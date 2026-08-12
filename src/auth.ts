/**
 * OAuth 2.0 for two clouds, with no SDK and no third party in the loop.
 *
 * Threat model
 * ------------
 * The operator is a Global Admin / Super Admin. The tokens minted here are
 * among the most valuable credentials in the organisation, so:
 *
 *  1. **Public clients only.** No confidential-client secrets are required for
 *     Entra ID. Google's "Desktop app" client type does issue a secret, but per
 *     Google's own installed-app guidance it is not treated as confidential; it
 *     is still never written to disk by this tool.
 *  2. **PKCE (S256) on every authorization-code flow**, so an authorization
 *     code intercepted on the loopback interface is useless without the
 *     verifier held in this process's memory.
 *  3. **Tokens live in memory by default.** Persisting a Global Admin refresh
 *     token to disk turns a one-shot report into a standing credential; that is
 *     opt-in via `--save-session` and written 0600 under the user's home.
 *  4. **The loopback listener binds 127.0.0.1 only**, accepts exactly one
 *     callback, validates `state`, and shuts down immediately afterwards.
 *  5. **Read-only scopes.** Nothing here can mutate tenant state.
 *
 * Flows implemented
 * -----------------
 *  - Microsoft Entra ID: device code (default — no redirect URI to register,
 *    works over SSH/RDP) *and* loopback authorization code + PKCE.
 *  - Google Workspace: loopback authorization code + PKCE. Google restricts the
 *    device flow to "TV and Limited Input" clients, which cannot hold the Admin
 *    SDK scopes, so loopback is the only correct choice for a desktop utility.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { postForm, requestJson, sleep } from './http.js';
import { log, style } from './log.js';
import type { Provider } from './types.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface TokenSet {
  accessToken: string;
  /** Epoch ms. Refreshed 120s before this to avoid mid-pagination expiry. */
  expiresAt: number;
  refreshToken?: string;
  scope?: string;
  /** UPN / email the token belongs to, for display only. */
  account?: string;
}

export interface MicrosoftAuthOptions {
  tenantId: string;
  clientId: string;
  scopes: string[];
  /** `device` needs no redirect URI; `browser` needs a registered loopback URI. */
  mode: 'device' | 'browser';
  /** Loopback port for `browser` mode. Must match the registered reply URL. */
  port: number;
  /** Entra cloud host, e.g. `login.microsoftonline.us` for GCC High. */
  authority: string;
  /** Give up on the interactive step after this many ms. */
  interactiveTimeoutMs: number;
  session: SessionStore;
}

export interface GoogleAuthOptions {
  clientId: string;
  /** Google issues one for Desktop clients; not confidential, never persisted. */
  clientSecret?: string;
  scopes: string[];
  port: number;
  interactiveTimeoutMs: number;
  session: SessionStore;
}

