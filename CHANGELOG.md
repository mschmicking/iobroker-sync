# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
