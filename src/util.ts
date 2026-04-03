import type { SqliteTypeHint, TaggedId } from "./types";

export function isFilterOperators(value: unknown): value is {
  in?: readonly unknown[];
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
} {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("in" in value || "gt" in value || "gte" in value || "lt" in value || "lte" in value)
  );
}

export function assertTaggedId<TTag extends string>(tag: TTag, id: TaggedId<TTag>) {
  if (!id.startsWith(`${tag}_`)) {
    throw new Error(`Expected ID for tag "${tag}", received "${id}".`);
  }
}

export function parsePayload(payload: string) {
  return JSON.parse(payload) as Record<string, unknown>;
}

export function columnExpression(type: SqliteTypeHint, field: string) {
  const path = `$."${field.replaceAll('"', '""')}"`;
  const extract = `json_extract("kindstore_payload", '${path}')`;
  return type === "text" ? extract : `CAST(${extract} AS ${type.toUpperCase()})`;
}

export function indexName(table: string, suffix: string) {
  return `idx_${table}_${suffix}`;
}

export function sameColumns(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isSqliteTypeHint(value: string): value is SqliteTypeHint {
  return value === "text" || value === "integer" || value === "real" || value === "numeric";
}

export function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function snakeCase(value: string) {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    const lower = char.toLowerCase();
    if (index && char !== lower && value[index - 1] !== "_") {
      result += "_";
    }
    result += lower;
  }
  return result;
}
