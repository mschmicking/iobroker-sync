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
iob-sync init --url http://192.168.1.13:8081 --types
iob-sync pull
$EDITOR scripts/common/garage.ts
iob-sync status
iob-sync push
```

For a live edit loop:

```bash
iob-sync watch          # pushes on save
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
| `init` | Write `.iobroker-sync.json`, verify the connection, create the script folder. `--types` also sets up `tsconfig.json` and ioBroker type definitions. |
| `pull [pattern]` | Download scripts to disk. Never deletes local files. |
| `push [pattern]` | Upload locally modified scripts. Never deletes remote objects. |
| `status` | Show what changed, locally and remotely. |
| `diff [pattern]` | Unified diff of local vs server. |
| `watch` | Push on save. `--pull` also applies remote changes. |

**Lifecycle**

| Command | Description |
| --- | --- |
| `list` | All scripts with instance and enabled state. |
| `start` / `stop` / `restart` `<pattern>` | Toggle `common.enabled`. |
| `new <path>` | Create a new script (disabled) plus any missing folders. |
| `rename` / `move` / `remove` | Destructive. Require `--yes` and back up the object first. `remove` keeps the local file unless `--delete-local`. |

`--dry-run`, `--verbose` and `-C <dir>` are global options and work with every command.

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

## Authentication

Instances with authentication disabled need no setup. Otherwise set `username` in the config
and export the password:

```bash
export IOBROKER_PASSWORD=...
```

OAuth2 (`/oauth/token`) is tried first, with a fallback to the legacy `/login` endpoint.

## Notes

Connect to the **admin adapter** port (usually 8081), not the socket.io adapter port (8084) —
the latter lacks the permissions this tool needs.

Sources are normalised to LF before hashing and upload.
