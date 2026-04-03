import { expectTypeOf, test } from "bun:test";
import { z } from "zod";

import { kind } from "../src/kind";
import type {
  FindManyOptions,
  FindPageOptions,
  FindPageResult,
  KindId,
  KindInputValue,
  KindPageCursor,
  KindValue,
  KindWhere,
  MetadataValue,
  PatchValue,
  TaggedId,
  WhereOperand,
} from "../src/types";

test("type-level validation of core primitives", () => {
  // Define a mock schema and kind
  const userSchema = z.object({
    id: z.string(),
    name: z.string(),
    age: z.number(),
    status: z.enum(["active", "inactive"]).optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  });

  const userKind = kind("usr", userSchema)
    .index("status", { type: "text" })
    .index("age", { type: "integer" })
    .createdAt("createdAt")
    .updatedAt("updatedAt");

  type UserBag = typeof userKind extends import("../src/kind").KindDefinition<infer B extends import("../src/types").KindDefinitionBag> ? B : never;

  // KindValue exactly matches the schema output
  expectTypeOf<KindValue<UserBag>>().toEqualTypeOf<{
    id: string;
    name: string;
    age: number;
    status?: "active" | "inactive" | undefined;
    createdAt?: number | undefined;
    updatedAt?: number | undefined;
  }>();

  // KindInputValue allows omitting managed timestamps
  expectTypeOf<KindInputValue<UserBag>>().toMatchTypeOf<{
    id: string;
    name: string;
    age: number;
    status?: "active" | "inactive" | undefined;
  }>();
  // ... but allows providing them
  expectTypeOf<KindInputValue<UserBag>>().toMatchTypeOf<{
    id: string;
    name: string;
    age: number;
    createdAt?: number;
    updatedAt?: number;
  }>();

  // KindId uses TaggedId
  expectTypeOf<KindId<UserBag>>().toMatchTypeOf<TaggedId<"usr">>();
  expectTypeOf<"usr_123" | "usr_abc">().toMatchTypeOf<KindId<UserBag>>();
  expectTypeOf<"other_123">().not.toMatchTypeOf<KindId<UserBag>>();

  // KindWhere only allows fields that are indexed
  expectTypeOf<KindWhere<UserBag>>().toEqualTypeOf<Partial<{
    status: WhereOperand<"active" | "inactive" | undefined>;
    age: WhereOperand<number>;
  }>>();
  // @ts-expect-error - 'name' is not indexed
  expectTypeOf<{ name: string }>().toMatchTypeOf<KindWhere<UserBag>>();

  // FindManyOptions ensures where/orderBy are bounded to indices
  expectTypeOf<FindManyOptions<UserBag>>().toMatchTypeOf<{
    where?: KindWhere<UserBag>;
    orderBy?: { status?: "asc" | "desc"; age?: "asc" | "desc" };
    limit?: number;
  }>();

  // @ts-expect-error - 'name' cannot be ordered
  expectTypeOf<{ orderBy: { name: "asc" } }>().toMatchTypeOf<FindManyOptions<UserBag>>();

  // FindPageOptions requires orderBy and limit
  expectTypeOf<FindPageOptions<UserBag>>().toMatchTypeOf<{
    where?: KindWhere<UserBag>;
    orderBy: { status?: "asc" | "desc"; age?: "asc" | "desc" };
    limit: number;
    after?: KindPageCursor<UserBag>;
  }>();

  // FindPageResult structure
  expectTypeOf<FindPageResult<UserBag>>().toEqualTypeOf<{
    items: KindValue<UserBag>[];
    next?: KindPageCursor<UserBag>;
  }>();

  // PatchValue handles partial object updates
  expectTypeOf<PatchValue<KindInputValue<UserBag>>>().toEqualTypeOf<
    Partial<KindInputValue<UserBag>>
  >();

  // MetadataValue resolves ZodTypeAny mapping
  const metadataMap = {
    version: z.number(),
    features: z.array(z.string()),
  };
  expectTypeOf<MetadataValue<typeof metadataMap, "version">>().toBeNumber();
  expectTypeOf<MetadataValue<typeof metadataMap, "features">>().toBeArray();
});
