/**
 * Resilient JSON transport built on Node 20+ global `fetch`.
 *
 * Audit-log APIs are the worst-behaved endpoints in either cloud: Microsoft
 * Graph throttles aggressively per-tenant and per-app, Purview's async query
 * engine can stall for minutes, and Google's Reports API answers overage with a
 * *403* rather than a 429. Every caller in this tool goes through here so that
 * behaviour lives in exactly one place.
 *
 * Retry policy
 *  - 408 / 429 / 5xx and network faults are retried.
 *  - Google's `rateLimitExceeded` / `userRateLimitExceeded` / `quotaExceeded`
 *    403s are retried (they are throttles wearing a 403 costume).
 *  - `Retry-After` (seconds *or* HTTP-date) always wins over computed backoff.
 *  - Otherwise: exponential backoff with full jitter, so N concurrent callers
 *    do not resynchronise into a thundering herd.
 *  - 401/403-without-a-throttle-reason and 4xx are surfaced immediately; they
 *    are consent problems, not transient ones, and retrying just wastes the
 *    admin's 15 minutes.
 */

import { log } from './log.js';

export interface RetryOptions {
  /** Retry attempts *after* the initial try. Default 5. */
  retries?: number;
  /** First backoff step in ms; doubles per attempt. Default 1000. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 60_000. */
  maxDelayMs?: number;
  /** Per-attempt socket/response timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** Absolute epoch-ms deadline for the whole call, including retries. */
  deadline?: number;
  /** Human label used in log lines. */
  label?: string;
  /** Extra status codes to treat as retryable. */
  retryOnStatus?: number[];
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** Provider error code, dug out of either cloud's envelope. */
  get code(): string | undefined {
    const b = this.body as
      | { error?: { code?: string; status?: string; errors?: Array<{ reason?: string }> } }
      | undefined;
    return b?.error?.code ?? b?.error?.status ?? b?.error?.errors?.[0]?.reason;
  }
}

export class DeadlineExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

const DEFAULTS = {
  retries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  timeoutMs: 60_000,
} as const;

/** Statuses that always mean "try again later". */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Google returns 403 for quota exhaustion. Only these reasons are transient —
 * a plain `forbidden` really is a permission problem and must not be retried.
 */
