/**
 * Obtains an auth cookie for ioBroker Admin, when the instance requires one.
 *
 * Probes `<url>/login`: a 404 means authentication is disabled on this instance and
 * no cookie is needed at all. Otherwise a password is resolved (see
 * `resolvePassword`) and used to log in, preferring the OAuth2 token endpoint and
 * falling back to the legacy session-cookie login used by older Admin versions.
 *
 * These requests use `node:http`/`node:https` rather than the global `fetch`.
 * `fetch` has no way to accept a self-signed certificate without pulling in an
 * `undici` Agent, and an ioBroker instance that has authentication switched on is
 * usually also on HTTPS with a self-signed certificate — so honouring
 * `allowSelfSigned` here is not optional. The websocket path already honours it.
 *
 * The password is never logged, never placed in argv, and never written to the
 * project config. See `src/credentials.ts`.
 */

import * as http from 'node:http';
import * as https from 'node:https';

import { UserError } from '../types';
import { readStoredPassword, saveStoredPassword } from '../credentials';
import { isInteractive, promptPassword, promptYesNo, readPasswordFromStdin } from '../prompt';

export interface AuthOptions {
  /** Read the password from stdin (`--password-stdin`) instead of env/store/prompt. */
  passwordStdin?: boolean;
  /** Set false to never prompt, e.g. in tests. Defaults to whether a TTY is attached. */
  allowPrompt?: boolean;
  /** Warning channel. Never receives the password. */
  warn?: (msg: string) => void;
  /** Info channel. Never receives the password. */
  info?: (msg: string) => void;
  /**
   * Debug channel. Never receives the password. Records which login path worked,
   * which is otherwise invisible and is the first thing worth knowing when someone
   * else's instance fails to authenticate.
   */
  debug?: (msg: string) => void;
}

interface HttpResponse {
  status: number;
  cookies: string[];
}

type PasswordSource = 'stdin' | 'env' | 'store' | 'prompt';

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Minimal request helper. Redirects are never followed: the legacy login signals
 * success with a 302 plus a cookie, and following it would discard that.
 */
function request(
  target: string,
  opts: { method: string; body?: string; allowSelfSigned: boolean },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      reject(new Error(`Invalid URL "${target}"`));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: opts.method,
        headers: opts.body
          ? {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(opts.body),
            }
          : {},
        // Only meaningful for https; ignored otherwise.
        rejectUnauthorized: !opts.allowSelfSigned,
      },
      (res) => {
        // The body is not needed for any of these endpoints, but it must be drained
        // or the socket is never released.
        res.resume();
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            cookies: res.headers['set-cookie'] ?? [],
          });
        });
      },
    );

    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function extractCookie(res: HttpResponse, cookieName: string): string | undefined {
  for (const raw of res.cookies) {
    const pair = raw.split(';', 1)[0]?.trim();
    if (pair?.startsWith(`${cookieName}=`)) {
      return pair;
    }
  }
  return undefined;
}

/**
 * Finds a password without ever accepting one on the command line.
 *
 * Order: `--password-stdin`, then `IOBROKER_PASSWORD`, then the saved credentials
 * file, then an interactive prompt. The prompt is last because the earlier sources
 * are the ones that work unattended.
 */
async function resolvePassword(
  url: string,
  username: string | null,
  opts: AuthOptions,
): Promise<{ password: string; source: PasswordSource }> {
  if (opts.passwordStdin) {
    const password = await readPasswordFromStdin();
    if (!password) {
      throw new UserError('--password-stdin was given but nothing was read from stdin.');
    }
    return { password, source: 'stdin' };
  }

  const fromEnv = process.env.IOBROKER_PASSWORD;
  if (fromEnv) return { password: fromEnv, source: 'env' };

  const stored = await readStoredPassword(url, username, opts.warn);
  if (stored) return { password: stored, source: 'store' };

  const mayPrompt = opts.allowPrompt ?? isInteractive();
  if (mayPrompt && isInteractive()) {
    const password = await promptPassword(`Password for ${username ?? 'ioBroker'} at ${url}`);
    if (password) return { password, source: 'prompt' };
  }

  throw new UserError(
    'ioBroker Admin requires authentication, but no password was available.',
    'Run `iob-sync login` to save one, set IOBROKER_PASSWORD, or pass --password-stdin.',
  );
}

export async function getAuthCookie(
  url: string,
  username: string | null,
  allowSelfSigned: boolean,
  opts: AuthOptions = {},
): Promise<string | undefined> {
  const base = trimTrailingSlash(url);

  let loginProbe: HttpResponse;
  try {
    loginProbe = await request(`${base}/login`, { method: 'GET', allowSelfSigned });
  } catch (err) {
    const message = (err as Error).message;
    const selfSignedHint =
      /self.signed|unable to verify|CERT_/i.test(message) && !allowSelfSigned
        ? 'The certificate is not trusted. Set "allowSelfSigned": true in .iobroker-sync.json.'
        : 'Check that the URL in your config is correct and the instance is reachable.';
    throw new UserError(`Could not reach ioBroker Admin at ${base}: ${message}`, selfSignedHint);
  }

  if (loginProbe.status === 404) {
    opts.debug?.(`${base}/login returned 404: authentication is disabled`);
    return undefined;
  }

  const { password, source } = await resolvePassword(base, username, opts);
  const user = username ?? '';

  const persist = async (): Promise<void> => {
    // Only offer to save something the user typed, and only once it is known to work.
    if (source !== 'prompt') return;
    const mayPrompt = opts.allowPrompt ?? isInteractive();
    if (!mayPrompt || !isInteractive()) return;
    if (!(await promptYesNo('Save this password for next time?', true))) return;
    const file = await saveStoredPassword(base, username, password);
    opts.info?.(`Password saved to ${file} (owner-readable only).`);
  };

  // Try OAuth2 first (Admin >= 6.x style).
  try {
    const oauthRes = await request(`${base}/oauth/token`, {
      method: 'POST',
      allowSelfSigned,
      body: new URLSearchParams({
        grant_type: 'password',
        username: user,
        password,
        stayloggedin: 'true',
        client_id: 'ioBroker',
      }).toString(),
    });
    if (oauthRes.status >= 200 && oauthRes.status < 300) {
      const cookie = extractCookie(oauthRes, 'access_token');
      if (cookie) {
        opts.debug?.(`authenticated via OAuth2 (/oauth/token), password from ${source}`);
        await persist();
        return cookie;
      }
    }
  } catch {
    // Fall through to legacy login below.
  }

  // Fall back to legacy session-cookie login.
  let legacyRes: HttpResponse;
  try {
    legacyRes = await request(`${base}/login`, {
      method: 'POST',
      allowSelfSigned,
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
    opts.debug?.(`authenticated via legacy /login, password from ${source}`);
    await persist();
    return legacyCookie;
  }

  throw new UserError(
    'Login to ioBroker Admin failed: no auth cookie was returned.',
    source === 'store'
      ? 'The saved password may be out of date — run `iob-sync login` to replace it.'
      : 'Check the password and the configured username.',
  );
}
