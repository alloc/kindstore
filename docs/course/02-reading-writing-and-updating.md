# 02. Reading, writing, and updating

This lesson is a checkpoint, not a full walkthrough.

Run [examples/basic-usage.ts](../../examples/basic-usage.ts) for the
canonical workflow, then use this page to choose the right operation.

## Choose the right write

- `create(value)`: let kindstore allocate the ID and insert one new document.
- `newId()` then `put(id, value)`: use this when the caller needs the ID before
  the write happens.
- `put(id, value)`: replacement write for the full next document.
- `putByUnique(selector, value)`: replacement write keyed by one declared
  unique field set, creating the document when it does not exist yet.
- `update(id, patch)`: shallow partial update.
- `update(id, fn)`: computed next value based on the current stored document.
- `delete(id)`: remove one document and get a `boolean` back.

## Choose the right read

- `get(id)`: read by known collection.
- `resolve(id)`: read by tagged ID when you do not already have the collection.
- `get(id)` and `update(id, ...)`: return `undefined` when the document is
  missing.

## Keep in mind

- `put()` is not a merge helper. Omitted fields are replaced away.
- `putByUnique()` is not a general query-write helper. The selector must match
  one declared unique index exactly.
- Collection methods are tag-aware, so IDs must belong to the matching kind.
- `id` is store-owned and `data` is reserved for storage.
- Exact signatures and examples now live outside the course:
  [../../dist/index.d.mts](../../dist/index.d.mts) and
  [examples/basic-usage.ts](../../examples/basic-usage.ts).

## Next

Continue to [03-indexed-queries.md](./03-indexed-queries.md).
