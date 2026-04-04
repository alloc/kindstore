# Storage Layout And Invariants

## Purpose

This document describes the durable storage model of kindstore.

It focuses on the concepts that future changes must preserve. It intentionally
avoids pinning down concrete internal object names, exact SQL, or serialized
bookkeeping identifiers unless those details become part of a stable contract.

## Conceptual storage model

kindstore is a document store with relational support for a narrow set of query
operations.

For each declared kind, the store maintains:

- a physical storage area owned by that kind alone
- the full validated document payload
- derived query structures for explicitly declared indexed fields

The payload is the source of business data. Derived query structures exist only
to support filtering and ordering on declared fields.

## Per-kind ownership

Each kind owns its own physical storage area.

This is a core architectural decision, not an incidental implementation choice.
Maintainers should preserve the idea that unrelated kinds do not share a single
cross-kind document table.

That separation keeps:

- kind identity explicit
- query support local to the kind that declared it
- structural reconciliation scoped to one kind at a time
- future schema changes easier to reason about

## Document representation

Every persisted document has two conceptual representations:

- the complete payload, validated against the kind schema
- a limited derived projection used for indexed queries

The payload remains the canonical representation. The derived projection is
owned by the library and may be rebuilt from the declaration.

Maintainers should not treat the derived projection as an independent source of
truth.

## Indexed field projection

Only explicitly declared top-level fields participate in the derived query
projection.

That restriction is part of the design contract. It keeps the query model
simple, makes structural reconciliation tractable, and avoids pretending that
kindstore supports arbitrary document-path indexing.

The durable rules are:

- undeclared fields are stored only in the document payload
- top-level fields declared through `.index(...)` or `.multi(...)` are eligible
  for derived query support
- query support is library-owned derived data, not application-owned state

## Managed payload timestamps

kindstore supports opt-in managed payload timestamps at the kind-definition
level.

When a kind opts in, the timestamp still lives in the payload schema. The
library simply takes responsibility for assigning it on writes.

Maintainers should preserve these behaviors:

- a kind only gets automatic timestamp assignment if it explicitly opted in
- an automatic creation timestamp is assigned only when a document is first
  inserted
- replacing or updating an existing document preserves its existing creation
  timestamp when one already exists
- an automatic modification timestamp advances on each successful write and on
  library-driven rewrite paths such as eager payload migration
- timestamp assignment policy is distinct from queryability, so a managed
  timestamp field is only queryable if it participates in an index declaration

## Tagged identity

Document IDs are tagged.

The tag is part of the storage contract because it ties a persisted ID to a kind
identity. That means a tag change is not just a cosmetic rename. It is a
structural change that requires explicit migration intent.

The exact ID generation algorithm is intentionally omitted here. The durable
contract is that the generated ID is opaque except for its kind tag.

## Metadata domains

kindstore has two distinct metadata domains:

- application-owned metadata, exposed as a typed public API
- library-owned bookkeeping used for startup reconciliation and compatibility

They must remain separate.

Application metadata is part of the user-facing data model. Library-owned
bookkeeping exists only to keep the storage layer safe and self-consistent.
Future changes should not merge these domains or expose library bookkeeping as
ordinary application metadata.

## Derived structures are disposable

Derived query structures are intentionally disposable.

If a declaration changes, kindstore may create, rebuild, or remove library-owned
derived structures as needed, so long as persisted document payloads and
application metadata remain intact unless explicit destructive intent was
provided elsewhere.

This is one of the main safety boundaries in the design:

- primary data is preserved conservatively
- derived query support can be reconciled aggressively

## Invariants maintainers must preserve

The following storage invariants are central:

- each kind owns its own physical storage area
- the payload is the canonical source of document data
- indexed query support is derived from the declaration, not authored directly
  by callers
- only declared top-level fields participate in typed filtering and ordering
- automatic payload timestamps are opt-in and remain part of the payload schema
- application metadata is separate from library-owned bookkeeping
- structural reconciliation may rebuild derived data, but it must not silently
  discard primary data

## What may change safely

The following details may evolve without changing the architectural contract:

- concrete internal table names
- exact bookkeeping record names
- exact SQL shape
- exact naming rules for derived storage objects
- exact serialization details of library-owned metadata

If a future change only affects those details, this document should not need to
change.

## Related documents

Read this after the overview:

- [Architecture Overview](./architecture-overview.md)

Then continue to:

- [Migration Pipeline](./migration-pipeline.md)
- [Schema Reconciliation](./schema-reconciliation.md)
- [Query And Collection Semantics](./query-and-collection-semantics.md)
