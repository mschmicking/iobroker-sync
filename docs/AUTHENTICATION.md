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

`allowSelfSigned` applies to both the HTTPS login and the websocket. It accepts any
certificate; there is no way to pin a specific one. Without it, an untrusted certificate
fails before any credential is sent, and the error names the setting that fixes it.
