/**
 * Audit-log collection for both clouds.
 *
 * Microsoft — Purview Audit Search (Graph v1.0)
 * --------------------------------------------
 * This is an *asynchronous* API, which is the single biggest thing to design
 * around:
 *
 *   1. `POST /security/auditLog/queries`      -> 201 with a query id
 *   2. `GET  /security/auditLog/queries/{id}` -> poll until status `succeeded`
 *   3. `GET  /security/auditLog/queries/{id}/records` -> paginate `@odata.nextLink`
 *
 * Step 2 routinely takes 2–20 minutes depending on tenant size and how busy the
 * Purview backend is; it is not unusual for a 7-day query on a large tenant to
 * exceed 15. We therefore poll against a deadline, print live elapsed time, and
 * on timeout hand back the query id so the operator can resume with
 * `--ms-query-id <id>` instead of paying the wait a second time.
 *
 * A note on filtering, because the obvious approach does not work:
 * `recordTypeFilters` is typed as the `auditLogRecordType` enum, and that enum
 * has **no Copilot member** in v1.0 — sending `"copilotInteraction"` yields a
 * 400. Copilot records are therefore selected by `operationFilters`
 * (`CopilotInteraction`, and `AIAppInteraction` for newer agent surfaces), which
 * is an unconstrained string collection. Unknown operation names simply match
 * nothing, so listing extras is free insurance against Microsoft renaming them.
 *
 * Google — Admin SDK Reports API
 * ------------------------------
 * Straightforward synchronous pagination over
 * `/activity/users/all/applications/gemini_in_workspace_apps`, whose single
 * event name is `feature_utilization`. Note that Gemini-in-Workspace logs only
 * exist from 2025-06-20 onward and retain 180 days.
 */

import { bearer, type TokenSet } from './auth.js';
import {
  DeadlineExceededError,
  HttpError,
  requestJson,
  requestRaw,
  sleep,
} from './http.js';
import { log, Progress, style } from './log.js';
import type { TimeWindow } from './types.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const REPORTS_BASE = 'https://admin.googleapis.com/admin/reports/v1';

/** Operations that carry a Microsoft 365 Copilot interaction. */
export const DEFAULT_COPILOT_OPERATIONS = ['CopilotInteraction', 'AIAppInteraction'];

/** Reports API applications that carry Gemini interactions. */
export const DEFAULT_GEMINI_APPLICATIONS = ['gemini_in_workspace_apps'];

// ---------------------------------------------------------------------------
// Microsoft Purview
// ---------------------------------------------------------------------------

export interface GraphAuditRecord {
  id: string;
  createdDateTime?: string;
  auditLogRecordType?: string;
  operation?: string;
  organizationId?: string;
  userType?: string;
  userId?: string;
  service?: string;
  objectId?: string;
  userPrincipalName?: string;
  clientIp?: string;
  administrativeUnits?: string[];
  /** Service-specific payload; PascalCase keys, occasionally a JSON string. */
  auditData?: Record<string, unknown> | string;
}

interface AuditLogQuery {
  id: string;
  displayName?: string;
  status?: 'notStarted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | string;
}

export interface MicrosoftFetchOptions {
  token: TokenSet;
  window: TimeWindow;
  /** Operation names to select. Defaults to {@link DEFAULT_COPILOT_OPERATIONS}. */
  operations: string[];
  /** Stop after this many records. */
  maxRecords: number;
  /** Absolute epoch-ms deadline for the whole Microsoft phase. */
  deadline: number;
  /** Resume a previously created query instead of creating a new one. */
  resumeQueryId?: string;
  /** Refresh the token mid-run; pagination can outlive a 1-hour access token. */
  refreshToken?: () => Promise<TokenSet>;
}

export interface MicrosoftFetchResult {
  records: GraphAuditRecord[];
  queryId: string;
  truncated: boolean;
  warnings: string[];
  /** Seconds spent waiting on the async query engine. */
  queryWaitSeconds: number;
}

/**
 * Run (or resume) a Purview audit search and page every matching record.
 */
