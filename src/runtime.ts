import { Database } from "bun:sqlite";
import { monotonicFactory } from "ulid";

import { KindDefinition } from "./kind";
import type {
  ConnectionConfig,
  FindManyOptions,
  IndexDirection,
  KindDefinitionBag,
  KindId,
  KindMigrationContext,
  KindRegistry,
  KindValue,
  KindWhere,
  MetadataDefinitionMap,
  MetadataValue,
  PatchValue,
  SqliteTypeHint,
  TaggedId,
} from "./types";

const INTERNAL_KIND_VERSIONS = "__kindstore_kind_versions";
const INTERNAL_METADATA = "__kindstore_metadata";
const RESERVED_STORE_KEYS = new Set([
  "batch",
  "close",
  "connection",
  "metadata",
  "raw",
]);
const RESERVED_COLUMN_NAMES = new Set([
  "id",
  "payload",
  "created_at",
  "updated_at",
]);
const nextUlid = monotonicFactory();

type StoredRow = {
  id: string;
  payload: string;
  created_at: number;
  updated_at: number;
};

type IndexColumn = {
  field: string;
  column: string;
  type: SqliteTypeHint;
  single: boolean;
};

type KindRuntimeDefinition<T extends KindDefinitionBag> = {
  key: string;
  table: string;
  columns: Map<string, IndexColumn>;
  definition: KindDefinition<T>;
};

type CompiledQuery = {
  sql: string;
  values: any[];
};

type KindCollectionSurface<T extends KindDefinitionBag> = {
  newId(): KindId<T>;
  get(id: KindId<T>): KindValue<T> | undefined;
  put(id: KindId<T>, value: KindValue<T>): KindValue<T>;
  delete(id: KindId<T>): boolean;
  update(
    id: KindId<T>,
    updater:
      | PatchValue<KindValue<T>>
      | ((current: KindValue<T>) => KindValue<T>),
  ): KindValue<T> | undefined;
  first(options?: FindManyOptions<T>): KindValue<T> | undefined;
  findMany(options?: FindManyOptions<T>): KindValue<T>[];
  iterate(options?: FindManyOptions<T>): IterableIterator<KindValue<T>>;
};

type MetadataSurface<T extends MetadataDefinitionMap> = {
  get<K extends keyof T & string>(key: K): MetadataValue<T, K> | undefined;
  set<K extends keyof T & string>(
    key: K,
    value: MetadataValue<T, K>,
  ): MetadataValue<T, K>;
  delete<K extends keyof T & string>(key: K): boolean;
  update<K extends keyof T & string>(
    key: K,
    updater: (current: MetadataValue<T, K> | undefined) => MetadataValue<T, K>,
  ): MetadataValue<T, K>;
};

type KindStoreSurface<
  TKinds extends KindRegistry,
  TMetadata extends MetadataDefinitionMap,
> = {
  readonly raw: Database;
  readonly metadata: MetadataSurface<TMetadata>;
  batch<TResult>(callback: () => TResult): TResult;
  close(): void;
} & {
  [K in keyof TKinds]: TKinds[K] extends KindDefinition<infer TBag>
    ? KindCollectionSurface<TBag>
    : never;
};

export type PublicKindCollection<T extends KindDefinitionBag> =
  KindCollectionSurface<T>;
export type PublicMetadataCollection<T extends MetadataDefinitionMap> =
  MetadataSurface<T>;
export type PublicKindstore<
  TKinds extends KindRegistry,
  TMetadata extends MetadataDefinitionMap,
> = KindStoreSurface<TKinds, TMetadata>;

export function createStore<
  TKinds extends KindRegistry,
  TMetadata extends MetadataDefinitionMap,
>(
  connection: ConnectionConfig,
  kinds: TKinds,
  metadataDefinitions: TMetadata,
) {
  const database = new Database(connection.filename, connection.options);
  const runtime = new KindstoreRuntime<TKinds, TMetadata>(
    database,
    normalizeKinds(kinds),
    metadataDefinitions,
  );
  return runtime.publicStore as PublicKindstore<TKinds, TMetadata>;
}

