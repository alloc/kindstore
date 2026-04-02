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
    expect(
      mirrored.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'store_format_version'`)
        .get(),
    ).toEqual({ payload: "1" });
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
    expect(
      migrated.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"tasks":2}' });
    expect(
      migrated.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'schema_snapshot'`)
        .get(),
    ).toEqual({
      payload: expect.stringContaining('"tasks"'),
    });
    migrated.close();
    initial.close();
  });

  test("fails fast when an initialized store is missing its format version", () => {
    const filename = `file:kindstore-format-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
      status: z.enum(["active", "revoked", "expired"]),
    });
    const db = kindstore({
      connection: { filename },
      sessions: kind("ses", Session).index("userId").index("status"),
    });
    db.raw
      .query(`DELETE FROM "__kindstore_internal" WHERE "key" = 'store_format_version'`)
      .run();
    expect(() =>
      kindstore({
        connection: { filename },
        sessions: kind("ses", Session).index("userId").index("status"),
      }),
    ).toThrow("missing the kindstore format version");
    db.close();
  });

  test("reconciles stale derived indexes and generated columns from the previous snapshot", () => {
    const filename = `file:kindstore-reconcile-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
      status: z.enum(["active", "revoked", "expired"]),
      expiresAt: z.number().int(),
      updatedAt: z.number().int(),
      deviceId: z.string().optional(),
    });
    const initial = kindstore({
      connection: { filename },
      sessions: kind("ses", Session)
        .index("userId")
        .index("status")
        .index("expiresAt", { type: "integer" })
        .index("updatedAt", { type: "integer" })
        .index("deviceId")
        .multi("user_updatedAt", { userId: "asc", updatedAt: "desc" }),
    });
    initial.sessions.put(initial.sessions.newId(), {
      userId: "usr_1",
      status: "active",
      expiresAt: 1,
      updatedAt: 2,
      deviceId: "mobile:ios",
    });

    const narrowed = kindstore({
      connection: { filename },
      sessions: kind("ses", Session).index("userId").index("status"),
    });
    expect(
      (
        narrowed.raw
          .query(`PRAGMA table_xinfo('sessions')`)
          .all() as { name: string }[]
      ).map((column) => column.name),
    ).toEqual([
      "id",
      "payload",
      "created_at",
      "updated_at",
      "user_id",
      "status",
    ]);
    expect(
      (
        narrowed.raw
          .query(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'index' AND "tbl_name" = 'sessions' ORDER BY "name" ASC`)
          .all() as { name: string }[]
      )
        .map((index) => index.name)
        .filter((name) => !name.startsWith("sqlite_autoindex_")),
    ).toEqual(["idx_sessions_status", "idx_sessions_user_id"]);
    narrowed.close();
    initial.close();
  });

  test("requires an explicit schema migration for a missing previous kind", () => {
    const filename = `file:kindstore-missing-kind-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const initial = kindstore({
      connection: { filename },
      sessions: kind("ses", Session).index("userId"),
    });
    expect(() =>
      kindstore({
        connection: { filename },
        authSessions: kind("ses", Session).index("userId"),
      }),
    ).toThrow('Previous kind "sessions" is missing');
    const reopened = kindstore({
      connection: { filename },
      sessions: kind("ses", Session).index("userId"),
    });
    expect(reopened.sessions.findMany()).toEqual([]);
    reopened.close();
    initial.close();
  });

  test("renames a previous kind when authorized by schema.migrate", () => {
    const filename = `file:kindstore-rename-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const initial = kindstore({
      connection: { filename },
      sessions: kind("ses", Session).index("userId"),
    });
    const sessionId = initial.sessions.newId();
    initial.sessions.put(sessionId, {
      userId: "usr_1",
    });

    const renamed = kindstore({
      connection: { filename },
      schema: {
        migrate(m) {
          m.rename("sessions", "authSessions");
        },
      },
      authSessions: kind("ses", Session).index("userId"),
    });
    expect(renamed.authSessions.get(sessionId as never)).toEqual({
      userId: "usr_1",
    });
    expect(
      renamed.raw
        .query(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name" ASC`)
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { name: "auth_sessions" },
      ]),
    );
    expect(
      renamed.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"authSessions":1}' });
    renamed.close();
    initial.close();
  });

  test("drops a previous kind when authorized by schema.migrate", () => {
    const filename = `file:kindstore-drop-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const initial = kindstore({
      connection: { filename },
      sessions: kind("ses", Session).index("userId"),
    });
    initial.sessions.put(initial.sessions.newId(), {
      userId: "usr_1",
    });

    const dropped = kindstore({
      connection: { filename },
      schema: {
        migrate(m) {
          m.drop("sessions");
        },
      },
    });
    expect(
      dropped.raw
        .query(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'sessions'`)
        .all(),
    ).toEqual([]);
    expect(
      dropped.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .all(),
    ).toEqual([]);
    dropped.close();
    initial.close();
  });

  test("retags a kind when authorized by schema.migrate", () => {
    const filename = `file:kindstore-retag-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const User = z.object({
      email: z.string(),
    });
    const initial = kindstore({
      connection: { filename },
      users: kind("usr", User),
    });
    const userId = initial.users.newId();
    initial.users.put(userId, {
      email: "jane@example.com",
    });

    const retagged = kindstore({
      connection: { filename },
      schema: {
        migrate(m) {
          m.retag("users", "usr");
        },
      },
      users: kind("per", User),
    });
    const retaggedId = userId.replace("usr_", "per_");
    expect(retagged.users.get(retaggedId as never)).toEqual({
      email: "jane@example.com",
    });
    expect(
      retagged.raw.query(`SELECT "id" FROM "users"`).all(),
    ).toEqual([{ id: retaggedId }]);
    retagged.close();
    initial.close();
  });

  test("rolls back failed schema reconciliation without mutating the existing store", () => {
    const filename = `file:kindstore-rollback-schema-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const initial = kindstore({
      connection: { filename },
      sessions: kind("ses", Session).index("userId"),
    });
    const sessionId = initial.sessions.newId();
    initial.sessions.put(sessionId, {
      userId: "usr_1",
    });
    expect(() =>
      kindstore({
        connection: { filename },
        authSessions: kind("ses", Session).index("userId"),
      }),
    ).toThrow();
    const reopened = kindstore({
      connection: { filename },
      sessions: kind("ses", Session).index("userId"),
    });
    expect(reopened.sessions.get(sessionId)).toEqual({
      userId: "usr_1",
    });
    expect(
      reopened.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"sessions":1}' });
    reopened.close();
    initial.close();
  });

  test("rolls back failed payload migrations without advancing kind versions", () => {
    const filename = `file:kindstore-rollback-data-${crypto.randomUUID()}?mode=memory&cache=shared`;
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
    });
    expect(() =>
      kindstore({
        connection: { filename },
        tasks: kind("tsk", TaskV2).migrate(2, {
          1: () => {
            throw new Error("boom");
          },
        }),
      }),
    ).toThrow("boom");
    const reopened = kindstore({
      connection: { filename },
      tasks: kind("tsk", TaskV1),
    });
    expect(reopened.tasks.get(taskId)).toEqual({ title: "Ship v1" });
    expect(
      reopened.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"tasks":1}' });
    reopened.close();
    initial.close();
  });
});