export async function fetchCopilotAuditRecords(
  opts: MicrosoftFetchOptions,
): Promise<MicrosoftFetchResult> {
  const warnings: string[] = [];
  let token = opts.token;

  // Access tokens last ~60–75 minutes; a long poll plus deep pagination can
  // outrun that, so re-acquire whenever we're inside the skew window.
  const auth = async (): Promise<Record<string, string>> => {
    if (opts.refreshToken && token.expiresAt - 120_000 < Date.now()) {
      token = await opts.refreshToken();
    }
    return bearer(token);
  };

  let queryId = opts.resumeQueryId;
  const waitStart = Date.now();

  if (queryId) {
    log.info(`Resuming Purview query ${style.dim(queryId)}.`);
  } else {
    queryId = await createAuditQuery(opts, await auth());
    log.ok(`Purview query created: ${style.dim(queryId)}`);
    log.info(
      style.dim('  Purview runs this asynchronously. If you interrupt, resume with --ms-query-id ' + queryId),
    );
  }

  await waitForQuery(queryId, opts.deadline, auth);
  const queryWaitSeconds = Math.round((Date.now() - waitStart) / 1000);

  const { records, truncated } = await pageAuditRecords(queryId, opts, auth);

  if (records.length === 0) {
    warnings.push(
      'The Purview query succeeded but returned no Copilot records. Verify that unified auditing is on ' +
        '(Purview > Audit) and that users have Copilot licences with activity in this window.',
    );
  }

  return { records, queryId, truncated, warnings, queryWaitSeconds };
}

async function createAuditQuery(
  opts: MicrosoftFetchOptions,
  headers: Record<string, string>,
): Promise<string> {
  const body: Record<string, unknown> = {
    '@odata.type': '#microsoft.graph.security.auditLogQuery',
    displayName: `AI Audit Lens ${new Date().toISOString().slice(0, 19)}Z`,
    filterStartDateTime: opts.window.start,
    filterEndDateTime: opts.window.end,
    // See the module header: recordTypeFilters cannot express Copilot in v1.0.
    operationFilters: opts.operations,
  };

  try {
    const created = await requestJson<AuditLogQuery>(
      `${GRAPH_BASE}/security/auditLog/queries`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { label: 'create Purview query', deadline: opts.deadline, timeoutMs: 90_000 },
    );
    if (!created.id) throw new Error('Purview accepted the query but returned no id.');
    return created.id;
  } catch (err) {
    throw explainGraphError(err, opts.operations);
  }
}

/** Poll the query to completion, backing off as the wait lengthens. */
async function waitForQuery(
  queryId: string,
  deadline: number,
  auth: () => Promise<Record<string, string>>,
): Promise<void> {
  const progress = new Progress('Purview query');
  const started = Date.now();

  for (;;) {
    const elapsed = Date.now() - started;

    if (Date.now() > deadline) {
      throw new DeadlineExceededError(
        `Purview did not finish the audit search in time.\n` +
          `  The query is still running server-side. Resume without re-waiting from the start:\n` +
          `    ai-audit-lens --provider microsoft --ms-query-id ${queryId}`,
      );
    }

    const res = await requestRaw<AuditLogQuery>(
      `${GRAPH_BASE}/security/auditLog/queries/${encodeURIComponent(queryId)}`,
      { headers: await auth() },
      { label: 'poll Purview query', deadline, timeoutMs: 30_000 },
    );

    if (!res.ok) {
      throw explainGraphError(
        new HttpError(`poll Purview query: HTTP ${res.status}`, res.status, '', res.data),
        [],
      );
    }

    const status = res.data?.status ?? 'unknown';
    switch (status) {
      case 'succeeded':
        progress.done(`completed in ${formatDuration(elapsed)}`);
        return;
      case 'failed':
        throw new Error(
          'Purview reported the audit search as failed. This usually means the date range is ' +
            'outside your retention window, or the tenant has no unified audit log enabled.',
        );
      case 'cancelled':
        throw new Error('The Purview audit search was cancelled server-side.');
      default:
        progress.update(
          `${status} — ${formatDuration(elapsed)} elapsed (large tenants commonly need 5–20 min)`,
        );
    }

    // Cheap polls early (most queries finish fast), then ease off so a long
    // wait does not burn the tenant's Graph throttling budget.
    const interval = elapsed < 60_000 ? 5_000 : elapsed < 300_000 ? 15_000 : 30_000;
    await sleep(Math.min(interval, Math.max(1_000, deadline - Date.now())));
  }
}

/** One page of the `records` collection. Named so inference cannot go circular. */
interface RecordsPage {
  value?: GraphAuditRecord[];
  '@odata.nextLink'?: string;
}

