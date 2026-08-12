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
  dict: { users: string[]; apps: string[]; ops: string[] };
  /** [timestampMs, userIdx, providerIdx, appIdx, opIdx, ip, resources, labels] */
  rows: Array<[number, number, number, number, number, string, string[], string[]]>;
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
    e.accessedResources.slice(0, 6),
    e.sensitivityLabels.slice(0, 4),
  ]);

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
    dict: { users: users.values, apps: apps.values, ops: ops.values },
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
      <button id="themeToggle" class="field px-3 py-2 text-sm font-medium" aria-label="Toggle colour theme">Theme</button>
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
      <div>
        <label for="providerFilter" class="ink-2 mb-1 block text-xs font-medium">Platform</label>
        <select id="providerFilter" class="field px-3 py-2 text-sm"><option value="">All platforms</option></select>
      </div>
      <div>
        <label for="appFilter" class="ink-2 mb-1 block text-xs font-medium">Surface</label>
        <select id="appFilter" class="field px-3 py-2 text-sm"><option value="">All surfaces</option></select>
      </div>
      <button id="resetFilters" class="field px-3 py-2 text-sm font-medium">Reset</button>
    </div>
  </section>

  <!-- KPI tiles: the numbers that are a number, not a chart. -->
  <section class="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4" id="kpis"></section>

  <!-- Charts -->
  <section class="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
    <div class="card p-5 xl:col-span-2">
      <h2 class="text-sm font-semibold">Prompt volume over time</h2>
      <p class="ink-3 mt-0.5 text-xs">Interactions per day across the selected window</p>
      <div class="chart-scroll mt-4"><div style="height:300px;min-width:420px"><canvas id="volumeChart"></canvas></div></div>
    </div>
    <div class="card p-5">
      <h2 class="text-sm font-semibold">Top users</h2>
      <p class="ink-3 mt-0.5 text-xs">Ten highest interaction counts</p>
      <div class="chart-scroll mt-4"><div style="height:300px;min-width:280px"><canvas id="usersChart"></canvas></div></div>
    </div>
  </section>

  <section class="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
    <div class="card p-5">
      <h2 class="text-sm font-semibold">Surfaces</h2>
      <p class="ink-3 mt-0.5 text-xs">Where the assistant was invoked</p>
      <div class="chart-scroll mt-4"><div style="height:280px;min-width:280px"><canvas id="appsChart"></canvas></div></div>
    </div>
    <div class="card p-5 xl:col-span-2">
      <h2 class="text-sm font-semibold">Activity types</h2>
      <p class="ink-3 mt-0.5 text-xs">What users asked the assistant to do</p>
      <div class="chart-scroll mt-4"><div style="height:280px;min-width:420px"><canvas id="opsChart"></canvas></div></div>
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
            <th class="px-5 py-3 font-medium" data-sort="2" scope="col">Platform</th>
            <th class="px-5 py-3 font-medium" data-sort="3" scope="col">Surface</th>
            <th class="px-5 py-3 font-medium" data-sort="4" scope="col">Activity</th>
            <th class="px-5 py-3 font-medium" scope="col">Resources touched</th>
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
  var state = { q: '', provider: '', app: '', sort: 0, dir: -1, page: 0, view: ROWS };
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

  function rowText(r) {
    return (DICT.users[r[1]] + ' ' + PROVIDER_LABELS[r[2]] + ' ' + DICT.apps[r[3]] + ' ' +
            DICT.ops[r[4]] + ' ' + r[5] + ' ' + r[6].join(' ') + ' ' + r[7].join(' ')).toLowerCase();
  }

  // ---- filtering --------------------------------------------------------
  function applyFilters() {
    var q = state.q.trim().toLowerCase();
    state.view = ROWS.filter(function (r) {
      if (state.provider !== '' && String(r[2]) !== state.provider) return false;
      if (state.app !== '' && DICT.apps[r[3]] !== state.app) return false;
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
    for (var i = 0; i < rows.length; i++) {
      users.add(rows[i][1]);
      if (rows[i][6].length > 0) withResources++;
      if (rows[i][7].length > 0) labelled++;
    }
    var daily = dailySeries(rows);
    var totals = daily.labels.map(function (_, i) {
      return daily.series[0][i] + daily.series[1][i];
    });
    var peak = 0, peakIdx = -1;
    totals.forEach(function (v, i) { if (v > peak) { peak = v; peakIdx = i; } });
    var activeDays = totals.filter(function (v) { return v > 0; }).length;

    var tiles = [
      { label: 'Interactions', value: num(rows.length), sub: activeDays + ' active day' + (activeDays === 1 ? '' : 's') },
      { label: 'Active users', value: num(users.size), sub: users.size ? (rows.length / users.size).toFixed(1) + ' avg per user' : 'no activity' },
      { label: 'Busiest day', value: peakIdx >= 0 ? num(peak) : '0', sub: peakIdx >= 0 ? daily.labels[peakIdx] : 'no activity' },
      {
        label: 'Grounded on tenant data',
        value: num(withResources),
        sub: labelled > 0 ? num(labelled) + ' touched labelled content' : 'no sensitivity labels seen',
        alert: labelled > 0
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
        backgroundColor: slots[i],
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
      ? '<tr><td colspan="6" class="ink-3 px-5 py-10 text-center">No interactions match these filters.</td></tr>'
      : slice.map(function (r) {
          var resources = r[6];
          var extra = '';
          if (resources.length > 3) extra = ' <span class="ink-3">+' + (resources.length - 3) + ' more</span>';
          var cells = resources.slice(0, 3).map(function (x) {
            return '<span class="chip">' + esc(x) + '</span>';
          }).join(' ');
          var labels = r[7].map(function (x) {
            return '<span class="chip" style="border-color:var(--status-critical);color:var(--status-critical)">' + esc(x) + '</span>';
          }).join(' ');
          return '<tr class="border-b rule align-top">' +
            '<td class="tnum whitespace-nowrap px-5 py-3 ink-2">' + esc(fmtTime(r[0])) + '</td>' +
            '<td class="px-5 py-3 font-medium">' + esc(DICT.users[r[1]]) + '</td>' +
            '<td class="px-5 py-3"><span class="chip" style="border-color:' +
              (r[2] === 0 ? 'var(--series-1);color:var(--series-1)' : 'var(--series-2);color:var(--series-2)') +
              '">' + esc(PROVIDER_LABELS[r[2]]) + '</span></td>' +
            '<td class="px-5 py-3 ink-2">' + esc(DICT.apps[r[3]]) + '</td>' +
            '<td class="px-5 py-3 ink-2">' + esc(DICT.ops[r[4]]) + '</td>' +
            '<td class="px-5 py-3">' + (cells || labels ? cells + ' ' + labels + extra : '<span class="ink-3">&mdash;</span>') + '</td>' +
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
    renderKpis(state.view);
    if (chartsAvailable) {
      renderVolume(state.view);
      renderRanked('users', 'usersChart', state.view, function (r) { return DICT.users[r[1]]; }, 10, false);
      renderRanked('apps', 'appsChart', state.view, function (r) { return DICT.apps[r[3]]; }, 8, true);
      renderRanked('ops', 'opsChart', state.view, function (r) { return DICT.ops[r[4]]; }, 8, true);
    }
    renderTable();
  }

  // ---- theme ------------------------------------------------------------
  function currentTheme() {
    var stored = null;
    try { stored = localStorage.getItem('ai-audit-lens-theme'); } catch (e) {}
    if (stored === 'dark' || stored === 'light') return stored;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
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
        DICT.apps[r[3]], DICT.ops[r[4]], r[5], r[6].join('; '), r[7].join('; ')
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
  document.getElementById('resetFilters').addEventListener('click', function () {
    state.q = ''; state.provider = ''; state.app = '';
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
  if (!chartsAvailable) degradeCharts();
  renderChrome();
  renderBanners();
  populateFilters();
  applyFilters();
})();
</script>
</body>
</html>
`;
