import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore constraint migrations", () => {
  test("runs prepareConstraints before creating a new unique single-field index", () => {
    const filename = `file:kindstore-prepare-constraints-single-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const User = z.object({
      email: z.string(),
      name: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        users: kind("usr", User).index("email"),
      },
    });
    initial.users.create({ email: "jane@example.com", name: "Jane" });
    initial.users.create({ email: "jane@example.com", name: "Jane Duplicate" });
    initial.users.create({ email: "ada@example.com", name: "Ada" });

    expect(() =>
      kindstore({
        filename,
        schema: {
          users: kind("usr", User).index("email", { unique: true }),
        },
      }),
    ).toThrow(/UNIQUE/i);

    let runs = 0;
    const migrated = kindstore({
      filename,
      migrate(m) {
        m.prepareConstraints("dedupe-user-email", ({ db }) => {
          runs++;
          expect("putByUnique" in db.users).toBe(false);
          const seen = new Set<string>();
          for (const user of db.users.findMany({ orderBy: { email: "asc" } })) {
            if (seen.has(user.email)) {
              db.users.delete(user.id);
              continue;
            }
            seen.add(user.email);
          }
        });
      },
      schema: {
        users: kind("usr", User).index("email", { unique: true }),
      },
    });

    expect(runs).toBe(1);
    expect(migrated.users.findMany({ orderBy: { email: "asc" } })).toEqual([
      expect.objectContaining({ email: "ada@example.com", name: "Ada" }),
      expect.objectContaining({ email: "jane@example.com", name: "Jane" }),
    ]);
    expect(
      migrated.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'constraint_migrations'`)
        .get(),
    ).toEqual({ payload: '["dedupe-user-email"]' });

    const reopened = kindstore({
      filename,
      migrate(m) {
        m.prepareConstraints("dedupe-user-email", () => {
          runs++;
        });
      },
      schema: {
        users: kind("usr", User).index("email", { unique: true }),
      },
    });
    expect(runs).toBe(1);
    reopened.close();
    migrated.close();
    initial.close();
  });

  test("runs prepareConstraints before creating a new unique composite index", () => {
    const filename = `file:kindstore-prepare-constraints-composite-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Turn = z.object({
      completedAt: z.number(),
      sequence: z.number(),
      sessionId: z.string(),
      text: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        turns: kind("trn", Turn).index("completedAt", { type: "integer" }).multi(
          "session_sequence",
          {
            sessionId: "asc",
            sequence: "asc",
          },
        ),
      },
    });
    initial.turns.create({
      completedAt: 10,
      sequence: 1,
      sessionId: "ses_1",
      text: "older duplicate",
    });
    initial.turns.create({
      completedAt: 20,
      sequence: 1,
      sessionId: "ses_1",
      text: "newer duplicate",
    });
    initial.turns.create({
      completedAt: 30,
      sequence: 2,
      sessionId: "ses_1",
      text: "unique turn",
    });

    expect(() =>
      kindstore({
        filename,
        schema: {
          turns: kind("trn", Turn).index("completedAt", { type: "integer" }).multi(
            "session_sequence",
            {
              sessionId: "asc",
              sequence: "asc",
            },
            { unique: true },
          ),
        },
      }),
    ).toThrow(/UNIQUE/i);

    const migrated = kindstore({
      filename,
      migrate(m) {
        m.prepareConstraints("dedupe-turn-session-sequence", ({ db }) => {
          const seen = new Set<string>();
          for (const turn of db.turns.findMany({
            orderBy: { sessionId: "asc", sequence: "asc", completedAt: "desc" },
          })) {
            const key = `${turn.sessionId}:${turn.sequence}`;
            if (seen.has(key)) {
              db.turns.delete(turn.id);
              continue;
            }
            seen.add(key);
          }
        });
      },
      schema: {
        turns: kind("trn", Turn).index("completedAt", { type: "integer" }).multi(
          "session_sequence",
          {
            sessionId: "asc",
            sequence: "asc",
          },
          { unique: true },
        ),
      },
    });

    expect(migrated.turns.findMany({ orderBy: { sequence: "asc" } })).toEqual([
      expect.objectContaining({ sequence: 1, text: "newer duplicate" }),
      expect.objectContaining({ sequence: 2, text: "unique turn" }),
    ]);
    expect(migrated.raw.query(`PRAGMA index_list('turns')`).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "idx_turns_session_sequence", unique: 1 }),
      ]),
    );
    migrated.close();
    initial.close();
  });

  test("rolls back prepareConstraints changes and metadata when startup fails", () => {
    const filename = `file:kindstore-prepare-constraints-rollback-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const User = z.object({
      email: z.string(),
      name: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        users: kind("usr", User).index("email"),
      },
    });
    initial.users.create({ email: "jane@example.com", name: "Jane" });

    expect(() =>
      kindstore({
        filename,
        migrate(m) {
          m.prepareConstraints("failing-user-repair", ({ db }) => {
            db.users.delete(db.users.first({ where: { email: "jane@example.com" } })!.id);
            throw new Error("repair failed");
          });
        },
        schema: {
          users: kind("usr", User).index("email", { unique: true }),
        },
      }),
    ).toThrow("repair failed");

    expect(initial.users.findMany()).toEqual([
      expect.objectContaining({ email: "jane@example.com", name: "Jane" }),
    ]);
    expect(
      initial.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'constraint_migrations'`)
        .get(),
    ).toBeNull();
    initial.close();
  });
});