class KindstoreRuntime<
  TKinds extends KindRegistry,
  TMetadata extends MetadataDefinitionMap,
> {
  readonly database: Database;
  readonly kinds: Map<string, KindRuntimeDefinition<any>>;
  readonly publicStore: Record<string, unknown>;
  readonly metadata: MetadataRuntime<TMetadata>;

  constructor(
    database: Database,
    kinds: Map<string, KindRuntimeDefinition<any>>,
    metadataDefinitions: TMetadata,
  ) {
    this.database = database;
    this.kinds = kinds;
    this.publicStore = this as Record<string, unknown>;
    this.bootstrap();
    this.metadata = new MetadataRuntime(database, metadataDefinitions);
    this.publicStore.raw = database;
    this.publicStore.metadata =
      this.metadata as PublicMetadataCollection<TMetadata>;
    for (const [key, definition] of kinds) {
      this.publicStore[key] = new KindCollectionRuntime(
        database,
        definition,
      ) as PublicKindCollection<any>;
    }
  }

  batch<TResult>(callback: () => TResult) {
    return this.database.transaction(callback)();
  }

  close() {
    this.database.close();
  }

  private bootstrap() {
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(INTERNAL_KIND_VERSIONS)} (
        "name" TEXT PRIMARY KEY NOT NULL,
        "version" INTEGER NOT NULL
      ) STRICT`,
    );
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(INTERNAL_METADATA)} (
        "key" TEXT PRIMARY KEY NOT NULL,
        "payload" TEXT NOT NULL,
        "created_at" INTEGER NOT NULL,
        "updated_at" INTEGER NOT NULL
      ) STRICT`,
    );
    for (const definition of this.kinds.values()) {
      this.ensureKindTable(definition);
      this.ensureGeneratedColumns(definition);
      this.ensureIndexes(definition);
      this.migrateKind(definition);
    }
  }

  private ensureKindTable<T extends KindDefinitionBag>(
    definition: KindRuntimeDefinition<T>,
  ) {
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(definition.table)} (
        "id" TEXT PRIMARY KEY NOT NULL,
        "payload" TEXT NOT NULL,
        "created_at" INTEGER NOT NULL,
        "updated_at" INTEGER NOT NULL
      ) STRICT`,
    );
  }

  private ensureGeneratedColumns<T extends KindDefinitionBag>(
    definition: KindRuntimeDefinition<T>,
  ) {
    const existing = new Set(
      (
        this.database
          .query(`PRAGMA table_xinfo(${quoteString(definition.table)})`)
          .all() as { name: string }[]
      ).map((column) => column.name),
    );
    for (const column of definition.columns.values()) {
      if (existing.has(column.column)) {
        continue;
      }
      this.database.exec(
        `ALTER TABLE ${quoteIdentifier(definition.table)} ADD COLUMN ${quoteIdentifier(column.column)} ${column.type.toUpperCase()} GENERATED ALWAYS AS (${columnExpression(column.type, column.field)}) VIRTUAL`,
      );
    }
  }

  private ensureIndexes<T extends KindDefinitionBag>(
    definition: KindRuntimeDefinition<T>,
  ) {
    for (const column of definition.columns.values()) {
      if (!column.single) {
        continue;
      }
      this.database.exec(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName(definition.table, column.column))} ON ${quoteIdentifier(definition.table)} (${quoteIdentifier(column.column)})`,
      );
    }
    for (const multiIndex of definition.definition.multiIndexes) {
      this.database.exec(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName(definition.table, snakeCase(multiIndex.name)))} ON ${quoteIdentifier(definition.table)} (${multiIndex.fields.map(([field, direction]) => `${quoteIdentifier(definition.columns.get(field)!.column)} ${direction.toUpperCase()}`).join(", ")})`,
      );
    }
  }

  private migrateKind<T extends KindDefinitionBag>(
    definition: KindRuntimeDefinition<T>,
  ) {
    const versionRow = this.database
      .query(
        `SELECT "version" FROM ${quoteIdentifier(INTERNAL_KIND_VERSIONS)} WHERE "name" = ?`,
      )
      .get(definition.key) as { version: number } | undefined;
    if (!versionRow) {
      this.database
        .query(
          `INSERT INTO ${quoteIdentifier(INTERNAL_KIND_VERSIONS)} ("name", "version") VALUES (?, ?)`,
        )
        .run(definition.key, definition.definition.version);
      return;
    }
    if (versionRow.version > definition.definition.version) {
      throw new Error(
        `Kind "${definition.key}" is at version ${versionRow.version}, but the registry declares version ${definition.definition.version}.`,
      );
    }
    if (versionRow.version === definition.definition.version) {
      return;
    }
    const migrations = definition.definition.migrations;
    if (!migrations) {
      throw new Error(
        `Kind "${definition.key}" requires migrations from version ${versionRow.version} to ${definition.definition.version}, but none were declared.`,
      );
    }
    const updateRow = this.database.query(
      `UPDATE ${quoteIdentifier(definition.table)} SET "payload" = ?, "updated_at" = ? WHERE "id" = ?`,
    );
    const setVersion = this.database.query(
      `UPDATE ${quoteIdentifier(INTERNAL_KIND_VERSIONS)} SET "version" = ? WHERE "name" = ?`,
    );
    this.database.transaction(() => {
      const now = Date.now();
      const context: KindMigrationContext = { now };
      for (const row of this.database.query(
        `SELECT "id", "payload", "created_at", "updated_at" FROM ${quoteIdentifier(definition.table)} ORDER BY "id" ASC`,
      ).iterate() as IterableIterator<StoredRow>) {
        let value = parsePayload(row.payload);
        for (
          let version = versionRow.version;
          version < definition.definition.version;
          version++
        ) {
          const step = migrations[version];
          if (!step) {
            throw new Error(
              `Kind "${definition.key}" is missing migration step ${version} -> ${version + 1}.`,
            );
          }
          value = step(
            value as Partial<KindValue<T>> & Record<string, unknown>,
            context,
          ) as Record<string, unknown>;
        }
        updateRow.run(
          JSON.stringify(definition.definition.schema.parse(value)),
          now,
          row.id,
        );
      }
      setVersion.run(definition.definition.version, definition.key);
    })();
  }
}

class KindCollectionRuntime<T extends KindDefinitionBag>
  implements KindCollectionSurface<T>
{
  readonly database: Database;
  readonly definition: KindRuntimeDefinition<T>;
  readonly getStatement;
  readonly putStatement;
  readonly deleteStatement;
  readonly updateStatement;

  constructor(database: Database, definition: KindRuntimeDefinition<T>) {
    this.database = database;
    this.definition = definition;
    this.getStatement = database.query(
      `SELECT "id", "payload", "created_at", "updated_at" FROM ${quoteIdentifier(definition.table)} WHERE "id" = ?`,
    );
    this.putStatement = database.query(
      `INSERT INTO ${quoteIdentifier(definition.table)} ("id", "payload", "created_at", "updated_at") VALUES (?, ?, ?, ?)
       ON CONFLICT("id") DO UPDATE SET "payload" = excluded."payload", "updated_at" = excluded."updated_at"`,
    );
    this.deleteStatement = database.query(
      `DELETE FROM ${quoteIdentifier(definition.table)} WHERE "id" = ?`,
    );
    this.updateStatement = database.query(
      `UPDATE ${quoteIdentifier(definition.table)} SET "payload" = ?, "updated_at" = ? WHERE "id" = ?`,
    );
  }

  newId() {
    return `${this.definition.definition.tag}_${nextUlid()}` as KindId<T>;
  }

  get(id: KindId<T>) {
    assertTaggedId(this.definition.definition.tag, id);
    const row = this.getStatement.get(id) as StoredRow | undefined;
    return row ? this.parseRow(row) : undefined;
  }

  put(id: KindId<T>, value: KindValue<T>) {
    assertTaggedId(this.definition.definition.tag, id);
    const parsed = this.definition.definition.schema.parse(value);
    const now = Date.now();
    this.putStatement.run(id, JSON.stringify(parsed), now, now);
    return parsed;
  }

  delete(id: KindId<T>) {
    assertTaggedId(this.definition.definition.tag, id);
    return this.deleteStatement.run(id).changes > 0;
  }

  update(
    id: KindId<T>,
    updater:
      | PatchValue<KindValue<T>>
      | ((current: KindValue<T>) => KindValue<T>),
  ) {
    assertTaggedId(this.definition.definition.tag, id);
    return this.database.transaction(() => {
      const row = this.getStatement.get(id) as StoredRow | undefined;
      if (!row) {
        return undefined;
      }
      const current = this.parseRow(row);
      const parsed =
        typeof updater === "function"
          ? this.definition.definition.schema.parse(updater(current))
          : this.definition.definition.schema.parse({ ...current, ...updater });
      this.updateStatement.run(JSON.stringify(parsed), Date.now(), id);
      return parsed;
    })();
  }

  first(options: FindManyOptions<T> = {}) {
    const compiled = this.compileSelect({
      where: options.where,
      orderBy: options.orderBy,
      limit: 1,
    });
    const rows = this.database.query(compiled.sql).all(...compiled.values) as StoredRow[];
    return rows[0] ? this.parseRow(rows[0]) : undefined;
  }

  findMany(options: FindManyOptions<T> = {}) {
    return Array.from(this.iterate(options));
  }

  *iterate(options: FindManyOptions<T> = {}) {
    const compiled = this.compileSelect(options);
    for (const row of this.database
      .query(compiled.sql)
      .iterate(...compiled.values) as IterableIterator<StoredRow>) {
      yield this.parseRow(row);
    }
  }

  private parseRow(row: StoredRow) {
    return this.definition.definition.schema.parse(parsePayload(row.payload));
  }

  private compileSelect(options: FindManyOptions<T>) {
    if (
      options.limit != null &&
      (!Number.isInteger(options.limit) || options.limit < 0)
    ) {
      throw new Error(
        `Query limit for kind "${this.definition.key}" must be a non-negative integer.`,
      );
    }
    const where = compileWhere(this.definition.columns, options.where);
    const orderBy = compileOrderBy(this.definition.columns, options.orderBy);
    return {
      sql: `SELECT "id", "payload", "created_at", "updated_at" FROM ${quoteIdentifier(this.definition.table)}${where.sql}${orderBy}${options.limit == null ? "" : " LIMIT ?"}`,
      values:
        options.limit == null
          ? where.values
          : [...where.values, options.limit],
    };
  }
}

class MetadataRuntime<T extends MetadataDefinitionMap>
  implements MetadataSurface<T>
{
  readonly database: Database;
  readonly definitions: T;
  readonly getStatement;
  readonly setStatement;
  readonly deleteStatement;

  constructor(database: Database, definitions: T) {
    this.database = database;
    this.definitions = definitions;
    this.getStatement = database.query(
      `SELECT "payload" FROM ${quoteIdentifier(INTERNAL_METADATA)} WHERE "key" = ?`,
    );
    this.setStatement = database.query(
      `INSERT INTO ${quoteIdentifier(INTERNAL_METADATA)} ("key", "payload", "created_at", "updated_at") VALUES (?, ?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET "payload" = excluded."payload", "updated_at" = excluded."updated_at"`,
    );
    this.deleteStatement = database.query(
      `DELETE FROM ${quoteIdentifier(INTERNAL_METADATA)} WHERE "key" = ?`,
    );
  }

  get<K extends keyof T & string>(key: K) {
    const schema = this.definitions[key];
    if (!schema) {
      throw new Error(`Metadata key "${key}" is not declared.`);
    }
    const row = this.getStatement.get(key) as { payload: string } | undefined;
    return row ? schema.parse(parsePayload(row.payload)) : undefined;
  }

  set<K extends keyof T & string>(key: K, value: MetadataValue<T, K>) {
    const schema = this.definitions[key];
    if (!schema) {
      throw new Error(`Metadata key "${key}" is not declared.`);
    }
    const parsed = schema.parse(value);
    const now = Date.now();
    this.setStatement.run(key, JSON.stringify(parsed), now, now);
    return parsed;
  }

  delete<K extends keyof T & string>(key: K) {
    if (!this.definitions[key]) {
      throw new Error(`Metadata key "${key}" is not declared.`);
    }
    return this.deleteStatement.run(key).changes > 0;
  }

  update<K extends keyof T & string>(
    key: K,
    updater: (current: MetadataValue<T, K> | undefined) => MetadataValue<T, K>,
  ) {
    return this.database.transaction(() => this.set(key, updater(this.get(key))))();
  }
}

function normalizeKinds<TKinds extends KindRegistry>(kinds: TKinds) {
  const definitions = new Map<string, KindRuntimeDefinition<any>>();
  const seenTags = new Set<string>();
  const seenTables = new Set<string>();
  for (const [key, value] of Object.entries(kinds)) {
    if (!(value instanceof KindDefinition)) {
      throw new Error(`Property "${key}" is not a kind definition.`);
    }
    if (RESERVED_STORE_KEYS.has(key)) {
      throw new Error(`Kind key "${key}" is reserved.`);
    }
    if (seenTags.has(value.tag)) {
      throw new Error(`Kind tag "${value.tag}" is declared more than once.`);
    }
    const table = snakeCase(key);
    if (seenTables.has(table)) {
      throw new Error(`Kind key "${key}" collides with an existing table name.`);
    }
    seenTags.add(value.tag);
    seenTables.add(table);
    definitions.set(key, {
      key,
      table,
      columns: normalizeColumns(value),
      definition: value,
    });
  }
  return definitions;
}

function normalizeColumns<T extends KindDefinitionBag>(definition: KindDefinition<T>) {
  const shape = definition.schema.shape as Record<string, unknown>;
  const columns = new Map<string, IndexColumn>();
  const seenColumns = new Set<string>();
  for (const index of definition.indexes.values()) {
    assertTopLevelField(definition.tag, shape, index.field);
    const column = columnName(index.field);
    if (seenColumns.has(column)) {
      throw new Error(
        `Kind "${definition.tag}" has multiple indexed fields that map to column "${column}".`,
      );
    }
    seenColumns.add(column);
    columns.set(index.field, {
      field: index.field,
      column,
      single: index.single,
      type:
        index.type ??
        inferSqliteType(shape[index.field], definition.tag, index.field),
    });
  }
  for (const multiIndex of definition.multiIndexes) {
    for (const [field] of multiIndex.fields) {
      if (columns.has(field)) {
        continue;
      }
      assertTopLevelField(definition.tag, shape, field);
      const column = columnName(field);
      if (seenColumns.has(column)) {
        throw new Error(
          `Kind "${definition.tag}" has multiple indexed fields that map to column "${column}".`,
        );
      }
      seenColumns.add(column);
      columns.set(field, {
        field,
        column,
        single: false,
        type: inferSqliteType(shape[field], definition.tag, field),
      });
    }
  }
  return columns;
}

function assertTopLevelField(
  tag: string,
  shape: Record<string, unknown>,
  field: string,
) {
  if (!(field in shape)) {
    throw new Error(`Kind "${tag}" references unknown field "${field}".`);
  }
}

function inferSqliteType(schema: any, tag: string, field: string): SqliteTypeHint {
  while (
    schema?._def?.type === "optional" ||
    schema?._def?.type === "nullable" ||
    schema?._def?.type === "default" ||
    schema?._def?.type === "readonly" ||
    schema?._def?.type === "catch"
  ) {
    schema = schema._def.innerType;
  }
  switch (schema?._def?.type) {
    case "string":
    case "enum":
      return "text";
    case "boolean":
      return "integer";
    case "literal":
      return typeof schema._def.value === "number"
        ? "integer"
        : typeof schema._def.value === "boolean"
          ? "integer"
          : "text";
    case "number":
      return schema._def.checks?.some((check: any) => check.isInt)
        ? "integer"
        : "real";
    default:
      throw new Error(
        `Kind "${tag}" field "${field}" needs an explicit SQLite type hint.`,
      );
  }
}

function compileWhere<T extends KindDefinitionBag>(
  columns: Map<string, IndexColumn>,
  where: KindWhere<T> | undefined,
): CompiledQuery {
  if (!where || !Object.keys(where).length) {
    return { sql: "", values: [] };
  }
  const parts: string[] = [];
  const values: any[] = [];
  for (const [field, operand] of Object.entries(where)) {
    const column = columns.get(field);
    if (!column) {
      throw new Error(`Field "${field}" is not indexed and cannot be queried.`);
    }
    if (isFilterOperators(operand)) {
      if (operand.in) {
        if (!operand.in.length) {
          parts.push("0 = 1");
          continue;
        }
        parts.push(
          `${quoteIdentifier(column.column)} IN (${operand.in.map(() => "?").join(", ")})`,
        );
        values.push(...operand.in);
      }
      if (operand.gt != null) {
        parts.push(`${quoteIdentifier(column.column)} > ?`);
        values.push(operand.gt);
      }
      if (operand.gte != null) {
        parts.push(`${quoteIdentifier(column.column)} >= ?`);
        values.push(operand.gte);
      }
      if (operand.lt != null) {
        parts.push(`${quoteIdentifier(column.column)} < ?`);
        values.push(operand.lt);
      }
      if (operand.lte != null) {
        parts.push(`${quoteIdentifier(column.column)} <= ?`);
        values.push(operand.lte);
      }
      continue;
    }
    if (operand == null) {
      parts.push(`${quoteIdentifier(column.column)} IS NULL`);
      continue;
    }
    parts.push(`${quoteIdentifier(column.column)} = ?`);
    values.push(operand);
  }
  return {
    sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "",
    values,
  };
}

function compileOrderBy(
  columns: Map<string, IndexColumn>,
  orderBy: Record<string, IndexDirection | undefined> | undefined,
) {
  if (!orderBy || !Object.keys(orderBy).length) {
    return "";
  }
  return ` ORDER BY ${Object.entries(orderBy)
    .map(([field, direction]) => {
      if (!direction) {
        throw new Error(`Order direction for "${field}" is required.`);
      }
      const column = columns.get(field);
      if (!column) {
        throw new Error(`Field "${field}" is not indexed and cannot be ordered.`);
      }
      return `${quoteIdentifier(column.column)} ${direction.toUpperCase()}`;
    })
    .join(", ")}`;
}

function isFilterOperators(value: unknown): value is {
  in?: readonly unknown[];
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
} {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("in" in value ||
      "gt" in value ||
      "gte" in value ||
      "lt" in value ||
      "lte" in value)
  );
}

function assertTaggedId<TTag extends string>(tag: TTag, id: TaggedId<TTag>) {
  if (!id.startsWith(`${tag}_`)) {
    throw new Error(`Expected ID for tag "${tag}", received "${id}".`);
  }
}

function parsePayload(payload: string) {
  return JSON.parse(payload) as Record<string, unknown>;
}

function columnExpression(type: SqliteTypeHint, field: string) {
  const path = `$."${field.replaceAll('"', '""')}"`;
  const extract = `json_extract("payload", '${path}')`;
  return type === "text" ? extract : `CAST(${extract} AS ${type.toUpperCase()})`;
}

function indexName(table: string, suffix: string) {
  return `idx_${table}_${suffix}`;
}

function columnName(field: string) {
  const column = snakeCase(field);
  return RESERVED_COLUMN_NAMES.has(column) ? `doc_${column}` : column;
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function snakeCase(value: string) {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    const lower = char.toLowerCase();
    if (index && char !== lower && value[index - 1] !== "_") {
      result += "_";
    }
    result += lower;
  }
  return result;
}
