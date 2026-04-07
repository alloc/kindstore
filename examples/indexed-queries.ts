import { z } from "zod";

import { kind, kindstore } from "../src/index";

const Task = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  assigneeId: z.string().optional(),
  updatedAt: z.number().int(),
});

const db = kindstore({
  filename: ":memory:",
  schema: {
    tasks: kind("tsk", Task)
      .index("status")
      .index("assigneeId")
      .index("updatedAt")
      .multi("status_updatedAt", {
        status: "asc",
        updatedAt: "desc",
      }),
  },
});

db.tasks.create({
  title: "Review open pull requests",
  status: "doing",
  assigneeId: "usr_1",
  updatedAt: 1_710_000_000_000,
});

db.tasks.create({
  title: "Write release notes",
  status: "todo",
  assigneeId: "usr_2",
  updatedAt: 1_710_000_000_100,
});

db.tasks.create({
  title: "Publish package",
  status: "doing",
  assigneeId: "usr_1",
  updatedAt: 1_710_000_000_200,
});

const active = db.tasks.findMany({
  where: { status: { in: ["todo", "doing"] } },
  orderBy: { updatedAt: "desc" },
  limit: 20,
});

const firstPage = db.tasks.findPage({
  where: { status: "doing" },
  orderBy: { updatedAt: "desc" },
  limit: 1,
});

const secondPage = firstPage.next
  ? db.tasks.findPage({
      where: { status: "doing" },
      orderBy: { updatedAt: "desc" },
      limit: 1,
      after: firstPage.next,
    })
  : undefined;

const assignedTitles = Array.from(
  db.tasks.iterate({
    where: { assigneeId: "usr_1" },
    orderBy: { updatedAt: "desc" },
  }),
  (task) => task.title,
);

console.log({ active, firstPage, secondPage, assignedTitles });
db.close();
