# Migration Pipeline

## Purpose

This document describes how kindstore brings a persisted store into alignment
with the current declaration before the public API becomes usable.

It focuses on sequencing, safety boundaries, and failure behavior. It avoids
concrete bookkeeping identifiers and low-level execution details that are likely
to drift.

## Why kindstore has a pipeline

kindstore has to reconcile three different kinds of change:

- changes to the library's own storage strategy
- changes to the declared structural shape of the store
- data repairs needed before declared constraints can be materialized
- changes to the payload shape for individual kinds

Those are separate concerns with different sources of truth. Keeping them in a
single undifferentiated migration mechanism would make compatibility and failure
handling much harder to reason about.

## Migration layers

### Library-owned format upgrades

This layer handles compatibility changes introduced by kindstore itself.

Examples include:

- how the library records structural history
- how the library interprets prior structural records
- how library-owned derived storage is represented

This layer is internal. It is not driven by application-defined kind versions.

### Structural reconciliation

This layer compares the previously materialized store shape with the current
declaration.

Its job is to decide:

- what can be derived and reconciled automatically
- what requires explicit structural intent from the caller

This is where kind renames, deletions, dormant preservation, tag changes, and
derived query-support changes are handled.

Preserved dormant kinds remain in structural history but are not current
declared collections. They are skipped by later constraint preparation, index
reconciliation, and eager payload migration work until the same kind key is
declared again in a later open.

### Constraint preparation migrations

This layer runs explicit store-level data repair before declared constraints are
materialized.

Use `m.prepareConstraints(id, fn)` when existing rows must be cleaned up before
the current declaration can safely create or rebuild indexes and constraints.
The common case is adding a unique index to a collection that already contains
duplicate rows.

The callback receives:

- `db`: current declared collections with a limited migration-time surface
- `raw`: the underlying SQLite database for repairs outside the typed surface
- `now`: one timestamp for the migration run

The migration-time collection surface intentionally omits `putByUnique` because
the unique constraints it depends on may not exist yet. If the current schema
cannot parse older payloads, use `raw` for that repair step.

### Payload migrations

This layer upgrades persisted document payloads for a kind from older declared
payload versions to the current one.

It is kind-owned and registry-driven. It operates only after the structural
shape needed by the current declaration is ready.

## Startup sequence

At a high level, opening a store follows this sequence:

1. Open the SQLite database for the requested store.
2. Load the current declaration and the library-owned structural history needed
   to understand what already exists.
3. Bring the store forward to the current library-owned format, if needed.
4. Reconcile structural differences between the previous declared shape and the
   current one, preserving any explicitly dormant previous kinds and ensuring
   current tables and generated columns exist.
5. Run pending `prepareConstraints` migrations in declaration order.
6. Materialize declared indexes and constraints.
7. Run eager payload migrations for currently declared kinds.
8. Persist the updated structural history and completed migration metadata.
9. Publish the ready-to-use store surface.

The important contract is that the public store should only become visible after
this sequence has succeeded.

## Ordering rules

The ordering is intentional and should be preserved.

### Library format before structural reconciliation

The store's own compatibility state must be understood first. Otherwise the
runtime may misread or misapply previously recorded structural history.

### Structural reconciliation before payload migration

Payload migrations assume the current kind definition is the one that matters.
That only makes sense after ownership, tagging, and derived query support have
been reconciled to the current declaration.

### Constraint preparation before constraint materialization

`prepareConstraints` runs after current tables and generated columns are
available, but before declared indexes and constraints are created or rebuilt.
This gives the application one transactional chance to make existing rows
satisfy the current declaration without kindstore silently choosing winners.

### Structural history write last

The persisted record of the current shape should only be updated after the rest
of startup reconciliation succeeds. Otherwise a failed open could falsely record
progress that never actually completed. Completed `prepareConstraints` ids
follow the same rule.

## Eager migration policy

kindstore uses eager migration rather than lazy migration on read.

That means:

- a kind should not remain in mixed persisted payload shapes after open
- typed queries should operate against the current declared query support
- callers should not need to trigger background upgrades by touching old rows

This policy is especially important because query support is derived from the
current declaration. Mixed persisted shapes would make that support unreliable.

## Failure behavior

Startup is an all-or-nothing operation.

If any required migration step fails, kindstore should fail store opening rather
than expose a partially reconciled store. That includes failures caused by:

- unsupported library-owned format state
- missing structural migration intent
- invalid or malformed library-owned bookkeeping
- constraint preparation migration errors
- payload migration errors

Maintainers should preserve this fail-closed behavior.

## Transactionality

The migration pipeline should behave transactionally from the caller's point of
view.

The intended contract is:

- a successful open leaves the store fully aligned with the current declaration
- a failed open leaves the prior consistent state intact

This protects both application data and library-owned structural history from
drifting apart.

## What does not belong in this pipeline

The pipeline is not a place for:

- ordinary application writes
- background cleanup unrelated to the current declaration
- implicit behavior triggered later by reads

If a behavior is required to make the store safe and queryable, it belongs in
startup. If it is optional or speculative, it likely does not.

## Invariants maintainers must preserve

The following migration invariants are central:

- the store is not publicly usable until startup reconciliation succeeds
- library-owned format upgrades, structural reconciliation, and payload
  migration remain distinct layers
- constraint preparation is explicit, named, ordered, and transactional
- payload migrations are eager rather than read-triggered
- missing explicit structural intent causes store open to fail
- failed startup does not partially advance the store from the caller's point of
  view

## Related documents

Read this after:

- [Architecture Overview](./architecture-overview.md)
- [Storage Layout And Invariants](./storage-layout-and-invariants.md)

Then continue to:

- [Schema Reconciliation](./schema-reconciliation.md)
- [Query And Collection Semantics](./query-and-collection-semantics.md)
