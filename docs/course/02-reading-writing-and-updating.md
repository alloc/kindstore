# 02. Reading, writing, and updating

## Goal

Learn the everyday collection workflow and the behavioral difference between
replacement writes and updates.

## Set up a collection

```ts
import { z } from "zod";
import { kind, kindstore } from "kindstore";

const Task = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  updatedAt: z.number().int(),
  assigneeId: z.string().optional(),
});

const db = kindstore({
  connection: { filename: ":memory:" },
  tasks: kind("tsk", Task).index("status").index("updatedAt", { type: "integer" }),
});
```

## Create a document

```ts
const id = db.tasks.newId();

db.tasks.put(id, {
  title: "Ship docs",
  status: "todo",
  updatedAt: Date.now(),
});
```

`newId()` gives you a tagged ID for the collection. `put()` validates the value
and stores it under that ID.

## Read a document

```ts
const task = db.tasks.get(id);
```

`get()` returns the validated document or `undefined` when the ID does not
exist.

## Understand `put`

`put()` is a replacement write.

That means:

- if the ID is new, the document is inserted
- if the ID already exists, the stored payload is replaced
- `put()` does not merge fields into the existing payload

```ts
db.tasks.put(id, {
  title: "Ship docs today",
  status: "doing",
  updatedAt: Date.now(),
});
```

Use `put()` when you already have the full next document.
For example, a form submit that sends the full next task object is a good fit
for `put()`.

## Use `update()` for partial or computed changes

Patch style:

```ts
db.tasks.update(id, {
  status: "done",
  updatedAt: Date.now(),
});
```

Function style:

```ts
db.tasks.update(id, (current) => ({
  ...current,
  status: "doing",
  updatedAt: Date.now(),
}));
```

Use patch style when the change is obvious and shallow. Use function style when
the next value depends on the current document. For example, patch style works
well for "set `status` to `done`", while function style is safer for "append a
derived field based on the current value" because you can inspect the existing
document first.

If the document does not exist, `update()` returns `undefined`.

## Delete a document

```ts
const removed = db.tasks.delete(id);
```

`delete()` returns `true` when something was removed and `false` otherwise.

## A practical workflow

```ts
const id = db.tasks.newId();

db.tasks.put(id, {
  title: "Review pull request",
  status: "todo",
  updatedAt: Date.now(),
});

db.tasks.update(id, {
  status: "doing",
  updatedAt: Date.now(),
});

const latest = db.tasks.get(id);
```

This is the core loop for most collections:

- create IDs with `newId()`
- write full documents with `put()`
- make targeted changes with `update()`
- read with `get()`

## Rules to internalize

- `put()` replaces the payload. It is not a merge helper. If you leave out a
  field during `put()`, kindstore treats that as part of the new full document,
  not as "keep the old value."
- `update()` is the typed partial-update path, so prefer it when you only want
  to change `status`, `updatedAt`, or another small part of the document.
- Collection methods are tag-aware. Use the ID from the matching collection,
  because a `tasks` ID should not be accepted by a different kind just because
  both are strings.
- All typed reads and writes pass through schema validation, which is why the
  typed API is the safe default and raw SQL is not.

## Next

Continue to [03-indexed-queries.md](./03-indexed-queries.md).
