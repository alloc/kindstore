# kindstore

kindstore is a registry-driven document store for Bun and SQLite. You define
document kinds with Zod, declare which top-level fields are queryable, and keep
payload and schema migrations explicit.

Requires Bun at runtime because kindstore uses `bun:sqlite`.

```sh
bun add kindstore zod
```

The [skills.sh](https://skills.sh/) command line tool makes it easy to teach your
favorite coding agent how to use Kindstore:

```sh
npx skills add alloc/kindstore
```

```ts
import { z } from "zod";
import { kind, kindstore } from "kindstore";

const Post = z.object({
  authorId: z.string(),
  slug: z.string(),
  title: z.string(),
  status: z.enum(["draft", "published"]),
  updatedAt: z.number().int(),
});

const db = kindstore({
  filename: ":memory:",
  schema: {
    posts: kind("pst", Post)
      .updatedAt()
      .index("authorId")
      .index("slug")
      .index("status")
      .index("updatedAt", { type: "integer" }),
  },
});

const id = db.posts.newId();

db.posts.put(id, {
  authorId: "usr_1",
  slug: "hello-kindstore",
  title: "Hello, kindstore",
  status: "published",
});

const publishedPosts = db.posts.findMany({
  where: { status: "published" },
  orderBy: { updatedAt: "desc" },
});

const firstPage = db.posts.findPage({
  where: { status: "published" },
  orderBy: { updatedAt: "desc" },
  limit: 20,
});
```

That example covers the happy path, but kindstore also supports:

- full-document replacement and targeted updates with `get()`, `put()`, `update()`, and `delete()` in the same typed collection API
- lazy query iteration with `iterate()` when you want incremental processing instead of materializing every result
- compound indexes with `.multi(...)` for query shapes like `status + updatedAt`
- typed store-level metadata via `db.metadata`
- atomic multi-write workflows with `db.batch(...)`
- raw SQLite access through `db.raw` when you need an escape hatch
- eager payload migrations with kind-level `.migrate(version, steps)`
- explicit structural migrations for renames, drops, and tag changes with top-level `migrate(...)`

Next:

- Start with the intermediate guides in [docs/course/README.md](./docs/course/README.md)
- Read the maintainer-facing system docs in [docs/architecture-overview.md](./docs/architecture-overview.md)
