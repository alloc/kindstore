# 06. Structural migrations

This lesson is about changes that affect kind ownership or document identity.

If you need the maintainer-facing policy boundary first, read
[../schema-reconciliation.md](../schema-reconciliation.md).

## When you need this

Use structural migration when the declaration changes row ownership or document
identity across store opens.

Typical examples:

- a collection key is renamed
- an old kind should be removed explicitly
- a kind keeps its rows but changes ID tag prefix

If the kind stays the same logical collection and only the payload body changes,
you want payload migration instead.

## Minimal example

```ts
import { z } from "zod";
import { kind, kindstore } from "kindstore";

const WorkItem = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
});

const db = kindstore({
  filename: ":memory:",
  migrate(m) {
    m.rename("tasks", "workItems");
    m.retag("workItems", "tsk");
    m.drop("drafts");
  },
  schema: {
    workItems: kind("wrk", WorkItem).index("status"),
  },
});
```

## What this is not

Structural migration is not for rewriting fields inside stored documents. It
does not replace kind-level `.migrate(version, steps)`.

## Choose the right kind of migration

Ask this question:

Does this change alter which rows belong to which kind, or how those rows are
identified?

- Yes: use top-level `migrate(planner)`.
- No: it is probably a payload migration or an automatic derived-structure
  change.

## Planner operations

- `rename(previousKindKey, nextKindKey)`: current kind continues a previous
  kind under a new registry key.
- `drop(previousKindKey)`: explicitly remove a previous kind.
- `preserve(previousKindKey)`: keep an omitted previous kind dormant for a
  future declaration without exposing it on the current typed store.
- `retag(kindKey, previousTag)`: keep the same logical kind but change the ID
  tag prefix.

For optional modules or feature packages, use preserve when the current process
intentionally omits a previous kind but still owns its data:

```ts
const db = kindstore({
  filename: "app.sqlite",
  migrate(m) {
    m.preserve("drafts");
  },
  schema: {
    tasks: kind("tsk", Task),
  },
});
```

While preserved, `drafts` keeps its table, rows, structural history, and payload
version metadata. It is not available as `db.drafts`, does not participate in
`db.resolve(id)`, and does not run payload migrations until `drafts` is declared
again.

## Keep in mind

- kindstore fails store open when this intent is required but missing.
- Tag changes are structural because the tag is part of persisted identity.
- Preserved dormant kinds reserve their owned table and ID tag while omitted.
- Index additions or removals are still automatic derived-structure changes.

## Executable references

The best runnable examples for this topic are the structural migration tests:

- [test/kindstore.e2e.test.ts](../../test/kindstore.e2e.test.ts):
  `requires an explicit schema migration for a missing previous kind`
- [test/kindstore.e2e.test.ts](../../test/kindstore.e2e.test.ts):
  `renames a previous kind when authorized by migrate`
- [test/kindstore.e2e.test.ts](../../test/kindstore.e2e.test.ts):
  `drops a previous kind when authorized by migrate`
- [test/kindstore.e2e.test.ts](../../test/kindstore.e2e.test.ts):
  `retags a kind when authorized by migrate`
- [test/kindstore.e2e.test.ts](../../test/kindstore.e2e.test.ts):
  `rolls back failed schema reconciliation without mutating the existing store`

## Next

Return to [README.md](./README.md) and use the course as a reference when you
design new kinds or migrations.
