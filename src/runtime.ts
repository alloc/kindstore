import { Database } from "bun:sqlite";
import { monotonicFactory } from "ulid";

import { UnrecoverableStoreOpenError } from "./errors";
import { KindBuilder } from "./kind";
import type {
  DatabaseOptions,
  FindManyOptions,
  FindPageOptions,
  FindPageResult,
  IndexDirection,
  Kind,
  KindId,
  KindInput,
  KindManagedCreatedAt,
  KindManagedUpdatedAt,
  KindMigrationContext,
  KindOutput,
  KindPageCursor,
  KindRegistry,
  KindUniqueSelector,
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
  parseRowData,
  quoteIdentifier,
  quoteString,
  sameColumns,
  snakeCase,
  taggedIdTag,
} from "./util";

const KINDSTORE_FORMAT_VERSION = 1;
const INTERNAL_TABLE = "__kindstore_internal";
const APP_METADATA_TABLE = "__kindstore_app_metadata";
const STORE_FORMAT_VERSION_KEY = "store_format_version";
const KIND_VERSIONS_KEY = "kind_versions";
const SCHEMA_SNAPSHOT_KEY = "schema_snapshot";
const RESERVED_STORE_KEYS = new Set(["batch", "close", "metadata", "raw", "resolve", "schema"]);
const RESERVED_ROW_COLUMNS = new Set(["id", "data"]);
const nextUlid = monotonicFactory();
const PAGE_CURSOR_VERSION = 1;

type StoredRow = {
  id: string;
  data: string;
};

type IndexColumn = {
  field: string;
  column: string;
  type: SqliteTypeHint;
  single: boolean;
  unique: boolean;
};

type UniqueIndexDefinition = {
  name: string;
  fields: readonly string[];
};

type KindRuntimeDefinition<T extends Kind> = {
  key: string;
  table: string;
  columns: Map<string, IndexColumn>;
  uniqueIndexes: readonly UniqueIndexDefinition[];
  createdAtField?: KindManagedCreatedAt<T>;
  updatedAtField?: KindManagedUpdatedAt<T>;
  definition: KindBuilder<T>;
};

