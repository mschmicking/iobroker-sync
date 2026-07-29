/**
 * Tests for `diff`.
 *
 * Previously exercised against a live instance only. The behaviours worth locking
 * down are that it is strictly read-only, that it reports each divergence class,
 * and that it stays quiet when there is genuinely nothing to say.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { FakeAdminServer } from './fake-server';
import {
  TempProject,
  entryFor,
  makeContext,
  makeTempProject,
  writeLocal,
  writeManifest,
} from './helpers';
import { diff } from '../src/commands/diff';
import { backup } from '../src/commands/backup';
import { ScriptObject, UserError } from '../src/types';

const ID = 'script.js.common.garage';
const REL = 'common/garage.ts';
const REMOTE_SOURCE = "log('remote');\n";
const LOCAL_SOURCE = "log('local');\n";

function script(id: string, source: string): ScriptObject {
  return {
    _id: id,
    type: 'script',
    common: {
      name: id.slice(id.lastIndexOf('.') + 1),
      source,
      engineType: 'TypeScript/ts',
      engine: 'system.adapter.javascript.0',
      enabled: true,
      expert: true,
    },
    native: {},
  };
}

/** The whole captured output, so assertions can look for patch fragments anywhere. */
function output(all: string[]): string {
  return all.join('\n');
}

