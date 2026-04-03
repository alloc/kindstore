# Changelog

## 0.2.0

- Breaking: reworked `kindstore()` so `filename`, optional `databaseOptions`, optional `metadata`, and optional `migrate(...)` live at the top level, while declared kinds now live under a required `schema` object. Exported `DatabaseOptions` as a public type.

## 0.1.4

- Made `.createdAt()` and `.updatedAt()` default to the conventional `createdAt` and `updatedAt` field names, while still supporting explicit custom field names.
