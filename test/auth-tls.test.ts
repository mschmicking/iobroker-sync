/**
 * Tests for authentication over HTTPS with a self-signed certificate.
 *
 * This is the shape of a real ioBroker install that has authentication switched on:
 * Admin will not accept a password over plain HTTP, so enabling auth means enabling
 * TLS, and a home instance's certificate is self-signed.
 *
 * Before this, `allowSelfSigned` was honoured only on the websocket connection —
 * the HTTP login path used the global `fetch`, which cannot be told to accept an
 * untrusted certificate without an `undici` Agent. Login therefore failed at the TLS
 * handshake, before any credential was even sent. `src/client/auth.ts` now uses
 * `node:https` directly so the flag applies to both.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { FakeAdminServer } from './fake-server';
import { getAuthCookie } from '../src/client/auth';
import { UserError } from '../src/types';
import { TempProject, makeTempProject } from './helpers';

const NO_PROMPT = { allowPrompt: false } as const;

describe('getAuthCookie over https with a self-signed certificate', () => {
  let server: FakeAdminServer;
  let url: string;
  let project: TempProject;
  let previousStore: string | undefined;

  before(async () => {
    server = new FakeAdminServer();
    url = `https://127.0.0.1:${await server.start(0, { tls: true })}`;
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    delete process.env.IOBROKER_PASSWORD;
    project = await makeTempProject();
    previousStore = process.env.IOBROKER_SYNC_CREDENTIALS;
    process.env.IOBROKER_SYNC_CREDENTIALS = path.join(project.root, 'credentials.json');
  });

  afterEach(async () => {
    if (previousStore === undefined) delete process.env.IOBROKER_SYNC_CREDENTIALS;
    else process.env.IOBROKER_SYNC_CREDENTIALS = previousStore;
    await project.cleanup();
  });

  it('logs in via OAuth2 when allowSelfSigned is set', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
    process.env.IOBROKER_PASSWORD = 'secret';

    const cookie = await getAuthCookie(url, 'admin', true, NO_PROMPT);

    assert.equal(cookie, 'access_token=fake-oauth-token');
  });

  it('logs in via the legacy endpoint when allowSelfSigned is set', async () => {
    server.auth = { mode: 'legacy', username: 'admin', password: 'secret' };
    process.env.IOBROKER_PASSWORD = 'secret';

    const cookie = await getAuthCookie(url, 'admin', true, NO_PROMPT);

    assert.equal(cookie, 'connect.sid=fake-session-id');
  });

  it('detects auth-disabled over https too', async () => {
    server.auth = { mode: 'disabled', username: 'admin', password: 'secret' };

    assert.equal(await getAuthCookie(url, null, true, NO_PROMPT), undefined);
  });

  it('refuses an untrusted certificate when allowSelfSigned is not set', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
    process.env.IOBROKER_PASSWORD = 'secret';

    await assert.rejects(
      () => getAuthCookie(url, 'admin', false, NO_PROMPT),
      (err: unknown) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /could not reach/i);
        return true;
      },
    );
  });

  it('tells the user exactly which setting fixes an untrusted certificate', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
    process.env.IOBROKER_PASSWORD = 'secret';

    // A raw TLS error here is close to unactionable; the hint has to name the flag.
    const err = (await getAuthCookie(url, 'admin', false, NO_PROMPT).catch(
      (e: unknown) => e,
    )) as UserError;

    assert.match(String(err.hint), /allowSelfSigned/);
  });

  it('never sends the password when the certificate is rejected', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
    process.env.IOBROKER_PASSWORD = 'secret';

    await getAuthCookie(url, 'admin', false, NO_PROMPT).catch(() => undefined);

    // The handshake fails before any request body is written, so the server must
    // not have seen a credential at all.
    assert.deepEqual(server.httpRequests, [], 'nothing may reach an untrusted server');
  });
});
