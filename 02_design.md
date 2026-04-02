Here’s the bookmarkable outline of the design we’ve converged on so far.

## Core storage model

* SQLite is the storage engine.
* The app is local-only.
* The data model is document-oriented rather than fully normalized.
* Each document kind gets its own table from day one.
* We are explicitly not planning around later splitting or “graduating” kinds into separate tables, so the design should already assume per-kind tables permanently.
* Documents are stored as a payload column containing JSON in SQLite-friendly form, alongside a small set of top-level relational columns used for store bookkeeping.

## Why per-kind tables won out

* A single shared table would force kind-specific generated/indexing columns to coexist for unrelated document kinds.
* That would create lots of sparse or irrelevant columns and more awkward indexing strategy.
* Per-kind tables keep each table focused on only the fields and indexes that matter for that kind.
* Composite indexes become simpler and cleaner.
* Query planning and filter compilation become more predictable.
* The registry and API can still present a uniform abstraction even though the physical layout is one table per kind.

## Table shape per kind

Each document kind’s table conceptually contains:

* A tagged primary key stored as text.
* A payload column holding the document body.
* Store-level created-at timestamp.
* Store-level updated-at timestamp.
* Generated columns for indexed top-level payload fields only.
* No per-row version column, because we have decided against lazy migrations.

Important distinction:

* Store-level timestamps are separate from any timestamps inside the payload.
* Payload fields like expiresAt or lastSeenAt remain domain data.
* Table-level created_at and updated_at are bookkeeping fields for the storage layer.

## Document IDs

* IDs are tagged, so the kind is recognizable from the ID itself.
* The tag is a stable storage-level identifier, distinct from the code-level registry key if needed.
* Tagged IDs are useful for debugging, references, and “foreign key by convention” lookups.
* The ID format should stay boring and stable.

## Schema and validation

* Zod is the schema layer.
* Each kind has a Zod schema.
* Zod is the source of runtime validation and TypeScript inference.
* Writes should go through schema parsing so stored data reflects the validated output shape.
* Reads should also validate after decoding from storage.
* The design is intentionally light and does not aim to become a full ORM.

## Registry-driven architecture

The registry is the center of the system. For each kind, it should define:

* Stable tag.
* Current kind version.
* Zod schema.
* Declared top-level indexed fields.
* Declared multi-column indexes.
* Migration function for upgrading the kind’s persisted data during explicit migrations.

The registry should be the single source of truth for:

* Schema shape.
* Storage shape.
* Indexable fields.
* Migration behavior.
* Generated DDL.

## Registry style

The most promising direction is a builder-style API inspired by the schema, but with constraints.

What we currently like:

* A builder-style declaration for each kind.
* Top-level-field indexing only.
* Explicit multi-index declarations.
* Minimal magic overall.

What changed in the discussion:

* Earlier skepticism about schema-centered indexing softened once the design was restricted to top-level indexed fields only.
* That restriction makes schema-driven ergonomics more realistic.

The likely builder feel is:

* Define a kind with a tag and Zod schema.
* Declare version.
* Declare top-level indexes by field name.
* Optionally provide SQLite type hints where needed.
* Declare composite indexes.
* Provide a migration hook.

## Indexed fields

* Only top-level payload fields should be eligible for generated indexed columns.
* This is an intentional constraint to keep the system simple.
* Indexed fields are not arbitrary JSON paths anymore in the conceptual design; they are top-level schema fields.
* Mapping top-level scalar fields to SQLite generated columns should be straightforward in the common case.
* When Zod effects such as transforms or preprocessors make the storage type ambiguous, the registry may require an explicit SQLite type hint.

## Generated columns and indexing strategy

* Indexed payload fields are exposed through generated columns.
* Only fields that are actually queried or ordered on should get generated columns.
* Since tables are per-kind, generated columns are no longer polluted by unrelated kinds.
* Generated columns exist only to support indexing and query compilation, not to mirror the entire payload.

## Multi-column indexes

* Multi-column indexes are part of the design and considered worthwhile.
* They should be declared explicitly in the registry.
* The preferred declaration style combines field order and direction in one ordered object-like structure rather than splitting them into separate fields and order arrays.
* The order of indexed fields matters a lot.
* Direction metadata such as asc and desc is useful, though less fundamental than field sequence.
* Multi-column indexes should be designed around real query patterns rather than speculative coverage.

Typical uses:

* Equality plus equality.
* Equality plus range.
* Equality plus sort.

## Query API philosophy

* Keep the abstraction small and honest.
* Avoid building a full Prisma-like ORM.
* Provide a small, typed collection API per kind.
* Always preserve a raw SQL escape hatch.

The collection API should include:

* Get by ID.
* Put.
* Delete.
* Update.
* First.
* FindMany.
* Iterate.

## FindMany design

* We agreed on a tiny findMany API.
* It should support constrained filtering rather than a broad ORM-style language.
* The goal is ergonomic querying without pretending to support arbitrary relational patterns.

