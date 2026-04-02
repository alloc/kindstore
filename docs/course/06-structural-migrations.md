# 06. Structural migrations

## Goal

Learn when a store-level structural migration is required and how to express it
explicitly.

## The problem structural migration solves

Payload migration rewrites document bodies inside a kind.

Structural migration handles changes such as:

- renaming a kind in the registry
- deleting a previously persisted kind
- changing a kind's tag

These changes affect row ownership or document identity, so kindstore requires
explicit intent instead of guessing.

## Use the top-level `schema.migrate(...)` planner

```ts
import { z } from "zod";
import { kind, kindstore } from "kindstore";

const WorkItem = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
});

const db = kindstore({
  connection: { filename: ":memory:" },
  schema: {
    migrate(m) {
      m.rename("tasks", "workItems");
      m.retag("workItems", "tsk");
      m.drop("drafts");
    },
  },
  workItems: kind("wrk", WorkItem).index("status"),
});
```

This tells kindstore:

- the previous `tasks` collection is now `workItems`
- the current `workItems` kind used to have the tag `"tsk"`
- the previous `drafts` collection should be removed

## Understand each operation

### `rename(previousKindKey, nextKindKey)`

Use this when a current collection is the continuation of a previous collection
under a new registry key. For example, `m.rename("tasks", "workItems")` says
that `workItems` now owns the rows that previously belonged to `tasks`.

### `drop(previousKindKey)`

Use this when a previous collection should be deleted instead of carried
forward. For example, `m.drop("drafts")` is the explicit way to say that old
draft rows should not survive into the new store shape.

### `retag(kindKey, previousTag)`

Use this when the collection is still the same logical kind but its tagged ID
prefix is changing. For example, `m.retag("workItems", "tsk")` says that the
current `workItems` collection used to use the `"tsk"` tag and is now switching
to a new one.

## When startup will fail

kindstore fails store open when a structural change needs explicit intent and
you did not provide it.

Typical examples:

- a previously persisted kind disappears from the registry
- a kind changes tag without a matching `retag(...)`
- the planner describes a contradictory or irrelevant operation

This fail-closed behavior is intentional.

## What stays automatic

Not every declaration change needs a structural migration.

kindstore can still reconcile derived query support automatically when you add,
remove, or change declared indexes. The explicit planner is reserved for changes
that affect ownership, deletion, or tagged identity.

## A useful decision rule

Ask this question:

Does this change alter which rows belong to which kind, or how those rows are
identified?

If the answer is yes, you probably need store-level schema migration.

If the answer is no, it is probably either:

- a payload migration, or
- an automatically derived structural change

For example:

- adding `updatedAt` to a task payload is a payload migration
- adding an index for `status` is an automatically derived structural change
- renaming `tasks` to `workItems` is a structural migration

## Next

Return to [README.md](./README.md) and use the course as a reference when you
design new kinds or migrations.
