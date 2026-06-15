import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore", () => {
  test("enforces declared unique single-field and composite indexes", () => {
    const filename = `file:kindstore-unique-indexes-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Membership = z.object({
      accountId: z.string(),
      email: z.string(),
      role: z.enum(["owner", "member"]),
    });
    const db = kindstore({
      filename,
      schema: {
        memberships: kind("mem", Membership).index("email", { unique: true }).multi(
          "account_role",
          {
            accountId: "asc",
            role: "asc",
          },
          { unique: true },
        ),
      },
    });

    db.memberships.create({
      accountId: "acct_1",
      email: "jane@example.com",
      role: "owner",
    });

    expect(() =>
      db.memberships.create({
        accountId: "acct_2",
        email: "jane@example.com",
        role: "member",
      }),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db.memberships.create({
        accountId: "acct_1",
        email: "john@example.com",
        role: "owner",
      }),
    ).toThrow(/UNIQUE/i);

    expect(db.raw.query(`PRAGMA index_list('memberships')`).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "idx_memberships_email", unique: 1 }),
        expect.objectContaining({ name: "idx_memberships_account_role", unique: 1 }),
      ]),
    );

    db.close();
  });

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

    expect(() =>
      kindstore({
        filename,
        migrate(m) {
          m.prepareConstraints("dedupe-sessions", () => {});
          m.prepareConstraints("dedupe-sessions", () => {});
        },
        schema: {
          sessions: kind("ses", Session).index("userId"),
        },
      }),
    ).toThrow('Constraint preparation migration "dedupe-sessions" is already defined.');
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
