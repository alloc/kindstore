# Schema Reconciliation

## Purpose

This document describes how kindstore reconciles structural differences between
the previously materialized store shape and the current declaration.

It focuses on the stable policy boundary: which changes are automatic, which
changes require explicit intent, and how that intent is expressed through the
public API.

## Structural reconciliation in one sentence

kindstore compares the previous declared shape of the store with the current
declaration and decides whether each difference is:

- safe derived maintenance the library can perform automatically, or
- a structural change that requires explicit caller authorization

## Inputs to reconciliation

Structural reconciliation is driven by three inputs:

- the current declaration
- the previously recorded structural history of the store
- any explicit structural migration intent provided by the caller

The current declaration alone is not enough. Without structural history,
kindstore could not reliably distinguish a new kind from a renamed kind, or a
deleted kind from a temporarily missing declaration.

## Automatic reconciliation

kindstore may reconcile library-owned derived structure automatically when the
change does not imply loss of primary data or transfer of kind identity.

Automatic changes include:

- materializing storage for a brand new kind
- adding derived query support for newly declared indexed fields
- rebuilding derived query support when indexed declarations change
- removing library-owned derived query support that is no longer declared

The important boundary is that these operations affect derived structure, not
the logical ownership of persisted rows.

## Changes that require explicit intent

kindstore must not infer destructive or identity-changing structural changes.

Explicit structural intent is required when:

- a previously persisted kind no longer appears in the current declaration
- a current kind is taking over the rows of a previous kind
- the tagged identity of a kind changes
- rows would otherwise be discarded or reassigned implicitly

When this intent is missing, store open should fail.

## Public API for structural intent

Structural migration intent is expressed through the top-level store
configuration:

```ts
const db = kindstore({
  filename: ":memory:",
  migrate(m) {
    m.rename("legacySessions", "sessions");
    m.drop("obsoleteCache");
    m.retag("users", "usr");
  },
  schema: {
    sessions: kind("ses", Session),
    users: kind("per", User),
  },
});
```

The important public concepts are:

- `rename(previousKindKey, nextKindKey)`
- `drop(previousKindKey)`
- `retag(kindKey, previousTag)`

The planner is about structural ownership, not payload rewriting.

## Meaning of each structural operation

### Rename

Rename tells kindstore that a current kind is the continuation of a previous
kind under a new declaration key and, potentially, a new physical ownership
name.

This is how a current declaration explicitly claims responsibility for rows that
previously belonged to another declared kind.

### Drop

Drop tells kindstore that a previously persisted kind should be removed rather
than carried forward.

This is the explicit destructive path. kindstore must not assume deletion just
because a previous kind is absent from the current declaration.

### Retag

Retag tells kindstore that a kind's ID tag has intentionally changed while the
kind itself remains the same logical collection.

Because the tag is part of persisted identity, this cannot be treated as a
purely cosmetic declaration change.

## Validation rules

Structural migration intent should fail fast when it is contradictory or does
not match the actual structural diff.

That includes cases such as:

- referring to kinds that are not relevant to the current diff
- declaring multiple structural operations for the same prior kind
- mapping multiple prior kinds to the same current kind
- declaring a retag where no tag change actually needs authorization

The goal is to keep structural intent precise and auditable.

## Relationship to payload migrations

Structural reconciliation and payload migration solve different problems.

Structural reconciliation answers questions like:

- which kind owns these rows now
- whether a prior kind is being removed
- whether the persisted identity of a kind has changed
- what derived query support should exist

Payload migration answers a different question:

- how an existing row's document payload should be rewritten to satisfy the
  current schema

Maintainers should preserve that separation.

## What reconciliation should not do

Structural reconciliation should not:

- silently discard primary data without explicit intent
- infer kind identity changes from guesswork
- act as a replacement for payload migrations
- expose library-owned structural history as ordinary application data

## Invariants maintainers must preserve

The following reconciliation invariants are central:

- structural reconciliation is driven by previous structural history plus the
  current declaration
- derived query structures may be reconciled automatically
- row ownership changes require explicit structural intent
- tag changes require explicit structural intent
- missing structural intent causes store open to fail rather than guess

## Related documents

Read this after:

- [Architecture Overview](./architecture-overview.md)
- [Migration Pipeline](./migration-pipeline.md)

This document pairs with:

- [Storage Layout And Invariants](./storage-layout-and-invariants.md)
- [Query And Collection Semantics](./query-and-collection-semantics.md)
