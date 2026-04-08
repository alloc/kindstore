# Overview

kindstore is a registry-driven document store for Bun and SQLite. You declare
kinds with Zod, decide which top-level payload fields should participate in the
typed query model, and then work through one typed collection per kind.

Exact exported signatures live in [../dist/index.d.mts](../dist/index.d.mts).
Runnable usage lives in [examples/basic-usage.ts](../examples/basic-usage.ts),
[examples/indexed-queries.ts](../examples/indexed-queries.ts), and
[examples/metadata-and-batch.ts](../examples/metadata-and-batch.ts).

# When to Use

- You want a small document store with runtime validation and a deliberately
  narrow typed query API.
- You want SQLite durability without adopting a full ORM.
- You want explicit payload and structural migrations instead of implicit
  best-effort behavior.
- You want tagged IDs so a store can resolve an ID back to the matching
  collection.

# When Not to Use

- You need joins, relations, arbitrary boolean query composition, or nested
  document-path indexing.
- You need a runtime other than Bun.
- You want an ORM that models many tables and relationships directly.
- You want lazy or background migration behavior instead of eager startup
  reconciliation.

# Core Abstractions

- Store: opened with `kindstore(...)`; owns the SQLite connection, one
  collection per declared kind, typed metadata, batching, and raw SQL access.
- Kind: built with `kind(tag, schema)`; combines a stable tag, a Zod object
  schema, declared queryable fields, and an optional payload migration history.
- Collection: `db.<kindKey>`; exposes `newId`, `create`, `get`, `put`,
  `update`, `delete`, `first`, `findMany`, `findPage`, and `iterate`.
- Metadata: `db.metadata`; stores small typed store-scoped values such as sync
  cursors or preferences.
- Migrations: kind-level `.migrate(version, steps)` rewrites persisted payloads;
  store-level `migrate(planner)` handles renames, drops, and tag changes.

# Data Flow / Lifecycle

1. Declare kinds and optional metadata with Zod.
2. Open the store with `kindstore(...)`.
3. kindstore reconciles derived structure and runs required migrations before
   exposing the public API.
4. Collections validate writes, persist the full document payload, and use the
   declared query fields for typed filtering and ordering.
5. Callers use `batch()` for atomic multi-write workflows and `raw` only when
   the typed surface is intentionally too small.

# Common Tasks -> Recommended APIs

- Define a collection: `kind(tag, schema)` plus `.index(...)`, `.multi(...)`,
  `.createdAt()`, or `.updatedAt()` as needed.
- Enforce a natural key: use `.index(..., { unique: true })` or
  `.multi(..., ..., { unique: true })`.
- Open a store: `kindstore({ filename, schema, metadata, migrate })`.
- Let kindstore allocate IDs: `create(value)`.
- Allocate an ID before writing: `newId()` then `put(id, value)`.
- Replace a full document: `put(id, value)`.
- Apply a shallow or computed change: `update(id, patch)` or `update(id, fn)`.
- Read by known collection: `get(id)`, `first(...)`, `findMany(...)`,
  `iterate(...)`, or `findPage(...)`.
- Read by tagged ID only: `resolve(id)`.
- Store app-level cursors or preferences: `db.metadata.get/set/update/delete`.
- Group writes atomically: `db.batch(() => { ... })`.
- Leave the typed query model: `db.raw`.
- Rewrite old payloads: `.migrate(version, steps)` on the kind.
- Rename, drop, or retag kinds: top-level `migrate(planner)` when opening the
  store.

# Invariants and Constraints

- Queryable fields are top-level payload fields declared through `.index(...)`
  or `.multi(...)`, plus `id` when it participates in `.multi(...)`.
- Declared unique indexes are enforced by SQLite at write time and during store
  open when kindstore reconciles schema state.
- Tags are part of persisted identity. Changing a tag is a structural
  migration, not a cosmetic rename.
- `id` is store-owned and `data` is reserved for storage.
- `kindstore(...)` requires at least one declared kind.
- `findPage(...)` requires explicit `orderBy` and a positive `limit`.
- Ordered paging fields need non-null boundary values if pagination should
  continue safely.
- Managed `createdAt` and `updatedAt` fields stay in the payload schema;
  kindstore only owns their assignment policy.
- kindstore uses `bun:sqlite`, so Bun is the required runtime.

# Error Model

- Schema validation failures surface through the typed collection and metadata
  APIs.
- Missing or contradictory structural migration intent causes store open to
  fail.
- Missing payload migration steps cause store open to fail.
- `UnrecoverableStoreOpenError` means kindstore cannot safely interpret the
  store's own internal format or bookkeeping.
- `resolve(id)` and collection methods reject malformed or wrong-tag IDs.

# Terminology

- Kind: a document category with one tag, one schema, and one collection
  surface.
- Tag: the prefix embedded in a document ID, such as `tsk` in `tsk_...`.
- Indexed field: a declared top-level field eligible for typed filtering or
  ordering.
- Structural migration: a store-level change to kind ownership or tagged
  identity.
- Payload migration: a kind-level rewrite from one document version to the
  next.

# Non-Goals

- General ORM behavior.
- Relation management or join planning.
- Arbitrary boolean query builders.
- Nested document-path indexing.
- Hiding structural or payload migrations behind implicit guesses.
