# kindstore

## Purpose

kindstore is a registry-driven document store for Bun and SQLite. You define
document kinds with Zod, declare which top-level fields are queryable, and keep
payload and structural migrations explicit.

## Installation

Requires Bun at runtime because kindstore uses `bun:sqlite`.

```sh
bun add kindstore zod
```

## Quick Example

```ts
import { z } from "zod";
import { kind, kindstore } from "kindstore";

const Post = z.object({
  authorId: z.string(),
  title: z.string(),
  status: z.enum(["draft", "published"]),
});

const db = kindstore({
  filename: ":memory:",
  schema: {
    posts: kind("pst", Post)
      .updatedAt()
      .index("authorId")
      .index("status")
      .index("updatedAt"),
  },
});

const created = db.posts.create({
  authorId: "usr_1",
  title: "Hello, kindstore",
  status: "published",
});

const published = db.posts.findMany({
  where: { status: "published" },
  orderBy: { updatedAt: "desc" },
  limit: 20,
});

console.log({ created, published });
db.close();
```

## Documentation Map

- Read [docs/context.md](./docs/context.md) for the mental model, constraints,
  and task-to-API map.
- Run the examples in
  [examples/basic-usage.ts](./examples/basic-usage.ts),
  [examples/indexed-queries.ts](./examples/indexed-queries.ts), and
  [examples/metadata-and-batch.ts](./examples/metadata-and-batch.ts).
- Follow [docs/course/README.md](./docs/course/README.md) for the guided
  learning path.
- Use [dist/index.d.mts](./dist/index.d.mts) for exact exported signatures.
- Read [docs/architecture-overview.md](./docs/architecture-overview.md) and the
  related architecture docs when you are maintaining kindstore itself.
- Install the agent guidance with `npx skills add alloc/kindstore`, or inspect
  [skills/kindstore/SKILL.md](./skills/kindstore/SKILL.md) directly.
- Run `pnpm docs:check` to re-emit declarations and execute the examples.
