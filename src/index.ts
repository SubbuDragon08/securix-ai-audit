#!/usr/bin/env node
/**
 * ai-audit-lens — command-line front end.
 *
 * This file is *only* argument parsing, config resolution, and terminal
 * presentation. All orchestration lives in `run.ts`, which the Electron app
 * drives identically, so the CLI and the GUI can never disagree about how a
 * partial failure or a deadline is handled.
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { openBrowser, SessionStore } from './auth.js';
import { ENTRA } from './brand.js';
import { log, setVerbose, style } from './log.js';
import {
  DEFAULT_COPILOT_OPERATIONS,
  DEFAULT_GEMINI_APPLICATIONS,
  runAudit,
  VERSION,
  type RunConfig,
} from './run.js';
import type { Provider } from './types.js';

const USAGE = `
${style.bold('ai-audit-lens')} v${VERSION} — local AI prompt audit reporting

  Pulls Microsoft 365 Copilot and Google Gemini prompt audit logs from your own
  tenant and renders a single-file HTML dashboard. Runs entirely on this machine.

  Prefer a desktop app? The same core ships as a signed GUI — see the README.

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
  --demo-provider <p>     microsoft | google | both  (default microsoft)
                          Real tenants run one assistant, so the sample data
                          models one. "both" exercises the mixed-tenant view.
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
             https://graph.microsoft.com/SensitivityLabel.Read      (read-only)
             The second turns sensitivity-label GUIDs in the audit records into
             names. Declining it costs only the label names.
  Google     https://www.googleapis.com/auth/admin.reports.audit.readonly
`;

class ConfigError extends Error {}

interface CliConfig extends RunConfig {
  open: boolean;
  json: boolean;
  verbose: boolean;
  saveSession: boolean;
}

const splitList = (value: string | undefined, fallback: string[]): string[] =>
  value === undefined
    ? fallback
    : value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

function parseConfig(argv: string[]): CliConfig {
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
      'demo-provider': { type: 'string' },
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

  const msAuth = values['ms-auth'] ?? 'device';
  if (msAuth !== 'device' && msAuth !== 'browser') {
    throw new ConfigError('--ms-auth must be "device" or "browser".');
  }

  const msTenant = values['ms-tenant'] ?? process.env['AZURE_TENANT_ID'];
  const msClientId = values['ms-client-id'] ?? process.env['AZURE_CLIENT_ID'];
  const googleClientId = values['google-client-id'] ?? process.env['GOOGLE_CLIENT_ID'];

  const configured: Provider[] = [];
  if (msTenant && msClientId) configured.push('microsoft');
  if (googleClientId) configured.push('google');

  let providers: Provider[];
  if (values.provider === undefined) {
    if (configured.length === 0 && values.demo !== true) {
      throw new ConfigError(
        'No provider is configured.\n\n' +
          '  Microsoft:  --ms-tenant <tenant> --ms-client-id <app-id>\n' +
          '  Google:     --google-client-id <id> --google-client-secret <secret>\n\n' +
          '  See the README for the app registration walkthrough, or run\n' +
          '  ai-audit-lens --demo to preview the report with synthetic data first.',
      );
    }
    providers = configured;
  } else {
    const raw = values.provider.toLowerCase();
    if (raw === 'both') providers = ['microsoft', 'google'];
    else if (raw === 'microsoft' || raw === 'google') providers = [raw];
    else throw new ConfigError('--provider must be "microsoft", "google", or "both".');

    for (const wanted of providers) {
      if (configured.includes(wanted) || values.demo === true) continue;
      throw new ConfigError(
        wanted === 'microsoft'
          ? '--provider microsoft needs --ms-tenant and --ms-client-id (or AZURE_TENANT_ID / AZURE_CLIENT_ID).'
          : '--provider google needs --google-client-id (or GOOGLE_CLIENT_ID).',
      );
    }
  }

  return {
    providers,
    // Purview and Reports both retain ~180 days; asking for more just errors later.
    days: int(values.days, 'days', 7, 1, 180),
    maxRecords: int(values['max-records'], 'max-records', 50_000, 1, 1_000_000),
    timeoutMs: int(values.timeout, 'timeout', 15, 1, 240) * 60_000,
    port: int(values.port, 'port', 3000, 1024, 65_535),
    pseudonymize: values.pseudonymize === true,
    includeRaw: values['include-raw'] === true,
    demo: values.demo === true,
    demoProvider: (function () {
      const raw = values['demo-provider'];
      if (raw === undefined) return 'microsoft' as const;
      if (raw === 'microsoft' || raw === 'google' || raw === 'both') return raw;
      throw new ConfigError('--demo-provider must be "microsoft", "google", or "both".');
    })(),
    outPath: values.out,
    microsoft:
      msTenant && msClientId
        ? {
            tenantId: msTenant,
            clientId: msClientId,
            authority: values['ms-authority'] ?? ENTRA.authority,
            auth: msAuth,
            operations: splitList(values['ms-operations'], DEFAULT_COPILOT_OPERATIONS),
            queryId: values['ms-query-id'],
          }
        : undefined,
    google: googleClientId
      ? {
          clientId: googleClientId,
          clientSecret: values['google-client-secret'] ?? process.env['GOOGLE_CLIENT_SECRET'],
          applications: splitList(values['google-apps'], DEFAULT_GEMINI_APPLICATIONS),
        }
      : undefined,
    open: values['no-open'] !== true,
    json: values.json === true,
    verbose: values.verbose === true,
    saveSession: values['save-session'] === true,
  };
}

async function main(): Promise<number> {
  const config = parseConfig(process.argv.slice(2));
  setVerbose(config.verbose);

  log.info('');
  log.info(style.bold(`ai-audit-lens v${VERSION}`) + style.dim('  ·  everything runs locally'));

  if (!config.demo) {
    log.info(
      style.dim(
        `  Window: last ${config.days}d  ·  Providers: ${config.providers.join(', ')}  ·  ` +
          `Deadline: ${Math.round(config.timeoutMs / 60_000)}m`,
      ),
    );
    if (!config.saveSession) {
      log.info(style.dim('  Tokens are held in memory only (--save-session to cache).'));
    }
  }

  const outcome = await runAudit(config, {
    session: new SessionStore(config.saveSession),
  });

  if (config.json) {
    log.out(JSON.stringify(outcome.events, null, 2));
  } else if (config.includeRaw) {
    log.warn('--include-raw only affects --json output; the HTML report never embeds raw payloads.');
  }

  log.info('');
  log.info(
    `  ${style.bold(outcome.totalEvents.toLocaleString())} interactions  ·  ` +
      `${outcome.uniqueUsers} users  ·  ${outcome.elapsedSeconds}s elapsed`,
  );

  for (const result of outcome.results.filter((r) => r.error)) {
    log.warn(`${result.provider} did not complete — the report says so on its face.`);
  }

  if (config.open) {
    openBrowser(pathToFileURL(outcome.outPath).href);
  } else {
    log.info(style.dim(`  Open it with: open "${outcome.outPath}"`));
  }
  log.info('');

  // Non-zero only when nothing at all was collected — a partial report is a
  // success from the operator's point of view.
  return outcome.allFailed ? 1 : 0;
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
