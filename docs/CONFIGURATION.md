# Configuration

Where files live, how ioBroker ids map to paths, and how to give your editor
intellisense. See the [README](../README.md) for the overview.

## The project folder

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
`git` finds `.git`, so you can run them from any subfolder. `-C <dir>` runs as if started
somewhere else.

## `.iobroker-sync.json`

| Field             | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `url`             | Admin base URL including scheme and port, e.g. `https://host:8081`    |
| `scriptRoot`      | Folder for synced scripts, relative to the project root               |
| `allowSelfSigned` | Accept an untrusted TLS certificate                                   |
| `certFingerprint` | Optional. SHA-256 of the certificate to expect; recorded on first use |
| `username`        | Admin username, or `null` when authentication is disabled             |
| `defaultInstance` | javascript instance assigned to newly created scripts                 |

Commit this file — it holds no password. Credentials live outside the project entirely;
see [AUTHENTICATION.md](AUTHENTICATION.md). A certificate fingerprint is public
information, not a secret, so committing it is fine and makes the pin reviewable.

`certFingerprint` is written for you the first time you connect to an `allowSelfSigned`
instance; you never need to type it. Configs written before it existed keep working.

## `scriptRoot` cannot escape the project

Absolute paths and `../` are rejected. `scriptRoot` is the directory the tool writes
into, so a config pointing outside could drop files anywhere on your disk.

This means you do not point an existing project at a scripts folder elsewhere — you run
`init` **in** the folder you want to keep scripts in:

```bash
cd ~/iobroker-scripts     # your git repo
iob-sync init             # config lands here, scriptRoot defaults to "scripts"
```

### If that folder already contains files

Safe, but worth knowing: when a script would land on top of a file you already have and
the two differ, `pull` reports a **conflict** and leaves your file alone. `--force` takes
the server's copy. Identical files are adopted silently.

Setting `scriptRoot` to `.` works, but scripts then land beside your `README.md` and
`package.json`. A subfolder is tidier and keeps `status` output readable.

## How ids map to files

| ioBroker object                                | local file                    |
| ---------------------------------------------- | ----------------------------- |
| `script.js.common.garage` (`TypeScript/ts`)    | `scripts/common/garage.ts`    |
| `script.js.Switch-Musiccast` (`Javascript/js`) | `scripts/Switch-Musiccast.js` |

Script folders are ioBroker `channel` objects; nested folders map to nested directories.
`Blockly` and `Rules` scripts are pulled as `.block` / `.rules` for completeness, but
their sources are generated XML/JSON and are not meant to be hand-edited.

Sources are normalised to LF before hashing and upload, so a CRLF checkout does not show
every script as modified.

## Patterns

Patterns match case-insensitively against both the ioBroker id and the local path. A
pattern without `*` matches as a substring (`iob-sync diff garage`); one containing `*`
is an anchored glob (`iob-sync status 'common/*.ts'`).

## Editor support

Straight after a `pull` an editor does not know what `log`, `schedule`, `on` or
`getState` are — they exist only inside the javascript adapter's sandbox, so every script
shows `Cannot find name 'log'`. Fix it once:

```bash
iob-sync types
```

That downloads the adapter's own typings to `.iobroker/types/` and writes
`<scriptRoot>/tsconfig.json`, so any LSP client — neovim, VS Code, Helix, Zed — picks
them up. **Restart your language server afterwards.**

`init --types` does the same during setup. `iob-sync types` exists so you can add or
refresh them later without touching a working config. `--force` replaces an existing
`tsconfig.json`; `--offline` skips the download.

### Why the generated config sets `moduleDetection: force`

Each ioBroker script runs in its own sandbox scope, but to TypeScript a folder of plain
scripts shares one global scope — so two scripts each declaring `const helper` would
collide with TS2451, an error about code that is perfectly fine at runtime. Module
semantics give every file its own scope, matching how the adapter actually runs them.
`module`/`target` are `es2022` rather than `commonjs` because the adapter permits
top-level `await`, which commonjs rejects with TS1378.
