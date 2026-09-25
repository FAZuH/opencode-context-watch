## [Unreleased]

### ⚠ BREAKING CHANGES

* The plugin now targets OpenCode V2 only and no longer loads on OpenCode 1.x. It is a plain `{ id, setup }` default export with no `@opencode-ai/*` runtime dependency.
* Configuration moved from `~/.config/opencode/opencode-context-watch.json` and the `CONTEXT_WATCH_*` environment variables to the `options` object of the `plugins: [{ package, options }]` config form in `opencode.json`. There is no config file, env override, or watcher to migrate.
* Removed the `compact_context` tool and the `toast`, `postCompactContinue`, and `postCompactMsg` options. OpenCode 2 exposes no compaction trigger to plugins, so opencode's own automatic compaction is the compaction path. Config problems are written to the console log instead of a TUI toast.

### New Features

* The model context window is read from the OpenCode model list at startup, so the percent threshold works without a separate system hook.
* Context usage comes from each session's `session.step.ended` token usage; the cumulative `session.usage.updated` figure is ignored.

## 0.1.3 (2026-08-07)

## 0.1.2 (2026-08-05)


### ⚠ BREAKING CHANGES

* Config file is renamed. Rename your config file to `opencode-context-watch.json`.

### Code Refactoring

* Renamed config file name to `opencode-context-watch.json` ([f6ffcb5](https://github.com/FAZuH/opencode-context-watch/commit/f6ffcb57bb89e5f4a88d6b5fcfa93dc7d6567035))
* Renamed project repository to "opencode-context-watch" ([d46d60b](https://github.com/FAZuH/opencode-context-watch/commit/d46d60b77e54363e1dd5ff23de00b54a6e505b28))


### New Features

* Added TUI error toast on invalid config, falling back to defaults ([4664e3a](https://github.com/FAZuH/opencode-context-watch/commit/4664e3aa22a7dac3f08a2da7e9ff6e521fe10ffa))


### Miscellaneous Chores

* Modified default 'warnTokens' config to 150k tokens ([4585dd5](https://github.com/FAZuH/opencode-context-watch/commit/4585dd52a1480ba8f2adef80e1a9361eefd795e8))

## 0.1.1 (2026-08-05)


### ⚠ BREAKING CHANGES

* The `mode` option, the `warnThreshold` config key, and the `CONTEXT_WATCH_MODE`/`CONTEXT_WATCH_THRESHOLD` env vars are removed. Use `warnPercent` instead of `warnThreshold`; `warnTokens` now runs alongside it instead of being exclusive.

### Continuous Integration

* debug ([12c5ec4](https://github.com/FAZuH/opencode-context-watch/commit/12c5ec4ed3ac57d2afbbebf1d868f5074864dc2b))
* debug ([6a873c5](https://github.com/FAZuH/opencode-context-watch/commit/6a873c5a94c189298c64a58da5efc8b59b608e20))


### New Features

* Warnings now fire when either the percent or token threshold is crossed; renamed `warnThreshold` to `warnPercent` and removed the `mode` option ([3cd960f](https://github.com/FAZuH/opencode-context-watch/commit/3cd960f669f6ed4dfcaba96d737b8ccace71a6a8))

## 0.1.0 (2026-08-05)

