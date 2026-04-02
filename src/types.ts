import type { Database } from "bun:sqlite";
import type { z } from "zod";

import type { KindDefinition } from "./kind";

export type SqliteTypeHint = "text" | "integer" | "real" | "numeric";

export type IndexDirection = "asc" | "desc";

export type TaggedId<Tag extends string> = `${Tag}_${string}` & {
  readonly __kindstoreTag?: Tag;
};

export type KindDefinitionBag = {
  tag: string;
  schema: z.ZodObject<any>;
  indexed: string;
  version: number;
};

export type KindValue<T extends KindDefinitionBag> = z.output<T["schema"]>;

export type KindId<T extends KindDefinitionBag> = TaggedId<T["tag"]>;

export type KindIndexedField<T extends KindDefinitionBag> = Extract<
  T["indexed"],
  keyof KindValue<T> & string
>;

export type FilterOperators<T> = {
  in?: readonly Exclude<T, undefined>[];
  gt?: Exclude<T, undefined>;
  gte?: Exclude<T, undefined>;
  lt?: Exclude<T, undefined>;
  lte?: Exclude<T, undefined>;
};

export type WhereOperand<T> =
  | Exclude<T, undefined>
  | null
  | FilterOperators<T>;

export type KindWhere<T extends KindDefinitionBag> = Partial<{
  [K in KindIndexedField<T>]: WhereOperand<KindValue<T>[K]>;
}>;

export type KindOrderBy<T extends KindDefinitionBag> = Partial<
  Record<KindIndexedField<T>, IndexDirection>
>;

export type FindManyOptions<T extends KindDefinitionBag> = {
  where?: KindWhere<T>;
  orderBy?: KindOrderBy<T>;
  limit?: number;
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

export type MetadataValue<
  T extends MetadataDefinitionMap,
  K extends keyof T & string,
> = z.output<T[K]>;

export type KindRegistry = Record<string, KindDefinition<any>>;

export type ConnectionConfig = {
  filename: string;
  options?: ConstructorParameters<typeof Database>[1];
};
