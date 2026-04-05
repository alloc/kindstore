import type { DatabaseOptions } from "bun:sqlite";
import type { z } from "zod";

import type { KindBuilder } from "./kind";

/** Same as built-in Omit but can be erased for more readable type output. */
export type Omit<T, K extends PropertyKey> = {} & {
  [P in Exclude<keyof T, K>]: T[P];
};

export type SqliteTypeHint = "text" | "integer" | "real" | "numeric";

export type IndexDirection = "asc" | "desc";

export type TaggedId<Tag extends string> = `${Tag}_${string}` & {
  readonly __kindstoreTag?: Tag;
};

export type Kind = {
  tag: string;
  schema: z.ZodObject<any>;
  indexed: string;
  version: number;
  createdAtField: string;
  updatedAtField: string;
};

type KindLike = Kind | KindBuilder<any>;

type InferKindDefinition<T extends KindLike> = T extends KindBuilder<infer B extends Kind> ? B : T;

export type KindPropertyKey<T extends KindLike> = keyof z.input<InferKindDefinition<T>["schema"]> &
  string;

type KindIndexedKey<T extends KindLike> = KindPropertyKey<T> | "id";

export type KindManagedCreatedAt<T extends KindLike> = Extract<
  InferKindDefinition<T>["createdAtField"],
  KindPropertyKey<T>
>;

export type KindManagedUpdatedAt<T extends KindLike> = Extract<
  InferKindDefinition<T>["updatedAtField"],
  KindPropertyKey<T>
>;

type KindManagedTimestampField<T extends KindLike> =
  | KindManagedCreatedAt<T>
  | KindManagedUpdatedAt<T>;

export type KindOutput<T extends KindLike> = {
  id: KindId<T>;
} & Omit<z.output<InferKindDefinition<T>["schema"]>, "id">;

export type KindInput<T extends KindLike> = Omit<
  z.input<InferKindDefinition<T>["schema"]>,
  KindManagedTimestampField<T> | "id" | "data"
> &
  Partial<Pick<z.input<InferKindDefinition<T>["schema"]>, KindManagedTimestampField<T>>>;

export type KindId<T extends KindLike> = TaggedId<InferKindDefinition<T>["tag"]>;

export type KindIndexedField<T extends KindLike> = Extract<
  InferKindDefinition<T>["indexed"],
  KindIndexedKey<T>
>;

type KindFieldValue<T extends KindLike, K extends KindIndexedField<T>> = K extends "id"
  ? KindId<T>
  : z.output<InferKindDefinition<T>["schema"]>[K];

export type FilterOperators<T> = {
  in?: readonly Exclude<T, undefined>[];
  gt?: Exclude<T, undefined>;
  gte?: Exclude<T, undefined>;
  lt?: Exclude<T, undefined>;
  lte?: Exclude<T, undefined>;
};

export type WhereOperand<T> = Exclude<T, undefined> | null | FilterOperators<T>;

export type KindWhere<T extends KindLike> = Partial<{
  [K in KindIndexedField<T>]: WhereOperand<KindFieldValue<T, K>>;
}>;

export type KindOrderBy<T extends KindLike> = Partial<Record<KindIndexedField<T>, IndexDirection>>;

export type FindManyOptions<T extends KindLike> = {
  where?: KindWhere<T>;
  orderBy?: KindOrderBy<T>;
  limit?: number;
};

export type KindPageCursor<T extends KindLike> = string & {
  readonly __kindstorePageCursor?: InferKindDefinition<T>["tag"];
};

export type FindPageOptions<T extends KindLike> = {
  where?: KindWhere<T>;
  orderBy: KindOrderBy<T>;
  limit: number;
  after?: KindPageCursor<T>;
};

export type FindPageResult<T extends KindLike> = {
  items: KindOutput<T>[];
  next?: KindPageCursor<T>;
};

export type PatchValue<T> = T extends object ? Partial<T> : never;

export type KindMigrationContext = {
  readonly now: number;
};

export type KindMigration<T extends Kind> = (
  value: Partial<z.output<T["schema"]>> & Record<string, unknown>,
  context: KindMigrationContext,
) => z.output<T["schema"]> | Record<string, unknown>;

export type MetadataDefinitionMap = Record<string, z.ZodTypeAny>;

export interface SchemaMigrationPlanner {
  rename(previousKindKey: string, nextKindKey: string): this;
  drop(previousKindKey: string): this;
  retag(kindKey: string, previousTag: string): this;
}

export type SchemaDefinition = {
  migrate(planner: SchemaMigrationPlanner): void;
};

export type { DatabaseOptions };

export type MetadataValue<T extends MetadataDefinitionMap, K extends keyof T & string> = z.output<
  T[K]
>;

export type KindRegistry = Record<string, KindBuilder<any>>;
