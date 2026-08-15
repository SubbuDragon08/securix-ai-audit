/**
 * Raw provider records -> the unified `PromptEvent`.
 *
 * This module is deliberately paranoid. Audit schemas on both sides are still
 * moving (Microsoft ships `auditData` as an untyped bag whose casing varies by
 * workload and which is *sometimes* a JSON string; Google keeps adding event
 * parameters), so every read goes through a case-insensitive, defensive
 * accessor and every unknown shape degrades to a sensible label rather than
 * throwing. A schema change should cost you a column, never the report.
 *
 * Privacy posture: prompt and response *content* is never mapped into an
 * indexed field. `--include-raw` attaches the untouched provider payload to
 * `raw` for forensics, which surfaces only in the `--json` stream — the HTML
 * report is built from the normalised fields alone.
 */

import type { GoogleActivity, GraphAuditRecord } from './fetch.js';
import type { PromptEvent } from './types.js';

// ---------------------------------------------------------------------------
// Defensive access helpers
// ---------------------------------------------------------------------------

type Bag = Record<string, unknown>;

const isBag = (v: unknown): v is Bag =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Case-insensitive property read.
 *
 * Purview emits `AppHost` in most workloads and `appHost` in a few; Graph
 * sometimes camel-cases the envelope while leaving `auditData` PascalCase.
 * Matching case-insensitively is the only stable option.
 */
function pick(bag: unknown, ...names: string[]): unknown {
  if (!isBag(bag)) return undefined;
  const lowered = new Map<string, unknown>();
  for (const [k, v] of Object.entries(bag)) lowered.set(k.toLowerCase(), v);
  for (const name of names) {
    const hit = lowered.get(name.toLowerCase());
    if (hit !== undefined && hit !== null && hit !== '') return hit;
  }
  return undefined;
}

