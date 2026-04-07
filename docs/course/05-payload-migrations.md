# 05. Payload migrations

This lesson is about changing a kind's document shape without leaving old rows
behind.

If you need the broader migration model first, read
[../migration-pipeline.md](../migration-pipeline.md).

## When you need this

Use payload migration when the kind stays the same logical collection, but the
document body needs to change shape.

Typical examples:

- add a required field with a default
- rename or normalize a field inside the payload
- introduce a managed timestamp such as `.updatedAt()`

If the change affects which rows belong to which kind, or changes the tag in
persisted IDs, this is not the right tool.

## Minimal example

```ts
import { z } from "zod";
import { kind, kindstore } from "kindstore";

const TaskV1 = z.object({
  title: z.string(),
});

const db = kindstore({
  filename: ":memory:",
  schema: {
    tasks: kind("tsk", TaskV1),
  },
});
```

```ts
const TaskV2 = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
});
```

You can declare the new version and its upgrade step on the kind:

```ts
const db = kindstore({
  filename: ":memory:",
  schema: {
    tasks: kind("tsk", TaskV2)
      .updatedAt()
      .index("status")
      .index("updatedAt")
      .migrate(2, {
        1: (value) => ({
          ...value,
          status: "todo",
        }),
      }),
  },
});
```

## What this is not

Payload migration rewrites document bodies only. It does not:

- rename a kind in the store registry
- drop a previous kind
- change a kind's tag

Those are structural changes and belong to store-level migration instead.

## Keep in mind

- `.migrate(version, steps)` declares the current payload version and the step
  functions needed to reach it.
- Steps are eager. kindstore runs them during store open before typed reads and
  queries begin.
- Missing intermediate steps are an error.
- Old rows should be treated as partial input.
- The returned value must satisfy the new schema fully.
- `context.now` is available when the migration itself needs a stable
  timestamp.

For example:

```ts
1: (value, context) => ({
  ...value,
  status: "todo",
  migratedAt: context.now,
})
```

## Executable references

The best runnable examples for this topic are the migration tests rather than
standalone examples:

- [test/kindstore.e2e.test.ts](../../test/kindstore.e2e.test.ts):
  `runs eager migrations before reads and indexed queries`
- [test/kindstore.e2e.test.ts](../../test/kindstore.e2e.test.ts):
  `rolls back failed payload migrations without advancing kind versions`

## Next

Continue to [06-structural-migrations.md](./06-structural-migrations.md).
