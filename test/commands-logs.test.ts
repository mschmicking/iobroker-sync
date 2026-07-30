/**
 * Tests for `logs`.
 *
 * The point of the command is that a push whose script fails to compile produces
 * *something* the user can see, so the assertions worth having are: an error line is
 * never filtered away by accident, filtering works, and the stream is read-only.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { FakeAdminServer } from './fake-server';
import { TempProject, makeContext, makeTempProject } from './helpers';
import { formatLogLine, logs } from '../src/commands/logs';
import { UserError } from '../src/types';

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Lets anything wrong have time to happen, for "must NOT appear" assertions. */
async function settle(): Promise<void> {
  await delay(150);
}

describe('logs', () => {
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
    if (project) await project.cleanup();
    project = await makeTempProject();
  });

  it('asks the server for the log stream', async () => {
    const t = await makeContext(port, project);
    const handle = await logs(t.ctx);
    try {
      assert.ok(
        server.subscriptionRequests.includes('subscribe:log'),
        `expected a log subscription, got ${JSON.stringify(server.subscriptionRequests)}`,
      );
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('prints a log line as it arrives', async () => {
    const t = await makeContext(port, project);
    const handle = await logs(t.ctx);
    try {
      server.emitLog({ message: 'garage: door opened', from: 'javascript.2' });

      await waitFor(
        () => t.captured.result.some((l) => l.includes('garage: door opened')),
        'the log line',
      );
      assert.ok(t.captured.result.some((l) => l.includes('javascript.2')));
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('shows errors even though the default level is info', async () => {
    const t = await makeContext(port, project);
    const handle = await logs(t.ctx);
    try {
      server.emitLog({ message: 'TypeError: x is not a function', severity: 'error' });

      await waitFor(() => t.captured.result.some((l) => l.includes('TypeError')), 'the error line');
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('hides debug noise below the requested level', async () => {
    const t = await makeContext(port, project);
    const handle = await logs(t.ctx, { level: 'warn' });
    try {
      server.emitLog({ message: 'chatty debug detail', severity: 'debug' });
      server.emitLog({ message: 'something is wrong', severity: 'warn' });

      await waitFor(
        () => t.captured.result.some((l) => l.includes('something is wrong')),
        'the warning',
      );
      assert.ok(
        !t.captured.result.some((l) => l.includes('chatty debug detail')),
        'debug must be filtered out at level warn',
      );
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('never hides a line whose severity it does not recognise', async () => {
    const t = await makeContext(port, project);
    const handle = await logs(t.ctx);
    try {
      // Treating an unknown severity as below-threshold could swallow a real failure.
      server.emitLog({ message: 'from the future', severity: 'catastrophe' });

      await waitFor(
        () => t.captured.result.some((l) => l.includes('from the future')),
        'the unknown-severity line',
      );
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('filters by pattern against both message and source', async () => {
    const t = await makeContext(port, project);
    const handle = await logs(t.ctx, { pattern: 'garage' });
    try {
      server.emitLog({ message: 'garage: closing', from: 'javascript.2' });
      server.emitLog({ message: 'dehumidifier: running', from: 'javascript.2' });
      await settle();

      assert.ok(t.captured.result.some((l) => l.includes('garage: closing')));
      assert.ok(
        !t.captured.result.some((l) => l.includes('dehumidifier')),
        'non-matching lines must not be printed',
      );
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('stops after --limit lines', async () => {
    const t = await makeContext(port, project);
    const handle = await logs(t.ctx, { limit: 2 });
    try {
      server.emitLog({ message: 'one' });
      server.emitLog({ message: 'two' });

      await handle.finished;
      assert.equal(t.captured.result.length, 2);
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('stops delivering once stopped', async () => {
    const t = await makeContext(port, project);
    const handle = await logs(t.ctx);

    server.emitLog({ message: 'before stop' });
    await waitFor(() => t.captured.result.length === 1, 'the first line');

    await handle.stop();
    server.emitLog({ message: 'after stop' });
    await settle();

    assert.ok(
      !t.captured.result.some((l) => l.includes('after stop')),
      'no lines may arrive after stop()',
    );
    await handle.stop(); // idempotent
    await t.close();
  });

  it('does not modify anything on the server', async () => {
    const t = await makeContext(port, project);
    const handle = await logs(t.ctx);
    try {
      const before = JSON.stringify(server.getAll());
      server.emitLog({ message: 'noise' });
      await settle();

      assert.equal(JSON.stringify(server.getAll()), before);
    } finally {
      await handle.stop();
      await t.close();
    }
  });

  it('rejects an unknown level instead of silently showing everything', async () => {
    const t = await makeContext(port, project);
    try {
      await assert.rejects(() => logs(t.ctx, { level: 'verbose' }), UserError);
    } finally {
      await t.close();
    }
  });
});

describe('formatLogLine', () => {
  it('includes time, severity, source and message', () => {
    const line = formatLogLine({
      message: 'hello',
      severity: 'warn',
      from: 'javascript.2',
      ts: Date.parse('2026-07-29T10:11:12Z'),
    });

    assert.match(line, /WARN/);
    assert.match(line, /javascript\.2/);
    assert.match(line, /hello/);
    assert.match(line, /\d{2}:\d{2}:\d{2}/);
  });

  it('survives a missing timestamp rather than printing Invalid Date', () => {
    const line = formatLogLine({
      message: 'hello',
      severity: 'info',
      from: 'javascript.0',
      ts: Number.NaN,
    });

    assert.doesNotMatch(line, /Invalid Date/);
  });
});
