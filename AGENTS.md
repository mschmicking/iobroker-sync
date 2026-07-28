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
   *before* deleting. A failed backup aborts the operation.
5. **Copy-then-delete must verify first.** ioBroker has no native rename/move, so both
   are implemented as copy-verify-delete. The verification compares the actual source
   text. Checking only that "something exists at the new id" is not verification — a
   truncated copy would pass and the original would be destroyed.
6. **`backup` is read-only and all-or-nothing.** It fetches objects and writes files,
   never mutating the server. It stores the *whole* object, not just the source, because
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

`common.sourceHash` and `common.compiled` are adapter-managed. Never write them: the
javascript adapter recomputes the hash from `source` and only reuses `compiled` on a
hash match, so leaving them stale is safe and forces a correct recompile.

Use the `ws` npm package, **not** Node's built-in WebSocket — the built-in (undici)
infinite-loops on connection errors against this server.

## Conventions

- TypeScript, CommonJS output, `strict: true`. `npx tsc -p tsconfig.json --noEmit`
  must be clean before you call anything done.
- Commands never call `console.*` — use `ctx.log` (`info`/`warn`/`error`/`debug`/`result`).
- User-facing failures are `UserError` (message + optional hint); `cli.ts` prints them
  without a stack trace and sets exit code 1.
- Comments explain *why*, not *what*. The non-obvious protocol and safety reasoning is
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

128 tests, all against `test/fake-server.ts` — no test may touch a real instance.

Directly tested: `client/socket`, `client/objects`, `sync/compare`, `sync/mapping`,
`sync/safe-path` (path traversal, symlink-file writes, symlinked-directory writes),
and the commands `pull`, `push`, `status`, `list`, `start`, `stop`, `restart`, `new`,
`rename`, `move`, `remove`. `sync/manifest` and `sync/scan` are covered indirectly by
every pull/push test.

`pull` also skips-and-continues per script rather than aborting the whole run: one
unwritable script (a bad id, a symlink in the way) is reported and the rest still
sync. Covered by "pull skips a script whose local path is unwritable but still
pulls the rest" in `test/commands-sync.test.ts`.

**Not directly tested** — treat as unverified and add coverage when you touch them:

- `commands/watch.ts` — only manually smoke-tested. The echo-suppression logic
  (ignoring the adapter's `compiled`/`sourceHash` write-back) is subtle and a
  regression there means an infinite push loop.
- `commands/diff.ts` — manually exercised against a live instance only.
- `commands/init.ts` — the tsconfig scaffolding is covered by
  `test/commands-init.test.ts`; `probeConnection` and the `javascript.d.ts`
  download are not.
- `config.ts`, `cli.ts`, `client/auth.ts` — the auth-disabled fast path is the only
  one ever run; the OAuth2 and legacy login paths have never executed.

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

Pulled scripts **cannot be typechecked as a single program**. Each ioBroker script runs
in its own sandbox scope, so top-level names are private to it — but one `tsc` program
puts them all in one global scope, where they collide (`TS2451` on a shared `axios`,
`TS2393` on a shared `sendMessage`). These are artifacts of joint checking, not runtime
bugs; scripts must be checked one program per file. The generated
`scripts/tsconfig.json` is for editor intellisense and **will** show those false
collisions.

### This repo holds no scripts

The CLI is a tool; the scripts it syncs live in their own repository
(`mschmicking/iobroker-scripts`), along with their tests and a per-file typecheck
runner. Do not add a `scripts/` directory here — running `iob-sync init` inside this
repo is what caused the `tsconfig.json` breakage above. Test commands against
`test/fake-server.ts` and temporary project directories instead.
