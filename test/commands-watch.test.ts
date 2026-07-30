/**
 * Tests for `watch`.
 *
 * The assertion that matters most is echo suppression. Pushing a script makes the
 * javascript adapter write `compiled`/`sourceHash` back onto the same object, which
 * produces an `objectChange` carrying source we just sent. If that is not recognised
 * as our own echo, `--pull` writes it to disk, chokidar sees a change, and the file
 * is pushed again — an infinite push loop against a live house.
 *
 * These drive `watch()` through its returned handle rather than a signal, which is
 * why it returns one (see WatchHandle in src/commands/watch.ts).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { FakeAdminServer } from './fake-server';
import {
  TempProject,
  entryFor,
  makeContext,
  makeTempProject,
  readLocal,
  readManifest,
  writeLocal,
  writeManifest,
} from './helpers';
import { watch } from '../src/commands/watch';
import { ScriptObject } from '../src/types';

const ID = 'script.js.common.garage';
const REL = 'common/garage.ts';
const SOURCE_A = "log('a');\n";
const SOURCE_B = "log('b');\n";
const SOURCE_C = "log('c');\n";

/**
 * Short enough to keep the suite quick, long enough to absorb chokidar emitting
 * more than one event for a single write. At 20 ms an add+change pair can straddle
 * the window and produce two pushes, which shows up as a rare CI-only failure.
 */
const DEBOUNCE = 150;

function script(source: string, overrides: Partial<ScriptObject['common']> = {}): ScriptObject {
  return {
    _id: ID,
    type: 'script',
    common: {
      name: 'garage',
      source,
      engineType: 'TypeScript/ts',
      engine: 'system.adapter.javascript.0',
      enabled: true,
      expert: true,
      ...overrides,
    },
    native: {},
  };
}

/** Polls until `cond` holds, so tests never depend on a fixed filesystem-event latency. */
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Gives the watcher a chance to do the wrong thing, for "must NOT happen" assertions. */
async function settle(): Promise<void> {
  await delay(300);
}

/**
 * Waits for a completed push. The result line is emitted last, after the manifest
 * has been saved — synchronising on the server object instead races the tail of
 * `pushFile` and makes these tests flaky.
 */
function pushLines(result: string[]): string[] {
  return result.filter((l) => l.startsWith('push'));
}

describe('watch', () => {
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
    server.seed([script(SOURCE_A)]);
    if (project) await project.cleanup();
    project = await makeTempProject();
  });

  it('pushes a local edit', async () => {
    await writeLocal(project, REL, SOURCE_A);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', SOURCE_A)]);

    const t = await makeContext(port, project);
    const handle = await watch(t.ctx, { debounceMs: DEBOUNCE });
    try {
      await writeLocal(project, REL, SOURCE_B);
      await waitFor(
        () => pushLines(t.captured.result).some((l) => l.includes(REL)),
        'the push to complete',
      );

      const obj = server.getObject(ID) as ScriptObject | null;
      assert.equal(obj?.common.source, SOURCE_B);
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('ignores the adapter write-back instead of pushing it again (infinite-loop guard)', async () => {
    await writeLocal(project, REL, SOURCE_A);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', SOURCE_A)]);

    const t = await makeContext(port, project);
    const handle = await watch(t.ctx, { pull: true, debounceMs: DEBOUNCE });
    try {
      await writeLocal(project, REL, SOURCE_B);
      await waitFor(() => pushLines(t.captured.result).length >= 1, 'the push to complete');

      // What the javascript adapter does after a push: same source, plus the
      // fields it manages itself.
      server.emitObjectChange(
        ID,
        script(SOURCE_B, {
          sourceHash: 'recomputed-by-the-adapter',
          compiled: 'var b = 1;',
        }),
      );
      await settle();

      assert.deepEqual(
        t.captured.result.filter((l) => l.startsWith('pull')),
        [],
        'the adapter write-back must not be pulled back to disk',
      );
      assert.equal(
        pushLines(t.captured.result).length,
        1,
        `exactly one push expected, got ${JSON.stringify(t.captured.result)}`,
      );
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('collapses rapid saves into a single push', async () => {
    await writeLocal(project, REL, SOURCE_A);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', SOURCE_A)]);

    // A generous window plus synchronous writes, so this asserts that the debounce
    // coalesces — not that the runner's disk is fast. With an async helper and a
    // 120 ms window, three awaited writes can straddle the window on a loaded CI
    // machine and legitimately produce two pushes.
    const t = await makeContext(port, project);
    const handle = await watch(t.ctx, { debounceMs: 1000 });
    try {
      const target = path.join(project.scriptRoot, REL);
      writeFileSync(target, "log('1');\n", 'utf8');
      writeFileSync(target, "log('2');\n", 'utf8');
      writeFileSync(target, SOURCE_B, 'utf8');

      await waitFor(() => pushLines(t.captured.result).length >= 1, 'the push to complete', 8000);
      await settle();

      assert.equal(
        pushLines(t.captured.result).length,
        1,
        `debounce should coalesce, got ${JSON.stringify(t.captured.result)}`,
      );
      const obj = server.getObject(ID) as ScriptObject | null;
      assert.equal(obj?.common.source, SOURCE_B, 'the last edit wins');
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('--pull writes a remote change to disk and updates the manifest', async () => {
    await writeLocal(project, REL, SOURCE_A);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', SOURCE_A)]);

    const t = await makeContext(port, project);
    const handle = await watch(t.ctx, { pull: true, debounceMs: DEBOUNCE });
    try {
      server.emitObjectChange(ID, script(SOURCE_C));

      await waitFor(
        async () => (await readLocal(project, REL)) === SOURCE_C,
        'the remote change on disk',
      );

      const manifest = await readManifest(project.root);
      assert.equal(manifest.entries[ID]?.path, REL);
      assert.ok(
        t.captured.result.some((l) => l.startsWith('pull')),
        `expected a pull line, got ${JSON.stringify(t.captured.result)}`,
      );
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('refuses to overwrite local edits when the remote also changed', async () => {
    // Local is dirty relative to the manifest baseline, and never pushed:
    // chokidar runs with ignoreInitial, so writing before watch() starts is inert.
    await writeLocal(project, REL, SOURCE_B);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', SOURCE_A)]);

    const t = await makeContext(port, project);
    const handle = await watch(t.ctx, { pull: true, debounceMs: DEBOUNCE });
    try {
      server.emitObjectChange(ID, script(SOURCE_C));

      await waitFor(
        () => t.captured.warn.some((w) => w.includes('conflict')),
        'a conflict warning',
      );
      assert.equal(await readLocal(project, REL), SOURCE_B, 'local edits must survive');
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('--dry-run reports but does not touch the server', async () => {
    await writeLocal(project, REL, SOURCE_A);
    await writeManifest(project.root, [entryFor(ID, REL, 'TypeScript/ts', SOURCE_A)]);

    const t = await makeContext(port, project, { dryRun: true });
    const handle = await watch(t.ctx, { debounceMs: DEBOUNCE });
    try {
      await writeLocal(project, REL, SOURCE_B);
      await waitFor(
        () => t.captured.result.some((l) => l.includes('(dry-run)')),
        'a dry-run report',
      );

      const obj = server.getObject(ID) as ScriptObject | null;
      assert.equal(obj?.common.source, SOURCE_A, 'server must be untouched under --dry-run');
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('stop() is idempotent', async () => {
    const t = await makeContext(port, project);
    const handle = await watch(t.ctx, { pull: true, debounceMs: DEBOUNCE });
    try {
      await handle.stop();
      await handle.stop();
    } finally {
      await t.close();
    }
  });
});
