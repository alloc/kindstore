# Index Reconciliation

## Goal

Treat indexes as fully derived data that can be migrated automatically from the
current registry definition and the previous schema snapshot.

This includes:

* Single-field indexes for generated columns
* Declared multi-column indexes

## Why

Indexes do not carry primary business data. If an index definition changes, the
library can safely add, drop, or rebuild the SQLite index without asking the user to
write manual migration code.

This keeps manual migrations focused on table identity and row preservation.

## Proposed Rules

Automatic:

* Create missing indexes that are now declared
* Drop stale indexes that were previously declared but no longer exist
* Recreate indexes whose ordered field list or direction changed
* Drop stale kindstore-owned generated columns after dependent indexes are removed

Still explicit elsewhere:

* Table deletion
* Table rename
* Any change that implies row data must move or be discarded

## Snapshot Requirements

The stored schema snapshot needs enough information to compare:

* Logical index name
* Physical SQLite index name
* Owning table
* Ordered column list
* Sort direction per column

## API Design

There should be no new public API in v1 for index reconciliation.

The existing index declaration surface remains the source of truth:

```ts
const db = kindstore({
  connection: { filename: ":memory:" },
  sessions: kind("ses", Session)
    .index("userId")
    .index("updatedAt", { type: "integer" })
    .multi("user_updatedAt", { userId: "asc", updatedAt: "desc" }),
})
```

On store open, kindstore should automatically:

* create missing declared indexes
* drop stale indexes that were previously declared
* rebuild indexes whose ordered column list or direction changed
* drop stale generated columns that are known to be kindstore-owned derived columns

No `db.indexes`, no `schema.indexes.migrate()`, and no per-index reconcile policy
should exist in v1.

Index reconciliation remains automatic and internal in v1 with no additional public
API.

## Work Items

1. Normalize index definitions into a deterministic internal representation.
2. Compare previous and current index sets per table.
3. Emit automatic operations: create, drop, recreate.
4. Run index reconciliation after table existence is resolved.
5. Drop generated columns for no-longer-indexed fields when they are known to be
   kindstore-owned derived columns.

## Recommended Initial Scope

For the first pass:

* Automatically manage SQLite indexes and kindstore-owned generated columns.
* Compile queries only against currently declared indexed fields.

That keeps startup aggressive where the schema is clearly derived, while still
avoiding destructive operations against user-owned data columns.

## Locked In Rules

* Generated columns are treated as derived data and are garbage-collected in v1 when
  they are known to be kindstore-owned and derived from current or previous index
  declarations.
* Physical SQLite index names are internal. Logical names may remain in the registry
  for readability and snapshot stability.
