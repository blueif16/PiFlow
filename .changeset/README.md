# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets) — it
drives versioning, changelogs, and publishing for the `@piflow/*` packages.

## Releasing (the loop)

1. **Describe the change.** After a change that should ship, run:
   ```sh
   npm run changeset
   ```
   Pick the affected packages and the bump (patch / minor / major). This writes a
   markdown file in this folder. Commit it alongside your code.

2. **Apply versions.** When you're ready to cut a release, run:
   ```sh
   npm run version-packages
   ```
   This consumes the pending changeset files, bumps each package's `version`, rewrites
   the internal `@piflow/*` dependency ranges, and updates each `CHANGELOG.md`. Commit
   the result.

3. **Publish.** With an `npm login` that owns the `@piflow` scope:
   ```sh
   npm run release
   ```
   This builds, then `changeset publish` publishes every bumped package in dependency
   order (`access: "public"` from `config.json`) and creates git tags.

`baseBranch` is `main`. Private packages (the monorepo root, `@piflow/tui`) are skipped.
