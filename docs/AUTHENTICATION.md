# Authentication

How `iob-sync` gets a password, and why it refuses to take one on the command line. See
the [README](../README.md) for the overview.

## Instances without authentication

Nothing to do. `iob-sync` probes `<url>/login`; a 404 means authentication is disabled
and no credential is needed.

## Instances with authentication

ioBroker will not accept a password over plain HTTP, so an authenticated instance is
also on HTTPS — usually with a self-signed certificate. Set `allowSelfSigned: true`
(interactive `init` offers this automatically), then save a password once:

```bash
iob-sync login       # prompts without echoing, verifies, then saves
```

`login` checks the password against the live instance **before** storing it, so a typo
fails immediately rather than on the next command. `iob-sync logout` removes it.

## Where the password is kept

**Never in the project.** `.iobroker-sync.json` holds only the username. The password
goes to `~/.config/iobroker-sync/credentials.json`, mode `0600` inside a `0700`
directory, keyed by URL and username so several instances can be used from one machine.

Override the location with `IOBROKER_SYNC_CREDENTIALS` — the test suite does this so it
never touches a real store.

## There is no `--password` flag

Deliberately. `argv` is readable by any other local process via `ps`, and shells record
it in history. The sources actually supported, in the order they are tried:

| Source              | Use                                                                    |
| ------------------- | ---------------------------------------------------------------------- |
| `--password-stdin`  | scripts and CI: `printf '%s' "$PW" \| iob-sync --password-stdin login` |
| `IOBROKER_PASSWORD` | ad-hoc shells                                                          |
| saved credentials   | normal interactive use, after `iob-sync login`                         |
| hidden prompt       | when nothing else is available and a terminal is attached              |

Prompts require stdin **and** stdout to be TTYs, so a script, CI job or agent gets a
clear error instead of hanging on an invisible prompt.

## Which login path is used

OAuth2 (`POST /oauth/token`) is tried first, falling back to the legacy `POST /login`
session cookie used by older Admin versions. `--verbose` reports which one worked and
where the password came from:

```
debug: authenticated via OAuth2 (/oauth/token), password from store
```

The legacy path is covered by tests but has never run against real hardware — current
Admin authenticates via OAuth2.

## Ports and certificates

Connect to the **admin adapter** port, usually 8081 — not the socket.io adapter port
(8084), which lacks the permissions this tool needs.

`allowSelfSigned` applies to both the HTTPS login and the websocket. Without it, an
untrusted certificate fails before any credential is sent, and the error names the
setting that fixes it.

### The certificate is pinned

Switching off certificate validation would otherwise mean the tool sends your password
to anything answering on that address. So the certificate is remembered instead:

1. On the first connection its SHA-256 fingerprint is written to `certFingerprint` in
   `.iobroker-sync.json` and reported once. Nothing to type, nothing to look up.
2. Every connection after that must present the same certificate.
3. If it changes, you are asked before anything is sent — and in a script or CI job,
   where there is nobody to ask, the command fails instead.

This is what `ssh` does with `known_hosts`, including the weak spot: the _first_
connection is trusted blindly. On a network you do not trust, verify the fingerprint
against the server before the first run.

A certificate normally changes only because ioBroker was reinstalled or its certificate
regenerated. To accept the new one:

```bash
iob-sync trust          # shows the fingerprint and asks
iob-sync trust --yes    # no prompt, for unattended use
```
