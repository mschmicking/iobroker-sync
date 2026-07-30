import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, LocalFileInfo, RemoteScriptInfo } from '../src/sync/compare';
import { Manifest, ManifestEntry } from '../src/types';
import { idToRelPath, relPathToId } from '../src/sync/mapping';

function entry(
  partial: Partial<ManifestEntry> & Pick<ManifestEntry, 'id' | 'path' | 'baseHash'>,
): ManifestEntry {
  return {
    engineType: 'Javascript/js',
    engine: 'system.adapter.javascript.0',
    enabled: true,
    lastSync: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function remoteInfo(
  partial: Partial<RemoteScriptInfo> & Pick<RemoteScriptInfo, 'id' | 'sourceHash'>,
): RemoteScriptInfo {
  return {
    engineType: 'Javascript/js',
    engine: 'system.adapter.javascript.0',
    enabled: true,
    ...partial,
  };
}

function localInfo(relPath: string, hash: string): LocalFileInfo {
  return { relPath, hash };
}

function byPath(results: ReturnType<typeof computeStatus>, path: string) {
  const found = results.find((r) => r.path === path);
  assert.ok(found, `expected a result for path "${path}"`);
  return found;
}

describe('computeStatus: three-way matrix', () => {
  test('same/same -> in-sync', () => {
    const manifest: Manifest = {
      version: 1,
      entries: { 'script.js.a1': entry({ id: 'script.js.a1', path: 'a1.js', baseHash: 'h1' }) },
    };
    const remote = new Map([
      ['script.js.a1', remoteInfo({ id: 'script.js.a1', sourceHash: 'h1' })],
    ]);
    const local = new Map([['a1.js', localInfo('a1.js', 'h1')]]);

    const result = byPath(computeStatus({ manifest, remote, local }), 'a1.js');
    assert.equal(result.state, 'in-sync');
    assert.equal(result.id, 'script.js.a1');
    assert.equal(result.localHash, 'h1');
    assert.equal(result.remoteHash, 'h1');
    assert.equal(result.baseHash, 'h1');
  });

  test('local differs, remote same -> local-modified', () => {
    const manifest: Manifest = {
      version: 1,
      entries: { 'script.js.a2': entry({ id: 'script.js.a2', path: 'a2.js', baseHash: 'h2' }) },
    };
    const remote = new Map([
      ['script.js.a2', remoteInfo({ id: 'script.js.a2', sourceHash: 'h2' })],
    ]);
    const local = new Map([['a2.js', localInfo('a2.js', 'h2-changed')]]);

    const result = byPath(computeStatus({ manifest, remote, local }), 'a2.js');
    assert.equal(result.state, 'local-modified');
  });

  test('local same, remote differs -> remote-modified', () => {
    const manifest: Manifest = {
      version: 1,
      entries: { 'script.js.a3': entry({ id: 'script.js.a3', path: 'a3.js', baseHash: 'h3' }) },
    };
    const remote = new Map([
      ['script.js.a3', remoteInfo({ id: 'script.js.a3', sourceHash: 'h3-changed' })],
    ]);
    const local = new Map([['a3.js', localInfo('a3.js', 'h3')]]);

    const result = byPath(computeStatus({ manifest, remote, local }), 'a3.js');
    assert.equal(result.state, 'remote-modified');
  });

  test('local differs, remote differs (different content) -> conflict', () => {
    const manifest: Manifest = {
      version: 1,
      entries: { 'script.js.a4': entry({ id: 'script.js.a4', path: 'a4.js', baseHash: 'h4' }) },
    };
    const remote = new Map([
      ['script.js.a4', remoteInfo({ id: 'script.js.a4', sourceHash: 'h4-remote' })],
    ]);
    const local = new Map([['a4.js', localInfo('a4.js', 'h4-local')]]);

    const result = byPath(computeStatus({ manifest, remote, local }), 'a4.js');
    assert.equal(result.state, 'conflict');
  });

  test('converging edits: local and remote both changed but to the SAME content -> in-sync, not conflict', () => {
    const manifest: Manifest = {
      version: 1,
      entries: { 'script.js.a5': entry({ id: 'script.js.a5', path: 'a5.js', baseHash: 'h5' }) },
    };
    const remote = new Map([
      ['script.js.a5', remoteInfo({ id: 'script.js.a5', sourceHash: 'h5-new' })],
    ]);
    const local = new Map([['a5.js', localInfo('a5.js', 'h5-new')]]);

    const result = byPath(computeStatus({ manifest, remote, local }), 'a5.js');
    assert.equal(result.state, 'in-sync');
  });
});

describe('computeStatus: extra cases', () => {
  test('in manifest + remote, missing locally -> remote-only', () => {
    const manifest: Manifest = {
      version: 1,
      entries: { 'script.js.a6': entry({ id: 'script.js.a6', path: 'a6.js', baseHash: 'h6' }) },
    };
    const remote = new Map([
      ['script.js.a6', remoteInfo({ id: 'script.js.a6', sourceHash: 'h6' })],
    ]);
    const local = new Map<string, LocalFileInfo>();

    const result = byPath(computeStatus({ manifest, remote, local }), 'a6.js');
    assert.equal(result.state, 'remote-only');
    assert.equal(result.id, 'script.js.a6');
  });

  test('in manifest + local, gone from server -> remote-missing', () => {
    const manifest: Manifest = {
      version: 1,
      entries: { 'script.js.a7': entry({ id: 'script.js.a7', path: 'a7.js', baseHash: 'h7' }) },
    };
    const remote = new Map<string, RemoteScriptInfo>();
    const local = new Map([['a7.js', localInfo('a7.js', 'h7')]]);

    const result = byPath(computeStatus({ manifest, remote, local }), 'a7.js');
    assert.equal(result.state, 'remote-missing');
    assert.equal(result.id, 'script.js.a7');
  });

  test('not in manifest, local only -> local-only', () => {
    const manifest: Manifest = { version: 1, entries: {} };
    const remote = new Map<string, RemoteScriptInfo>();
    const local = new Map([['new-file.js', localInfo('new-file.js', 'hnew')]]);

    const result = byPath(computeStatus({ manifest, remote, local }), 'new-file.js');
    assert.equal(result.state, 'local-only');
    assert.equal(result.id, relPathToId('new-file.js'));
    assert.equal(result.localHash, 'hnew');
  });

  test('not in manifest, remote only -> remote-only, path derived from id/engineType', () => {
    const manifest: Manifest = { version: 1, entries: {} };
    const remote = new Map([
      [
        'script.js.brandnew',
        remoteInfo({ id: 'script.js.brandnew', sourceHash: 'hb', engineType: 'TypeScript/ts' }),
      ],
    ]);
    const local = new Map<string, LocalFileInfo>();

    const results = computeStatus({ manifest, remote, local });
    const expectedPath = idToRelPath('script.js.brandnew', 'TypeScript/ts');
    const result = byPath(results, expectedPath);
    assert.equal(result.state, 'remote-only');
    assert.equal(result.id, 'script.js.brandnew');
  });
});

describe('computeStatus: output ordering', () => {
  test('results are sorted deterministically by path', () => {
    const manifest: Manifest = { version: 1, entries: {} };
    const remote = new Map<string, RemoteScriptInfo>();
    const local = new Map([
      ['zeta.js', localInfo('zeta.js', 'hz')],
      ['alpha.js', localInfo('alpha.js', 'ha')],
      ['middle.js', localInfo('middle.js', 'hm')],
    ]);

    const results = computeStatus({ manifest, remote, local });
    const paths = results.map((r) => r.path);
    assert.deepEqual(paths, ['alpha.js', 'middle.js', 'zeta.js']);
  });
});
