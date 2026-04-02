# Schema Snapshot

## Goal

Persist an internal snapshot of the store's physical schema so startup can diff the
declared registry against what was previously materialized in SQLite.

This snapshot should cover:

* Kind key
* Kind tag
* Physical table name
* Indexed/generated columns
* Declared multi-column indexes
* The schema-level migration state for each kind

This is separate from document data migrations. The current implementation only
tracks per-kind document versions and does not persist a schema snapshot.

## Why

Without a persisted snapshot, startup only knows the current registry and the live
database. That makes it harder to distinguish:

* A brand new kind from a renamed kind
* A deleted kind from a temporarily missing declaration
* A structural change that needs explicit operator intent from one that is safe to
  derive automatically

The snapshot gives us a stable previous declaration to diff against.

## Proposed Storage

Store the snapshot under internal kindstore-owned metadata keys, not in the
user-facing typed `db.metadata` namespace.

Suggested internal metadata records:

* `kindstore:store_format_version`
* `kindstore:schema_snapshot`

Suggested snapshot shape:

```json
{
  "kindstoreVersion": 1,
  "kinds": {
    "sessions": {
      "tag": "ses",
      "table": "sessions",
      "version": 2,
      "columns": {
        "userId": { "column": "user_id", "type": "text", "single": true },
        "updatedAt": { "column": "doc_updated_at", "type": "integer", "single": true }
      },
      "indexes": {
        "idx_sessions_user_id": ["user_id"],
        "idx_sessions_user_updated_at": ["user_id ASC", "doc_updated_at DESC"]
      }
    }
  }
}
```

## API Design

There is no new public API in v1 for reading or mutating the schema snapshot.

The design is:

```ts
const db = kindstore({
  connection: { filename: ":memory:" },
  users: kind("usr", User).index("email"),
})

// no db.system
// no db.metadata.get("kindstore:schema_snapshot")
// use db.raw only if debugging is absolutely necessary
```

Internally, kindstore should own a separate internal table:

```sql
CREATE TABLE IF NOT EXISTS "__kindstore_internal" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "payload" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL
) STRICT
```

Internal records should be stored as JSON payloads:

```ts
type KindstoreInternalRecords = {
  store_format_version: number;
  schema_snapshot: StoreSchemaSnapshot;
};
```

Recommended internal snapshot type:

```ts
type StoreSchemaSnapshot = {
  kindstoreVersion: number;
  kinds: Record<string, SnapshotKind>;
};

type SnapshotKind = {
  tag: string;
  table: string;
  version: number;
  columns: Record<
    string,
    {
      field: string;
      column: string;
      type: "text" | "integer" | "real" | "numeric";
      single: boolean;
    }
  >;
  indexes: Record<
    string,
    {
      sqliteName: string;
      columns: readonly string[];
    }
  >;
};
```

Schema snapshots are stored in a separate internal table and are not exposed through
a public API in v1.

## Work Items

1. Add an internal metadata layer that is not exposed through the app metadata API.
2. Define a stable serialized snapshot format with explicit versioning.
3. Generate the snapshot from normalized runtime definitions after registry parsing.
4. Load the previous snapshot at startup before schema reconciliation.
5. Persist the new snapshot only after startup reconciliation succeeds.

## Constraints

* The snapshot must be deterministic so diffs are stable.
* Snapshot writes should happen inside the same transaction as schema reconciliation.
* Internal metadata keys must not collide with app-defined metadata keys.
