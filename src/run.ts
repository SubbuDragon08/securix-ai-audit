/**
 * Shared orchestration: authenticate -> collect -> normalise -> render.
 *
 * Both front ends drive this exact code path — the CLI in `index.ts` and the
 * Electron main process in `electron/main.ts`. Keeping one orchestrator means
 * the GUI cannot quietly drift from the CLI's behaviour around partial
 * failures, deadlines, or redaction, which is where two parallel
 * implementations always diverge first.
 *
 * Providers run sequentially and independently: a Microsoft consent failure
 * still produces a Google report, with the failure stated on the report's face.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  getGoogleToken,
  getMicrosoftToken,
  SessionStore,
  type TokenSet,
} from './auth.js';
import { ENTRA } from './brand.js';
import { buildDemoData } from './demo.js';
import {
  buildWindow,
  DEFAULT_COPILOT_OPERATIONS,
  DEFAULT_GEMINI_APPLICATIONS,
  fetchCopilotAuditRecords,
  fetchGeminiActivities,
  fetchSensitivityLabels,
} from './fetch.js';
import { log } from './log.js';
import {
  applyLabelNames,
  normalizeGoogle,
  normalizeMicrosoft,
  pseudonymiseUsers,
  sortEvents,
} from './normalize.js';
import { renderReport } from './report.js';
import type { PromptEvent, Provider, ProviderResult } from './types.js';

export const VERSION = '0.1.0';

export interface MicrosoftRunConfig {
  tenantId: string;
  clientId: string;
  authority: string;
  auth: 'device' | 'browser';
  operations: string[];
  queryId?: string;
}

export interface GoogleRunConfig {
  clientId: string;
  clientSecret?: string;
  applications: string[];
}

export interface RunConfig {
  providers: Provider[];
  days: number;
  maxRecords: number;
  timeoutMs: number;
  port: number;
  pseudonymize: boolean;
  includeRaw: boolean;
  demo: boolean;
  /** Which platform --demo should simulate. Real orgs run exactly one. */
  demoProvider?: 'microsoft' | 'google' | 'both';
  outPath?: string;
  microsoft?: MicrosoftRunConfig;
  google?: GoogleRunConfig;
}

export interface RunOutcome {
  outPath: string;
  events: PromptEvent[];
  results: ProviderResult[];
  totalEvents: number;
  uniqueUsers: number;
  elapsedSeconds: number;
  /** True when every attempted provider failed. */
  allFailed: boolean;
}

export interface RunHooks {
  session: SessionStore;
  signal?: AbortSignal;
  /** Default output filename when `outPath` is not given. */
  defaultOutDir?: string;
}

const defaultFileName = (): string =>
  `ai-audit-report-${new Date().toISOString().slice(0, 10)}.html`;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function runMicrosoft(
  config: RunConfig,
  ms: MicrosoftRunConfig,
  hooks: RunHooks,
  deadline: number,
): Promise<ProviderResult> {
  const result: ProviderResult = {
    provider: 'microsoft',
    events: [],
    truncated: false,
    warnings: [],
    diagnostics: {},
  };

  try {
    log.step('Microsoft 365 Copilot — Purview Audit Search');

    const authOptions = {
      tenantId: ms.tenantId,
      clientId: ms.clientId,
      scopes: [
        'https://graph.microsoft.com/AuditLogsQuery.Read.All',
        // Turns label GUIDs in the audit records into names an admin recognises.
        'https://graph.microsoft.com/SensitivityLabel.Read',
      ],
      mode: ms.auth,
      port: config.port,
      authority: ms.authority,
      interactiveTimeoutMs: Math.max(30_000, Math.min(10 * 60_000, deadline - Date.now())),
      session: hooks.session,
    };

    const token = await getMicrosoftToken(authOptions);

    const fetched = await fetchCopilotAuditRecords({
      token,
      window: buildWindow(config.days),
      operations: ms.operations,
      maxRecords: config.maxRecords,
      deadline,
      resumeQueryId: ms.queryId,
      refreshToken: (): Promise<TokenSet> => getMicrosoftToken(authOptions),
      signal: hooks.signal,
    });

    const rawCount = fetched.records.length;
    result.events = normalizeMicrosoft(fetched.records, { includeRaw: config.includeRaw });

    // Release the raw Purview records now that normalisation is done. They are
    // the fattest thing in the process — measured at ~4 KB each once auditData
    // is included — and holding them alongside the normalised events roughly
    // doubles peak memory on a large tenant for no benefit. Skipped when
    // --include-raw, because there the events still reference them.
    if (!config.includeRaw) fetched.records.length = 0;

    // Only worth a round trip if something actually came back labelled.
    if (result.events.some((e) => e.sensitivityLabels.length > 0)) {
      const labels = await fetchSensitivityLabels({ token, deadline, signal: hooks.signal });
      result.events = applyLabelNames(result.events, labels.names);
      if (labels.warning) fetched.warnings.push(labels.warning);
    }

    result.truncated = fetched.truncated;
    result.warnings = fetched.warnings;
    result.diagnostics = {
      queryId: fetched.queryId,
      rawRecords: rawCount,
      queryWaitSeconds: fetched.queryWaitSeconds,
      operations: ms.operations.join(', '),
    };

    const dropped = rawCount - result.events.length;
    if (dropped > 0) {
      result.warnings.push(`${dropped} record(s) had no usable timestamp and were excluded.`);
    }
  } catch (err) {
    result.error = (err as Error).message;
    log.error(result.error);
  }

  return result;
}

