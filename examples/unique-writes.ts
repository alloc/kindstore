import { z } from "zod";

import { kind, kindstore } from "../src/index";

const User = z.object({
  email: z.string(),
  name: z.string(),
  accountId: z.string(),
  role: z.enum(["owner", "member"]),
});

const db = kindstore({
  filename: ":memory:",
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

console.log({
  created,
  replaced,
  createdByComposite,
  sameId: created.id === replaced.id,
});
db.close();
