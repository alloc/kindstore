# Destructive Reset For Unhandled Structural Diffs

## Overview / Problem Statement

kindstore currently fails store open when structural reconciliation detects a
destructive or identity-changing change that the caller did not authorize
explicitly. This is the correct default for durable application data, but it is
slower than necessary in development and test environments where callers often
want schema changes to succeed even if the existing local database is reset.

This document proposes one additive planner API:

```ts
destructiveResetUnhandled(): this
```

When enabled for a store open, kindstore should keep honoring explicit
structural migration declarations, then destructively reset any remaining
unhandled structural diffs instead of failing open.

The feature is intended for development and disposable test databases. The
library should not infer environment policy. Callers remain responsible for
guarding use with their own environment checks.

## Context

kindstore has a deliberate fail-closed migration model:

- explicit `rename(previousKindKey, nextKindKey)` transfers row ownership
- explicit `drop(previousKindKey)` authorizes row deletion
- explicit `retag(kindKey, previousTag)` authorizes ID rewriting
- any missing structural intent currently causes store open to fail

This boundary exists because the runtime must not guess whether a missing prior
kind was deleted intentionally, renamed, or temporarily omitted.

That safety boundary remains correct for production data. The problem is that
the same boundary adds friction for disposable databases used during rapid local
iteration, tests, or examples. In those cases, developers often prefer "open
the store and wipe anything that no longer matches" over writing explicit
`drop(...)` and `retag(...)` calls for every temporary schema edit.

## Goals

- Add a narrow, explicit escape hatch for development-time structural resets.
- Preserve the current safe default when the new API is not used.
- Keep existing `rename`, `drop`, and `retag` semantics unchanged.
- Specify deterministic precedence when explicit operations and destructive
  fallback are combined.
- Keep the feature scoped to structural reconciliation only.

## Non-Goals

- Do not infer renames automatically.
- Do not bypass payload migration failures.
- Do not bypass malformed internal bookkeeping or unsupported store formats.
- Do not add environment-driven behavior inside kindstore itself.
- Do not add row-level partial preservation for unhandled tag changes.

## Assumptions and Constraints

- kindstore startup remains transactional from the caller's point of view.
- Structural reconciliation still runs before payload migration.
- Application metadata remains separate from library-owned bookkeeping and must
  not be reset by this feature.
- The new behavior must be additive and backward compatible.
- The feature must be safe to omit entirely in production code paths.

## Terminology

- Structural diff: A difference between the previously recorded store shape and
  the current registry that structural reconciliation must handle.
- Explicit structural intent: A `rename`, `drop`, or `retag` declaration in the
  top-level `migrate(planner)` callback.
- Unhandled structural diff: A structural diff left over after applying all
  explicit planner declarations.
- Destructive reset: Dropping the prior persisted rows and version bookkeeping
  for one kind so the current declaration is recreated as an empty kind during
  the same store open.

## Proposed Design

Extend `SchemaMigrationPlanner` with one new method:

```ts
export interface SchemaMigrationPlanner {
  rename(previousKindKey: string, nextKindKey: string): this;
  drop(previousKindKey: string): this;
  retag(kindKey: string, previousTag: string): this;
  destructiveResetUnhandled(): this;
}
```

`destructiveResetUnhandled()` enables a fallback mode for the current store
open only. It does not persist any policy to the database. Its effect is:

1. Apply all explicit `rename`, `drop`, and `retag` declarations normally.
2. For any structural diff still unresolved after step 1, prefer destructive
   reset over failing store open.

The method is idempotent. Calling it multiple times has the same effect as
calling it once. Its position relative to other planner calls does not change
semantics.

Recommended caller usage:

```ts
const db = kindstore({
  filename,
  migrate(m) {
    m.rename("legacyTasks", "tasks");

    if (process.env.NODE_ENV === "development") {
      m.destructiveResetUnhandled();
    }
  },
  schema: {
    tasks: kind("tsk", Task),
  },
});
```

## API / Interface Specification

### `SchemaMigrationPlanner.destructiveResetUnhandled(): this`

Purpose:

- Opt into destructive fallback handling for unhandled structural diffs during
  the current store open.

Inputs:

- No arguments.

Outputs:

- Returns the planner instance for chaining.

Defaults:

- Disabled unless the caller invokes it.

Ownership and lifecycle:

- Applies only during the current invocation of `kindstore(...)`.
- Is not recorded in schema history or internal metadata.

Invariants:

- Explicit planner operations still take precedence.
- Structural reconciliation still does not guess renames.
- The feature never touches application metadata.

Guarantees:

- Unhandled missing previous kinds are dropped instead of causing a missing
  intent error.
- Unhandled tag changes are reset to an empty current kind instead of causing a
  missing intent error.
- Unhandled rename-like diffs are treated as destructive reset, not inferred
  rename.

