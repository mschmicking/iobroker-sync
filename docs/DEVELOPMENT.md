# Development

Running `iob-sync` from a clone, and working on the tool itself. See the
[README](../README.md) for what it does.

## Running it from a clone

Until the package is on npm, this is how to try it:

```bash
git clone https://github.com/mschmicking/iobroker-sync
cd iobroker-sync
npm install
npm run build
npm link            # puts `iob-sync` on your PATH from your working copy
```

**Then leave this directory.** `iob-sync` operates on whatever folder you run it in, so
`init` belongs in your _scripts_ folder, not in the clone:

```bash
cd ~/iobroker-scripts     # your own folder — create it if it does not exist
iob-sync init
iob-sync pull
```

Running `init` inside the clone makes the tool's own repository the project root, and
`scriptRoot` cannot point outside it — so there is no way to reach scripts kept
elsewhere. If you have already done that, delete the stray `.iobroker-sync.json`,
`.iobroker-sync/` and `scripts/` from the clone and start again in the right folder.

If you would rather not `npm link`, call the built entry point directly and let `-C`
choose the project:

```bash
node /path/to/iobroker-sync/dist/cli.js -C ~/iobroker-scripts list
```

## Working on the tool

```bash
npm test            # build + full suite
npm run test:unit   # pure-logic tests only
npm run lint
npm run format
npm run verify      # lint + format check + typecheck + tests
```

`npm test` builds `dist/` as well as `dist-test/`, because `test/cli.test.ts` spawns the
real binary.

Every test runs against an in-process fake Admin server (`test/fake-server.ts`); **no
test may touch a real instance.** The TLS suite generates a self-signed certificate on
first run via `openssl` and caches it under `test/fixtures/`; without `openssl` it skips
rather than fails.

## Invariants the tests exist to protect

Do not weaken these without a deliberate decision:

- `pull` never deletes a local file, and never silently overwrites one.
- `push` sends only `common.source` and `common.engineType` — never `enabled` or
  `engine`. `ObjectsApi.extendScript` is typed to enforce it, so a sync bug structurally
  cannot stop a running script or move it between javascript instances.
- Conflicts refuse and exit non-zero rather than guessing.
- Only `remove`, `rename` and `move` delete anything; each needs `--yes` and writes the
  object to `.iobroker-sync/trash/` first.
- `watch` suppresses the adapter's own `compiled`/`sourceHash` write-back. A regression
  there means an infinite push loop against a live instance.

Commands never call `console.*` — output goes through `ctx.log`, which is what makes
`--json` and the tests possible. ESLint enforces this everywhere except `cli.ts`.

## Contributing

Pull request titles must be [conventional commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `chore:` …) — the title becomes the squashed commit message
and drives the version bump, and a workflow validates it. PRs are squash-merged.

**[AGENTS.md](../AGENTS.md)** has the full picture: the Admin wire protocol, why each
lint rule is on or off, and what is deliberately untested. Read it before changing sync
logic.
