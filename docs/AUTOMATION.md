# Scripting and automation

Machine-readable output, and what it is for. See the
[README](../README.md) for everything else.

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
