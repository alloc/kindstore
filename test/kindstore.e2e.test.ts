import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore", () => {
  test("persists typed documents, queries indexed fields, and manages metadata", () => {
    const filename = `file:kindstore-crud-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
      status: z.enum(["active", "revoked", "expired"]),
      expiresAt: z.number().int(),
      updatedAt: z.number().int(),
      deviceId: z.string().optional(),
    });
    const AppMetadata = z.object({
      theme: z.enum(["light", "dark"]).default("dark"),
      lastOpenedAt: z.number().int().optional(),
    });
    const db = kindstore({
      connection: { filename },
      metadata: { app: AppMetadata },
      sessions: kind("ses", Session)
        .index("userId")
        .index("status")
        .index("expiresAt", { type: "integer" })
        .index("updatedAt", { type: "integer" })
        .index("deviceId")
        .multi("user_updatedAt", { userId: "asc", updatedAt: "desc" }),
    });
    const now = Date.now();
    const activeId = db.sessions.newId();
    const revokedId = db.sessions.newId();
    const active = db.sessions.put(activeId, {
      userId: "usr_1",
      status: "active",
      expiresAt: now + 10_000,
      updatedAt: now,
      deviceId: "mobile:ios",
    });
    db.sessions.put(revokedId, {
      userId: "usr_1",
      status: "revoked",
      expiresAt: now + 20_000,
      updatedAt: now - 1,
    });
    expect(activeId.startsWith("ses_")).toBe(true);
    expect(db.sessions.get(activeId)).toEqual(active);
    expect(
      db.sessions.findMany({
        where: {
          userId: "usr_1",
          expiresAt: { gt: now },
        },
        orderBy: { updatedAt: "desc" },
        limit: 10,
      }),
    ).toEqual([
      active,
      {
        userId: "usr_1",
        status: "revoked",
        expiresAt: now + 20_000,
        updatedAt: now - 1,
      },
    ]);
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
        updatedAt: now + 5,
      }),
    ).toEqual({
      userId: "usr_1",
      status: "expired",
      expiresAt: now + 10_000,
      updatedAt: now + 5,
      deviceId: "mobile:ios",
    });
    expect(
      db.sessions.update(activeId, (current) => ({
        ...current,
        status: "active",
        updatedAt: now + 6,
      })),
    ).toEqual({
      userId: "usr_1",
      status: "active",
      expiresAt: now + 10_000,
      updatedAt: now + 6,
      deviceId: "mobile:ios",
    });
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
      db.raw
        .query(`SELECT count(*) AS count FROM "sessions" WHERE "user_id" = ?`)
        .get("usr_1"),
    ).toEqual({ count: 1 });

    const mirrored = kindstore({
      connection: { filename },
      metadata: { app: AppMetadata },
      sessions: kind("ses", Session)
        .index("userId")
        .index("status")
        .index("expiresAt", { type: "integer" })
        .index("updatedAt", { type: "integer" })
        .index("deviceId")
        .multi("user_updatedAt", { userId: "asc", updatedAt: "desc" }),
    });
    expect(mirrored.sessions.get(activeId)).toEqual({
      userId: "usr_1",
      status: "active",
      expiresAt: now + 10_000,
      updatedAt: now + 6,
      deviceId: "mobile:ios",
    });
    expect(mirrored.metadata.get("app")).toEqual({
      theme: "light",
      lastOpenedAt: now + 2,
    });
    mirrored.close();
    db.close();
  });

  test("runs eager migrations before reads and indexed queries", () => {
    const filename = `file:kindstore-migrate-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const TaskV1 = z.object({
      title: z.string(),
    });
    const initial = kindstore({
      connection: { filename },
      tasks: kind("tsk", TaskV1),
    });
    const taskId = initial.tasks.newId();
    initial.tasks.put(taskId, { title: "Ship v1" });

    const TaskV2 = z.object({
      title: z.string(),
      status: z.enum(["open", "done"]),
      updatedAt: z.number().int(),
    });
    const migrated = kindstore({
      connection: { filename },
      tasks: kind("tsk", TaskV2)
        .index("status")
        .index("updatedAt", { type: "integer" })
        .migrate(2, {
          1: (value, context) => ({
            ...value,
            status: "open",
            updatedAt: context.now,
          }),
        }),
    });
    const task = migrated.tasks.get(taskId);
    expect(task?.title).toBe("Ship v1");
    expect(task?.status).toBe("open");
    expect(typeof task?.updatedAt).toBe("number");
    expect(
      migrated.tasks.first({
        where: { status: "open" },
        orderBy: { updatedAt: "desc" },
      }),
    ).toEqual(task);
    migrated.close();
    initial.close();
  });
});
