#!/usr/bin/env node
/**
 * ai-audit-lens — CLI entry point and orchestrator.
 *
 * Flow: parse config -> authenticate per provider -> collect -> normalise ->
 * render -> open. Providers are independent: if Microsoft fails on consent, the
 * Google half still renders and the failure is stated on the report's face
 * rather than swallowed. That partial-success behaviour is deliberate — an
 * admin evaluating a tool in a 15-minute window should never get an empty
 * terminal and no artifact.
 */

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  getGoogleToken,
  getMicrosoftToken,
  openBrowser,
  SessionStore,
  type TokenSet,
} from './auth.js';
import { buildDemoData } from './demo.js';
import {
  buildWindow,
  DEFAULT_COPILOT_OPERATIONS,
  DEFAULT_GEMINI_APPLICATIONS,
  fetchCopilotAuditRecords,
  fetchGeminiActivities,
} from './fetch.js';
import { log, setVerbose, style } from './log.js';
import { normalizeGoogle, normalizeMicrosoft, pseudonymiseUsers, sortEvents } from './normalize.js';
import { renderReport } from './report.js';
import type { PromptEvent, Provider, ProviderResult } from './types.js';

const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const USAGE = `
${style.bold('ai-audit-lens')} v${VERSION} — local AI prompt audit reporting

  Pulls Microsoft 365 Copilot and Google Gemini prompt audit logs from your own
  tenant and renders a single-file HTML dashboard. Runs entirely on this machine.

${style.bold('USAGE')}
  ai-audit-lens [options]

${style.bold('QUICK START')}
  ai-audit-lens --demo                      Preview the report with synthetic data
  ai-audit-lens --ms-tenant <id> --ms-client-id <id>
  ai-audit-lens --google-client-id <id> --google-client-secret <secret>

${style.bold('GENERAL')}
  --days <n>              Days of history to collect (default 7, max 180)
  --provider <p>          microsoft | google | both  (default: whatever is configured)
  --out <path>            Output file (default ./ai-audit-report-<date>.html)
  --max-records <n>       Per-provider collection cap (default 50000)
  --timeout <minutes>     Overall deadline (default 15)
  --no-open               Do not launch the browser when finished
  --json                  Also write normalised events as JSON to stdout
  --verbose               Log URLs, status codes, and retry decisions
  --demo                  Generate a synthetic report; no network, no auth
  --version, --help

${style.bold('PRIVACY')}
  --pseudonymize          Replace user identities with per-run aliases, drop IPs
  --include-raw           Attach untouched provider payloads to --json output.
                          Deliberately NOT embedded in the HTML: raw audit records
                          are many times larger than the report and would make it
                          both unopenable and far more sensitive to pass around.
  --save-session          Cache refresh tokens under ~/.ai-audit-lens (0600).
                          Off by default: a Global Admin refresh token on disk is
                          a standing credential, not a one-shot report.

${style.bold('MICROSOFT (Purview Audit Search via Graph)')}
  --ms-tenant <id>        Tenant id or domain            [env AZURE_TENANT_ID]
  --ms-client-id <id>     App registration client id     [env AZURE_CLIENT_ID]
  --ms-auth <mode>        device | browser  (default device)
  --ms-operations <list>  Comma-separated operation filters
                          (default ${DEFAULT_COPILOT_OPERATIONS.join(',')})
  --ms-query-id <id>      Resume a previously created Purview query
  --ms-authority <host>   Entra host (default login.microsoftonline.com)

${style.bold('GOOGLE (Admin SDK Reports)')}
  --google-client-id <id>       OAuth client id      [env GOOGLE_CLIENT_ID]
  --google-client-secret <s>    OAuth client secret  [env GOOGLE_CLIENT_SECRET]
  --google-apps <list>          Comma-separated Reports applications
                                (default ${DEFAULT_GEMINI_APPLICATIONS.join(',')})
  --port <n>                    Loopback callback port (default 3000)

${style.bold('SCOPES REQUESTED')}
  Microsoft  https://graph.microsoft.com/AuditLogsQuery.Read.All   (read-only)
  Google     https://www.googleapis.com/auth/admin.reports.audit.readonly
`;

