/**
 * Single-file HTML dashboard generator.
 *
 * Output contract: one `.html` file the admin can open, email, or attach to a
 * ticket. It contains no local asset references and makes no network calls of
 * its own beyond two pinned CDN tags (Tailwind + Chart.js) requested by the
 * brief. Normalised tenant data is embedded inline — **the file is as sensitive
 * as the audit log itself**, which the report says on its own face. Raw provider
 * payloads are never embedded, even under `--include-raw`; they reach the
 * operator through the `--json` stream instead.
 *
 * Payload encoding
 * ----------------
 * Events are dictionary-encoded into parallel arrays rather than an array of
 * objects. A tenant with 50k interactions would be ~18 MB of naive JSON; the
 * encoded form lands around 2–3 MB, which keeps the file openable. The client
 * re-derives every aggregate from those rows so the filter bar can re-scope all
 * three charts and the KPI tiles consistently — precomputing server-side would
 * desynchronise the moment a filter is applied.
 *
 * Colour
 * ------
 * The categorical slots, sequential ramp, chrome ink, and both surfaces come
 * from a palette validated for CVD separation and contrast in light *and* dark.
 * Slot order is the safety mechanism, so it is fixed and never cycled: single
 * series charts use slot 1 for every mark; the only two-series chart
 * (Microsoft vs Google) uses slots 1 and 2, which clear every gate.
 */

import type { PromptEvent, ReportMeta } from './types.js';

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

interface Payload {
  meta: {
    generatedAt: string;
    windowStart: string;
    windowEnd: string;
    tenantLabel: string;
    toolVersion: string;
    redacted: boolean;
    totalEvents: number;
    shownEvents: number;
    /**
     * The platform this report is about.
     *
     * An organisation runs one assistant — whichever came with its productivity
     * suite — so the report drops the whole provider dimension (split charts,
     * platform column, platform filter) and spends that space on widgets
     * specific to the platform in play. `mixed` restores the comparison view.
     */
    primaryProvider: 'microsoft' | 'google' | 'mixed' | 'none';
    providers: Array<{
      provider: string;
      label: string;
      count: number;
      truncated: boolean;
      warnings: string[];
      error?: string;
      diagnostics: Record<string, string | number | boolean>;
    }>;
  };
  dict: {
    users: string[];
    apps: string[];
    ops: string[];
    resources: string[];
    labels: string[];
    /** Google `feature_source` values. Empty for Microsoft. */
    surfaces: string[];
  };
  /**
   * [timestampMs, userIdx, providerIdx, appIdx, opIdx, ip, resourceIdx[], labelIdx[], surfaceIdx]
   *
   * Resources are interned like every other string. They repeat heavily — a
   * handful of hot documents account for most groundings in a real tenant — and
   * inlining them was by far the largest contributor to report size.
   */
  rows: Array<[number, number, number, number, number, string, number[], number[], number]>;
}

class Interner {
  private readonly index = new Map<string, number>();
  readonly values: string[] = [];

  intern(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const id = this.values.length;
    this.index.set(value, id);
    this.values.push(value);
    return id;
  }
}

const PROVIDER_LABELS: Record<string, string> = {
  microsoft: 'Microsoft 365 Copilot',
  google: 'Google Gemini',
};

function buildPayload(events: PromptEvent[], meta: ReportMeta, maxRows: number): Payload {
  const users = new Interner();
  const apps = new Interner();
  const ops = new Interner();
  const resources = new Interner();
  const labels = new Interner();
  const surfaces = new Interner();

  const shown = events.slice(0, maxRows);
  const rows = shown.map((e): Payload['rows'][number] => [
    Date.parse(e.timestamp),
    users.intern(e.user),
    e.provider === 'microsoft' ? 0 : 1,
    apps.intern(e.app),
    ops.intern(e.operation),
    e.clientIp ?? '',
    // Cap per-row detail: a Copilot answer can ground on dozens of files, and
    // the table only ever shows the first few before "+N more".
    e.accessedResources.slice(0, 6).map((r) => resources.intern(r)),
    e.sensitivityLabels.slice(0, 4).map((l) => labels.intern(l)),
    e.surface ? surfaces.intern(e.surface) : -1,
  ]);

  // Derived from the events actually collected, not from what was configured:
  // a provider that authenticated but returned nothing should not claim the
  // report.
  const present = new Set(shown.map((e) => e.provider));
  const primaryProvider: Payload['meta']['primaryProvider'] =
    present.size === 0
      ? 'none'
      : present.size > 1
        ? 'mixed'
        : present.has('microsoft')
          ? 'microsoft'
          : 'google';

  return {
    meta: {
      generatedAt: meta.generatedAt,
      windowStart: meta.windowStart,
      windowEnd: meta.windowEnd,
      tenantLabel: meta.tenantLabel,
      toolVersion: meta.toolVersion,
      redacted: meta.redacted,
      totalEvents: events.length,
      shownEvents: shown.length,
      primaryProvider,
      providers: meta.results.map((r) => ({
        provider: r.provider,
        label: PROVIDER_LABELS[r.provider] ?? r.provider,
        count: r.events.length,
        truncated: r.truncated,
        warnings: r.warnings,
        error: r.error,
        diagnostics: r.diagnostics,
      })),
    },
    dict: {
      users: users.values,
      apps: apps.values,
      ops: ops.values,
      resources: resources.values,
      labels: labels.values,
      surfaces: surfaces.values,
    },
    rows,
  };
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Serialise for embedding inside a `<script>` element.
 *
 * `<` must be escaped or a resource literally named `</script>` — which an
 * attacker inside the tenant could create on purpose — terminates the block and
 * turns audit data into executable markup. U+2028/2029 are legacy JS line
 * terminators that break older parsers.
 */
function toEmbeddedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Events embedded for client-side filtering. Default 50 000. */
  maxRows?: number;
}

