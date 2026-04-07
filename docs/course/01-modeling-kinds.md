# 01. Modeling kinds

This lesson is about the one decision that matters most in kindstore: choosing
the query surface, not just the payload shape.

If you want the full mental model first, read [../context.md](../context.md).
If you want a runnable version of this lesson, start with
[examples/indexed-queries.ts](../../examples/indexed-queries.ts).

## Start from a real kind

```ts
import { kind } from "kindstore";

const Tasks = kind("tsk", Task)
  .index("status")
  .index("updatedAt")
  .index("assigneeId")
  .multi("status_updatedAt", {
    status: "asc",
    updatedAt: "desc",
  });
```

The collection key such as `tasks` is the name you use in code. The `"tsk"` tag
is the storage identity embedded in document IDs.

## What to decide

- Choose a short stable tag. Changing it later is a structural migration.
- Keep the payload schema about business data, not query ambitions.
- Declare only the top-level fields you will actually filter or sort on.
- Add `.createdAt()` or `.updatedAt()` only when the store should own those
  payload fields.
- Add `.multi(...)` only for real filter-plus-sort patterns you expect to run.

## Keep in mind

- `.updatedAt()` and `.createdAt()` control assignment policy, not queryability.
  Add `.index(...)` too when you need typed filtering or ordering.
- `.multi(...)` can include top-level payload fields and `id`.
- SQLite type hints are optional unless inference cannot determine the affinity
  you want.

## Next

Continue to [02-reading-writing-and-updating.md](./02-reading-writing-and-updating.md).