const MS_SCOPES = ['https://graph.microsoft.com/AuditLogsQuery.Read.All'];
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/admin.reports.audit.readonly'];

interface Config {
  days: number;
  provider: Provider[] | 'auto';
  out?: string;
  maxRecords: number;
  timeoutMs: number;
  open: boolean;
  json: boolean;
  verbose: boolean;
  demo: boolean;
  pseudonymize: boolean;
  includeRaw: boolean;
  saveSession: boolean;
  port: number;
  ms: {
    tenantId?: string;
    clientId?: string;
    auth: 'device' | 'browser';
    operations: string[];
    queryId?: string;
    authority: string;
  };
  google: {
    clientId?: string;
    clientSecret?: string;
    applications: string[];
  };
}

class ConfigError extends Error {}

const splitList = (value: string | undefined, fallback: string[]): string[] =>
  value === undefined
    ? fallback
    : value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

function parseConfig(argv: string[]): Config {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      days: { type: 'string' },
      provider: { type: 'string' },
      out: { type: 'string' },
      'max-records': { type: 'string' },
      timeout: { type: 'string' },
      // Declared explicitly: node:util parseArgs does not synthesise `--no-*`
      // negations, so the documented flag has to be a real option.
      'no-open': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      pseudonymize: { type: 'boolean', default: false },
      'include-raw': { type: 'boolean', default: false },
      'save-session': { type: 'boolean', default: false },
      port: { type: 'string' },
      'ms-tenant': { type: 'string' },
      'ms-client-id': { type: 'string' },
      'ms-auth': { type: 'string' },
      'ms-operations': { type: 'string' },
      'ms-query-id': { type: 'string' },
      'ms-authority': { type: 'string' },
      'google-client-id': { type: 'string' },
      'google-client-secret': { type: 'string' },
      'google-apps': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  if (values.version) {
    process.stdout.write(VERSION + '\n');
    process.exit(0);
  }

  const int = (raw: string | undefined, label: string, def: number, min: number, max: number): number => {
    if (raw === undefined) return def;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new ConfigError(`--${label} must be an integer between ${min} and ${max} (got "${raw}").`);
    }
    return parsed;
  };

  // Purview and Reports both retain ~180 days; asking for more just errors later.
  const days = int(values.days, 'days', 7, 1, 180);
  const msAuth = values['ms-auth'] ?? 'device';
  if (msAuth !== 'device' && msAuth !== 'browser') {
    throw new ConfigError('--ms-auth must be "device" or "browser".');
  }

  let provider: Provider[] | 'auto' = 'auto';
  if (values.provider !== undefined) {
    const raw = values.provider.toLowerCase();
    if (raw === 'both') provider = ['microsoft', 'google'];
    else if (raw === 'microsoft' || raw === 'google') provider = [raw];
    else throw new ConfigError('--provider must be "microsoft", "google", or "both".');
  }

  return {
    days,
    provider,
    out: values.out,
    maxRecords: int(values['max-records'], 'max-records', 50_000, 1, 1_000_000),
    timeoutMs: int(values.timeout, 'timeout', 15, 1, 240) * 60_000,
    open: values['no-open'] !== true,
    json: values.json === true,
    verbose: values.verbose === true,
    demo: values.demo === true,
    pseudonymize: values.pseudonymize === true,
    includeRaw: values['include-raw'] === true,
    saveSession: values['save-session'] === true,
    port: int(values.port, 'port', 3000, 1024, 65_535),
    ms: {
      tenantId: values['ms-tenant'] ?? process.env['AZURE_TENANT_ID'],
      clientId: values['ms-client-id'] ?? process.env['AZURE_CLIENT_ID'],
      auth: msAuth,
      operations: splitList(values['ms-operations'], DEFAULT_COPILOT_OPERATIONS),
      queryId: values['ms-query-id'],
      authority: values['ms-authority'] ?? 'login.microsoftonline.com',
    },
    google: {
      clientId: values['google-client-id'] ?? process.env['GOOGLE_CLIENT_ID'],
      clientSecret: values['google-client-secret'] ?? process.env['GOOGLE_CLIENT_SECRET'],
      applications: splitList(values['google-apps'], DEFAULT_GEMINI_APPLICATIONS),
    },
  };
}