const RETRYABLE_403_REASONS = new Set([
  'ratelimitexceeded',
  'userratelimitexceeded',
  'quotaexceeded',
  'dailylimitexceeded',
  'backenderror',
  'servingratelimitexceeded',
]);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` is either delta-seconds or an HTTP-date. Handle both. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Exponential backoff with full jitter (AWS "Exponential Backoff and Jitter"). */
function backoffMs(attempt: number, base: number, cap: number): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (err as { code?: string }).code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  );
}

function retryReasonFor403(body: unknown): boolean {
  const b = body as
    | { error?: { status?: string; errors?: Array<{ reason?: string }> } }
    | undefined;
  const reasons = [
    ...(b?.error?.errors ?? []).map((e) => e.reason),
    b?.error?.status,
  ].filter((r): r is string => typeof r === 'string');
  return reasons.some((r) => RETRYABLE_403_REASONS.has(r.toLowerCase()));
}

export interface RawResponse<T> {
  status: number;
  ok: boolean;
  data: T | undefined;
  headers: Headers;
}

/**
 * Perform a request with retries, returning status and parsed body without
 * throwing on HTTP error status.
 *
 * Use this when a non-2xx is a *meaningful* answer — OAuth token endpoints
 * reply `400 {"error":"authorization_pending"}` on every device-code poll, and
 * treating that as an exception would be wrong.
 */
export async function requestRaw<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<RawResponse<T>> {
  const retries = opts.retries ?? DEFAULTS.retries;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const label = opts.label ?? new URL(url).pathname;
  const extraRetryable = new Set(opts.retryOnStatus ?? []);

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) {
      throw new DeadlineExceededError(
        `Deadline exceeded before completing ${label}. Re-run with a longer --timeout or a shorter --days window.`,
      );
    }

    // A fresh controller per attempt; reusing an aborted one silently no-ops.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Respect a caller-supplied signal in addition to our timeout.
    const externalSignal = init.signal;
    const onExternalAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const headers = res.headers;
      const requestId =
        headers.get('request-id') ??
        headers.get('x-ms-request-id') ??
        headers.get('x-guploader-uploadid') ??
        undefined;

      const data = await parseBody<T>(res);

      if (res.ok) {
        log.debug(`${res.status} ${label}${requestId ? ` (req ${requestId})` : ''}`);
        return { status: res.status, ok: true, data, headers };
      }

      const retryable =
        RETRYABLE_STATUS.has(res.status) ||
        extraRetryable.has(res.status) ||
        (res.status === 403 && retryReasonFor403(data));

      if (!retryable || attempt === retries) {
        return { status: res.status, ok: false, data, headers };
      }

      const wait =
        parseRetryAfter(headers.get('retry-after')) ??
        backoffMs(attempt, baseDelayMs, maxDelayMs);

      // Do not sleep past the caller's deadline — fail fast instead.
      if (opts.deadline !== undefined && Date.now() + wait > opts.deadline) {
        throw new DeadlineExceededError(
          `${label} is being throttled (HTTP ${res.status}) and the retry would exceed the run deadline.`,
        );
      }

      log.warn(
        `${label}: HTTP ${res.status}${res.status === 429 ? ' (throttled)' : ''} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${retries}).`,
      );
      await sleep(wait);
      continue;
    } catch (err) {
      if (err instanceof DeadlineExceededError) throw err;
      lastError = err;

      const timedOut = err instanceof Error && err.name === 'AbortError';
      if (!isTransientNetworkError(err) || attempt === retries) {
        throw wrapNetworkError(err, url, label, timedOut, timeoutMs);
      }

      const wait = backoffMs(attempt, baseDelayMs, maxDelayMs);
      log.warn(
        `${label}: ${timedOut ? `no response in ${Math.round(timeoutMs / 1000)}s` : describeError(err)} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${retries}).`,
      );
      await sleep(wait);
      continue;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw wrapNetworkError(lastError, url, label, false, timeoutMs);
}

/** Same as {@link requestRaw} but throws {@link HttpError} on any non-2xx. */
export async function requestJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<T> {
  const res = await requestRaw<T>(url, init, opts);
  if (!res.ok) {
    throw new HttpError(
      formatApiError(res.status, res.data, opts.label ?? url),
      res.status,
      url,
      res.data,
      res.headers.get('request-id') ?? res.headers.get('x-ms-request-id') ?? undefined,
    );
  }
  return res.data as T;
}

/** Convenience wrapper for `application/x-www-form-urlencoded` POSTs (OAuth). */
export async function postForm<T = unknown>(
  url: string,
  form: Record<string, string | undefined>,
  opts: RetryOptions = {},
): Promise<RawResponse<T>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (v !== undefined) body.set(k, v);
  }
  return requestRaw<T>(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    },
    opts,
  );
}

async function parseBody<T>(res: Response): Promise<T | undefined> {
  if (res.status === 204 || res.status === 304) return undefined;
  const text = await res.text();
  if (text.length === 0) return undefined;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    // Non-JSON error pages (HTML sign-in walls, proxy blocks) still need to
    // reach the caller — carry the text so the message is actionable.
    return { __nonJsonBody: text.slice(0, 2000) } as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return { __unparsableBody: text.slice(0, 2000) } as unknown as T;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

function wrapNetworkError(
  err: unknown,
  url: string,
  label: string,
  timedOut: boolean,
  timeoutMs: number,
): Error {
  if (timedOut) {
    const e = new Error(
      `${label}: request timed out after ${Math.round(timeoutMs / 1000)}s. ` +
        `If you are behind a corporate proxy or TLS-inspecting firewall, set HTTPS_PROXY and NODE_EXTRA_CA_CERTS.`,
    );
    e.name = 'TimeoutError';
    return e;
  }
  const e = new Error(`${label}: network error contacting ${new URL(url).host} — ${describeError(err)}`);
  e.name = 'NetworkError';
  return e;
}

/** Turn either cloud's error envelope into one actionable sentence. */
function formatApiError(status: number, body: unknown, label: string): string {
  const b = body as
    | {
        error?:
          | string
          | {
              code?: string;
              message?: string;
              status?: string;
              errors?: Array<{ reason?: string; message?: string }>;
            };
        error_description?: string;
        __nonJsonBody?: string;
        __unparsableBody?: string;
      }
    | undefined;

  // OAuth-style: { error: "invalid_grant", error_description: "..." }
  if (typeof b?.error === 'string') {
    return `${label}: HTTP ${status} ${b.error}${b.error_description ? ` — ${b.error_description}` : ''}`;
  }

  const err = b?.error;
  const code = err?.code ?? err?.status ?? err?.errors?.[0]?.reason;
  const message = err?.message ?? err?.errors?.[0]?.message;
  if (code ?? message) {
    return `${label}: HTTP ${status} ${code ?? ''}${code && message ? ' — ' : ''}${message ?? ''}`.trim();
  }

  const fallback = b?.__nonJsonBody ?? b?.__unparsableBody;
  return `${label}: HTTP ${status}${fallback ? ` — ${fallback.slice(0, 300)}` : ''}`;
}
