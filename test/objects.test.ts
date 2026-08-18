import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdminSocketClient } from '../src/client/socket';
import { AdminObjectsApi } from '../src/client/objects';
import { ScriptCommon, ScriptObject } from '../src/types';
import { FakeAdminServer, defaultSeed } from './fake-server';

async function withApi<T>(
  fn: (api: AdminObjectsApi, server: FakeAdminServer) => Promise<T>,
): Promise<T> {
  const server = new FakeAdminServer();
  server.seed(defaultSeed());
  const port = await server.start();
  const client = new AdminSocketClient({ url: `http://localhost:${port}` });
  await client.connect();
  const api = new AdminObjectsApi(client);
  try {
    return await fn(api, server);
  } finally {
    await client.close();
    await server.stop();
  }
}

describe('AdminObjectsApi: listScripts / listFolders', () => {
  test('listScripts returns only type "script"', async () => {
    await withApi(async (api) => {
      const scripts = await api.listScripts();
      assert.equal(scripts.length, 4);
      const ids = scripts.map((s) => s._id).sort();
      assert.deepEqual(ids, [
        'script.js.Switch-Musiccast',
        'script.js.common.dehumidifier',
        'script.js.common.garage',
        'script.js.fetch-test',
      ]);
      assert.ok(scripts.every((s) => s.type === 'script'));
    });
  });

  test('listFolders returns only type "channel"', async () => {
    await withApi(async (api) => {
      const folders = await api.listFolders();
      assert.equal(folders.length, 2);
      const ids = folders.map((f) => f._id).sort();
      assert.deepEqual(ids, ['script.js.Rollos', 'script.js.common']);
      assert.ok(folders.every((f) => f.type === 'channel'));
    });
  });
});

describe('AdminObjectsApi: getScript', () => {
  test('returns null for a missing id', async () => {
    await withApi(async (api) => {
      const result = await api.getScript('script.js.does.not.exist');
      assert.equal(result, null);
    });
  });

  test('returns null for an id that is a folder, not a script', async () => {
    await withApi(async (api) => {
      const result = await api.getScript('script.js.common');
      assert.equal(result, null);
    });
  });

  test('returns the script object for a valid script id', async () => {
    await withApi(async (api) => {
      const result = await api.getScript('script.js.common.garage');
      assert.ok(result);
      assert.equal(result._id, 'script.js.common.garage');
      assert.equal(result.type, 'script');
    });
  });
});

describe('AdminObjectsApi: extendScript', () => {
  test('normal usage: engine, enabled, and name are unchanged after a source update', async () => {
    await withApi(async (api, server) => {
      const before = server.getObject('script.js.common.garage') as ScriptObject;
      assert.equal(before.common.enabled, true);
      assert.equal(before.common.engine, 'system.adapter.javascript.1');

      await api.extendScript('script.js.common.garage', {
        source: 'console.log("updated garage");',
        engineType: 'TypeScript/ts',
      });

      const after = server.getObject('script.js.common.garage') as ScriptObject;
      assert.equal(after.common.source, 'console.log("updated garage");');
      assert.equal(after.common.engineType, 'TypeScript/ts');
      // The central safety property: nothing else in `common` was touched.
      assert.equal(after.common.engine, 'system.adapter.javascript.1');
      assert.equal(after.common.enabled, true);
      assert.equal(after.common.name, 'garage');
    });
  });

  test('even if the caller-supplied common carries extra fields, only source and engineType reach the wire', async () => {
    await withApi(async (api, server) => {
      // Deliberately bypass the Pick<> type to simulate a bug upstream trying to
      // smuggle extra fields through — extendScript must still forward only
      // source/engineType to the server.
      const malicious = {
        source: 'console.log("hacked");',
        engineType: 'Javascript/js',
        enabled: false,
        engine: 'system.adapter.javascript.9',
        name: 'HACKED',
      } as unknown as Pick<ScriptCommon, 'source' | 'engineType'>;

      await api.extendScript('script.js.common.garage', malicious);

      const after = server.getObject('script.js.common.garage') as ScriptObject;
      assert.equal(after.common.source, 'console.log("hacked");');
      assert.equal(after.common.engineType, 'Javascript/js');
      // These must remain exactly as seeded, proving the extra keys never reached the server.
      assert.equal(after.common.enabled, true);
      assert.equal(after.common.engine, 'system.adapter.javascript.1');
      assert.equal(after.common.name, 'garage');
    });
  });

  test('on a script with sourceHash/compiled, those adapter-managed fields are left in place', async () => {
    await withApi(async (api, server) => {
      const before = server.getObject('script.js.common.dehumidifier') as ScriptObject;
      assert.equal(before.common.sourceHash, 'abc123hash');
      assert.equal(before.common.compiled, 'console.log("compiled dehumidifier");');

      await api.extendScript('script.js.common.dehumidifier', {
        source: 'console.log("new dehumidifier logic");',
        engineType: 'TypeScript/ts',
      });

      const after = server.getObject('script.js.common.dehumidifier') as ScriptObject;
      assert.equal(after.common.source, 'console.log("new dehumidifier logic");');
      // We never write sourceHash/compiled; the adapter recomputes them on its own.
      assert.equal(after.common.sourceHash, 'abc123hash');
      assert.equal(after.common.compiled, 'console.log("compiled dehumidifier");');
      assert.equal(after.common.engine, 'system.adapter.javascript.2');
      assert.equal(after.common.enabled, true);
    });
  });
});

