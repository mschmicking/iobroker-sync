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
      assert.equal(result!._id, 'script.js.common.garage');
      assert.equal(result!.type, 'script');
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
      assert.equal(folderA!.type, 'channel');
      assert.ok(folderAB);
      assert.equal(folderAB!.type, 'channel');
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
