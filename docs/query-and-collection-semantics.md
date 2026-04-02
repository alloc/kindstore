# Query And Collection Semantics

## Purpose

This document describes the stable behavior of kindstore's public collection and
store APIs.

It focuses on caller-visible semantics rather than code structure or exact SQL
translation details.

## Store surface

A store exposes four public capabilities:

- one typed collection per declared kind
- a typed application metadata surface
- batch execution for grouping operations atomically
- raw SQLite access as an escape hatch

The typed collection API is intentionally small. Its goal is to cover common
document-store operations without pretending to be a general ORM.

## Collection surface

Each collection provides:

- `newId()`
- `get(id)`
- `put(id, value)`
- `update(id, updater)`
- `delete(id)`
- `first(options?)`
- `findMany(options?)`
- `findPage(options)`
- `iterate(options?)`

## ID semantics

`newId()` returns a new opaque ID carrying the collection's tag.

The durable contract is:

- callers may rely on the tag prefix matching the collection
- callers should otherwise treat the generated suffix as opaque
- collection methods reject IDs that do not belong to the collection's tag

## Read semantics

### `get(id)`

`get(id)` returns the validated document for that ID, or `undefined` if no
document exists.

Returned values should be treated as schema-validated output, not raw stored
JSON.

### `first(options?)`

`first` returns the first matching document according to the same filtering and
ordering rules used by the broader query API, or `undefined` when no document
matches.

If callers need deterministic results, they should supply an explicit order.

### `findMany(options?)`

`findMany` returns an eager array of matching validated documents.

It is the convenience API for callers who want the full result set materialized
in memory.

### `findPage(options)`

`findPage` returns one eager page of matching validated documents plus an
optional cursor for the next page.

Its durable contract is intentionally narrow:

- callers must provide an explicit `orderBy`
- callers must provide a positive `limit`
- pagination is forward-only
- kindstore adds the document ID as an internal tie-breaker so traversal stays
  deterministic when ordered field values tie
- cursors are only valid for the same kind and the same `orderBy`
- ordered fields used as the paging boundary must be non-null

### `iterate(options?)`

`iterate` returns a lazy iterator over matching validated documents.

It exists for cases where callers want to process results incrementally rather
than materialize them all at once.

## Write semantics

### `put(id, value)`

`put` validates the provided value and writes it as the current document for the
given ID.

The durable behavior is replacement-oriented:

- if the document does not exist, `put` creates it
- if the document already exists, `put` replaces its payload
- if the kind opted into an automatic creation timestamp, replacement preserves
  the existing value for that field
- if the kind opted into an automatic modification timestamp, replacement
  assigns a fresh value for that field

`put` returns the validated stored value.

### `update(id, updater)`

`update` performs an atomic read-modify-write for one document.

The updater may be:

- a shallow patch object applied to the current document, or
- a function from the current document to the next document

The resulting value is validated before it is persisted.

If the kind opted into automatic payload timestamps, `update` applies those
policies before validation is finalized. In practice that means automatic
modification timestamps advance on each successful update, while existing
creation timestamps are preserved.

If the document does not exist, `update` returns `undefined`.

### `delete(id)`

`delete` removes the document for the given ID if it exists and returns whether
anything was removed.

## Query language

The typed query language is intentionally narrow.

It supports:

- equality checks
- null checks
- membership checks
- simple range comparisons
- ordering
- limits

It does not support:

- joins
- arbitrary boolean composition
- relation traversal
- arbitrary document-path predicates

## Indexed-field restriction

Typed filtering and ordering only apply to fields that were explicitly declared
as queryable in the kind definition.

That restriction is part of the contract, not an incidental limitation.

If a caller needs logic outside that narrow indexed query model, the intended
paths are:

- narrow with declared queryable fields and finish in application code, or
- use raw SQL directly

## Ordering semantics

Ordering is only meaningful on explicitly queryable fields.

Callers should not rely on implicit row order. If result order matters, they
should provide an explicit `orderBy`.

This applies especially to:

- `first`, when more than one document could match
- `findMany`, when result order matters to the caller
- `iterate`, when consumers assume a stable sequence

## Validation semantics

kindstore validates at the API boundary.

The durable contract is:

- writes are validated before persistence
- values returned through the typed collection and metadata APIs are validated
  outputs
- invalid values fail the operation rather than being partially accepted

Raw SQL access is outside that contract.

## Managed timestamp semantics

Kinds may opt into automatic payload timestamp assignment.

The durable contract is:

- automatic timestamp assignment is declared on the kind, not inferred from the
  field name
- the managed field still lives in the payload schema and read results
- a managed field is only queryable when it is also declared as indexed
- caller-provided values for managed timestamp fields do not override the
  library's assignment policy

## Metadata semantics

The public metadata surface is a typed key/value space owned by the application.

It provides:

- `get`
- `set`
- `update`
- `delete`

Its behavior mirrors the rest of the public API:

- values are schema-validated
- undeclared metadata keys are rejected
- application metadata is distinct from library-owned bookkeeping

## Batch semantics

`batch` groups multiple operations into one atomic unit from the caller's point
of view.

Its purpose is straightforward:

- either the grouped operations succeed together
- or the grouped operations fail together

This is the main public mechanism for coordinating several writes or metadata
updates as one change.

## Raw access semantics

Raw SQLite access exists intentionally as an escape hatch.

It is appropriate when callers need:

- ad hoc inspection
- one-off operational queries
- query shapes outside the typed collection API

It comes with an important warning:

- raw reads bypass the typed API's abstraction
- raw writes can bypass validation, migration expectations, and library-owned
  safety boundaries

Maintainers should preserve the presence of the raw escape hatch while being
careful not to weaken the guarantees of the typed API around it.

## Invariants maintainers must preserve

The following public semantics are central:

- collection methods are tag-aware and reject IDs for the wrong kind
- `put` is a replacement write, not a merge
- `update` is the only typed partial-update operation
- automatic payload timestamp policy is separate from indexed query intent
- typed queries are restricted to explicitly queryable fields
- callers should not be asked to understand library-owned bookkeeping to use the
  public API
- raw access remains an escape hatch rather than the default path

## Related documents

Read this after:

- [Architecture Overview](./architecture-overview.md)
- [Storage Layout And Invariants](./storage-layout-and-invariants.md)

This document pairs with:

- [Migration Pipeline](./migration-pipeline.md)
- [Schema Reconciliation](./schema-reconciliation.md)
