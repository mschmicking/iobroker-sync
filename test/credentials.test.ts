/**
 * Tests for the password store.
 *
 * These are security assertions, not feature assertions: the file must not be
 * readable by other users, the password must never reach the project directory, and
 * a corrupt or unreadable store must not brick every command.
 *
 * Every test points `IOBROKER_SYNC_CREDENTIALS` at a temporary file, so the
 * developer's real credentials are never read or written by the suite.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  credentialsPath,
  deleteStoredPassword,
  readStoredPassword,
  saveStoredPassword,
} from '../src/credentials';
import { TempProject, makeTempProject } from './helpers';

const URL_A = 'https://iobroker.example:8081';
const URL_B = 'https://other.example:8081';
const PASSWORD = 'correct horse battery staple';

describe('credentials store', () => {
  let project: TempProject;
  let storeFile: string;
  let previousOverride: string | undefined;

  beforeEach(async () => {
    project = await makeTempProject();
    storeFile = path.join(project.root, 'secrets', 'credentials.json');
    previousOverride = process.env.IOBROKER_SYNC_CREDENTIALS;
    process.env.IOBROKER_SYNC_CREDENTIALS = storeFile;
  });

  afterEach(async () => {
    if (previousOverride === undefined) delete process.env.IOBROKER_SYNC_CREDENTIALS;
    else process.env.IOBROKER_SYNC_CREDENTIALS = previousOverride;
    await project.cleanup();
  });

  it('round-trips a password', async () => {
    await saveStoredPassword(URL_A, 'admin', PASSWORD);

    assert.equal(await readStoredPassword(URL_A, 'admin'), PASSWORD);
  });

  it('writes the file owner-readable only', async () => {
    await saveStoredPassword(URL_A, 'admin', PASSWORD);

    const stat = await fs.stat(storeFile);
    assert.equal(
      stat.mode & 0o777,
      0o600,
      `expected mode 600, got ${(stat.mode & 0o777).toString(8)}`,
    );
  });

  it('creates the containing directory owner-accessible only', async () => {
    await saveStoredPassword(URL_A, 'admin', PASSWORD);

    const stat = await fs.stat(path.dirname(storeFile));
    assert.equal(
      stat.mode & 0o777,
      0o700,
      `expected mode 700, got ${(stat.mode & 0o777).toString(8)}`,
    );
  });

  it('leaves no readable temporary file behind', async () => {
    await saveStoredPassword(URL_A, 'admin', PASSWORD);

    const entries = await fs.readdir(path.dirname(storeFile));
    assert.deepEqual(entries, ['credentials.json'], 'the temp file must be renamed away');
  });

  it('keeps separate passwords per instance and per user', async () => {
    await saveStoredPassword(URL_A, 'admin', 'pw-a');
    await saveStoredPassword(URL_B, 'admin', 'pw-b');
    await saveStoredPassword(URL_A, 'other', 'pw-c');

    assert.equal(await readStoredPassword(URL_A, 'admin'), 'pw-a');
    assert.equal(await readStoredPassword(URL_B, 'admin'), 'pw-b');
    assert.equal(await readStoredPassword(URL_A, 'other'), 'pw-c');
  });

  it('treats a trailing slash as the same instance', async () => {
    await saveStoredPassword(URL_A, 'admin', PASSWORD);

    assert.equal(await readStoredPassword(`${URL_A}/`, 'admin'), PASSWORD);
  });

  it('returns undefined when nothing is stored', async () => {
    assert.equal(await readStoredPassword(URL_A, 'admin'), undefined);

    await saveStoredPassword(URL_A, 'admin', PASSWORD);
    assert.equal(await readStoredPassword(URL_A, 'nobody'), undefined);
  });

  it('warns when the store is readable by other users', async () => {
    await saveStoredPassword(URL_A, 'admin', PASSWORD);
    await fs.chmod(storeFile, 0o644);

    const warnings: string[] = [];
    const password = await readStoredPassword(URL_A, 'admin', (m) => warnings.push(m));

    assert.equal(password, PASSWORD, 'still usable — warning, not refusal');
    assert.ok(
      warnings.some((w) => /readable by other users/i.test(w)),
      `expected a permissions warning, got ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      warnings.every((w) => !w.includes(PASSWORD)),
      'the warning must not contain the password',
    );
  });

  it('tolerates a corrupt store rather than failing every command', async () => {
    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    await fs.writeFile(storeFile, '{ this is not json', 'utf8');

    assert.equal(await readStoredPassword(URL_A, 'admin'), undefined);

    // ...and a later save repairs it.
    await saveStoredPassword(URL_A, 'admin', PASSWORD);
    assert.equal(await readStoredPassword(URL_A, 'admin'), PASSWORD);
  });

  it('deletes a stored password and reports whether there was one', async () => {
    await saveStoredPassword(URL_A, 'admin', PASSWORD);

    assert.equal(await deleteStoredPassword(URL_A, 'admin'), true);
    assert.equal(await readStoredPassword(URL_A, 'admin'), undefined);
    assert.equal(await deleteStoredPassword(URL_A, 'admin'), false);
  });

  it('does not disturb other entries when deleting one', async () => {
    await saveStoredPassword(URL_A, 'admin', 'pw-a');
    await saveStoredPassword(URL_B, 'admin', 'pw-b');

    await deleteStoredPassword(URL_A, 'admin');

    assert.equal(await readStoredPassword(URL_B, 'admin'), 'pw-b');
  });

  it('honours IOBROKER_SYNC_CREDENTIALS, so nothing writes to the real store', () => {
    assert.equal(credentialsPath(), storeFile);
  });
});
