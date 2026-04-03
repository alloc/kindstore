# AGENTS.md

Repository-specific instructions for `/Users/alec/dev/alloc/kindstore`:

- When fixing a code-level bug, add an entry to `CHANGELOG.md`.
- When adding a new user-facing feature, add an entry to `CHANGELOG.md`.
- When a change is visible to downstream users of kindstore, update `skills/kindstore/SKILL.md` so the distributed guidance stays aligned with the current API and behavior.
- Before updating `CHANGELOG.md`, check the latest package version with `cat package.json | jq '.version'` and base the next implied version on that result so unreleased entries stay grouped under the correct upcoming release.

For `CHANGELOG.md` entries, determine the next implied version according to these rules:

- **Breaking changes:** Bump the major component (the `x` in `x.y.z`, or the `x` in `0.x.y`).
- **New features:** Bump the minor component (the `y` in `x.y.z`).
- **Bug fixes:** Bump the patch component (the `z` in `x.y.z`, or the `y` in `0.x.y`).
