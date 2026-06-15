import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore indexed queries", () => {
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
});
