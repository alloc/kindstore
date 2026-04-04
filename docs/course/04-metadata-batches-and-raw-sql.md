# 04. Metadata, batches, and raw SQL

## Goal

Learn how to use store-level metadata, group writes atomically, and decide when
to leave the typed API.

## Add application metadata

```ts
import { z } from "zod";
import { kind, kindstore } from "kindstore";

const Task = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  updatedAt: z.number().int(),
});

const Preferences = z.object({
  theme: z.enum(["light", "dark"]).default("dark"),
  lastOpenedAt: z.number().int().optional(),
});

const db = kindstore({
  filename: ":memory:",
  metadata: { preferences: Preferences },
  schema: {
    tasks: kind("tsk", Task).index("status").index("updatedAt"),
  },
});
```

Application metadata is a typed key/value space owned by your app.

kindstore does not add store-managed metadata timestamps. If you want metadata
creation or update times, include them in the metadata schema and set them in
your app code.

## Read and write metadata

```ts
db.metadata.set("preferences", {
  theme: "dark",
  lastOpenedAt: Date.now(),
});

const preferences = db.metadata.get("preferences");

db.metadata.update("preferences", (current) => ({
  ...(current ?? { theme: "dark" }),
  lastOpenedAt: Date.now(),
}));
```

Here `lastOpenedAt` is just part of the metadata payload. kindstore does not
maintain metadata timestamps unless your app stores them explicitly.

Use metadata for small store-scoped values such as:

- preferences
- cursors
- sync checkpoints
- feature flags

Do not use it as a substitute for a real document kind when the value set needs
history, indexing, or per-record identity. For example, a single
`preferences` record belongs in metadata, but a growing set of user-owned
notifications should be modeled as its own kind.

## Group changes with `batch()`

```ts
db.batch(() => {
  db.tasks.put(db.tasks.newId(), {
    title: "Write release notes",
    status: "todo",
    updatedAt: Date.now(),
  });

  db.metadata.set("preferences", {
    theme: "light",
    lastOpenedAt: Date.now(),
  });
});
```

Use `batch()` when several writes should succeed or fail together.

Common examples:

- write a document and update a checkpoint
- delete one document and create another
- coordinate a metadata change with a data change

## Use raw SQL deliberately

```ts
const rows = db.raw
  .query(`SELECT count(*) AS count FROM "tasks" WHERE "status" = ?`)
  .get("todo");
```

Raw access is useful when you need:

- operational inspection
- an ad hoc query outside the typed API
- SQLite-specific behavior the typed surface does not model

For example, counting rows for a quick operational check is a good raw-read
case, while ordinary task reads should still go through `db.tasks`.

## Know the boundary

The typed API gives you:

- validation
- typed field-level query constraints
- migration-aware collection access

Raw access does not.

That means raw reads are fine for inspection, but raw writes should be used very
carefully because they can bypass the assumptions kindstore relies on.

## Rules to internalize

- Use metadata for small typed store-level state, not as a catch-all table,
  because metadata is best for one-off values like preferences or checkpoints.
- Use `batch()` whenever a group of writes should succeed atomically. For
  example, create a task and advance a sync cursor together if either change
  would be wrong without the other.
- Use raw SQL as an escape hatch, not as your default access pattern, because
  raw writes can bypass validation and migration-aware behavior.

## Next

Continue to [05-payload-migrations.md](./05-payload-migrations.md).
