/**
 * Tests for the destructive commands: remove, rename, move.
 *
 * These paths delete data from a live home-automation system, so they get the
 * most scrutiny. The single most important test in this file is
 * "verification failure leaves the original intact" — ioBroker has no native
 * rename/move, so both are copy-then-delete, and the source-comparison check is
 * the only thing standing between a bad copy and permanently lost work.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeAdminServer } from './fake-server';
import {
  TempProject,
  entryFor,
  listTrash,
  localExists,
  makeContext,
  makeTempProject,
  readLocal,
  readManifest,
  readTrashFile,
  writeLocal,
  writeManifest,
} from './helpers';
import { remove } from '../src/commands/remove';
import { rename } from '../src/commands/rename';
import { move } from '../src/commands/move';
import { ScriptObject, UserError } from '../src/types';

const SOURCE = "on('x', () => log('hello'));\n";

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

describe('destructive commands', () => {
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
    server.seed([script('script.js.common.target'), script('script.js.other')]);
    if (project) await project.cleanup();
    project = await makeTempProject();
    await writeLocal(project, 'common/target.ts', SOURCE);
    await writeManifest(project.root, [
      entryFor('script.js.common.target', 'common/target.ts', 'TypeScript/ts', SOURCE),
    ]);
  });

  // -------------------------------------------------------------------------
  // Guard: nothing happens without --yes
  // -------------------------------------------------------------------------

  it('remove without --yes changes nothing', async () => {
    const t = await makeContext(port, project);
    await remove(t.ctx, 'script.js.common.target', {});
    await t.close();

    assert.ok(server.getObject('script.js.common.target'), 'server object must survive');
    assert.equal(await readLocal(project, 'common/target.ts'), SOURCE);
    assert.deepEqual(await listTrash(project.root), [], 'no backup should be written');
    assert.ok(t.captured.all.some((l) => /re-run with --yes/i.test(l)));
  });

  it('rename without --yes changes nothing', async () => {
    const t = await makeContext(port, project);
    await rename(t.ctx, 'script.js.common.target', 'renamed', {});
    await t.close();

    assert.ok(server.getObject('script.js.common.target'));
    assert.equal(server.getObject('script.js.common.renamed'), null);
    assert.deepEqual(await listTrash(project.root), []);
  });

  it('move without --yes changes nothing', async () => {
    const t = await makeContext(port, project);
    await move(t.ctx, 'script.js.common.target', 'elsewhere', {});
    await t.close();

    assert.ok(server.getObject('script.js.common.target'));
    assert.equal(server.getObject('script.js.elsewhere.target'), null);
    assert.deepEqual(await listTrash(project.root), []);
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  it('remove --yes deletes remotely, backs up, and KEEPS the local file', async () => {
    const t = await makeContext(port, project);
    await remove(t.ctx, 'script.js.common.target', { yes: true });
    await t.close();

    assert.equal(server.getObject('script.js.common.target'), null, 'object should be gone');

    const trash = await listTrash(project.root);
    assert.equal(trash.length, 1, 'exactly one backup expected');
    const backup = (await readTrashFile(project.root, trash[0])) as ScriptObject;
    assert.equal(backup._id, 'script.js.common.target');
    assert.equal(backup.common.source, SOURCE, 'backup must contain the original source');

    assert.ok(
      await localExists(project, 'common/target.ts'),
      'local file must be kept by default — losing the remote object is no reason to lose the code',
    );

    const manifest = await readManifest(project.root);
    assert.equal(manifest.entries['script.js.common.target'], undefined);
  });

  it('remove --yes --delete-local also removes the local file', async () => {
    const t = await makeContext(port, project);
    await remove(t.ctx, 'script.js.common.target', { yes: true, deleteLocal: true });
    await t.close();

    assert.equal(server.getObject('script.js.common.target'), null);
    assert.equal(await localExists(project, 'common/target.ts'), false);
    assert.equal((await listTrash(project.root)).length, 1, 'backup still required');
  });

  it('remove of an unknown id throws and deletes nothing', async () => {
    const t = await makeContext(port, project);
    await assert.rejects(() => remove(t.ctx, 'script.js.does-not-exist', { yes: true }), UserError);
    await t.close();

    assert.ok(server.getObject('script.js.common.target'));
    assert.deepEqual(await listTrash(project.root), []);
  });

  it('remove --dry-run deletes nothing', async () => {
    const t = await makeContext(port, project, { dryRun: true });
    await remove(t.ctx, 'script.js.common.target', { yes: true });
    await t.close();

    assert.ok(server.getObject('script.js.common.target'));
    assert.deepEqual(await listTrash(project.root), []);
  });

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  it('rename --yes copies, verifies, backs up, then deletes the original', async () => {
    const t = await makeContext(port, project);
    await rename(t.ctx, 'script.js.common.target', 'renamed', { yes: true });
    await t.close();

    const created = server.getObject('script.js.common.renamed') as ScriptObject | null;
    assert.ok(created, 'new id must exist');
    assert.equal(created.common.source, SOURCE, 'source must survive the copy');
    assert.equal(created.common.engine, 'system.adapter.javascript.2', 'engine preserved');
    assert.equal(created.common.enabled, true, 'enabled state preserved');
    assert.equal(created.common.name, 'renamed');

    assert.equal(server.getObject('script.js.common.target'), null, 'original must be gone');
    assert.equal((await listTrash(project.root)).length, 1, 'original must be backed up');

    assert.equal(await localExists(project, 'common/target.ts'), false);
    assert.equal(await readLocal(project, 'common/renamed.ts'), SOURCE);

    const manifest = await readManifest(project.root);
    assert.equal(manifest.entries['script.js.common.target'], undefined);
    assert.equal(manifest.entries['script.js.common.renamed']?.path, 'common/renamed.ts');
  });

  it('rename refuses when the target id already exists, leaving the original intact', async () => {
    server.seed([script('script.js.common.taken')]);
    const t = await makeContext(port, project);
    await assert.rejects(
      () => rename(t.ctx, 'script.js.common.target', 'taken', { yes: true }),
      UserError,
    );
    await t.close();

    assert.ok(server.getObject('script.js.common.target'), 'original must survive');
    assert.deepEqual(
      await listTrash(project.root),
      [],
      'nothing was deleted, so nothing to back up',
    );
  });

  /**
   * The critical one. If the copy lands but does not match the original, the command
   * must abort BEFORE deleting anything. Prior to this being enforced, the check only
   * asserted that *something* existed at the new id, so a truncated copy passed and the
   * original was destroyed.
   */
  it('rename aborts and preserves the original when the copy does not match', async () => {
    server.corruptNextSetObject((obj) => ({
      ...obj,
      common: { ...(obj as ScriptObject).common, source: 'TRUNCATED' },
    }));

    const t = await makeContext(port, project);
    await assert.rejects(
      () => rename(t.ctx, 'script.js.common.target', 'renamed', { yes: true }),
      (err: unknown) => err instanceof UserError && /does not match/i.test(err.message),
    );
    await t.close();

    const original = server.getObject('script.js.common.target') as ScriptObject | null;
    assert.ok(original, 'ORIGINAL MUST STILL EXIST after a failed verification');
    assert.equal(original.common.source, SOURCE, 'original source must be untouched');
    assert.deepEqual(
      await listTrash(project.root),
      [],
      'must not have reached the backup/delete step',
    );
    assert.ok(await localExists(project, 'common/target.ts'), 'local file untouched');
  });

  it('rename aborts when the copy cannot be read back at all', async () => {
    server.corruptNextSetObject(() => null as unknown as ScriptObject);

    const t = await makeContext(port, project);
    await assert.rejects(
      () => rename(t.ctx, 'script.js.common.target', 'renamed', { yes: true }),
      UserError,
    );
    await t.close();

    const original = server.getObject('script.js.common.target') as ScriptObject | null;
    assert.ok(original, 'original must survive');
    assert.equal(original.common.source, SOURCE);
  });

  // -------------------------------------------------------------------------
  // move
  // -------------------------------------------------------------------------

  it('move --yes relocates the script and creates missing folders', async () => {
    const t = await makeContext(port, project);
    await move(t.ctx, 'script.js.common.target', 'archive/old', { yes: true });
    await t.close();

    const moved = server.getObject('script.js.archive.old.target') as ScriptObject | null;
    assert.ok(moved, 'script must exist at the new id');
    assert.equal(moved.common.source, SOURCE);
    assert.equal(moved.common.engine, 'system.adapter.javascript.2');

    assert.ok(server.getObject('script.js.archive'), 'parent folder created');
    assert.ok(server.getObject('script.js.archive.old'), 'nested folder created');

    assert.equal(server.getObject('script.js.common.target'), null, 'original gone');
    assert.equal((await listTrash(project.root)).length, 1, 'original backed up');
    assert.equal(await readLocal(project, 'archive/old/target.ts'), SOURCE);
  });

  it('move to the root works', async () => {
    const t = await makeContext(port, project);
    await move(t.ctx, 'script.js.common.target', '', { yes: true });
    await t.close();

    assert.ok(server.getObject('script.js.target'));
    assert.equal(server.getObject('script.js.common.target'), null);
  });

  it('move refuses when the target id already exists, leaving the original intact', async () => {
    server.seed([script('script.js.elsewhere.target')]);
    const t = await makeContext(port, project);
    await assert.rejects(
      () => move(t.ctx, 'script.js.common.target', 'elsewhere', { yes: true }),
      UserError,
    );
    await t.close();

    assert.ok(server.getObject('script.js.common.target'), 'original must survive');
    assert.deepEqual(await listTrash(project.root), []);
  });

  it('move aborts and preserves the original when the copy does not match', async () => {
    // Seed the destination folder first: `move` calls ensureFolders() before copying,
    // and folder creation is itself a setObject, which would otherwise consume the
    // one-shot corruption before the script copy ever happens.
    server.seed([
      { _id: 'script.js.archive', type: 'channel', common: { name: 'archive' }, native: {} },
    ]);
    server.corruptNextSetObject((obj) => ({
      ...obj,
      common: { ...(obj as ScriptObject).common, source: '' },
    }));

    const t = await makeContext(port, project);
    await assert.rejects(
      () => move(t.ctx, 'script.js.common.target', 'archive', { yes: true }),
      UserError,
    );
    await t.close();

    const original = server.getObject('script.js.common.target') as ScriptObject | null;
    assert.ok(original, 'ORIGINAL MUST STILL EXIST after a failed verification');
    assert.equal(original.common.source, SOURCE);
    assert.deepEqual(await listTrash(project.root), []);
  });
});
