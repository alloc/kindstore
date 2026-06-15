import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore store surface", () => {
  test("exposes declared kind builders under db.schema", () => {
    const filename = `file:kindstore-schema-surface-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const sessions = kind("ses", Session).index("userId");
    const db = kindstore({
      filename,
      schema: {
        sessions,
      },
    });
    expect(db.schema.sessions).toBe(sessions);
    expect(() =>
      kindstore({
        filename: `file:kindstore-reserved-schema-${crypto.randomUUID()}?mode=memory&cache=shared`,
        schema: {
          schema: kind("sch", z.object({ value: z.string() })),
        },
      }),
    ).toThrow('Kind key "schema" is reserved.');
    expect(() =>
      kindstore({
        filename: `file:kindstore-reserved-resolve-${crypto.randomUUID()}?mode=memory&cache=shared`,
        schema: {
          resolve: kind("rsl", z.object({ value: z.string() })),
        },
      }),
    ).toThrow('Kind key "resolve" is reserved.');
    db.close();
  });

  test("resolves documents by tagged ID across kinds", () => {
    const filename = `file:kindstore-resolve-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const User = z.object({
      email: z.string(),
    });
    const Task = z.object({
      title: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        users: kind("usr", User),
        tasks: kind("tsk", Task),
      },
    });

    const user = db.users.create({ email: "jane@example.com" });
    const task = db.tasks.create({ title: "Ship docs" });

    expect(db.resolve(user.id)).toEqual(user);
    expect(db.resolve(task.id)).toEqual(task);
    expect(db.resolve(db.tasks.newId())).toBeUndefined();
    expect(() => db.resolve("invalid" as never)).toThrow('Expected tagged ID, received "invalid".');
    expect(() => db.resolve("oth_123" as never)).toThrow(
      'No kind is registered for tag "oth" from ID "oth_123".',
    );

    db.close();
  });

  test("persists typed documents, queries indexed fields, and manages metadata", () => {
    const filename = `file:kindstore-crud-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
      status: z.enum(["active", "revoked", "expired"]),
      expiresAt: z.number().int(),
      deviceId: z.string().optional(),
    });
    const AppMetadata = z.object({
      theme: z.enum(["light", "dark"]).default("dark"),
      lastOpenedAt: z.number().int().optional(),
    });
    const db = kindstore({
      filename,
      metadata: { app: AppMetadata },
      schema: {
        sessions: kind("ses", Session)
          .createdAt()
          .updatedAt()
          .index("userId")
          .index("status")
          .index("expiresAt", { type: "integer" })
          .index("updatedAt", { type: "integer" })
          .index("deviceId")
          .multi("user_updatedAt", { userId: "asc", updatedAt: "desc" }),
      },
    });
    const now = Date.now();
    const activeId = db.sessions.newId();
    const revokedId = db.sessions.newId();
    const active = db.sessions.put(activeId, {
      userId: "usr_1",
      status: "active",
      expiresAt: now + 10_000,
      deviceId: "mobile:ios",
    });
    const revoked = db.sessions.put(revokedId, {
      userId: "usr_1",
      status: "revoked",
      expiresAt: now + 20_000,
    });
    expect(activeId.startsWith("ses_")).toBe(true);
    expect(active.id).toBe(activeId);
    expect(revoked.id).toBe(revokedId);
    expect(active.createdAt).toBe(active.updatedAt);
    expect(revoked.createdAt).toBe(revoked.updatedAt);
    expect(db.sessions.get(activeId)).toEqual(active);
    const matching = db.sessions.findMany({
      where: {
        userId: "usr_1",
        expiresAt: { gt: now },
      },
      orderBy: { expiresAt: "desc" },
      limit: 10,
    });
    expect(matching.map((session) => session.status)).toEqual(["revoked", "active"]);
    expect(matching[0]?.expiresAt).toBe(now + 20_000);
    expect(matching[1]?.expiresAt).toBe(now + 10_000);
    expect(
      Array.from(
        db.sessions.iterate({
          where: { deviceId: "mobile:ios" },
          orderBy: { updatedAt: "desc" },
        }),
      ),
    ).toEqual([active]);
    expect(
      db.sessions.update(activeId, {
        status: "expired",
      }),
    ).toEqual({
      id: activeId,
      userId: "usr_1",
      status: "expired",
      expiresAt: now + 10_000,
      createdAt: active.createdAt,
      updatedAt: expect.any(Number),
      deviceId: "mobile:ios",
    });
    const afterPatch = db.sessions.get(activeId)!;
    expect(afterPatch.createdAt).toBe(active.createdAt);
    expect(afterPatch.updatedAt).toBeGreaterThanOrEqual(active.updatedAt);
    expect(
      db.sessions.update(activeId, (current) => ({
        ...current,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      })),
    ).toEqual({
      id: activeId,
      userId: "usr_1",
      status: "active",
      expiresAt: now + 10_000,
      createdAt: active.createdAt,
      updatedAt: expect.any(Number),
      deviceId: "mobile:ios",
    });
    const afterFunction = db.sessions.get(activeId)!;
    expect(afterFunction.createdAt).toBe(active.createdAt);
    expect(afterFunction.updatedAt).toBeGreaterThanOrEqual(afterPatch.updatedAt);
    const overwritten = db.sessions.put(activeId, {
      userId: "usr_1",
      status: "active",
      expiresAt: now + 30_000,
      createdAt: 1,
      updatedAt: 1,
      deviceId: "mobile:ios",
    });
    expect(overwritten.createdAt).toBe(active.createdAt);
    expect(overwritten.updatedAt).toBeGreaterThanOrEqual(afterFunction.updatedAt);
    expect(db.metadata.get("app")).toBeUndefined();
    expect(
      db.metadata.set("app", {
        theme: "dark",
        lastOpenedAt: now,
      }),
    ).toEqual({
      theme: "dark",
      lastOpenedAt: now,
    });
    expect(
      db.metadata.update("app", (current) => ({
        ...(current ?? { theme: "dark" }),
        lastOpenedAt: now + 1,
      })),
    ).toEqual({
      theme: "dark",
      lastOpenedAt: now + 1,
    });
    db.batch(() => {
      db.sessions.delete(revokedId);
      db.metadata.set("app", {
        theme: "light",
        lastOpenedAt: now + 2,
      });
    });
    expect(
      db.raw.query(`SELECT count(*) AS count FROM "sessions" WHERE "user_id" = ?`).get("usr_1"),
    ).toEqual({ count: 1 });
    expect(
      (db.raw.query(`PRAGMA table_xinfo('sessions')`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    ).toEqual(["id", "data", "user_id", "status", "expires_at", "updated_at", "device_id"]);
    expect(
      db.raw
        .query(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name" ASC`)
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { name: "__kindstore_app_metadata" },
        { name: "__kindstore_internal" },
        { name: "sessions" },
      ]),
    );
    expect(
      (
        db.raw.query(`PRAGMA table_xinfo('__kindstore_app_metadata')`).all() as { name: string }[]
      ).map((column) => column.name),
    ).toEqual(["key", "payload"]);
    expect(
      db.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'store_format_version'`)
        .get(),
    ).toEqual({ payload: "1" });
    expect(
      db.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"sessions":1}' });
    expect(
      db.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'schema_snapshot'`)
        .get(),
    ).toEqual({
      payload: expect.stringContaining('"kindstoreVersion":1'),
    });

    const mirrored = kindstore({
      filename,
      metadata: { app: AppMetadata },
      schema: {
        sessions: kind("ses", Session)
          .createdAt()
          .updatedAt()
          .index("userId")
          .index("status")
          .index("expiresAt", { type: "integer" })
          .index("updatedAt", { type: "integer" })
          .index("deviceId")
          .multi("user_updatedAt", { userId: "asc", updatedAt: "desc" }),
      },
    });
    expect(mirrored.sessions.get(activeId)).toEqual({
      id: activeId,
      userId: "usr_1",
      status: "active",
      expiresAt: now + 30_000,
      createdAt: active.createdAt,
      updatedAt: overwritten.updatedAt,
      deviceId: "mobile:ios",
    });
    expect(mirrored.metadata.get("app")).toEqual({
      theme: "light",
      lastOpenedAt: now + 2,
    });
    expect(
      mirrored.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'store_format_version'`)
        .get(),
    ).toEqual({ payload: "1" });
    mirrored.close();
    db.close();
  });

  test("rejects empty schemas", () => {
    expect(() =>
      kindstore({
        filename: ":memory:",
        schema: {} as never,
      }),
    ).toThrow('kindstore() requires at least one declared kind in "schema".');
  });
});
