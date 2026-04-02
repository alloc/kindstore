# Schema-Level Migrations

## Goal

Add a startup reconciliation phase that compares the previous schema snapshot to the
current registry and decides which changes are automatic versus which require an
explicit schema-level migration.

This is distinct from document-shape migrations that rewrite payload JSON.

## Required Behavior

If a table that existed in the previous snapshot is now missing from the registry,
startup must not silently drop it.

Instead, the kind declaration or store-level configuration must provide an explicit
schema-level migration that does one of:

* Delete the old table
* Rename the old table to the new table

The intent is to make destructive or identity-changing changes explicit.

## Proposed Diff Categories

Safe automatic changes:

* Brand new kind creates a new table
* New generated column added for a newly indexed field
* Index add/drop/rebuild derived from current declarations

Explicit migration required:

* Previous table missing from current registry
* Previous kind renamed to a different key/table
* Previous tag changed in a way that implies logical identity changed
* Any table-level destructive change that could lose persisted rows

## API Design

Schema-level migrations should use a top-level store option, not the per-kind
document migration builder.

Recommended API:

```ts
const db = kindstore({
  connection: { filename: ":memory:" },

  schema: {
    migrate(m) {
      m.rename("legacySessions", "sessions");
      m.drop("oldCache");
      m.retag("users", "usr_old");
    },
  },

  sessions: kind("ses", Session)
    .index("userId")
    .migrate(2, {
      1: (value, ctx) => ({
        ...value,
        updatedAt: value.updatedAt ?? ctx.now,
      }),
    }),

  users: kind("usr", User),
});
```

Recommended planner surface:

```ts
type SchemaMigrationPlanner = {
  rename(previousKindKey: string, nextKindKey: string): this;
  drop(previousKindKey: string): this;
  retag(kindKey: string, previousTag: string): this;
};
```

The separation is explicit:

* Data migration rewrites row payloads.
* Schema migration rewrites tables and store structure.

Planner semantics:

* `rename(previousKindKey, nextKindKey)` maps a kind from the previous snapshot to a
  current registry kind and authorizes table ownership transfer or table rename.
* `drop(previousKindKey)` explicitly authorizes deleting a previously snapshotted
  table that no longer exists in the current registry.
* `retag(kindKey, previousTag)` explicitly authorizes a tag change when the current
  kind key still exists but the storage ID prefix changed.

Validation rules:

* If the previous snapshot contains a missing kind/table and no `rename` or `drop`
  covers it, store open fails.
* If a current kind changes tag and no `retag` covers it, store open fails.
* Unknown previous/current kind keys in the planner fail fast.
* The planner runs before payload migrations.

Schema-level migrations use a top-level store option with a
`schema.migrate(...)` planner API.

## Work Items

1. Build a schema diff engine from `previous snapshot -> current registry`.
2. Define a machine-readable set of diff operations.
3. Reject startup when destructive diffs exist without an explicit schema migration.
4. Add schema migration execution before data migration and query readiness.
5. Update the stored schema snapshot after the migration succeeds.

## Execution Order

Recommended order:

1. Load internal kindstore metadata.
2. Apply any store-format migration.
3. Diff previous schema snapshot against current registry.
4. Run schema-level migrations and automatic reconciliations.
5. Run per-kind document migrations.
6. Persist the new snapshot and updated versions.

## Locked In Rules

* Table rename is declared from the current registry side, meaning the new kind or a
  store-level schema migration entry claims the previous table.
* A tag change always requires an explicit schema-level migration.
* Kindstore-owned stale generated columns may be dropped automatically in v1 after
  dependent indexes are removed. This never applies to user/data columns.
