## [1.0.3](https://github.com/FAZuH/opencode-context-watch/compare/v1.0.2...v1.0.3) (2026-11-10)


### Bug Fixes

* **plugin:** declare the TUI runtime dependencies ([fa3cdde](https://github.com/FAZuH/opencode-context-watch/commit/fa3cdded45079f12b5cef358d608b31265ab71c2))

## [1.0.2](https://github.com/FAZuH/opencode-context-watch/compare/v1.0.1...v1.0.2) (2026-11-10)


### Bug Fixes

* **plugin:** drop the extra top margin on the sidebar section ([5e8f133](https://github.com/FAZuH/opencode-context-watch/commit/5e8f133f21f14d0ada7a8d265c65b309b0d58858))

## [1.0.1](https://github.com/FAZuH/opencode-context-watch/compare/v1.0.0...v1.0.1) (2026-11-10)


### Features

* **plugin:** add the Context Watch sidebar section ([0d35342](https://github.com/FAZuH/opencode-context-watch/commit/0d3534228b7f81f43c84a318ec21fee71e8f46e4))
* **plugin:** expose context status over RPC for the sidebar ([ec4fc2f](https://github.com/FAZuH/opencode-context-watch/commit/ec4fc2f6cf7635b05708d454d9875d6b7cf668ac))
* **plugin:** handle compaction state and nullable warning bands ([3be8cec](https://github.com/FAZuH/opencode-context-watch/commit/3be8cecf3cb00b0b10eae291baf9e6cd0ba5ad86))


### Bug Fixes

* **plugin:** resolve the status window from the session record ([a6295d9](https://github.com/FAZuH/opencode-context-watch/commit/a6295d964f080ec5d20be2d987325351694bf51b))
* **plugin:** say which threshold fired ([b26e304](https://github.com/FAZuH/opencode-context-watch/commit/b26e3048b0300d2a8931a7ece3538c1fa6051e4d))

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

