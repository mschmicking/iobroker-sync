/**
 * Tests for the core sync commands: pull, push, status.
 *
 * The load-bearing assertions here are the two anti-data-loss invariants:
 *   - pull must never silently overwrite a local edit
 *   - push must never disturb `enabled`, `engine` or `name` on the server
 * Both are the difference between a sync tool and a tool that quietly breaks
 * someone's home automation.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeAdminServer } from './fake-server';
import {
  TempProject,
  entryFor,
  localExists,
  makeContext,
  makeTempProject,
  readLocal,
  readManifest,
  writeLocal,
  writeManifest,
} from './helpers';
import { pull } from '../src/commands/pull';
import { push } from '../src/commands/push';
import { status } from '../src/commands/status';
import { ScriptObject, UserError } from '../src/types';
import { hashSource } from '../src/sync/mapping';

const TS_SOURCE = "on('a', () => log('ts'));\n";
const JS_SOURCE = "on('b', () => log('js'));\n";

function script(
  id: string,
  source: string,
  engineType = 'TypeScript/ts',
  overrides: Partial<ScriptObject['common']> = {},
): ScriptObject {
  return {
    _id: id,
    type: 'script',
    common: {
      name: id.slice(id.lastIndexOf('.') + 1),
      source,
      engineType,
      engine: 'system.adapter.javascript.2',
      enabled: true,
      expert: true,
      ...overrides,
    },
    native: {},
  };
}

describe('sync commands', () => {
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
      script('script.js.common.garage', TS_SOURCE),
      script('script.js.rooted', JS_SOURCE, 'Javascript/js'),
    ]);
    if (project) await project.cleanup();
    project = await makeTempProject();
  });

  // -------------------------------------------------------------------------
  // pull
  // -------------------------------------------------------------------------

  it('pull writes files with correct paths, extensions and manifest entries', async () => {
    const t = await makeContext(port, project);
    await pull(t.ctx, {});
    await t.close();

    assert.equal(await readLocal(project, 'common/garage.ts'), TS_SOURCE);
    assert.equal(await readLocal(project, 'rooted.js'), JS_SOURCE);

    const manifest = await readManifest(project.root);
    assert.equal(manifest.entries['script.js.common.garage']?.path, 'common/garage.ts');
    assert.equal(manifest.entries['script.js.common.garage']?.baseHash, hashSource(TS_SOURCE));
    assert.equal(manifest.entries['script.js.rooted']?.path, 'rooted.js');
  });

  it('pull is idempotent', async () => {
    let t = await makeContext(port, project);
    await pull(t.ctx, {});
    await t.close();

    t = await makeContext(port, project);
    await pull(t.ctx, {});
    await t.close();

    assert.ok(
      t.captured.all.some((l) => l.includes('0 pulled')),
      `second pull should write nothing, got: ${t.captured.all.join(' | ')}`,
    );
  });

  it('pull does NOT overwrite a locally modified file without --force', async () => {
    const localEdit = TS_SOURCE + '// my local work\n';
    await writeLocal(project, 'common/garage.ts', localEdit);
    await writeManifest(project.root, [
      entryFor('script.js.common.garage', 'common/garage.ts', 'TypeScript/ts', TS_SOURCE),
    ]);

    const t = await makeContext(port, project);
    await pull(t.ctx, {});
    await t.close();

    assert.equal(
      await readLocal(project, 'common/garage.ts'),
      localEdit,
      'local edit must survive byte-for-byte',
    );
    assert.ok(
      t.captured.all.some((l) => /skip/i.test(l)),
      'the skip must be reported, not silent',
    );
  });

  it('pull --force does overwrite a local modification', async () => {
    await writeLocal(project, 'common/garage.ts', TS_SOURCE + '// clobber me\n');
    await writeManifest(project.root, [
      entryFor('script.js.common.garage', 'common/garage.ts', 'TypeScript/ts', TS_SOURCE),
    ]);

    const t = await makeContext(port, project);
    await pull(t.ctx, { force: true });
    await t.close();

    assert.equal(await readLocal(project, 'common/garage.ts'), TS_SOURCE);
  });

  it('pull never deletes a local file whose script is gone from the server', async () => {
    await writeLocal(project, 'common/orphan.ts', 'still mine\n');
    await writeManifest(project.root, [
      entryFor('script.js.common.orphan', 'common/orphan.ts', 'TypeScript/ts', 'still mine\n'),
    ]);

    const t = await makeContext(port, project);
    await pull(t.ctx, {});
    await t.close();

    assert.ok(await localExists(project, 'common/orphan.ts'), 'local file must survive');
    assert.equal(await readLocal(project, 'common/orphan.ts'), 'still mine\n');
  });

  it('pull --dry-run writes no files', async () => {
    const t = await makeContext(port, project, { dryRun: true });
    await pull(t.ctx, {});
    await t.close();

    assert.equal(await localExists(project, 'common/garage.ts'), false);
  });

  it('pull skips a script whose local path is unwritable but still pulls the rest', async () => {
    // A symlink sitting at the destination path makes safeWriteFile throw for
    // just this one script. That must not abort the whole run — every other
    // script in the batch should still land.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outsideFile = path.join(project.root, 'outside.txt');
    await fs.writeFile(outsideFile, 'ORIGINAL');
    await fs.mkdir(path.join(project.scriptRoot, 'common'), { recursive: true });
    await fs.symlink(outsideFile, path.join(project.scriptRoot, 'common', 'garage.ts'));

    const t = await makeContext(port, project);
    await pull(t.ctx, {});
    await t.close();

    assert.equal(
      await readLocal(project, 'rooted.js'),
      JS_SOURCE,
      'the unaffected script must still pull',
    );
    assert.equal(
      await fs.readFile(outsideFile, 'utf8'),
      'ORIGINAL',
      'the symlink target must be untouched',
    );
    assert.ok(
      t.captured.all.some((l) => /skipped/i.test(l) && /garage/i.test(l)),
      `the failure must be reported, got: ${t.captured.all.join(' | ')}`,
    );
  });

  // -------------------------------------------------------------------------
  // push — the central safety invariant
  // -------------------------------------------------------------------------

  it('push updates source but leaves enabled, engine and name untouched', async () => {
    const edited = TS_SOURCE + '// edited locally\n';
    await writeLocal(project, 'common/garage.ts', edited);
    await writeManifest(project.root, [
      entryFor('script.js.common.garage', 'common/garage.ts', 'TypeScript/ts', TS_SOURCE),
    ]);

    const t = await makeContext(port, project);
    await push(t.ctx, {});
    await t.close();

    const obj = server.getObject('script.js.common.garage') as ScriptObject;
    assert.equal(obj.common.source, edited, 'source should be updated');
    assert.equal(obj.common.enabled, true, 'enabled must be untouched');
    assert.equal(obj.common.engine, 'system.adapter.javascript.2', 'engine must be untouched');
    assert.equal(obj.common.name, 'garage', 'name must be untouched');
  });

  it('push creates a brand-new script disabled, on the default instance, with parent folders', async () => {
    await writeLocal(project, 'newdir/fresh.ts', 'const x = 1;\n');

    const t = await makeContext(port, project, {
      config: { defaultInstance: 'system.adapter.javascript.3' },
    });
    await push(t.ctx, {});
    await t.close();

    const created = server.getObject('script.js.newdir.fresh') as ScriptObject | null;
    assert.ok(created, 'new script must be created');
    assert.equal(created.common.enabled, false, 'a new script must never be auto-started');
    assert.equal(created.common.engine, 'system.adapter.javascript.3');
    assert.equal(created.common.engineType, 'TypeScript/ts');
    assert.equal(created.common.source, 'const x = 1;\n');

    const folder = server.getObject('script.js.newdir');
    assert.ok(folder, 'parent folder must be created');
    assert.equal(folder.type, 'channel');
  });

  it('push refuses a conflict, writes nothing, and signals failure', async () => {
    await writeLocal(project, 'common/garage.ts', 'local version\n');
    await writeManifest(project.root, [
      // baseHash matches neither side -> both changed -> conflict
      {
        id: 'script.js.common.garage',
        path: 'common/garage.ts',
        engineType: 'TypeScript/ts',
        baseHash: '0'.repeat(64),
        lastSync: new Date().toISOString(),
      },
    ]);

    const t = await makeContext(port, project);
    await assert.rejects(() => push(t.ctx, {}), UserError);
    await t.close();

    const obj = server.getObject('script.js.common.garage') as ScriptObject;
    assert.equal(obj.common.source, TS_SOURCE, 'server must be untouched on a refused conflict');
    assert.ok(t.captured.all.some((l) => /refus/i.test(l)));
  });

  it('push --force overwrites a conflict', async () => {
    await writeLocal(project, 'common/garage.ts', 'forced version\n');
    await writeManifest(project.root, [
      {
        id: 'script.js.common.garage',
        path: 'common/garage.ts',
        engineType: 'TypeScript/ts',
        baseHash: '0'.repeat(64),
        lastSync: new Date().toISOString(),
      },
    ]);

    const t = await makeContext(port, project);
    await push(t.ctx, { force: true });
    await t.close();

    const obj = server.getObject('script.js.common.garage') as ScriptObject;
    assert.equal(obj.common.source, 'forced version\n');
    assert.equal(obj.common.enabled, true, 'even --force must not touch enabled');
  });

  it('push --dry-run writes nothing to the server', async () => {
    await writeLocal(project, 'common/garage.ts', 'changed\n');
    await writeManifest(project.root, [
      entryFor('script.js.common.garage', 'common/garage.ts', 'TypeScript/ts', TS_SOURCE),
    ]);

    const t = await makeContext(port, project, { dryRun: true });
    await push(t.ctx, {});
    await t.close();

    const obj = server.getObject('script.js.common.garage') as ScriptObject;
    assert.equal(obj.common.source, TS_SOURCE, 'dry-run must not write');
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  it('status reports in-sync when nothing changed', async () => {
    await writeLocal(project, 'common/garage.ts', TS_SOURCE);
    await writeLocal(project, 'rooted.js', JS_SOURCE);
    await writeManifest(project.root, [
      entryFor('script.js.common.garage', 'common/garage.ts', 'TypeScript/ts', TS_SOURCE),
      entryFor('script.js.rooted', 'rooted.js', 'Javascript/js', JS_SOURCE),
    ]);

    const t = await makeContext(port, project);
    await status(t.ctx, {});
    await t.close();

    const out = t.captured.all.join('\n');
    assert.match(out, /IN-SYNC: 2/i);
  });

  it('status distinguishes local-modified, remote-modified and conflict', async () => {
    // local-modified: local differs from base, remote equals base
    await writeLocal(project, 'common/garage.ts', TS_SOURCE + '// local\n');
    // remote-modified: local equals base, remote differs from base
    await writeLocal(project, 'rooted.js', JS_SOURCE);
    await writeManifest(project.root, [
      entryFor('script.js.common.garage', 'common/garage.ts', 'TypeScript/ts', TS_SOURCE),
      entryFor('script.js.rooted', 'rooted.js', 'Javascript/js', JS_SOURCE),
    ]);
    server.seed([script('script.js.rooted', JS_SOURCE + '// remote\n', 'Javascript/js')]);

    const t = await makeContext(port, project);
    await status(t.ctx, {});
    await t.close();

    const out = t.captured.all.join('\n');
    assert.match(out, /LOCAL-MODIFIED/i);
    assert.match(out, /REMOTE-MODIFIED/i);
  });

  it('status reports local-only and remote-only', async () => {
    // remote-only: garage + rooted exist on the server, nothing local, empty manifest
    await writeLocal(project, 'brand-new.ts', 'only here\n');

    const t = await makeContext(port, project);
    await status(t.ctx, {});
    await t.close();

    const out = t.captured.all.join('\n');
    assert.match(out, /LOCAL-ONLY/i);
    assert.match(out, /REMOTE-ONLY/i);
  });

  it('status reports remote-missing when a synced script vanishes from the server', async () => {
    await writeLocal(project, 'common/ghost.ts', 'gone\n');
    await writeManifest(project.root, [
      entryFor('script.js.common.ghost', 'common/ghost.ts', 'TypeScript/ts', 'gone\n'),
    ]);

    const t = await makeContext(port, project);
    await status(t.ctx, {});
    await t.close();

    assert.match(t.captured.all.join('\n'), /REMOTE-MISSING/i);
  });
});

describe('pull vs files the user already had', () => {
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
    if (project) await project.cleanup();
    project = await makeTempProject();
  });

  /** A never-synced script whose derived path collides with an existing local file. */
  function collidingScript(source: string): ScriptObject {
    return {
      _id: 'script.js.notes',
      type: 'script',
      common: {
        name: 'notes',
        source,
        engineType: 'TypeScript/ts',
        engine: 'system.adapter.javascript.0',
        enabled: true,
        expert: true,
      },
      native: {},
    };
  }

  it('refuses to clobber an untracked local file a script would land on', async () => {
    // The scenario: someone points scriptRoot at a folder that already has files.
    // "pull never deletes local files" was true and beside the point — overwriting
    // loses the work just the same.
    server.seed([collidingScript('REMOTE CONTENT\n')]);
    await writeLocal(project, 'notes.ts', 'MY OWN FILE\n');

    const t = await makeContext(port, project);
    try {
      await pull(t.ctx, {});

      assert.equal(await readLocal(project, 'notes.ts'), 'MY OWN FILE\n');
      assert.ok(
        t.captured.all.some((l) => /conflict/i.test(l)),
        `expected a conflict report, got ${JSON.stringify(t.captured.all)}`,
      );
    } finally {
      await t.close();
    }
  });

  it('--force still takes the remote copy', async () => {
    server.seed([collidingScript('REMOTE CONTENT\n')]);
    await writeLocal(project, 'notes.ts', 'MY OWN FILE\n');

    const t = await makeContext(port, project);
    try {
      await pull(t.ctx, { force: true });

      assert.equal(await readLocal(project, 'notes.ts'), 'REMOTE CONTENT\n');
    } finally {
      await t.close();
    }
  });

  it('adopts an identical local file without complaining', async () => {
    // Same bytes on both sides is not a conflict — it is already what pull wants.
    server.seed([collidingScript('SAME\n')]);
    await writeLocal(project, 'notes.ts', 'SAME\n');

    const t = await makeContext(port, project);
    try {
      await pull(t.ctx, {});

      assert.equal(await readLocal(project, 'notes.ts'), 'SAME\n');
      assert.ok(!t.captured.all.some((l) => /conflict/i.test(l)));
    } finally {
      await t.close();
    }
  });
});
