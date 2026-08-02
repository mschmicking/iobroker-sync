# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## What this is

A CLI that syncs ioBroker JavaScript/TypeScript scripts between a local folder and a
live ioBroker instance, so scripts can be edited in a normal editor instead of the
Admin web UI.

## The one rule that matters

**This tool talks to a live home-automation system. Losing a script means losing
working automation that someone's house depends on.**

Every design decision here is downstream of that. When in doubt, refuse and report
rather than proceed. A command that does nothing and says why is always better than
one that guesses.

Concretely, these invariants must hold. Do not weaken them without an explicit
instruction from the user:

1. **`pull` never deletes a local file.** A script gone from the server is reported
   as `remote-missing`; the user decides.
2. **`push` never deletes a remote object**, and sends only `common.source` and
   `common.engineType`. It must not send `enabled` or `engine` — that is what makes
   it structurally impossible for a sync bug to stop a running script or move it
   between javascript instances. `ObjectsApi.extendScript` is typed
   `Pick<ScriptCommon, 'source' | 'engineType'>` to enforce this at compile time.
3. **Conflicts block.** If local and remote both changed, refuse and exit non-zero.
4. **Deletion is explicit.** Only `remove`, `rename` and `move` delete anything, each
   requires `--yes`, and each writes the full object JSON to `.iobroker-sync/trash/`
   _before_ deleting. A failed backup aborts the operation.
5. **Copy-then-delete must verify first.** ioBroker has no native rename/move, so both
   are implemented as copy-verify-delete. The verification compares the actual source
   text. Checking only that "something exists at the new id" is not verification — a
   truncated copy would pass and the original would be destroyed.
6. **`backup` is read-only and all-or-nothing.** It fetches objects and writes files,
   never mutating the server. It stores the _whole_ object, not just the source, because
   `push` cannot write `common.enabled` or `common.engine` back (invariant 2) — so
   `objects/*.json` is the only record of those. A partial snapshot is worse than none,
   so any write failure aborts with a `UserError` rather than leaving a plausible-looking
   half-snapshot behind.

## Testing against a real instance

Do **not** write to a user's ioBroker instance without explicit permission for that
specific action. Read-only calls (`getObject`, `getObjectView`) are fine and genuinely
useful for verification.

`test/fake-server.ts` implements the Admin websocket protocol in-process. Write and run
tests against that, not against real hardware.

## Architecture

```
src/types.ts        Frozen shared contracts. Implementations conform to it, not
                    the reverse. Changing it ripples everywhere — think first.
src/client/         Transport. socket.ts speaks the raw Admin WS protocol;
                    objects.ts is the typed object-layer API; auth.ts gets a cookie.
src/sync/           Pure logic: mapping (id <-> path), manifest, three-way compare,
                    filesystem/remote scanning. No network code belongs here.
src/commands/       One file per CLI command. Takes a CommandContext, returns void.
src/cli.ts          Commander wiring, context construction, error formatting.
```

### Protocol notes (verified against Admin 7.6.17)

Connect to `ws://<host>:<port>/?sid=<ts>&name=<client>`. Frames are JSON arrays
`[type, id, name, args]` — 0=message, 1=ping, 2=pong, 3=callback. Reply to pings with
`[2]` or the server drops you. Wait for `[0, null, "___ready___"]` before sending.
Requests are `[3, id, command, args]`; the reply reuses the id with `args = [err, result]`.

Scripts are `script.js.<folder>.<name>` (`type: "script"`); folders are `type: "channel"`.
Folder `common.name` may be a **multilingual object**, not a string — use `resolveName()`.

### Log streaming (verified against live Admin 7.x)

Subscribing uses the **generic `subscribe` command with the literal type `log`** — there
is no `subscribeLog` on the wire. Server-side that flips `requireLog(true)`, after which
lines arrive as ordinary message frames `[0, null, "log", [entry]]` where `entry` is
`{ message, severity, from, ts }`.

**A script's identity is inside `message`, not a field.** A real line looks like
`javascript.2 (200) script.js.Rollos.astroControl: ...`, so filtering by script is
substring matching over `message` + `from`. There is nothing else to match on.

Unknown severities are shown, never hidden — treating an unrecognised level as
below-threshold could swallow the very error the user is looking for.

`common.sourceHash` and `common.compiled` are adapter-managed. Never write them: the
javascript adapter recomputes the hash from `source` and only reuses `compiled` on a
hash match, so leaving them stale is safe and forces a correct recompile.

Use the `ws` npm package, **not** Node's built-in WebSocket — the built-in (undici)
infinite-loops on connection errors against this server.

## Conventions

- TypeScript, CommonJS output, `strict: true`. `npx tsc -p tsconfig.json --noEmit`
  must be clean before you call anything done.
- Commands never call `console.*` — use `ctx.log`
  (`info`/`warn`/`error`/`debug`/`result`/`data`).
- **`data()` accompanies `result()`, never replaces it.** One code path serves both
  audiences; a command that emits only one of them is broken for the other. Records
  carry underlying values (booleans, full ids), not the display strings, and each has
  a `type` discriminator.
