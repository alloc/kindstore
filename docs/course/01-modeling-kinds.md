# 01. Modeling kinds

## Goal

Learn how to model a kind so it stays easy to query, migrate, and maintain over
time.

## Mental model

A kind is the unit of storage in kindstore.

Each kind combines:

- a stable tag used in generated IDs
- a Zod schema for runtime validation and type inference
- a set of declared queryable fields
- an optional payload migration history

The most important decision is not the schema itself. It is deciding which
fields deserve indexed query support.

## Start with the payload shape

```ts
import { z } from "zod";

const Task = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  updatedAt: z.number().int(),
  assigneeId: z.string().optional(),
});
```

This shape describes your business data. At this stage, nothing is queryable
yet.

## Add a stable tag

```ts
import { kind } from "kindstore";

const Tasks = kind("tsk", Task);
```

Tags become part of persisted document IDs. Treat them as stable storage
identifiers, not presentation text.

Good tag choices are:

- short
- unambiguous
- stable across refactors

Avoid choosing tags based on temporary naming preferences, because changing a
tag later is a structural migration rather than a harmless rename. For example,
choosing `"task"` now and later deciding you prefer `"tsk"` forces you to treat
the change as persisted identity work.

## Let kindstore own payload timestamps when you mean it

```ts
const TimestampedTask = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const TimestampedTasks = kind("tsk", TimestampedTask)
  .createdAt()
  .updatedAt()
  .index("updatedAt", { type: "integer" });
```

Use this when `createdAt` and `updatedAt` are store-owned payload fields rather
than caller-owned data. The benefit is that callers do not need to assign or
preserve those values manually, while the fields still live in the payload
schema readers work with.

Notice that `.updatedAt()` does not imply `.index("updatedAt")`.
One is about value assignment policy. The other is about query intent.

## Declare only the fields you will actually query

```ts
const Tasks = kind("tsk", Task)
  .index("status")
  .index("updatedAt", { type: "integer" })
  .index("assigneeId");
```

This is the core tradeoff in kindstore:

- every field stays in the document payload
- only declared top-level fields become part of the typed query model

That means you should index fields based on actual query needs, not just because
they might be useful later.

## Add a composite index for real query shapes

```ts
const Tasks = kind("tsk", Task)
  .index("status")
  .index("updatedAt", { type: "integer" })
  .index("assigneeId")
  .multi("status_updatedAt", {
    status: "asc",
    updatedAt: "desc",
  });
```

Use a composite index when your common query shape depends on more than one
field. Typical examples are:

- equality plus sort
- equality plus range
- equality plus equality

If you do not have a real query pattern in mind, do not add the composite index
yet. For example, adding `.multi("status_updatedAt", { status: "asc",
updatedAt: "desc" })` only makes sense if you actually expect queries like
"show the most recently updated tasks with status `doing`."

## Put the kind into a store

```ts
import { kindstore } from "kindstore";

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

The `tasks` key is the collection name you use in code. The `"tsk"` tag is the
storage identity used in document IDs.

## Rules to internalize

- Index only top-level schema fields, because the typed query API is built
  around declared top-level fields such as `status` or `updatedAt`, not nested
  document paths.
- Use explicit SQLite type hints when the indexed field is numeric and you want
  integer ordering or comparison semantics. For example, `.index("updatedAt",
{ type: "integer" })` makes the intent clear for timestamp queries.
- Keep tags stable even if the collection name in code changes later, because
  the code-level collection name can be renamed with structural migration while
  the tag remains part of persisted document identity.
- Use `.createdAt(...)` and `.updatedAt(...)` only when the store should own
  those payload fields. For example, a user-supplied `publishedAt` field usually
  stays caller-owned, while a store-managed `updatedAt` field is a strong fit
  for `.updatedAt()`.
- Model for your real query patterns, not for hypothetical ones. For example,
  add an index for `assigneeId` if you routinely fetch "tasks assigned to
  `usr_1`", not just because that field exists in the schema.

## Next

Continue to [02-reading-writing-and-updating.md](./02-reading-writing-and-updating.md).