// ---------------------------------------------------------------------------
// PKCE + CSRF primitives
// ---------------------------------------------------------------------------

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256. 32 random bytes -> 43-char verifier, comfortably in spec. */
function createPkce(): Pkce {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Constant-time compare so `state` cannot be probed byte-by-byte. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Session store (opt-in persistence)
// ---------------------------------------------------------------------------

interface SessionFile {
  version: 1;
  entries: Record<string, TokenSet>;
}

/**
 * Refresh-token cache. Disabled unless the operator passes `--save-session`;
 * when enabled the file is 0600 inside a 0700 directory.
 */
export class SessionStore {
  private readonly file: string;
  private cache: SessionFile = { version: 1, entries: {} };

  constructor(
    private readonly enabled: boolean,
    dir = join(homedir(), '.ai-audit-lens'),
  ) {
    this.file = join(dir, 'session.json');
    if (!enabled) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as SessionFile;
      if (parsed.version === 1 && typeof parsed.entries === 'object') this.cache = parsed;
    } catch {
      // Missing or corrupt cache is not an error — we just re-authenticate.
    }
  }

  get(key: string): TokenSet | undefined {
    return this.enabled ? this.cache.entries[key] : undefined;
  }

  set(key: string, token: TokenSet): void {
    if (!this.enabled) return;
    this.cache.entries[key] = token;
    try {
      writeFileSync(this.file, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch (err) {
      log.warn(`Could not persist session (continuing in memory): ${(err as Error).message}`);
    }
  }

  clear(): void {
    this.cache = { version: 1, entries: {} };
    try {
      rmSync(this.file, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Browser launch + loopback listener
// ---------------------------------------------------------------------------

/**
 * Open the system browser without shelling out through a parsed command line.
 *
 * Windows uses `rundll32 url.dll,FileProtocolHandler` rather than `cmd /c start`
 * precisely because the latter re-parses the URL and mangles `&` in query
 * strings (and would be an injection surface).
 */
export function openBrowser(url: string): void {
  try {
    const [cmd, args]: [string, string[]] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* headless box: the caller already printed the URL */
    });
    child.unref();
  } catch {
    /* non-fatal: the URL is always printed as a fallback */
  }
}

interface CallbackResult {
  code: string;
  state: string;
}

/** Minimal styled page shown in the admin's browser after the redirect. */
function resultPage(ok: boolean, heading: string, detail: string): string {
  const accent = ok ? '#1baf7a' : '#d03b3b';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Audit Lens</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fcfcfb;color:#0b0b0b;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){body{background:#1a1a19;color:#fff}.card{background:#232321;border-color:rgba(255,255,255,.1)}}
.card{max-width:30rem;padding:2.5rem;border:1px solid rgba(11,11,11,.1);border-radius:14px;background:#fff;text-align:center}
.dot{width:44px;height:44px;border-radius:50%;background:${accent};margin:0 auto 1.25rem;display:grid;place-items:center;color:#fff;font-size:22px}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#52514e}
@media(prefers-color-scheme:dark){p{color:#c3c2b7}}
</style></head><body><div class="card"><div class="dot">${ok ? '&#10003;' : '!'}</div>
<h1>${heading}</h1><p>${detail}</p></div></body></html>`;
}

/**
 * Bind a single-shot loopback listener and resolve with the first valid
 * callback. Anything else (favicon probes, path typos, a mismatched `state`)
 * is answered and ignored without resolving.
 *
 * @param port 0 selects an ephemeral port — only usable where the identity
 *             provider allows dynamic loopback ports.
 */
async function awaitLoopbackCallback(
  port: number,
  path: string,
  expectedState: string,
  timeoutMs: number,
): Promise<{ result: Promise<CallbackResult>; redirectUri: string; close: () => void }> {
  let settle!: (v: CallbackResult) => void;
  let fail!: (e: Error) => void;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== path) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }

    const send = (status: number, html: string): void => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        // This page must never be cached or embedded — it is part of an auth flow.
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
      });
      res.end(html);
    };

    const error = url.searchParams.get('error');
    if (error) {
      const desc = url.searchParams.get('error_description') ?? '';
      send(400, resultPage(false, 'Sign-in was not completed', escapeHtml(desc || error)));
      fail(new Error(`Authorization denied: ${error}${desc ? ` — ${desc}` : ''}`));
      return;
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      send(400, resultPage(false, 'Malformed callback', 'No authorization code was present.'));
      return;
    }
    if (!safeEqual(state, expectedState)) {
      // A state mismatch is a CSRF signal, not a typo. Refuse the code outright.
      send(400, resultPage(false, 'Request rejected', 'The security token did not match.'));
      fail(new Error('OAuth state mismatch — the callback did not originate from this session.'));
      return;
    }

    send(200, resultPage(true, 'Signed in', 'You can close this tab and return to your terminal.'));
    settle({ code, state });
  });

  server.on('error', (err) => fail(err));

  // If `listen` fails we reject below and never hand `result` to a caller, so
  // give it a terminal handler now. `result` keeps its own rejection for
  // whoever does await it — this only silences the unhandled-rejection warning.
  void result.catch(() => undefined);

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `Port ${port} is already in use, so the sign-in callback cannot be received. ` +
                `Free it or pass --port <other>. For Entra ID the port must match the ` +
                `registered reply URL (http://localhost:${port}/callback).`,
            )
          : err,
      );
    });
    // 127.0.0.1 (never 0.0.0.0): the listener must not be reachable from the LAN.
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = (server.address() as AddressInfo).port;
  const timer = setTimeout(
    () => fail(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser sign-in.`)),
    timeoutMs,
  );

  const close = (): void => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };

  return {
    result,
    // Entra matches the reply URL literally; `localhost` (not 127.0.0.1) is the
    // form its portal registers, while Google accepts either loopback form.
    redirectUri: `http://localhost:${actualPort}${path}`,
    close,
  };
}

// ---------------------------------------------------------------------------
// Token plumbing shared by both providers
// ---------------------------------------------------------------------------

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Skew guard: treat a token as expired 2 minutes early. */
const EXPIRY_SKEW_MS = 120_000;

/**
 * Deliberately *not* a type predicate: narrowing on it would collapse the
 * `else` branch to `never` and hide the still-usable refresh token.
 */
const isFresh = (t: TokenSet | undefined): boolean =>
  t !== undefined && t.accessToken.length > 0 && t.expiresAt - EXPIRY_SKEW_MS > Date.now();

function toTokenSet(res: OAuthTokenResponse, previous?: TokenSet): TokenSet {
  if (!res.access_token) throw new Error('Token endpoint returned no access_token.');
  return {
    accessToken: res.access_token,
    // Refresh tokens are not always re-issued on refresh; keep the prior one.
    refreshToken: res.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000,
    scope: res.scope ?? previous?.scope,
    account: accountFromIdToken(res.id_token) ?? previous?.account,
  };
}

/**
 * Read the display name out of an id_token *without* verifying it.
 *
 * This is safe here and only here: the token came straight off a TLS channel to
 * the provider's token endpoint in response to our own PKCE-bound code, and the
 * value is used for a cosmetic "signed in as …" line. It is never an
 * authorization input.
 */
function accountFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const payload = idToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      preferred_username?: string;
      upn?: string;
      email?: string;
    };
    return claims.preferred_username ?? claims.upn ?? claims.email;
  } catch {
    return undefined;
  }
}

function tokenError(res: { status: number; data: OAuthTokenResponse | undefined }): Error {
  const d = res.data;
  const detail = d?.error_description ?? d?.error ?? `HTTP ${res.status}`;
  return new Error(detail.split('\n')[0] ?? detail);
}

// ---------------------------------------------------------------------------
// Microsoft Entra ID
// ---------------------------------------------------------------------------

/**
 * Acquire a Microsoft Graph token for the Purview audit-search scopes.
 *
 * Order of preference: cached access token -> refresh token -> interactive.
 */
export async function getMicrosoftToken(opts: MicrosoftAuthOptions): Promise<TokenSet> {
  const key = `microsoft:${opts.authority}:${opts.tenantId}:${opts.clientId}`;
  const tokenUrl = `https://${opts.authority}/${encodeURIComponent(opts.tenantId)}/oauth2/v2.0/token`;
  // `offline_access` is what makes a refresh token possible; the rest are the
  // resource scopes. `openid`/`profile` only give us the display name.
  const scope = [...new Set([...opts.scopes, 'offline_access', 'openid', 'profile'])].join(' ');

  const cached = opts.session.get(key);
  if (cached && isFresh(cached)) {
    log.ok(`Microsoft: reusing cached session${cached.account ? ` for ${cached.account}` : ''}.`);
    return cached;
  }

  if (cached?.refreshToken) {
    try {
      const refreshed = await refreshToken(tokenUrl, {
        client_id: opts.clientId,
        refresh_token: cached.refreshToken,
        scope,
      }, cached);
      opts.session.set(key, refreshed);
      log.ok(`Microsoft: refreshed session${refreshed.account ? ` for ${refreshed.account}` : ''}.`);
      return refreshed;
    } catch (err) {
      log.debug(`Microsoft refresh failed, falling back to interactive: ${(err as Error).message}`);
    }
  }

  const token =
    opts.mode === 'device'
      ? await microsoftDeviceCodeFlow(opts, scope)
      : await microsoftAuthCodeFlow(opts, scope, tokenUrl);

  opts.session.set(key, token);
  return token;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
  message?: string;
}

/**
 * RFC 8628 device authorization grant.
 *
 * Default for Microsoft because it needs no reply URL registered, survives SSH
 * sessions and jump boxes, and lets the admin complete MFA on a phone.
 */
async function microsoftDeviceCodeFlow(
  opts: MicrosoftAuthOptions,
  scope: string,
): Promise<TokenSet> {
  const base = `https://${opts.authority}/${encodeURIComponent(opts.tenantId)}/oauth2/v2.0`;

  const start = await postForm<DeviceCodeResponse & OAuthTokenResponse>(
    `${base}/devicecode`,
    { client_id: opts.clientId, scope },
    { label: 'Entra device code' },
  );
  if (!start.ok || !start.data?.device_code) {
    throw new Error(
      `Could not start device sign-in: ${tokenError(start).message}\n` +
        `  Check that the app registration allows public client flows ` +
        `(Authentication -> "Allow public client flows" = Yes).`,
    );
  }

  const dc = start.data;
  log.info('');
  log.info(`  ${style.bold('1.')} Open ${style.cyan(dc.verification_uri)}`);
  log.info(`  ${style.bold('2.')} Enter code ${style.bold(style.yellow(dc.user_code))}`);
  log.info(`  ${style.bold('3.')} Sign in with an account holding the audit-read role.`);
  log.info('');
  openBrowser(dc.verification_uri);

  // Poll cadence is dictated by the server; `slow_down` widens it permanently.
  let intervalMs = (dc.interval ?? 5) * 1000;
  const expiry = Date.now() + Math.min(dc.expires_in * 1000, opts.interactiveTimeoutMs);

  while (Date.now() < expiry) {
    await sleep(intervalMs);

    const res = await postForm<OAuthTokenResponse>(
      `${base}/token`,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: opts.clientId,
        device_code: dc.device_code,
      },
      // 400 is the *normal* answer while the user is still typing — never retry it.
      { label: 'Entra token', retries: 2 },
    );

    if (res.ok && res.data?.access_token) {
      const token = toTokenSet(res.data);
      log.ok(`Microsoft: signed in${token.account ? ` as ${token.account}` : ''}.`);
      return token;
    }

    switch (res.data?.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += 5000;
        continue;
      case 'authorization_declined':
        throw new Error('Sign-in was declined in the browser.');
      case 'expired_token':
        throw new Error('The device code expired before sign-in completed.');
      case 'bad_verification_code':
        throw new Error('The device code was rejected. Re-run to get a fresh code.');
      default:
        throw new Error(`Device sign-in failed: ${tokenError(res).message}`);
    }
  }

  throw new Error('Timed out waiting for device sign-in.');
}

/** Authorization code + PKCE against a loopback reply URL. */
async function microsoftAuthCodeFlow(
  opts: MicrosoftAuthOptions,
  scope: string,
  tokenUrl: string,
): Promise<TokenSet> {
  const pkce = createPkce();
  const state = b64url(randomBytes(16));
  const listener = await awaitLoopbackCallback(opts.port, '/callback', state, opts.interactiveTimeoutMs);

  try {
    const authUrl = new URL(
      `https://${opts.authority}/${encodeURIComponent(opts.tenantId)}/oauth2/v2.0/authorize`,
    );
    authUrl.search = new URLSearchParams({
      client_id: opts.clientId,
      response_type: 'code',
      redirect_uri: listener.redirectUri,
      response_mode: 'query',
      scope,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      // Force account choice so an admin does not silently reuse a low-privilege session.
      prompt: 'select_account',
    }).toString();

    log.info(`Opening your browser to sign in to Microsoft…`);
    log.info(style.dim(`If it does not open: ${authUrl.toString()}`));
    openBrowser(authUrl.toString());

    const { code } = await listener.result;

    const res = await postForm<OAuthTokenResponse>(
      tokenUrl,
      {
        client_id: opts.clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: listener.redirectUri,
        code_verifier: pkce.verifier,
        scope,
      },
      { label: 'Entra token', retries: 2 },
    );
    if (!res.ok) throw new Error(`Token exchange failed: ${tokenError(res).message}`);

    const token = toTokenSet(res.data ?? {});
    log.ok(`Microsoft: signed in${token.account ? ` as ${token.account}` : ''}.`);
    return token;
  } finally {
    listener.close();
  }
}

// ---------------------------------------------------------------------------
// Google Workspace
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Acquire an Admin SDK Reports token.
 *
 * Google desktop clients accept *any* loopback port, so port 0 (ephemeral) is
 * safe here and avoids collisions — unlike Entra, which matches the reply URL
 * literally.
 */
export async function getGoogleToken(opts: GoogleAuthOptions): Promise<TokenSet> {
  const key = `google:${opts.clientId}`;
  const scope = [...new Set([...opts.scopes, 'openid', 'email'])].join(' ');

  const cached = opts.session.get(key);
  if (cached && isFresh(cached)) {
    log.ok(`Google: reusing cached session${cached.account ? ` for ${cached.account}` : ''}.`);
    return cached;
  }

  if (cached?.refreshToken) {
    try {
      const refreshed = await refreshToken(
        GOOGLE_TOKEN_URL,
        {
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          refresh_token: cached.refreshToken,
        },
        cached,
      );
      opts.session.set(key, refreshed);
      log.ok('Google: refreshed session.');
      return refreshed;
    } catch (err) {
      log.debug(`Google refresh failed, falling back to interactive: ${(err as Error).message}`);
    }
  }

  const pkce = createPkce();
  const state = b64url(randomBytes(16));
  const listener = await awaitLoopbackCallback(opts.port, '/callback', state, opts.interactiveTimeoutMs);

  try {
    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.search = new URLSearchParams({
      client_id: opts.clientId,
      response_type: 'code',
      redirect_uri: listener.redirectUri,
      scope,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      // offline + consent are what make a refresh token appear at all.
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
    }).toString();

    log.info('Opening your browser to sign in to Google Workspace…');
    log.info(style.dim(`If it does not open: ${authUrl.toString()}`));
    openBrowser(authUrl.toString());

    const { code } = await listener.result;

    const res = await postForm<OAuthTokenResponse>(
      GOOGLE_TOKEN_URL,
      {
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: listener.redirectUri,
        code_verifier: pkce.verifier,
      },
      { label: 'Google token', retries: 2 },
    );
    if (!res.ok) {
      throw new Error(
        `Token exchange failed: ${tokenError(res).message}\n` +
          `  If this says "invalid_client", confirm the OAuth client type is ` +
          `"Desktop app" and that --google-client-secret matches it.`,
      );
    }

    const token = toTokenSet(res.data ?? {});
    // Google's id_token carries `email` only when the email scope was granted.
    token.account = token.account ?? (await fetchGoogleAccount(token.accessToken));
    log.ok(`Google: signed in${token.account ? ` as ${token.account}` : ''}.`);
    opts.session.set(key, token);
    return token;
  } finally {
    listener.close();
  }
}

/** Cosmetic only — never gates access. Failure is swallowed. */
async function fetchGoogleAccount(accessToken: string): Promise<string | undefined> {
  try {
    const info = await requestJson<{ email?: string }>(
      'https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { authorization: `Bearer ${accessToken}` } },
      { label: 'Google userinfo', retries: 1, timeoutMs: 10_000 },
    );
    return info.email;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function refreshToken(
  tokenUrl: string,
  form: Record<string, string | undefined>,
  previous: TokenSet,
): Promise<TokenSet> {
  const res = await postForm<OAuthTokenResponse>(
    tokenUrl,
    { ...form, grant_type: 'refresh_token' },
    { label: 'token refresh', retries: 2 },
  );
  if (!res.ok) throw tokenError(res);
  return toTokenSet(res.data ?? {}, previous);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Bearer header helper so callers never hand-roll the prefix. */
export const bearer = (token: TokenSet): Record<string, string> => ({
  authorization: `Bearer ${token.accessToken}`,
});

/** Which provider a set of CLI options actually enables. */
export function describeProvider(p: Provider): string {
  return p === 'microsoft' ? 'Microsoft 365 Copilot' : 'Google Gemini for Workspace';
}
