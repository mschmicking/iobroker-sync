# Troubleshooting

Things that look like bugs and are not. See the [README](../README.md) for the overview.

## `logs` prints the banner and nothing else

It is streaming; there is simply nothing to show. Two things surprise people:

- **`--level` only narrows what the server already sends.** An ioBroker adapter emits
  nothing below _its own_ configured log level, so asking for `--level debug` while
  `javascript.0` runs at `info` produces silence. Raise it in
  **Admin → Instances → your javascript instance → log level**.
- **"script recompiled / started / stopped" are debug-level messages**, so at the default
  `info` the adapter never emits them at all — a `push` looks silent even though it
  worked. Your own `log()` calls are info-level and do appear.

To prove the stream is alive, run `iob-sync logs` and then any `iob-sync` command in a
second terminal: Admin logs every connection at info, so a line appears immediately.

## Every script shows `Cannot find name 'log'`

The ioBroker typings are not installed. Run `iob-sync types`, then **restart your
language server** — most LSP clients cache `tsconfig.json` for the session.

## `Cannot find namespace 'NodeJS'`

The ioBroker typings reference Node's own types:

```bash
npm install --save-dev @types/node
```

Run it in the project folder. `iob-sync types` warns about this and names the directory.

## `Config "scriptRoot" must not escape the project root`

`scriptRoot` is a folder _inside_ the project. You cannot point an existing project at a
scripts folder somewhere else — run `iob-sync init` in the folder you want the scripts
in, or use `-C <dir>` to work on a different project. See
[CONFIGURATION.md](CONFIGURATION.md).

The usual cause is running `init` inside a clone of this repository rather than in your
own scripts folder.

## `push` reports success but nothing changed on the server

`push` writes only `common.source` and `common.engineType`. If you expected it to enable
a script or move it to another javascript instance, it cannot — that is deliberate, so a
sync bug cannot stop a running script. Use `start` / `stop` for `enabled`; instance moves
must be done in Admin.

## A push is refused as a conflict

Local and remote both changed since the last sync. Inspect with `iob-sync diff`, then
either `pull --force` to take the server's copy or `push --force` to take yours. Run
`iob-sync backup` first if the script matters.

## `pull` refuses to overwrite a file

A script would land on a file you already have, and nothing records that the two are
related. Your file is left alone. `pull --force` takes the server's copy; identical files
are adopted silently.

## Connection fails on an HTTPS instance

Set `"allowSelfSigned": true` in `.iobroker-sync.json`. Home instances almost always use
a self-signed certificate, and the failure happens during the TLS handshake — before any
credential is sent.

Also check you are on the **admin** adapter port (usually 8081), not the socket.io port
(8084).
