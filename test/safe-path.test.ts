import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveWithinRoot, safeWriteFile } from '../src/sync/safe-path';
import { UserError } from '../src/types';
import { makeTempProject } from './helpers';

describe('resolveWithinRoot', () => {
  test('resolves an ordinary relative path inside root', async () => {
    const project = await makeTempProject();
    try {
      const resolved = resolveWithinRoot(project.scriptRoot, 'foo/bar.js');
      assert.equal(resolved, path.join(project.scriptRoot, 'foo', 'bar.js'));
    } finally {
      await project.cleanup();
    }
  });

  test('refuses ../ segments that escape root', async () => {
    const project = await makeTempProject();
    try {
      assert.throws(() => resolveWithinRoot(project.scriptRoot, '../../../etc/passwd'), UserError);
      assert.throws(() => resolveWithinRoot(project.scriptRoot, '../outside.js'), UserError);
      assert.throws(
        () => resolveWithinRoot(project.scriptRoot, 'a/../../../outside.js'),
        UserError,
      );
    } finally {
      await project.cleanup();
    }
  });

  test('refuses an absolute relPath', () => {
    // path.resolve(absRoot, '/etc/passwd') discards absRoot entirely per Node's
    // resolve semantics (an absolute later segment resets the path), so this must
    // be caught by the containment check, not silently anchored under root.
    assert.throws(() => resolveWithinRoot('/tmp/some-root', '/etc/passwd'), UserError);
  });
});

describe('safeWriteFile', () => {
  test('writes an ordinary file inside root', async () => {
    const project = await makeTempProject();
    try {
      const written = await safeWriteFile(project.scriptRoot, 'common/foo.js', 'hello');
      assert.equal(await fs.readFile(written, 'utf8'), 'hello');
    } finally {
      await project.cleanup();
    }
  });

  test('creates intermediate directories as needed', async () => {
    const project = await makeTempProject();
    try {
      await safeWriteFile(project.scriptRoot, 'a/b/c/deep.js', 'x');
      assert.equal(await fs.readFile(path.join(project.scriptRoot, 'a/b/c/deep.js'), 'utf8'), 'x');
    } finally {
      await project.cleanup();
    }
  });

  test('refuses a path that traverses outside root and does not touch the target', async () => {
    const project = await makeTempProject();
    try {
      const victim = path.join(project.root, 'outside.js');
      await fs.writeFile(victim, 'ORIGINAL');

      await assert.rejects(
        () => safeWriteFile(project.scriptRoot, '../outside.js', 'PWNED'),
        UserError,
      );
      assert.equal(await fs.readFile(victim, 'utf8'), 'ORIGINAL');
    } finally {
      await project.cleanup();
    }
  });

  test('refuses to write through a symlink pointing outside root, leaving the target untouched', async () => {
    const project = await makeTempProject();
    try {
      const victim = path.join(project.root, 'victim.txt');
      await fs.writeFile(victim, 'ORIGINAL CONTENT');
      await fs.symlink(victim, path.join(project.scriptRoot, 'foo.js'));

      await assert.rejects(
        () => safeWriteFile(project.scriptRoot, 'foo.js', 'OVERWRITTEN'),
        UserError,
      );
      assert.equal(await fs.readFile(victim, 'utf8'), 'ORIGINAL CONTENT');
    } finally {
      await project.cleanup();
    }
  });

  test('refuses to write through a symlinked directory pointing outside root', async () => {
    const project = await makeTempProject();
    try {
      const outsideDir = path.join(project.root, 'outside-dir');
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(project.scriptRoot, 'linked'));

      await assert.rejects(
        () => safeWriteFile(project.scriptRoot, 'linked/evil.js', 'PWNED'),
        UserError,
      );
      assert.equal(await fs.readdir(outsideDir).then((e) => e.length), 0);
    } finally {
      await project.cleanup();
    }
  });
});
