import { z } from "zod";

import type {
  IndexDirection,
  Kind,
  KindManagedCreatedAt,
  KindManagedUpdatedAt,
  KindMigration,
  KindPropertyKey,
  Omit,
  SqliteTypeHint,
} from "./types";

type MultiIndexFields<T extends Kind> = {
  [K in KindPropertyKey<T> | "id"]?: IndexDirection;
};

type ExactFieldKeys<TValue, TAllowed extends PropertyKey> = TValue &
  Record<Exclude<keyof TValue, TAllowed>, never>;

type IndexDefinition = {
  field: string;
  type?: SqliteTypeHint;
  single: boolean;
  unique: boolean;
};

type MultiIndexDefinition = {
  name: string;
  fields: readonly [string, IndexDirection][];
  unique: boolean;
};

type ExtendSchema<TSchema extends z.ZodObject<any>, TKey extends string> =
  TSchema extends z.ZodObject<infer TShape, infer TConfig>
    ? z.ZodObject<Omit<TShape, TKey> & Record<TKey, z.ZodNumber>, TConfig>
    : never;

type ExtendKindSchema<T extends Kind, TKey extends string> = Omit<T, "schema"> & {
  schema: TKey extends KindPropertyKey<T> ? T["schema"] : ExtendSchema<T["schema"], TKey>;
};

type SetManagedCreatedAt<T extends Kind, TKey extends string> = Omit<
  ExtendKindSchema<T, TKey>,
  "createdAtField"
> & {
  createdAtField: TKey;
};

type SetManagedUpdatedAt<T extends Kind, TKey extends string> = Omit<
  ExtendKindSchema<T, TKey>,
  "updatedAtField"
> & {
  updatedAtField: TKey;
};

/**
 * Fluent builder for one kind declaration.
 *
 * @remarks
 * The builder records schema, index, and migration intent. kindstore does not
 * materialize storage until you pass the builder to `kindstore(...)`.
 */
export class KindBuilder<T extends Kind> {
  readonly tag: T["tag"];
  schema: T["schema"];
  version: T["version"];
  createdAtField?: KindManagedCreatedAt<T>;
  updatedAtField?: KindManagedUpdatedAt<T>;
  readonly indexes = new Map<string, IndexDefinition>();
  readonly multiIndexes: MultiIndexDefinition[] = [];
  migrations?: Record<number, KindMigration<T>>;

  constructor(tag: T["tag"], schema: T["schema"], version: T["version"]) {
    this.tag = tag;
    this.schema = schema;
    this.version = version;
  }

  /**
   * Declares a top-level payload field as queryable through kindstore's typed
   * filtering and ordering APIs.
   *
   * @remarks
   * Pass `options.type` only when SQLite type inference from the Zod field is
   * not the affinity you want. Pass `options.unique` when SQLite should reject
   * duplicate values for that field.
   */
  index<TKey extends KindPropertyKey<T>>(
    field: TKey,
    options: { type?: SqliteTypeHint; unique?: boolean } = {},
  ) {
    const current = this.indexes.get(field);
    this.indexes.set(field, {
      field,
      single: true,
      type: options.type ?? current?.type,
      unique: options.unique ?? current?.unique ?? false,
    });
    return this as unknown as KindBuilder<Omit<T, "indexed"> & { indexed: T["indexed"] | TKey }>;
  }

  /**
   * Lets kindstore assign a payload creation timestamp for this kind.
   *
   * @remarks
   * If the field does not already exist in the schema, kindstore adds it as an
   * integer timestamp field.
   */
  createdAt<const TKey extends string = "createdAt">(field?: TKey) {
    const resolvedField = (field ?? "createdAt") as TKey;
    const shape = this.schema.shape as Record<string, unknown>;
    if (!(resolvedField in shape)) {
      this.schema = this.schema.extend({
        [resolvedField]: z.number().int(),
      } as Record<TKey, z.ZodNumber>) as T["schema"];
    }
    if (resolvedField === this.updatedAtField) {
      throw new Error(
        `Kind "${this.tag}" cannot use "${resolvedField}" for both createdAt and updatedAt.`,
      );
    }
    this.createdAtField = resolvedField as KindManagedCreatedAt<T>;
    return this as unknown as KindBuilder<SetManagedCreatedAt<T, TKey>>;
  }

  /**
   * Lets kindstore assign a payload modification timestamp for this kind.
   *
   * @remarks
   * If the field does not already exist in the schema, kindstore adds it as an
   * integer timestamp field.
   */
  updatedAt<const TKey extends string = "updatedAt">(field?: TKey) {
    const resolvedField = (field ?? "updatedAt") as TKey;
    const shape = this.schema.shape as Record<string, unknown>;
    if (!(resolvedField in shape)) {
      this.schema = this.schema.extend({
        [resolvedField]: z.number().int(),
      } as Record<TKey, z.ZodNumber>) as T["schema"];
    }
    if (resolvedField === this.createdAtField) {
      throw new Error(
        `Kind "${this.tag}" cannot use "${resolvedField}" for both createdAt and updatedAt.`,
      );
    }
    this.updatedAtField = resolvedField as KindManagedUpdatedAt<T>;
    return this as unknown as KindBuilder<SetManagedUpdatedAt<T, TKey>>;
  }

  /**
   * Declares a composite index over top-level payload fields and, optionally,
   * the store-owned `id`.
   *
   * @remarks
   * Pass `options.unique` when the field set should identify at most one row.
   */
  multi<const TName extends string, const TFields extends MultiIndexFields<T>>(
    name: TName,
    fields: ExactFieldKeys<TFields, KindPropertyKey<T> | "id">,
    options: { unique?: boolean } = {},
  ) {
    const entries = Object.entries(fields) as [string, IndexDirection][];
    if (!entries.length) {
      throw new Error(`Multi-index "${name}" must include at least one field.`);
    }
    this.multiIndexes.push({
      name,
      fields: entries,
      unique: options.unique ?? false,
    });
    return this as unknown as KindBuilder<
      Omit<T, "indexed"> & { indexed: T["indexed"] | (keyof TFields & string) }
    >;
  }

  /**
   * Declares the current payload version for this kind and the eager upgrade
   * steps from older versions.
   */
  migrate<const TVersion extends number>(
    version: TVersion,
    steps: Record<number, KindMigration<T>>,
  ) {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`Kind "${this.tag}" version must be a positive integer.`);
    }
    this.version = version as T["version"];
    this.migrations = steps;
    return this as unknown as KindBuilder<Omit<T, "version"> & { version: TVersion }>;
  }
}

/**
 * Starts a kind declaration for one document category.
 *
 * @remarks
 * The `tag` becomes part of persisted document IDs, so changing it later
 * requires a structural migration.
 *
 * @example
 * ```ts
 * const Tasks = kind("tsk", Task).index("status");
 * ```
 */
export function kind<const TTag extends string, const TSchema extends z.ZodObject<any>>(
  tag: TTag,
  schema: TSchema,
) {
  return new KindBuilder<{
    tag: TTag;
    schema: TSchema;
    indexed: never;
    version: 1;
    createdAtField: never;
    updatedAtField: never;
  }>(tag, schema, 1);
}