describe('AdminObjectsApi: setEnabled', () => {
  test('flips only common.enabled, leaving source and other fields intact', async () => {
    await withApi(async (api, server) => {
      const before = server.getObject('script.js.fetch-test') as ScriptObject;
      assert.equal(before.common.enabled, false);
      const sourceBefore = before.common.source;

      await api.setEnabled('script.js.fetch-test', true);

      const after = server.getObject('script.js.fetch-test') as ScriptObject;
      assert.equal(after.common.enabled, true);
      assert.equal(after.common.source, sourceBefore);
      assert.equal(after.common.engineType, 'TypeScript/ts');
      assert.equal(after.common.engine, 'system.adapter.javascript.3');

      await api.setEnabled('script.js.fetch-test', false);
      const after2 = server.getObject('script.js.fetch-test') as ScriptObject;
      assert.equal(after2.common.enabled, false);
      assert.equal(after2.common.source, sourceBefore);
    });
  });
});

describe('AdminObjectsApi: ensureFolders', () => {
  test('creates intermediate folders but not the script id itself; second call is a no-op', async () => {
    await withApi(async (api, server) => {
      assert.equal(server.getObject('script.js.a'), null);
      assert.equal(server.getObject('script.js.a.b'), null);

      const created = await api.ensureFolders('script.js.a.b.c');
      assert.deepEqual(created, ['script.js.a', 'script.js.a.b']);

      const folderA = server.getObject('script.js.a');
      const folderAB = server.getObject('script.js.a.b');
      assert.ok(folderA);
      assert.equal(folderA.type, 'channel');
      assert.ok(folderAB);
      assert.equal(folderAB.type, 'channel');
      // The script id itself must never be created by ensureFolders.
      assert.equal(server.getObject('script.js.a.b.c'), null);

      const createdAgain = await api.ensureFolders('script.js.a.b.c');
      assert.deepEqual(createdAgain, []);
    });
  });

  test('leaves a pre-existing folder untouched, including a multilingual name object', async () => {
    await withApi(async (api, server) => {
      const nameBefore = (server.getObject('script.js.common') as ScriptObject | null)?.common.name;
      assert.deepEqual(nameBefore, {
        en: 'Common scripts (common)',
        de: 'Allgemeine Skripte (common)',
      });

      const created = await api.ensureFolders('script.js.common.newscript');
      assert.deepEqual(created, []);

      const nameAfter = (server.getObject('script.js.common') as ScriptObject | null)?.common.name;
      assert.deepEqual(nameAfter, nameBefore);
    });
  });
});

describe('AdminObjectsApi: createScript', () => {
  test('stores the full object as-is', async () => {
    await withApi(async (api, server) => {
      const obj: ScriptObject = {
        _id: 'script.js.brandnew',
        type: 'script',
        common: {
          name: 'brandnew',
          engineType: 'Javascript/js',
          enabled: true,
          engine: 'system.adapter.javascript.0',
          source: 'console.log("brand new");',
        },
        native: {},
      };

      await api.createScript(obj);

      const stored = server.getObject('script.js.brandnew');
      assert.deepEqual(stored, obj);
    });
  });
});

