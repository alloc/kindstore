# kindstore

kindstore is a registry-driven document store for Bun and SQLite. You define
document kinds with Zod, declare which top-level fields are queryable, and keep
payload and schema migrations explicit.

Requires Bun at runtime because kindstore uses `bun:sqlite`.

```sh
bun add kindstore zod
```

```ts
import { z } from "zod";
import { kind, kindstore } from "kindstore";

const Session = z.object({
  userId: z.string(),
  status: z.enum(["active", "revoked"]),
  updatedAt: z.number().int(),
});

const db = kindstore({
  connection: { filename: ":memory:" },
  sessions: kind("ses", Session)
    .updatedAt("updatedAt")
    .index("userId")
    .index("status")
    .index("updatedAt", { type: "integer" }),
});

const id = db.sessions.newId();

db.sessions.put(id, {
  userId: "usr_1",
  status: "active",
});

const activeSessions = db.sessions.findMany({
  where: { status: "active" },
  orderBy: { updatedAt: "desc" },
});

const firstPage = db.sessions.findPage({
  where: { status: "active" },
  orderBy: { updatedAt: "desc" },
  limit: 20,
});
```

Next:

- Start with the intermediate guides in [docs/course/README.md](./docs/course/README.md)
- Read the maintainer-facing system docs in [docs/architecture-overview.md](./docs/architecture-overview.md)