describe('diff', () => {
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
    server.seed([script(ID, REMOTE_SOURCE)]);
    if (project) await project.cleanup();
    project = await makeTempProject();
  });

  it('shows a unified patch when local and remote differ', async () => {
    await writeLocal(project, REL, LOCAL_SOURCE);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', REMOTE_SOURCE)]);

    const t = await makeContext(port, project);
    try {
      await diff(t.ctx, {});

      const text = output(t.captured.all);
      assert.match(text, /-log\('remote'\);/, 'expected the remote line as a removal');
      assert.match(text, /\+log\('local'\);/, 'expected the local line as an addition');
    } finally {
      await t.close();
    }
  });

  it('says nothing changed when local matches remote', async () => {
    await writeLocal(project, REL, REMOTE_SOURCE);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', REMOTE_SOURCE)]);

    const t = await makeContext(port, project);
    try {
      await diff(t.ctx, {});

      assert.ok(
        t.captured.info.some((l) => /no differences/i.test(l)),
        `expected a no-differences message, got ${JSON.stringify(t.captured.all)}`,
      );
      assert.deepEqual(t.captured.result, [], 'no patch should be printed');
    } finally {
      await t.close();
    }
  });

  it('treats CRLF-only differences as no change', async () => {
    // Sources are normalised to LF before comparison; a checkout with CRLF endings
    // must not report every script as modified.
    await writeLocal(project, REL, REMOTE_SOURCE.replace(/\n/g, '\r\n'));
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', REMOTE_SOURCE)]);

    const t = await makeContext(port, project);
    try {
      await diff(t.ctx, {});

      assert.deepEqual(t.captured.result, [], 'line endings alone must not produce a patch');
    } finally {
      await t.close();
    }
  });

  it('reports a script that exists only locally', async () => {
    await writeLocal(project, 'common/new-one.ts', LOCAL_SOURCE);

    const t = await makeContext(port, project);
    try {
      await diff(t.ctx, {});

      const text = output(t.captured.all);
      assert.match(text, /new-one\.ts/);
      assert.match(text, /\+log\('local'\);/);
    } finally {
      await t.close();
    }
  });

  it('reports a script that exists only remotely', async () => {
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', REMOTE_SOURCE)]);

    const t = await makeContext(port, project);
    try {
      await diff(t.ctx, {});

      const text = output(t.captured.all);
      assert.match(text, /garage\.ts/);
      assert.match(text, /-log\('remote'\);/);
    } finally {
      await t.close();
    }
  });

  it('honours a pattern', async () => {
    server.seed([script('script.js.other', "log('other');\n")]);
    await writeLocal(project, REL, LOCAL_SOURCE);
    await writeLocal(project, 'other.ts', "log('other-local');\n");

    const t = await makeContext(port, project);
    try {
      await diff(t.ctx, { pattern: 'garage' });

      const text = output(t.captured.all);
      assert.match(text, /garage/);
      assert.doesNotMatch(text, /other-local/, 'the pattern must exclude the other script');
    } finally {
      await t.close();
    }
  });

  describe('--against a backup snapshot', () => {
    it('shows what changed since the snapshot was taken', async () => {
      await writeLocal(project, REL, REMOTE_SOURCE);
      const t = await makeContext(port, project);
      try {
        await backup(t.ctx);
        await writeLocal(project, REL, LOCAL_SOURCE);

        await diff(t.ctx, { against: 'latest' });

        const text = output(t.captured.all);
        assert.match(text, /-log\('remote'\);/, 'the snapshot content as a removal');
        assert.match(text, /\+log\('local'\);/, 'the working tree as an addition');
      } finally {
        await t.close();
      }
    });

    it('says nothing changed when the working tree matches the snapshot', async () => {
      await writeLocal(project, REL, REMOTE_SOURCE);
      const t = await makeContext(port, project);
      try {
        await backup(t.ctx);

        await diff(t.ctx, { against: 'latest' });

        assert.ok(
          t.captured.info.some((l) => /no differences against this snapshot/i.test(l)),
          `expected a no-differences message, got ${JSON.stringify(t.captured.info)}`,
        );
      } finally {
        await t.close();
      }
    });

    it('reports a file deleted since the snapshot', async () => {
      await writeLocal(project, REL, REMOTE_SOURCE);
      const t = await makeContext(port, project);
      try {
        await backup(t.ctx);
        await fs.rm(path.join(project.scriptRoot, REL));

        await diff(t.ctx, { against: 'latest' });

        assert.match(output(t.captured.all), /missing-locally/);
      } finally {
        await t.close();
      }
    });

    it('surfaces that a script was disabled when the snapshot was taken', async () => {
      // `push` cannot restore common.enabled, so the snapshot is the only record —
      // it would be useless if diff stayed silent about it.
      server.reset();
      server.seed([{ ...script(ID, REMOTE_SOURCE), common: { ...script(ID, REMOTE_SOURCE).common, enabled: false } }]);
      await writeLocal(project, REL, REMOTE_SOURCE);

      const t = await makeContext(port, project);
      try {
        await backup(t.ctx);

        await diff(t.ctx, { against: 'latest' });

        assert.ok(
          t.captured.info.some((l) => /was disabled when this snapshot/i.test(l)),
          `expected a disabled note, got ${JSON.stringify(t.captured.info)}`,
        );
      } finally {
        await t.close();
      }
    });

    it('never contacts the server', async () => {
      await writeLocal(project, REL, REMOTE_SOURCE);
      const t = await makeContext(port, project);
      try {
        await backup(t.ctx);
        await writeLocal(project, REL, LOCAL_SOURCE);
        await t.close();

        // The socket is closed: any attempt to scan the server would throw.
        await diff(t.ctx, { against: 'latest' });

        assert.match(output(t.captured.all), /\+log\('local'\);/);
      } finally {
        await t.close();
      }
    });

    it('refuses an unknown snapshot name and lists what exists', async () => {
      await writeLocal(project, REL, REMOTE_SOURCE);
      const t = await makeContext(port, project);
      try {
        await backup(t.ctx);

        await assert.rejects(
          () => diff(t.ctx, { against: 'not-a-snapshot' }),
          (err: unknown) => {
            assert.ok(err instanceof UserError);
            assert.match(err.message, /no snapshot named/i);
            assert.match(String(err.hint), /Available:/);
            return true;
          },
        );
      } finally {
        await t.close();
      }
    });

    it('points at `backup` when there are no snapshots at all', async () => {
      const t = await makeContext(port, project);
      try {
        await assert.rejects(
          () => diff(t.ctx, { against: 'latest' }),
          (err: unknown) => {
            assert.ok(err instanceof UserError);
            assert.match(String(err.hint), /iob-sync backup/);
            return true;
          },
        );
      } finally {
        await t.close();
      }
    });
  });

  it('does not modify the server or the working tree', async () => {
    await writeLocal(project, REL, LOCAL_SOURCE);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', REMOTE_SOURCE)]);

    const t = await makeContext(port, project);
    try {
      const before = JSON.stringify(server.getAll());
      await diff(t.ctx, {});

      assert.equal(JSON.stringify(server.getAll()), before, 'diff must be read-only');
      const obj = server.getObject(ID) as ScriptObject | null;
      assert.equal(obj?.common.source, REMOTE_SOURCE);
    } finally {
      await t.close();
    }
  });
});
