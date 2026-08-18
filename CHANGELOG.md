# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0](https://github.com/mschmicking/iobroker-sync/compare/v1.2.0...v1.3.0) (2026-08-18)


### Added

* **cli:** sweep the adapter markers a deleted script leaves behind ([#30](https://github.com/mschmicking/iobroker-sync/issues/30)) ([da1692c](https://github.com/mschmicking/iobroker-sync/commit/da1692c2b3709dbf9ea7616f97b45efc4d7db7cd))


### Fixed

* **deps:** bump js-yaml and brace-expansion out of their advisories ([#31](https://github.com/mschmicking/iobroker-sync/issues/31)) ([021472a](https://github.com/mschmicking/iobroker-sync/commit/021472a1ac55be1674fc9c25e0e1b8ca1efa6445))
* **deps:** Bump ws from 8.21.1 to 8.21.3 ([#28](https://github.com/mschmicking/iobroker-sync/issues/28)) ([475ddcf](https://github.com/mschmicking/iobroker-sync/commit/475ddcf6bae46377e35694f38fec040065e614dd))

## [1.2.0](https://github.com/mschmicking/iobroker-sync/compare/v1.1.0...v1.2.0) (2026-08-05)


### Added

* **cli:** add a read-only doctor command that explains itself ([#23](https://github.com/mschmicking/iobroker-sync/issues/23)) ([84dc84a](https://github.com/mschmicking/iobroker-sync/commit/84dc84a09851964ae8d37b49c1994110af7e45cd))


### Fixed

* address the two code scanning alerts ([#25](https://github.com/mschmicking/iobroker-sync/issues/25)) ([07ada65](https://github.com/mschmicking/iobroker-sync/commit/07ada6525fb78b7862bc4775a9e0b1948f71d8cd))

## [1.1.0](https://github.com/mschmicking/iobroker-sync/compare/v1.0.1...v1.1.0) (2026-08-03)


### Added

* **auth:** pin the ioBroker TLS certificate on first use ([#21](https://github.com/mschmicking/iobroker-sync/issues/21)) ([360cf07](https://github.com/mschmicking/iobroker-sync/commit/360cf07b0ee1b0c6b601a02e12e37dd48f3f565a))

## [1.0.1](https://github.com/mschmicking/iobroker-sync/compare/v1.0.0...v1.0.1) (2026-07-31)


### Fixed

* **build:** add the npm metadata provenance and the npm page need ([8c2f5db](https://github.com/mschmicking/iobroker-sync/commit/8c2f5dbc637faa3b18dfb475a9225b7aa930d547))
* **cli:** report the real version instead of a hardcoded 0.1.0 ([#17](https://github.com/mschmicking/iobroker-sync/issues/17)) ([3f62ac0](https://github.com/mschmicking/iobroker-sync/commit/3f62ac0e755c4c937f21d785ba34f770babc5aaa))

## [1.0.0](https://github.com/mschmicking/iobroker-sync/compare/v0.1.0...v1.0.0) (2026-07-31)


### Added

* **types:** add an `iob-sync types` command and fix phantom collisions ([3b9724b](https://github.com/mschmicking/iobroker-sync/commit/3b9724b99a996acb1f2fabaff9823ae48d764869))


### Fixed

* **ci:** allow the scope release-please uses in its own PR title ([6fe3742](https://github.com/mschmicking/iobroker-sync/commit/6fe37420e086025baea4cf3ebbd87a6ceea42cdb))
* **ci:** let the release PR actually run its checks, and fix the tag name ([02e36c7](https://github.com/mschmicking/iobroker-sync/commit/02e36c7316fd4abd7ebb68df75f92924f5ce989e))
* **ci:** make release-please able to open a release PR ([cab77a4](https://github.com/mschmicking/iobroker-sync/commit/cab77a46594220dafe308cd2f7633c816ffeac8a))
* **sync:** stop pull silently overwriting files the user already had ([e8ccf4a](https://github.com/mschmicking/iobroker-sync/commit/e8ccf4ac658d0f8d6e245583e292143367cba3b2))


### Chores

* release 1.0.0 ([837b553](https://github.com/mschmicking/iobroker-sync/commit/837b553b5fe743479a5a47c35539d238b02f0c02))

## [Unreleased]

Nothing published to npm yet. The entries below describe the state being prepared
for the first release.

### Added

- `logs` — streams the ioBroker log. `push` only reports that the source was uploaded;
  the javascript adapter compiles it afterwards, so failures appear in the log and
  nowhere else. `--level`, `--limit`, and pattern filtering.
- `--json` — NDJSON on stdout, one record per line, each with a `type`. Human output is
  suppressed and warnings/errors stay on stderr, so stdout is parseable even on failure.
- `diff --against <snapshot>` — compare the working tree with a `backup` snapshot rather
  than the server. `latest` resolves to the newest.
- `login` / `logout` — save or remove the password for an instance. Verified against the
  live server before saving.
- `backup` — read-only snapshot of every script's source _and_ full object, since `push`
  cannot restore `common.enabled` or `common.engine`.
- Interactive `init`, which asks for URL, certificate handling, script root and username
  when run without flags, and adds `.iobroker-sync/` to `.gitignore`.

### Changed

- **Authentication now works over HTTPS with a self-signed certificate.** `client/auth.ts`
  uses `node:http`/`node:https` instead of the global `fetch`, which cannot accept an
  untrusted certificate without an `undici` Agent. ioBroker refuses passwords over plain
  HTTP, so every authenticated instance is affected; login previously failed at the TLS
  handshake before sending anything.
- Passwords are stored outside the project at `~/.config/iobroker-sync/credentials.json`,
  mode `0600` in a `0700` directory. `.iobroker-sync.json` holds only the username.
- `watch()` returns a handle with `stop()` instead of blocking until SIGINT; signal
  handling moved to the CLI layer.

### Fixed

- `watch` dropped edits saved before chokidar finished its initial scan. It now waits for
  the watcher to be ready before reporting that it is watching.
- `watch` could re-pull its own push. The hash used to suppress the javascript adapter's
  `compiled`/`sourceHash` echo was recorded _after_ the server write, so an echo arriving
  mid-write escaped the guard.
- `login --password-stdin` always reported "no terminal available". The option was
  declared both globally and on the subcommand, and the parent silently shadowed the
  child.
- `init --types` no longer merges into a `tsconfig.json` at the project root, which broke
  builds owning `rootDir`/`outDir` with TS6059.

### Security

- No `--password` flag exists, deliberately: argv is readable by other local processes via
  `ps` and is recorded in shell history. Use `--password-stdin`, `IOBROKER_PASSWORD`, the
  saved credential store, or the hidden prompt.
- Prompts require both stdin and stdout to be TTYs, so scripts and CI get an error rather
  than hanging on a password prompt.
