# Changelog

## 0.3.4

- Flattened downstream declaration output for `KindInput`, `KindOutput`, and related public types by using an internal erased `Omit` helper instead of exposing the built-in `Omit<...>` wrapper in inspected types.
- Expanded `KindInput` and `KindOutput` to accept `KindBuilder` types directly, which preserves inference for inlined schema entries like `typeof schema.tasks`.

## 0.3.3

- Fixed exported inferred `kindstore(...)` values to keep `.createdAt()` and `.updatedAt()` type state out of downstream declaration emit, avoiding `TS4023` and inaccessible `unique symbol` errors.

## 0.3.2

- Fixed `.createdAt()` and `.updatedAt()` to extend the kind schema with integer timestamp fields when they are missing, while keeping those fields store-managed.

## 0.3.1

- Fixed `collection.create(value)` to use insert-only semantics instead of inheriting `put()` upsert behavior when writing a generated ID.

## 0.3.0

Note: There is no supported migration path from 0.2.x to 0.3.x.

- Added `collection.create(value)` as a one-step helper that allocates a fresh tagged ID and persists the document.
- Breaking: reserved `id` as a store-owned document field, removed it from application payload schemas, and now include it in typed read and write results.
- Breaking: renamed the internal document storage column to `data`, reserved `data` in document schemas, and use `RowData` as the internal term for persisted document bodies.
- Breaking: renamed the typed document result helper to `KindOutput`, renamed the input helper to `KindInput`, and now use `z.output<T["schema"]>` directly where the raw schema output is needed.
- Added `KindPropertyKey<T>` as the shared property-key alias for a kind's inferred output shape.
- Changed `KindMigration<T>` to take a `KindDefinition` type parameter directly instead of a plain object type.

## 0.2.1

- Fixed store-format bookkeeping to keep the current internal format at version `1` and removed test coverage for a nonexistent `1 -> 2` format transition.

## 0.2.0

- Breaking: renamed the builder class from `KindDefinition` to `KindBuilder`, renamed the exported schema bag type from `KindDefinitionBag` to `KindDefinition`, and collapsed the runtime `*Surface` types into the exported `KindCollection`, `MetadataCollection`, and `Kindstore` names.
- Breaking: reworked `kindstore()` so `filename`, optional `databaseOptions`, optional `metadata`, and optional `migrate(...)` live at the top level, while declared kinds now live under a required `schema` object. Exported `DatabaseOptions` as a public type.

## 0.1.4

- Made `.createdAt()` and `.updatedAt()` default to the conventional `createdAt` and `updatedAt` field names, while still supporting explicit custom field names.
