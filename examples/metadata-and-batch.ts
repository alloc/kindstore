import { z } from "zod";

import { kind, kindstore } from "../src/index";

const Task = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  updatedAt: z.number().int(),
});

const Preferences = z.object({
  theme: z.enum(["light", "dark"]),
  lastOpenedAt: z.number().int().optional(),
});

const db = kindstore({
  filename: ":memory:",
  metadata: {
    preferences: Preferences,
  },
  schema: {
    tasks: kind("tsk", Task).index("status").index("updatedAt"),
  },
});

db.batch(() => {
  db.tasks.put(db.tasks.newId(), {
    title: "Ship docs",
    status: "todo",
    updatedAt: 1_710_000_000_000,
  });

  db.metadata.set("preferences", {
    theme: "dark",
    lastOpenedAt: 1_710_000_000_500,
  });
});

const preferences = db.metadata.get("preferences");
const todoCount = db.raw
  .query(`SELECT count(*) AS count FROM "tasks" WHERE "status" = ?`)
  .get("todo");

console.log({ preferences, todoCount });
db.close();
