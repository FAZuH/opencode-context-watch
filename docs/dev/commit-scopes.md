# Commit Scopes

The scope in a commit subject (`type(scope): subject`) names the area of the
codebase the change touches. Scopes are a human-readable convention. They do
not affect version bump logic.

## Scopes

| Scope     | Area                                                                 |
|-----------|----------------------------------------------------------------------|
| `plugin`  | Core plugin behavior in `src/index.ts` — the context hook, threshold and rearm bands, warning injection, and logging |
| `config`  | Option validation and defaults in `src/config.ts` — `ctx.options` schema, per-key fallback, problem messages |
| `docs`    | Documentation — `README.md`, `docs/`, `AGENTS.md`                     |
| `dev`     | Development tooling — `package.json` scripts, biome/tsc/bundle setup  |
| `release` | Version bumps and release commits (for example `chore(release)`)      |

## Choosing a scope

- Use the scope of the primary area when a change touches several areas.
- Omit the scope when no area fits, for example `docs:` or `ci:`.
- A change to the plugin behavior that also renames a config option is
  `feat(config)` only when the option surface is the point; otherwise use
  `feat(plugin)` and describe the option in the body.
- `release` is only for version-bump and release commits. Regular changes
  never use it.