The filter model should likely support:

* Equality.
* In.
* Greater than / greater than or equal.
* Less than / less than or equal.
* OrderBy.
* Limit.

The constraints should likely include:

* Filtering only on declared indexed fields.
* Ordering only on declared indexed fields.
* Query shapes should ideally correspond to an available single-field or multi-column index.
* No ambitious relation syntax.
* No broad nested boolean logic at first.
* No arbitrary JSON-path predicates.

## Iterate as a first-class primitive

* We agreed that iterate is a good name.
* Streaming/iterative access should exist from the start.
* This fits Bun’s synchronous SQLite usage well.
* It allows coarse narrowing in SQL and then optional additional filtering in JavaScript without materializing everything at once.
* The abstraction should encourage “SQL first for narrowing, JS second for final business logic.”

The intended execution flow is:

* SQLite does indexed narrowing.
* Rows are iterated lazily.
* Payload decoding and validation happen lazily as rows are pulled.
* Callers can apply extra JS filtering where needed.

FindMany can then be an eager convenience built on top of iterate.

## JavaScript filtering stance

* JavaScript-side filtering is expected to be used fairly often.
* That said, the design should still encourage using SQL for coarse, indexed narrowing first.
* Iterate exists partly to make this hybrid model memory-friendly and ergonomic.
* Raw SQL remains available for cases where query complexity or performance needs exceed the small abstraction.

## Migration strategy

This is one of the biggest settled decisions.

* No lazy migrations.
* Therefore no per-row version column.
* Migrations should be explicit and eager.
* The store should not operate in a mixed-version state for a given kind.
* This avoids the complications that generated indexed columns would create under lazy migration.

Why this matters:

* Generated columns and indexes reflect the currently stored payload.
* If old and new payload shapes coexist, indexed queries can become incorrect or incomplete.
* By rejecting lazy migration, we eliminate that whole class of problems.

So the migration model is:

* Each kind has a current version in the registry.
* Migrations are executed deliberately, not opportunistically on read.
* After migration, the table’s data is expected to match the current schema assumptions for generated columns and queries.

## Metadata table

* We like the idea of a metadata table.
* It should be first-class and exposed as db.metadata.
* It should have a simple get/set/delete style API.
* It should be schema-backed with Zod.
* It should support both library-internal metadata and app-defined metadata.
* It can participate in migrations too.

This metadata system can store things like:

* Store format version.
* Per-kind migration bookkeeping.
* Registry-related state.
* Application-level metadata.
* UI or app settings.
* Custom metadata the user wants to layer on top.

It is useful both for internal bookkeeping and as a general-purpose typed metadata facility.

## Versioning model after the lazy-migration decision

* No per-row version column.
* Versioning remains at the kind level in the registry and metadata system.
* The registry knows the current version for each kind.
* The metadata table can track what version each kind has been migrated to in the database.
* Migrations operate at the table/kind level rather than per row.

## Driver and implementation style

* Bun’s SQLite driver is the intended base.
* The abstraction should stay lightweight and close to raw SQLite.
* We do not want a heavy ORM.
* The API should feel ergonomic, but implementation simplicity matters.
* A typed wrapper around the underlying database is preferred over a large framework-like layer.

## Proxy vs plain object

* Earlier, there was skepticism about making Proxy the foundation.
* The stronger direction is that the real abstraction is the typed store/registry, not clever runtime interception.
* The final design has not fully committed one way or the other, but the stronger conceptual center is a typed, registry-backed store API rather than proxy magic.
* In spirit, the collection-like API matters more than whether Proxy is used internally.

## Design constraints we have intentionally chosen

* Local-only application.
* Rapidly evolving schemas.
* Strong preference for simplicity.
* SQLite used as a document store with selective indexing.
* Per-kind tables permanently.
* Top-level indexed fields only.
* Small query API.
* Eager migrations only.
* Metadata is first-class.
* Raw SQL escape hatch always available.

## The design in one sentence

A lightweight, registry-driven, Zod-backed document store on top of Bun SQLite, using one table per kind, tagged IDs, generated columns for top-level indexed fields, explicit composite indexes, eager migrations, iterative querying, and a typed metadata subsystem.

## Open questions

A few things still seem genuinely open.

### Builder API shape

* How fluent versus declarative should the registry builder be?
* Proposed answer: Keep a chainable builder for kinds and a plain object for the
  top-level store registry. The builder should stay narrowly fluent.
* Should kinds be declared with a chainable builder, object helpers, or some hybrid?
* Proposed answer: Use a chainable builder for kinds in v1, not a hybrid helper
  system.
* How much inference should come from the Zod schema versus explicit hints?
* Proposed answer: Infer only obvious top-level scalar output shapes from Zod and
  require explicit hints when the storage type is ambiguous.

### Zod-to-SQLite field mapping

