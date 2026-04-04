import { z } from "zod";

import type {
  IndexDirection,
  KindDefinition,
  KindManagedCreatedAt,
  KindManagedUpdatedAt,
  KindMigration,
  KindPropertyKey,
  Omit,
  SqliteTypeHint,
} from "./types";

type MultiIndexFields<T extends KindDefinition> = {
  [K in KindPropertyKey<T>]?: IndexDirection;
};

type ExactFieldKeys<TValue, TAllowed extends PropertyKey> = TValue &
  Record<Exclude<keyof TValue, TAllowed>, never>;

type IndexDefinition = {
  field: string;
  type?: SqliteTypeHint;
  single: boolean;
};

type MultiIndexDefinition = {
  name: string;
  fields: readonly [string, IndexDirection][];
};

type ExtendSchema<TSchema extends z.ZodObject<any>, TKey extends string> =
  TSchema extends z.ZodObject<infer TShape, infer TConfig>
    ? z.ZodObject<Omit<TShape, TKey> & Record<TKey, z.ZodNumber>, TConfig>
    : never;

type ExtendKindSchema<T extends KindDefinition, TKey extends string> = Omit<T, "schema"> & {
  schema: TKey extends KindPropertyKey<T> ? T["schema"] : ExtendSchema<T["schema"], TKey>;
};

type SetManagedCreatedAt<T extends KindDefinition, TKey extends string> = Omit<
  ExtendKindSchema<T, TKey>,
  "createdAtField"
> & {
  createdAtField: TKey;
};

type SetManagedUpdatedAt<T extends KindDefinition, TKey extends string> = Omit<
  ExtendKindSchema<T, TKey>,
  "updatedAtField"
> & {
  updatedAtField: TKey;
};

export class KindBuilder<T extends KindDefinition> {
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

  index<TKey extends KindPropertyKey<T>>(field: TKey, options: { type?: SqliteTypeHint } = {}) {
    const current = this.indexes.get(field);
    this.indexes.set(field, {
      field,
      single: true,
      type: options.type ?? current?.type,
    });
    return this as unknown as KindBuilder<Omit<T, "indexed"> & { indexed: T["indexed"] | TKey }>;
  }

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

  multi<
    const TName extends string,
    const TFields extends MultiIndexFields<T>,
  >(name: TName, fields: ExactFieldKeys<TFields, KindPropertyKey<T>>) {
    const entries = Object.entries(fields) as [string, IndexDirection][];
    if (!entries.length) {
      throw new Error(`Multi-index "${name}" must include at least one field.`);
    }
    this.multiIndexes.push({
      name,
      fields: entries,
    });
    return this as unknown as KindBuilder<
      Omit<T, "indexed"> & { indexed: T["indexed"] | (keyof TFields & string) }
    >;
  }

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
