import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore schema reconciliation", () => {
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

  test("preserves a missing previous kind as dormant when authorized by migrate", () => {
    const filename = `file:kindstore-preserve-${crypto.randomUUID()}?mode=memory&cache=shared`;
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
    const sessionId = initial.sessions.newId();
    initial.sessions.put(sessionId, {
      userId: "usr_1",
    });

    const preserved = kindstore({
      filename,
      migrate(m) {
        m.preserve("sessions");
      },
      schema: {
        users: kind("usr", User).index("email"),
      },
    });
    expect("sessions" in preserved).toBe(false);
    expect(preserved.raw.query(`SELECT "id", "data" FROM "sessions"`).all()).toEqual([
      {
        id: sessionId,
        data: '{"userId":"usr_1"}',
      },
    ]);
    expect(() => preserved.resolve(sessionId as never)).toThrow(
      `No kind is registered for tag "ses" from ID "${sessionId}".`,
    );
    const kindVersions = JSON.parse(
      (
        preserved.raw
          .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
          .get() as { payload: string }
      ).payload,
    );
    expect(kindVersions).toEqual({
      sessions: 1,
      users: 1,
    });
    const snapshot = JSON.parse(
      (
        preserved.raw
          .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'schema_snapshot'`)
          .get() as { payload: string }
      ).payload,
    );
    expect(Object.keys(snapshot.kinds).sort()).toEqual(["sessions", "users"]);
    expect(snapshot.kinds.sessions).toMatchObject({
      tag: "ses",
      table: "sessions",
      version: 1,
    });

    expect(() =>
      kindstore({
        filename,
        schema: {
          users: kind("usr", User).index("email"),
        },
      }),
    ).toThrow('Previous kind "sessions" is missing');
    preserved.close();
    initial.close();
  });

  test("rejects preserve declarations that conflict with current or unknown kinds", () => {
    const Session = z.object({
      userId: z.string(),
    });
    const User = z.object({
      email: z.string(),
    });

    {
      const filename = `file:kindstore-preserve-current-${crypto.randomUUID()}?mode=memory&cache=shared`;
      const initial = kindstore({
        filename,
        schema: {
          sessions: kind("ses", Session),
        },
      });
      expect(() =>
        kindstore({
          filename,
          migrate(m) {
            m.preserve("sessions");
          },
          schema: {
            sessions: kind("ses", Session),
          },
        }),
      ).toThrow('Schema migration preserve source "sessions" still exists');
      const reopened = kindstore({
        filename,
        schema: {
          sessions: kind("ses", Session),
        },
      });
      reopened.close();
      initial.close();
    }

    {
      const filename = `file:kindstore-preserve-unknown-${crypto.randomUUID()}?mode=memory&cache=shared`;
      const initial = kindstore({
        filename,
        schema: {
          sessions: kind("ses", Session),
        },
      });
      expect(() =>
        kindstore({
          filename,
          migrate(m) {
            m.preserve("missing");
          },
          schema: {
            users: kind("usr", User),
          },
        }),
      ).toThrow('Schema migration preserve references unknown previous kind "missing".');
      const reopened = kindstore({
        filename,
        schema: {
          sessions: kind("ses", Session),
        },
      });
      reopened.close();
      initial.close();
    }

    {
      const filename = `file:kindstore-preserve-table-conflict-${crypto.randomUUID()}?mode=memory&cache=shared`;
      const initial = kindstore({
        filename,
        schema: {
          auth_sessions: kind("ses", Session),
        },
      });
      expect(() =>
        kindstore({
          filename,
          migrate(m) {
            m.preserve("auth_sessions");
          },
          schema: {
            authSessions: kind("usr", User),
          },
        }),
      ).toThrow(
        'Current kind "authSessions" cannot use table "auth_sessions" because it belongs to preserved kind "auth_sessions".',
      );
      const reopened = kindstore({
        filename,
        schema: {
          auth_sessions: kind("ses", Session),
        },
      });
      reopened.close();
      initial.close();
    }

    {
      const filename = `file:kindstore-preserve-tag-conflict-${crypto.randomUUID()}?mode=memory&cache=shared`;
      const initial = kindstore({
        filename,
        schema: {
          sessions: kind("ses", Session),
        },
      });
      expect(() =>
        kindstore({
          filename,
          migrate(m) {
            m.preserve("sessions");
          },
          schema: {
            users: kind("ses", User),
          },
        }),
      ).toThrow(
        'Current kind "users" cannot use tag "ses" because it belongs to preserved kind "sessions".',
      );
      const reopened = kindstore({
        filename,
        schema: {
          sessions: kind("ses", Session),
        },
      });
      reopened.close();
      initial.close();
    }
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
          m.preserve("");
        },
        schema: {
          sessions: kind("ses", Session).index("userId"),
        },
      }),
    ).toThrow("Schema migration preserve key must be non-empty.");

    expect(() =>
      kindstore({
        filename,
        migrate(m) {
          m.preserve("sessions");
          m.preserve("sessions");
        },
        schema: {
          sessions: kind("ses", Session).index("userId"),
        },
      }),
    ).toThrow('Schema migration already defines an operation for previous kind "sessions".');

    expect(() =>
      kindstore({
        filename,
        migrate(m) {
          m.drop("sessions");
          m.preserve("sessions");
        },
        schema: {
          sessions: kind("ses", Session).index("userId"),
        },
      }),
    ).toThrow('Schema migration already defines an operation for previous kind "sessions".');

    expect(() =>
      kindstore({
        filename,
        migrate(m) {
          m.preserve("sessions");
          m.rename("sessions", "authSessions");
        },
        schema: {
          sessions: kind("ses", Session).index("userId"),
        },
      }),
    ).toThrow('Schema migration already defines an operation for previous kind "sessions".');

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


});
