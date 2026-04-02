# Kindstore Versioning

## Goal

Persist a kindstore-owned store-format version so the library can perform breaking
storage-strategy upgrades independently of app-defined kind versions.

This version is about the storage engine contract, not document payload shape.

Examples of changes that belong here:

- Internal metadata layout changes
- Snapshot serialization changes
- Generated-column naming changes
- Internal table layout changes
- Migration bookkeeping strategy changes

## Why

Per-kind versions only describe application document evolution. They do not help
when the library itself changes how it stores metadata or materializes schema.

Without a separate store-format version, the library cannot safely distinguish:

- An old store created by a previous kindstore release
- A current store whose app kinds simply have older payload versions

## Proposed Metadata

Persist an internal integer version, for example:

- `kindstore:store_format_version = 1`

This should be loaded before schema diffing, because store-format upgrades may affect
how snapshots and internal metadata are interpreted.

## API Design

There should be no new main public API in v1 for store-format versioning.

The design should be:

```ts
const KINDSTORE_FORMAT_VERSION = 1;

type StoreFormatMigration = (context: {
  db: Database;
  from: number;
  to: number;
  now: number;
}) => void;

const STORE_FORMAT_MIGRATIONS: Record<number, StoreFormatMigration> = {
  // 1: migrate from version 1 to 2
};
```

Runtime behavior:

* read `store_format_version` from the internal table
* fail if the stored version is newer than the runtime version
* run internal migrations sequentially when the stored version is older
* persist the new version in the same transaction

Caller-facing debugging remains available through `db.raw` if necessary:

```ts
db.raw
  .query(`SELECT payload FROM "__kindstore_internal" WHERE key = 'store_format_version'`)
  .get()
```

Store-format versioning remains fully internal in v1 with no new public API.

## Work Items

1. Define the first explicit store-format version constant in code.
2. Persist it in internal metadata on store creation.
3. Add a startup check that compares persisted version to runtime version.
4. Run library-owned migrations when upgrading from older supported versions.
5. Reject opening stores from newer unsupported versions.

## Failure Policy

Required behavior:

- Older supported version: upgrade in a transaction
- Same version: continue
- Newer version than library supports: fail fast
- Missing version on an existing store: fail fast

## Interaction With Other Migration Layers

Recommended order:

1. Upgrade kindstore store-format version
2. Reconcile schema snapshot and schema-level migrations
3. Run per-kind payload migrations

This avoids mixing library-internal upgrades with app-defined data rewrites.

## Locked In Rules

* The store-format version is not exposed as part of the main public API in v1.
* Store-format migrations use a dedicated internal migration registry keyed by
  integer version, with the current format version also defined as a code constant.
