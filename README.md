# iobroker-sync

Sync ioBroker JavaScript/TypeScript scripts with a local folder, so you can edit them with
Claude Code, neovim, or any other editor instead of the Admin web UI.

Editor-agnostic CLI equivalent of the
[ioBroker JavaScript VS Code extension](https://github.com/nokxs/iobroker-javascript-vs-code-extension).

## Install

```bash
npm install
npm run build
npm link          # optional, puts `iob-sync` on your PATH
```

## Quick start

```bash
cd ~/my-iobroker-scripts
iob-sync init --url https://iobroker.local:8081 --types
iob-sync pull
$EDITOR scripts/common/garage.ts
iob-sync status
iob-sync push
```

For a live edit loop:

```bash
iob-sync watch          # pushes on save
```

`push` only reports that the source was uploaded — the javascript adapter compiles it
afterwards, so a syntax error or a throw on load shows up in the log, not in the push.
Watch it from a second terminal:

```bash
iob-sync logs                  # everything, info and above
iob-sync logs garage           # only lines mentioning "garage"
iob-sync logs --level error    # only failures
```

## How it maps

| ioBroker object | local file |
| --- | --- |
| `script.js.common.garage` (`TypeScript/ts`) | `scripts/common/garage.ts` |
| `script.js.Switch-Musiccast` (`Javascript/js`) | `scripts/Switch-Musiccast.js` |

Script folders are ioBroker `channel` objects; nested folders map to nested directories.
`Blockly` and `Rules` scripts are pulled as `.block` / `.rules` for completeness, but their
sources are generated XML/JSON and are not meant to be hand-edited.

## Commands

**Sync**

| Command | Description |
| --- | --- |
| `login` / `logout` | Save or remove the password for this instance. Never stored in the project. |
| `init` | Write `.iobroker-sync.json`, verify the connection, create the script folder. `--types` also sets up `tsconfig.json` and ioBroker type definitions. |
| `pull [pattern]` | Download scripts to disk. Never deletes local files. |
| `push [pattern]` | Upload locally modified scripts. Never deletes remote objects. |
| `status` | Show what changed, locally and remotely. |
| `diff [pattern]` | Unified diff of local vs server. `--against <snapshot>` compares with a backup instead. |
| `watch` | Push on save. `--pull` also applies remote changes. |
| `logs [pattern]` | Stream the server log. `--level`, `--limit`. Read-only. |
| `backup [pattern]` | Snapshot every script — source *and* full object — to `.iobroker-sync/backup/<timestamp>/`. Read-only against the server. |

**Lifecycle**

| Command | Description |
| --- | --- |
| `list` | All scripts with instance and enabled state. |
| `start` / `stop` / `restart` `<pattern>` | Toggle `common.enabled`. |
| `new <path>` | Create a new script (disabled) plus any missing folders. |
| `rename` / `move` / `remove` | Destructive. Require `--yes` and back up the object first. `remove` keeps the local file unless `--delete-local`. |

`--dry-run`, `--verbose`, `--json` and `-C <dir>` are global options and work with every
command.

### Machine-readable output

`--json` puts NDJSON on stdout — one JSON object per line, each tagged with a `type`.
Human text is suppressed, and warnings/errors stay on stderr, so stdout is always
parseable even when a command fails.

```bash
iob-sync --json status | jq 'select(.state != "in-sync") | .path'
iob-sync --json list   | jq -s 'map(select(.enabled)) | length'
iob-sync --json logs --level error
```

Records carry underlying values rather than display strings: `enabled` is a boolean,
`engine` is the full instance id, and `status` includes in-sync scripts that the human
view collapses to a count. NDJSON rather than one array because `logs` and `watch` never
end — use `jq -s .` if you want a single document.

Patterns are matched case-insensitively against both the ioBroker id and the local
path. A pattern without `*` matches as a substring (`iob-sync diff garage`), while
one containing `*` is an anchored glob (`iob-sync status 'common/*.ts'`).

## Safety model

This tool is deliberately conservative about destroying work:

- **`pull` never deletes local files.** A script removed on the server shows up in `status`
  as `remote-missing`; what to do about it is your call.
- **`push` never deletes remote objects**, and writes only `common.source` and
  `common.engineType`. It cannot disable a running script or move it to a different
  javascript instance, because it never sends those fields.
- **Conflicts block.** A manifest at `.iobroker-sync/state.json` records the source hash at
  last sync, so the tool distinguishes "you changed it", "the server changed it", and "both
  changed" — the last refuses to push without `--force`.
- **Deletion is always explicit.** Only `remove`, `rename` and `move` delete anything, all
  require `--yes`, and each writes the full object JSON to `.iobroker-sync/trash/` first.
- **`backup` gives you a restore point.** Run it before editing anything that matters:

  ```bash
  iob-sync backup
  # ...edit, break something...
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

| Source | Use |
| --- | --- |
| `--password-stdin` | scripts and CI: `printf '%s' "$PW" \| iob-sync --password-stdin login` |
| `IOBROKER_PASSWORD` | ad-hoc shells |
| saved credentials | normal interactive use, after `iob-sync login` |
| hidden prompt | when nothing else is available and a terminal is attached |

OAuth2 (`/oauth/token`) is tried first, falling back to the legacy `/login` endpoint.
`--verbose` reports which path was used.

## Notes

Connect to the **admin adapter** port (usually 8081), not the socket.io adapter port (8084) —
the latter lacks the permissions this tool needs.

Sources are normalised to LF before hashing and upload.

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
