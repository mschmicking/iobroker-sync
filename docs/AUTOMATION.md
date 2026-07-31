# Scripting and automation

Machine-readable output, and what it is for. See the [README](../README.md) for the
overview.

`--json` puts [NDJSON](https://ndjson.org) on stdout — one JSON object per line, each
tagged with a `type`. Human text is suppressed and warnings/errors stay on stderr, so
**stdout stays parseable even when a command fails**.

## What it is actually for

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
can read `status`, push, then watch `logs` for a compile failure, without screen-scraping
a table meant for a terminal.

## Record shapes

Every record carries a `type` discriminator. Records hold underlying values rather than
display strings — `enabled` is a boolean, not `"✓"`; `engine` is the full instance id,
not `js.2`.

| Command  | `type`   | Fields                                           |
| -------- | -------- | ------------------------------------------------ |
| `list`   | `script` | `id`, `path`, `engine`, `engineType`, `enabled`  |
| `status` | `status` | `id`, `path`, `state`                            |
| `pull`   | `pull`   | `id`, `path`, `dryRun`                           |
| `push`   | `push`   | `id`, `path`, `created`, `dryRun`                |
| `diff`   | `diff`   | `id`, `path`, `state`, `against` (snapshot mode) |
| `backup` | `backup` | `snapshot`, `createdAt`, `scripts`, `entries`    |
| `logs`   | `log`    | `message`, `severity`, `from`, `ts`              |

`--json status` includes the in-sync scripts that the human view collapses into a bare
count, so a consumer never has to re-run with `--verbose`.

`dryRun` is present on anything that would have written, so a consumer cannot mistake a
`--dry-run` rehearsal for a real change.

## Why NDJSON rather than one array

`logs` and `watch` never end. An array could never be closed, and nothing would appear
until the process exited. Line-at-a-time also means an agent watching stdout sees
progress as it happens.

Use `jq -s .` to slurp the stream into a single document when you want one:

```bash
iob-sync --json list | jq -s 'map(select(.enabled)) | length'
```

## Exit codes

`0` on success, `1` on a user-facing failure — a conflict needing `--force`, a missing
config, a failed login. Errors go to stderr as human text, never as NDJSON, so a non-zero
exit with empty stdout is unambiguous.
