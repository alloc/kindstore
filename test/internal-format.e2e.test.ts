import { describe, test } from "bun:test";
import { z } from "zod";

import { kind, kindstore } from "../src/index";
import { expectUnrecoverableOpen } from "./helpers/kindstore";

describe("kindstore internal format", () => {
  test("fails fast when an initialized store is missing its format version", () => {
    const filename = `file:kindstore-format-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
      status: z.enum(["active", "revoked", "expired"]),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId").index("status"),
      },
    });
    db.raw.query(`DELETE FROM "__kindstore_internal" WHERE "key" = 'store_format_version'`).run();
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId").index("status"),
          },
        }),
      "missing the kindstore format version",
    );
    db.close();
  });

  test("marks malformed internal format-version metadata as unrecoverable", () => {
    const filename = `file:kindstore-bad-format-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    db.raw
      .query(`UPDATE "__kindstore_internal" SET "payload" = ? WHERE "key" = 'store_format_version'`)
      .run("oops");
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId"),
          },
        }),
      'Internal metadata key "store_format_version" is malformed',
    );
    db.close();
  });

  test("fails fast when internal kind_versions metadata is malformed", () => {
    const filename = `file:kindstore-bad-kind-versions-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    db.raw
      .query(`UPDATE "__kindstore_internal" SET "payload" = ? WHERE "key" = 'kind_versions'`)
      .run('"oops"');
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId"),
          },
        }),
      'Internal metadata key "kind_versions" is malformed',
    );
    db.close();
  });

  test("fails fast when internal schema_snapshot metadata is malformed", () => {
    const filename = `file:kindstore-bad-snapshot-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    db.raw
      .query(`UPDATE "__kindstore_internal" SET "payload" = ? WHERE "key" = 'schema_snapshot'`)
      .run('{"kindstoreVersion":1,"kinds":{"sessions":{"tag":"ses"}}}');
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId"),
          },
        }),
      'Internal metadata key "schema_snapshot" has an invalid kind entry',
    );
    db.close();
  });

  test("marks unsupported newer store formats as unrecoverable", () => {
    const filename = `file:kindstore-newer-format-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const Session = z.object({
      userId: z.string(),
    });
    const db = kindstore({
      filename,
      schema: {
        sessions: kind("ses", Session).index("userId"),
      },
    });
    db.raw
      .query(`UPDATE "__kindstore_internal" SET "payload" = ? WHERE "key" = 'store_format_version'`)
      .run("2");
    expectUnrecoverableOpen(
      () =>
        kindstore({
          filename,
          schema: {
            sessions: kind("ses", Session).index("userId"),
          },
        }),
      "newer than supported version",
    );
    db.close();
  });
});