export function renderReport(
  events: PromptEvent[],
  meta: ReportMeta,
  opts: RenderOptions = {},
): string {
  const payload = buildPayload(events, meta, opts.maxRows ?? 50_000);
  const title = `AI Prompt Audit — ${meta.tenantLabel}`;

  return TEMPLATE.replace('/*__PAYLOAD__*/null', () => toEmbeddedJson(payload)).replace(
    /__TITLE__/g,
    () => escapeHtml(title),
  );
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------
//
// Written without template literals in the client-side script so no `${` or
// backtick needs escaping through the TypeScript string. Client code uses
// string concatenation throughout.

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>__TITLE__</title>
<script src="https://cdn.tailwindcss.com/3.4.16"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  /* Palette validated for CVD separation and contrast on both surfaces.
     Light values live on bare :root; dark values are redeclared under both the
     OS media query and the explicit toggle so neither can strand the other. */
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --border: rgba(11, 11, 11, 0.10);
    --series-1: #2a78d6;
    --series-2: #eb6834;
    --series-3: #1baf7a;
    --status-critical: #d03b3b;
    --status-warning: #fab219;
    --status-good: #0ca30c;
    --wash: rgba(42, 120, 214, 0.08);
    /* Sequential blue ramp for the heatmap: one hue, light -> dark. */
    --heat-0: #eeeeea;
    --heat-1: #cde2fb;
    --heat-2: #9ec5f4;
    --heat-3: #6da7ec;
    --heat-4: #3987e5;
    --heat-5: #2a78d6;
    --heat-6: #1c5cab;
    --heat-7: #0d366b;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --grid: #2c2c2a;
      --axis: #383835;
      --border: rgba(255, 255, 255, 0.10);
      --series-1: #3987e5;
      --series-2: #d95926;
      --series-3: #199e70;
      --wash: rgba(57, 135, 229, 0.14);
      /* Dark surface: run the ramp dark -> light so magnitude reads as brightness. */
      --heat-0: #232322;
      --heat-1: #10314f;
      --heat-2: #104281;
      --heat-3: #1c5cab;
      --heat-4: #256abf;
      --heat-5: #3987e5;
      --heat-6: #6da7ec;
      --heat-7: #9ec5f4;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255, 255, 255, 0.10);
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --wash: rgba(57, 135, 229, 0.14);
    --heat-0: #232322;
    --heat-1: #10314f;
    --heat-2: #104281;
    --heat-3: #1c5cab;
    --heat-4: #256abf;
    --heat-5: #3987e5;
    --heat-6: #6da7ec;
    --heat-7: #9ec5f4;
  }

  body {
    background: var(--page);
    color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 14px;
  }
  .ink-2 { color: var(--text-secondary); }
  .ink-3 { color: var(--text-muted); }
  .rule { border-color: var(--border); }
  .field {
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-primary);
    border-radius: 9px;
  }
  .field:focus { outline: 2px solid var(--series-1); outline-offset: 1px; }
  /* Icon-only theme toggle. The 20px icon box matches the 20px line-height of
     the sibling text buttons, so both end up exactly 38px tall. */
  .theme-toggle { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
  .theme-toggle svg { display: block; width: 20px; height: 20px; }
  .theme-toggle:hover { background: var(--wash); }
  /* Show the theme you would switch TO: moon while light, sun while dark.
     Boot always writes an explicit data-theme, so these two rules cover it. */
  .theme-toggle .icon-sun { display: none; }
  :root[data-theme="dark"] .theme-toggle .icon-sun { display: block; }
  :root[data-theme="dark"] .theme-toggle .icon-moon { display: none; }
  /* Tabular figures only where digits stack vertically. Hero numbers keep
     proportional figures so they do not read loose at display size. */
  .tnum { font-variant-numeric: tabular-nums; }
  th[data-sort] { cursor: pointer; user-select: none; }
  th[data-sort]:hover { color: var(--text-primary); }
  tbody tr:hover { background: var(--wash); }
  .chip {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 18px;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .chart-scroll { overflow-x: auto; }
  /* Tailwind's display utilities (.grid, .flex) are emitted after preflight's
     [hidden]{display:none}, so at equal specificity they win and a hidden
     section still paints. Provider gating depends on this holding. */
  [hidden] { display: none !important; }
  .heat-grid { display: grid; grid-template-columns: 34px repeat(24, 1fr); gap: 2px; }
  .heat-cell { aspect-ratio: 1 / 1; border-radius: 3px; min-height: 14px; }
  .heat-rowlabel, .heat-collabel {
    font-size: 10px; color: var(--text-muted); display: flex; align-items: center;
  }
  .heat-collabel { justify-content: center; }
  .heat-swatch { width: 13px; height: 13px; border-radius: 3px; }
  .sens-row { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
  .sens-bar { flex: 1; height: 7px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
  .sens-fill { height: 100%; border-radius: 999px; background: var(--status-critical); }
  @media print {
    .no-print { display: none !important; }
    body { background: #fff; }
  }
</style>
</head>
<body class="min-h-screen">
<div class="mx-auto max-w-[1400px] px-5 py-8 md:px-8">

  <!-- Header -->
  <header class="mb-7 flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">AI Prompt Audit</h1>
      <p class="ink-2 mt-1 text-sm" id="subtitle">&nbsp;</p>
    </div>
    <div class="no-print flex items-center gap-2">
      <button id="exportCsv" class="field px-3 py-2 text-sm font-medium">Export CSV</button>
      <button id="themeToggle" type="button" class="field theme-toggle px-2 py-2" aria-label="Switch to dark theme" title="Switch to dark theme">
        <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
        <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      </button>
    </div>
  </header>

  <div id="banners" class="mb-6 space-y-2"></div>

  <!-- Filters: one row, above everything they scope. -->
  <section class="no-print card mb-6 p-4">
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-[240px] flex-1">
        <label for="q" class="ink-2 mb-1 block text-xs font-medium">Search user, app, activity, or resource</label>
        <input id="q" type="search" placeholder="e.g. finance@, Teams, layoffs.xlsx" class="field w-full px-3 py-2 text-sm" autocomplete="off">
      </div>
      <div id="providerFilterWrap" hidden>
        <label for="providerFilter" class="ink-2 mb-1 block text-xs font-medium">Platform</label>
        <select id="providerFilter" class="field px-3 py-2 text-sm"><option value="">All platforms</option></select>
      </div>
      <div>
        <label for="appFilter" class="ink-2 mb-1 block text-xs font-medium" id="appFilterLabel">App</label>
        <select id="appFilter" class="field px-3 py-2 text-sm"><option value="">All apps</option></select>
      </div>
      <label class="flex cursor-pointer items-center gap-2 px-1 py-2 text-sm" id="labelledWrap" hidden>
        <input type="checkbox" id="labelledFilter" class="h-4 w-4">
        <span>Only labelled content</span>
      </label>
      <button id="resetFilters" class="field px-3 py-2 text-sm font-medium">Reset</button>
    </div>
  </section>

  <!-- KPI tiles: the numbers that are a number, not a chart. -->
  <section class="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4" id="kpis"></section>

  <!-- Charts -->
  <section class="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
    <div class="card p-5 xl:col-span-2">
      <h2 class="text-sm font-semibold">Prompt volume over time</h2>
      <p class="ink-3 mt-0.5 text-xs" id="volumeSub">Interactions per day across the selected window</p>
      <div class="chart-scroll mt-4"><div style="height:300px;min-width:420px"><canvas id="volumeChart"></canvas></div></div>
    </div>
    <div class="card p-5">
      <h2 class="text-sm font-semibold">Top users</h2>
      <p class="ink-3 mt-0.5 text-xs">Ten highest interaction counts</p>
      <div class="chart-scroll mt-4"><div style="height:300px;min-width:280px"><canvas id="usersChart"></canvas></div></div>
    </div>
  </section>

  <!-- When people use it. Off-hours concentration is a security signal, not
       just an adoption one, which is why the stat sits in the caption. -->
  <section class="card mb-4 p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h2 class="text-sm font-semibold">When the assistant is used</h2>
        <p class="ink-3 mt-0.5 text-xs" id="heatSub">Interactions by day and hour (UTC)</p>
      </div>
      <div class="flex items-center gap-2">
        <span class="ink-3 text-xs">Fewer</span>
        <div class="flex gap-[2px]" id="heatLegend"></div>
        <span class="ink-3 text-xs">More</span>
      </div>
    </div>
    <div class="chart-scroll mt-4"><div id="heatmap" style="min-width:560px"></div></div>
  </section>

  <!-- Microsoft-only: the security payload. Copilot names the tenant files it
       grounded each answer on; Google exposes no equivalent. -->
  <section class="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-3" id="groundingSection" hidden>
    <div class="card p-5 xl:col-span-2">
      <h2 class="text-sm font-semibold">Most-read tenant files</h2>
      <p class="ink-3 mt-0.5 text-xs">Documents Copilot opened to answer prompts</p>
      <div class="chart-scroll mt-4"><div style="height:300px;min-width:420px"><canvas id="docsChart"></canvas></div></div>
    </div>
    <div class="card p-5">
      <h2 class="text-sm font-semibold">Sensitivity exposure</h2>
      <p class="ink-3 mt-0.5 text-xs">Classified content reached by the assistant</p>
      <div id="sensitivityPanel" class="mt-4"></div>
    </div>
  </section>

  <section class="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-3" id="breakdownSection">
    <div class="card p-5">
      <h2 class="text-sm font-semibold" id="appsTitle">Apps</h2>
      <p class="ink-3 mt-0.5 text-xs" id="appsSub">Where the assistant was invoked</p>
      <div class="chart-scroll mt-4"><div style="height:280px;min-width:260px"><canvas id="appsChart"></canvas></div></div>
    </div>
    <div class="card p-5" id="opsCard">
      <h2 class="text-sm font-semibold" id="opsTitle">Activity types</h2>
      <p class="ink-3 mt-0.5 text-xs" id="opsSub">What users asked the assistant to do</p>
      <div class="chart-scroll mt-4"><div style="height:280px;min-width:260px"><canvas id="opsChart"></canvas></div></div>
    </div>
    <!-- Google-only: feature_source tells you which UI entry point was used. -->
    <div class="card p-5" id="surfaceCard" hidden>
      <h2 class="text-sm font-semibold">Invocation points</h2>
      <p class="ink-3 mt-0.5 text-xs">Which Gemini entry point users reached for</p>
      <div class="chart-scroll mt-4"><div style="height:280px;min-width:260px"><canvas id="surfaceChart"></canvas></div></div>
    </div>
  </section>

  <!-- Table view: the WCAG-clean twin of every chart above. -->
  <section class="card overflow-hidden">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b p-5 rule">
      <div>
        <h2 class="text-sm font-semibold">Interaction log</h2>
        <p class="ink-3 mt-0.5 text-xs" id="tableCaption">&nbsp;</p>
      </div>
      <div class="no-print flex items-center gap-2">
        <button id="prevPage" class="field px-3 py-1.5 text-sm">Prev</button>
        <span class="ink-2 tnum text-xs" id="pageLabel"></span>
        <button id="nextPage" class="field px-3 py-1.5 text-sm">Next</button>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="ink-2 text-xs uppercase tracking-wide">
          <tr class="border-b rule">
            <th class="px-5 py-3 font-medium" data-sort="0" scope="col">Time (UTC)</th>
            <th class="px-5 py-3 font-medium" data-sort="1" scope="col">User</th>
            <th class="px-5 py-3 font-medium" data-sort="2" scope="col" id="thPlatform">Platform</th>
            <th class="px-5 py-3 font-medium" data-sort="3" scope="col" id="thApp">App</th>
            <th class="px-5 py-3 font-medium" data-sort="4" scope="col">Activity</th>
            <th class="px-5 py-3 font-medium" scope="col" id="thResources">Files read</th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>
  </section>

  <footer class="ink-3 mt-8 space-y-1 text-xs">
    <p id="footerMeta"></p>
    <p>Generated locally. No tenant data left this machine. This file embeds audit records &mdash; treat it with the same handling rules as the audit log itself.</p>
  </footer>
</div>

<script id="audit-payload" type="application/json">/*__PAYLOAD__*/null</script>
<script>
(function () {
  'use strict';

  var PAYLOAD = JSON.parse(document.getElementById('audit-payload').textContent);
  var META = PAYLOAD.meta;
  var DICT = PAYLOAD.dict;
  var ROWS = PAYLOAD.rows;
  var PROVIDERS = ['microsoft', 'google'];
  var PROVIDER_LABELS = ['Microsoft 365 Copilot', 'Google Gemini'];

  var PAGE_SIZE = 50;
  var state = { q: '', provider: '', app: '', labelled: false, sort: 0, dir: -1, page: 0, view: ROWS };
  var MODE = META.primaryProvider;              // microsoft | google | mixed | none
  var SINGLE = MODE === 'microsoft' || MODE === 'google';
  var IS_MS = MODE === 'microsoft';
  var charts = {};

  // ---- helpers ----------------------------------------------------------
  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;'
           : c === '"' ? '&quot;' : '&#39;';
    });
  }
  function num(n) { return n.toLocaleString(); }
  function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function fmtTime(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16); }

  /** Resources and labels are interned; expand on demand. */
  function resourcesOf(r) { return r[6].map(function (i) { return DICT.resources[i]; }); }
  function labelsOf(r) { return r[7].map(function (i) { return DICT.labels[i]; }); }

  function surfaceOf(r) { return r[8] >= 0 ? DICT.surfaces[r[8]] : ''; }

  /**
   * Purview reports sensitivity as a label GUID, not a name. Rather than print
   * a raw GUID at the reader, shorten it and flag it — resolving the display
   * name needs an extra Graph scope this tool deliberately does not request.
   */
  var GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var sawGuidLabel = false;
  function prettyLabel(v) {
    if (GUID_RE.test(v)) { sawGuidLabel = true; return 'Label ' + v.slice(0, 8); }
    return v;
  }

  /** Tally how often each file was read, and by how many distinct people. */
  function resourceUsage(rows) {
    var map = new Map();
    for (var i = 0; i < rows.length; i++) {
      var ids = rows[i][6];
      for (var k = 0; k < ids.length; k++) {
        var entry = map.get(ids[k]);
        if (!entry) { entry = { count: 0, users: new Set() }; map.set(ids[k], entry); }
        entry.count++;
        entry.users.add(rows[i][1]);
      }
    }
    return map;
  }

  function rowText(r) {
    return (DICT.users[r[1]] + ' ' + PROVIDER_LABELS[r[2]] + ' ' + DICT.apps[r[3]] + ' ' +
            DICT.ops[r[4]] + ' ' + r[5] + ' ' + surfaceOf(r) + ' ' +
            resourcesOf(r).join(' ') + ' ' + labelsOf(r).join(' ')).toLowerCase();
  }

  // ---- filtering --------------------------------------------------------
  function applyFilters() {
    var q = state.q.trim().toLowerCase();
    state.view = ROWS.filter(function (r) {
      if (state.provider !== '' && String(r[2]) !== state.provider) return false;
      if (state.app !== '' && DICT.apps[r[3]] !== state.app) return false;
      if (state.labelled && r[7].length === 0) return false;
      if (q !== '' && rowText(r).indexOf(q) === -1) return false;
      return true;
    });
    state.page = 0;
    renderAll();
  }

  // ---- aggregation (recomputed from the current slice) ------------------
  function countBy(rows, keyFn) {
    var map = new Map();
    for (var i = 0; i < rows.length; i++) {
      var k = keyFn(rows[i]);
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  }

  /**
   * Rank and cap.
   *
   * The withOther flag folds the tail into a single bucket so a part-to-whole
   * reading still adds up. It is deliberately OFF for "Top users": with a long
   * tail the Other bar outgrows the actual top user and the chart stops meaning
   * what its title says.
   */
  function topN(map, n, withOther) {
    var entries = Array.from(map.entries()).sort(function (a, b) {
      return b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
    });
    if (entries.length <= n) return entries;
    var head = entries.slice(0, n);
    if (!withOther) return head;
    var rest = entries.slice(n).reduce(function (sum, e) { return sum + e[1]; }, 0);
    head.push(['Other (' + (entries.length - n) + ')', rest]);
    return head;
  }

  /** Whole-day buckets across the window so quiet days render as real zeros. */
  function dailySeries(rows) {
    var start = new Date(META.windowStart);
    var end = new Date(META.windowEnd);
    var labels = [];
    var cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    var last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    var guard = 0;
    while (cursor <= last && guard++ < 400) {
      labels.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    var index = {};
    labels.forEach(function (l, i) { index[l] = i; });

    var series = PROVIDERS.map(function () { return labels.map(function () { return 0; }); });
    for (var i = 0; i < rows.length; i++) {
      var slot = index[dayKey(rows[i][0])];
      if (slot !== undefined) series[rows[i][2]][slot]++;
    }
    return { labels: labels, series: series };
  }

  // ---- KPI tiles --------------------------------------------------------
  function renderKpis(rows) {
    var users = new Set();
    var withResources = 0;
    var labelled = 0;
    var offHours = 0;
    for (var i = 0; i < rows.length; i++) {
      users.add(rows[i][1]);
      if (rows[i][6].length > 0) withResources++;
      if (rows[i][7].length > 0) labelled++;
      var h = new Date(rows[i][0]).getUTCHours();
      var d = new Date(rows[i][0]).getUTCDay();
      if (h < 8 || h >= 18 || d === 0 || d === 6) offHours++;
    }
    var daily = dailySeries(rows);
    var totals = daily.labels.map(function (_, i) {
      return daily.series[0][i] + daily.series[1][i];
    });
    var peak = 0, peakIdx = -1;
    totals.forEach(function (v, i) { if (v > peak) { peak = v; peakIdx = i; } });
    var activeDays = totals.filter(function (v) { return v > 0; }).length;

    // Adoption direction: second half of the window against the first.
    var half = Math.floor(totals.length / 2);
    var first = totals.slice(0, half).reduce(function (a, b) { return a + b; }, 0);
    var second = totals.slice(half).reduce(function (a, b) { return a + b; }, 0);
    var trend = first > 0 ? Math.round(((second - first) / first) * 100) : null;
    var trendText = trend === null ? activeDays + ' active days'
      : (trend >= 0 ? '\u2191 ' : '\u2193 ') + Math.abs(trend) + '% vs first half';

    var offPct = rows.length ? Math.round((offHours / rows.length) * 100) : 0;

    var tiles = [
      { label: 'Interactions', value: num(rows.length), sub: trendText },
      {
        label: 'Active users',
        value: num(users.size),
        sub: users.size ? (rows.length / users.size).toFixed(1) + ' avg per user' : 'no activity'
      },
      {
        label: 'Busiest day',
        value: peakIdx >= 0 ? num(peak) : '0',
        sub: peakIdx >= 0 ? daily.labels[peakIdx] : 'no activity'
      },
      // The fourth tile is the one that differs by platform: Microsoft can say
      // what the assistant read, Google cannot, so it reports timing risk.
      IS_MS
        ? {
            label: 'Read tenant files',
            value: num(withResources),
            sub: labelled > 0
              ? num(labelled) + ' touched classified content'
              : 'none carried a sensitivity label',
            alert: labelled > 0
          }
        : {
            label: 'Outside work hours',
            value: offPct + '%',
            sub: num(offHours) + ' interactions, nights and weekends',
            alert: offPct >= 25
          }
    ];

    document.getElementById('kpis').innerHTML = tiles.map(function (t) {
      return '<div class="card p-5">' +
        '<div class="ink-2 text-xs font-medium">' + esc(t.label) + '</div>' +
        '<div class="mt-1.5 text-3xl font-semibold tracking-tight">' + esc(t.value) + '</div>' +
        '<div class="mt-1 text-xs ' + (t.alert ? '' : 'ink-3') + '"' +
          (t.alert ? ' style="color:var(--status-critical)"' : '') + '>' + esc(t.sub) + '</div>' +
        '</div>';
    }).join('');

    return { offPct: offPct, offHours: offHours };
  }

  // ---- charts -----------------------------------------------------------
  function baseOptions() {
    var muted = css('--text-muted');
    var grid = css('--grid');
    var surface = css('--surface-1');
    var ink = css('--text-primary');
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 220 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: surface,
          titleColor: ink,
          bodyColor: css('--text-secondary'),
          borderColor: css('--border'),
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true
        }
      },
      scales: {
        x: {
          grid: { display: false, drawBorder: false },
          border: { color: css('--axis') },
          ticks: { color: muted, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 }
        },
        y: {
          beginAtZero: true,
          grid: { color: grid, drawBorder: false, lineWidth: 1 },
          border: { display: false },
          ticks: { color: muted, font: { size: 11 }, precision: 0, padding: 6 }
        }
      }
    };
  }

  function destroy(key) {
    if (charts[key]) { charts[key].destroy(); charts[key] = null; }
  }

  function renderVolume(rows) {
    var d = dailySeries(rows);
    var surface = css('--surface-1');
    var slots = [css('--series-1'), css('--series-2')];
    // Only chart a platform that is actually present; a flat zero series is
    // noise, and a lone series needs no legend because the title names it.
    var active = PROVIDERS.map(function (_, i) { return i; }).filter(function (i) {
      return d.series[i].some(function (v) { return v > 0; });
    });
    if (active.length === 0) active = [0];

    var datasets = active.map(function (i) {
      return {
        label: PROVIDER_LABELS[i],
        data: d.series[i],
        // Single-provider reports use slot 1 like every other chart on the
        // page; slot 2 only earns its place when both platforms are compared.
        backgroundColor: active.length > 1 ? slots[i] : css('--series-1'),
        borderColor: surface,
        // 2px surface gap between stacked segments, not a drawn border.
        borderWidth: active.length > 1 ? { top: 2 } : 0,
        borderRadius: 4,
        borderSkipped: false,
        barPercentage: 0.72,
        categoryPercentage: 0.86
      };
    });

    var opts = baseOptions();
    opts.plugins.legend = active.length > 1
      ? { display: true, position: 'top', align: 'end',
          labels: { color: css('--text-secondary'), usePointStyle: true, pointStyle: 'circle', boxWidth: 8, padding: 16, font: { size: 11 } } }
      : { display: false };
    opts.scales.x.stacked = true;
    opts.scales.y.stacked = true;
    opts.scales.x.ticks.callback = function (value) {
      var label = this.getLabelForValue(value);
      return label ? label.slice(5) : label;
    };

    destroy('volume');
    charts.volume = new Chart(document.getElementById('volumeChart'), {
      type: 'bar', data: { labels: d.labels, datasets: datasets }, options: opts
    });
  }

  /**
   * Writes each bar's value just past its end.
   *
   * On a ranked horizontal bar chart the value axis earns nothing: ten
   * gridlines to support ten numbers we can simply print. Dropping the axis and
   * labelling the ends removes a whole layer of chrome and makes the values
   * exact rather than estimated. This is selective labelling, not a number on
   * every point — there is one mark per row.
   */
  var barValueLabels = {
    id: 'barValueLabels',
    afterDatasetsDraw: function (chart, args, cfg) {
      var meta = chart.getDatasetMeta(0);
      var data = chart.data.datasets[0].data;
      var ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = cfg.color;
      ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      meta.data.forEach(function (bar, i) {
        ctx.fillText(Number(data[i]).toLocaleString(), bar.x + 6, bar.y);
      });
      ctx.restore();
    }
  };

  /**
   * Size a horizontal bar chart to its content.
   *
   * A fixed height leaves a two-category chart floating in whitespace and
   * squeezes a ten-category one. 30px per bar tracks the 20px bar plus gap.
   */
  function fitBarHeight(canvasId, count) {
    var box = document.getElementById(canvasId).parentNode;
    box.style.height = Math.max(110, count * 30 + 26) + 'px';
  }

  /** Horizontal bars, one series -> slot 1 for every bar (no value ramp). */
  function renderRanked(key, canvasId, rows, keyFn, limit, withOther) {
    var entries = topN(countBy(rows, keyFn), limit, withOther);
    var opts = baseOptions();
    opts.indexAxis = 'y';
    opts.interaction = { mode: 'nearest', intersect: true };
    // Value axis removed entirely; the direct labels carry the numbers.
    opts.scales.x.display = false;
    opts.scales.y.grid = { display: false, drawBorder: false };
    opts.scales.y.border = { color: css('--axis') };
    opts.scales.y.ticks.callback = function (value) {
      var label = this.getLabelForValue(value);
      return label.length > 26 ? label.slice(0, 25) + '\\u2026' : label;
    };
    // Reserve room so the longest bar's label is never clipped.
    opts.layout = { padding: { right: 52, top: 4, bottom: 4 } };
    opts.plugins.barValueLabels = { color: css('--text-secondary') };
    fitBarHeight(canvasId, entries.length);

    destroy(key);
    charts[key] = new Chart(document.getElementById(canvasId), {
      type: 'bar',
      data: {
        labels: entries.map(function (e) { return e[0]; }),
        datasets: [{
          label: 'Interactions',
          data: entries.map(function (e) { return e[1]; }),
          backgroundColor: css('--series-1'),
          borderRadius: 4,
          borderSkipped: false,
          barThickness: 'flex',
          maxBarThickness: 20,
          categoryPercentage: 0.8
        }]
      },
      options: opts,
      plugins: [barValueLabels]
    });
  }

  // ---- heatmap: weekday x hour ------------------------------------------
  var DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /**
   * A CSS grid, not a chart library: Chart.js has no native matrix type, and
   * 168 coloured divs are lighter and more accessible than a plugin. Every cell
   * carries a title so the value is reachable without colour, and the table
   * view below remains the full WCAG-clean twin.
   */
  function renderHeatmap(rows, offStats) {
    // getUTCDay() is Sunday-first; shift so the week reads Mon..Sun.
    var counts = [];
    for (var d = 0; d < 7; d++) counts.push(new Array(24).fill(0));
    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      var dt = new Date(rows[i][0]);
      var day = (dt.getUTCDay() + 6) % 7;
      var hour = dt.getUTCHours();
      counts[day][hour]++;
      if (counts[day][hour] > max) max = counts[day][hour];
    }

    var html = '<div class="heat-grid">';
    html += '<div></div>';
    for (var h = 0; h < 24; h++) {
      html += '<div class="heat-collabel">' + (h % 3 === 0 ? (h < 10 ? '0' + h : h) : '') + '</div>';
    }
    for (var d2 = 0; d2 < 7; d2++) {
      html += '<div class="heat-rowlabel">' + DAY_NAMES[d2] + '</div>';
      for (var h2 = 0; h2 < 24; h2++) {
        var v = counts[d2][h2];
        // Bucket 1..7 on the observed max; 0 keeps its own neutral step so
        // "no activity" never reads as "a little activity".
        var step = v === 0 ? 0 : Math.max(1, Math.ceil((v / max) * 7));
        html += '<div class="heat-cell" style="background:var(--heat-' + step + ')" title="' +
          DAY_NAMES[d2] + ' ' + (h2 < 10 ? '0' + h2 : h2) + ':00 UTC — ' + v +
          ' interaction' + (v === 1 ? '' : 's') + '"></div>';
      }
    }
    html += '</div>';
    document.getElementById('heatmap').innerHTML = html;

    var legend = '';
    for (var L = 0; L <= 7; L++) legend += '<div class="heat-swatch" style="background:var(--heat-' + L + ')"></div>';
    document.getElementById('heatLegend').innerHTML = legend;

    document.getElementById('heatSub').textContent =
      'Interactions by day and hour (UTC) · ' + offStats.offPct +
      '% fall outside 08:00–18:00 on weekdays';
  }

  // ---- most-read tenant files (Microsoft only) --------------------------
  function renderDocuments(rows) {
    var usage = resourceUsage(rows);
    var entries = Array.from(usage.entries())
      .sort(function (a, b) { return b[1].count - a[1].count; })
      .slice(0, 8);

    var labels = entries.map(function (e) { return DICT.resources[e[0]]; });
    var values = entries.map(function (e) { return e[1].count; });
    var userCounts = entries.map(function (e) { return e[1].users.size; });

    var opts = baseOptions();
    opts.indexAxis = 'y';
    opts.interaction = { mode: 'nearest', intersect: true };
    opts.scales.x.display = false;
    opts.scales.y.grid = { display: false, drawBorder: false };
    opts.scales.y.border = { color: css('--axis') };
    opts.scales.y.ticks.callback = function (value) {
      var label = this.getLabelForValue(value);
      return label.length > 30 ? label.slice(0, 29) + '\u2026' : label;
    };
    opts.layout = { padding: { right: 60, top: 4, bottom: 4 } };
    opts.plugins.barValueLabels = { color: css('--text-secondary') };
    // The "how many people" number matters as much as the raw read count: one
    // person opening a file 40 times is very different from 40 people doing so.
    opts.plugins.tooltip.callbacks = {
      afterLabel: function (ctx) {
        return userCounts[ctx.dataIndex] + ' distinct user' + (userCounts[ctx.dataIndex] === 1 ? '' : 's');
      }
    };

    destroy('docs');
    fitBarHeight('docsChart', entries.length);
    if (entries.length === 0) {
      document.getElementById('docsChart').parentNode.innerHTML =
        '<div class="ink-3 flex h-full items-center justify-center text-center text-xs">' +
        'No grounded files in this slice.</div>';
      return;
    }
    charts.docs = new Chart(document.getElementById('docsChart'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Reads',
          data: values,
          backgroundColor: css('--series-1'),
          borderRadius: 4,
          borderSkipped: false,
          maxBarThickness: 20,
          categoryPercentage: 0.8
        }]
      },
      options: opts,
      plugins: [barValueLabels]
    });
  }

  // ---- sensitivity exposure (Microsoft only) ----------------------------
  function renderSensitivity(rows) {
    var grounded = 0, labelled = 0;
    var byLabel = new Map();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][6].length > 0) grounded++;
      var ids = rows[i][7];
      if (ids.length === 0) continue;
      labelled++;
      for (var k = 0; k < ids.length; k++) {
        var name = prettyLabel(DICT.labels[ids[k]]);
        byLabel.set(name, (byLabel.get(name) || 0) + 1);
      }
    }

    var pct = grounded ? Math.round((labelled / grounded) * 100) : 0;
    var top = Array.from(byLabel.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
    var maxVal = top.length ? top[0][1] : 1;

    var html =
      '<div class="text-3xl font-semibold tracking-tight" style="color:' +
      (labelled > 0 ? 'var(--status-critical)' : 'inherit') + '">' + pct + '%</div>' +
      '<div class="ink-3 mb-4 mt-1 text-xs">of grounded interactions touched labelled content</div>';

    if (top.length === 0) {
      html += '<div class="ink-3 text-xs">No sensitivity labels seen on any file the assistant read. ' +
        'That can mean the content is genuinely unclassified, or that labelling is not deployed.</div>';
    } else {
      html += top.map(function (e) {
        return '<div class="sens-row">' +
          '<span class="text-xs" style="min-width:96px">' + esc(e[0]) + '</span>' +
          '<span class="sens-bar"><span class="sens-fill" style="width:' +
            Math.max(4, Math.round((e[1] / maxVal) * 100)) + '%"></span></span>' +
          '<span class="tnum ink-2 text-xs">' + num(e[1]) + '</span>' +
          '</div>';
      }).join('');
      if (sawGuidLabel) {
        html += '<div class="ink-3 mt-3 text-xs">Purview reports labels as GUIDs. ' +
          'Resolving display names needs an additional Graph permission this tool does not request.</div>';
      }
    }
    document.getElementById('sensitivityPanel').innerHTML = html;
  }

  // ---- table ------------------------------------------------------------
  function sortedView() {
    var s = state.sort, dir = state.dir;
    var accessor = s === 0
      ? function (r) { return r[0]; }
      : s === 1 ? function (r) { return DICT.users[r[1]]; }
      : s === 2 ? function (r) { return PROVIDER_LABELS[r[2]]; }
      : s === 3 ? function (r) { return DICT.apps[r[3]]; }
      : function (r) { return DICT.ops[r[4]]; };
    return state.view.slice().sort(function (a, b) {
      var av = accessor(a), bv = accessor(b);
      if (av === bv) return b[0] - a[0];
      return (av > bv ? 1 : -1) * dir;
    });
  }

  function renderTable() {
    var rows = sortedView();
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.page >= pages) state.page = pages - 1;
    var slice = rows.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);

    document.getElementById('tableBody').innerHTML = slice.length === 0
      ? '<tr><td colspan="' + (SINGLE ? 5 : 6) + '" class="ink-3 px-5 py-10 text-center">No interactions match these filters.</td></tr>'
      : slice.map(function (r) {
          var last;
          if (MODE === 'google') {
            var sfc = surfaceOf(r);
            last = sfc ? '<span class="chip">' + esc(sfc) + '</span>' : '<span class="ink-3">&mdash;</span>';
          } else {
            var resources = resourcesOf(r);
            var extra = resources.length > 3
              ? ' <span class="ink-3">+' + (resources.length - 3) + ' more</span>' : '';
            var cells = resources.slice(0, 3).map(function (x) {
              return '<span class="chip">' + esc(x) + '</span>';
            }).join(' ');
            var labels = labelsOf(r).map(function (x) {
              return '<span class="chip" style="border-color:var(--status-critical);color:var(--status-critical)">' +
                esc(prettyLabel(x)) + '</span>';
            }).join(' ');
            last = (cells || labels) ? cells + ' ' + labels + extra : '<span class="ink-3">&mdash;</span>';
          }
          return '<tr class="border-b rule align-top">' +
            '<td class="tnum whitespace-nowrap px-5 py-3 ink-2">' + esc(fmtTime(r[0])) + '</td>' +
            '<td class="px-5 py-3 font-medium">' + esc(DICT.users[r[1]]) + '</td>' +
            (SINGLE ? '' :
              '<td class="px-5 py-3"><span class="chip" style="border-color:' +
              (r[2] === 0 ? 'var(--series-1);color:var(--series-1)' : 'var(--series-2);color:var(--series-2)') +
              '">' + esc(PROVIDER_LABELS[r[2]]) + '</span></td>') +
            '<td class="px-5 py-3 ink-2">' + esc(DICT.apps[r[3]]) + '</td>' +
            '<td class="px-5 py-3 ink-2">' + esc(DICT.ops[r[4]]) + '</td>' +
            '<td class="px-5 py-3">' + last + '</td>' +
            '</tr>';
        }).join('');

    document.getElementById('pageLabel').textContent = (state.page + 1) + ' / ' + pages;
    document.getElementById('tableCaption').textContent =
      num(rows.length) + ' interaction' + (rows.length === 1 ? '' : 's') +
      (rows.length !== ROWS.length ? ' (filtered from ' + num(ROWS.length) + ')' : '');
    document.getElementById('prevPage').disabled = state.page === 0;
    document.getElementById('nextPage').disabled = state.page >= pages - 1;
  }

  // ---- shell ------------------------------------------------------------
  function renderBanners() {
    var out = [];
    function banner(color, title, body) {
      return '<div class="card p-4 text-sm" style="border-color:' + color + '">' +
        '<span class="font-semibold" style="color:' + color + '">' + esc(title) + '</span> ' +
        '<span class="ink-2">' + esc(body) + '</span></div>';
    }
    META.providers.forEach(function (p) {
      if (p.error) out.push(banner('var(--status-critical)', p.label + ' failed.', p.error));
      (p.warnings || []).forEach(function (w) {
        out.push(banner('var(--status-warning)', p.label + ':', w));
      });
      if (p.truncated) {
        out.push(banner('var(--status-warning)', p.label + ':',
          'Collection stopped at the --max-records cap, so this window is incomplete.'));
      }
    });
    if (META.shownEvents < META.totalEvents) {
      out.push(banner('var(--status-warning)', 'Large dataset.',
        'Charting the most recent ' + num(META.shownEvents) + ' of ' + num(META.totalEvents) +
        ' interactions. Narrow the window with --days for a complete view.'));
    }
    if (META.redacted) {
      out.push(banner('var(--series-1)', 'Pseudonymised.',
        'User identities were replaced with per-run aliases and IPs dropped. The mapping was not saved.'));
    }
    document.getElementById('banners').innerHTML = out.join('');
  }

  function renderChrome() {
    var counts = META.providers.map(function (p) { return p.label + ' ' + num(p.count); }).join('  ·  ');
    document.getElementById('subtitle').textContent =
      META.windowStart.slice(0, 10) + ' to ' + META.windowEnd.slice(0, 10) +
      '  ·  ' + META.tenantLabel + (counts ? '  ·  ' + counts : '');
    document.getElementById('footerMeta').textContent =
      'ai-audit-lens v' + META.toolVersion + '  ·  generated ' + META.generatedAt.replace('T', ' ').slice(0, 19) + ' UTC';
  }

  /**
   * Retune the page for the platform in play.
   *
   * A tenant runs one assistant, so the provider dimension is noise: the split
   * chart, the Platform column, and the Platform filter all collapse, and the
   * vocabulary switches to the terms that platform's admins actually use.
   */
  function applyProviderChrome() {
    var groundingSection = document.getElementById('groundingSection');
    var surfaceCard = document.getElementById('surfaceCard');
    var providerWrap = document.getElementById('providerFilterWrap');
    var labelledWrap = document.getElementById('labelledWrap');
    var thPlatform = document.getElementById('thPlatform');
    var thResources = document.getElementById('thResources');

    // Platform column and filter only earn their space in a mixed tenant.
    providerWrap.hidden = SINGLE;
    if (thPlatform) thPlatform.hidden = SINGLE;

    groundingSection.hidden = !IS_MS;
    labelledWrap.hidden = !IS_MS;
    surfaceCard.hidden = MODE !== 'google';
    // With the Gemini-only card hidden, a 3-column grid leaves a dead slot.
    if (MODE !== 'google') {
      var breakdown = document.getElementById('breakdownSection');
      breakdown.classList.remove('xl:grid-cols-3');
      breakdown.classList.add('xl:grid-cols-2');
    }

    if (IS_MS) {
      document.getElementById('appsTitle').textContent = 'Copilot surfaces';
      document.getElementById('appsSub').textContent = 'Which app Copilot was used from';
      document.getElementById('opsTitle').textContent = 'Interaction types';
      document.getElementById('opsSub').textContent = 'Chat versus agent-driven activity';
      document.getElementById('appFilterLabel').textContent = 'Surface';
      thResources.textContent = 'Files read';
      document.getElementById('thApp').textContent = 'Surface';
      document.getElementById('volumeSub').textContent =
        'Copilot interactions per day across the selected window';
    } else if (MODE === 'google') {
      document.getElementById('appsTitle').textContent = 'Workspace apps';
      document.getElementById('appsSub').textContent = 'Which app Gemini was used from';
      document.getElementById('opsTitle').textContent = 'Actions requested';
      document.getElementById('opsSub').textContent = 'What users asked Gemini to do';
      document.getElementById('appFilterLabel').textContent = 'App';
      // Google exposes no grounded-resource data, so the column would be an
      // empty promise. Repurpose it for the invocation point instead.
      thResources.textContent = 'Invoked from';
      document.getElementById('thApp').textContent = 'App';
      document.getElementById('volumeSub').textContent =
        'Gemini interactions per day across the selected window';
    }
  }

  function populateFilters() {
    var providerSelect = document.getElementById('providerFilter');
    var present = new Set(ROWS.map(function (r) { return r[2]; }));
    PROVIDERS.forEach(function (_, i) {
      if (!present.has(i)) return;
      var o = document.createElement('option');
      o.value = String(i); o.textContent = PROVIDER_LABELS[i];
      providerSelect.appendChild(o);
    });

    var appSelect = document.getElementById('appFilter');
    Array.from(countBy(ROWS, function (r) { return DICT.apps[r[3]]; }).entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .forEach(function (e) {
        var o = document.createElement('option');
        o.value = e[0]; o.textContent = e[0] + ' (' + num(e[1]) + ')';
        appSelect.appendChild(o);
      });
  }

  /**
   * Replace each canvas with a note when Chart.js could not be fetched.
   *
   * Opened on an air-gapped machine the CDN tags fail, and an unguarded
   * "new Chart(...)" would throw before the table ever rendered — losing the
   * numbers along with the pictures. The table view is the WCAG-clean twin of
   * every chart, so it is the half that must survive.
   */
  function degradeCharts() {
    ['volumeChart', 'usersChart', 'appsChart', 'opsChart'].forEach(function (id) {
      var canvas = document.getElementById(id);
      if (!canvas || !canvas.parentNode) return;
      var note = document.createElement('div');
      note.className = 'ink-3 flex h-full items-center justify-center text-center text-xs';
      note.textContent = 'Charts need Chart.js, which could not be loaded offline. Every value is in the table below.';
      canvas.parentNode.replaceChild(note, canvas);
    });
  }

  var chartsAvailable = typeof Chart !== 'undefined';

  function renderAll() {
    var offStats = renderKpis(state.view);
    renderHeatmap(state.view, offStats);
    if (chartsAvailable) {
      renderVolume(state.view);
      renderRanked('users', 'usersChart', state.view, function (r) { return DICT.users[r[1]]; }, 10, false);
      renderRanked('apps', 'appsChart', state.view, function (r) { return DICT.apps[r[3]]; }, 8, true);
      renderRanked('ops', 'opsChart', state.view, function (r) { return DICT.ops[r[4]]; }, 8, true);
      if (IS_MS) {
        renderDocuments(state.view);
      } else if (MODE === 'google') {
        renderRanked('surface', 'surfaceChart', state.view, surfaceOf, 8, true);
      }
    }
    if (IS_MS) renderSensitivity(state.view);
    renderTable();
  }

  // ---- theme ------------------------------------------------------------
  function currentTheme() {
    var stored = null;
    try { stored = localStorage.getItem('ai-audit-lens-theme'); } catch (e) {}
    if (stored === 'dark' || stored === 'light') return stored;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeLabel() {
    var btn = document.getElementById('themeToggle');
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    btn.setAttribute('title', 'Switch to ' + next + ' theme');
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    syncThemeLabel();
    try { localStorage.setItem('ai-audit-lens-theme', theme); } catch (e) {}
    // Chart.js bakes colours in at construction; re-create on theme change.
    renderAll();
  }

  // ---- CSV export (client-side only; nothing is uploaded) ---------------
  function exportCsv() {
    var head = ['timestamp_utc', 'user', 'platform', 'surface', 'activity', 'client_ip', 'resources', 'sensitivity_labels'];
    var lines = [head.join(',')];
    var rows = sortedView();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        new Date(r[0]).toISOString(), DICT.users[r[1]], PROVIDER_LABELS[r[2]],
        DICT.apps[r[3]], DICT.ops[r[4]], r[5], resourcesOf(r).join('; '), labelsOf(r).join('; ')
      ].map(csvCell).join(','));
    }
    var blob = new Blob([lines.join('\\r\\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ai-prompt-audit-' + META.generatedAt.slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /** Neutralise leading =, +, -, @ so Excel cannot treat a cell as a formula. */
  function csvCell(value) {
    var s = String(value == null ? '' : value);
    if (/^[=+\\-@\\t\\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  // ---- wiring -----------------------------------------------------------
  var debounce;
  document.getElementById('q').addEventListener('input', function (e) {
    clearTimeout(debounce);
    var value = e.target.value;
    debounce = setTimeout(function () { state.q = value; applyFilters(); }, 160);
  });
  document.getElementById('providerFilter').addEventListener('change', function (e) {
    state.provider = e.target.value; applyFilters();
  });
  document.getElementById('appFilter').addEventListener('change', function (e) {
    state.app = e.target.value; applyFilters();
  });
  document.getElementById('labelledFilter').addEventListener('change', function (e) {
    state.labelled = e.target.checked; applyFilters();
  });
  document.getElementById('resetFilters').addEventListener('click', function () {
    state.q = ''; state.provider = ''; state.app = ''; state.labelled = false;
    document.getElementById('labelledFilter').checked = false;
    document.getElementById('q').value = '';
    document.getElementById('providerFilter').value = '';
    document.getElementById('appFilter').value = '';
    applyFilters();
  });
  document.getElementById('prevPage').addEventListener('click', function () {
    if (state.page > 0) { state.page--; renderTable(); }
  });
  document.getElementById('nextPage').addEventListener('click', function () {
    state.page++; renderTable();
  });
  Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      var col = Number(th.getAttribute('data-sort'));
      if (state.sort === col) { state.dir = -state.dir; } else { state.sort = col; state.dir = col === 0 ? -1 : 1; }
      renderTable();
    });
  });
  document.getElementById('exportCsv').addEventListener('click', exportCsv);
  document.getElementById('themeToggle').addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // ---- boot -------------------------------------------------------------
  document.documentElement.setAttribute('data-theme', currentTheme());
  syncThemeLabel();
  if (!chartsAvailable) degradeCharts();
  applyProviderChrome();
  renderChrome();
  renderBanners();
  populateFilters();
  applyFilters();
})();
</script>
</body>
</html>
`;
