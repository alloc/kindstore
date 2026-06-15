import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore managed timestamps", () => {
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
});