* Exactly which Zod shapes should be auto-indexable without hints?
* Proposed answer: Auto-index only obvious top-level scalar outputs such as string,
  number, integer, boolean, enum, scalar literals, and the same wrapped in
  `optional`, `nullable`, `default`, `catch`, or `readonly`.
* How should transforms, coercions, defaults, optionals, and nullables affect inferred SQLite type?
* Proposed answer: Infer from the parsed output type, not the input type. Defaults
  and nullability do not change affinity by themselves, while transforms and
  coercions should require explicit hints.
* Where should the line be drawn between convenient inference and explicit configuration?
* Proposed answer: Stop automatic inference at unions, transforms, preprocessors,
  dates, objects, arrays, tuples, records, maps, and sets.

### Metadata API surface

* Should db.metadata be fully generic key/value with optional schemas, or should it require predeclared metadata schemas?
* Proposed answer: Keep `db.metadata` predeclared and schema-backed instead of
  making it a generic key/value bag.
* How should internal metadata keys be namespaced and protected from accidental collision with app keys?
* Proposed answer: Internal kindstore metadata should live outside the public
  metadata namespace entirely.
* Should metadata migrations use the same mechanism as kind migrations or a separate one?
* Proposed answer: Split them by responsibility. App metadata evolves with app
  schemas, while internal metadata evolves with kindstore store-format migrations.

### Migration runner behavior

* When and how are migrations triggered?
* Proposed answer: Run them automatically during store open, before the caller can
  use collections.
* At application startup only, or through an explicit migration step?
* Proposed answer: Startup only in v1. Opening the store should either succeed with
  a ready store or fail.
* What does failure recovery look like if a migration is interrupted?
* Proposed answer: Schema reconciliation and data migrations should run in
  transactions so interruption rolls back cleanly.
* Should migration bookkeeping live solely in metadata, or also include a migration history log?
* Proposed answer: Keep bookkeeping in internal metadata only for v1. A history log
  can be deferred.

### Query planner strictness

* How strict should findMany be about only allowing query shapes that match declared indexes?
* Proposed answer: Be strict about field eligibility, meaning only declared indexed
  fields may appear in `where` or `orderBy`, but do not try to prove exact
  optimal-index coverage in v1.
* Should unsupported query shapes be rejected, warned about, or allowed with a slower fallback?
* Proposed answer: Reject unsupported shapes. Do not add warnings or slower fallback
  modes yet.
* How much planner intelligence is desirable before the system starts feeling like an ORM?
* Proposed answer: Very little. Compile the small supported query language and stop
  there.

### OrderBy support

* How many orderBy fields should be supported in v1?
* Proposed answer: Support multiple `orderBy` fields using object insertion order as
  the sequence.
* Should orderBy only be allowed when compatible with a declared multi-column index?
* Proposed answer: No. Restrict ordering to declared indexed fields, but do not make
  exact composite-index compatibility a hard gate in v1.
* How much should index direction metadata matter in practice?
* Proposed answer: It should matter for emitted composite indexes and deterministic
  snapshots, but not as a reason to reject otherwise valid queries.

### Iterate contract

* Should iterate return fully validated documents only, or should there also be a lower-level row iterator?
* Proposed answer: Return fully parsed and validated documents only in v1.
* Should decoding and validation errors stop iteration or be skippable with an option?
* Proposed answer: Stop iteration on decode or validation errors. Silent skipping is
  too easy to miss.
* Should there be a separate first method or should it simply be built on iterate internally and exposed anyway for ergonomics?
* Proposed answer: Keep `first` as a separate ergonomic method, even if it reuses
  the same internal query compiler.

### Store-level timestamps

* Should created_at and updated_at be entirely store-managed?
* Proposed answer: Yes. They are storage-layer bookkeeping fields, not domain data.
* Should put always replace updated_at, and should update preserve created_at automatically?
* Proposed answer: `put` should preserve `created_at` for existing rows and always
  refresh `updated_at`, while `update` should preserve `created_at`
  automatically.
* How much control should callers have over these fields, if any?
* Proposed answer: None through the normal typed API.

### ID generation

* What exact tagged ID format should be used?
* Proposed answer: Use `<tag>_<ulid>`.
* Should the library generate IDs by default, or should callers always provide them?
* Proposed answer: Expose `newId()` as the default path, while still allowing
  callers to provide their own tagged IDs.
* Is sortability of IDs a requirement?
* Proposed answer: Yes. That is part of why ULID is the right default.

### Raw SQL escape hatch

* What should the official low-level escape hatch look like?
* Proposed answer: Direct access to the underlying Bun `Database`.
* Direct access to the underlying Bun database object, or a smaller curated raw/query/transaction surface?
* Proposed answer: Direct driver access. Do not add a second abstraction layer
  around raw SQL in v1.

If you want, the next step can be turning this outline into a short design doc structure with sections like Goals, Non-goals, Schema Model, Migration Model, Query Model, and API Surface.
