import type { DatabaseOptions } from "bun:sqlite";
import type { z } from "zod";

import type { KindBuilder } from "./kind";

/** Same as built-in Omit but can be erased for more readable type output. */
export type Omit<T, K extends PropertyKey> = {} & {
  [P in Exclude<keyof T, K>]: T[P];
};

/** Helper type for erasing intersection types in type output. */
export type Simplify<T extends object> = {} & {
  [K in keyof T]: T[K];
};

/** SQLite affinity hint for a derived query column created from an indexed field. */
export type SqliteTypeHint = "text" | "integer" | "real" | "numeric";

/** Sort direction used by typed ordering and composite index definitions. */
export type IndexDirection = "asc" | "desc";

/** Tagged document ID whose prefix identifies the owning kind. */
export type TaggedId<Tag extends string> = `${Tag}_${string}` & {
  readonly __kindstoreTag?: Tag;
};

/** Structural description of a declared kind used by the public type helpers. */
export type Kind = {
  tag: string;
  schema: z.ZodObject<any>;
  indexed: string;
  version: number;
  createdAtField: string;
  updatedAtField: string;
};

type KindLike = Kind | KindBuilder<any>;

type InferKind<T extends KindLike> = T extends KindBuilder<infer B extends Kind> ? B : T;

/** Top-level payload field names available on a kind schema. */
export type KindPropertyKey<T extends KindLike> = keyof z.input<InferKind<T>["schema"]> & string;

type KindIndexedKey<T extends KindLike> = KindPropertyKey<T> | "id";

/** Payload field automatically managed by `.createdAt()`. */
export type KindManagedCreatedAt<T extends KindLike> = Extract<
  InferKind<T>["createdAtField"],
  KindPropertyKey<T>
>;

/** Payload field automatically managed by `.updatedAt()`. */
export type KindManagedUpdatedAt<T extends KindLike> = Extract<
  InferKind<T>["updatedAtField"],
  KindPropertyKey<T>
>;

type KindManagedTimestampField<T extends KindLike> =
  | KindManagedCreatedAt<T>
  | KindManagedUpdatedAt<T>;

/** Validated document shape returned from collection reads, including the store-owned `id`. */
export type KindOutput<T extends KindLike> = Simplify<
  { id: KindId<T> } & Omit<z.output<InferKind<T>["schema"]>, "id">
>;

/** Payload shape accepted by `create`, `put`, and `update`. */
export type KindInput<T extends KindLike> = Simplify<
  Omit<z.input<InferKind<T>["schema"]>, KindManagedTimestampField<T> | "id" | "data"> &
    Partial<Pick<z.input<InferKind<T>["schema"]>, KindManagedTimestampField<T>>>
>;

/** Tagged document ID type for a specific kind. */
export type KindId<T extends KindLike> = InferKind<T>["tag"] extends infer Tag extends string
  ? TaggedId<Tag>
  : never;

/** Fields eligible for typed filtering and ordering. */
export type KindIndexedField<T extends KindLike> = Extract<
  InferKind<T>["indexed"],
  KindIndexedKey<T>
>;

type KindFieldValue<T extends KindLike, K extends KindIndexedField<T>> = K extends "id"
  ? KindId<T>
  : z.output<InferKind<T>["schema"]>[K];

type KindUniqueField<T extends KindLike> = Exclude<KindIndexedField<T>, "id">;

type KindUniqueFieldValue<T extends KindLike, K extends KindUniqueField<T>> = Exclude<
  KindFieldValue<T, K>,
  undefined | null
>;

/** Comparison operators supported in typed `where` clauses. */
export type FilterOperators<T> = {
  in?: readonly Exclude<T, undefined>[];
  gt?: Exclude<T, undefined>;
  gte?: Exclude<T, undefined>;
  lt?: Exclude<T, undefined>;
  lte?: Exclude<T, undefined>;
};

/** Accepted value shape for one typed filter field. */
export type WhereOperand<T> = Exclude<T, undefined> | null | FilterOperators<T>;

/** Typed filter object constrained to indexed fields for a kind. */
export type KindWhere<T extends KindLike> = Partial<{
  [K in KindIndexedField<T>]: WhereOperand<KindFieldValue<T, K>>;
}>;

/** Exact-match selector shape accepted by `putByUnique`. */
export type KindUniqueSelector<T extends KindLike> = Partial<{
  [K in KindUniqueField<T>]: KindUniqueFieldValue<T, K>;
}>;

/** Typed ordering object constrained to indexed fields for a kind. */
export type KindOrderBy<T extends KindLike> = Partial<Record<KindIndexedField<T>, IndexDirection>>;

/** Shared query options used by `first`, `findMany`, and `iterate`. */
export type FindManyOptions<T extends KindLike> = {
  where?: KindWhere<T>;
  orderBy?: KindOrderBy<T>;
  limit?: number;
};

/** Opaque cursor returned from `findPage` for one kind and order definition. */
export type KindPageCursor<T extends KindLike> = string & {
  readonly __kindstorePageCursor?: InferKind<T>["tag"];
};

/** Options for forward keyset pagination. */
export type FindPageOptions<T extends KindLike> = {
  where?: KindWhere<T>;
  orderBy: KindOrderBy<T>;
  limit: number;
  after?: KindPageCursor<T>;
};

/** Result returned from `findPage`. */
export type FindPageResult<T extends KindLike> = {
  items: KindOutput<T>[];
  next?: KindPageCursor<T>;
};

/** Shallow patch object accepted by `update` when using patch syntax. */
export type PatchValue<T> = T extends object ? Partial<T> : never;

/** Context passed to one payload migration step. */
export type KindMigrationContext = {
  /** Store-managed timestamp captured for the current migration run. */
  readonly now: number;
};

/** One eager payload migration step from version `N` to version `N + 1`. */
export type KindMigration<T extends Kind> = (
  value: Partial<z.output<T["schema"]>> & Record<string, unknown>,
  context: KindMigrationContext,
) => z.output<T["schema"]> | Record<string, unknown>;

/** Zod schema map for store-level application metadata. */
export type MetadataDefinitionMap = Record<string, z.ZodTypeAny>;

/** Planner used by top-level structural migrations. */
export interface SchemaMigrationPlanner {
  /** Declares that a current kind continues a previous kind under a new key. */
  rename(previousKindKey: string, nextKindKey: string): this;
  /** Declares that a previous kind should be removed. */
  drop(previousKindKey: string): this;
  /** Declares the previous tag for a current kind whose IDs changed prefix. */
  retag(kindKey: string, previousTag: string): this;
}

/** Store-level structural migration declaration executed during open. */
export type SchemaDefinition = {
  /** Populates the structural migration plan for this store open. */
  migrate(planner: SchemaMigrationPlanner): void;
};

export type { DatabaseOptions };

/** Resolved output type for one metadata key. */
export type MetadataValue<T extends MetadataDefinitionMap, K extends keyof T & string> = z.output<
  T[K]
>;

/** Map of collection keys to declared kind builders. */
export type KindRegistry = Record<string, KindBuilder<any>>;