async function runGoogle(
  config: RunConfig,
  google: GoogleRunConfig,
  hooks: RunHooks,
  deadline: number,
): Promise<ProviderResult> {
  const result: ProviderResult = {
    provider: 'google',
    events: [],
    truncated: false,
    warnings: [],
    diagnostics: {},
  };

  try {
    log.step('Google Gemini — Admin SDK Reports');

    const authOptions = {
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      scopes: ['https://www.googleapis.com/auth/admin.reports.audit.readonly'],
      port: config.port,
      interactiveTimeoutMs: Math.max(30_000, Math.min(10 * 60_000, deadline - Date.now())),
      session: hooks.session,
    };

    const token = await getGoogleToken(authOptions);

    const fetched = await fetchGeminiActivities({
      token,
      window: buildWindow(config.days),
      applications: google.applications,
      maxRecords: config.maxRecords,
      deadline,
      refreshToken: (): Promise<TokenSet> => getGoogleToken(authOptions),
      signal: hooks.signal,
    });

    result.events = normalizeGoogle(fetched.activities, { includeRaw: config.includeRaw });
    result.truncated = fetched.truncated;
    result.warnings = fetched.warnings;
    result.diagnostics = {
      rawActivities: fetched.activities.length,
      applications: google.applications.join(', '),
    };
  } catch (err) {
    result.error = (err as Error).message;
    log.error(result.error);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAudit(config: RunConfig, hooks: RunHooks): Promise<RunOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + config.timeoutMs;
  const window = buildWindow(config.days);

  let results: ProviderResult[];
  let tenantLabel: string;

  if (config.demo) {
    log.step('Demo mode — synthetic data, no network calls');
    const demo = buildDemoData(config.days, config.demoProvider ?? 'microsoft');
    results = demo.results;
    tenantLabel = 'contoso.com (sample data)';
    log.ok(`Generated ${demo.events.length.toLocaleString()} synthetic interactions.`);
  } else {
    results = [];
    for (const provider of config.providers) {
      if (hooks.signal?.aborted) break;
      if (provider === 'microsoft' && config.microsoft) {
        results.push(await runMicrosoft(config, config.microsoft, hooks, deadline));
      } else if (provider === 'google' && config.google) {
        results.push(await runGoogle(config, config.google, hooks, deadline));
      }
    }
    // The Entra tenant id is the most recognisable label; a Google OAuth client
    // id is a Cloud project number and means nothing to the reader.
    tenantLabel =
      config.microsoft && config.microsoft.tenantId !== ENTRA.tenant
        ? config.microsoft.tenantId
        : config.google
          ? 'Google Workspace tenant'
          : 'your tenant';
  }

  log.step('Building report');

  let events = sortEvents(results.flatMap((r) => r.events));
  if (config.pseudonymize) {
    events = pseudonymiseUsers(events);
    for (const result of results) result.events = pseudonymiseUsers(result.events);
    log.info('Identities pseudonymised; the alias map was not written anywhere.');
  }

  const html = renderReport(events, {
    generatedAt: new Date().toISOString(),
    windowStart: window.start,
    windowEnd: window.end,
    tenantLabel,
    toolVersion: VERSION,
    redacted: config.pseudonymize,
    results,
  });

  const outPath = resolve(
    config.outPath ?? resolve(hooks.defaultOutDir ?? process.cwd(), defaultFileName()),
  );
  // 0600: this file embeds tenant audit records.
  writeFileSync(outPath, html, { encoding: 'utf8', mode: 0o600 });

  const sizeMb = Buffer.byteLength(html, 'utf8') / 1_048_576;
  log.ok(`Report written: ${outPath} (${sizeMb.toFixed(1)} MB)`);

  const attempted = results.length;
  return {
    outPath,
    events,
    results,
    totalEvents: events.length,
    uniqueUsers: new Set(events.map((e) => e.user)).size,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    allFailed: attempted > 0 && results.every((r) => r.error) && !config.demo,
  };
}

export { DEFAULT_COPILOT_OPERATIONS, DEFAULT_GEMINI_APPLICATIONS };
