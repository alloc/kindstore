import type { z } from "zod";

import type { KindBuilder } from "./kind";
import { createStore } from "./runtime";
import type { Kindstore } from "./runtime";
import type {
  DatabaseOptions,
  KindRegistry,
  MetadataDefinitionMap,
  SchemaDefinition,
} from "./types";

type AnyStoreInput<
  TKinds extends KindRegistry = KindRegistry,
  TMetadata extends MetadataDefinitionMap = MetadataDefinitionMap,
> = {
  filename: string;
  databaseOptions?: DatabaseOptions;
  metadata?: TMetadata;
  migrate?: SchemaDefinition["migrate"];
  schema: keyof TKinds extends never ? never : TKinds;
};

type Exact<TShape, TObject extends TShape> = TShape &
  Record<Exclude<keyof TObject, keyof TShape>, never>;

type InferKinds<TKinds extends KindRegistry> = {
  [K in keyof TKinds as TKinds[K] extends KindBuilder<any> ? K : never]: Extract<
    TKinds[K],
    KindBuilder<any>
  >;
};

/**
 * Opens a kindstore instance against a SQLite database.
 *
 * @remarks
 * Startup reconciles structural changes and runs required payload migrations
 * before the returned store becomes usable.
 */
export function kindstore<
  const TKinds extends KindRegistry,
  const TMetadata extends MetadataDefinitionMap = {},
  const TInput extends AnyStoreInput<TKinds, TMetadata> = AnyStoreInput<TKinds, TMetadata>,
>(input: Exact<AnyStoreInput<TKinds, TMetadata>, TInput>) {
  const { filename, databaseOptions, metadata, migrate, schema } = input;
  if (Object.keys(schema).length === 0) {
    throw new Error('kindstore() requires at least one declared kind in "schema".');
  }
  return createStore(
    filename,
    databaseOptions,
    schema as InferKinds<TKinds>,
    (metadata ?? {}) as TMetadata,
    migrate ? { migrate } : undefined,
  ) as Kindstore<InferKinds<TKinds>, TMetadata>;
}

/**
 * Zod schema map for the store-level application metadata surface.
 */
export type MetadataSchemas = Record<string, z.ZodTypeAny>;
