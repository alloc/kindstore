# 04. Metadata, batches, and raw SQL

This lesson is another checkpoint, not a long guide.

Run [examples/metadata-and-batch.ts](../../examples/metadata-and-batch.ts)
for the canonical workflow, then use this page to choose the right escape hatch.

## Choose the right tool

- `db.metadata`: small store-scoped values such as preferences, cursors, or
  sync checkpoints.
- `db.batch(() => { ... })`: one transaction for several writes that should
  succeed or fail together.
- `db.raw`: operational inspection or SQLite-specific work outside the typed
  surface.

## Keep in mind

- Metadata is not a substitute for a real kind when you need identity, history,
  or indexing.
- kindstore does not manage metadata timestamps for you.
- Raw reads are usually fine; raw writes can bypass validation and
  migration-aware behavior.
- Exact signatures and examples live outside the course:
  [../../dist/index.d.mts](../../dist/index.d.mts) and
  [examples/metadata-and-batch.ts](../../examples/metadata-and-batch.ts).

## Next

Continue to [05-payload-migrations.md](./05-payload-migrations.md).
