## [1.0.0](https://github.com/FAZuH/opencode-context-watch/compare/v0.1.3...v1.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* **plugin:** OpenCode 1 support, the standalone config file, environment overrides, and compact_context were removed

### Features

* **plugin:** add context_watch_settings tool for live config control ([2826d17](https://github.com/FAZuH/opencode-context-watch/commit/2826d1790cc96935edb8877fc189342d6ad5c5f5))
* **plugin:** add v2 token/notify helpers and beta compact strategy ([8824e10](https://github.com/FAZuH/opencode-context-watch/commit/8824e1025363d7459f0c560cf7466200efc88c9c))
* **plugin:** live-settings TUI bridge and v2 beta-17898 port ([d1d62cc](https://github.com/FAZuH/opencode-context-watch/commit/d1d62cc665e76f00c98a8f629df1abea40e3114a))
* **plugin:** run one entry on opencode v1 and v2 via runtime autodetection ([364ed6b](https://github.com/FAZuH/opencode-context-watch/commit/364ed6b4220aa784f12c8df833d2914e7a1f7709))


### Code Refactoring

* **plugin:** rewrite for opencode v2 only ([61da70b](https://github.com/FAZuH/opencode-context-watch/commit/61da70b28ec3951a628504a06d7c7664dd4c61f9))

## [0.1.3](https://github.com/FAZuH/opencode-context-watch/compare/v0.1.2...v0.1.3) (2026-08-07)


### Features

* **plugin:** add compact_context tool and post-compaction message ([cd015f7](https://github.com/FAZuH/opencode-context-watch/commit/cd015f762d8da776fb07d53e9fadad974b201b0f)), closes [#5449](https://github.com/FAZuH/opencode-context-watch/issues/5449)

## [0.1.2](https://github.com/FAZuH/opencode-context-watch/compare/v0.1.1...v0.1.2) (2026-08-05)


### ⚠ BREAKING CHANGES

* **config:** Config file is renamed. Rename your config file to `opencode-context-watch.json`.

### Features

* **config:** Show an error toast for invalid config and fall back to defaults ([4664e3a](https://github.com/FAZuH/opencode-context-watch/commit/4664e3aa22a7dac3f08a2da7e9ff6e521fe10ffa))


### Code Refactoring

* **config:** rename config file to opencode-context-watch.json ([f6ffcb5](https://github.com/FAZuH/opencode-context-watch/commit/f6ffcb57bb89e5f4a88d6b5fcfa93dc7d6567035))

## [0.1.1](https://github.com/FAZuH/opencode-context-watch/compare/v0.1.0...v0.1.1) (2026-08-05)


### ⚠ BREAKING CHANGES

* **config:** The `mode` option, the `warnThreshold` config key, and the `CONTEXT_WATCH_MODE`/`CONTEXT_WATCH_THRESHOLD` env vars are removed. Use `warnPercent` instead of `warnThreshold`; `warnTokens` now runs alongside it instead of being exclusive.

### Features

* **config:** support warnPercent and warnTokens together, remove mode ([3cd960f](https://github.com/FAZuH/opencode-context-watch/commit/3cd960f669f6ed4dfcaba96d737b8ccace71a6a8))

## 0.1.0 (2026-08-05)

