import { z } from "zod";

import { kind, kindstore } from "../src/index";

const Task = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
});

const db = kindstore({
  filename: ":memory:",
  schema: {
    tasks: kind("tsk", Task).createdAt().updatedAt().index("status").index("updatedAt"),
  },
});

const created = db.tasks.create({
  title: "Ship docs",
  status: "todo",
});

const progressed = db.tasks.update(created.id, {
  status: "doing",
});

const resolved = db.resolve(created.id);

console.log({ created, progressed, resolved });
db.close();