- Under `--json`, stdout is **NDJSON only** — `info`/`result` are suppressed and
  `warn`/`error` go to stderr, so stdout stays parseable even on failure. NDJSON rather
  than one accumulated array because `logs` and `watch` are unbounded: an array could
  never be closed, and nothing would appear until exit.
- User-facing failures are `UserError` (message + optional hint); `cli.ts` prints them
  without a stack trace and sets exit code 1.
- Comments explain _why_, not _what_. The non-obvious protocol and safety reasoning is
  worth writing down; restating the code is not.
- No new npm dependencies without a good reason. Current set: `ws`, `commander`,
  `chokidar`, `diff`.

## Commands

```bash
npm run build      # compile to dist/
npm test           # build + run the full suite
npm run test:unit  # pure-logic tests only
```

## Test coverage

All tests run against `test/fake-server.ts` — **no test may touch a real instance.**
(Deliberately not stating a test count here: it went stale five times in a single
session. `node --test` reports the number.)

Directly tested: `client/socket`, `client/objects`, `client/auth` (HTTP and HTTPS),
`config`, `credentials`, `sync/compare`, `sync/mapping`, `sync/safe-path` (path
traversal, symlink-file writes, symlinked-directory writes), the `--json` record shapes,
and the commands `pull`, `push`, `status`, `diff` (including `--against`), `watch`,
`logs`, `list`, `start`, `stop`, `restart`, `new`, `rename`, `move`, `remove`, `backup`.
`sync/manifest` and `sync/scan` are covered indirectly by every pull/push test.

`test/cli.test.ts` spawns the built `dist/cli.js` and asserts on real argv handling.
It exists because a duplicate `--password-stdin` declaration — global _and_ on the
`login` subcommand — was silently shadowed by commander, and no in-process test could
see it. **Anything about option wiring, exit codes or stdout/stderr separation belongs
there, and it needs `dist/` built first.**

`test/fake-server.ts` serves HTTP and websocket on one port, as real Admin does on 8081.
Its `auth` field selects how the HTTP side answers the probes in `client/auth.ts`
(`disabled` → `GET /login` 404s, `oauth` → `POST /oauth/token`, `legacy` → `POST /login`);
`reset()` returns it to `disabled`, so tests that do not care are unaffected.

`pull` also skips-and-continues per script rather than aborting the whole run: one
unwritable script (a bad id, a symlink in the way) is reported and the rest still
sync. Covered by "pull skips a script whose local path is unwritable but still
pulls the rest" in `test/commands-sync.test.ts`.

**Not directly tested** — treat as unverified and add coverage when you touch them:

- `commands/init.ts` — the tsconfig scaffolding, gitignore handling and config writing
  are covered; `probeConnection` and the `javascript.d.ts` download are not.
- The **interactive prompts** in `prompt.ts` are never exercised: tests run without a
  TTY, which is exactly the guard being relied on. Verified by hand only.
- The **SIGINT path** in `cli.ts` (`untilSigint`) is exercised by hand only; `watch`
  and `logs` are tested through their `stop()` handles instead.
- The **legacy `/login` fallback** passes against the fake server but has never run
  against real hardware — current Admin authenticates via OAuth2.
- `client/auth.ts` is covered against the fake server over both HTTP and HTTPS,
  but **no login path has yet run against a real authenticated instance.**

## Passwords

The password must never reach the project directory, argv, or a log line:

- `.iobroker-sync.json` holds the **username only**. It lives in the user's git repo.
- There is deliberately **no `--password <value>` flag** — argv is readable by any
  local process via `ps` and is kept in shell history. Only `--password-stdin`,
  `IOBROKER_PASSWORD`, the saved store, or a hidden prompt.
