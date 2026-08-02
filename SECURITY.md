# Security policy

`iobroker-sync` connects to a live ioBroker instance with credentials and writes files
derived from server-controlled identifiers. Security reports are welcome.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private reporting:

**[Report a vulnerability](https://github.com/mschmicking/iobroker-sync/security/advisories/new)**
— Security → Advisories → Report a vulnerability.

This is a spare-time project maintained by one person. Realistic expectations:

- Acknowledgement within about a week.
- A fix for anything that exposes credentials or writes outside the script root gets
  priority over everything else.
- I will tell you plainly if I think something is not a vulnerability, and why.

Credit in the advisory and the changelog if you would like it.

## Supported versions

| Version        | Supported    |
| -------------- | ------------ |
| latest `1.x`   | ✅           |
| anything older | ❌ — upgrade |

Fixes ship as a new release rather than as patches to old versions.

## Where the risk actually is

If you are looking for somewhere to start:

- **`src/credentials.ts`** — password storage. Written to
  `~/.config/iobroker-sync/credentials.json`, mode `0600` in a `0700` directory, via
  temp-file-and-rename.
- **`src/sync/safe-path.ts`** — server-controlled ioBroker ids become local file paths.
  Guards against traversal, symlinked files and symlinked directories.
- **`src/client/auth.ts`** — OAuth2 and legacy login, TLS handling.
- **`src/client/tls.ts`** — certificate pinning. The check that replaces CA validation
  when `allowSelfSigned` is on, and the thing standing between the stored password and
  whatever is answering on that address.
- **`src/commands/backup.ts`** — snapshots contain whatever secrets the live scripts do,
  and land under the gitignored `.iobroker-sync/`.

## Deliberate decisions that are not bugs

These are known trade-offs, documented so they need not be re-reported:

- **The stored password is not encrypted.** It is a `0600` file in a `0700` directory
  outside the project. There is no portable OS keychain across Linux, macOS, Windows and
  Termux, and the realistic alternative — an environment variable — is worse: it leaks
  into shell history and into the environment of every child process.
- **There is no `--password` flag.** `argv` is readable by any local process via `ps` and
  is recorded in shell history. Use `--password-stdin`, `IOBROKER_PASSWORD`, the saved
  credential, or the interactive prompt.
- **`allowSelfSigned` turns off CA validation, and the first connection is trusted
  blindly.** The flag exists because ioBroker refuses passwords over plain HTTP, so
  authenticated instances are HTTPS with a self-signed certificate. Identity then comes
  from the pinned fingerprint in `certFingerprint` instead (`src/client/tls.ts`):
  recorded on first use, verified on every connection afterwards, and a change stops the
  command before anything is sent. The residual weakness is the same one `ssh` has —
  an attacker already in position for the _very first_ connection is trusted and pinned.
  Verify the fingerprint out of band if that matters to you.
- **`push` cannot disable a script or move it between javascript instances.** It sends
  only `common.source` and `common.engineType`, enforced by the type of
  `ObjectsApi.extendScript`. This is a safety property, not an oversight.
- **Test fixtures contain password-shaped strings.** All fake — `secret`,
  `correct horse battery staple`, `fake-oauth-token`.

## What is genuinely worth reporting

- Anything that writes outside the configured script root.
- Anything that puts a password into a log line, an error message, `argv`, or the project
  directory.
- Anything that makes `push` write a field other than `common.source` and
  `common.engineType`.
- Anything that lets a malicious ioBroker server cause local code execution or
  arbitrary file writes.
- Any way to reach the network with credentials that skips the fingerprint check in
  `src/client/tls.ts`, or to make a mismatch continue rather than stop.
