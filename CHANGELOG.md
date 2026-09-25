## 0.2.0 (2026-08-13)

### New Features

* Added `context_watch_settings` tool to reload the config and control warning injection live without restarting opencode ([6b3a7ba](https://github.com/FAZuH/opencode-context-watch/commit/6b3a7ba638796ce87158fffc6a5e41854eb7b4a0))
* Added v2 token/notify helpers and a beta compact strategy ([8824e10](https://github.com/FAZuH/opencode-context-watch/commit/8824e1025363d7459f0c560cf7466200efc88c9c))
* The plugin now supports both OpenCode v1 and v2 via runtime autodetection ([364ed6b](https://github.com/FAZuH/opencode-context-watch/commit/364ed6b4220aa784f12c8df833d2914e7a1f7709))

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