/** Follow `@odata.nextLink` until exhausted, the cap is hit, or time runs out. */
async function pageAuditRecords(
  queryId: string,
  opts: MicrosoftFetchOptions,
  auth: () => Promise<Record<string, string>>,
): Promise<{ records: GraphAuditRecord[]; truncated: boolean }> {
  const records: GraphAuditRecord[] = [];
  const progress = new Progress('Copilot records');
  let truncated = false;
  let pages = 0;

  // $top is a hint; Graph caps page size itself. 999 keeps round-trips low.
  let url: string | undefined =
    `${GRAPH_BASE}/security/auditLog/queries/${encodeURIComponent(queryId)}/records?$top=999`;

  while (url) {
    const page: RecordsPage = await requestJson<RecordsPage>(
      url,
      { headers: await auth() },
      { label: 'Purview records page', deadline: opts.deadline, timeoutMs: 120_000 },
    );

    pages++;
    for (const record of page.value ?? []) {
      if (records.length >= opts.maxRecords) {
        truncated = true;
        break;
      }
      records.push(record);
    }

    progress.update(`${records.length.toLocaleString()} fetched (page ${pages})`);

    if (truncated) break;
    url = page['@odata.nextLink'];
  }

  progress.done(
    `${records.length.toLocaleString()} record${records.length === 1 ? '' : 's'} over ${pages} page${pages === 1 ? '' : 's'}` +
      (truncated ? ` (capped at --max-records ${opts.maxRecords})` : ''),
  );
  return { records, truncated };
}

/** Translate Graph's terse errors into something an admin can act on. */
function explainGraphError(err: unknown, operations: string[]): Error {
  if (!(err instanceof HttpError)) return err as Error;

  const hint = (text: string): Error => new Error(`${err.message}\n  ${text}`);

  switch (err.status) {
    case 401:
      return hint(
        'The token was rejected. Sign in again, and confirm the account is a member of a role that can ' +
          'search the audit log (Audit Reader / Audit Manager, or Global Reader).',
      );
    case 403:
      return hint(
        'Access denied. Confirm all three:\n' +
          '    1. The app registration has delegated Graph permission AuditLogsQuery.Read.All (admin-consented).\n' +
          '    2. The signed-in account holds Audit Reader, Audit Manager, or Global Reader in Purview.\n' +
          '    3. Your tenant has a licence that includes Purview Audit (Standard or Premium).',
      );
    case 400:
      return hint(
        'Purview rejected the query shape. Current operation filters: ' +
          `${operations.join(', ') || '(none)'}. Override with --ms-operations if Microsoft has renamed them.`,
      );
    case 404:
      return hint(
        'The Purview Audit Search endpoint was not found for this tenant. It is unavailable in US Gov ' +
          'L4/L5 and 21Vianet clouds, where you must fall back to Search-UnifiedAuditLog in Exchange Online PowerShell.',
      );
    case 503:
      return hint('Purview is busy. This is usually transient — re-run in a few minutes.');
    default:
      return err;
  }
}

// ---------------------------------------------------------------------------
// Google Workspace Admin SDK Reports
// ---------------------------------------------------------------------------

export interface GoogleActivity {
  kind?: string;
  id?: {
    time?: string;
    uniqueQualifier?: string;
    applicationName?: string;
    customerId?: string;
  };
  actor?: { email?: string; profileId?: string; callerType?: string };
  ipAddress?: string;
  events?: Array<{
    type?: string;
    name?: string;
    parameters?: Array<{
      name?: string;
      value?: string;
      intValue?: string;
      boolValue?: boolean;
      multiValue?: string[];
      multiIntValue?: string[];
    }>;
  }>;
}

export interface GoogleFetchOptions {
  token: TokenSet;
  window: TimeWindow;
  /** Reports applications to sweep. Defaults to {@link DEFAULT_GEMINI_APPLICATIONS}. */
  applications: string[];
  maxRecords: number;
  deadline: number;
  refreshToken?: () => Promise<TokenSet>;
}

export interface GoogleFetchResult {
  activities: GoogleActivity[];
  truncated: boolean;
  warnings: string[];
}

/**
 * Page every Gemini activity in the window, across each requested application.
 *
 * An application the tenant does not have (or that Google has renamed) answers
 * 400 `invalidInput`; that degrades to a warning rather than failing the run,
 * so one bad application name cannot cost the admin the whole report.
 */
