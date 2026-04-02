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
  SchemaDefinition,
  SqliteTypeHint,
} from "./types";
import {
  assertTaggedId,
  columnExpression,
  indexName,
  isFilterOperators,
  isRecord,
  isSqliteTypeHint,
  parsePayload,
  quoteIdentifier,
  quoteString,
  sameColumns,
  snakeCase,
} from "./util";

const KINDSTORE_FORMAT_VERSION = 1;
const INTERNAL_TABLE = "__kindstore_internal";
const APP_METADATA_TABLE = "__kindstore_app_metadata";
const LEGACY_KIND_VERSIONS_TABLE = "__kindstore_kind_versions";
const LEGACY_APP_METADATA_TABLE = "__kindstore_metadata";
const STORE_FORMAT_VERSION_KEY = "store_format_version";
const KIND_VERSIONS_KEY = "kind_versions";
const SCHEMA_SNAPSHOT_KEY = "schema_snapshot";
const RESERVED_STORE_KEYS = new Set(["batch", "close", "connection", "metadata", "raw"]);
const RESERVED_COLUMN_NAMES = new Set(["id", "payload", "created_at", "updated_at"]);
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

type SnapshotIndex = {
  sqliteName: string;
  columns: readonly string[];
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
      type: SqliteTypeHint;
      single: boolean;
    }
  >;
  indexes: Record<string, SnapshotIndex>;
};

type StoreSchemaSnapshot = {
  kindstoreVersion: number;
  kinds: Record<string, SnapshotKind>;
};

type SchemaPlan = {
  drops: Set<string>;
  renames: Map<string, string>;
  retags: Map<string, string>;
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
    updater: PatchValue<KindValue<T>> | ((current: KindValue<T>) => KindValue<T>),
  ): KindValue<T> | undefined;
  first(options?: FindManyOptions<T>): KindValue<T> | undefined;
  findMany(options?: FindManyOptions<T>): KindValue<T>[];
  iterate(options?: FindManyOptions<T>): IterableIterator<KindValue<T>>;
};

type MetadataSurface<T extends MetadataDefinitionMap> = {
  get<K extends keyof T & string>(key: K): MetadataValue<T, K> | undefined;
  set<K extends keyof T & string>(key: K, value: MetadataValue<T, K>): MetadataValue<T, K>;
  delete<K extends keyof T & string>(key: K): boolean;
  update<K extends keyof T & string>(
    key: K,
    updater: (current: MetadataValue<T, K> | undefined) => MetadataValue<T, K>,
  ): MetadataValue<T, K>;
};

type KindStoreSurface<TKinds extends KindRegistry, TMetadata extends MetadataDefinitionMap> = {
  readonly raw: Database;
  readonly metadata: MetadataSurface<TMetadata>;
  batch<TResult>(callback: () => TResult): TResult;
  close(): void;
} & {
  [K in keyof TKinds]: TKinds[K] extends KindDefinition<infer TBag>
    ? KindCollectionSurface<TBag>
    : never;
};

export type PublicKindCollection<T extends KindDefinitionBag> = KindCollectionSurface<T>;
export type PublicMetadataCollection<T extends MetadataDefinitionMap> = MetadataSurface<T>;
export type PublicKindstore<
  TKinds extends KindRegistry,
  TMetadata extends MetadataDefinitionMap,
> = KindStoreSurface<TKinds, TMetadata>;

export function createStore<TKinds extends KindRegistry, TMetadata extends MetadataDefinitionMap>(
  connection: ConnectionConfig,
  kinds: TKinds,
  metadataDefinitions: TMetadata,
  schemaDefinition?: SchemaDefinition,
) {
  const database = new Database(connection.filename, connection.options);
  try {
    const runtime = new KindstoreRuntime<TMetadata>(
      database,
      normalizeKinds(kinds),
      metadataDefinitions,
      normalizeSchemaPlan(schemaDefinition),
    );
    return runtime.publicStore as PublicKindstore<TKinds, TMetadata>;
  } catch (error) {
    database.close();
    throw error;
  }
}