/** Which providers actually have enough configuration to run. */
function resolveProviders(config: Config): Provider[] {
  const configured: Provider[] = [];
  if (config.ms.tenantId && config.ms.clientId) configured.push('microsoft');
  if (config.google.clientId) configured.push('google');

  if (config.provider === 'auto') {
    if (configured.length === 0) {
      throw new ConfigError(
        'No provider is configured.\n\n' +
          '  Microsoft:  --ms-tenant <tenant> --ms-client-id <app-id>\n' +
          '  Google:     --google-client-id <id> --google-client-secret <secret>\n\n' +
          '  See the README for the two-minute app registration walkthrough, or run\n' +
          '  ai-audit-lens --demo to preview the report with synthetic data first.',
      );
    }
    return configured;
  }

  for (const wanted of config.provider) {
    if (!configured.includes(wanted)) {
      throw new ConfigError(
        wanted === 'microsoft'
          ? '--provider microsoft needs --ms-tenant and --ms-client-id (or AZURE_TENANT_ID / AZURE_CLIENT_ID).'
          : '--provider google needs --google-client-id (or GOOGLE_CLIENT_ID).',
      );
    }
  }
  return config.provider;
}

// ---------------------------------------------------------------------------
// Provider runs
// ---------------------------------------------------------------------------