describe('AdminObjectsApi: deleteObject', () => {
  test('removes the object from storage', async () => {
    await withApi(async (api, server) => {
      assert.ok(server.getObject('script.js.common.garage'));
      await api.deleteObject('script.js.common.garage');
      assert.equal(server.getObject('script.js.common.garage'), null);
    });
  });
});

describe('AdminObjectsApi: script markers', () => {
  /**
   * Mirrors a real instance: every instance holds markers for scripts it does not run,
   * `gone` has no script left at all, and each script carries a `scriptProblem` twin
   * alongside its `scriptEnabled` one.
   */
  function seedMarkers(server: FakeAdminServer): void {
    server.seedMarker('javascript.1.scriptEnabled.common.garage', true);
    server.seedMarker('javascript.3.scriptEnabled.common.garage', false);
    server.seedMarker('javascript.2.scriptEnabled.diag.gone', true);
    // Not a marker: same namespace, different purpose. Must never be picked up.
    server.seedMarker('javascript.0.variables.someUserState', 42);
    // Nor is this: right shape, but the instance is not a number.
    server.seedMarker('javascript.admin.scriptEnabled.nope', true);
  }

  test('lists markers across instances and ignores other javascript states', async () => {
    await withApi(async (api, server) => {
      seedMarkers(server);
      const entries = await api.listScriptMarkers();

      assert.deepEqual(
        entries.map((e) => e.id),
        [
          'javascript.1.scriptEnabled.common.garage',
          'javascript.2.scriptEnabled.diag.gone',
          'javascript.3.scriptEnabled.common.garage',
        ],
      );
      assert.deepEqual(
        entries.map((e) => e.scriptId),
        ['script.js.common.garage', 'script.js.diag.gone', 'script.js.common.garage'],
      );
      assert.ok(entries.every((e) => e.hasValue && e.hasObject));
    });
  });

  test('reports each half of a marker separately', async () => {
    await withApi(async (api, server) => {
      server.seedMarker('javascript.1.scriptEnabled.a', true, { valueOnly: true });
      server.seedMarker('javascript.2.scriptEnabled.b', true, { objectOnly: true });

      const entries = await api.listScriptMarkers();
      const byId = new Map(entries.map((e) => [e.id, e]));

      assert.deepEqual(
        { ...byId.get('javascript.1.scriptEnabled.a') },
        {
          id: 'javascript.1.scriptEnabled.a',
          scriptId: 'script.js.a',
          kind: 'scriptEnabled',
          hasValue: true,
          hasObject: false,
        },
      );
      assert.deepEqual(
        { ...byId.get('javascript.2.scriptEnabled.b') },
        {
          id: 'javascript.2.scriptEnabled.b',
          scriptId: 'script.js.b',
          kind: 'scriptEnabled',
          hasValue: false,
          hasObject: true,
        },
      );
    });
  });

  test('falls back to getForeignStates on an instance without getStates', async () => {
    await withApi(async (api, server) => {
      seedMarkers(server);
      server.failCommand('getStates', 'Unknown command: getStates');

      const entries = await api.listScriptMarkers();
      assert.equal(entries.length, 3);
      assert.ok(entries.every((e) => e.hasValue));
    });
  });

  test('still reports markers when the object side cannot be read', async () => {
    await withApi(async (api, server) => {
      seedMarkers(server);
      server.failCommand('getForeignObjects', 'permission denied');

      const entries = await api.listScriptMarkers();
      assert.equal(entries.length, 3);
      assert.ok(entries.every((e) => e.hasValue && !e.hasObject));
    });
  });

  test('deleteScriptMarker removes the value and the object', async () => {
    await withApi(async (api, server) => {
      seedMarkers(server);
      const id = 'javascript.2.scriptEnabled.diag.gone';
      const entry = (await api.listScriptMarkers()).find((e) => e.id === id)!;

      await api.deleteScriptMarker(entry);

      assert.equal(server.getState(id), null, 'the value must be gone');
      assert.equal(server.getObject(id), null, 'the object must be gone');
      assert.ok(server.getState('javascript.1.scriptEnabled.common.garage'), 'others untouched');
    });
  });

  test('deletes the object separately where delState leaves it behind', async () => {
    await withApi(async (api, server) => {
      seedMarkers(server);
      // The behaviour of older Admin builds: the value goes, the object stays.
      server.delStateAlsoDeletesObject = false;
      const id = 'javascript.2.scriptEnabled.diag.gone';
      const entry = (await api.listScriptMarkers()).find((e) => e.id === id)!;

      await api.deleteScriptMarker(entry);

      assert.equal(server.getState(id), null);
      assert.equal(server.getObject(id), null, 'the follow-up delObject must have run');
    });
  });

  /**
   * The failure mode that matters: deleting the object while the value survives is
   * what produces the "state has no object" warning in the first place. A delState
   * that fails must abort before that can happen.
   */
  test('a failed value delete leaves the object alone rather than orphaning it', async () => {
    await withApi(async (api, server) => {
      seedMarkers(server);
      const id = 'javascript.2.scriptEnabled.diag.gone';
      const entry = (await api.listScriptMarkers()).find((e) => e.id === id)!;
      server.failCommand('delState', 'states db is read-only');

      await assert.rejects(() => api.deleteScriptMarker(entry));

      assert.ok(server.getState(id), 'the value is still there');
      assert.ok(server.getObject(id), 'so the object must be too');
    });
  });

  test('refuses an id outside the marker namespaces', async () => {
    await withApi(async (api, server) => {
      server.seedMarker('javascript.0.variables.someUserState', 42);

      await assert.rejects(
        () =>
          api.deleteScriptMarker({
            id: 'javascript.0.variables.someUserState',
            scriptId: 'script.js.someUserState',
            kind: 'scriptEnabled',
            hasValue: true,
            hasObject: true,
          }),
        /Refusing to delete/,
      );
      assert.ok(server.getState('javascript.0.variables.someUserState'));
    });
  });

  /**
   * The defect a live instance caught: the adapter creates `scriptEnabled` and
   * `scriptProblem` together and deletes them together, so anything that handles only
   * the first cleans up half a mess and reports success.
   */
  test('lists scriptProblem states alongside scriptEnabled ones', async () => {
    await withApi(async (api, server) => {
      server.seedMarker('javascript.1.scriptEnabled.diag.gone', true);
      server.seedMarker('javascript.1.scriptProblem.diag.gone', false);
      server.seedMarker('javascript.2.scriptProblem.diag.gone', false);

      const entries = await api.listScriptMarkers();

      assert.deepEqual(
        entries.map((e) => `${e.kind} ${e.id}`),
        [
          'scriptEnabled javascript.1.scriptEnabled.diag.gone',
          'scriptProblem javascript.1.scriptProblem.diag.gone',
          'scriptProblem javascript.2.scriptProblem.diag.gone',
        ],
      );
      assert.ok(
        entries.every((e) => e.scriptId === 'script.js.diag.gone'),
        'both kinds must map back to the same script',
      );
    });
  });

  /**
   * A script may legitimately be *named* after a marker kind, which puts the infix in the
   * id twice. Only the leading occurrence, right after a numeric instance, identifies the
   * marker; the rest belongs to the script name. Getting this backwards would map a state
   * onto the wrong script — the one mistake here that could delete something real.
   */
  test('maps an id whose script name contains a marker kind back to the right script', async () => {
    await withApi(async (api, server) => {
      server.seedMarker('javascript.1.scriptProblem.foo.scriptEnabled.bar', false);

      const entries = await api.listScriptMarkers();

      assert.equal(entries.length, 1);
      assert.deepEqual(
        { ...entries[0] },
        {
          id: 'javascript.1.scriptProblem.foo.scriptEnabled.bar',
          scriptId: 'script.js.foo.scriptEnabled.bar',
          kind: 'scriptProblem',
          hasValue: true,
          hasObject: true,
        },
      );
    });
  });

  test('deletes a scriptProblem state the same way', async () => {
    await withApi(async (api, server) => {
      const id = 'javascript.2.scriptProblem.diag.gone';
      server.seedMarker(id, false);
      const entry = (await api.listScriptMarkers()).find((e) => e.id === id)!;

      assert.equal(entry.kind, 'scriptProblem');
      await api.deleteScriptMarker(entry);

      assert.equal(server.getState(id), null);
      assert.equal(server.getObject(id), null);
    });
  });
});