export async function fetchGeminiActivities(
  opts: GoogleFetchOptions,
): Promise<GoogleFetchResult> {
  const activities: GoogleActivity[] = [];
  const warnings: string[] = [];
  let truncated = false;
  let token = opts.token;

  const auth = async (): Promise<Record<string, string>> => {
    if (opts.refreshToken && token.expiresAt - 120_000 < Date.now()) {
      token = await opts.refreshToken();
    }
    return bearer(token);
  };

  for (const application of opts.applications) {
    if (truncated) break;

    const progress = new Progress(`Gemini activities (${application})`);
    let pageToken: string | undefined;
    let pages = 0;
    const before = activities.length;

    try {
      do {
        const url = new URL(
          `${REPORTS_BASE}/activity/users/all/applications/${encodeURIComponent(application)}`,
        );
        url.searchParams.set('startTime', opts.window.start);
        url.searchParams.set('endTime', opts.window.end);
        // 1000 is the documented ceiling for this endpoint.
        url.searchParams.set('maxResults', '1000');
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const page = await requestJson<{
          items?: GoogleActivity[];
          nextPageToken?: string;
        }>(
          url.toString(),
          { headers: { ...(await auth()), accept: 'application/json' } },
          {
            label: `Reports API (${application})`,
            deadline: opts.deadline,
            timeoutMs: 90_000,
          },
        );

        pages++;
        for (const item of page.items ?? []) {
          if (activities.length >= opts.maxRecords) {
            truncated = true;
            break;
          }
          activities.push(item);
        }

        progress.update(`${activities.length - before} fetched (page ${pages})`);
        pageToken = truncated ? undefined : page.nextPageToken;
      } while (pageToken);

      const count = activities.length - before;
      progress.done(
        `${count.toLocaleString()} activit${count === 1 ? 'y' : 'ies'} over ${pages} page${pages === 1 ? '' : 's'}` +
          (truncated ? ` (capped at --max-records ${opts.maxRecords})` : ''),
      );
    } catch (err) {
      const explained = explainReportsError(err, application);
      if (explained.fatal) throw explained.error;
      warnings.push(explained.error.message);
      log.warn(explained.error.message);
    }
  }

  if (activities.length === 0 && warnings.length === 0) {
    warnings.push(
      'No Gemini activities were returned. Gemini-in-Workspace audit logging began 2025-06-20 and requires ' +
        'a Gemini for Workspace / Workspace with Gemini licence — an unlicensed tenant logs nothing.',
    );
  }

  return { activities, truncated, warnings };
}

/**
 * Classify a Reports API failure as fatal (stop) or skippable (warn).
 *
 * Only credential and consent problems are fatal; an application name this
 * tenant does not recognise should not sink the run.
 */
function explainReportsError(
  err: unknown,
  application: string,
): { error: Error; fatal: boolean } {
  if (!(err instanceof HttpError)) return { error: err as Error, fatal: true };

  switch (err.status) {
    case 400:
      return {
        error: new Error(
          `Reports API rejected application "${application}" — this tenant may not expose it yet. Skipping.`,
        ),
        fatal: false,
      };
    case 401:
      return {
        error: new Error(
          `${err.message}\n  The Google token was rejected. Re-run to sign in again.`,
        ),
        fatal: true,
      };
    case 403:
      return {
        error: new Error(
          `${err.message}\n` +
            '  Access denied. Confirm all three:\n' +
            '    1. You signed in as a Super Admin (or a role with Reports privileges).\n' +
            '    2. The OAuth consent screen grants admin.reports.audit.readonly.\n' +
            '    3. The Admin SDK API is enabled in the Google Cloud project backing your OAuth client.',
        ),
        fatal: true,
      };
    case 404:
      return {
        error: new Error(
          `Reports API has no data source named "${application}" for this tenant. Skipping.`,
        ),
        fatal: false,
      };
    default:
      return { error: err, fatal: true };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Compute the collection window.
 *
 * The end is nudged to "now" rather than midnight so the report includes
 * today's activity, and the start is floored to midnight UTC so day buckets in
 * the chart are whole days.
 */
export function buildWindow(days: number, now = new Date()): TimeWindow {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  start.setUTCHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}
