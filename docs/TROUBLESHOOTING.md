# Troubleshooting

Things that look like bugs and are not. See the [README](../README.md) for the overview.

**Start with `iob-sync doctor`.** It checks the config, the certificate, the login, the
connection and a live round-trip, and names the one that is wrong — including the two
cases below, which are the ones that reliably send people down the wrong path. It is
read-only and never prompts, so it is safe to run at any time.

## Commands time out, but the connection "works"

Symptom: `___ready___` arrives, the socket reports connected, and then every request
fails with `Request "getObject" timed out after 20000ms.`

The session is not authenticated. ioBroker Admin does not answer an unauthenticated
command with an error — it accepts the connection, sends `___ready___`, and then
ignores the command entirely. There is nothing to find in the log, because nothing
went wrong at the transport layer.

Usually this means the stored password is stale (`iob-sync login` replaces it) or the
session expired during a long-running `watch`. It also happens to anyone driving
`AdminSocketClient` from their own code without an auth cookie: **iob-sync is a CLI,
not a library** — there is no supported import path, and the wiring the commands rely
on (certificate check, then cookie, then socket) lives in `withContext` in
`src/cli.ts`. A client constructed without `cookie`, `allowSelfSigned` and
`certFingerprint` connects perfectly and then does nothing.

## `certificate has expired` from other tools on the same port

`iob-sync` keeps working while every other client refuses to connect. Both are correct.

A home ioBroker signs its own certificate, typically for one year, and nothing renews
it. With `allowSelfSigned` the chain is not what establishes identity here — the pinned
SHA-256 fingerprint is (see [AUTHENTICATION.md](AUTHENTICATION.md)) — and an expired
certificate signs exactly as well as a fresh one. Anything validating the chain the
normal way rejects it.

`iob-sync doctor` reports this as OK with a note rather than as a fault. To make the
other tools happy, regenerate the certificate on the instance and then run
`iob-sync trust` to accept the new fingerprint.

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

## "The TLS certificate has changed"

Commands stop before sending anything, and print the pinned fingerprint next to the one
the server presented.

If you reinstalled ioBroker or regenerated its certificate, this is expected — run
`iob-sync trust` to accept the new one (`--yes` when unattended). If you did **not**
change anything on the server, do not accept it: something is answering in its place.

To start over from scratch, delete the `certFingerprint` line from
`.iobroker-sync.json`; the next connection records whatever it finds.
