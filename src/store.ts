import type { z } from "zod";

import type { KindDefinition } from "./kind";
import { createStore } from "./runtime";
import type {
  ConnectionConfig,
  KindRegistry,
  MetadataDefinitionMap,
  SchemaDefinition,
} from "./types";
import type {
  PublicKindCollection,
  PublicKindstore,
  PublicMetadataCollection,
} from "./runtime";

type AnyStoreInput = {
  connection: ConnectionConfig;
  metadata?: MetadataDefinitionMap;
  schema?: SchemaDefinition;
} & Record<string, unknown>;

type InferKinds<TInput extends AnyStoreInput> = {
  [K in keyof TInput as K extends "connection" | "metadata" | "schema"
    ? never
    : TInput[K] extends KindDefinition<any>
      ? K
      : never]: Extract<TInput[K], KindDefinition<any>>;
};

type InferMetadata<TInput extends AnyStoreInput> =
  TInput extends { metadata: infer TMetadata extends MetadataDefinitionMap }
    ? TMetadata
    : {};

export type KindCollection<T extends import("./types").KindDefinitionBag> =
  PublicKindCollection<T>;

export type MetadataCollection<T extends MetadataDefinitionMap> =
  PublicMetadataCollection<T>;

export type Kindstore<
  TKinds extends KindRegistry,
  TMetadata extends MetadataDefinitionMap = {},
> = PublicKindstore<TKinds, TMetadata>;

export function kindstore<const TInput extends AnyStoreInput>(input: TInput) {
  const { connection, metadata, schema, ...rest } = input;
  return createStore(
    connection,
    rest as unknown as InferKinds<TInput>,
    (metadata ?? {}) as InferMetadata<TInput>,
    schema,
  ) as Kindstore<InferKinds<TInput>, InferMetadata<TInput>>;
}

export type MetadataSchemas = Record<string, z.ZodTypeAny>;
