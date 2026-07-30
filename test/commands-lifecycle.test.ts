/**
 * Tests for the lifecycle commands: list, start, stop, restart, new.
 *
 * The recurring assertion is that toggling a script's enabled state does not
 * disturb its source or its javascript instance, and that creating a script
 * never starts it.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeAdminServer } from './fake-server';
import {
  TempProject,
  localExists,
  makeContext,
  makeTempProject,
  readLocal,
  readManifest,
} from './helpers';
import { list } from '../src/commands/list';
import { start } from '../src/commands/start';
import { restart, stop } from '../src/commands/stop';
import { createNew } from '../src/commands/new';
import { ScriptObject, UserError } from '../src/types';

const SOURCE = "on('x', () => log('y'));\n";

function script(id: string, overrides: Partial<ScriptObject['common']> = {}): ScriptObject {
  return {
    _id: id,
    type: 'script',
    common: {
      name: id.slice(id.lastIndexOf('.') + 1),
      source: SOURCE,
      engineType: 'TypeScript/ts',
      engine: 'system.adapter.javascript.2',
      enabled: false,
      expert: true,
      ...overrides,
    },
    native: {},
  };
}

describe('lifecycle commands', () => {
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
      script('script.js.common.garage', { enabled: true }),
      script('script.js.common.heater', { enabled: false }),
      script('script.js.rooted', { enabled: false, engineType: 'Javascript/js' }),
    ]);
    if (project) await project.cleanup();
    project = await makeTempProject();
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  it('list shows every script and marks the enabled ones', async () => {
    const t = await makeContext(port, project);
    await list(t.ctx, {});
    await t.close();

    const out = t.captured.all.join('\n');
    assert.match(out, /script\.js\.common\.garage/);
    assert.match(out, /script\.js\.common\.heater/);
    assert.match(out, /script\.js\.rooted/);
    assert.match(out, /3 scripts, 1 enabled/);
  });

  it('list with a bare substring pattern selects matching scripts', async () => {
    const t = await makeContext(port, project);
    await list(t.ctx, { pattern: 'heater' });
    await t.close();

    const out = t.captured.all.join('\n');
    assert.match(out, /heater/);
    assert.doesNotMatch(out, /garage/);
  });

  it('list with a * glob is anchored', async () => {
    const t = await makeContext(port, project);
    await list(t.ctx, { pattern: 'common/*.ts' });
    await t.close();

    const out = t.captured.all.join('\n');
    assert.match(out, /garage/);
    assert.match(out, /heater/);
    assert.doesNotMatch(out, /script\.js\.rooted/);
  });

  // -------------------------------------------------------------------------
  // start / stop / restart
  // -------------------------------------------------------------------------

  it('start enables a script without touching source or engine', async () => {
    const t = await makeContext(port, project);
    await start(t.ctx, { pattern: 'heater' });
    await t.close();

    const obj = server.getObject('script.js.common.heater') as ScriptObject;
    assert.equal(obj.common.enabled, true);
    assert.equal(obj.common.source, SOURCE, 'source must be untouched');
    assert.equal(obj.common.engine, 'system.adapter.javascript.2', 'engine must be untouched');
  });

  it('stop disables a script without touching source or engine', async () => {
    const t = await makeContext(port, project);
    await stop(t.ctx, { pattern: 'garage' });
    await t.close();

    const obj = server.getObject('script.js.common.garage') as ScriptObject;
    assert.equal(obj.common.enabled, false);
    assert.equal(obj.common.source, SOURCE);
    assert.equal(obj.common.engine, 'system.adapter.javascript.2');
  });

  it('start on an already-enabled script is a reported no-op', async () => {
    const t = await makeContext(port, project);
    await start(t.ctx, { pattern: 'garage' });
    await t.close();

    assert.ok(
      t.captured.all.some((l) => /already/i.test(l)),
      `expected an "already enabled" notice, got: ${t.captured.all.join(' | ')}`,
    );
  });

  it('restart leaves the script enabled', async () => {
    const t = await makeContext(port, project);
    await restart(t.ctx, { pattern: 'garage' });
    await t.close();

    const obj = server.getObject('script.js.common.garage') as ScriptObject;
    assert.equal(obj.common.enabled, true);
    assert.equal(obj.common.source, SOURCE);
  });

  it('start --dry-run changes nothing', async () => {
    const t = await makeContext(port, project, { dryRun: true });
    await start(t.ctx, { pattern: 'heater' });
    await t.close();

    const obj = server.getObject('script.js.common.heater') as ScriptObject;
    assert.equal(obj.common.enabled, false);
  });

  // -------------------------------------------------------------------------
  // new
  // -------------------------------------------------------------------------

  it('new creates a DISABLED script with the configured instance and derived engineType', async () => {
    const t = await makeContext(port, project, {
      config: { defaultInstance: 'system.adapter.javascript.1' },
    });
    await createNew(t.ctx, 'fresh/thing.ts', {});
    await t.close();

    const obj = server.getObject('script.js.fresh.thing') as ScriptObject | null;
    assert.ok(obj, 'script must be created');
    assert.equal(obj.common.enabled, false, 'a new script must never be auto-started');
    assert.equal(obj.common.engine, 'system.adapter.javascript.1');
    assert.equal(obj.common.engineType, 'TypeScript/ts');

    assert.ok(await localExists(project, 'fresh/thing.ts'), 'local file must be created');
    assert.equal(await readLocal(project, 'fresh/thing.ts'), '');

    const manifest = await readManifest(project.root);
    assert.equal(manifest.entries['script.js.fresh.thing']?.path, 'fresh/thing.ts');
  });

  it('new derives Javascript/js from a .js extension', async () => {
    const t = await makeContext(port, project);
    await createNew(t.ctx, 'plain.js', {});
    await t.close();

    const obj = server.getObject('script.js.plain') as ScriptObject;
    assert.equal(obj.common.engineType, 'Javascript/js');
  });

  it('new expands a bare instance number', async () => {
    const t = await makeContext(port, project);
    await createNew(t.ctx, 'inst.ts', { instance: '2' });
    await t.close();

    const obj = server.getObject('script.js.inst') as ScriptObject;
    assert.equal(obj.common.engine, 'system.adapter.javascript.2');
  });

  it('new accepts a full instance id unchanged', async () => {
    const t = await makeContext(port, project);
    await createNew(t.ctx, 'inst2.ts', { instance: 'system.adapter.javascript.3' });
    await t.close();

    const obj = server.getObject('script.js.inst2') as ScriptObject;
    assert.equal(obj.common.engine, 'system.adapter.javascript.3');
  });

  it('new on an existing id throws and does not modify the existing script', async () => {
    const t = await makeContext(port, project);
    await assert.rejects(() => createNew(t.ctx, 'common/garage.ts', {}), UserError);
    await t.close();

    const obj = server.getObject('script.js.common.garage') as ScriptObject;
    assert.equal(obj.common.source, SOURCE, 'existing script must be untouched');
    assert.equal(obj.common.enabled, true);
  });

  it('new with an unknown extension throws', async () => {
    const t = await makeContext(port, project);
    await assert.rejects(() => createNew(t.ctx, 'weird.xyz', {}), UserError);
    await t.close();

    assert.equal(server.getObject('script.js.weird'), null);
  });

  it('new creates missing parent folders', async () => {
    const t = await makeContext(port, project);
    await createNew(t.ctx, 'deep/nested/leaf.ts', {});
    await t.close();

    assert.ok(server.getObject('script.js.deep'), 'first folder created');
    assert.ok(server.getObject('script.js.deep.nested'), 'nested folder created');
    assert.equal(server.getObject('script.js.deep')?.type, 'channel');
  });
});
