# 05. Payload migrations

## Goal

Learn how to evolve a kind's document payload shape without leaving persisted
rows behind.

## Start with version 1

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

At this point, `tasks` is at payload version `1`.

## Evolve the schema

Now suppose version 2 adds `status` and `updatedAt`.

```ts
const TaskV2 = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  updatedAt: z.number().int(),
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

## Understand the model

The `migrate(version, steps)` call means:

- the current payload version for this kind is `version`
- each numbered step upgrades from one version to the next
- missing steps are an error

In the example above, the step labeled `1` upgrades rows from version 1 to
version 2.

## Migrations are eager

Payload migrations run when the store opens, before ordinary typed reads and
queries begin.

That means callers do not have to:

- touch old rows to upgrade them
- handle mixed payload versions at read time
- guess whether indexed queries are seeing stale row shapes

This is a major part of kindstore's model.

## Use `context.now` when the migration itself needs a timestamp

The migration context currently gives you a store-managed `now` value.

That is useful when the migration itself needs to introduce timestamps or other
derived defaults without calling `Date.now()` repeatedly inside the migration
loop.

In the example above, `updatedAt` does not need `context.now` because the kind
declared `.updatedAt()`, so the store assigns it automatically on
migration rewrites too.

If a later migration also introduced a separate timestamp field, a step could
look like this:

```ts
1: (value, context) => ({
  ...value,
  status: "todo",
  migratedAt: context.now,
})
```

## Practical rules

- Keep migration steps small and explicit. For example, add `status` and
  `updatedAt` in one version step instead of mixing unrelated redesign work into
  the same migration.
- Treat old persisted rows as partial input, because earlier versions may not
  have every field your new schema expects.
- Make the returned value satisfy the new schema completely. If version 2
  requires `status`, the migration should always produce one.
- Add new indexes alongside the new schema version if the new fields need typed
  querying. For example, if version 2 introduces `updatedAt` and you plan to
  order by it, declare that index in the same upgraded kind definition.

## What payload migrations do not solve

Payload migrations change document bodies. They do not handle:

- renaming a kind in the store registry
- deleting a previously persisted kind
- changing a kind's tag

Those are structural changes and belong to store-level schema migration.

## Next

Continue to [06-structural-migrations.md](./06-structural-migrations.md).
