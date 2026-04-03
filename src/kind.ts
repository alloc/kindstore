import { z } from "zod";

import type {
  IndexDirection,
  KindDefinition,
  KindMigration,
  KindPropertyKey,
  SqliteTypeHint,
} from "./types";

type MultiIndexFields<T extends KindDefinition> = {
  [K in KindPropertyKey<T>]?: IndexDirection;
};

type DefaultManagedTimestampField<
  T extends KindDefinition,
  TName extends "createdAt" | "updatedAt",
> = Extract<TName, KindPropertyKey<T>>;

type IndexDefinition = {
  field: string;
  type?: SqliteTypeHint;
  single: boolean;
};

type MultiIndexDefinition = {
  name: string;
  fields: readonly [string, IndexDirection][];
};

export class KindBuilder<T extends KindDefinition> {
  readonly tag: T["tag"];
  readonly schema: T["schema"];
  version: T["version"];
  createdAtField?: T["createdAt"];
  updatedAtField?: T["updatedAt"];
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

  createdAt<TKey extends KindPropertyKey<T> = DefaultManagedTimestampField<T, "createdAt">>(
    ...args: DefaultManagedTimestampField<T, "createdAt"> extends never
      ? [field: KindPropertyKey<T>]
      : [field?: TKey]
  ) {
    const field = (args[0] ?? "createdAt") as TKey;
    if (field === this.updatedAtField) {
      throw new Error(`Kind "${this.tag}" cannot use "${field}" for both createdAt and updatedAt.`);
    }
    this.createdAtField = field as T["createdAt"];
    return this as unknown as KindBuilder<Omit<T, "createdAt"> & { createdAt: TKey }>;
  }

  updatedAt<TKey extends KindPropertyKey<T> = DefaultManagedTimestampField<T, "updatedAt">>(
    ...args: DefaultManagedTimestampField<T, "updatedAt"> extends never
      ? [field: KindPropertyKey<T>]
      : [field?: TKey]
  ) {
    const field = (args[0] ?? "updatedAt") as TKey;
    if (field === this.createdAtField) {
      throw new Error(`Kind "${this.tag}" cannot use "${field}" for both createdAt and updatedAt.`);
    }
    this.updatedAtField = field as T["updatedAt"];
    return this as unknown as KindBuilder<Omit<T, "updatedAt"> & { updatedAt: TKey }>;
  }

  multi<
    const TName extends string,
    const TFields extends MultiIndexFields<T> & Record<string, IndexDirection>,
  >(name: TName, fields: TFields) {
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
    createdAt: never;
    updatedAt: never;
    version: 1;
  }>(tag, schema, 1);
}