class KindstoreRuntime<TMetadata extends MetadataDefinitionMap> {
  readonly database: Database;
  readonly kinds: Map<string, KindRuntimeDefinition<any>>;
  readonly publicStore: Record<string, unknown>;
  readonly internal: InternalMetadataRuntime;
  readonly metadata: MetadataRuntime<TMetadata>;
  readonly schemaPlan: SchemaPlan;

  constructor(
    database: Database,
    kinds: Map<string, KindRuntimeDefinition<any>>,
    metadataDefinitions: TMetadata,
    schemaPlan: SchemaPlan,
  ) {
    this.database = database;
    this.kinds = kinds;
    this.schemaPlan = schemaPlan;
    this.publicStore = this as Record<string, unknown>;
    this.ensureInternalTable();
    this.internal = new InternalMetadataRuntime(database);
    this.bootstrap();
    this.metadata = new MetadataRuntime(database, metadataDefinitions);
    this.publicStore.raw = database;
    this.publicStore.metadata = this.metadata as PublicMetadataCollection<TMetadata>;
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
    this.database.transaction(() => {
      this.ensureStoreFormatVersion();
      this.database.exec(
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(APP_METADATA_TABLE)} (
          "key" TEXT PRIMARY KEY NOT NULL,
          "payload" TEXT NOT NULL,
          "created_at" INTEGER NOT NULL,
          "updated_at" INTEGER NOT NULL
        ) STRICT`,
      );
      const previousSnapshot = this.applySchemaMigrations(this.internal.getSchemaSnapshot());
      for (const definition of this.kinds.values()) {
        this.ensureKindTable(definition);
        this.ensureGeneratedColumns(definition);
        this.reconcileIndexes(definition, previousSnapshot?.kinds[definition.key]);
        this.dropStaleGeneratedColumns(definition, previousSnapshot?.kinds[definition.key]);
        this.migrateKind(definition);
      }
      this.internal.setSchemaSnapshot(this.createSchemaSnapshot());
    })();
  }

  private ensureInternalTable() {
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(INTERNAL_TABLE)} (
        "key" TEXT PRIMARY KEY NOT NULL,
        "payload" TEXT NOT NULL,
        "updated_at" INTEGER NOT NULL
      ) STRICT`,
    );
  }

  private ensureStoreFormatVersion() {
    const version = this.internal.getNumber(STORE_FORMAT_VERSION_KEY);
    if (version == null) {
      if (this.hasExistingStoreArtifacts()) {
        throw new Error(
          "Store is missing the kindstore format version and cannot be opened safely.",
        );
      }
      this.internal.set(STORE_FORMAT_VERSION_KEY, KINDSTORE_FORMAT_VERSION);
      return;
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`Invalid kindstore format version "${version}".`);
    }
    if (version > KINDSTORE_FORMAT_VERSION) {
      throw new Error(
        `Store format version ${version} is newer than supported version ${KINDSTORE_FORMAT_VERSION}.`,
      );
    }
    if (version < KINDSTORE_FORMAT_VERSION) {
      throw new Error(
        `Store format version ${version} is older than supported version ${KINDSTORE_FORMAT_VERSION}.`,
      );
    }
  }

  private hasExistingStoreArtifacts() {
    if (this.hasTable(LEGACY_KIND_VERSIONS_TABLE) || this.hasTable(LEGACY_APP_METADATA_TABLE)) {
      return true;
    }
    for (const definition of this.kinds.values()) {
      if (this.hasTable(definition.table)) {
        return true;
      }
    }
    return this.internal.keys().length > 0;
  }

  private hasTable(name: string) {
    return !!this.database
      .query(`SELECT 1 AS "exists" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?`)
      .get(name);
  }

