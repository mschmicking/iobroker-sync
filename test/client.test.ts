import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdminSocketClient } from '../src/client/socket';
import { FakeAdminServer, defaultSeed } from './fake-server';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withServer<T>(
  fn: (server: FakeAdminServer, port: number) => Promise<T>,
): Promise<T> {
  const server = new FakeAdminServer();
  server.seed(defaultSeed());
  const port = await server.start();
  try {
    return await fn(server, port);
  } finally {
    await server.stop();
  }
}

describe('AdminSocketClient: connect', () => {
  test('resolves after ___ready___ and reports connected', async () => {
    await withServer(async (_server, port) => {
      const client = new AdminSocketClient({ url: `http://localhost:${port}` });
      try {
        assert.equal(client.connected, false);
        await client.connect();
        assert.equal(client.connected, true);
      } finally {
        await client.close();
      }
    });
  });

  test('rejects when ___ready___ never arrives before the connect timeout', async () => {
    await withServer(async (server, port) => {
      server.readyDelayMs = 400;
      const client = new AdminSocketClient({ url: `http://localhost:${port}`, connectTimeoutMs: 100 });
      try {
        await assert.rejects(() => client.connect(), /Timed out waiting/);
        assert.equal(client.connected, false);
      } finally {
        await client.close();
      }
    });
  });
});

describe('AdminSocketClient: emit', () => {
  test('resolves with the callback result', async () => {
    await withServer(async (_server, port) => {
      const client = new AdminSocketClient({ url: `http://localhost:${port}` });
      try {
        await client.connect();
        const result = await client.emit('getObject', ['script.js.common.garage']);
        assert.ok(result);
        assert.equal((result as { _id: string })._id, 'script.js.common.garage');
      } finally {
        await client.close();
      }
    });
  });

  test('rejects when the server returns a non-null error', async () => {
    await withServer(async (server, port) => {
      server.failCommand('getObject', 'Simulated failure');
      const client = new AdminSocketClient({ url: `http://localhost:${port}` });
      try {
        await client.connect();
        await assert.rejects(
          () => client.emit('getObject', ['script.js.common.garage']),
          /Simulated failure/,
        );
      } finally {
        await client.close();
      }
    });
  });

  test('unknown command exercises the error path', async () => {
    await withServer(async (_server, port) => {
      const client = new AdminSocketClient({ url: `http://localhost:${port}` });
      try {
        await client.connect();
        await assert.rejects(() => client.emit('totallyUnknownCommand', []));
      } finally {
        await client.close();
      }
    });
  });

  test('request timeout rejects and does not leak the pending entry', async () => {
    await withServer(async (server, port) => {
      const client = new AdminSocketClient({ url: `http://localhost:${port}`, requestTimeoutMs: 80 });
      try {
        await client.connect();
        server.delayCommand('getObject', 300);
        await assert.rejects(
          () => client.emit('getObject', ['script.js.common.garage']),
          /timed out/,
        );
        // A later request on the same client must still work: the timed-out
        // entry must not have wedged internal state (e.g. a stale pending map entry).
        const result = await client.emit('getObject', ['script.js.common.garage']);
        assert.ok(result);
      } finally {
        await client.close();
      }
    });
  });
});

describe('AdminSocketClient: ping/pong', () => {
  test('answers a server-sent ping with a pong', async () => {
    await withServer(async (server, port) => {
      const client = new AdminSocketClient({ url: `http://localhost:${port}` });
      try {
        await client.connect();
        assert.equal(server.pongReceived, false);
        server.sendPing();
        await sleep(100);
        assert.equal(server.pongReceived, true);
      } finally {
        await client.close();
      }
    });
  });
});

describe('AdminSocketClient: subscribeObjects', () => {
  test('delivers matching objectChange events and filters out non-matching ids', async () => {
    await withServer(async (server, port) => {
      const client = new AdminSocketClient({ url: `http://localhost:${port}` });
      try {
        await client.connect();
        const received: Array<{ id: string; obj: unknown }> = [];
        await client.subscribeObjects('script.js.common.*', (id, obj) => {
          received.push({ id, obj });
        });

        server.emitObjectChange('script.js.common.garage', { _id: 'script.js.common.garage' } as never);
        server.emitObjectChange('script.js.Rollos', { _id: 'script.js.Rollos' } as never);
        server.emitObjectChange('script.js.Switch-Musiccast', { _id: 'script.js.Switch-Musiccast' } as never);
        await sleep(100);

        assert.equal(received.length, 1);
        assert.equal(received[0].id, 'script.js.common.garage');
      } finally {
        await client.close();
      }
    });
  });
});

describe('AdminSocketClient: close', () => {
  test('resolves and rejects in-flight requests', async () => {
    await withServer(async (server, port) => {
      const client = new AdminSocketClient({ url: `http://localhost:${port}`, requestTimeoutMs: 5000 });
      await client.connect();
      server.delayCommand('getObject', 5000);
      const pending = client.emit('getObject', ['script.js.common.garage']);
      const pendingRejects = assert.rejects(pending);
      await client.close();
      await pendingRejects;
      assert.equal(client.connected, false);
    });
  });
});

describe('AdminSocketClient: reconnection regression', () => {
  test('connect() after an unexpected drop genuinely re-establishes a working connection', async () => {
    const server = new FakeAdminServer();
    server.seed(defaultSeed());
    const port = await server.start();
    const client = new AdminSocketClient({ url: `http://localhost:${port}`, connectTimeoutMs: 1000, requestTimeoutMs: 1000 });
    try {
      await client.connect();
      assert.equal(client.connected, true);
      const before = await client.emit('getObject', ['script.js.common.garage']);
      assert.ok(before);

      // Simulate an unexpected drop by stopping the server entirely.
      await server.stop();
      // Give the client's websocket a moment to observe the close event.
      await sleep(100);
      assert.equal(client.connected, false);

      // Restart the server on the SAME port, as a real Admin instance restart would look
      // from the client's perspective (same URL).
      await server.start(port);

      // Bug regression: a previous implementation left a stale resolved
      // `connectPromise` around after the drop, so this second connect() would
      // silently resolve immediately without re-establishing a real socket,
      // and the emit below would hang/reject against a dead connection.
      await client.connect();
      assert.equal(client.connected, true);

      const after = await client.emit('getObject', ['script.js.common.garage']);
      assert.ok(after);
      assert.equal((after as { _id: string })._id, 'script.js.common.garage');
    } finally {
      await client.close();
      await server.stop();
    }
  });
});
