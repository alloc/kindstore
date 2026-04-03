import type { DatabaseOptions } from "bun:sqlite";
import type { z } from "zod";

import type { KindBuilder } from "./kind";

export type SqliteTypeHint = "text" | "integer" | "real" | "numeric";

export type IndexDirection = "asc" | "desc";

export type TaggedId<Tag extends string> = `${Tag}_${string}` & {
  readonly __kindstoreTag?: Tag;
};

export type KindDefinition = {
  tag: string;
  schema: z.ZodObject<any>;
  indexed: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type KindPayloadValue<T extends KindDefinition> = z.output<T["schema"]>;

type KindManagedTimestampField<T extends KindDefinition> = Extract<
  T["createdAt"] | T["updatedAt"],
  keyof KindPayloadValue<T> & string
>;

export type KindValue<T extends KindDefinition> = {
  id: KindId<T>;
} & Omit<KindPayloadValue<T>, "id">;

export type KindInputValue<T extends KindDefinition> = Omit<
  KindPayloadValue<T>,
  KindManagedTimestampField<T> | "id"
> &
  Partial<Pick<KindPayloadValue<T>, KindManagedTimestampField<T>>>;

export type KindId<T extends KindDefinition> = TaggedId<T["tag"]>;

export type KindIndexedField<T extends KindDefinition> = Extract<
  T["indexed"],
  keyof KindPayloadValue<T> & string
>;

export type FilterOperators<T> = {
  in?: readonly Exclude<T, undefined>[];
  gt?: Exclude<T, undefined>;
  gte?: Exclude<T, undefined>;
  lt?: Exclude<T, undefined>;
  lte?: Exclude<T, undefined>;
};

export type WhereOperand<T> = Exclude<T, undefined> | null | FilterOperators<T>;

export type KindWhere<T extends KindDefinition> = Partial<{
  [K in KindIndexedField<T>]: WhereOperand<KindPayloadValue<T>[K]>;
}>;

export type KindOrderBy<T extends KindDefinition> = Partial<
  Record<KindIndexedField<T>, IndexDirection>
>;

export type FindManyOptions<T extends KindDefinition> = {
  where?: KindWhere<T>;
  orderBy?: KindOrderBy<T>;
  limit?: number;
};

export type KindPageCursor<T extends KindDefinition> = string & {
  readonly __kindstorePageCursor?: T["tag"];
};

export type FindPageOptions<T extends KindDefinition> = {
  where?: KindWhere<T>;
  orderBy: KindOrderBy<T>;
  limit: number;
  after?: KindPageCursor<T>;
};

export type FindPageResult<T extends KindDefinition> = {
  items: KindValue<T>[];
  next?: KindPageCursor<T>;
};

export type PatchValue<T> = T extends object ? Partial<T> : never;

export type KindMigrationContext = {
  readonly now: number;
};

export type KindMigration<T extends object> = (
  value: Partial<T> & Record<string, unknown>,
  context: KindMigrationContext,
) => T | Record<string, unknown>;

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
