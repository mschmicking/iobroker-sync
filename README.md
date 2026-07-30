# iobroker-sync

Edit your ioBroker scripts as ordinary files, in any editor, under version control.

ioBroker keeps JavaScript and TypeScript scripts inside its object database, reachable
only through the Admin web UI. That means no git history, no code review, no diffs, no
search across scripts, no editor of your choice, and no way to touch them from a script
or a CI job. `iobroker-sync` maps them to a local folder and keeps the two in step.

<!-- Screenshot to add before v1.0 — see docs/images/README.md for exactly what to capture. -->

![Two terminal panes side by side. On the left, a script is edited and iob-sync push reports it was uploaded. On the right, iob-sync logs is streaming the ioBroker log, where the script's own output appears a moment later.](docs/images/edit-loop.png)

## Quick start

> **Not released yet.** `iobroker-sync` is not on npm until v1.0, so the command below
> does not work today — see [Running it from a clone](#running-it-from-a-clone).

<!-- RELEASE CHECKLIST — do these together, in this order:
     1. npm publish  (the GitHub URL is the npm homepage, so the package must exist first)
     2. delete the "Not released yet" note above
     3. flip the repository to public
     Publishing after going public leaves this quick start broken for every visitor. -->

```bash
npm install -g iobroker-sync
```

```bash
mkdir ~/iobroker-scripts && cd ~/iobroker-scripts

iob-sync init      # asks for the URL and username, then verifies the connection
iob-sync login     # only if your instance has authentication enabled
iob-sync pull      # your scripts are now files in ./scripts

$EDITOR scripts/common/garage.ts
iob-sync status    # what changed
iob-sync push      # send it back
```

That is the whole loop. `git init` in that folder and your home automation has history.

The five commands worth knowing on day one:

|                   |                                                                           |
| ----------------- | ------------------------------------------------------------------------- |
| `iob-sync pull`   | bring the server's scripts down                                           |
| `iob-sync status` | what differs, locally and remotely                                        |
| `iob-sync push`   | send your edits up                                                        |
| `iob-sync logs`   | watch script output — **this is how you find out a push actually worked** |
| `iob-sync backup` | snapshot everything before you touch something important                  |

## Contents

- [Why this exists](#why-this-exists)
- [iobroker-sync or the VS Code extension?](#iobroker-sync-or-the-vs-code-extension)
- [Where things live](#where-things-live)
- [How scripts map to files](#how-scripts-map-to-files)
- [The edit loop](#the-edit-loop)
- [Commands](#commands)
- [Patterns](#patterns)
- [Safety model](#safety-model)
- [Authentication](#authentication)
- [Scripting and automation](#scripting-and-automation)
- [Known limitations](#known-limitations)
- [Development](#development)

## Why this exists

Scripts that run a house are production code. They deserve the same treatment as any
other production code, and the Admin UI cannot give it to them:

- **No history.** A script edited in the web UI has no previous version. If you break
  something at 23:00, there is nothing to go back to.
- **No review.** No diffs, no branches, no way to see what changed and when.
- **One editor, and it's a textarea in a browser.** No LSP, no vim bindings, no
  multi-file search, no refactoring.
- **Nothing can automate it.** No backup job, no CI check, no deployment from a
  pipeline, no coding agent.

Once the scripts are files, all of that comes free from tools you already have.

## iobroker-sync or the VS Code extension?

The [ioBroker JavaScript VS Code extension](https://github.com/nokxs/iobroker-javascript-vs-code-extension)
by nokxs solves the same core problem and inspired this tool. If you work in VS Code, it
is genuinely good and does things a CLI cannot — go use it.

|                                       | iobroker-sync       | VS Code extension |
| ------------------------------------- | ------------------- | ----------------- |
| Editor                                | any, or none        | VS Code           |
| State-ID autocompletion, hover values | —                   | yes               |
| Script tree, buttons, context menus   | — (`iob-sync list`) | yes               |
| Works over SSH, in CI, headless       | yes                 | —                 |
| Machine-readable output               | yes                 | —                 |
| Scriptable from a shell or an agent   | yes                 | —                 |

Rough rule: **if you live in VS Code, use the extension.** If you want your own editor, a
git-first workflow, or anything automated, use this. They are not exclusive — both talk
to the same Admin API, and this tool never writes fields it does not own.

## Where things live

`iob-sync` is a global command that works on a **project folder** — the folder holding
`.iobroker-sync.json`. Where the tool itself is installed is irrelevant; nothing is ever
read from or written to `node_modules`.

```
~/iobroker-scripts/            <- project root: run iob-sync anywhere inside it
├── .iobroker-sync.json        <- config. Commit it; it holds no password.
├── .iobroker-sync/            <- state, backups, trash. Gitignored; may contain secrets.
└── scripts/                   <- scriptRoot: your scripts land here
    ├── common/garage.ts
    └── Switch-Musiccast.js
```

Commands search upward from the current directory for `.iobroker-sync.json`, the way
`git` finds `.git` — so you can run them from any subfolder. `-C <dir>` runs as if
started somewhere else.

**`scriptRoot` is relative to the project root and cannot escape it.** Absolute paths and
`../` are rejected: it is the directory the tool writes into, so a config that pointed
outside could drop files anywhere on your disk.

That means you do not point an existing project at a scripts folder elsewhere — you run
`init` **in** the folder you want to keep scripts in:

```bash
cd ~/iobroker-scripts     # your git repo
iob-sync init             # config lands here, scriptRoot defaults to "scripts"
```

Your password is **not** stored here. It lives in
`~/.config/iobroker-sync/credentials.json` — see [Authentication](#authentication).

### Pointing scriptRoot at a folder that already has files

Safe, but worth knowing: if a script would land on top of a file you already have, and
the two differ, `pull` reports a **conflict** and leaves your file alone. Use `--force`
to take the server's copy. Identical files are adopted silently.

Setting `scriptRoot` to `.` (the project root itself) works, but then scripts land beside
your `README.md` and `package.json`. A subfolder is tidier and keeps `status` output
meaningful.

## How scripts map to files

| ioBroker object                                | local file                    |
| ---------------------------------------------- | ----------------------------- |
| `script.js.common.garage` (`TypeScript/ts`)    | `scripts/common/garage.ts`    |
| `script.js.Switch-Musiccast` (`Javascript/js`) | `scripts/Switch-Musiccast.js` |

Script folders are ioBroker `channel` objects; nested folders map to nested directories.
`Blockly` and `Rules` scripts are pulled as `.block` / `.rules` for completeness, but their
sources are generated XML/JSON and are not meant to be hand-edited.

### Editor support

Straight after a `pull`, an editor will not know what `log`, `schedule`, `on` or
`getState` are — they exist only inside the javascript adapter's sandbox, so every script
shows "Cannot find name 'log'". Fix it once:

```bash
iob-sync types
```

That downloads the adapter's own typings to `.iobroker/types/` and writes
`<scriptRoot>/tsconfig.json` so any LSP client — neovim, VS Code, Helix, Zed — picks them
up. **Restart your language server afterwards.** `init --types` does the same thing during
setup; `iob-sync types` exists so you can add or refresh them later without touching a
working config.

Re-run it whenever the adapter gains functions you want typed. `--force` replaces an
existing `tsconfig.json`, `--offline` skips the download.

If you see `Cannot find namespace 'NodeJS'`, the typings reference Node's own types:

```bash
npm install --save-dev @types/node
```

The generated config sets `moduleDetection: force` deliberately. Each ioBroker script
runs in its own sandbox scope, but to TypeScript a folder of plain scripts shares one
global scope — so two scripts each declaring `const helper` would collide with TS2451,
an error about code that is perfectly fine at runtime. Module semantics give every file
its own scope, matching how the adapter actually runs them.

## The edit loop

For a live loop, let it push as you save:

```bash
iob-sync watch          # pushes on save; --pull also applies remote changes
```

**`push` only tells you the source was uploaded.** The javascript adapter compiles it
afterwards, so a syntax error or a throw on load appears in the ioBroker log and nowhere
else. Watch it from a second terminal:

```bash
iob-sync logs                  # everything, info and above
iob-sync logs garage           # only lines mentioning "garage"
iob-sync logs --level error    # only failures
```

## Commands

**Sync**

| Command            | Description                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`             | Write `.iobroker-sync.json`, verify the connection, create the script folder. Asks interactively when run without flags. `--types` also sets up TypeScript definitions. |
| `types`            | Set up editor intellisense (`log`, `schedule`, ...). `--force`, `--offline`.                                                                                            |
| `login` / `logout` | Save or remove the password for this instance. Never stored in the project.                                                                                             |
| `pull [pattern]`   | Download scripts to disk. Never deletes local files.                                                                                                                    |
| `push [pattern]`   | Upload locally modified scripts. Never deletes remote objects.                                                                                                          |
| `status`           | Show what changed, locally and remotely.                                                                                                                                |
| `diff [pattern]`   | Unified diff of local vs server. `--against <snapshot>` compares with a backup instead.                                                                                 |
| `watch`            | Push on save. `--pull` also applies remote changes.                                                                                                                     |
| `logs [pattern]`   | Stream the server log. `--level`, `--limit`. Read-only.                                                                                                                 |
| `backup [pattern]` | Snapshot every script — source _and_ full object — to `.iobroker-sync/backup/<timestamp>/`. Read-only against the server.                                               |

**Lifecycle**

| Command                                  | Description                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `list`                                   | All scripts with instance and enabled state.                                                                      |
| `start` / `stop` / `restart` `<pattern>` | Toggle `common.enabled`.                                                                                          |
| `new <path>`                             | Create a new script (disabled) plus any missing folders.                                                          |
| `rename` / `move` / `remove`             | Destructive. Require `--yes` and back up the object first. `remove` keeps the local file unless `--delete-local`. |

`--dry-run`, `--verbose`, `--json` and `-C <dir>` are global options and work with every
command. When in doubt, `--dry-run` shows what would happen and changes nothing.

## Patterns

Patterns are matched case-insensitively against both the ioBroker id and the local path.
A pattern without `*` matches as a substring (`iob-sync diff garage`), while one
containing `*` is an anchored glob (`iob-sync status 'common/*.ts'`).

## Safety model

This tool talks to a live home-automation system, and is deliberately conservative about
destroying work:

- **`pull` never deletes local files, and never silently overwrites one.** A script
  removed on the server shows up in `status` as `remote-missing`; what to do is your
  call. A script that would land on top of an existing untracked file is reported as a
  conflict rather than written over it.
- **`push` never deletes remote objects**, and writes only `common.source` and
  `common.engineType`. It _cannot_ disable a running script or move it to a different
  javascript instance, because it never sends those fields — a sync bug structurally
  cannot stop your heating.
- **Conflicts block.** A manifest at `.iobroker-sync/state.json` records the source hash at
  last sync, so the tool distinguishes "you changed it", "the server changed it", and "both
  changed" — the last refuses to push without `--force`.
- **Deletion is always explicit.** Only `remove`, `rename` and `move` delete anything, all
  require `--yes`, and each writes the full object JSON to `.iobroker-sync/trash/` first.
- **`backup` gives you a restore point.** Run it before editing anything that matters:

  ```bash
  iob-sync backup
  # ...edit, break something...
  iob-sync diff --against latest        # what did I change since the snapshot?
  cp .iobroker-sync/backup/<timestamp>/sources/common/garage.ts scripts/common/garage.ts
  iob-sync push common/garage.ts
  ```

  The snapshot also stores each full object, because `push` writes only `common.source`
  and `common.engineType` — so `objects/*.json` is the only record of which javascript
  instance a script ran on and whether it was enabled. Snapshots live under the gitignored
  `.iobroker-sync/`, since they hold whatever secrets the live scripts do.

## Authentication

Instances with authentication disabled need no setup at all.

Otherwise, ioBroker will not accept a password over plain HTTP, so an authenticated
instance is also on HTTPS — usually with a self-signed certificate. Set
`allowSelfSigned: true` (interactive `init` offers this automatically) and save a
password once:

```bash
iob-sync login       # prompts without echoing, verifies, then saves
```

**Your password is never stored in the project.** `.iobroker-sync.json` holds only the
username. The password goes to `~/.config/iobroker-sync/credentials.json`, mode `0600`
in a `0700` directory, outside your repo. `iob-sync logout` removes it.

There is deliberately **no `--password` flag**: argv is visible to other local processes
via `ps` and is recorded in shell history. The alternatives, in the order they are tried:

| Source              | Use                                                                    |
| ------------------- | ---------------------------------------------------------------------- |
| `--password-stdin`  | scripts and CI: `printf '%s' "$PW" \| iob-sync --password-stdin login` |
| `IOBROKER_PASSWORD` | ad-hoc shells                                                          |
| saved credentials   | normal interactive use, after `iob-sync login`                         |
| hidden prompt       | when nothing else is available and a terminal is attached              |

OAuth2 (`/oauth/token`) is tried first, falling back to the legacy `/login` endpoint.
`--verbose` reports which path was used.

Connect to the **admin adapter** port (usually 8081), not the socket.io adapter port
(8084) — the latter lacks the permissions this tool needs.

## Scripting and automation

Human output is for reading; `--json` is for everything else. It emits
[NDJSON](https://ndjson.org) on stdout — one JSON object per line, each tagged with a
`type`. Human text is suppressed and warnings/errors stay on stderr, so **stdout stays
parseable even when a command fails**.

What that is actually for:

```bash
# Fail a CI job if anything drifted from git
test -z "$(iob-sync --json status | jq -rc 'select(.state != "in-sync")')"

# Alert if a script got disabled behind your back
iob-sync --json list | jq -r 'select(.enabled | not) | .id'

# Nightly backup, reporting where the snapshot went
iob-sync --json backup | jq -r .snapshot

# Follow only errors, as structured events
iob-sync --json logs --level error
```

It is also what makes the tool usable by a coding agent: an agent editing your scripts
can read `status`, push, and then watch `logs` for a compile failure, without
screen-scraping a table meant for a terminal.

Records carry underlying values rather than display strings — `enabled` is a boolean, not
`"✓"`; `engine` is the full instance id, not `js.2`; and `--json status` includes the
in-sync scripts the human view collapses into a count. NDJSON rather than one array
because `logs` and `watch` never end; use `jq -s .` if you want a single document.

## Known limitations

- **Verified against Admin 7.x only.** Older Admin versions are likely to work — the
  legacy login path exists for them — but the wire protocol has not been checked
  against them. The legacy `/login` fallback itself is covered by tests but has never
  run against real hardware, since current Admin uses OAuth2.
- **Self-signed certificates** are accepted only when `allowSelfSigned` is set. There is
  no way to pin a specific certificate.
- **`Blockly` and `Rules` scripts** are pulled for completeness but their sources are
  generated; editing them by hand is not supported.
- **Scripts cannot be typechecked as one program.** Each ioBroker script runs in its own
  sandbox scope, so a single `tsc` run reports false collisions between top-level names
  in different scripts. `init --types` generates a config for editor intellisense; check
  scripts one program per file.
- Sources are normalised to LF before hashing and upload.

## Development

### Running it from a clone

Until the package is on npm, this is how to try it:

```bash
git clone https://github.com/mschmicking/iobroker-sync
cd iobroker-sync
npm install
npm run build
npm link            # puts `iob-sync` on your PATH from your working copy
```

**Then leave this directory.** `iob-sync` operates on whatever folder you run it in, so
`init` belongs in your _scripts_ folder, not in the clone:

```bash
cd ~/iobroker-scripts     # your own folder — create it if it does not exist
iob-sync init
iob-sync pull
```

Running `init` inside the clone makes the tool's own repository the project root, and
`scriptRoot` cannot point outside it — so there is no way to reach scripts kept
elsewhere. If you have already done that, delete the stray `.iobroker-sync.json`,
`.iobroker-sync/` and `scripts/` from the clone and start again in the right folder.

If you prefer not to `npm link`, call the built entry point directly and let `-C` choose
the project:

```bash
node /path/to/iobroker-sync/dist/cli.js -C ~/iobroker-scripts list
```

### Working on the tool

```bash
npm test            # full suite
npm run test:unit   # pure-logic tests only
npm run lint
npm run verify      # lint + format check + typecheck + tests
```

Every test runs against an in-process fake Admin server (`test/fake-server.ts`); none
touches a real instance. `AGENTS.md` documents the architecture, the wire protocol, and
the safety invariants any change has to preserve — read it before changing sync logic.

## License

MIT — see [LICENSE](LICENSE).
