/**
 * Tests for `--json` records.
 *
 * The contract is that a consumer never has to parse the human output back apart:
 * records carry real values (booleans, full ids), and they include rows the human
 * view collapses or omits. The CLI writes one record per line (NDJSON) so unbounded
 * streams like `logs` work; these tests assert on the records themselves.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeAdminServer } from './fake-server';
import {
  TempProject,
  entryFor,
  makeContext,
  makeTempProject,
  writeLocal,
  writeManifest,
} from './helpers';
import { list } from '../src/commands/list';
import { status } from '../src/commands/status';
import { pull } from '../src/commands/pull';
import { push } from '../src/commands/push';
import { backup } from '../src/commands/backup';
import { ScriptObject } from '../src/types';

const ID = 'script.js.common.garage';
const REL = 'common/garage.ts';
const SOURCE = "log('hi');\n";

function script(
  id: string,
  source = SOURCE,
  overrides: Partial<ScriptObject['common']> = {},
): ScriptObject {
  return {
    _id: id,
    type: 'script',
    common: {
      name: id.slice(id.lastIndexOf('.') + 1),
      source,
      engineType: 'TypeScript/ts',
      engine: 'system.adapter.javascript.2',
      enabled: true,
      expert: true,
      ...overrides,
    },
    native: {},
  };
}

function recordsOfType(data: unknown[], type: string): Record<string, unknown>[] {
  return (data as Record<string, unknown>[]).filter((d) => d.type === type);
}

describe('--json records', () => {
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
    server.seed([script(ID)]);
    if (project) await project.cleanup();
    project = await makeTempProject();
  });

  it('list emits real values, not the display strings', async () => {
    const t = await makeContext(port, project);
    try {
      await list(t.ctx, {});

      const rows = recordsOfType(t.captured.data, 'script');
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.id, ID);
      assert.equal(row.path, REL);
      // The table shows "✓" and "js.2"; the record must carry the underlying values.
      assert.equal(row.enabled, true);
      assert.equal(row.engine, 'system.adapter.javascript.2');
      assert.equal(row.engineType, 'TypeScript/ts');
    } finally {
      await t.close();
    }
  });

  it('list reports enabled as a boolean false, not an empty string', async () => {
    server.reset();
    server.seed([script(ID, SOURCE, { enabled: false })]);

    const t = await makeContext(port, project);
    try {
      await list(t.ctx, {});

      assert.equal(recordsOfType(t.captured.data, 'script')[0].enabled, false);
    } finally {
      await t.close();
    }
  });

  it('status includes in-sync scripts that the human view collapses to a count', async () => {
    await writeLocal(project, REL, SOURCE);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', SOURCE)]);

    const t = await makeContext(port, project);
    try {
      await status(t.ctx, {});

      // Human output is just "IN-SYNC: 1" — the record must still name the script.
      const rows = recordsOfType(t.captured.data, 'status');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, ID);
      assert.equal(rows[0].state, 'in-sync');
    } finally {
      await t.close();
    }
  });

  it('pull emits one record per file written', async () => {
    const t = await makeContext(port, project);
    try {
      await pull(t.ctx, {});

      const rows = recordsOfType(t.captured.data, 'pull');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].path, REL);
      assert.equal(rows[0].dryRun, false);
    } finally {
      await t.close();
    }
  });

  it('marks dry-run records so a consumer cannot mistake them for real writes', async () => {
    const t = await makeContext(port, project, { dryRun: true });
    try {
      await pull(t.ctx, {});

      const rows = recordsOfType(t.captured.data, 'pull');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].dryRun, true);
    } finally {
      await t.close();
    }
  });

  it('push distinguishes an update from a newly created script', async () => {
    await writeLocal(project, REL, "log('changed');\n");
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', SOURCE)]);
    await writeLocal(project, 'brand-new.ts', "log('new');\n");

    const t = await makeContext(port, project);
    try {
      await push(t.ctx, {});

      const rows = recordsOfType(t.captured.data, 'push');
      const updated = rows.find((r) => r.path === REL);
      const created = rows.find((r) => r.path === 'brand-new.ts');
      assert.ok(updated, 'expected a record for the updated script');
      assert.ok(created, 'expected a record for the new script');
      assert.equal(updated.created, false);
      assert.equal(created.created, true);
    } finally {
      await t.close();
    }
  });

  it('backup leads with the snapshot path a caller needs next', async () => {
    const t = await makeContext(port, project);
    try {
      const dir = await backup(t.ctx);

      const rows = recordsOfType(t.captured.data, 'backup');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].snapshot, dir);
      assert.equal(rows[0].scripts, 1);
    } finally {
      await t.close();
    }
  });

  it('every record is JSON-serialisable and carries a type tag', async () => {
    const t = await makeContext(port, project);
    try {
      await list(t.ctx, {});
      await pull(t.ctx, {});

      assert.ok(t.captured.data.length > 0);
      for (const record of t.captured.data) {
        const round = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
        assert.equal(typeof round.type, 'string', 'each record needs a type discriminator');
        assert.deepEqual(round, record, 'records must survive a JSON round-trip unchanged');
      }
    } finally {
      await t.close();
    }
  });
});
