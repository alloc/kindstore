# Take the kindstore course

This course is for readers who already know TypeScript, Zod, and basic SQLite
concepts, but want to learn how to use kindstore idiomatically.

The guides are ordered. Each one builds on the previous one.

1. [01-modeling-kinds.md](./01-modeling-kinds.md)
   Define kinds, choose stable tags, and decide which fields should be queryable.
2. [02-reading-writing-and-updating.md](./02-reading-writing-and-updating.md)
   Work with collection APIs and internalize the difference between `put` and
   `update`.
3. [03-indexed-queries.md](./03-indexed-queries.md)
   Build query shapes around declared indexes, ordering, and lazy iteration.
4. [04-metadata-batches-and-raw-sql.md](./04-metadata-batches-and-raw-sql.md)
   Use application metadata, transactional batches, and the raw SQLite escape
   hatch.
5. [05-payload-migrations.md](./05-payload-migrations.md)
   Evolve a kind's payload shape with eager startup migrations.
6. [06-structural-migrations.md](./06-structural-migrations.md)
   Handle renames, drops, and tag changes explicitly at the store level.

If you are maintaining kindstore itself rather than using it, start with the
system docs in [../architecture-overview.md](../architecture-overview.md).
