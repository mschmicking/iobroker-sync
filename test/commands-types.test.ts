/**
 * Tests for `types`.
 *
 * The generated tsconfig is the whole point of the command, so the assertions are
 * about the two settings that make a folder of ioBroker scripts checkable at all:
 * module semantics per file (no phantom name collisions) and a module target that
 * permits top-level await.
 *
 * The download is not exercised — it needs the network. `--offline` covers the rest.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { setupTypes } from '../src/commands/types';
import { makeCapturingLogger, makeTempProject } from './helpers';

async function readTsconfig(root: string, scriptRoot: string): Promise<Record<string, never>> {
  const raw = await fs.readFile(path.join(root, scriptRoot, 'tsconfig.json'), 'utf8');
  return JSON.parse(raw) as Record<string, never>;
}

describe('types', () => {
  it('writes a config that gives each script its own scope', async () => {
    const project = await makeTempProject();
    try {
      const { log } = makeCapturingLogger();
      await setupTypes(project.root, 'scripts', { offline: true }, log);

      const cfg = await readTsconfig(project.root, 'scripts');
      const opts = cfg.compilerOptions as Record<string, unknown>;

      // Without this, two scripts each declaring `const helper` collide with
      // TS2451 even though the adapter runs them in separate sandboxes.
      assert.equal(opts.moduleDetection, 'force');
      // Top-level await is allowed by the adapter; commonjs would reject it (TS1378).
      assert.equal(opts.module, 'es2022');
      assert.equal(opts.noEmit, true);
      assert.equal(opts.checkJs, true, 'plain .js scripts are checked too');
    } finally {
      await project.cleanup();
    }
  });

  it('points at the type definitions from a nested script root', async () => {
    const project = await makeTempProject();
    try {
      const { log } = makeCapturingLogger();
      await setupTypes(project.root, 'a/b', { offline: true }, log);

      const cfg = await readTsconfig(project.root, 'a/b');
      assert.ok(
        (cfg.include as unknown as string[]).includes('../../.iobroker/types/**/*.d.ts'),
        `expected a ../../ types include, got ${JSON.stringify(cfg.include)}`,
      );
    } finally {
      await project.cleanup();
    }
  });

  it('keeps an existing tsconfig unless --force', async () => {
    const project = await makeTempProject();
    try {
      const mine = '{ "compilerOptions": { "strict": true } }\n';
      await fs.writeFile(path.join(project.scriptRoot, 'tsconfig.json'), mine, 'utf8');

      const { log } = makeCapturingLogger();
      await setupTypes(project.root, 'scripts', { offline: true }, log);
      assert.equal(await fs.readFile(path.join(project.scriptRoot, 'tsconfig.json'), 'utf8'), mine);

      await setupTypes(project.root, 'scripts', { offline: true, force: true }, log);
      assert.notEqual(
        await fs.readFile(path.join(project.scriptRoot, 'tsconfig.json'), 'utf8'),
        mine,
      );
    } finally {
      await project.cleanup();
    }
  });

  it('still writes global.d.ts when the download is skipped', async () => {
    const project = await makeTempProject();
    try {
      const { log } = makeCapturingLogger();
      await setupTypes(project.root, 'scripts', { offline: true }, log);

      const globals = await fs.readFile(
        path.join(project.root, '.iobroker', 'types', 'global.d.ts'),
        'utf8',
      );
      assert.match(globals, /function require/);
    } finally {
      await project.cleanup();
    }
  });

  it('says what is missing rather than failing when offline and nothing is cached', async () => {
    const project = await makeTempProject();
    try {
      const { log, captured } = makeCapturingLogger();
      await setupTypes(project.root, 'scripts', { offline: true }, log);

      assert.ok(
        captured.all.some((l) => /restart your editor/i.test(l)),
        'the user needs telling that the LSP must be reloaded',
      );
    } finally {
      await project.cleanup();
    }
  });
});