Failure behavior:

- Does not suppress invalid planner declarations.
- Does not suppress explicit operation failures.
- Does not suppress payload migration errors or library-owned format errors.

Compatibility:

- Fully backward compatible.
- Existing code that does not call the method keeps current behavior.

## Behavioral Semantics

### Planner normalization

Planner normalization adds one boolean flag to the internal schema plan:

- `destructiveResetUnhandled: boolean`

The default is `false`.

### Reconciliation order

Structural reconciliation keeps the existing high-level order:

1. Match unchanged current kinds by key.
2. Apply explicit renames.
3. Process unmatched previous kinds.
4. Process tag changes for matched current kinds.
5. Validate that explicit retags were relevant.

The new behavior only changes steps 3 and 4.

### Step 3: unmatched previous kinds

For each previous kind not already consumed by an unchanged key match or an
explicit rename:

- If the caller declared `drop(previousKindKey)`, drop it.
- Else if the previous kind key is absent from the current registry and
  `destructiveResetUnhandled` is `true`, drop it.
- Else if the previous kind key is absent from the current registry and
  `destructiveResetUnhandled` is `false`, fail store open with the current
  missing migration error.

This means a rename-like diff with no explicit `rename(...)` remains
non-inferential:

- the old kind is dropped if destructive reset is enabled
- the new current kind is created empty later in bootstrap

### Step 4: matched current kinds with tag changes

For each current kind that matched a previous kind, including kinds matched
through explicit rename:

- If the previous and current tags are the same, preserve rows as today.
- Else if the caller declared the matching explicit `retag(...)`, rewrite IDs
  as today.
- Else if `destructiveResetUnhandled` is `true`, destructively reset the
  current kind.
- Else fail store open with the current missing retag error.

Destructively resetting a matched current kind means:

- drop the physical table that currently owns the rows
- remove the kind's stored payload version entry
- remove the previous snapshot match for that current kind so later bootstrap
  recreates the kind as new and empty

This rule intentionally discards rows instead of trying to preserve them under a
new tag. Tag changes remain identity changes unless the caller opted into the
explicit preserving path with `retag(...)`.

### Precedence rules

Explicit operations always win over destructive fallback:

- `rename(...)` beats fallback drop for its source key.
- `drop(...)` beats any implicit preservation of the old key.
- `retag(...)` beats destructive reset for that matched current kind.

Destructive fallback applies only after explicit declarations have had their
chance to resolve the diff.

### Combined rename plus unhandled tag change

If the caller explicitly renames a kind but does not explicitly retag it, and
the resolved current kind has a different tag, the kind is reset if
`destructiveResetUnhandled` is enabled.

Example:

```ts
migrate(m) {
  m.rename("sessions", "authSessions");
  m.destructiveResetUnhandled();
}
```

If `sessions` previously used tag `ses` and `authSessions` now uses tag `aut`,
kindstore should not infer ID rewriting. It should drop the renamed table's
rows and recreate `authSessions` empty.

### Interaction with payload migrations

Destructive reset only affects structural reconciliation.

After a kind is reset:

- its table is recreated empty if it is still declared in the current registry
- its payload version entry is treated as absent
- no payload migration steps run for discarded rows because those rows no longer
  exist

Kinds that remain preserved continue through normal payload migration.

## Architecture / Data Flow

The main bootstrap path after this change is:

1. Normalize declared schema plan, including the new destructive reset flag.
2. Load the previous schema snapshot and version metadata.
3. Reconcile structural diffs.
4. Emit one effective previous snapshot for the surviving preserved kinds.
5. For each current kind:
   - create the table if needed
   - add generated columns if needed
   - reconcile indexes against the effective preserved snapshot entry, if any
   - drop stale generated columns against the effective preserved snapshot
   - run payload migration if a preserved version entry still exists
6. Persist the new current schema snapshot.

State transitions for one kind:

- Preserved path: previous snapshot entry survives and rows remain.
- Explicit retag path: previous snapshot entry survives, rows remain, IDs are
  rewritten.
- Explicit drop path: previous snapshot entry is removed and rows are deleted.
- Destructive reset path: previous snapshot entry is removed, rows are deleted,
  current kind is recreated empty if still declared.

## Alternatives and Tradeoffs

### Chosen: `destructiveResetUnhandled()`

Pros:

- Keeps the feature on the existing structural-migration surface.
- Makes the destructive behavior explicit in the API name.
- Preserves the current production-safe default.
- Handles both missing prior kinds and unhandled tag changes with one rule.

Cons:

- It is a coarse switch, not a per-kind allowlist.
- It intentionally discards more data than a fully explicit migration plan.

### Rejected: `acceptDataLoss()` or similarly vague naming

Rejected because it states risk but not behavior. The important runtime
semantic is reset, not merely permission for arbitrary loss.