const asString = (v: unknown): string | undefined => {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** `auditData` arrives as an object or, from some workloads, a JSON string. */
function parseAuditData(raw: unknown): Bag {
  if (isBag(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isBag(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Trim unbounded provider strings before they reach the DOM. */
const clamp = (s: string, max = 200): string =>
  s.length > max ? s.slice(0, max - 1) + '…' : s;

const dedupe = (values: Array<string | undefined>, limit = 25): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const trimmed = clamp(v);
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
};

const UNKNOWN_USER = 'unknown';

/** Normalise an identity to a comparable key, without inventing one. */
function normaliseUser(...candidates: Array<unknown>): string {
  for (const c of candidates) {
    const s = asString(c);
    if (!s) continue;
    // Purview writes system principals as `app@sharepoint`, GUIDs, or SIDs;
    // keep them verbatim so they are visibly non-human in the report.
    return s.toLowerCase();
  }
  return UNKNOWN_USER;
}

// ---------------------------------------------------------------------------
// Microsoft Copilot
// ---------------------------------------------------------------------------

/**
 * `AppHost` values seen in CopilotInteraction records, mapped to the names an
 * admin would recognise. Unmapped values pass through title-cased.
 */
const COPILOT_HOSTS: Record<string, string> = {
  bizchat: 'Microsoft 365 Copilot Chat',
  m365app: 'Microsoft 365 App',
  office: 'Microsoft 365 App',
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
  outlook: 'Outlook',
  teams: 'Teams',
  onenote: 'OneNote',
  loop: 'Loop',
  sharepoint: 'SharePoint',
  whiteboard: 'Whiteboard',
  stream: 'Stream',
  designer: 'Designer',
  planner: 'Planner',
  forms: 'Forms',
  viva: 'Viva',
  copilotstudio: 'Copilot Studio',
  'copilot studio': 'Copilot Studio',
  edge: 'Edge',
  windows: 'Windows',
};

const titleCase = (s: string): string =>
  s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function copilotApp(eventData: Bag, record: GraphAuditRecord): string {
  const host = asString(pick(eventData, 'AppHost', 'appHost', 'AppName', 'App'));
  if (host) return COPILOT_HOSTS[host.toLowerCase()] ?? titleCase(host);
  const service = asString(record.service);
  return service ? titleCase(service) : 'Microsoft 365 Copilot';
}

/**
 * Pull the resources Copilot grounded its answer on.
 *
 * This is the security payload of the whole report: it is how an admin sees
 * that Copilot read `Q3 Layoffs.xlsx` while answering someone in Teams.
 */
function copilotResources(eventData: Bag): {
  resources: string[];
  labels: string[];
} {
  const accessed = asArray(pick(eventData, 'AccessedResources', 'accessedResources'));
  const contexts = asArray(pick(eventData, 'Contexts', 'contexts'));

  const resources = dedupe([
    ...accessed.map((r) => {
      const name = asString(pick(r, 'Name', 'name'));
      const site = asString(pick(r, 'SiteUrl', 'siteUrl', 'Id', 'id'));
      const type = asString(pick(r, 'Type', 'type'));
      if (name) return type ? `${name} (${type})` : name;
      return site;
    }),
    // Contexts describe *where* the interaction happened (a meeting, a doc).
    ...contexts.map((c) => asString(pick(c, 'Id', 'id'))),
  ]);

  const labels = dedupe(
    accessed.map((r) =>
      asString(pick(r, 'SensitivityLabelId', 'sensitivityLabelId', 'SensitivityLabel')),
    ),
    10,
  );

  return { resources, labels };
}

export interface NormalizeOptions {
  /** Attach the untouched provider payload to `raw`. Off by default. */
  includeRaw: boolean;
}

export function normalizeMicrosoft(
  records: GraphAuditRecord[],
  opts: NormalizeOptions,
): PromptEvent[] {
  const events: PromptEvent[] = [];

  for (const record of records) {
    const data = parseAuditData(record.auditData);
    const eventData = isBag(pick(data, 'CopilotEventData', 'copilotEventData'))
      ? (pick(data, 'CopilotEventData', 'copilotEventData') as Bag)
      : {};

    const timestamp =
      asString(record.createdDateTime) ?? asString(pick(data, 'CreationTime')) ?? '';
    // A record with no usable timestamp cannot be placed on the timeline and
    // would silently corrupt the daily buckets — drop it rather than guess.
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) continue;

    const { resources, labels } = copilotResources(eventData);

    const models = dedupe(
      asArray(pick(eventData, 'ModelTransparencyDetails', 'modelTransparencyDetails')).map((m) =>
        asString(pick(m, 'ModelName', 'modelName', 'Name')),
      ),
      3,
    );

    events.push({
      id: record.id || `ms-${parsed}-${events.length}`,
      timestamp: new Date(parsed).toISOString(),
      provider: 'microsoft',
      user: normaliseUser(record.userPrincipalName, record.userId, pick(data, 'UserId')),
      app: copilotApp(eventData, record),
      operation: asString(record.operation) ?? asString(pick(data, 'Operation')) ?? 'CopilotInteraction',
      clientIp: asString(record.clientIp) ?? asString(pick(data, 'ClientIP', 'ClientIp')),
      model: models[0],
      accessedResources: resources,
      sensitivityLabels: labels,
      ...(opts.includeRaw ? { raw: record } : {}),
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

/** `app_name` values from `gemini_in_workspace_apps` events. */
const GEMINI_APPS: Record<string, string> = {
  gmail: 'Gmail',
  docs: 'Docs',
  drive: 'Drive',
  sheets: 'Sheets',
  slides: 'Slides',
  meet: 'Meet',
  chat: 'Chat',
  vids: 'Vids',
  forms: 'Forms',
  gemini_app: 'Gemini App',
  geminiapp: 'Gemini App',
  workspace: 'Workspace',
};

/** Flatten a Reports API parameter list into a plain map. */
function parameterMap(
  parameters: NonNullable<NonNullable<GoogleActivity['events']>[number]['parameters']>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of parameters) {
    if (!p.name) continue;
    const value =
      p.value ??
      p.intValue ??
      (typeof p.boolValue === 'boolean' ? String(p.boolValue) : undefined) ??
      (p.multiValue?.length ? p.multiValue.join(', ') : undefined) ??
      (p.multiIntValue?.length ? p.multiIntValue.join(', ') : undefined);
    if (value !== undefined && value !== '') map.set(p.name.toLowerCase(), value);
  }
  return map;
}

/**
 * One Reports activity can carry several events; each is one interaction, so
 * they are emitted as separate `PromptEvent`s.
 */
export function normalizeGoogle(
  activities: GoogleActivity[],
  opts: NormalizeOptions,
): PromptEvent[] {
  const events: PromptEvent[] = [];

  for (const activity of activities) {
    const timestamp = activity.id?.time ?? '';
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) continue;

    const user = normaliseUser(activity.actor?.email, activity.actor?.profileId);
    const qualifier = activity.id?.uniqueQualifier ?? String(parsed);
    const list = activity.events ?? [];

    // An activity with no event array still represents a logged interaction;
    // emit a single row so the count stays honest.
    const iterable = list.length > 0 ? list : [{ name: undefined, parameters: undefined }];

    iterable.forEach((event, index) => {
      const params = parameterMap(event.parameters ?? []);
      const appName = params.get('app_name') ?? params.get('product_name');
      const action = params.get('action');
      const featureSource = params.get('feature_source');
      const category = params.get('event_category');

      events.push({
        id: `${qualifier}-${index}`,
        timestamp: new Date(parsed).toISOString(),
        provider: 'google',
        user,
        app: appName
          ? (GEMINI_APPS[appName.toLowerCase()] ?? titleCase(appName))
          : 'Gemini for Workspace',
        // `action` (generate_text, summarize, …) is far more informative than
        // the event name, which is always `feature_utilization`.
        operation: titleCase(action ?? event.name ?? 'feature_utilization'),
        clientIp: activity.ipAddress,
        surface: featureSource ? titleCase(featureSource) : category ? titleCase(category) : undefined,
        // Google exposes no grounded-resource data at all. Leaving this empty —
        // rather than padding it with UI metadata — keeps "grounded on tenant
        // data" an honest measure, and is why that tile is Microsoft-only.
        accessedResources: [],
        sensitivityLabels: [],
        ...(opts.includeRaw ? { raw: activity } : {}),
      });
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

/** Newest first, with a stable tiebreak so repeat runs render identically. */
export function sortEvents(events: PromptEvent[]): PromptEvent[] {
  return [...events].sort((a, b) => {
    const delta = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

/**
 * Replace identities with stable pseudonyms.
 *
 * For sharing a report outside the security team, or for works councils / GDPR
 * regimes where per-user AI telemetry is restricted. The mapping is per-run and
 * held only in memory, so it cannot be reversed from the HTML alone.
 */
export function pseudonymiseUsers(events: PromptEvent[]): PromptEvent[] {
  const aliases = new Map<string, string>();
  return events.map((event) => {
    if (event.user === UNKNOWN_USER) return event;
    let alias = aliases.get(event.user);
    if (!alias) {
      alias = `user-${String(aliases.size + 1).padStart(3, '0')}`;
      aliases.set(event.user, alias);
    }
    return { ...event, user: alias, clientIp: undefined };
  });
}