  private applySchemaMigrations(previousSnapshot: StoreSchemaSnapshot | undefined) {
    if (!previousSnapshot) {
      return previousSnapshot;
    }
    const resolvedKinds: Record<string, SnapshotKind> = {};
    const consumedPrevious = new Set<string>();
    const usedRetags = new Set<string>();
    for (const [key, previous] of Object.entries(previousSnapshot.kinds)) {
      if (this.kinds.has(key)) {
        resolvedKinds[key] = previous;
        consumedPrevious.add(key);
      }
    }
    for (const [previousKey, nextKey] of this.schemaPlan.renames) {
      const previous = previousSnapshot.kinds[previousKey];
      if (!previous) {
        throw new Error(
          `Schema migration rename references unknown previous kind "${previousKey}".`,
        );
      }
      const next = this.kinds.get(nextKey);
      if (!next) {
        throw new Error(
          `Schema migration rename target "${nextKey}" is not in the current registry.`,
        );
      }
      if (resolvedKinds[nextKey]) {
        throw new Error(
          `Schema migration rename target "${nextKey}" is already matched to a previous kind.`,
        );
      }
      this.renameKind(previousKey, previous, nextKey, next);
      resolvedKinds[nextKey] = {
        ...previous,
        table: next.table,
      };
      consumedPrevious.add(previousKey);
    }
    for (const [previousKey, previous] of Object.entries(previousSnapshot.kinds)) {
      if (consumedPrevious.has(previousKey)) {
        continue;
      }
      if (this.schemaPlan.drops.has(previousKey)) {
        this.dropKind(previousKey, previous);
        consumedPrevious.add(previousKey);
        continue;
      }
      if (!this.kinds.has(previousKey)) {
        throw new Error(
          `Previous kind "${previousKey}" is missing from the current registry and requires schema.migrate(...).`,
        );
      }
    }
    for (const [key, current] of this.kinds) {
      const previous = resolvedKinds[key];
      if (!previous) {
        continue;
      }
      if (this.retagKindIfNeeded(key, previous, current)) {
        usedRetags.add(key);
      }
    }
    for (const key of this.schemaPlan.retags.keys()) {
      if (!usedRetags.has(key)) {
        throw new Error(
          `Schema migration retag for kind "${key}" did not match a changed current kind.`,
        );
      }
    }
    return {
      kindstoreVersion: previousSnapshot.kindstoreVersion,
      kinds: resolvedKinds,
    };
  }

  private renameKind<T extends KindDefinitionBag>(
    previousKey: string,
    previous: SnapshotKind,
    nextKey: string,
    next: KindRuntimeDefinition<T>,
  ) {
    if (this.kinds.has(previousKey)) {
      throw new Error(
        `Schema migration rename source "${previousKey}" still exists in the current registry.`,
      );
    }
    if (!this.hasTable(previous.table)) {
      throw new Error(`Schema migration rename source table "${previous.table}" does not exist.`);
    }
    if (previous.table !== next.table) {
      if (this.hasTable(next.table)) {
        throw new Error(`Schema migration rename target table "${next.table}" already exists.`);
      }
      this.database.exec(
        `ALTER TABLE ${quoteIdentifier(previous.table)} RENAME TO ${quoteIdentifier(next.table)}`,
      );
    }
    this.internal.moveKindVersion(previousKey, nextKey);
  }

