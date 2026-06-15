import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore unique constraints", () => {
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
});
