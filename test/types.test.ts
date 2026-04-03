import { expectTypeOf, test } from "bun:test";
import { z } from "zod";

import { kindstore } from "../src/index";
import { kind } from "../src/kind";
import type { KindBuilder } from "../src/kind";
import type {
  DatabaseOptions,
  FindManyOptions,
  FindPageOptions,
  FindPageResult,
  KindDefinition,
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

  type UserBag =
    typeof userKind extends KindBuilder<infer B extends KindDefinition> ? B : never;

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
  expectTypeOf<KindWhere<UserBag>>().toEqualTypeOf<
    Partial<{
      status: WhereOperand<"active" | "inactive" | undefined>;
      age: WhereOperand<number>;
    }>
  >();
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

test("type-level validation of kindstore constructor", () => {
  const Task = z.object({
    title: z.string(),
    status: z.enum(["todo", "doing", "done"]),
  });
  const Preferences = z.object({
    theme: z.enum(["light", "dark"]),
  });

  const db = kindstore({
    filename: ":memory:",
    databaseOptions: { strict: true } satisfies DatabaseOptions,
    metadata: { preferences: Preferences },
    migrate(m) {
      m.rename("legacyTasks", "tasks");
    },
    schema: {
      tasks: kind("tsk", Task).index("status"),
    },
  });

  expectTypeOf(db.tasks.findMany()).toEqualTypeOf<
    Array<{
      title: string;
      status: "todo" | "doing" | "done";
    }>
  >();
  expectTypeOf(db.metadata.get("preferences")).toEqualTypeOf<
    | {
        theme: "light" | "dark";
      }
    | undefined
  >();

  if (false) {
    // @ts-expect-error connection config object was removed
    kindstore({
      connection: { filename: ":memory:" },
      schema: {
        tasks: kind("tsk", Task),
      },
    });

    // @ts-expect-error databaseOptions replaced the old options property
    kindstore({
      filename: ":memory:",
      options: { strict: true },
      schema: {
        tasks: kind("tsk", Task),
      },
    });

    // @ts-expect-error kinds must be declared under schema
    kindstore({
      filename: ":memory:",
      schema: {
        tasks: kind("tsk", Task),
      },
      tasks: kind("tsk", Task),
    });

    // @ts-expect-error migrate is top-level, not nested under schema
    kindstore({
      filename: ":memory:",
      schema: {
        migrate() {},
        tasks: kind("tsk", Task),
      },
    });

    // @ts-expect-error empty schemas are not supported
    kindstore({
      filename: ":memory:",
      schema: {},
    });
  }
});