async function runMicrosoft(
  config: Config,
  session: SessionStore,
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
      tenantId: config.ms.tenantId!,
      clientId: config.ms.clientId!,
      scopes: MS_SCOPES,
      mode: config.ms.auth,
      port: config.port,
      authority: config.ms.authority,
      // Never fall below 30s: a deadline that has nearly elapsed should not
      // abort the browser step the instant it opens.
      interactiveTimeoutMs: Math.max(30_000, Math.min(10 * 60_000, deadline - Date.now())),
      session,
    };

    const token = await getMicrosoftToken(authOptions);

    const fetched = await fetchCopilotAuditRecords({
      token,
      window: buildWindow(config.days),
      operations: config.ms.operations,
      maxRecords: config.maxRecords,
      deadline,
      resumeQueryId: config.ms.queryId,
      // Deep pagination can outlive the access token; hand the fetcher a way
      // to silently re-mint one instead of dying at page 40.
      refreshToken: (): Promise<TokenSet> => getMicrosoftToken(authOptions),
    });

    result.events = normalizeMicrosoft(fetched.records, { includeRaw: config.includeRaw });
    result.truncated = fetched.truncated;
    result.warnings = fetched.warnings;
    result.diagnostics = {
      queryId: fetched.queryId,
      rawRecords: fetched.records.length,
      queryWaitSeconds: fetched.queryWaitSeconds,
      operations: config.ms.operations.join(', '),
    };

    const dropped = fetched.records.length - result.events.length;
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
  config: Config,
  session: SessionStore,
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
      clientId: config.google.clientId!,
      clientSecret: config.google.clientSecret,
      scopes: GOOGLE_SCOPES,
      port: config.port,
      // Never fall below 30s: a deadline that has nearly elapsed should not
      // abort the browser step the instant it opens.
      interactiveTimeoutMs: Math.max(30_000, Math.min(10 * 60_000, deadline - Date.now())),
      session,
    };

    const token = await getGoogleToken(authOptions);

    const fetched = await fetchGeminiActivities({
      token,
      window: buildWindow(config.days),
      applications: config.google.applications,
      maxRecords: config.maxRecords,
      deadline,
      refreshToken: (): Promise<TokenSet> => getGoogleToken(authOptions),
    });

    result.events = normalizeGoogle(fetched.activities, { includeRaw: config.includeRaw });
    result.truncated = fetched.truncated;
    result.warnings = fetched.warnings;
    result.diagnostics = {
      rawActivities: fetched.activities.length,
      applications: config.google.applications.join(', '),
    };
  } catch (err) {
    result.error = (err as Error).message;
    log.error(result.error);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const config = parseConfig(process.argv.slice(2));
  setVerbose(config.verbose);

  const startedAt = Date.now();
  const deadline = startedAt + config.timeoutMs;
  const window = buildWindow(config.days);

  log.info('');
  log.info(style.bold(`ai-audit-lens v${VERSION}`) + style.dim('  ·  everything runs locally'));

  let results: ProviderResult[];
  let tenantLabel: string;

  if (config.demo) {
    log.step('Demo mode — synthetic data, no network calls');
    const demo = buildDemoData(config.days);
    results = demo.results;
    tenantLabel = 'contoso.com (demo data)';
    log.ok(`Generated ${demo.events.length.toLocaleString()} synthetic interactions.`);
  } else {
    const providers = resolveProviders(config);
    const session = new SessionStore(config.saveSession);

    log.info(
      style.dim(
        `  Window: ${window.start.slice(0, 10)} to ${window.end.slice(0, 10)} (${config.days}d)  ·  ` +
          `Providers: ${providers.join(', ')}  ·  Deadline: ${Math.round(config.timeoutMs / 60_000)}m`,
      ),
    );
    if (!config.saveSession) {
      log.info(style.dim('  Tokens are held in memory only (--save-session to cache).'));
    }

    // Sequential, not parallel: two interactive browser sign-ins racing each
    // other is a genuinely confusing experience.
    results = [];
    for (const provider of providers) {
      results.push(
        provider === 'microsoft'
          ? await runMicrosoft(config, session, deadline)
          : await runGoogle(config, session, deadline),
      );
    }

    // The Entra tenant id is the most recognisable label; a Google OAuth client
    // id is a Cloud project number and means nothing to the reader.
    tenantLabel = config.ms.tenantId ?? 'Google Workspace tenant';
  }

  // ---- assemble -----------------------------------------------------------
  log.step('Building report');

  let events: PromptEvent[] = sortEvents(results.flatMap((r) => r.events));
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
    config.out ?? `ai-audit-report-${new Date().toISOString().slice(0, 10)}.html`,
  );
  // 0600: this file embeds tenant audit records.
  writeFileSync(outPath, html, { encoding: 'utf8', mode: 0o600 });

  const sizeMb = Buffer.byteLength(html, 'utf8') / 1_048_576;
  log.ok(`Report written: ${style.bold(outPath)} (${sizeMb.toFixed(1)} MB)`);

  if (config.json) {
    log.out(JSON.stringify(events, null, 2));
  } else if (config.includeRaw) {
    log.warn('--include-raw only affects --json output; the HTML report never embeds raw payloads.');
  }

  // ---- summary ------------------------------------------------------------
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  log.info('');
  log.info(
    `  ${style.bold(events.length.toLocaleString())} interactions  ·  ` +
      `${new Set(events.map((e) => e.user)).size} users  ·  ` +
      `${elapsed}s elapsed`,
  );

  const failed = results.filter((r) => r.error);
  for (const result of failed) {
    log.warn(`${result.provider} did not complete — the report says so on its face.`);
  }

  if (config.open) {
    openBrowser(pathToFileURL(outPath).href);
  } else {
    log.info(style.dim(`  Open it with: open "${outPath}"`));
  }
  log.info('');

  // Non-zero only when nothing at all was collected — a partial report is a
  // success from the operator's point of view.
  return failed.length === results.length && !config.demo ? 1 : 0;
}

/**
 * Set the exit code and let Node terminate on its own.
 *
 * Emphatically *not* `process.exit()`: stdout to a pipe is asynchronous, so
 * exiting immediately after a large `--json` write truncates it at the pipe
 * buffer (64 KB on Linux/macOS). Falling off the end of the event loop flushes
 * first. Every handle this tool opens — the loopback listener, retry timers —
 * is closed or cleared on the way out, so there is nothing left to hold it.
 */
const finish = (code: number): void => {
  process.exitCode = code;
};

main()
  .then(finish)
  .catch((err: unknown) => {
    log.info('');
    if (err instanceof ConfigError) {
      log.error(err.message);
      log.info(style.dim('\n  Run ai-audit-lens --help for the full option list.'));
      finish(2);
      return;
    }
    log.error((err as Error)?.message ?? String(err));
    if (process.env['AI_AUDIT_LENS_DEBUG'] === '1') {
      console.error(err);
    } else {
      log.info(style.dim('  Re-run with --verbose, or AI_AUDIT_LENS_DEBUG=1 for a stack trace.'));
    }
    finish(1);
  });
