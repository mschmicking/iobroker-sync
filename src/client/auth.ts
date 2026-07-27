/**
 * Obtains an auth cookie for ioBroker Admin, when the instance requires one.
 *
 * Probes `<url>/login`: a 404 means authentication is disabled on this
 * instance (no `web` adapter auth / no ACL) and no cookie is needed at all.
 * Otherwise a password is read from `IOBROKER_PASSWORD` and used to log in,
 * preferring the OAuth2 token endpoint and falling back to the legacy
 * session-cookie login used by older Admin versions.
 *
 * Note: unlike the websocket client (which takes `rejectUnauthorized: false`
 * directly via `ws`'s connection options), Node's global `fetch` has no
 * simple per-request way to accept self-signed certificates without adding
 * an `undici` dependency, which we deliberately avoid here. Self-signed
 * instances that also require authentication over HTTPS are out of scope
 * for this helper; the websocket connection itself still honors
 * `allowSelfSigned`.
 */

import { UserError } from '../types';

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function extractCookie(res: Response, cookieName: string): string | undefined {
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const raw of cookies) {
    const pair = raw.split(';', 1)[0]?.trim();
    if (pair && pair.startsWith(`${cookieName}=`)) {
      return pair;
    }
  }
  return undefined;
}

export async function getAuthCookie(
  url: string,
  username: string | null,
  allowSelfSigned: boolean,
): Promise<string | undefined> {
  const base = trimTrailingSlash(url);

  let loginProbe: Response;
  try {
    loginProbe = await fetch(`${base}/login`, { method: 'GET', redirect: 'manual' });
  } catch (err) {
    throw new UserError(
      `Could not reach ioBroker Admin at ${base}: ${(err as Error).message}`,
      'Check that the URL in your config is correct and the instance is reachable.',
    );
  }

  if (loginProbe.status === 404) {
    // Authentication is disabled on this instance.
    return undefined;
  }

  const password = process.env.IOBROKER_PASSWORD;
  if (!password) {
    throw new UserError(
      'ioBroker Admin requires authentication, but no password was provided.',
      'Set the IOBROKER_PASSWORD environment variable and try again.',
    );
  }

  const user = username ?? '';
  // `allowSelfSigned` only affects the websocket connection (see module comment);
  // it is accepted here for interface symmetry with SocketOptions.
  void allowSelfSigned;

  // Try OAuth2 first (Admin >= 6.x style).
  try {
    const oauthRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        username: user,
        password,
        stayloggedin: 'true',
        client_id: 'ioBroker',
      }).toString(),
    });
    if (oauthRes.ok) {
      const cookie = extractCookie(oauthRes, 'access_token');
      if (cookie) {
        return cookie;
      }
    }
  } catch {
    // Fall through to legacy login below.
  }

  // Fall back to legacy session-cookie login.
  let legacyRes: Response;
  try {
    legacyRes = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        username: user,
        password,
        stayloggedin: 'on',
      }).toString(),
    });
  } catch (err) {
    throw new UserError(`Login request to ${base}/login failed: ${(err as Error).message}`);
  }

  const legacyCookie = extractCookie(legacyRes, 'connect.sid');
  if (legacyCookie) {
    return legacyCookie;
  }

  throw new UserError(
    'Login to ioBroker Admin failed: no auth cookie was returned.',
    'Check IOBROKER_PASSWORD and the configured username.',
  );
}
