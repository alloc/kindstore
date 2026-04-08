import { expectTypeOf, test } from "bun:test";
import { z } from "zod";

import { kindstore } from "../src/index";
import type { KindBuilder } from "../src/kind";
import { kind } from "../src/kind";
import type {
  DatabaseOptions,
  FindManyOptions,
  FindPageOptions,
  FindPageResult,
  Kind,
  KindId,
  KindInput,
  KindOutput,
  KindPageCursor,
  KindPropertyKey,
  KindWhere,
  MetadataValue,
  PatchValue,
  TaggedId,
  WhereOperand,
} from "../src/types";

test("type-level validation of core primitives", () => {
  // Define a mock schema and kind
  const userSchema = z.object({
    name: z.string(),
    age: z.number(),
    status: z.enum(["active", "inactive"]).optional(),
  });

  const userKind = kind("usr", userSchema)
    .index("status", { type: "text" })
    .index("age", { type: "integer" })
    .createdAt()
    .updatedAt();

  type UserBag = typeof userKind extends KindBuilder<infer B extends Kind> ? B : never;

  // KindOutput is the typed document shape returned from collection APIs
  expectTypeOf<KindOutput<UserBag>>().toEqualTypeOf<{
    id: KindId<UserBag>;
    name: string;
    age: number;
    status?: "active" | "inactive" | undefined;
    createdAt: number;
    updatedAt: number;
  }>();
  expectTypeOf<KindOutput<typeof userKind>>().toEqualTypeOf<KindOutput<UserBag>>();

  // KindInput allows omitting managed timestamps
  expectTypeOf<KindInput<UserBag>>().toMatchTypeOf<{
    name: string;
    age: number;
    status?: "active" | "inactive" | undefined;
  }>();
  expectTypeOf<KindInput<typeof userKind>>().toEqualTypeOf<KindInput<UserBag>>();
  // ... but allows providing them
  expectTypeOf<KindInput<UserBag>>().toMatchTypeOf<{
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
  expectTypeOf<KindPropertyKey<UserBag>>().toEqualTypeOf<
    "name" | "age" | "status" | "createdAt" | "updatedAt"
  >();
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
    items: KindOutput<UserBag>[];
    next?: KindPageCursor<UserBag>;
  }>();

  // PatchValue handles partial object updates
  expectTypeOf<PatchValue<KindInput<UserBag>>>().toEqualTypeOf<Partial<KindInput<UserBag>>>();

  // MetadataValue resolves ZodTypeAny mapping
  const metadataMap = {
    version: z.number(),
    features: z.array(z.string()),
  };
  expectTypeOf<MetadataValue<typeof metadataMap, "version">>().toBeNumber();
  expectTypeOf<MetadataValue<typeof metadataMap, "features">>().toBeArray();
});

test("type-level validation of multi-only query fields", () => {
  const activityKind = kind(
    "act",
    z.object({
      userId: z.string(),
      updatedAt: z.number().int(),
      status: z.enum(["active", "inactive"]),
    }),
  ).multi(
    "user_updatedAt",
    {
      userId: "asc",
      updatedAt: "desc",
    },
    { unique: true },
  );

  type ActivityBag = typeof activityKind extends KindBuilder<infer B extends Kind> ? B : never;

  expectTypeOf<KindWhere<ActivityBag>>().toEqualTypeOf<
    Partial<{
      userId: WhereOperand<string>;
      updatedAt: WhereOperand<number>;
    }>
  >();
  expectTypeOf<FindManyOptions<ActivityBag>>().toMatchTypeOf<{
    where?: KindWhere<ActivityBag>;
    orderBy?: { userId?: "asc" | "desc"; updatedAt?: "asc" | "desc" };
    limit?: number;
  }>();

  if (false) {
    // @ts-expect-error - 'missingField' is not in the schema
    kind("act", z.object({ userId: z.string() })).multi("bad", { missingField: "asc" });
  }
});

test("type-level validation of id in multi query fields", () => {
  const activityKind = kind(
    "act",
    z.object({
      userId: z.string(),
      updatedAt: z.number().int(),
    }),
  ).multi("user_id", {
    userId: "asc",
    id: "asc",
  });

  type ActivityBag = typeof activityKind extends KindBuilder<infer B extends Kind> ? B : never;

  expectTypeOf<KindWhere<ActivityBag>>().toEqualTypeOf<
    Partial<{
      userId: WhereOperand<string>;
      id: WhereOperand<KindId<ActivityBag>>;
    }>
  >();
  expectTypeOf<FindManyOptions<ActivityBag>>().toMatchTypeOf<{
    where?: KindWhere<ActivityBag>;
    orderBy?: { userId?: "asc" | "desc"; id?: "asc" | "desc" };
    limit?: number;
  }>();

  if (false) {
    // @ts-expect-error - ids stay tag-scoped
    expectTypeOf<{ where: { id: "other_123" } }>().toMatchTypeOf<FindManyOptions<ActivityBag>>();
  }
});

test("type-level validation of kindstore constructor", () => {
  const Task = z.object({
    title: z.string(),
    status: z.enum(["todo", "doing", "done"]),
  });
  const User = z.object({
    email: z.string(),
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
      users: kind("usr", User).index("email", { unique: true }),
    },
  });

  expectTypeOf(db.tasks.findMany()).toEqualTypeOf<
    Array<{
      id: `tsk_${string}`;
      title: string;
      status: "todo" | "doing" | "done";
    }>
  >();
  expectTypeOf(
    db.tasks.create({
      title: "Ship docs",
      status: "todo",
    }),
  ).toEqualTypeOf<{
    id: `tsk_${string}`;
    title: string;
    status: "todo" | "doing" | "done";
  }>();
  expectTypeOf(db.resolve(db.tasks.newId())).toEqualTypeOf<
    | {
        id: `tsk_${string}`;
        title: string;
        status: "todo" | "doing" | "done";
      }
    | undefined
  >();
  expectTypeOf(db.resolve(db.users.newId())).toEqualTypeOf<
    | {
        id: `usr_${string}`;
        email: string;
      }
    | undefined
  >();
  expectTypeOf(db.metadata.get("preferences")).toEqualTypeOf<
    | {
        theme: "light" | "dark";
      }
    | undefined
  >();

  type TaskInput = KindInput<typeof db.schema.tasks>;
  type TaskOutput = KindOutput<typeof db.schema.tasks>;
  expectTypeOf<TaskInput>().toEqualTypeOf<{
    title: string;
    status: "todo" | "doing" | "done";
  }>();
  expectTypeOf<TaskOutput>().toEqualTypeOf<{
    id: `tsk_${string}`;
    title: string;
    status: "todo" | "doing" | "done";
  }>();

  if (false) {
    // @ts-expect-error - resolve only accepts IDs from declared kinds
    db.resolve("other_123");

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
