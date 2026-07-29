/**
 * Tests for `getAuthCookie`.
 *
 * Until now only the auth-disabled fast path (`GET /login` -> 404) had ever run,
 * in tests or in real use. The OAuth2 and legacy login paths were written but never
 * executed even once — and they are the paths almost every ioBroker instance with
 * authentication switched on will take.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { FakeAdminServer } from './fake-server';
import { getAuthCookie } from '../src/client/auth';
import { saveStoredPassword } from '../src/credentials';
import { UserError } from '../src/types';
import { TempProject, makeTempProject } from './helpers';

/**
 * Never prompt: the suite must not block on a terminal, and must not read the
 * developer's real credentials file.
 */
const NO_PROMPT = { allowPrompt: false } as const;

describe('getAuthCookie', () => {
  let server: FakeAdminServer;
  let url: string;
  let project: TempProject;
  let previousStore: string | undefined;

  before(async () => {
    server = new FakeAdminServer();
    url = `http://127.0.0.1:${await server.start()}`;
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

  it('returns no cookie when authentication is disabled', async () => {
    server.auth = { mode: 'disabled', username: 'admin', password: 'secret' };

    assert.equal(await getAuthCookie(url, null, false, NO_PROMPT), undefined);
  });

  it('never sends a password to an instance that does not require one', async () => {
    server.auth = { mode: 'disabled', username: 'admin', password: 'secret' };
    process.env.IOBROKER_PASSWORD = 'secret';

    await getAuthCookie(url, 'admin', false, NO_PROMPT);

    assert.deepEqual(
      server.httpRequests.map((r) => `${r.method} ${r.path}`),
      ['GET /login'],
      'the 404 probe must be the only request made',
    );
  });

  it('logs in via OAuth2 and returns the access_token cookie', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
    process.env.IOBROKER_PASSWORD = 'secret';

    const cookie = await getAuthCookie(url, 'admin', false, NO_PROMPT);

    assert.equal(cookie, 'access_token=fake-oauth-token');

    const tokenReq = server.httpRequests.find((r) => r.path === '/oauth/token');
    assert.ok(tokenReq, 'expected a token request');
    const form = new URLSearchParams(tokenReq.body);
    assert.equal(form.get('grant_type'), 'password');
    assert.equal(form.get('username'), 'admin');
  });

  it('falls back to the legacy login when OAuth2 is unavailable', async () => {
    server.auth = { mode: 'legacy', username: 'admin', password: 'secret' };
    process.env.IOBROKER_PASSWORD = 'secret';

    const cookie = await getAuthCookie(url, 'admin', false, NO_PROMPT);

    assert.equal(cookie, 'connect.sid=fake-session-id');
    assert.ok(
      server.httpRequests.some((r) => r.path === '/oauth/token'),
      'OAuth2 should be attempted first',
    );
    assert.ok(
      server.httpRequests.some((r) => r.method === 'POST' && r.path === '/login'),
      'then the legacy login',
    );
  });

  it('fails with a clear error when a password is required but not set', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };

    await assert.rejects(
      () => getAuthCookie(url, 'admin', false, NO_PROMPT),
      (err: unknown) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /requires authentication/i);
        return true;
      },
    );
  });

  it('fails rather than returning undefined when the credentials are wrong', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
    process.env.IOBROKER_PASSWORD = 'wrong-password';

    // Both paths reject the bad password, so neither yields a cookie. Returning
    // undefined here would look exactly like "auth disabled" and produce a
    // confusing websocket failure later instead of a login error now.
    await assert.rejects(
      () => getAuthCookie(url, 'admin', false, NO_PROMPT),
      (err: unknown) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /login/i);
        return true;
      },
    );
  });

  it('reports an unreachable instance as a connection problem', async () => {
    await assert.rejects(
      // Port 1 is not listening; this must not surface as a login failure.
      () => getAuthCookie('http://127.0.0.1:1', null, false, NO_PROMPT),
      (err: unknown) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /could not reach/i);
        return true;
      },
    );
  });

  it('tolerates a trailing slash on the configured URL', async () => {
    server.auth = { mode: 'disabled', username: 'admin', password: 'secret' };

    assert.equal(await getAuthCookie(`${url}/`, null, false, NO_PROMPT), undefined);
    assert.deepEqual(
      server.httpRequests.map((r) => r.path),
      ['/login'],
      'a doubled slash would 404 for the wrong reason',
    );
  });

  it('uses a saved password when the environment has none', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
    await saveStoredPassword(url, 'admin', 'secret');

    assert.equal(await getAuthCookie(url, 'admin', false, NO_PROMPT), 'access_token=fake-oauth-token');
  });

  it('prefers IOBROKER_PASSWORD over the saved password', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'from-env' };
    await saveStoredPassword(url, 'admin', 'stale-saved-password');
    process.env.IOBROKER_PASSWORD = 'from-env';

    assert.equal(await getAuthCookie(url, 'admin', false, NO_PROMPT), 'access_token=fake-oauth-token');
  });

  it('points at `login` when a saved password has gone stale', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
    await saveStoredPassword(url, 'admin', 'no-longer-valid');

    await assert.rejects(
      () => getAuthCookie(url, 'admin', false, NO_PROMPT),
      (err: unknown) => {
        assert.ok(err instanceof UserError);
        assert.match(String(err.hint), /iob-sync login/);
        return true;
      },
    );
  });

  it('never puts the password in an error or a log line', async () => {
    const password = 'sup3r-s3cret-passphrase';
    server.auth = { mode: 'oauth', username: 'admin', password: 'something-else' };
    process.env.IOBROKER_PASSWORD = password;

    const logged: string[] = [];
    const err = await getAuthCookie(url, 'admin', false, {
      ...NO_PROMPT,
      warn: (m) => logged.push(m),
      info: (m) => logged.push(m),
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    assert.ok(err, 'expected the bad password to be rejected');
    assert.ok(!err.message.includes(password), 'the message must not contain the password');
    assert.ok(!String((err as UserError).hint ?? '').includes(password), 'nor the hint');
    assert.ok(
      logged.every((l) => !l.includes(password)),
      `no log line may contain the password, got ${JSON.stringify(logged)}`,
    );
  });

  it('does not prompt, or hang, when no terminal is available', async () => {
    server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };

    // allowPrompt defaults to isInteractive(); forcing it true here proves the
    // isInteractive() guard still refuses rather than blocking on a non-TTY stdin.
    await assert.rejects(
      () => getAuthCookie(url, 'admin', false, { allowPrompt: true }),
      UserError,
    );
  });
});