  private dropKind(previousKey: string, previous: SnapshotKind) {
    if (this.kinds.has(previousKey)) {
      throw new Error(
        `Schema migration drop source "${previousKey}" still exists in the current registry.`,
      );
    }
    if (this.hasTable(previous.table)) {
      this.database.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(previous.table)}`);
    }
    this.internal.deleteKindVersion(previousKey);
  }

  private retagKindIfNeeded<T extends KindDefinitionBag>(
    key: string,
    previous: SnapshotKind,
    current: KindRuntimeDefinition<T>,
  ) {
    if (previous.tag === current.definition.tag) {
      return false;
    }
    const expectedPreviousTag = this.schemaPlan.retags.get(key);
    if (expectedPreviousTag !== previous.tag) {
      throw new Error(
        `Kind "${key}" changed tag from "${previous.tag}" to "${current.definition.tag}" and requires schema.migrate(...).`,
      );
    }
    const updateIds = this.database.query(
      `UPDATE ${quoteIdentifier(current.table)} SET "id" = ? WHERE "id" = ?`,
    );
    for (const row of this.database
      .query(`SELECT "id" FROM ${quoteIdentifier(current.table)} ORDER BY "id" ASC`)
      .iterate() as IterableIterator<{ id: string }>) {
      if (!row.id.startsWith(`${previous.tag}_`)) {
        throw new Error(
          `Kind "${key}" cannot retag row "${row.id}" because it does not use the previous tag prefix "${previous.tag}_".`,
        );
      }
      updateIds.run(`${current.definition.tag}_${row.id.slice(previous.tag.length + 1)}`, row.id);
    }
    return true;
  }

  private ensureKindTable<T extends KindDefinitionBag>(definition: KindRuntimeDefinition<T>) {
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
        this.database.query(`PRAGMA table_xinfo(${quoteString(definition.table)})`).all() as {
          name: string;
        }[]
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

  private reconcileIndexes<T extends KindDefinitionBag>(
    definition: KindRuntimeDefinition<T>,
    previous: SnapshotKind | undefined,
  ) {
    const current = snapshotIndexes(definition);
    if (previous) {
      for (const index of Object.values(previous.indexes)) {
        const next = current[index.sqliteName];
        if (next && sameColumns(index.columns, next.columns)) {
          continue;
        }
        this.database.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(index.sqliteName)}`);
      }
    }
    for (const index of Object.values(current)) {
      this.database.exec(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(index.sqliteName)} ON ${quoteIdentifier(definition.table)} (${index.columns.join(", ")})`,
      );
    }
  }

  private dropStaleGeneratedColumns<T extends KindDefinitionBag>(
    definition: KindRuntimeDefinition<T>,
    previous: SnapshotKind | undefined,
  ) {
    if (!previous) {
      return;
    }
    const currentColumns = new Set(
      Array.from(definition.columns.values(), (column) => column.column),
    );
    const existingColumns = new Set(
      (
        this.database.query(`PRAGMA table_xinfo(${quoteString(definition.table)})`).all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    for (const column of Object.values(previous.columns)) {
      if (currentColumns.has(column.column) || !existingColumns.has(column.column)) {
        continue;
      }
      this.database.exec(
        `ALTER TABLE ${quoteIdentifier(definition.table)} DROP COLUMN ${quoteIdentifier(column.column)}`,
      );
    }
  }

  private createSchemaSnapshot(): StoreSchemaSnapshot {
    const kinds: Record<string, SnapshotKind> = {};
    for (const [key, definition] of this.kinds) {
      kinds[key] = snapshotKind(definition);
    }
    return {
      kindstoreVersion: KINDSTORE_FORMAT_VERSION,
      kinds,
    };
  }

  private migrateKind<T extends KindDefinitionBag>(definition: KindRuntimeDefinition<T>) {
    const version = this.internal.getKindVersion(definition.key);
    if (version == null) {
      this.internal.setKindVersion(definition.key, definition.definition.version);
      return;
    }
    if (version > definition.definition.version) {
      throw new Error(
        `Kind "${definition.key}" is at version ${version}, but the registry declares version ${definition.definition.version}.`,
      );
    }
    if (version === definition.definition.version) {
      return;
    }
    const migrations = definition.definition.migrations;
    if (!migrations) {
      throw new Error(
        `Kind "${definition.key}" requires migrations from version ${version} to ${definition.definition.version}, but none were declared.`,
      );
    }
    const updateRow = this.database.query(
      `UPDATE ${quoteIdentifier(definition.table)} SET "payload" = ?, "updated_at" = ? WHERE "id" = ?`,
    );
    this.database.transaction(() => {
      const now = Date.now();
      const context: KindMigrationContext = { now };
      for (const row of this.database
        .query(
          `SELECT "id", "payload", "created_at", "updated_at" FROM ${quoteIdentifier(definition.table)} ORDER BY "id" ASC`,
        )
        .iterate() as IterableIterator<StoredRow>) {
        let value = parsePayload(row.payload);
        for (
          let currentVersion = version;
          currentVersion < definition.definition.version;
          currentVersion++
        ) {
          const step = migrations[currentVersion];
          if (!step) {
            throw new Error(
              `Kind "${definition.key}" is missing migration step ${currentVersion} -> ${currentVersion + 1}.`,
            );
          }
          value = step(value as Partial<KindValue<T>> & Record<string, unknown>, context) as Record<
            string,
            unknown
          >;
        }
        updateRow.run(JSON.stringify(definition.definition.schema.parse(value)), now, row.id);
      }
      this.internal.setKindVersion(definition.key, definition.definition.version);
    })();
  }
}

class KindCollectionRuntime<T extends KindDefinitionBag> implements KindCollectionSurface<T> {
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
    updater: PatchValue<KindValue<T>> | ((current: KindValue<T>) => KindValue<T>),
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
    if (options.limit != null && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new Error(
        `Query limit for kind "${this.definition.key}" must be a non-negative integer.`,
      );
    }
    const where = compileWhere(this.definition.columns, options.where);
    const orderBy = compileOrderBy(this.definition.columns, options.orderBy);
    return {
      sql: `SELECT "id", "payload", "created_at", "updated_at" FROM ${quoteIdentifier(this.definition.table)}${where.sql}${orderBy}${options.limit == null ? "" : " LIMIT ?"}`,
      values: options.limit == null ? where.values : [...where.values, options.limit],
    };
  }
}

class MetadataRuntime<T extends MetadataDefinitionMap> implements MetadataSurface<T> {
  readonly database: Database;
  readonly definitions: T;
  readonly getStatement;
  readonly setStatement;
  readonly deleteStatement;

  constructor(database: Database, definitions: T) {
    this.database = database;
    this.definitions = definitions;
    this.getStatement = database.query(
      `SELECT "payload" FROM ${quoteIdentifier(APP_METADATA_TABLE)} WHERE "key" = ?`,
    );
    this.setStatement = database.query(
      `INSERT INTO ${quoteIdentifier(APP_METADATA_TABLE)} ("key", "payload", "created_at", "updated_at") VALUES (?, ?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET "payload" = excluded."payload", "updated_at" = excluded."updated_at"`,
    );
    this.deleteStatement = database.query(
      `DELETE FROM ${quoteIdentifier(APP_METADATA_TABLE)} WHERE "key" = ?`,
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

class InternalMetadataRuntime {
  readonly database: Database;
  readonly getStatement;
  readonly deleteStatement;
  readonly setStatement;

  constructor(database: Database) {
    this.database = database;
    this.getStatement = database.query(
      `SELECT "payload" FROM ${quoteIdentifier(INTERNAL_TABLE)} WHERE "key" = ?`,
    );
    this.deleteStatement = database.query(
      `DELETE FROM ${quoteIdentifier(INTERNAL_TABLE)} WHERE "key" = ?`,
    );
    this.setStatement = database.query(
      `INSERT INTO ${quoteIdentifier(INTERNAL_TABLE)} ("key", "payload", "updated_at") VALUES (?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET "payload" = excluded."payload", "updated_at" = excluded."updated_at"`,
    );
  }

  get(key: string) {
    const row = this.getStatement.get(key) as { payload: string } | undefined;
    return row ? parsePayload(row.payload) : undefined;
  }

  getNumber(key: string) {
    const value = this.get(key);
    if (value == null) {
      return undefined;
    }
    if (typeof value !== "number") {
      throw new Error(`Internal metadata key "${key}" must be a number.`);
    }
    return value;
  }

  set(key: string, value: unknown) {
    this.setStatement.run(key, JSON.stringify(value), Date.now());
  }

  delete(key: string) {
    this.deleteStatement.run(key);
  }

  keys() {
    return (
      this.database
        .query(`SELECT "key" FROM ${quoteIdentifier(INTERNAL_TABLE)} ORDER BY "key" ASC`)
        .all() as { key: string }[]
    ).map((row) => row.key);
  }

  getKindVersion(kind: string) {
    const versions = this.getKindVersions();
    const version = versions?.[kind];
    return typeof version === "number" ? version : undefined;
  }

  setKindVersion(kind: string, version: number) {
    const current = this.getKindVersions();
    const next = current ? { ...current, [kind]: version } : { [kind]: version };
    this.set(KIND_VERSIONS_KEY, next);
  }

  deleteKindVersion(kind: string) {
    const current = this.getKindVersions();
    if (!current) {
      return;
    }
    const next = { ...current };
    delete next[kind];
    if (Object.keys(next).length) {
      this.set(KIND_VERSIONS_KEY, next);
      return;
    }
    this.delete(KIND_VERSIONS_KEY);
  }

  moveKindVersion(previousKind: string, nextKind: string) {
    const version = this.getKindVersion(previousKind);
    if (version == null) {
      return;
    }
    if (this.getKindVersion(nextKind) != null) {
      throw new Error(
        `Schema migration cannot move kind version from "${previousKind}" to "${nextKind}" because the target already has a version entry.`,
      );
    }
    this.setKindVersion(nextKind, version);
    this.deleteKindVersion(previousKind);
  }

  getSchemaSnapshot() {
    const snapshot = this.get(SCHEMA_SNAPSHOT_KEY);
    if (snapshot == null) {
      return undefined;
    }
    if (
      !isRecord(snapshot) ||
      !Number.isInteger(snapshot.kindstoreVersion) ||
      !isRecord(snapshot.kinds)
    ) {
      throw new Error(`Internal metadata key "${SCHEMA_SNAPSHOT_KEY}" is malformed.`);
    }
    for (const [kindKey, kind] of Object.entries(snapshot.kinds)) {
      if (
        !isRecord(kind) ||
        typeof kind.tag !== "string" ||
        typeof kind.table !== "string" ||
        !Number.isInteger(kind.version) ||
        !isRecord(kind.columns) ||
        !isRecord(kind.indexes)
      ) {
        throw new Error(
          `Internal metadata key "${SCHEMA_SNAPSHOT_KEY}" has an invalid kind entry for "${kindKey}".`,
        );
      }
      for (const [field, column] of Object.entries(kind.columns)) {
        if (
          !isRecord(column) ||
          column.field !== field ||
          typeof column.column !== "string" ||
          typeof column.type !== "string" ||
          !isSqliteTypeHint(column.type) ||
          typeof column.single !== "boolean"
        ) {
          throw new Error(
            `Internal metadata key "${SCHEMA_SNAPSHOT_KEY}" has an invalid column entry for "${kindKey}.${field}".`,
          );
        }
      }
      for (const [indexName, index] of Object.entries(kind.indexes)) {
        if (
          !isRecord(index) ||
          index.sqliteName !== indexName ||
          !Array.isArray(index.columns) ||
          index.columns.some((column) => typeof column !== "string")
        ) {
          throw new Error(
            `Internal metadata key "${SCHEMA_SNAPSHOT_KEY}" has an invalid index entry for "${kindKey}.${indexName}".`,
          );
        }
      }
    }
    return snapshot as StoreSchemaSnapshot;
  }

  setSchemaSnapshot(snapshot: StoreSchemaSnapshot) {
    this.set(SCHEMA_SNAPSHOT_KEY, snapshot);
  }

  private getKindVersions() {
    const versions = this.get(KIND_VERSIONS_KEY);
    if (versions == null) {
      return undefined;
    }
    if (!isRecord(versions)) {
      throw new Error(`Internal metadata key "${KIND_VERSIONS_KEY}" is malformed.`);
    }
    for (const [kind, version] of Object.entries(versions as Record<string, unknown>)) {
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        throw new Error(
          `Internal metadata key "${KIND_VERSIONS_KEY}" has an invalid version for "${kind}".`,
        );
      }
    }
    return versions as Record<string, number>;
  }
}

function normalizeSchemaPlan(schemaDefinition: SchemaDefinition | undefined): SchemaPlan {
  const plan: SchemaPlan = {
    drops: new Set(),
    renames: new Map(),
    retags: new Map(),
  };
  if (!schemaDefinition) {
    return plan;
  }
  schemaDefinition.migrate(new SchemaMigrationPlannerRuntime(plan));
  return plan;
}

class SchemaMigrationPlannerRuntime {
  readonly plan: SchemaPlan;

  constructor(plan: SchemaPlan) {
    this.plan = plan;
  }

  rename(previousKindKey: string, nextKindKey: string) {
    if (!previousKindKey || !nextKindKey) {
      throw new Error("Schema migration rename keys must be non-empty.");
    }
    if (previousKindKey === nextKindKey) {
      throw new Error(
        `Schema migration rename from "${previousKindKey}" to itself is not allowed.`,
      );
    }
    if (this.plan.drops.has(previousKindKey) || this.plan.renames.has(previousKindKey)) {
      throw new Error(
        `Schema migration already defines an operation for previous kind "${previousKindKey}".`,
      );
    }
    for (const existingNextKey of this.plan.renames.values()) {
      if (existingNextKey === nextKindKey) {
        throw new Error(`Schema migration already maps a previous kind to "${nextKindKey}".`);
      }
    }
    this.plan.renames.set(previousKindKey, nextKindKey);
    return this;
  }

  drop(previousKindKey: string) {
    if (!previousKindKey) {
      throw new Error("Schema migration drop key must be non-empty.");
    }
    if (this.plan.renames.has(previousKindKey) || this.plan.drops.has(previousKindKey)) {
      throw new Error(
        `Schema migration already defines an operation for previous kind "${previousKindKey}".`,
      );
    }
    this.plan.drops.add(previousKindKey);
    return this;
  }

  retag(kindKey: string, previousTag: string) {
    if (!kindKey || !previousTag) {
      throw new Error("Schema migration retag arguments must be non-empty.");
    }
    if (this.plan.retags.has(kindKey)) {
      throw new Error(`Schema migration already defines a retag for kind "${kindKey}".`);
    }
    this.plan.retags.set(kindKey, previousTag);
    return this;
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
      type: index.type ?? inferSqliteType(shape[index.field], definition.tag, index.field),
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

function assertTopLevelField(tag: string, shape: Record<string, unknown>, field: string) {
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
      return schema._def.checks?.some((check: any) => check.isInt) ? "integer" : "real";
    default:
      throw new Error(`Kind "${tag}" field "${field}" needs an explicit SQLite type hint.`);
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

function columnName(field: string) {
  const column = snakeCase(field);
  return RESERVED_COLUMN_NAMES.has(column) ? `doc_${column}` : column;
}

function snapshotKind<T extends KindDefinitionBag>(
  definition: KindRuntimeDefinition<T>,
): SnapshotKind {
  const columns: SnapshotKind["columns"] = {};
  for (const column of definition.columns.values()) {
    columns[column.field] = {
      field: column.field,
      column: column.column,
      type: column.type,
      single: column.single,
    };
  }
  return {
    tag: definition.definition.tag,
    table: definition.table,
    version: definition.definition.version,
    columns,
    indexes: snapshotIndexes(definition),
  };
}

function snapshotIndexes<T extends KindDefinitionBag>(definition: KindRuntimeDefinition<T>) {
  const indexes: Record<string, SnapshotIndex> = {};
  for (const column of definition.columns.values()) {
    if (!column.single) {
      continue;
    }
    const sqliteName = indexName(definition.table, column.column);
    indexes[sqliteName] = {
      sqliteName,
      columns: [quoteIdentifier(column.column)],
    };
  }
  for (const multiIndex of definition.definition.multiIndexes) {
    const sqliteName = indexName(definition.table, snakeCase(multiIndex.name));
    indexes[sqliteName] = {
      sqliteName,
      columns: multiIndex.fields.map(
        ([field, direction]) =>
          `${quoteIdentifier(definition.columns.get(field)!.column)} ${direction.toUpperCase()}`,
      ),
    };
  }
  return indexes;
}