type SnapshotIndex = {
  sqliteName: string;
  columns: readonly string[];
  unique: boolean;
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

type ResolvedOrderByEntry = {
  field: string;
  direction: IndexDirection;
  column: IndexColumn;
};

type PageCursorData = {
  version: typeof PAGE_CURSOR_VERSION;
  tag: string;
  order: Array<readonly [field: string, direction: IndexDirection]>;
  values: unknown[];
  id: string;
};

type WriteMode = "create" | "replace";

/**
 * Typed collection API for one declared kind.
 */
export type KindCollection<T extends Kind> = {
  /** Returns a fresh opaque ID tagged for this kind. */
  newId(): KindId<T>;
  /** Allocates an ID, validates the payload, and inserts one new document. */
  create(value: KindInput<T>): KindOutput<T>;
  /** Reads one validated document by ID, or `undefined` if it does not exist. */
  get(id: KindId<T>): KindOutput<T> | undefined;
  /** Replaces the stored payload for `id`, inserting on the first write. */
  put(id: KindId<T>, value: KindInput<T>): KindOutput<T>;
  /**
   * Replaces the document identified by one declared unique selector, creating
   * it when absent.
   *
   * @remarks
   * The selector must use exact non-null values and must match one declared
   * unique index exactly. The provided value must preserve the selected unique
   * fields.
   */
  putByUnique(selector: KindUniqueSelector<T>, value: KindInput<T>): KindOutput<T>;
  /** Removes one document and returns whether anything was deleted. */
  delete(id: KindId<T>): boolean;
  /** Performs an atomic read-modify-write using a shallow patch or updater. */
  update(
    id: KindId<T>,
    updater: PatchValue<KindInput<T>> | ((current: KindOutput<T>) => KindInput<T>),
  ): KindOutput<T> | undefined;
  /** Returns the first matching document, or `undefined` when no row matches. */
  first(options?: FindManyOptions<T>): KindOutput<T> | undefined;
  /** Materializes all matching documents into memory. */
  findMany(options?: FindManyOptions<T>): KindOutput<T>[];
  /**
   * Returns one forward-only page of documents and an optional cursor for the
   * next page.
   *
   * @remarks
   * Requires an explicit `orderBy` and a positive `limit`.
   */
  findPage(options: FindPageOptions<T>): FindPageResult<T>;
  /** Lazily iterates matching documents without materializing the full result set. */
  iterate(options?: FindManyOptions<T>): IterableIterator<KindOutput<T>>;
};

/**
 * Typed key/value API for store-scoped application metadata.
 */
export type MetadataCollection<T extends MetadataDefinitionMap> = {
  /** Reads one metadata value, or `undefined` when it has not been set. */
  get<K extends keyof T & string>(key: K): MetadataValue<T, K> | undefined;
  /** Validates and writes one metadata value. */
  set<K extends keyof T & string>(key: K, value: MetadataValue<T, K>): MetadataValue<T, K>;
  /** Removes one metadata value and returns whether anything was deleted. */
  delete<K extends keyof T & string>(key: K): boolean;
  /** Updates one metadata value atomically from its current value. */
  update<K extends keyof T & string>(
    key: K,
    updater: (current: MetadataValue<T, K> | undefined) => MetadataValue<T, K>,
  ): MetadataValue<T, K>;
};

type StoreKind<TKinds extends KindRegistry> = TKinds[keyof TKinds];

type StoreKindId<TKinds extends KindRegistry> =
  StoreKind<TKinds> extends infer TKind extends KindBuilder<any> ? KindId<TKind> : never;

type ResolvedKind<TKinds extends KindRegistry, TId extends string> = {
  [K in keyof TKinds]: TId extends KindId<TKinds[K]> ? TKinds[K] : never;
}[keyof TKinds];

type ResolvedKindOutput<TKinds extends KindRegistry, TId extends string> =
  ResolvedKind<TKinds, TId> extends infer TKind extends KindBuilder<any>
    ? KindOutput<TKind>
    : never;

/**
 * Store surface returned from `kindstore(...)`.
 */
export type Kindstore<TKinds extends KindRegistry, TMetadata extends MetadataDefinitionMap> = {
  /** Underlying Bun SQLite database connection. */
  readonly raw: Database;
  /** Declared kind builders keyed by collection name. */
  readonly schema: TKinds;
  /** Typed application metadata collection. */
  readonly metadata: MetadataCollection<TMetadata>;
  /** Runs the callback in one SQLite transaction. */
  batch<TResult>(callback: () => TResult): TResult;
  /** Closes the underlying database connection. */
  close(): void;
  /** Dispatches a tagged ID to the matching collection automatically. */
  resolve<TId extends StoreKindId<TKinds>>(id: TId): ResolvedKindOutput<TKinds, TId> | undefined;
} & {
  [K in keyof TKinds]: TKinds[K] extends KindBuilder<infer TBag> ? KindCollection<TBag> : never;
};

/**
 * Internal helper that backs `kindstore(...)` after input normalization.
 */
export function createStore<TKinds extends KindRegistry, TMetadata extends MetadataDefinitionMap>(
  filename: string,
  databaseOptions: DatabaseOptions | undefined,
  kinds: TKinds,
  metadataDefinitions: TMetadata,
  schemaDefinition?: SchemaDefinition,
) {
  const database = new Database(filename, databaseOptions);
  try {
    const runtime = new KindstoreRuntime<TMetadata>(
      database,
      kinds,
      normalizeKinds(kinds),
      metadataDefinitions,
      normalizeSchemaPlan(schemaDefinition),
    );
    return runtime.publicStore as Kindstore<TKinds, TMetadata>;
  } catch (error) {
    database.close();
    throw error;
  }
}

class KindstoreRuntime<TMetadata extends MetadataDefinitionMap> {
  readonly database: Database;
  readonly kinds: Map<string, KindRuntimeDefinition<any>>;
  readonly collectionsByTag: Map<string, KindCollectionRuntime<any>>;
  readonly publicStore: Record<string, unknown>;
  readonly internal: InternalMetadataRuntime;
  readonly metadata: MetadataRuntime<TMetadata>;
  readonly schemaPlan: SchemaPlan;

  constructor(
    database: Database,
    declaredKinds: KindRegistry,
    kinds: Map<string, KindRuntimeDefinition<any>>,
    metadataDefinitions: TMetadata,
    schemaPlan: SchemaPlan,
  ) {
    this.database = database;
    this.kinds = kinds;
    this.collectionsByTag = new Map();
    this.schemaPlan = schemaPlan;
    this.publicStore = this as Record<string, unknown>;
    this.ensureInternalTable();
    this.internal = new InternalMetadataRuntime(database);
    this.bootstrap();
    this.metadata = new MetadataRuntime(database, metadataDefinitions);
    this.publicStore.raw = database;
    this.publicStore.schema = declaredKinds;
    this.publicStore.metadata = this.metadata as MetadataCollection<TMetadata>;
    for (const [key, definition] of kinds) {
      const collection = new KindCollectionRuntime(database, definition);
      this.collectionsByTag.set(definition.definition.tag, collection);
      this.publicStore[key] = collection as KindCollection<any>;
    }
  }

  batch<TResult>(callback: () => TResult) {
    return this.database.transaction(callback)();
  }

  close() {
    this.database.close();
  }

  resolve(id: string) {
    const tag = taggedIdTag(id);
    const collection = this.collectionsByTag.get(tag);
    if (!collection) {
      throw new Error(`No kind is registered for tag "${tag}" from ID "${id}".`);
    }
    return collection.get(id as never);
  }

  private bootstrap() {
    this.database.transaction(() => {
      this.ensureStoreFormatVersion();
      this.database.run(
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(APP_METADATA_TABLE)} (
          "key" TEXT PRIMARY KEY NOT NULL,
          "payload" TEXT NOT NULL
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
    this.database.run(
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
        throw new UnrecoverableStoreOpenError(
          "Store is missing the kindstore format version and cannot be opened safely.",
        );
      }
      this.internal.set(STORE_FORMAT_VERSION_KEY, KINDSTORE_FORMAT_VERSION);
      return;
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new UnrecoverableStoreOpenError(`Invalid kindstore format version "${version}".`);
    }
    if (version > KINDSTORE_FORMAT_VERSION) {
      throw new UnrecoverableStoreOpenError(
        `Store format version ${version} is newer than supported version ${KINDSTORE_FORMAT_VERSION}.`,
      );
    }
  }

  private hasExistingStoreArtifacts() {
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
          `Previous kind "${previousKey}" is missing from the current registry and requires migrate(...).`,
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

  private renameKind<T extends Kind>(
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
      this.database.run(
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
      this.database.run(`DROP TABLE IF EXISTS ${quoteIdentifier(previous.table)}`);
    }
    this.internal.deleteKindVersion(previousKey);
  }

  private retagKindIfNeeded<T extends Kind>(
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
        `Kind "${key}" changed tag from "${previous.tag}" to "${current.definition.tag}" and requires migrate(...).`,
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

  private ensureKindTable<T extends Kind>(definition: KindRuntimeDefinition<T>) {
    this.database.run(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(definition.table)} (
        "id" TEXT PRIMARY KEY NOT NULL,
        "data" TEXT NOT NULL
      ) STRICT`,
    );
  }

  private ensureGeneratedColumns<T extends Kind>(definition: KindRuntimeDefinition<T>) {
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
      this.database.run(
        `ALTER TABLE ${quoteIdentifier(definition.table)} ADD COLUMN ${quoteIdentifier(column.column)} ${column.type.toUpperCase()} GENERATED ALWAYS AS (${columnExpression(column.type, column.field)}) VIRTUAL`,
      );
    }
  }

  private reconcileIndexes<T extends Kind>(
    definition: KindRuntimeDefinition<T>,
    previous: SnapshotKind | undefined,
  ) {
    const current = snapshotIndexes(definition);
    if (previous) {
      for (const index of Object.values(previous.indexes)) {
        const next = current[index.sqliteName];
        if (next && index.unique === next.unique && sameColumns(index.columns, next.columns)) {
          continue;
        }
        this.database.run(`DROP INDEX IF EXISTS ${quoteIdentifier(index.sqliteName)}`);
      }
    }
    for (const index of Object.values(current)) {
      this.database.run(
        `CREATE${index.unique ? " UNIQUE" : ""} INDEX IF NOT EXISTS ${quoteIdentifier(index.sqliteName)} ON ${quoteIdentifier(definition.table)} (${index.columns.join(", ")})`,
      );
    }
  }

  private dropStaleGeneratedColumns<T extends Kind>(
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
      if (
        RESERVED_ROW_COLUMNS.has(column.column) ||
        currentColumns.has(column.column) ||
        !existingColumns.has(column.column)
      ) {
        continue;
      }
      this.database.run(
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

  private migrateKind<T extends Kind>(definition: KindRuntimeDefinition<T>) {
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
      `UPDATE ${quoteIdentifier(definition.table)} SET "data" = ? WHERE "id" = ?`,
    );
    this.database.transaction(() => {
      const now = Date.now();
      const context: KindMigrationContext = { now };
      for (const row of this.database
        .query(`SELECT "id", "data" FROM ${quoteIdentifier(definition.table)} ORDER BY "id" ASC`)
        .iterate() as IterableIterator<StoredRow>) {
        let value = parseRowData(row.data);
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
          value = step(value as any, context);
        }
        updateRow.run(
          JSON.stringify(
            applyManagedTimestamps(definition, value, parseRowData(row.data), now, "replace"),
          ),
          row.id,
        );
      }
      this.internal.setKindVersion(definition.key, definition.definition.version);
    })();
  }
}

class KindCollectionRuntime<T extends Kind> implements KindCollection<T> {
  readonly database: Database;
  readonly definition: KindRuntimeDefinition<T>;
  readonly getStatement;
  readonly createStatement;
  readonly putStatement;
  readonly deleteStatement;
  readonly updateStatement;

  constructor(database: Database, definition: KindRuntimeDefinition<T>) {
    this.database = database;
    this.definition = definition;
    this.getStatement = database.query(
      `SELECT "id", "data" FROM ${quoteIdentifier(definition.table)} WHERE "id" = ?`,
    );
    this.createStatement = database.query(
      `INSERT INTO ${quoteIdentifier(definition.table)} ("id", "data") VALUES (?, ?)`,
    );
    this.putStatement = database.query(
      `INSERT INTO ${quoteIdentifier(definition.table)} ("id", "data") VALUES (?, ?)
       ON CONFLICT("id") DO UPDATE SET "data" = excluded."data"`,
    );
    this.deleteStatement = database.query(
      `DELETE FROM ${quoteIdentifier(definition.table)} WHERE "id" = ?`,
    );
    this.updateStatement = database.query(
      `UPDATE ${quoteIdentifier(definition.table)} SET "data" = ? WHERE "id" = ?`,
    );
  }

  newId() {
    return `${this.definition.definition.tag}_${nextUlid()}` as KindId<T>;
  }

  create(value: KindInput<T>) {
    const id = this.newId();
    const parsed = this.prepareStoredValue(value, undefined, "create", Date.now());
    this.createStatement.run(id, JSON.stringify(parsed));
    return { id, ...parsed } as KindOutput<T>;
  }

  get(id: KindId<T>) {
    assertTaggedId(this.definition.definition.tag, id);
    const row = this.getStatement.get(id) as StoredRow | undefined;
    return row ? this.parseRow(row) : undefined;
  }

  put(id: KindId<T>, value: KindInput<T>) {
    assertTaggedId(this.definition.definition.tag, id);
    return this.database.transaction(() => {
      const row = this.getStatement.get(id) as StoredRow | undefined;
      const parsed = this.prepareStoredValue(
        value,
        row ? parseRowData(row.data) : undefined,
        row ? "replace" : "create",
      );
      this.putStatement.run(id, JSON.stringify(parsed));
      return { id, ...parsed } as KindOutput<T>;
    })();
  }

  putByUnique(selector: KindUniqueSelector<T>, value: KindInput<T>) {
    const selectorEntries = normalizeUniqueSelector(this.definition, selector);
    assertMatchesDeclaredUniqueIndex(this.definition, selectorEntries);
    return this.database.transaction(() => {
      const where = compileWhere(
        this.definition.columns,
        Object.fromEntries(selectorEntries) as KindWhere<T>,
      );
      const sql = `SELECT "id", "data" FROM ${quoteIdentifier(this.definition.table)}${where.sql} LIMIT 2`;
      const rows = this.database.query(sql).all(...where.values) as StoredRow[];
      if (rows.length > 1) {
        throw new Error(
          `putByUnique() selector for kind "${this.definition.key}" matched multiple rows.`,
        );
      }
      const row = rows[0];
      if (!row) {
        const id = this.newId();
        const parsed = this.prepareStoredValue(value, undefined, "create", Date.now());
        assertSelectorMatchesValue(this.definition, selectorEntries, parsed);
        this.createStatement.run(id, JSON.stringify(parsed));
        return { id, ...parsed } as KindOutput<T>;
      }
      const parsed = this.prepareStoredValue(value, parseRowData(row.data), "replace");
      assertSelectorMatchesValue(this.definition, selectorEntries, parsed);
      this.putStatement.run(row.id, JSON.stringify(parsed));
      return { id: row.id as KindId<T>, ...parsed } as KindOutput<T>;
    })();
  }

  delete(id: KindId<T>) {
    assertTaggedId(this.definition.definition.tag, id);
    return this.deleteStatement.run(id).changes > 0;
  }

  update(
    id: KindId<T>,
    updater: PatchValue<KindInput<T>> | ((current: KindOutput<T>) => KindInput<T>),
  ) {
    assertTaggedId(this.definition.definition.tag, id);
    return this.database.transaction(() => {
      const row = this.getStatement.get(id) as StoredRow | undefined;
      if (!row) {
        return undefined;
      }
      const current = this.parseRow(row);
      const nextValue =
        typeof updater === "function"
          ? (updater(current) as Record<string, unknown>)
          : ({ ...current, ...updater } as Record<string, unknown>);
      const parsed = this.prepareStoredValue(nextValue, parseRowData(row.data), "replace");
      this.updateStatement.run(JSON.stringify(parsed), id);
      return { id, ...parsed } as KindOutput<T>;
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

  findPage(options: FindPageOptions<T>) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error(
        `Query limit for kind "${this.definition.key}" must be a positive integer when using findPage().`,
      );
    }
    const orderEntries = resolveOrderBy(this.definition.columns, options.orderBy);
    if (!orderEntries.length) {
      throw new Error(`findPage() for kind "${this.definition.key}" requires an explicit orderBy.`);
    }
    const where = mergeWhereClauses(
      compileWhere(this.definition.columns, options.where),
      compilePageAfter(this.definition, orderEntries, options.after),
    );
    const sql = `SELECT "id", "data" FROM ${quoteIdentifier(this.definition.table)}${where.sql}${compileOrderBy(orderEntries, true)} LIMIT ?`;
    const rows = this.database.query(sql).all(...where.values, options.limit + 1) as StoredRow[];
    const pageRows = rows.slice(0, options.limit);
    const items = pageRows.map((row) => this.parseRow(row));
    if (rows.length <= options.limit || !pageRows.length) {
      return { items };
    }
    return {
      items,
      next: encodePageCursor(
        this.definition,
        orderEntries,
        pageRows[pageRows.length - 1]!,
        items.at(-1)!,
      ),
    };
  }

  *iterate(options: FindManyOptions<T> = {}) {
    const compiled = this.compileSelect(options);
    for (const row of this.database.query(compiled.sql).iterate(...compiled.values)) {
      yield this.parseRow(row as StoredRow);
    }
  }

  private parseRow(row: StoredRow) {
    const value = this.definition.definition.schema.parse(parseRowData(row.data));
    return { id: row.id as KindId<T>, ...value } as KindOutput<T>;
  }

  private prepareStoredValue(
    value: Record<string, unknown>,
    current: Record<string, unknown> | undefined,
    mode: WriteMode,
    now = Date.now(),
  ) {
    const { id: _id, ...rowData } = value;
    return applyManagedTimestamps(this.definition, rowData, current, now, mode);
  }

  private compileSelect(options: FindManyOptions<T>) {
    if (options.limit != null && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new Error(
        `Query limit for kind "${this.definition.key}" must be a non-negative integer.`,
      );
    }
    const where = compileWhere(this.definition.columns, options.where);
    const orderBy = compileOrderBy(resolveOrderBy(this.definition.columns, options.orderBy));
    return {
      sql: `SELECT "id", "data" FROM ${quoteIdentifier(this.definition.table)}${where.sql}${orderBy}${options.limit == null ? "" : " LIMIT ?"}`,
      values: options.limit == null ? where.values : [...where.values, options.limit],
    };
  }
}

class MetadataTableRuntime {
  readonly database: Database;
  readonly manageUpdatedAt: boolean;
  readonly getStatement;
  readonly setStatement;
  readonly deleteStatement;
  readonly keysStatement;

  constructor(database: Database, table: string, options: { manageUpdatedAt: boolean }) {
    this.database = database;
    this.manageUpdatedAt = options.manageUpdatedAt;
    this.getStatement = database.query(
      `SELECT "payload" FROM ${quoteIdentifier(table)} WHERE "key" = ?`,
    );
    this.setStatement = database.query(
      options.manageUpdatedAt
        ? `INSERT INTO ${quoteIdentifier(table)} ("key", "payload", "updated_at") VALUES (?, ?, ?)
           ON CONFLICT("key") DO UPDATE SET "payload" = excluded."payload", "updated_at" = excluded."updated_at"`
        : `INSERT INTO ${quoteIdentifier(table)} ("key", "payload") VALUES (?, ?)
           ON CONFLICT("key") DO UPDATE SET "payload" = excluded."payload"`,
    );
    this.deleteStatement = database.query(`DELETE FROM ${quoteIdentifier(table)} WHERE "key" = ?`);
    this.keysStatement = database.query(
      `SELECT "key" FROM ${quoteIdentifier(table)} ORDER BY "key" ASC`,
    );
  }

  get(key: string) {
    const row = this.getStatement.get(key) as { payload: string } | undefined;
    return row ? parseRowData(row.payload) : undefined;
  }

  set(key: string, value: unknown) {
    const now = Date.now();
    if (this.manageUpdatedAt) {
      this.setStatement.run(key, JSON.stringify(value), now);
      return;
    }
    this.setStatement.run(key, JSON.stringify(value));
  }

  delete(key: string) {
    return this.deleteStatement.run(key).changes > 0;
  }

  keys() {
    return (this.keysStatement.all() as { key: string }[]).map((row) => row.key);
  }
}

class MetadataRuntime<T extends MetadataDefinitionMap> implements MetadataCollection<T> {
  readonly database: Database;
  readonly definitions: T;
  readonly table: MetadataTableRuntime;

  constructor(database: Database, definitions: T) {
    this.database = database;
    this.definitions = definitions;
    this.table = new MetadataTableRuntime(database, APP_METADATA_TABLE, {
      manageUpdatedAt: false,
    });
  }

  get<K extends keyof T & string>(key: K) {
    const schema = this.definitions[key];
    if (!schema) {
      throw new Error(`Metadata key "${key}" is not declared.`);
    }
    const value = this.table.get(key);
    return value == null ? undefined : schema.parse(value);
  }

  set<K extends keyof T & string>(key: K, value: MetadataValue<T, K>) {
    const schema = this.definitions[key];
    if (!schema) {
      throw new Error(`Metadata key "${key}" is not declared.`);
    }
    const parsed = schema.parse(value);
    this.table.set(key, parsed);
    return parsed;
  }

  delete<K extends keyof T & string>(key: K) {
    if (!this.definitions[key]) {
      throw new Error(`Metadata key "${key}" is not declared.`);
    }
    return this.table.delete(key);
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
  readonly table: MetadataTableRuntime;

  constructor(database: Database) {
    this.database = database;
    this.table = new MetadataTableRuntime(database, INTERNAL_TABLE, {
      manageUpdatedAt: true,
    });
  }

  get(key: string) {
    try {
      return this.table.get(key);
    } catch (error) {
      throw new UnrecoverableStoreOpenError(`Internal metadata key "${key}" is malformed.`, {
        cause: error,
      });
    }
  }

  getNumber(key: string) {
    const value = this.get(key);
    if (value == null) {
      return undefined;
    }
    if (typeof value !== "number") {
      throw new UnrecoverableStoreOpenError(`Internal metadata key "${key}" must be a number.`);
    }
    return value;
  }

  set(key: string, value: unknown) {
    this.table.set(key, value);
  }

  delete(key: string) {
    this.table.delete(key);
  }

  keys() {
    return this.table.keys();
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
      throw new UnrecoverableStoreOpenError(
        `Internal metadata key "${SCHEMA_SNAPSHOT_KEY}" is malformed.`,
      );
    }
    if (snapshot.kindstoreVersion !== KINDSTORE_FORMAT_VERSION) {
      throw new UnrecoverableStoreOpenError(
        `Internal metadata key "${SCHEMA_SNAPSHOT_KEY}" references unsupported store format version "${snapshot.kindstoreVersion}".`,
      );
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
        throw new UnrecoverableStoreOpenError(
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
          throw new UnrecoverableStoreOpenError(
            `Internal metadata key "${SCHEMA_SNAPSHOT_KEY}" has an invalid column entry for "${kindKey}.${field}".`,
          );
        }
      }
      for (const [indexName, index] of Object.entries(kind.indexes)) {
        if (
          !isRecord(index) ||
          index.sqliteName !== indexName ||
          !Array.isArray(index.columns) ||
          (index.unique != null && typeof index.unique !== "boolean") ||
          index.columns.some((column) => typeof column !== "string")
        ) {
          throw new UnrecoverableStoreOpenError(
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
      throw new UnrecoverableStoreOpenError(
        `Internal metadata key "${KIND_VERSIONS_KEY}" is malformed.`,
      );
    }
    for (const [kind, version] of Object.entries(versions as Record<string, unknown>)) {
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        throw new UnrecoverableStoreOpenError(
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
    if (!(value instanceof KindBuilder)) {
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
    const shape = value.schema.shape as Record<string, unknown>;
    validateReservedRowDataFields(value.tag, shape);
    if (value.createdAtField && value.createdAtField === value.updatedAtField) {
      throw new Error(
        `Kind "${value.tag}" cannot use "${value.createdAtField}" for both createdAt and updatedAt.`,
      );
    }
    validateManagedTimestampField(value, shape, value.createdAtField, "createdAt");
    validateManagedTimestampField(value, shape, value.updatedAtField, "updatedAt");
    seenTags.add(value.tag);
    seenTables.add(table);
    definitions.set(key, {
      key,
      table,
      columns: normalizeColumns(value),
      uniqueIndexes: normalizeUniqueIndexes(value),
      createdAtField: value.createdAtField,
      updatedAtField: value.updatedAtField,
      definition: value,
    });
  }
  return definitions;
}

function normalizeColumns<T extends Kind>(definition: KindBuilder<T>) {
  const shape = definition.schema.shape as Record<string, unknown>;
  const columns = new Map<string, IndexColumn>();
  const seenColumns = new Set<string>();
  for (const index of definition.indexes.values()) {
    assertTopLevelField(definition.tag, shape, index.field);
    const column = snakeCase(index.field);
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
      unique: index.unique,
      type: index.type ?? inferSqliteType(shape[index.field], definition.tag, index.field),
    });
  }
  for (const multiIndex of definition.multiIndexes) {
    for (const [field] of multiIndex.fields) {
      if (columns.has(field)) {
        continue;
      }
      if (field === "id") {
        seenColumns.add("id");
        columns.set(field, {
          field,
          column: "id",
          single: false,
          unique: false,
          type: "text",
        });
        continue;
      }
      assertTopLevelField(definition.tag, shape, field);
      const column = snakeCase(field);
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
        unique: false,
        type: inferSqliteType(shape[field], definition.tag, field),
      });
    }
  }
  return columns;
}

function normalizeUniqueIndexes<T extends Kind>(definition: KindBuilder<T>) {
  const shape = definition.schema.shape as Record<string, unknown>;
  const uniqueIndexes: UniqueIndexDefinition[] = [];
  const seenFieldSets = new Set<string>();

  for (const index of definition.indexes.values()) {
    if (!index.unique) {
      continue;
    }
    assertTopLevelField(definition.tag, shape, index.field);
    const fields = [index.field];
    const key = fields.slice().sort().join("\0");
    if (seenFieldSets.has(key)) {
      continue;
    }
    seenFieldSets.add(key);
    uniqueIndexes.push({
      name: index.field,
      fields,
    });
  }

  for (const multiIndex of definition.multiIndexes) {
    if (!multiIndex.unique) {
      continue;
    }
    const fields = multiIndex.fields.map(([field]) => field);
    for (const field of fields) {
      if (field === "id") {
        continue;
      }
      assertTopLevelField(definition.tag, shape, field);
    }
    const key = fields.slice().sort().join("\0");
    if (seenFieldSets.has(key)) {
      continue;
    }
    seenFieldSets.add(key);
    uniqueIndexes.push({
      name: multiIndex.name,
      fields,
    });
  }

  return uniqueIndexes;
}

function normalizeUniqueSelector<T extends Kind>(
  definition: KindRuntimeDefinition<T>,
  selector: KindUniqueSelector<T>,
) {
  const entries = Object.entries(selector as Record<string, unknown>);
  if (!entries.length) {
    throw new Error(`putByUnique() for kind "${definition.key}" requires a non-empty selector.`);
  }
  for (const [field, value] of entries) {
    if (field === "id") {
      throw new Error(
        `putByUnique() for kind "${definition.key}" does not support selector field "id".`,
      );
    }
    if (value == null) {
      throw new Error(
        `putByUnique() selector field "${field}" for kind "${definition.key}" must be non-null.`,
      );
    }
    if (isFilterOperators(value)) {
      throw new Error(
        `putByUnique() selector field "${field}" for kind "${definition.key}" must use exact values, not filter operators.`,
      );
    }
  }
  return entries as Array<readonly [field: string, value: unknown]>;
}

function assertMatchesDeclaredUniqueIndex<T extends Kind>(
  definition: KindRuntimeDefinition<T>,
  selectorEntries: Array<readonly [field: string, value: unknown]>,
) {
  const selectorFields = selectorEntries.map(([field]) => field);
  const match = definition.uniqueIndexes.some((index) => sameFields(index.fields, selectorFields));
  if (match) {
    return;
  }
  throw new Error(
    `putByUnique() selector for kind "${definition.key}" must exactly match one declared unique index.`,
  );
}

function sameFields(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) {
    return false;
  }
  const remaining = new Set(left);
  for (const field of right) {
    if (!remaining.delete(field)) {
      return false;
    }
  }
  return remaining.size === 0;
}

function assertSelectorMatchesValue<T extends Kind>(
  definition: KindRuntimeDefinition<T>,
  selectorEntries: Array<readonly [field: string, value: unknown]>,
  value: KindOutput<T> | Record<string, unknown>,
) {
  for (const [field, expected] of selectorEntries) {
    if (Object.is((value as Record<string, unknown>)[field], expected)) {
      continue;
    }
    throw new Error(
      `putByUnique() value for kind "${definition.key}" must preserve selector field "${field}".`,
    );
  }
}

function assertTopLevelField(tag: string, shape: Record<string, unknown>, field: string) {
  if (!(field in shape)) {
    throw new Error(`Kind "${tag}" references unknown field "${field}".`);
  }
}

function validateReservedRowDataFields(tag: string, shape: Record<string, unknown>) {
  if ("id" in shape) {
    throw new Error(`Kind "${tag}" cannot declare reserved payload field "id".`);
  }
  if ("data" in shape) {
    throw new Error(`Kind "${tag}" cannot declare reserved payload field "data".`);
  }
}

function validateManagedTimestampField<T extends Kind>(
  definition: KindBuilder<T>,
  shape: Record<string, unknown>,
  field: string | undefined,
  name: "createdAt" | "updatedAt",
) {
  if (!field) {
    return;
  }
  assertTopLevelField(definition.tag, shape, field);
  if (inferSqliteType(shape[field], definition.tag, field) !== "integer") {
    throw new Error(`Kind "${definition.tag}" ${name} field "${field}" must be an integer.`);
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
    case "literal": {
      const values = schema._def.values;
      const value = values instanceof Set ? values.values().next().value : values?.[0];
      return typeof value === "number" || typeof value === "boolean" ? "integer" : "text";
    }
    case "number":
      return schema._def.checks?.some((check: any) => check.isInt) ? "integer" : "real";
    default:
      throw new Error(`Kind "${tag}" field "${field}" needs an explicit SQLite type hint.`);
  }
}

function compileWhere<T extends Kind>(
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

function mergeWhereClauses(...clauses: CompiledQuery[]) {
  const parts: string[] = [];
  const values: any[] = [];
  for (const clause of clauses) {
    if (!clause.sql) {
      continue;
    }
    parts.push(clause.sql.replace(/^ WHERE /, ""));
    values.push(...clause.values);
  }
  return {
    sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "",
    values,
  };
}

function resolveOrderBy(
  columns: Map<string, IndexColumn>,
  orderBy: Record<string, IndexDirection | undefined> | undefined,
) {
  if (!orderBy || !Object.keys(orderBy).length) {
    return [];
  }
  return Object.entries(orderBy).map(([field, direction]) => {
    if (!direction) {
      throw new Error(`Order direction for "${field}" is required.`);
    }
    const column = columns.get(field);
    if (!column) {
      throw new Error(`Field "${field}" is not indexed and cannot be ordered.`);
    }
    return { field, direction, column };
  });
}

function tieBreakerDirection(orderBy: ResolvedOrderByEntry[]) {
  return orderBy[orderBy.length - 1]!.direction;
}

function compileOrderBy(orderBy: ResolvedOrderByEntry[], includeIdTieBreaker = false) {
  if (!orderBy.length) {
    return "";
  }
  const parts = orderBy.map(
    ({ column, direction }) => `${quoteIdentifier(column.column)} ${direction.toUpperCase()}`,
  );
  if (includeIdTieBreaker) {
    parts.push(`"id" ${tieBreakerDirection(orderBy).toUpperCase()}`);
  }
  return ` ORDER BY ${parts.join(", ")}`;
}

function compilePageAfter<T extends Kind>(
  definition: KindRuntimeDefinition<T>,
  orderBy: ResolvedOrderByEntry[],
  after: KindPageCursor<T> | undefined,
) {
  if (!after) {
    return { sql: "", values: [] };
  }
  const cursor = decodePageCursor(after);
  if (cursor.version !== PAGE_CURSOR_VERSION) {
    throw new Error(`Unsupported findPage() cursor version "${cursor.version}".`);
  }
  if (cursor.tag !== definition.definition.tag) {
    throw new Error(`findPage() cursor does not belong to kind "${definition.key}".`);
  }
  if (cursor.order.length !== orderBy.length) {
    throw new Error(
      `findPage() cursor does not match the requested orderBy for kind "${definition.key}".`,
    );
  }
  for (const [index, [field, direction]] of cursor.order.entries()) {
    const expected = orderBy[index]!;
    if (field !== expected.field || direction !== expected.direction) {
      throw new Error(
        `findPage() cursor does not match the requested orderBy for kind "${definition.key}".`,
      );
    }
  }
  if (cursor.values.length !== orderBy.length) {
    throw new Error(`findPage() cursor is malformed for kind "${definition.key}".`);
  }
  const disjuncts: string[] = [];
  const values: unknown[] = [];
  for (let pivot = 0; pivot < orderBy.length; pivot += 1) {
    const parts: string[] = [];
    for (let index = 0; index < pivot; index += 1) {
      const value = cursor.values[index];
      if (value == null) {
        throw new Error(
          `findPage() cursor cannot continue on nullish ordered field "${orderBy[index]!.field}".`,
        );
      }
      parts.push(`${quoteIdentifier(orderBy[index]!.column.column)} = ?`);
      values.push(value);
    }
    const pivotValue = cursor.values[pivot];
    if (pivotValue == null) {
      throw new Error(
        `findPage() cursor cannot continue on nullish ordered field "${orderBy[pivot]!.field}".`,
      );
    }
    parts.push(
      `${quoteIdentifier(orderBy[pivot]!.column.column)} ${orderBy[pivot]!.direction === "asc" ? ">" : "<"} ?`,
    );
    values.push(pivotValue);
    disjuncts.push(`(${parts.join(" AND ")})`);
  }
  const tieBreakerParts = orderBy.map(({ column }, index) => {
    const value = cursor.values[index];
    if (value == null) {
      throw new Error(
        `findPage() cursor cannot continue on nullish ordered field "${orderBy[index]!.field}".`,
      );
    }
    values.push(value);
    return `${quoteIdentifier(column.column)} = ?`;
  });
  values.push(cursor.id);
  tieBreakerParts.push(`"id" ${tieBreakerDirection(orderBy) === "asc" ? ">" : "<"} ?`);
  disjuncts.push(`(${tieBreakerParts.join(" AND ")})`);
  return {
    sql: ` WHERE (${disjuncts.join(" OR ")})`,
    values,
  };
}

function encodePageCursor<T extends Kind>(
  definition: KindRuntimeDefinition<T>,
  orderBy: ResolvedOrderByEntry[],
  row: StoredRow,
  value: KindOutput<T>,
) {
  const values = orderBy.map(({ field }) => {
    const fieldValue = (value as Record<string, unknown>)[field];
    if (fieldValue == null) {
      throw new Error(`findPage() cannot paginate on nullish ordered field "${field}".`);
    }
    return fieldValue;
  });
  return Buffer.from(
    JSON.stringify({
      version: PAGE_CURSOR_VERSION,
      tag: definition.definition.tag,
      order: orderBy.map(({ field, direction }) => [field, direction] as const),
      values,
      id: row.id,
    } satisfies PageCursorData),
  ).toString("base64url") as KindPageCursor<T>;
}

function decodePageCursor(cursor: string): PageCursorData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("findPage() cursor is malformed.");
  }
  if (!isRecord(parsed)) {
    throw new Error("findPage() cursor is malformed.");
  }
  const { version, tag, order, values, id } = parsed;
  if (
    version !== PAGE_CURSOR_VERSION ||
    typeof tag !== "string" ||
    !Array.isArray(order) ||
    !Array.isArray(values) ||
    typeof id !== "string"
  ) {
    throw new Error("findPage() cursor is malformed.");
  }
  for (const entry of order) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      (entry[1] !== "asc" && entry[1] !== "desc")
    ) {
      throw new Error("findPage() cursor is malformed.");
    }
  }
  return {
    version,
    tag,
    order: order as PageCursorData["order"],
    values,
    id,
  };
}

function snapshotKind<T extends Kind>(definition: KindRuntimeDefinition<T>): SnapshotKind {
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

function snapshotIndexes<T extends Kind>(definition: KindRuntimeDefinition<T>) {
  const indexes: Record<string, SnapshotIndex> = {};
  for (const column of definition.columns.values()) {
    if (!column.single) {
      continue;
    }
    const sqliteName = indexName(definition.table, column.column);
    indexes[sqliteName] = {
      sqliteName,
      columns: [quoteIdentifier(column.column)],
      unique: column.unique,
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
      unique: multiIndex.unique,
    };
  }
  return indexes;
}

function applyManagedTimestamps<T extends Kind>(
  definition: KindRuntimeDefinition<T>,
  value: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
  now: number,
  mode: WriteMode,
) {
  const next = { ...value };
  if (definition.createdAtField) {
    if (current && Object.hasOwn(current, definition.createdAtField)) {
      next[definition.createdAtField] = current[definition.createdAtField];
    } else if (mode === "create") {
      next[definition.createdAtField] = now;
    } else {
      delete next[definition.createdAtField];
    }
  }
  if (definition.updatedAtField) {
    next[definition.updatedAtField] = now;
  }
  return definition.definition.schema.parse(next);
}
