import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { UnrecoverableStoreOpenError, kind, kindstore } from "../src/index";

function expectUnrecoverableOpen(open: () => unknown, message: string) {
  let thrown: unknown;
  try {
    open();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UnrecoverableStoreOpenError);
  expect((thrown as Error | undefined)?.message).toContain(message);
}

describe("kindstore", () => {
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
      (db.raw.query(`PRAGMA table_xinfo('__kindstore_app_metadata')`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
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

  test("creates documents with generated IDs", () => {
    const filename = `file:kindstore-create-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Task = z.object({
      title: z.string(),
      status: z.enum(["todo", "doing", "done"]),
    });
    const db = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", Task).index("status"),
      },
    });

    const created = db.tasks.create({
      title: "Ship docs",
      status: "todo",
    });

    expect(created).toEqual({
      id: expect.stringMatching(/^tsk_/),
      title: "Ship docs",
      status: "todo",
    });
    expect(db.tasks.findMany()).toEqual([created]);
    expect(
      (db.raw.query(`SELECT "id" FROM "tasks"`).get() as { id: string } | null)?.id.startsWith(
        "tsk_",
      ),
    ).toBe(true);

    db.close();
  });

  test("applies managed timestamps when creating documents", () => {
    const filename = `file:kindstore-create-timestamps-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Task = z.object({
      title: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", Task).createdAt().updatedAt(),
      },
    });

    const created = db.tasks.create({
      title: "Ship docs",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(created).toEqual({
      id: expect.stringMatching(/^tsk_/),
      title: "Ship docs",
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(created.createdAt).toBe(created.updatedAt);
    expect(db.tasks.get(created.id)).toEqual(created);

    db.close();
  });

  test("pages through indexed queries with a deterministic cursor", () => {
    const filename = `file:kindstore-pages-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Task = z.object({
      status: z.enum(["todo", "doing", "done"]),
      updatedAt: z.number().int(),
      title: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", Task)
          .index("status")
          .index("updatedAt", { type: "integer" })
          .multi("status_updatedAt", { status: "asc", updatedAt: "desc" }),
      },
    });
    for (const [title, updatedAt] of [
      ["Newest", 30],
      ["Tie B", 20],
      ["Tie A", 20],
      ["Oldest", 10],
    ] as const) {
      db.tasks.put(db.tasks.newId(), {
        status: "doing",
        updatedAt,
        title,
      });
    }

    const firstPage = db.tasks.findPage({
      where: { status: "doing" },
      orderBy: { updatedAt: "desc" },
      limit: 2,
    });
    expect(firstPage.items.map((task) => task.title)).toEqual(["Newest", "Tie A"]);
    expect(firstPage.next).toEqual(expect.any(String));

    const secondPage = db.tasks.findPage({
      where: { status: "doing" },
      orderBy: { updatedAt: "desc" },
      limit: 2,
      after: firstPage.next,
    });
    expect(secondPage.items.map((task) => task.title)).toEqual(["Tie B", "Oldest"]);
    expect(secondPage.next).toBeUndefined();
    db.close();
  });

  test("allows multi-only query fields and derives their generated columns", () => {
    const filename = `file:kindstore-multi-only-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
      updatedAt: z.number().int(),
      status: z.enum(["active", "revoked"]),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).multi("user_updatedAt", {
          userId: "asc",
          updatedAt: "desc",
        }),
      },
    });

    db.sessions.put(db.sessions.newId(), {
      userId: "usr_1",
      updatedAt: 10,
      status: "active",
    });
    db.sessions.put(db.sessions.newId(), {
      userId: "usr_1",
      updatedAt: 20,
      status: "revoked",
    });

    expect(
      db.sessions
        .findMany({
          where: { userId: "usr_1" },
          orderBy: { updatedAt: "desc" },
        })
        .map((session) => session.updatedAt),
    ).toEqual([20, 10]);
    expect(
      (db.raw.query(`PRAGMA table_xinfo('sessions')`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    ).toEqual(["id", "data", "user_id", "updated_at"]);
    expect(
      (
        db.raw
          .query(
            `SELECT "name" FROM "sqlite_master" WHERE "type" = 'index' AND "tbl_name" = 'sessions' ORDER BY "name" ASC`,
          )
          .all() as { name: string }[]
      )
        .map((index) => index.name)
        .filter((name) => !name.startsWith("sqlite_autoindex_")),
    ).toEqual(["idx_sessions_user_updated_at"]);
    db.close();
  });

  test("allows id as part of a multi index", () => {
    const filename = `file:kindstore-multi-id-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
      updatedAt: z.number().int(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).multi("user_id", {
          userId: "asc",
          id: "asc",
        }),
      },
    });

    const firstId = db.sessions.newId();
    const secondId = db.sessions.newId();

    db.sessions.put(firstId, {
      userId: "usr_1",
      updatedAt: 10,
    });
    db.sessions.put(secondId, {
      userId: "usr_1",
      updatedAt: 20,
    });

    expect(
      db.sessions.findMany({
        where: { userId: "usr_1", id: { gte: firstId } },
        orderBy: { id: "asc" },
      }),
    ).toEqual([
      {
        id: firstId,
        userId: "usr_1",
        updatedAt: 10,
      },
      {
        id: secondId,
        userId: "usr_1",
        updatedAt: 20,
      },
    ]);
    expect(
      (db.raw.query(`PRAGMA table_xinfo('sessions')`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    ).toEqual(["id", "data", "user_id"]);
    expect(
      (
        db.raw
          .query(
            `SELECT "name" FROM "sqlite_master" WHERE "type" = 'index' AND "tbl_name" = 'sessions' ORDER BY "name" ASC`,
          )
          .all() as { name: string }[]
      )
        .map((index) => index.name)
        .filter((name) => !name.startsWith("sqlite_autoindex_")),
    ).toEqual(["idx_sessions_user_id"]);
    db.close();
  });

  test("rejects invalid findPage usage", () => {
    const filename = `file:kindstore-find-page-errors-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Task = z.object({
      status: z.enum(["todo", "doing", "done"]),
      updatedAt: z.number().int(),
      title: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", Task).index("status").index("updatedAt", { type: "integer" }),
      },
    });
    db.tasks.put(db.tasks.newId(), {
      status: "doing",
      updatedAt: 1,
      title: "One",
    });
    db.tasks.put(db.tasks.newId(), {
      status: "doing",
      updatedAt: 0,
      title: "Two",
    });
    expect(() =>
      db.tasks.findPage({
        where: { status: "doing" },
        orderBy: {},
        limit: 1,
      }),
    ).toThrow('findPage() for kind "tasks" requires an explicit orderBy.');
    expect(() =>
      db.tasks.findPage({
        where: { status: "doing" },
        orderBy: { updatedAt: "desc" },
        limit: 0,
      }),
    ).toThrow("must be a positive integer when using findPage()");
    const firstPage = db.tasks.findPage({
      where: { status: "doing" },
      orderBy: { updatedAt: "desc" },
      limit: 1,
    });
    expect(firstPage.next).toEqual(expect.any(String));
    expect(() =>
      db.tasks.findPage({
        where: { status: "doing" },
        orderBy: { updatedAt: "asc" },
        limit: 1,
        after: firstPage.next,
      }),
    ).toThrow('findPage() cursor does not match the requested orderBy for kind "tasks".');
    db.close();
  });

  test("infers SQLite types for supported indexed Zod schemas", () => {
    const filename = `file:kindstore-inferred-types-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Item = z.object({
      title: z.string(),
      status: z.enum(["draft", "published"]),
      enabled: z.boolean(),
      priority: z.number().int(),
      score: z.number(),
      literalText: z.literal("pinned"),
      literalInt: z.literal(7),
      literalBool: z.literal(true),
      optionalText: z.string().optional(),
      nullableScore: z.number().nullable(),
      defaultPriority: z.number().int().default(0),
      readonlyStatus: z.enum(["open", "closed"]).readonly(),
      catchEnabled: z.boolean().catch(false),
    });
    const db = kindstore({
      filename,
      schema: {
        items: kind("itm", Item)
          .index("title")
          .index("status")
          .index("enabled")
          .index("priority")
          .index("score")
          .index("literalText")
          .index("literalInt")
          .index("literalBool")
          .index("optionalText")
          .index("nullableScore")
          .index("defaultPriority")
          .index("readonlyStatus")
          .index("catchEnabled"),
      },
    });

    db.items.put(db.items.newId(), {
      title: "High",
      status: "published",
      enabled: true,
      priority: 10,
      score: 10.5,
      literalText: "pinned",
      literalInt: 7,
      literalBool: true,
      optionalText: "alpha",
      nullableScore: 10.5,
      defaultPriority: 5,
      readonlyStatus: "open",
      catchEnabled: true,
    });
    db.items.put(db.items.newId(), {
      title: "Low",
      status: "draft",
      enabled: false,
      priority: 2,
      score: 2.5,
      literalText: "pinned",
      literalInt: 7,
      literalBool: true,
      nullableScore: 2.5,
      defaultPriority: 1,
      readonlyStatus: "closed",
      catchEnabled: false,
    });

    expect(
      Object.fromEntries(
        (
          db.raw.query(`PRAGMA table_xinfo('items')`).all() as {
            name: string;
            type: string;
          }[]
        ).map((column) => [column.name, column.type]),
      ),
    ).toMatchObject({
      title: "TEXT",
      status: "TEXT",
      enabled: "INTEGER",
      priority: "INTEGER",
      score: "REAL",
      literal_text: "TEXT",
      literal_int: "INTEGER",
      literal_bool: "INTEGER",
      optional_text: "TEXT",
      nullable_score: "REAL",
      default_priority: "INTEGER",
      readonly_status: "TEXT",
      catch_enabled: "INTEGER",
    });
    expect(
      db.items.findMany({
        orderBy: { priority: "asc" },
      }),
    ).toMatchObject([{ title: "Low" }, { title: "High" }]);
    expect(
      db.items.findMany({
        orderBy: { score: "desc" },
      }),
    ).toMatchObject([{ title: "High" }, { title: "Low" }]);
    db.close();
  });

  test("requires explicit SQLite hints for unsupported prefault, pipe, and transform schemas", () => {
    const prefaultFilename = `file:kindstore-prefault-${crypto.randomUUID()}?mode=memory&cache=shared`;
    expect(() =>
      kindstore({
        filename: prefaultFilename,
        schema: {
          items: kind(
            "itm",
            z.object({
              status: z.string().prefault("draft"),
            }),
          ).index("status"),
        },
      }),
    ).toThrow('Kind "itm" field "status" needs an explicit SQLite type hint.');

    const pipeFilename = `file:kindstore-pipe-${crypto.randomUUID()}?mode=memory&cache=shared`;
    expect(() =>
      kindstore({
        filename: pipeFilename,
        schema: {
          items: kind(
            "itm",
            z.object({
              // @ts-expect-error Zod correctly warns that you are piping string to number without parsing
              priority: z.string().pipe(z.number()),
            }),
          ).index("priority"),
        },
      }),
    ).toThrow('Kind "itm" field "priority" needs an explicit SQLite type hint.');

    const transformFilename = `file:kindstore-transform-${crypto.randomUUID()}?mode=memory&cache=shared`;
    expect(() =>
      kindstore({
        filename: transformFilename,
        schema: {
          items: kind(
            "itm",
            z.object({
              priority: z.string().transform(Number),
            }),
          ).index("priority"),
        },
      }),
    ).toThrow('Kind "itm" field "priority" needs an explicit SQLite type hint.');
  });

  test("rejects empty schemas", () => {
    expect(() =>
      kindstore({
        filename: ":memory:",
        schema: {} as never,
      }),
    ).toThrow('kindstore() requires at least one declared kind in "schema".');
  });

  test("runs eager migrations before reads and indexed queries", () => {
    const filename = `file:kindstore-migrate-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const TaskV1 = z.object({
      title: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", TaskV1),
      },
    });
    const taskId = initial.tasks.newId();
    initial.tasks.put(taskId, { title: "Ship v1" });

    const TaskV2 = z.object({
      title: z.string(),
      status: z.enum(["open", "done"]),
    });
    const migrated = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", TaskV2)
          .updatedAt()
          .index("status")
          .index("updatedAt", { type: "integer" })
          .migrate(2, {
            1: (value) => ({
              ...value,
              status: "open",
            }),
          }),
      },
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
    expect(
      migrated.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'store_format_version'`)
        .get(),
    ).toEqual({ payload: "1" });
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
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId").index("status"),
      },
    });
    db.raw.query(`DELETE FROM "__kindstore_internal" WHERE "key" = 'store_format_version'`).run();
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId").index("status"),
          },
        }),
      "missing the kindstore format version",
    );
    db.close();
  });

  test("marks malformed internal format-version metadata as unrecoverable", () => {
    const filename = `file:kindstore-bad-format-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    db.raw
      .query(`UPDATE "__kindstore_internal" SET "payload" = ? WHERE "key" = 'store_format_version'`)
      .run("oops");
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId"),
          },
        }),
      'Internal metadata key "store_format_version" is malformed',
    );
    db.close();
  });

  test("fails fast when internal kind_versions metadata is malformed", () => {
    const filename = `file:kindstore-bad-kind-versions-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    db.raw
      .query(`UPDATE "__kindstore_internal" SET "payload" = ? WHERE "key" = 'kind_versions'`)
      .run('"oops"');
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId"),
          },
        }),
      'Internal metadata key "kind_versions" is malformed',
    );
    db.close();
  });

  test("fails fast when internal schema_snapshot metadata is malformed", () => {
    const filename = `file:kindstore-bad-snapshot-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    db.raw
      .query(`UPDATE "__kindstore_internal" SET "payload" = ? WHERE "key" = 'schema_snapshot'`)
      .run('{"kindstoreVersion":1,"kinds":{"sessions":{"tag":"ses"}}}');
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId"),
          },
        }),
      'Internal metadata key "schema_snapshot" has an invalid kind entry',
    );
    db.close();
  });

  test("marks unsupported newer store formats as unrecoverable", () => {
    const filename = `file:kindstore-newer-format-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    db.raw
      .query(`UPDATE "__kindstore_internal" SET "payload" = ? WHERE "key" = 'store_format_version'`)
      .run("2");
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId"),
          },
        }),
      "newer than supported version",
    );
    db.close();
  });

  test("rejects invalid managed timestamp declarations", () => {
    const filename = `file:kindstore-bad-timestamps-${crypto.randomUUID()}?mode=memory&cache=shared`;
    expect(() =>
      kindstore({
        filename,
        schema: {
          sessions: kind(
            "ses",
            z.object({
              createdAt: z.string(),
            }),
          ).createdAt("createdAt"),
        },
      }),
    ).toThrow('createdAt field "createdAt" must be an integer');
    expect(() =>
      kind("ses", z.object({ timestamp: z.number().int() }))
        .createdAt("timestamp")
        .updatedAt("timestamp"),
    ).toThrow('cannot use "timestamp" for both createdAt and updatedAt');
    expect(() =>
      kindstore({
        filename,
        schema: {
          users: kind(
            "usr",
            z.object({
              id: z.string(),
              email: z.string(),
            }),
          ),
        },
      }),
    ).toThrow('Kind "usr" cannot declare reserved payload field "id".');
    expect(() =>
      kindstore({
        filename,
        schema: {
          users: kind(
            "usr",
            z.object({
              data: z.string(),
              email: z.string(),
            }),
          ),
        },
      }),
    ).toThrow('Kind "usr" cannot declare reserved payload field "data".');
  });

  test("defaults managed timestamp field names when omitted", () => {
    const filename = `file:kindstore-default-timestamps-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).createdAt().updatedAt().index("userId"),
      },
    });
    const session = db.sessions.put(db.sessions.newId(), {
      userId: "usr_1",
    });
    expect(session.createdAt).toEqual(expect.any(Number));
    expect(session.updatedAt).toEqual(expect.any(Number));
    expect(session.updatedAt).toBeGreaterThanOrEqual(session.createdAt);
    db.close();
  });

  test("adds custom managed timestamp fields to the schema when missing", () => {
    const filename = `file:kindstore-custom-timestamps-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session)
          .createdAt("createdOn")
          .updatedAt("modifiedOn")
          .index("userId")
          .index("modifiedOn"),
      },
    });
    const session = db.sessions.put(db.sessions.newId(), {
      userId: "usr_1",
    });
    expect(session.createdOn).toEqual(expect.any(Number));
    expect(session.modifiedOn).toEqual(expect.any(Number));
    expect(
      db.sessions.first({
        where: { userId: "usr_1" },
        orderBy: { modifiedOn: "desc" },
      }),
    ).toEqual(session);
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
      filename,
      schema: {
        sessions: kind("ses", Session)
          .index("userId")
          .index("status")
          .index("expiresAt", { type: "integer" })
          .index("updatedAt", { type: "integer" })
          .index("deviceId")
          .multi("user_updatedAt", { userId: "asc", updatedAt: "desc" }),
      },
    });
    initial.sessions.put(initial.sessions.newId(), {
      userId: "usr_1",
      status: "active",
      expiresAt: 1,
      updatedAt: 2,
      deviceId: "mobile:ios",
    });

    const narrowed = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId").index("status"),
      },
    });
    expect(
      (narrowed.raw.query(`PRAGMA table_xinfo('sessions')`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    ).toEqual(["id", "data", "user_id", "status"]);
    expect(
      (
        narrowed.raw
          .query(
            `SELECT "name" FROM "sqlite_master" WHERE "type" = 'index' AND "tbl_name" = 'sessions' ORDER BY "name" ASC`,
          )
          .all() as { name: string }[]
      )
        .map((index) => index.name)
        .filter((name) => !name.startsWith("sqlite_autoindex_")),
    ).toEqual(["idx_sessions_status", "idx_sessions_user_id"]);
    narrowed.close();
    initial.close();
  });

  test("allows indexed payload fields without storage-column remapping", () => {
    const filename = `file:kindstore-payload-column-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Message = z.object({
      payload: z.string(),
      status: z.enum(["queued", "sent"]),
    });
    const db = kindstore({
      filename,
      schema: {
        messages: kind("msg", Message).index("payload").index("status"),
      },
    });

    const message = db.messages.create({
      payload: "hello",
      status: "queued",
    });

    expect(db.messages.get(message.id)).toEqual(message);
    expect(
      (db.raw.query(`PRAGMA table_xinfo('messages')`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    ).toEqual(["id", "data", "payload", "status"]);

    db.close();
  });

  test("requires an explicit schema migration for a missing previous kind", () => {
    const filename = `file:kindstore-missing-kind-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    expect(() =>
      kindstore({
        filename,
        schema: {
          authSessions: kind("ses", Session).index("userId"),
        },
      }),
    ).toThrow('Previous kind "sessions" is missing');
    const reopened = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    expect(reopened.sessions.findMany()).toEqual([]);
    reopened.close();
    initial.close();
  });

  test("renames a previous kind when authorized by migrate", () => {
    const filename = `file:kindstore-rename-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    const sessionId = initial.sessions.newId();
    initial.sessions.put(sessionId, {
      userId: "usr_1",
    });

    const renamed = kindstore({
      filename,
      migrate(m) {
        m.rename("sessions", "authSessions");
      },
      schema: {
        authSessions: kind("ses", Session).index("userId"),
      },
    });
    expect(renamed.authSessions.get(sessionId as never)).toEqual({
      id: sessionId as never,
      userId: "usr_1",
    });
    expect(
      renamed.raw
        .query(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name" ASC`)
        .all(),
    ).toEqual(expect.arrayContaining([{ name: "auth_sessions" }]));
    expect(
      renamed.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"authSessions":1}' });
    renamed.close();
    initial.close();
  });

  test("rejects invalid schema migration planner declarations early", () => {
    const filename = `file:kindstore-invalid-planner-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    expect(() =>
      kindstore({
        filename,
        migrate(m) {
          m.rename("sessions", "sessions");
        },
        schema: {
          sessions: kind("ses", Session).index("userId"),
        },
      }),
    ).toThrow('rename from "sessions" to itself');
  });

  test("drops a previous kind when authorized by migrate", () => {
    const filename = `file:kindstore-drop-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const User = z.object({
      email: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    initial.sessions.put(initial.sessions.newId(), {
      userId: "usr_1",
    });

    const dropped = kindstore({
      filename,
      migrate(m) {
        m.drop("sessions");
      },
      schema: {
        users: kind("usr", User).index("email"),
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
        .get(),
    ).toEqual({ payload: '{"users":1}' });
    dropped.close();
    initial.close();
  });

  test("retags a kind when authorized by migrate", () => {
    const filename = `file:kindstore-retag-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const User = z.object({
      email: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        users: kind("usr", User),
      },
    });
    const userId = initial.users.newId();
    initial.users.put(userId, {
      email: "jane@example.com",
    });

    const retagged = kindstore({
      filename,
      migrate(m) {
        m.retag("users", "usr");
      },
      schema: {
        users: kind("per", User),
      },
    });
    const retaggedId = userId.replace("usr_", "per_");
    expect(retagged.users.get(retaggedId as never)).toEqual({
      id: retaggedId as never,
      email: "jane@example.com",
    });
    expect(retagged.raw.query(`SELECT "id" FROM "users"`).all()).toEqual([{ id: retaggedId }]);
    retagged.close();
    initial.close();
  });

  test("applies sequential schema migrations across passes and reopens cleanly once aligned", () => {
    const filename = `file:kindstore-schema-sequence-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const User = z.object({
      email: z.string(),
    });
    const Device = z.object({
      serial: z.string(),
    });
    const initialSchema = {
      sessions: kind("ses", Session).index("userId"),
      users: kind("usr", User).index("email"),
      devices: kind("dev", Device).index("serial"),
    };
    const retaggedSchema = {
      ...initialSchema,
      users: kind("per", User).index("email"),
    };
    const { devices: _droppedDevices, ...droppedSchema } = retaggedSchema;
    const renamedSchema = {
      users: droppedSchema.users,
      authSessions: kind("ses", Session).index("userId"),
    };

    const initial = kindstore({
      filename,
      schema: initialSchema,
    });
    const sessionId = initial.sessions.newId();
    const userId = initial.users.newId();
    const deviceId = initial.devices.newId();
    initial.sessions.put(sessionId, { userId: "usr_1" });
    initial.users.put(userId, { email: "jane@example.com" });
    initial.devices.put(deviceId, { serial: "dev-001" });
    initial.close();

    const retagged = kindstore({
      filename,
      migrate(m) {
        m.retag("users", "usr");
      },
      schema: retaggedSchema,
    });
    const retaggedUserId = userId.replace("usr_", "per_");
    expect(retagged.users.get(retaggedUserId as never)).toEqual({
      id: retaggedUserId as never,
      email: "jane@example.com",
    });
    expect(retagged.sessions.get(sessionId)).toEqual({
      id: sessionId,
      userId: "usr_1",
    });
    expect(retagged.devices.get(deviceId)).toEqual({
      id: deviceId,
      serial: "dev-001",
    });
    retagged.close();

    const dropped = kindstore({
      filename,
      migrate(m) {
        m.drop("devices");
      },
      schema: droppedSchema,
    });
    expect(dropped.users.get(retaggedUserId as never)).toEqual({
      id: retaggedUserId as never,
      email: "jane@example.com",
    });
    expect(dropped.sessions.get(sessionId)).toEqual({
      id: sessionId,
      userId: "usr_1",
    });
    expect(
      dropped.raw
        .query(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'devices'`)
        .all(),
    ).toEqual([]);
    dropped.close();

    const renamed = kindstore({
      filename,
      migrate(m) {
        m.rename("sessions", "authSessions");
      },
      schema: renamedSchema,
    });
    expect(renamed.authSessions.get(sessionId as never)).toEqual({
      id: sessionId as never,
      userId: "usr_1",
    });
    expect(renamed.users.get(retaggedUserId as never)).toEqual({
      id: retaggedUserId as never,
      email: "jane@example.com",
    });
    expect(
      renamed.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"users":1,"authSessions":1}' });
    renamed.close();

    const reopened = kindstore({
      filename,
      schema: renamedSchema,
    });
    expect(reopened.authSessions.get(sessionId as never)).toEqual({
      id: sessionId as never,
      userId: "usr_1",
    });
    expect(reopened.users.get(retaggedUserId as never)).toEqual({
      id: retaggedUserId as never,
      email: "jane@example.com",
    });
    expect(
      reopened.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'schema_snapshot'`)
        .get(),
    ).toEqual({
      payload: expect.stringContaining('"authSessions"'),
    });
    reopened.close();
  });

  test("rolls back failed schema reconciliation without mutating the existing store", () => {
    const filename = `file:kindstore-rollback-schema-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    const sessionId = initial.sessions.newId();
    initial.sessions.put(sessionId, {
      userId: "usr_1",
    });
    expect(() =>
      kindstore({
        filename,
        schema: {
          authSessions: kind("ses", Session).index("userId"),
        },
      }),
    ).toThrow();
    const reopened = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    expect(reopened.sessions.get(sessionId)).toEqual({
      id: sessionId,
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
      filename,
      schema: {
        tasks: kind("tsk", TaskV1),
      },
    });
    const taskId = initial.tasks.newId();
    initial.tasks.put(taskId, { title: "Ship v1" });
    const TaskV2 = z.object({
      title: z.string(),
      status: z.enum(["open", "done"]),
    });
    expect(() =>
      kindstore({
        filename,
        schema: {
          tasks: kind("tsk", TaskV2).migrate(2, {
            1: () => {
              throw new Error("boom");
            },
          }),
        },
      }),
    ).toThrow("boom");
    const reopened = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", TaskV1),
      },
    });
    expect(reopened.tasks.get(taskId)).toEqual({ id: taskId, title: "Ship v1" });
    expect(
      reopened.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"tasks":1}' });
    reopened.close();
    initial.close();
  });
});
