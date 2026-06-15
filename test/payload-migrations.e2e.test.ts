import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";

describe("kindstore payload migrations", () => {
  test("runs eager migrations before reads and indexed queries", () => {
    const filename = `file:kindstore-migrate-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const TaskV1 = z.object({
      title: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", TaskV1),
      },
    });
    const taskId = initial.tasks.newId();
    initial.tasks.put(taskId, { title: "Ship v1" });

    const TaskV2 = z.object({
      title: z.string(),
      status: z.enum(["open", "done"]),
    });
    const migrated = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", TaskV2)
          .updatedAt()
          .index("status")
          .index("updatedAt", { type: "integer" })
          .migrate(2, {
            1: (value) => ({
              ...value,
              status: "open",
            }),
          }),
      },
    });
    const task = migrated.tasks.get(taskId);
    expect(task?.title).toBe("Ship v1");
    expect(task?.status).toBe("open");
    expect(typeof task?.updatedAt).toBe("number");
    expect(
      migrated.tasks.first({
        where: { status: "open" },
        orderBy: { updatedAt: "desc" },
      }),
    ).toEqual(task);
    expect(
      migrated.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"tasks":2}' });
    expect(
      migrated.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'schema_snapshot'`)
        .get(),
    ).toEqual({
      payload: expect.stringContaining('"tasks"'),
    });
    expect(
      migrated.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'store_format_version'`)
        .get(),
    ).toEqual({ payload: "1" });
    migrated.close();
    initial.close();
  });

  test("rolls back failed payload migrations without advancing kind versions", () => {
    const filename = `file:kindstore-rollback-data-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const TaskV1 = z.object({
      title: z.string(),
    });
    const initial = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", TaskV1),
      },
    });
    const taskId = initial.tasks.newId();
    initial.tasks.put(taskId, { title: "Ship v1" });
    const TaskV2 = z.object({
      title: z.string(),
      status: z.enum(["open", "done"]),
    });
    expect(() =>
      kindstore({
        filename,
        schema: {
          tasks: kind("tsk", TaskV2).migrate(2, {
            1: () => {
              throw new Error("boom");
            },
          }),
        },
      }),
    ).toThrow("boom");
    const reopened = kindstore({
      filename,
      schema: {
        tasks: kind("tsk", TaskV1),
      },
    });
    expect(reopened.tasks.get(taskId)).toEqual({ id: taskId, title: "Ship v1" });
    expect(
      reopened.raw
        .query(`SELECT "payload" FROM "__kindstore_internal" WHERE "key" = 'kind_versions'`)
        .get(),
    ).toEqual({ payload: '{"tasks":1}' });
    reopened.close();
    initial.close();
  });
});
