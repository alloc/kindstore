# Architecture Overview

## Purpose

This document describes the stable architectural shape of kindstore.

It is intended for maintainers and future contributors who need to reason about
the system without reading the full codebase first. It focuses on contracts,
responsibilities, and lifecycle. It intentionally avoids low-level identifiers,
storage object names, and other details that are likely to drift.

## What kindstore is

kindstore is a registry-driven document store built on SQLite.

Applications declare a set of document kinds, each with:

- a stable tagged ID format
- a runtime validation schema
- declared indexed fields
- an optional payload migration history

From that registry, kindstore materializes a small typed collection API for each
kind and keeps the underlying SQLite schema aligned with the declared model.

kindstore is intentionally small in scope:

- it is not a general ORM
- it does not model relations
- it does not try to provide arbitrary query composition
- it does keep a raw SQL escape hatch for cases that exceed the small typed API

## Architectural model

kindstore has three durable layers.

### Declaration layer

The declaration layer is the user-authored registry.

It defines the current intended shape of the store:

- which kinds exist
- how documents are validated
- which fields participate in indexed queries
- how old payloads are upgraded
- which structural changes are explicitly authorized

This layer is the source of truth for the current store definition.

### Storage layer

The storage layer is responsible for persisting documents in SQLite and exposing
them through collection-oriented APIs.

Its job is to preserve two views of the same data:

- the full validated document payload
- a limited relational projection used for indexed filtering and ordering

The store is therefore document-oriented at the API boundary while still using
relational features where they improve lookup and query behavior.

### Migration layer

The migration layer brings an existing store forward to the currently declared
shape before the application begins using it.

It handles three distinct concerns:

- upgrading the library-owned storage format when the library itself changes
- reconciling structural differences between the previous declared store shape
  and the current registry
- upgrading persisted document payloads for individual kinds

These concerns are intentionally separate because they have different safety
rules and different sources of truth.

## Core concepts

### Store

A store is the full runtime object opened against a SQLite database. It exposes:

- one collection per declared kind
- a typed metadata surface for application-owned metadata
- a batching mechanism
- raw SQLite access

### Kind

A kind is a document category with a stable identity over time.

A kind combines:

- a tag used in document IDs
- a runtime schema
- queryable indexed fields
- a current payload version

Kinds are the main unit of storage, querying, and migration.

### Document

A document is a validated payload stored under a tagged ID.

kindstore treats the payload as the source of business data. Indexed fields are
derived from that payload and exist only to support query behavior.

### Application metadata

Application metadata is a first-class, schema-backed key/value space owned by
the application.

It is distinct from library-owned bookkeeping. Maintainers should preserve that
separation in future changes.

### Structural history

kindstore keeps enough library-owned structural history to compare the previous
materialized store shape with the current declaration.

That history exists to support safe startup reconciliation. It is not part of
the main user-facing API.

## Store lifecycle

At a high level, store startup follows this model:

1. Read the current registry and open the SQLite database.
2. Load library-owned bookkeeping needed to understand the store's existing
   state.
3. Bring the store forward to the current library-owned format if needed.
4. Reconcile structural differences between the previous declared shape and the
   current registry.
5. Run document payload migrations needed for currently declared kinds.
6. Publish the ready-to-use collection and metadata surfaces.

The important contract is that the store should only become usable after it is
internally consistent with the current declaration.

If required migration intent is missing, startup should fail rather than allow a
partially reconciled store to operate.

## Query model

kindstore provides a deliberately small query model.

The typed collection API is designed for:

- lookup by ID
- replacement writes
- partial or functional updates
- deletion
- simple indexed filtering
- simple indexed ordering
- bounded eager reads
- lazy iteration

The system is intentionally strict about which fields participate in this query
model. If a field is not declared as queryable, callers are expected to either:

- narrow results using declared indexed fields and finish filtering in
  application code, or
- use raw SQL directly

This keeps the abstraction honest and prevents the public API from drifting into
a misleading ORM-like surface.

## Migration model

kindstore uses eager migrations, not lazy per-read upgrades.

That decision supports a key architectural invariant: a kind should not operate
in a mixed persisted shape once the store is open and ready.

This matters because query behavior depends on storage structures derived from
the current declared shape. Structural reconciliation and payload migration must
therefore happen before normal reads and writes begin.

Maintainers should preserve the distinction between:

- library-owned format upgrades
- structural migrations
- payload migrations

Collapsing them into one mechanism would make error handling and compatibility
harder to reason about.

## Invariants

The following invariants are central to the system:

- The declared registry is the source of truth for the current intended store
  shape.
- Each kind owns its own physical storage area rather than sharing a single
  cross-kind document table.
- Document IDs are tagged and the tag is part of the storage contract.
- Indexed query behavior is only supported for explicitly declared fields.
- The application metadata surface is separate from library-owned bookkeeping.
- Store startup is responsible for reaching a fully reconciled state before the
  public API is used.
- Structural changes that may discard rows or change kind identity require
  explicit intent.
- Raw SQL access exists, but it bypasses kindstore's validation and migration
  guarantees.

## Non-goals

kindstore is not trying to provide:

- relation modeling
- join planning
- arbitrary boolean query composition
- nested path indexing as a general feature
- transparent background migrations during ordinary reads

Future work should be evaluated against these non-goals before the public API is
expanded.

## What this document omits

This overview intentionally does not pin down:

- concrete internal table names
- exact SQL statements
- exact serialized bookkeeping record names
- code-level class or function structure
- low-level naming rules for derived storage objects

Those details belong in narrower documents only when they are required to
explain a stable contract.

## Related documents

This document should be read first. More focused documents should cover:

* [Storage Layout And Invariants](./storage-layout-and-invariants.md)
* [Migration Pipeline](./migration-pipeline.md)
* [Schema Reconciliation](./schema-reconciliation.md)
* [Query And Collection Semantics](./query-and-collection-semantics.md)
