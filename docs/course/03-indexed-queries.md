# 03. Indexed queries

## Goal

Learn how kindstore's narrow query model works and how to shape your kinds
around it.

## Start from declared queryable fields

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
  filename: ":memory:",
  schema: {
    tasks: kind("tsk", Task)
      .index("status")
      .index("updatedAt", { type: "integer" })
      .index("assigneeId")
      .multi("status_updatedAt", {
        status: "asc",
        updatedAt: "desc",
      }),
  },
});
```

Only declared queryable fields participate in typed filtering and ordering.

## Use `findMany()` for eager result sets

```ts
const tasks = db.tasks.findMany({
  where: {
    status: "doing",
    updatedAt: { gte: startOfDay },
  },
  orderBy: { updatedAt: "desc" },
  limit: 20,
});
```

The typed query language supports:

- equality
- `null`
- `in`
- `gt`, `gte`, `lt`, `lte`
- `orderBy`
- `limit`

It does not support arbitrary boolean composition or relation traversal.

## Use `findPage()` for forward keyset pagination

```ts
const firstPage = db.tasks.findPage({
  where: { status: "doing" },
  orderBy: { updatedAt: "desc" },
  limit: 20,
});

const secondPage = db.tasks.findPage({
  where: { status: "doing" },
  orderBy: { updatedAt: "desc" },
  limit: 20,
  after: firstPage.next,
});
```

`findPage()` is a narrow helper over the same indexed query model:

- it requires explicit `orderBy`
- it requires a positive `limit`
- it only paginates forward
- it adds document ID as an internal tie-breaker for deterministic paging
- ordered fields should be non-null across page boundaries

## Use `first()` when you need one row

```ts
const nextTask = db.tasks.first({
  where: { status: "todo" },
  orderBy: { updatedAt: "desc" },
});
```

If more than one document can match, provide an explicit `orderBy` so the result
is meaningful. For example, "the next task to review" only makes sense if you
also say whether "next" means newest, oldest, or some other ordering.

## Use `iterate()` for streaming-style workflows

```ts
for (const task of db.tasks.iterate({
  where: { assigneeId: "usr_1" },
  orderBy: { updatedAt: "desc" },
})) {
  if (task.status !== "done") {
    console.log(task.title);
  }
}
```

This is a good fit when you want SQLite to narrow the candidate set and then
apply additional business logic in JavaScript without materializing everything
at once.

## Design query patterns, not just indexes

The most useful way to think about indexing in kindstore is:

- what does the caller filter by
- what does the caller sort by
- what should be bounded with `limit`

For example, this declaration:

```ts
kind("tsk", Task)
  .index("status")
  .index("updatedAt", { type: "integer" })
  .multi("status_updatedAt", {
    status: "asc",
    updatedAt: "desc",
  });
```

is motivated by queries like:

```ts
db.tasks.findMany({
  where: { status: "doing" },
  orderBy: { updatedAt: "desc" },
  limit: 50,
});
```

## Know when to stop using the typed query API

If your query depends on:

- undeclared fields
- advanced boolean logic
- joins
- ad hoc operational inspection

use one of these patterns:

- narrow with kindstore's typed query API and finish in JavaScript
- drop to raw SQL

kindstore is intentionally strict here.
That strictness keeps the typed API honest: when a query stops fitting the
declared indexed model, the library wants you to notice instead of assuming it
can optimize arbitrary document queries.

## Rules to internalize

- Query only on fields you declared as queryable, because kindstore's typed
  query model is intentionally restricted to those fields.
- Prefer `iterate()` when you want incremental processing. For example, it is a
  better fit than `findMany()` when you want to scan assigned tasks and stop
  once you find the first one that still needs follow-up.
- Add composite indexes to match real filter-plus-sort patterns. For example, a
  `status + updatedAt` composite index is motivated by queries like "show the
  newest tasks with status `doing`."
- Treat `first()` without explicit ordering as meaningful only when the match is
  unique, because otherwise "first" may not mean what your caller expects.

## Next

Continue to [04-metadata-batches-and-raw-sql.md](./04-metadata-batches-and-raw-sql.md).
