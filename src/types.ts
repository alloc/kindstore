import type { DatabaseOptions } from "bun:sqlite";
import type { z } from "zod";

import type { KindBuilder } from "./kind";

/** Same as built-in Omit but can be erased for more readable type output. */
export type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>> & {};

export type SqliteTypeHint = "text" | "integer" | "real" | "numeric";

export type IndexDirection = "asc" | "desc";

export type TaggedId<Tag extends string> = `${Tag}_${string}` & {
  readonly __kindstoreTag?: Tag;
};

export type KindDefinition = {
  tag: string;
  schema: z.ZodObject<any>;
  indexed: string;
  version: number;
  createdAtField: string;
  updatedAtField: string;
};

type KindLike = KindDefinition | KindBuilder<any>;

type ResolveKindDefinition<T extends KindLike> = T extends KindBuilder<infer B extends KindDefinition>
  ? B
  : T;

export type KindPropertyKey<T extends KindLike> =
  keyof z.input<ResolveKindDefinition<T>["schema"]> & string;

export type KindManagedCreatedAt<T extends KindLike> = Extract<
  ResolveKindDefinition<T>["createdAtField"],
  KindPropertyKey<T>
>;

export type KindManagedUpdatedAt<T extends KindLike> = Extract<
  ResolveKindDefinition<T>["updatedAtField"],
  KindPropertyKey<T>
>;

type KindManagedTimestampField<T extends KindLike> =
  | KindManagedCreatedAt<T>
  | KindManagedUpdatedAt<T>;

export type KindOutput<T extends KindLike> = {
  id: KindId<T>;
} & Omit<z.output<ResolveKindDefinition<T>["schema"]>, "id">;

export type KindInput<T extends KindLike> = Omit<
  z.input<ResolveKindDefinition<T>["schema"]>,
  KindManagedTimestampField<T> | "id" | "data"
> &
  Partial<Pick<z.input<ResolveKindDefinition<T>["schema"]>, KindManagedTimestampField<T>>>;

export type KindId<T extends KindLike> = TaggedId<ResolveKindDefinition<T>["tag"]>;

export type KindIndexedField<T extends KindLike> = Extract<
  ResolveKindDefinition<T>["indexed"],
  KindPropertyKey<T>
>;

export type FilterOperators<T> = {
  in?: readonly Exclude<T, undefined>[];
  gt?: Exclude<T, undefined>;
  gte?: Exclude<T, undefined>;
  lt?: Exclude<T, undefined>;
  lte?: Exclude<T, undefined>;
};

export type WhereOperand<T> = Exclude<T, undefined> | null | FilterOperators<T>;

export type KindWhere<T extends KindLike> = Partial<{
  [K in KindIndexedField<T>]: WhereOperand<z.output<ResolveKindDefinition<T>["schema"]>[K]>;
}>;

export type KindOrderBy<T extends KindLike> = Partial<Record<KindIndexedField<T>, IndexDirection>>;

export type FindManyOptions<T extends KindLike> = {
  where?: KindWhere<T>;
  orderBy?: KindOrderBy<T>;
  limit?: number;
};

export type KindPageCursor<T extends KindLike> = string & {
  readonly __kindstorePageCursor?: ResolveKindDefinition<T>["tag"];
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

export type KindMigration<T extends KindDefinition> = (
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
