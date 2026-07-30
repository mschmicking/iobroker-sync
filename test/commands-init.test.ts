/**
 * Tests for `init --types`.
 *
 * The regression that motivated these: `init --types` used to merge its settings
 * into whatever `tsconfig.json` sat at the project root. Run inside a repo that
 * already had a build config, that injected `scripts/**` into a config owning
 * `rootDir`/`outDir` and broke the build with TS6059. The scripts config must be
 * written to the script root and must never touch a root tsconfig.json.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { runInit } from '../src/commands/init';
import { UserError } from '../src/types';
import { makeCapturingLogger, makeTempProject } from './helpers';

/** A stand-in for a real build config: owns rootDir/outDir, must survive untouched. */
const ROOT_TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: { rootDir: 'src', outDir: 'dist', strict: true },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  ) + '\n';

// Unroutable port, so probeConnection fails fast and just warns.
const DEAD_URL = 'http://127.0.0.1:1';

describe('init --types', () => {
  it('leaves an existing root tsconfig.json byte-identical', async () => {
    const project = await makeTempProject();
    try {
      const rootTsconfig = path.join(project.root, 'tsconfig.json');
      await fs.writeFile(rootTsconfig, ROOT_TSCONFIG, 'utf8');

      const { log } = makeCapturingLogger();
      await runInit(project.root, { url: DEAD_URL, types: true }, log);

      assert.equal(
        await fs.readFile(rootTsconfig, 'utf8'),
        ROOT_TSCONFIG,
        'root tsconfig.json must not be rewritten',
      );
    } finally {
      await project.cleanup();
    }
  });

  it('writes the scripts config into the script root, not the project root', async () => {
    const project = await makeTempProject();
    try {
      const { log } = makeCapturingLogger();
      await runInit(project.root, { url: DEAD_URL, types: true }, log);

      const raw = await fs.readFile(path.join(project.root, 'scripts', 'tsconfig.json'), 'utf8');
      const cfg = JSON.parse(raw);

      // noEmit is what keeps rootDir out of the picture entirely.
      assert.equal(cfg.compilerOptions.noEmit, true);
      assert.equal(cfg.compilerOptions.checkJs, true);
      assert.equal(cfg.compilerOptions.allowJs, true);

      // The types live at the project root, one hop up from the script root.
      assert.ok(
        cfg.include.includes('../.iobroker/types/**/*.d.ts'),
        `expected a ../ types include, got ${JSON.stringify(cfg.include)}`,
      );
      assert.ok(cfg.include.includes('**/*.ts'));
      assert.ok(cfg.include.includes('**/*.js'));
    } finally {
      await project.cleanup();
    }
  });

  it('resolves the types path for a nested script root', async () => {
    const project = await makeTempProject();
    try {
      const { log } = makeCapturingLogger();
      await runInit(project.root, { url: DEAD_URL, types: true, scriptRoot: 'a/b' }, log);

      const raw = await fs.readFile(path.join(project.root, 'a', 'b', 'tsconfig.json'), 'utf8');
      const cfg = JSON.parse(raw);
      assert.ok(
        cfg.include.includes('../../.iobroker/types/**/*.d.ts'),
        `expected a ../../ types include, got ${JSON.stringify(cfg.include)}`,
      );
    } finally {
      await project.cleanup();
    }
  });

  it('does not clobber an existing scripts tsconfig.json without --force', async () => {
    const project = await makeTempProject();
    try {
      const scriptsTsconfig = path.join(project.root, 'scripts', 'tsconfig.json');
      const mine = '{ "compilerOptions": { "strict": true } }\n';
      await fs.writeFile(scriptsTsconfig, mine, 'utf8');

      const { log, captured } = makeCapturingLogger();
      await runInit(project.root, { url: DEAD_URL, types: true }, log);

      assert.equal(await fs.readFile(scriptsTsconfig, 'utf8'), mine);
      assert.ok(
        captured.warn.some((m) => m.includes('already exists')),
        'expected a warning that the existing config was kept',
      );
    } finally {
      await project.cleanup();
    }
  });
});

describe('init config and secrets', () => {
  it('never writes a password into the project config', async () => {
    const project = await makeTempProject();
    const previous = process.env.IOBROKER_PASSWORD;
    process.env.IOBROKER_PASSWORD = 'sup3r-s3cret-passphrase';
    try {
      const { log } = makeCapturingLogger();
      await runInit(project.root, { url: DEAD_URL, username: 'admin', interactive: false }, log);

      // The config lives in the user's git repo. The username belongs there; the
      // password belongs in the 0600 store outside it (see src/credentials.ts).
      const raw = await fs.readFile(path.join(project.root, '.iobroker-sync.json'), 'utf8');
      assert.doesNotMatch(raw, /sup3r-s3cret-passphrase/);
      assert.doesNotMatch(raw, /password/i);
      assert.match(raw, /"username": "admin"/);
    } finally {
      if (previous === undefined) delete process.env.IOBROKER_PASSWORD;
      else process.env.IOBROKER_PASSWORD = previous;
      await project.cleanup();
    }
  });

  it('records allowSelfSigned so an https instance can be reached at all', async () => {
    const project = await makeTempProject();
    try {
      const { log } = makeCapturingLogger();
      await runInit(
        project.root,
        { url: 'https://iobroker.example:8081', allowSelfSigned: true, interactive: false },
        log,
      );

      const raw = await fs.readFile(path.join(project.root, '.iobroker-sync.json'), 'utf8');
      assert.match(raw, /"allowSelfSigned": true/);
    } finally {
      await project.cleanup();
    }
  });

  it('gitignores the state directory, which holds backup snapshots of live scripts', async () => {
    const project = await makeTempProject();
    try {
      await fs.writeFile(path.join(project.root, '.gitignore'), 'node_modules/\n', 'utf8');

      const { log } = makeCapturingLogger();
      await runInit(project.root, { url: DEAD_URL, interactive: false }, log);

      const gitignore = await fs.readFile(path.join(project.root, '.gitignore'), 'utf8');
      assert.match(gitignore, /^\.iobroker-sync\/$/m);
      assert.match(gitignore, /node_modules\//, 'existing entries must survive');
    } finally {
      await project.cleanup();
    }
  });

  it('does not duplicate an existing gitignore entry', async () => {
    const project = await makeTempProject();
    try {
      await fs.writeFile(path.join(project.root, '.gitignore'), '.iobroker-sync/\n', 'utf8');

      const { log } = makeCapturingLogger();
      await runInit(project.root, { url: DEAD_URL, interactive: false }, log);

      const gitignore = await fs.readFile(path.join(project.root, '.gitignore'), 'utf8');
      const occurrences = gitignore
        .split('\n')
        .filter((l) => l.trim() === '.iobroker-sync/').length;
      assert.equal(occurrences, 1);
    } finally {
      await project.cleanup();
    }
  });

  it('fails with a usable message when there is no url and no terminal', async () => {
    const project = await makeTempProject();
    try {
      const { log } = makeCapturingLogger();
      await assert.rejects(
        () => runInit(project.root, { interactive: false }, log),
        (err: unknown) => {
          assert.ok(err instanceof UserError);
          assert.match(err.message, /no --url/i);
          return true;
        },
      );
    } finally {
      await project.cleanup();
    }
  });
});