### Rejected: automatic enablement in `NODE_ENV=development`

Rejected because kindstore should not infer deployment policy from process
environment. The library should provide the tool, not silently change behavior
by environment.

### Rejected: infer rename when destructive reset is enabled

Rejected because that weakens the current ownership model and would create a
surprising split between normal and dev behavior. The fallback should destroy
ambiguous prior state, not reinterpret it.

### Rejected: narrower `dropUnhandledMissingKinds()` only

Rejected because it leaves unhandled tag changes on the slow path and does not
solve the developer experience problem end to end.

## Failure Modes and Edge Cases

- Invalid planner declarations still fail early.
  - Example: renaming a kind to itself remains an error.
- Explicit operation contradictions still fail.
  - Example: renaming and dropping the same previous kind remains an error.
- Explicit operation execution failures still fail.
  - Example: an explicit `retag(...)` that encounters malformed persisted IDs
    remains an error.
- Payload migration gaps still fail.
  - Reset only affects discarded rows, not surviving preserved kinds.
- Library-owned format incompatibility still fails.
  - Example: unsupported store format versions remain unrecoverable.
- Unhandled new kinds remain ordinary new kinds.
  - They are created empty as today.
- Application metadata is never reset by this feature.

## Testing and Observability

Required tests:

- opens successfully when a previous kind is missing and destructive reset is
  enabled
- drops the previous table and removes version bookkeeping for that missing kind
- opens successfully when a matched kind changes tag and destructive reset is
  enabled
- recreates the current kind empty after unhandled tag change
- preserves current behavior when the new API is not used
- explicit `rename`, `drop`, and `retag` still behave exactly as before
- explicit rename plus unhandled tag change resets the current kind
- payload migration failures still surface for preserved kinds even when
  destructive reset is enabled
- invalid planner declarations still throw even when destructive reset is
  enabled
- failed opens still roll back transactionally

Observability:

- No new logging or metrics surface is proposed.
- The API name and documentation carry the warning signal.
- If maintainers later add a logging surface, destructive resets are a good
  candidate for debug-level events, but that is out of scope for this change.

## Rollout / Migration

Implementation rollout:

1. Add the planner API and internal schema-plan flag.
2. Update structural reconciliation logic for unmatched previous kinds and
   unhandled tag changes.
3. Add end-to-end and type-level tests.
4. Update public docs:
   - `docs/schema-reconciliation.md`
   - `docs/migration-pipeline.md`
   - `docs/context.md`
   - `docs/course/06-structural-migrations.md`
5. Update `skills/kindstore/SKILL.md` so distributed guidance reflects the new
   API.
6. Add a changelog entry under the next minor release when the feature is
   implemented.

Compatibility rollout:

- This is a semver-minor additive feature.
- No migration is required for existing callers.
- Production callers can ignore it entirely.

## Open Questions

- None for the core runtime model in this proposal.

## Ambiguities and Blockers

- AB-1 - Resolved - Public method naming
  - Affected area: API / Interface Specification
  - Issue: The initial idea was framed as "accept data loss," which does not
    specify what the runtime should actually do.
  - Why it matters: Ambiguous naming encourages accidental overreach in
    implementation and documentation.
  - Next step: Use `destructiveResetUnhandled()` to make the runtime behavior
    explicit.

- AB-2 - Deferred - Future per-kind or per-operation granularity
  - Affected area: Alternatives and Tradeoffs
  - Issue: Some callers may eventually want narrower fallback scope than "all
    remaining unhandled structural diffs."
  - Why it matters: A coarse switch may be broader than some teams want, but it
    keeps the initial design small and predictable.
  - Next step: Revisit only if real usage shows the coarse switch is too blunt.

## Appendix / Examples

### Example: explicit preservation plus dev-only destructive fallback

```ts
const db = kindstore({
  filename,
  migrate(m) {
    m.rename("legacyTasks", "tasks");

    if (process.env.NODE_ENV === "development") {
      m.destructiveResetUnhandled();
    }
  },
  schema: {
    tasks: kind("tsk", Task),
    users: kind("usr", User),
  },
});
```

Behavior:

- `legacyTasks -> tasks` preserves rows because it is explicit.
- any other missing previous kinds are dropped
- any matched current kinds with unhandled tag changes are recreated empty
- application metadata is preserved
- payload migration still runs for preserved kinds

### Example: rename-like diff without explicit rename

Previous schema:

```ts
schema: {
  sessions: kind("ses", Session),
}
```

Current schema:

```ts
schema: {
  authSessions: kind("ses", Session),
}
```

With `destructiveResetUnhandled()` enabled and no explicit `rename(...)`:

- `sessions` is dropped as an unhandled previous kind
- `authSessions` is created as a brand new empty kind
- rows are not transferred automatically
