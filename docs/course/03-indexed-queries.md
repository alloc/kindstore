# 03. Indexed queries

This lesson is about shaping kinds around the queries you really run.

Run [examples/indexed-queries.ts](../../examples/indexed-queries.ts) for
the canonical workflow. Use this page to keep the query model honest.

## Start from declared query fields

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
      .index("updatedAt")
      .index("assigneeId")
      .multi("status_updatedAt", {
        status: "asc",
        updatedAt: "desc",
      }),
  },
});
```

Only declared query fields participate in typed filtering and ordering:
top-level payload fields from `.index(...)` or `.multi(...)`, plus `id` when it
is included in `.multi(...)`.

## Choose the right query method

- `first(...)`: one row, ideally with explicit `orderBy`.
- `findMany(...)`: eager result set.
- `iterate(...)`: incremental processing without materializing everything.
- `findPage(...)`: forward-only keyset pagination.

## Keep the boundary small

- Supported filters are equality, `null`, `in`, `gt`, `gte`, `lt`, and `lte`.
- Ordering is only on declared query fields.
- `findPage(...)` requires explicit `orderBy` and a positive `limit`.
- kindstore adds document ID as an internal tie-breaker for deterministic
  paging.
- When a query needs undeclared fields, joins, or complex boolean logic, narrow
  with the typed API first or drop to raw SQL.

## Design indexes from queries

Think in this order:

1. What does the caller filter by?
2. What does the caller sort by?
3. Does the workflow want eager results, iteration, or paging?

If you cannot name a real query shape yet, do not add the index yet.

## Next

Continue to [04-metadata-batches-and-raw-sql.md](./04-metadata-batches-and-raw-sql.md).
