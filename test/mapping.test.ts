import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  engineTypeToExtension,
  extensionToEngineType,
  idToRelPath,
  relPathToId,
  resolveName,
  normalizeSource,
  hashSource,
  isEditableEngineType,
} from '../src/sync/mapping';
import { ENGINE_TYPES } from '../src/types';

describe('engineTypeToExtension', () => {
  test('maps all four canonical engine types', () => {
    assert.equal(engineTypeToExtension(ENGINE_TYPES.javascript), '.js');
    assert.equal(engineTypeToExtension(ENGINE_TYPES.typescript), '.ts');
    assert.equal(engineTypeToExtension(ENGINE_TYPES.blockly), '.block');
    assert.equal(engineTypeToExtension(ENGINE_TYPES.rules), '.rules');
  });

  test('is case-insensitive', () => {
    assert.equal(engineTypeToExtension('javascript/js'), '.js');
    assert.equal(engineTypeToExtension('TYPESCRIPT/TS'), '.ts');
    assert.equal(engineTypeToExtension('blockly'), '.block');
    assert.equal(engineTypeToExtension('RULES'), '.rules');
  });

  test('falls back to .txt for unknown engine types', () => {
    assert.equal(engineTypeToExtension('SomethingElse'), '.txt');
    assert.equal(engineTypeToExtension(''), '.txt');
  });
});

describe('extensionToEngineType', () => {
  test('maps known extensions back to canonical engine types', () => {
    assert.equal(extensionToEngineType('foo.js'), ENGINE_TYPES.javascript);
    assert.equal(extensionToEngineType('common/garage.ts'), ENGINE_TYPES.typescript);
    assert.equal(extensionToEngineType('a/b/c.block'), ENGINE_TYPES.blockly);
    assert.equal(extensionToEngineType('rules.rules'), ENGINE_TYPES.rules);
  });

  test('is case-insensitive on the extension', () => {
    assert.equal(extensionToEngineType('foo.JS'), ENGINE_TYPES.javascript);
  });

  test('returns undefined for unknown or missing extensions', () => {
    assert.equal(extensionToEngineType('foo.txt'), undefined);
    assert.equal(extensionToEngineType('foo'), undefined);
  });
});

describe('idToRelPath', () => {
  test('nested folder, TypeScript', () => {
    assert.equal(idToRelPath('script.js.common.garage', 'TypeScript/ts'), 'common/garage.ts');
  });

  test('root-level script, Javascript', () => {
    assert.equal(idToRelPath('script.js.Switch-Musiccast', 'Javascript/js'), 'Switch-Musiccast.js');
  });

  test('deeper nesting with hyphens and underscores', () => {
    assert.equal(
      idToRelPath('script.js.Rollos.astroControl_sun_temp_tracker', 'TypeScript/ts'),
      'Rollos/astroControl_sun_temp_tracker.ts',
    );
  });

  test('Blockly and Rules extensions', () => {
    assert.equal(idToRelPath('script.js.foo', 'Blockly'), 'foo.block');
    assert.equal(idToRelPath('script.js.foo', 'Rules'), 'foo.rules');
  });

  test('always uses POSIX separators', () => {
    const p = idToRelPath('script.js.a.b.c', 'Javascript/js');
    assert.ok(!p.includes('\\'));
    assert.equal(p, 'a/b/c.js');
  });
});

describe('relPathToId', () => {
  test('inverse of idToRelPath for clean ids (round trip)', () => {
    const ids = [
      'script.js.common.garage',
      'script.js.Switch-Musiccast',
      'script.js.Rollos.astroControl_sun_temp_tracker',
    ];
    for (const id of ids) {
      const relPath = idToRelPath(id, 'TypeScript/ts');
      assert.equal(relPathToId(relPath), id);
    }
  });

  test('root-level file', () => {
    assert.equal(relPathToId('Switch-Musiccast.js'), 'script.js.Switch-Musiccast');
  });

  test('nested file', () => {
    assert.equal(
      relPathToId('Rollos/astroControl_sun_temp_tracker.ts'),
      'script.js.Rollos.astroControl_sun_temp_tracker',
    );
  });

  test('sanitises spaces and disallowed characters within a segment', () => {
    assert.equal(relPathToId('My Folder/My Script.js'), 'script.js.My_Folder.My_Script');
    assert.equal(relPathToId('weird&name#here.js'), 'script.js.weird_name_here');
  });

  test('sanitises a literal extra dot left inside a segment', () => {
    assert.equal(relPathToId('foo/bar.baz.js'), 'script.js.foo.bar_baz');
  });
});

describe('resolveName', () => {
  test('plain string', () => {
    assert.equal(resolveName('Garage'), 'Garage');
  });

  test('multilingual object prefers en', () => {
    assert.equal(resolveName({ en: 'Garage', de: 'Garage DE' }), 'Garage');
  });

  test('multilingual object with only de falls back to first available', () => {
    assert.equal(resolveName({ de: 'Nur Deutsch' }), 'Nur Deutsch');
  });

  test('empty object returns empty string', () => {
    assert.equal(resolveName({}), '');
  });

  test('undefined returns empty string', () => {
    assert.equal(resolveName(undefined), '');
  });
});

describe('normalizeSource / hashSource', () => {
  test('CRLF is normalised to LF', () => {
    assert.equal(normalizeSource('a\r\nb\r\nc'), 'a\nb\nc');
  });

  test('LF-only text is unchanged', () => {
    assert.equal(normalizeSource('a\nb\nc'), 'a\nb\nc');
  });

  test('hashSource is stable and normalises before hashing', () => {
    const withCrlf = 'console.log(1);\r\nconsole.log(2);\r\n';
    const withLf = 'console.log(1);\nconsole.log(2);\n';
    assert.equal(hashSource(withCrlf), hashSource(withLf));
  });

  test('hashSource returns a 64-char hex sha256 digest', () => {
    const h = hashSource('hello world');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test('different content hashes differently', () => {
    assert.notEqual(hashSource('a'), hashSource('b'));
  });
});

describe('isEditableEngineType', () => {
  test('Javascript and TypeScript are editable', () => {
    assert.equal(isEditableEngineType(ENGINE_TYPES.javascript), true);
    assert.equal(isEditableEngineType(ENGINE_TYPES.typescript), true);
  });

  test('Blockly and Rules are not editable', () => {
    assert.equal(isEditableEngineType(ENGINE_TYPES.blockly), false);
    assert.equal(isEditableEngineType(ENGINE_TYPES.rules), false);
  });

  test('is case-insensitive', () => {
    assert.equal(isEditableEngineType('blockly'), false);
    assert.equal(isEditableEngineType('rules'), false);
  });
});
