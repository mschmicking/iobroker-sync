/**
 * Tests for `types`.
 *
 * The generated tsconfig is the whole point of the command, so the assertions are
 * about the two settings that make a folder of ioBroker scripts checkable at all:
 * module semantics per file (no phantom name collisions) and a module target that
 * permits top-level await.
 *
 * The download is exercised against a stubbed `fetch` rather than the network: what
 * matters is that a response which is not the declaration file never reaches the disk.
 * `--offline` covers the rest.
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

/** Run `fn` with `fetch` replaced by one that answers every call with `res`. */
async function withStubbedFetch(res: Response, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(res.clone());
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const DTS_PATH = ['.iobroker', 'types', 'javascript.d.ts'];

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

  it('writes the declaration file when the download is the real thing', async () => {
    const project = await makeTempProject();
    try {
      const dts = 'declare global {\n  function log(msg: string): void;\n}\n';
      const { log } = makeCapturingLogger();
      await withStubbedFetch(new Response(dts, { status: 200 }), async () => {
        await setupTypes(project.root, 'scripts', {}, log);
      });

      assert.equal(await fs.readFile(path.join(project.root, ...DTS_PATH), 'utf8'), dts);
    } finally {
      await project.cleanup();
    }
  });

  it('leaves a working copy alone when a portal answers 200 with a login page', async () => {
    const project = await makeTempProject();
    try {
      const good = 'declare global {\n  function log(msg: string): void;\n}\n';
      const dtsPath = path.join(project.root, ...DTS_PATH);
      await fs.mkdir(path.dirname(dtsPath), { recursive: true });
      await fs.writeFile(dtsPath, good, 'utf8');

      const portal = '<!doctype html><html><body>Sign in to continue</body></html>';
      const { log, captured } = makeCapturingLogger();
      await withStubbedFetch(new Response(portal, { status: 200 }), async () => {
        await setupTypes(project.root, 'scripts', {}, log);
      });

      assert.equal(await fs.readFile(dtsPath, 'utf8'), good, 'the HTML must not overwrite it');
      assert.ok(
        captured.warn.some((l) => /not a TypeScript declaration file/i.test(l)),
        `expected a warning about the response, got ${JSON.stringify(captured.warn)}`,
      );
    } finally {
      await project.cleanup();
    }
  });

  it('refuses a body far too large to be the declaration file', async () => {
    const project = await makeTempProject();
    try {
      const huge = `declare global {}\n${'x'.repeat(3 * 1024 * 1024)}`;
      const { log, captured } = makeCapturingLogger();
      await withStubbedFetch(new Response(huge, { status: 200 }), async () => {
        await setupTypes(project.root, 'scripts', {}, log);
      });

      await assert.rejects(
        () => fs.access(path.join(project.root, ...DTS_PATH)),
        'nothing should have been written',
      );
      assert.ok(
        captured.warn.some((l) => l.includes('KB')),
        `expected a warning naming the size, got ${JSON.stringify(captured.warn)}`,
      );
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
