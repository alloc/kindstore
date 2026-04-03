# Changelog

## 0.3.0

- Added `collection.create(value)` as a one-step helper that allocates a fresh tagged ID and persists the document.
- Breaking: reserved `id` as a store-owned document field, removed it from application payload schemas, and now include it in typed read and write results.
- Breaking: renamed the internal document storage column to `data`, reserved `data` in document schemas, and use `RowData` as the internal term for persisted document bodies.

## 0.2.1

- Fixed store-format bookkeeping to keep the current internal format at version `1` and removed test coverage for a nonexistent `1 -> 2` format transition.

## 0.2.0

- Breaking: renamed the builder class from `KindDefinition` to `KindBuilder`, renamed the exported schema bag type from `KindDefinitionBag` to `KindDefinition`, and collapsed the runtime `*Surface` types into the exported `KindCollection`, `MetadataCollection`, and `Kindstore` names.
- Breaking: reworked `kindstore()` so `filename`, optional `databaseOptions`, optional `metadata`, and optional `migrate(...)` live at the top level, while declared kinds now live under a required `schema` object. Exported `DatabaseOptions` as a public type.

## 0.1.4

- Made `.createdAt()` and `.updatedAt()` default to the conventional `createdAt` and `updatedAt` field names, while still supporting explicit custom field names.