- `src/credentials.ts` stores passwords at `~/.config/iobroker-sync/credentials.json`
  (override with `IOBROKER_SYNC_CREDENTIALS`, which every test does so the suite never
  reads the developer's real store), mode `0600` in a `0700` directory, written
  temp-then-rename so an interrupted write cannot truncate it.
- `iob-sync login` verifies a password against the live instance _before_ saving, so a
  typo fails now rather than on the next command.
- Prompts require stdin **and** stdout to be TTYs, so a script, CI job or agent gets a
  `UserError` instead of a hang.

### Auth requires TLS, and TLS here is self-signed

Admin will not accept a password over plain HTTP, so any instance with authentication
enabled is also on HTTPS — usually with a self-signed certificate. `allowSelfSigned`
used to be honoured only on the websocket; the HTTP login path used global `fetch`,
which cannot accept an untrusted certificate without an `undici` Agent, so login died
at the handshake before sending anything. `client/auth.ts` therefore uses `node:https`
directly rather than `fetch`. `test/fixtures/` holds a generated throwaway certificate
so this path is tested against a real handshake.

Because `allowSelfSigned` removes the only proof of who the server is, identity comes
from a pinned SHA-256 fingerprint instead (`client/tls.ts`, `certFingerprint` in the
config): recorded on first use, checked on every connection, and a mismatch stops the
command **before** credentials are sent. Two layers, both needed — `probeCertificate`
reads the certificate without sending anything, which is what makes it possible to ask
the user at a point where the answer still matters; the pinned `https.Agent` re-checks
on every connection, because an attacker can relay the probe untouched and interfere
only with the connection carrying the password.

`rejectUnauthorized` is never assigned a literal `false` anywhere in `src/`. It is
always `!allowSelfSigned` — the value is the user's decision, not a constant, and
writing it as one both misreports what the code does and trips CodeQL's
`js/disabling-certificate-validation`.

### Two bugs the watch tests caught

Both were live in working code, and both are the kind that only show up under a test
that can actually drive the watcher:

1. `watch()` returned before chokidar finished its initial scan, so any edit saved in
   that window was silently dropped. It now awaits the `ready` event.
2. `lastPushedHash` was recorded _after_ the server write completed, so an adapter
   echo arriving mid-flight escaped the echo guard and produced a spurious pull. The
   hash is now recorded before the write.

`watch()` returns a `WatchHandle` with `stop()` rather than blocking until SIGINT —
signal handling lives in `cli.ts`. That is what makes the echo-suppression logic
testable at all, which matters given a regression there means an infinite push loop.

## Other known gaps

- Self-signed certificates are honoured on the websocket path but not on the HTTP
  auth path (would require an `undici` Agent).
- `init --types` writes the ioBroker type definitions, but the download of
  `javascript.d.ts` from GitHub has only been exercised against a live network.

### Typechecking pulled scripts

`init --types` writes its tsconfig to **the script root** (`scripts/tsconfig.json`),
never merging into a `tsconfig.json` at the project root. Merging is what the command
used to do, and in a repo that already has a build config it injects `scripts/**` into
a config owning `rootDir`/`outDir` and breaks the build with TS6059. The scripts config
sets `noEmit`, which keeps `rootDir` out of the picture entirely.

Pulled scripts could not originally be typechecked as a single program. Each ioBroker script runs
in its own sandbox scope, so top-level names are private to it — but one `tsc` program
puts them all in one global scope, where they collide (`TS2451` on a shared `axios`,
`TS2393` on a shared `sendMessage`). These are artifacts of joint checking, not runtime
bugs. The generated `scripts/tsconfig.json` therefore sets `moduleDetection: force`, which
gives every file its own scope and makes the whole folder checkable in one pass —
verified against duplicate top-level names, top-level await, `require()` and .js scripts.
`module`/`target` are es2022 rather than commonjs because the adapter permits top-level
await, which commonjs rejects with TS1378.

### This repo holds no scripts

The CLI is a tool; the scripts it syncs belong in their own repository. Do not add a
`scripts/` directory here — running `iob-sync init` inside this repo is what caused the
`tsconfig.json` breakage above. Test commands against `test/fake-server.ts` and
temporary project directories instead.

## Linting and formatting

```bash
npm run lint          # eslint, type-aware
npm run format        # prettier --write
npm run verify        # lint + format check + typecheck + tests
```

Two rules encode invariants rather than taste, and must not be relaxed:

- **`no-console` is an error everywhere in `src/` except `cli.ts`.** Only the CLI layer
  owns stdout/stderr; everything else goes through `ctx.log`. This caught three
  `console.warn` calls in `sync/manifest.ts` that bypassed the logger entirely — they
  could not be captured by tests and ignored `--json`. `loadManifest` now takes a
  `warn` callback.
- **`no-floating-promises` is an error.** An unawaited write to a live instance means the
  command reports success and exits with the request still in flight. `node:test`'s
  `describe`/`it` are declared safe via `allowForKnownSafeCalls` rather than switching
  the rule off in tests.

Three rules from `strictTypeChecked` are deliberately **off**, with the reasoning in
`eslint.config.mjs`. The important one: `no-unnecessary-condition`. `socket.emit<T>()`
returns `T`, but that type is a _claim_ about what the server should send, not a
guarantee — so guards like `result?.rows ?? []` look redundant to the rule and are
essential at runtime. Following it would trade a handled edge case for a crash against
someone's house.

### Known flakiness in the watch tests

`test/commands-watch.test.ts` has failed roughly once in ten or twenty **full-suite**
runs, and not at all when that file runs alone. `node --test` executes files
concurrently, so a dozen fake servers, chokidar watchers and debounce timers compete
for the same machine — under that load a timer can slip past its window.

Two mitigations are already in place: the shared debounce is 150 ms rather than 20 ms
(chokidar can emit `add` and `change` for a single write, and at 20 ms that pair can
straddle the window), and the coalescing test uses synchronous writes with a 1000 ms
window so it measures the debounce rather than the disk.

If it recurs, that file is the suspect and the fix is more timing margin — **not**
loosening an assertion. The thing being tested is the guard against an infinite push
loop against someone's house.
