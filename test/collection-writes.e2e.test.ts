import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore collection writes", () => {
  test("putByUnique creates or replaces one document through a declared unique selector", () => {
    const filename = `file:kindstore-put-by-unique-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const User = z.object({
      email: z.string(),
      name: z.string(),
      accountId: z.string(),
      role: z.enum(["owner", "member"]),
    });
    const db = kindstore({
      filename,
      schema: {
        users: kind("usr", User).createdAt().updatedAt().index("email", { unique: true }).multi(
          "account_role",
          {
            accountId: "asc",
            role: "asc",
          },
          { unique: true },
        ),
      },
    });

    const created = db.users.putByUnique(
      {
        email: "jane@example.com",
      },
      {
        email: "jane@example.com",
        name: "Jane",
        accountId: "acct_1",
        role: "owner",
      },
    );
    const replaced = db.users.putByUnique(
      {
        email: "jane@example.com",
      },
      {
        email: "jane@example.com",
        name: "Jane Doe",
        accountId: "acct_1",
        role: "owner",
      },
    );
    const createdByComposite = db.users.putByUnique(
      {
        accountId: "acct_2",
        role: "member",
      },
      {
        email: "john@example.com",
        name: "John",
        accountId: "acct_2",
        role: "member",
      },
    );

    expect(replaced.id).toBe(created.id);
    expect(replaced.name).toBe("Jane Doe");
    expect(replaced.createdAt).toBe(created.createdAt);
    expect(replaced.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    expect(createdByComposite.id).not.toBe(created.id);
    expect(db.users.findMany()).toHaveLength(2);

    expect(() =>
      db.users.putByUnique(
        {
          email: "jane@example.com",
          role: "owner",
        } as never,
        {
          email: "jane@example.com",
          name: "Jane Again",
          accountId: "acct_1",
          role: "owner",
        },
      ),
    ).toThrow(
      'putByUnique() selector for kind "users" must exactly match one declared unique index.',
    );
    expect(() =>
      db.users.putByUnique(
        {
          email: "mismatch@example.com",
        },
        {
          email: "other@example.com",
          name: "Mismatch",
          accountId: "acct_3",
          role: "member",
        },
      ),
    ).toThrow('putByUnique() value for kind "users" must preserve selector field "email".');
    expect(() =>
      db.users.putByUnique(
        {
          email: { in: ["jane@example.com"] },
        } as never,
        {
          email: "jane@example.com",
          name: "Jane Again",
          accountId: "acct_1",
          role: "owner",
        },
      ),
    ).toThrow(
      'putByUnique() selector field "email" for kind "users" must use exact values, not filter operators.',
    );

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
});
