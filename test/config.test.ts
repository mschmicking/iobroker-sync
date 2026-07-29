/**
 * Tests for config loading and validation.
 *
 * `loadConfig` walks up from the working directory, so the upward search and the
 * validation rules that guard `scriptRoot` (which is later joined onto the project
 * root and written into) are the parts worth pinning down.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { defaultConfig, loadConfig, writeConfig } from '../src/config';
import { CONFIG_FILENAME, Config, UserError } from '../src/types';
import { TempProject, makeTempProject, testConfig } from './helpers';

async function writeRawConfig(root: string, contents: string): Promise<void> {
  await fs.writeFile(path.join(root, CONFIG_FILENAME), contents, 'utf8');
}

async function expectUserError(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof UserError, `expected UserError, got ${String(err)}`);
    assert.match(err.message, pattern);
    return true;
  });
}

describe('loadConfig', () => {
  let project: TempProject;

  beforeEach(async () => {
    project = await makeTempProject();
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('round-trips a config written by writeConfig', async () => {
    const written = testConfig({ url: 'https://iobroker.example:8081', username: 'admin' });
    await writeConfig(project.root, written);

    const { root, config } = await loadConfig(project.root);

    assert.equal(root, project.root);
    assert.deepEqual(config, written);
  });

  it('finds the config from a nested directory and reports the project root', async () => {
    await writeConfig(project.root, testConfig());
    const nested = path.join(project.scriptRoot, 'a', 'b');
    await fs.mkdir(nested, { recursive: true });

    const { root } = await loadConfig(nested);

    assert.equal(root, project.root, 'root must be where the config lives, not the start dir');
  });

  it('fails with an init hint when no config exists anywhere above', async () => {
    await expectUserError(() => loadConfig(project.root), /could not find/i);
  });

  it('reports malformed JSON as such rather than as a missing field', async () => {
    await writeRawConfig(project.root, '{ not json ');

    await expectUserError(() => loadConfig(project.root), /could not parse/i);
  });

  it('rejects a config that is not a JSON object', async () => {
    await writeRawConfig(project.root, '["nope"]');

    await expectUserError(() => loadConfig(project.root), /must contain a JSON object/i);
  });

  for (const field of ['url', 'scriptRoot', 'allowSelfSigned', 'defaultInstance'] as const) {
    it(`rejects a config missing "${field}"`, async () => {
      const partial: Record<string, unknown> = { ...testConfig() };
      delete partial[field];
      await writeRawConfig(project.root, JSON.stringify(partial));

      await expectUserError(() => loadConfig(project.root), new RegExp(field));
    });
  }

  it('rejects a non-http scheme', async () => {
    await writeRawConfig(project.root, JSON.stringify(testConfig({ url: 'ftp://host/' })));

    await expectUserError(() => loadConfig(project.root), /must use http or https/i);
  });

  it('rejects a url that is not a url at all', async () => {
    await writeRawConfig(project.root, JSON.stringify(testConfig({ url: 'not-a-url' })));

    await expectUserError(() => loadConfig(project.root), /invalid "url"/i);
  });

  it('rejects an absolute scriptRoot', async () => {
    await writeRawConfig(project.root, JSON.stringify(testConfig({ scriptRoot: '/etc' })));

    await expectUserError(() => loadConfig(project.root), /must be relative/i);
  });

  it('rejects a scriptRoot that escapes the project root', async () => {
    // scriptRoot is resolved against the project root and then written into, so a
    // `..` here would let a config file place scripts anywhere on the filesystem.
    await writeRawConfig(project.root, JSON.stringify(testConfig({ scriptRoot: '../outside' })));

    await expectUserError(() => loadConfig(project.root), /must not escape/i);
  });

  it('accepts a null username but not a numeric one', async () => {
    await writeRawConfig(project.root, JSON.stringify(testConfig({ username: null })));
    assert.equal((await loadConfig(project.root)).config.username, null);

    await writeRawConfig(
      project.root,
      JSON.stringify({ ...testConfig(), username: 42 } as unknown as Config),
    );
    await expectUserError(() => loadConfig(project.root), /username/i);
  });
});

describe('defaultConfig', () => {
  it('produces a config that loadConfig accepts', async () => {
    const project = await makeTempProject();
    try {
      await writeConfig(project.root, defaultConfig('http://127.0.0.1:8081'));

      const { config } = await loadConfig(project.root);
      assert.equal(config.scriptRoot, 'scripts');
      assert.equal(config.username, null);
      assert.equal(config.allowSelfSigned, false);
    } finally {
      await project.cleanup();
    }
  });

  it('validates the url up front instead of writing a broken config', () => {
    assert.throws(() => defaultConfig('nope'), UserError);
  });
});
