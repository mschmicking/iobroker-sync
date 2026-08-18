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

/**
 * Every javascript instance that runs a script keeps a `scriptEnabled` marker beside
 * it, and ioBroker only ever cleans up the one belonging to the instance that owned the
 * script at the moment it was deleted. Anything left behind is invisible to the user and
 * complained about by js-controller forever, so the delete paths sweep it themselves.
 */
describe('script marker cleanup', () => {
  let server: FakeAdminServer;
  let port: number;
  let project: TempProject;

  const TARGET = 'script.js.common.target';
  const OWN_MARKER = 'javascript.2.scriptEnabled.common.target';
  // Held by an instance that does not run the script — the pair ioBroker never cleans.
  const STALE_MARKER = 'javascript.1.scriptEnabled.common.target';
  // The twin the adapter creates beside every scriptEnabled state, and the one the
  // first version of this sweep missed on a real instance.
  const STALE_PROBLEM = 'javascript.1.scriptProblem.common.target';
  const OTHER_MARKER = 'javascript.2.scriptEnabled.other';

  before(async () => {
    server = new FakeAdminServer();
    port = await server.start();
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    server.seed([script(TARGET), script('script.js.other')]);
    server.seedMarker(OWN_MARKER, true);
    server.seedMarker(STALE_MARKER, true);
    server.seedMarker(STALE_PROBLEM, false);
    server.seedMarker(OTHER_MARKER, true);
    if (project) await project.cleanup();
    project = await makeTempProject();
    await writeLocal(project, 'common/target.ts', SOURCE);
    await writeManifest(project.root, [
      entryFor(TARGET, 'common/target.ts', 'TypeScript/ts', SOURCE),
    ]);
  });

  it('remove --yes sweeps the markers of the deleted script and nothing else', async () => {
    const t = await makeContext(port, project);
    await remove(t.ctx, TARGET, { yes: true });
    await t.close();

    assert.equal(server.getObject(TARGET), null);
    assert.deepEqual(server.stateIds(), [OTHER_MARKER], 'only the other script keeps its marker');
    assert.equal(server.getObject(OWN_MARKER), null, 'the marker object goes too');
    assert.equal(server.getObject(STALE_MARKER), null);
    assert.equal(server.getObject(STALE_PROBLEM), null, 'the scriptProblem twin goes too');
    assert.ok(t.captured.result.some((l) => l === `cleaned  ${STALE_MARKER}`));
    assert.ok(t.captured.result.some((l) => l === `cleaned  ${STALE_PROBLEM}`));
  });

  /**
   * Guards the specific regression: sweeping only `scriptEnabled` left the
   * `scriptProblem` twin behind on a live instance while reporting success.
   */
  it('leaves no scriptProblem state behind when the scriptEnabled one is swept', async () => {
    const t = await makeContext(port, project);
    await remove(t.ctx, TARGET, { yes: true });
    await t.close();

    assert.deepEqual(
      server.stateIds().filter((id) => id.includes('common.target')),
      [],
      'no marker of either kind may survive for the deleted script',
    );
  });

  it('remove without --yes lists the markers and deletes nothing', async () => {
    const t = await makeContext(port, project);
    await remove(t.ctx, TARGET, {});
    await t.close();

    assert.deepEqual(
      server.stateIds(),
      [STALE_MARKER, STALE_PROBLEM, OWN_MARKER, OTHER_MARKER].sort(),
    );
    assert.ok(
      t.captured.all.some((l) => l.includes(`Would clean up leftover:     ${STALE_MARKER}`)),
    );
  });

  /**
   * The case that makes the doctor report actionable: the script was deleted long ago,
   * from the Admin UI or by another tool, and only the markers remain. Refusing here
   * would leave the user with a warning nothing can clear.
   */
  it('remove --yes cleans markers of a script that is already gone from the server', async () => {
    const t = await makeContext(port, project);
    await remove(t.ctx, TARGET, { yes: true });
    // Second run: the object is gone, the markers are back (as if never swept).
    server.seedMarker(STALE_MARKER, true);
    await remove(t.ctx, TARGET, { yes: true });
    await t.close();

    assert.deepEqual(server.stateIds(), [OTHER_MARKER]);
    assert.ok(t.captured.all.some((l) => l.includes('already gone from the server')));
    assert.ok(
      await localExists(project, 'common/target.ts'),
      'the local file is never touched here',
    );
  });

  it('remove --yes still refuses an id with neither a script nor any markers', async () => {
    const t = await makeContext(port, project);
    await assert.rejects(() => remove(t.ctx, 'script.js.nothing-here', { yes: true }), UserError);
    await t.close();
  });

  it('remove --dry-run does not sweep markers of an already-deleted script', async () => {
    // Rebuild the world without the script, so the already-gone path is the one taken.
    server.reset();
    server.seedMarker(STALE_MARKER, true);
    const t = await makeContext(port, project, { dryRun: true });
    await remove(t.ctx, TARGET, { yes: true });
    await t.close();

    assert.ok(server.getState(STALE_MARKER), 'dry-run must not delete anything');
  });

  it('rename --yes sweeps the markers of the old id', async () => {
    const t = await makeContext(port, project);
    await rename(t.ctx, TARGET, 'renamed', { yes: true });
    await t.close();

    assert.ok(server.getObject('script.js.common.renamed'), 'the rename itself must have worked');
    assert.deepEqual(server.stateIds(), [OTHER_MARKER]);
  });

  it('move --yes sweeps the markers of the old id', async () => {
    server.seed([
      { _id: 'script.js.archive', type: 'channel', common: { name: 'archive' }, native: {} },
    ]);
    const t = await makeContext(port, project);
    await move(t.ctx, TARGET, 'archive', { yes: true });
    await t.close();

    assert.ok(server.getObject('script.js.archive.target'));
    assert.deepEqual(server.stateIds(), [OTHER_MARKER]);
  });

  /**
   * The script is already deleted and backed up by the time the sweep runs, so a
   * failure here is untidiness, not data loss. Reporting it as a failed delete would
   * be worse than the leftover it is complaining about.
   */
  it('a marker that cannot be deleted warns but does not fail the command', async () => {
    server.failCommand('delState', 'states db is read-only');
    const t = await makeContext(port, project);
    await remove(t.ctx, TARGET, { yes: true });
    await t.close();

    assert.equal(server.getObject(TARGET), null, 'the script itself is still deleted');
    assert.equal((await listTrash(project.root)).length, 1, 'and still backed up');
    assert.ok(t.captured.warn.some((l) => l.includes('Could not remove the leftover state')));
    assert.ok(server.getObject(STALE_MARKER), 'and the marker was left whole, not half-deleted');
  });

  it('a scriptEnabled lookup that fails does not stop the delete', async () => {
    server.failCommand('getStates', 'nope');
    server.failCommand('getForeignStates', 'nope');
    server.failCommand('getForeignObjects', 'nope');
    const t = await makeContext(port, project);
    await remove(t.ctx, TARGET, { yes: true });
    await t.close();

    assert.equal(server.getObject(TARGET), null);
    assert.equal((await listTrash(project.root)).length, 1);
  });
});
