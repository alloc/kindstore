Here’s a compact technical introduction plus an API sketch that shows the shape we landed on.

This design is a lightweight document store built on top of SQLite for local-only applications with fast-moving schemas. The core idea is to keep SQLite doing the jobs it is very good at—durable storage, indexing, filtering, ordering, and transactional updates—while letting Zod define document structure and TypeScript provide a typed API over each document kind.

The “why” is mostly about avoiding the two extremes. A fully normalized relational model is often too rigid when schemas are evolving quickly, while a pure untyped key-value blob store tends to decay into hard-to-query data and weak invariants. This design aims for the middle: each document kind gets its own table, documents are stored as JSON payloads, top-level fields that matter for querying are promoted into generated indexed columns, and everything else stays inside the payload. That keeps writes flexible, reads efficient, migrations explicit, and the abstraction small enough that it does not turn into an ORM.

The `db` is the center of the system. It declares each kind’s tag, schema, indexed fields, composite indexes, and migration logic. From that, the store exposes a typed collection API like `db.sessions.put()` and `db.sessions.findMany()`, plus a typed `db.metadata` namespace for store and app metadata. Querying stays intentionally narrow: enough to cover common indexed lookups and ordered scans, while still leaving a raw SQL escape hatch for anything more specialized.

```ts
import { z } from "zod";
import { kindstore, kind } from "kindstore";

const Session = z.object({
  userId: z.string(),
  status: z.enum(["active", "revoked", "expired"]),
  expiresAt: z.number().int(),
  updatedAt: z.number().int(),
  deviceId: z.string().optional(),
});

const User = z.object({
  email: z.string().email(),
  handle: z.string(),
  displayName: z.string(),
  createdAt: z.number().int(),
});

const AppMetadata = z.object({
  theme: z.enum(["light", "dark"]).default("dark"),
  lastOpenedAt: z.number().int().optional(),
});

const db = kindstore({
  connection: { filename: ":memory:" },

  metadata: {
    app: AppMetadata,
    customFlags: z.record(z.string(), z.boolean()),
  },

  sessions: kind("ses", Session)
    .index("userId")
    .index("status")
    .index("expiresAt", { type: "integer" })
    .index("updatedAt", { type: "integer" })
    .multi("user_status", { userId: "asc", status: "asc" })
    .multi("user_updatedAt", { userId: "asc", updatedAt: "desc" })
    .migrate(2, {
      1: (value, ctx) => ({
        ...value,
        status: value.status ?? "active",
        updatedAt: value.updatedAt ?? ctx.now,
      }),
    }),

  users: kind("usr", User)
    .index("email")
    .index("handle")
    .index("createdAt", { type: "integer" })
    .multi("handle_createdAt", { handle: "asc", createdAt: "desc" }),
});

// typed IDs
const userId = db.users.newId();
const sessionId = db.sessions.newId();

// CRUD
db.users.put(userId, {
  email: "jane@example.com",
  handle: "jane",
  displayName: "Jane Doe",
  createdAt: Date.now(),
});

db.sessions.put(sessionId, {
  userId,
  status: "active",
  expiresAt: Date.now() + 1000 * 60 * 60 * 24,
  updatedAt: Date.now(),
});

const user = db.users.get(userId);
const session = db.sessions.get(sessionId);

// typed updates
db.sessions.update(sessionId, (current) => ({
  ...current,
  status: "revoked",
  updatedAt: Date.now(),
}));

// patch updates
db.sessions.update(sessionId, {
  status: "expired",
  updatedAt: Date.now(),
});

// small indexed query API
const activeSessions = db.sessions.findMany({
  where: {
    userId,
    status: "active",
    expiresAt: { gt: Date.now() },
  },
  orderBy: {
    updatedAt: "desc",
  },
  limit: 50,
});

// lazy iteration for JS-side post-filtering
for (const s of db.sessions.iterate({
  where: { userId },
  orderBy: { updatedAt: "desc" },
})) {
  if (s.deviceId?.startsWith("mobile:")) {
    console.log("mobile session", s);
  }
}

const newestJane = db.users.first({
  where: { handle: "jane" },
  orderBy: { createdAt: "desc" },
});

// metadata is first-class and typed
db.metadata.set("app", {
  theme: "dark",
  lastOpenedAt: Date.now(),
});

const appMeta = db.metadata.get("app");

db.metadata.update("customFlags", (flags) => ({
  ...flags,
  onboardingComplete: true,
}));

// batch operations in a single transaction
db.batch(() => {
  db.sessions.delete(sessionId);
  db.metadata.set("app", {
    ...(appMeta ?? { theme: "dark" }),
    lastOpenedAt: Date.now(),
  });
});

// direct escape hatch to bun:sqlite instance (with automatic camel-to-snake mapping)
db.raw.query("SELECT * FROM sessions WHERE user_id = ?").all(userId);
```

A good way to describe this API is: typed document collections over SQLite, not an ORM. The library knows enough to validate documents, generate per-kind tables and indexes, run explicit migrations, and compile a narrow `findMany` into efficient SQL. Beyond that, it stays out of the way.
