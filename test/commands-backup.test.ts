/**
 * Tests for `backup`.
 *
 * The command exists so that edits to scripts running a real house are revertible.
 * The assertions that matter are therefore: the snapshot captures `enabled` and
 * `engine` (which `push` never writes back, so nothing else records them), the
 * source round-trips byte-for-byte, and nothing on the server is mutated.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { FakeAdminServer } from './fake-server';
import { TempProject, makeContext, makeTempProject } from './helpers';
import { backup, BackupManifest } from '../src/commands/backup';
import { ScriptObject, STATE_DIR, UserError } from '../src/types';

const SOURCE = "on('x', () => log('hello'));\n";
const CRLF_SOURCE = "on('x', () => {\r\n  log('crlf');\r\n});\r\n";

function script(id: string, overrides: Partial<ScriptObject['common']> = {}): ScriptObject {
  return {
    _id: id,
    type: 'script',
    common: {
      name: id.slice(id.lastIndexOf('.') + 1),
      source: SOURCE,
      engineType: 'TypeScript/ts',
      engine: 'system.adapter.javascript.2',
      enabled: true,
      expert: true,
      ...overrides,
    },
    native: {},
  };
}

async function readManifestAt(dir: string): Promise<BackupManifest> {
  return JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
}

describe('backup', () => {
  let server: FakeAdminServer;
  let port: number;
  let project: TempProject;

  before(async () => {
    server = new FakeAdminServer();
    port = await server.start();
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    server.seed([
      script('script.js.common.garage'),
      script('script.js.disabled-one', {
        enabled: false,
        engine: 'system.adapter.javascript.3',
      }),
    ]);
    if (project) await project.cleanup();
    project = await makeTempProject();
  });

  it('writes sources and full objects for every script', async () => {
    const t = await makeContext(port, project);
    try {
      const dir = await backup(t.ctx);

      assert.equal(
        await fs.readFile(path.join(dir, 'sources', 'common', 'garage.ts'), 'utf8'),
        SOURCE,
      );

      const obj = JSON.parse(
        await fs.readFile(path.join(dir, 'objects', 'script.js.common.garage.json'), 'utf8'),
      );
      assert.equal(obj._id, 'script.js.common.garage');
      assert.equal(obj.common.source, SOURCE);
    } finally {
      await t.close();
    }
  });

  it('records enabled and engine, which push can never restore', async () => {
    const t = await makeContext(port, project);
    try {
      const dir = await backup(t.ctx);
      const manifest = await readManifestAt(dir);

      const disabled = manifest.entries.find((e) => e.id === 'script.js.disabled-one');
      assert.ok(disabled, 'expected the disabled script in the manifest');
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.engine, 'system.adapter.javascript.3');

      const garage = manifest.entries.find((e) => e.id === 'script.js.common.garage');
      assert.ok(garage);
      assert.equal(garage.enabled, true);
      assert.equal(garage.engine, 'system.adapter.javascript.2');
    } finally {
      await t.close();
    }
  });

  it('preserves the source byte-for-byte, including CRLF', async () => {
    server.reset();
    server.seed([script('script.js.crlf', { source: CRLF_SOURCE })]);

    const t = await makeContext(port, project);
    try {
      const dir = await backup(t.ctx);
      // The on-disk copy is a faithful record, not a normalised one: a restore has
      // to reproduce exactly what the server had.
      assert.equal(await fs.readFile(path.join(dir, 'sources', 'crlf.ts'), 'utf8'), CRLF_SOURCE);
    } finally {
      await t.close();
    }
  });

  it('lands under the gitignored state directory', async () => {
    const t = await makeContext(port, project);
    try {
      const dir = await backup(t.ctx);
      const rel = path.relative(project.root, dir);
      assert.ok(
        rel.startsWith(`${STATE_DIR}${path.sep}backup${path.sep}`),
        `snapshot must live under ${STATE_DIR}/backup/, got ${rel}`,
      );
    } finally {
      await t.close();
    }
  });

  it('does not mutate anything on the server', async () => {
    const t = await makeContext(port, project);
    try {
      const before = JSON.stringify(await t.ctx.objects.listScripts());
      await backup(t.ctx);
      const after = JSON.stringify(await t.ctx.objects.listScripts());
      assert.equal(after, before);
    } finally {
      await t.close();
    }
  });

  it('honours a pattern', async () => {
    const t = await makeContext(port, project);
    try {
      const dir = await backup(t.ctx, { pattern: 'garage' });
      const manifest = await readManifestAt(dir);
      assert.equal(manifest.entries.length, 1);
      assert.equal(manifest.entries[0].id, 'script.js.common.garage');
    } finally {
      await t.close();
    }
  });

  it('refuses when a pattern matches nothing rather than writing an empty snapshot', async () => {
    const t = await makeContext(port, project);
    try {
      await assert.rejects(() => backup(t.ctx, { pattern: 'nope-not-here' }), UserError);

      // An empty snapshot directory would look like a safety net and not be one.
      const backupRoot = path.join(project.root, STATE_DIR, 'backup');
      const made = await fs.readdir(backupRoot).catch(() => []);
      assert.equal(made.length, 0);
    } finally {
      await t.close();
    }
  });

  it('writes nothing under --dry-run', async () => {
    const t = await makeContext(port, project, { dryRun: true });
    try {
      await backup(t.ctx);
      const made = await fs.readdir(path.join(project.root, STATE_DIR, 'backup')).catch(() => []);
      assert.equal(made.length, 0);
    } finally {
      await t.close();
    }
  });
});
