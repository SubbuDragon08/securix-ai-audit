/**
 * Renderer logic.
 *
 * Runs fully sandboxed: no Node, no `require`, and a CSP with `connect-src
 * 'none'` so this file could not make a network request even if it tried. Every
 * capability it has arrives through `window.auditApi` (see electron/preload.ts),
 * and the main process re-validates each call regardless of what is sent here.
 *
 * All DOM writes go through textContent rather than innerHTML — provider error
 * strings pass through this layer, and they are attacker-influenceable in
 * principle (a resource name in a tenant, an OAuth error_description).
 */

'use strict';

/* Wrapped in an IIFE: this loads as a classic script, so top-level `let`/`const`
   would otherwise live on the shared global lexical scope and collide with any
   other script on the page. */
(function () {

const api = window.auditApi;

const el = (id) => document.getElementById(id);

const dom = {
  setupNotice: el('setupNotice'),
  tagline: el('tagline'),
  aboutBtn: el('aboutBtn'),
  aboutDialog: el('aboutDialog'),
  aboutVersion: el('aboutVersion'),
  aboutPath: el('aboutPath'),

  msCard: el('msCard'),
  msPill: el('msPill'),
  msNote: el('msNote'),
  msConnect: el('msConnect'),
  msDisconnect: el('msDisconnect'),
  msError: el('msError'),

  gCard: el('gCard'),
  gPill: el('gPill'),
  gConnect: el('gConnect'),
  gDisconnect: el('gDisconnect'),
  gError: el('gError'),
  gSetup: el('gSetup'),
  gClientId: el('gClientId'),
  gClientSecret: el('gClientSecret'),

  daysSelect: el('daysSelect'),
  pseudoCheck: el('pseudoCheck'),
  stayCheck: el('stayCheck'),
  stayNote: el('stayNote'),
  runBtn: el('runBtn'),
  demoBtn: el('demoBtn'),
  runHint: el('runHint'),

  connectStep: el('connectStep'),
  runStep: el('runStep'),
  progressStep: el('progressStep'),
  progressTitle: el('progressTitle'),
  progressDetail: el('progressDetail'),
  purviewNotice: el('purviewNotice'),
  cancelBtn: el('cancelBtn'),
  console: el('console'),

  resultStep: el('resultStep'),
  resultBadge: el('resultBadge'),
  resultTitle: el('resultTitle'),
  resultSummary: el('resultSummary'),
  resultWarn: el('resultWarn'),
  resultPath: el('resultPath'),
  openBtn: el('openBtn'),
  saveAsBtn: el('saveAsBtn'),
  folderBtn: el('folderBtn'),
  againBtn: el('againBtn'),

  // Tabs
  tabBtnAudit: el('tabBtnAudit'),
  tabBtnScanner: el('tabBtnScanner'),
  scanTabCount: el('scanTabCount'),
  panelAudit: el('tab-audit'),
  panelScanner: el('tab-scanner'),

  // Scanner
  scanRunStep: el('scanRunStep'),
  scanBtn: el('scanBtn'),
  scanDemoBtn: el('scanDemoBtn'),
  scanProgressStep: el('scanProgressStep'),
  scanProgressTitle: el('scanProgressTitle'),
  scanProgressDetail: el('scanProgressDetail'),
  scanCancelBtn: el('scanCancelBtn'),
  scanConsole: el('scanConsole'),
  scanResultStep: el('scanResultStep'),
  scanHeadline: el('scanHeadline'),
  sevRow: el('sevRow'),
  findings: el('findings'),
  scanAgainBtn: el('scanAgainBtn'),
};

let state = null;
let lastReportPath = null;

// Progress from the shared log sink is routed to whichever console is active —
// the audit run or the scanner run — since both stream over the same channel.
const auditLog = { console: dom.console, title: dom.progressTitle, detail: dom.progressDetail, purview: dom.purviewNotice };
const scanLog = { console: dom.scanConsole, title: dom.scanProgressTitle, detail: dom.scanProgressDetail, purview: null };
let activeLog = auditLog;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (!state) return;

  dom.tagline.textContent = state.brand.tagline;
  dom.setupNotice.hidden = state.entraConfigured;

  // Microsoft card
  const ms = state.microsoft;
  dom.msPill.textContent = ms.connected ? 'Connected' : 'Not connected';
  dom.msPill.classList.toggle('on', ms.connected);
  dom.msCard.classList.toggle('connected', ms.connected);
  dom.msConnect.textContent = ms.connected ? 'Reconnect' : 'Connect Microsoft 365';
  dom.msDisconnect.hidden = !ms.connected;
  dom.msConnect.disabled = !state.entraConfigured;
  if (ms.connected && ms.account) {
    dom.msNote.textContent = 'Signed in as ' + ms.account;
  } else {
    dom.msNote.textContent =
      'Requires an account with Audit Reader, Audit Manager, or Global Reader.';
  }

  // Settings first: the Google card's enabled state is derived from the client
  // id field, so populating the inputs has to happen before we read them.
  // Computing `disabled` off an unpopulated input left Connect permanently
  // greyed out for anyone returning with a saved client id.
  dom.daysSelect.value = String(state.settings.days);
  dom.pseudoCheck.checked = state.settings.pseudonymize;

  // "Stay signed in" is only offered when the OS can genuinely encrypt the
  // token. On Linux without a keyring it is disabled with the reason shown,
  // rather than silently doing nothing.
  const secure = state.secureStorage || { available: true };
  dom.stayCheck.checked = state.settings.staySignedIn && secure.available;
  dom.stayCheck.disabled = !secure.available;
  dom.stayNote.textContent = secure.available
    ? 'Store the refresh token in your OS keychain. Off means it dies when you quit.'
    : secure.reason;
  // Never clobber a field mid-edit.
  if (document.activeElement !== dom.gClientId) {
    dom.gClientId.value = state.settings.googleClientId;
  }
  if (document.activeElement !== dom.gClientSecret) {
    dom.gClientSecret.value = state.settings.googleClientSecret;
  }

  // Google card
  const g = state.google;
  dom.gPill.textContent = g.connected ? 'Connected' : 'Not connected';
  dom.gPill.classList.toggle('on', g.connected);
  dom.gCard.classList.toggle('connected', g.connected);
  dom.gConnect.textContent = g.connected ? 'Reconnect' : 'Connect Google Workspace';
  dom.gDisconnect.hidden = !g.connected;
  dom.gConnect.disabled = !dom.gClientId.value.trim();

  // Keep the setup panel open until it is actually filled in.
  if (!state.settings.googleClientId && !g.connected) dom.gSetup.open = true;

  const ready = ms.connected || g.connected;
  dom.runBtn.disabled = !ready;
  dom.runHint.textContent = ready
    ? 'Reports are written to your Documents folder.'
    : 'Connect a platform above to continue.';

  dom.aboutVersion.textContent =
    state.brand.appName + ' v' + state.version + ' · ' + state.brand.vendor;
}

function showError(node, message) {
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

let progressLine = null;

function appendLog(entry) {
  const t = activeLog;
  // Progress ticks replace their own line instead of stacking hundreds of
  // near-identical rows.
  if (entry.level === 'progress') {
    if (!progressLine) {
      progressLine = document.createElement('span');
      progressLine.className = 'l-progress';
      t.console.appendChild(progressLine);
      t.console.appendChild(document.createTextNode('\n'));
    }
    progressLine.textContent = entry.message;
    t.detail.textContent = entry.message;
    t.console.scrollTop = t.console.scrollHeight;
    return;
  }

  progressLine = null;

  const span = document.createElement('span');
  span.className = 'l-' + entry.level;
  span.textContent = entry.message;
  t.console.appendChild(span);
  t.console.appendChild(document.createTextNode('\n'));
  t.console.scrollTop = t.console.scrollHeight;

  if (entry.level === 'step') {
    t.title.textContent = entry.message;
    t.detail.textContent = 'Working…';
  }
  if (entry.level === 'info' || entry.level === 'ok') {
    t.detail.textContent = entry.message;
  }
  // The Purview wait is the one place people assume the app has frozen.
  if (t.purview && /Purview query created/i.test(entry.message)) {
    t.purview.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function saveSettings() {
  state = await api.saveSettings({
    days: Number(dom.daysSelect.value),
    pseudonymize: dom.pseudoCheck.checked,
    staySignedIn: dom.stayCheck.checked,
    googleClientId: dom.gClientId.value,
    googleClientSecret: dom.gClientSecret.value,
  });
  render();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function connect(provider) {
  const button = provider === 'microsoft' ? dom.msConnect : dom.gConnect;
  const errorNode = provider === 'microsoft' ? dom.msError : dom.gError;
  const original = button.textContent;

  await saveSettings();
  showError(errorNode, null);
  button.disabled = true;
  button.textContent = 'Waiting for browser…';

  try {
    const result = await api.connect(provider);
    state = result.state;
    if (!result.ok) showError(errorNode, result.error);
  } catch (err) {
    showError(errorNode, String(err && err.message ? err.message : err));
  } finally {
    button.textContent = original;
    render();
  }
}

function setPhase(phase) {
  dom.connectStep.hidden = phase !== 'idle';
  dom.runStep.hidden = phase !== 'idle';
  dom.progressStep.hidden = phase !== 'running';
  dom.resultStep.hidden = phase !== 'done';
}

async function run(demo) {
  await saveSettings();

  activeLog = auditLog;
  dom.console.textContent = '';
  progressLine = null;
  dom.purviewNotice.hidden = true;
  dom.progressTitle.textContent = demo ? 'Building sample report' : 'Collecting audit logs';
  dom.progressDetail.textContent = 'Starting…';
  setPhase('running');

  const providers = [];
  if (state.microsoft.connected) providers.push('microsoft');
  if (state.google.connected) providers.push('google');

  let result;
  try {
    result = await api.run({ providers, demo: demo === true });
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }

  if (result.state) state = result.state;

  if (!result.ok) {
    if (result.cancelled) {
      setPhase('idle');
      render();
      return;
    }
    dom.resultBadge.textContent = '!';
    dom.resultBadge.classList.add('bad');
    dom.resultTitle.textContent = 'Could not finish';
    dom.resultSummary.textContent = result.error || 'Unknown error.';
    dom.resultPath.textContent = '';
    showError(dom.resultWarn, null);
    dom.openBtn.hidden = true;
    dom.saveAsBtn.hidden = true;
    dom.folderBtn.hidden = true;
    setPhase('done');
    return;
  }

  lastReportPath = result.outPath;
  dom.resultBadge.textContent = '✓';
  dom.resultBadge.classList.remove('bad');
  dom.openBtn.hidden = false;
  dom.saveAsBtn.hidden = false;
  dom.folderBtn.hidden = false;
  dom.resultTitle.textContent = demo ? 'Sample report ready' : 'Report ready';
  dom.resultSummary.textContent =
    result.totalEvents.toLocaleString() +
    ' interactions · ' +
    result.uniqueUsers +
    ' users · ' +
    result.elapsedSeconds +
    's';
  dom.resultPath.textContent = result.outPath;

  // A provider that failed is not a silent condition — say which and why.
  const errors = result.providerErrors || [];
  if (errors.length > 0) {
    dom.resultWarn.textContent =
      errors.map((e) => e.provider + ': ' + e.error).join('\n\n');
    dom.resultWarn.hidden = false;
  } else {
    dom.resultWarn.hidden = true;
  }

  setPhase('done');
  render();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

dom.msConnect.addEventListener('click', () => connect('microsoft'));
dom.gConnect.addEventListener('click', () => connect('google'));

dom.msDisconnect.addEventListener('click', async () => {
  state = await api.disconnect();
  render();
});
dom.gDisconnect.addEventListener('click', async () => {
  state = await api.disconnect();
  render();
});

dom.daysSelect.addEventListener('change', saveSettings);
dom.pseudoCheck.addEventListener('change', saveSettings);
dom.stayCheck.addEventListener('change', saveSettings);
dom.gClientId.addEventListener('input', () => {
  dom.gConnect.disabled = !dom.gClientId.value.trim();
});
dom.gClientId.addEventListener('change', saveSettings);
dom.gClientSecret.addEventListener('change', saveSettings);

dom.runBtn.addEventListener('click', () => run(false));
dom.demoBtn.addEventListener('click', () => run(true));
dom.cancelBtn.addEventListener('click', () => api.cancel());

dom.openBtn.addEventListener('click', () => lastReportPath && api.openReport(lastReportPath));
dom.folderBtn.addEventListener('click', () => lastReportPath && api.showInFolder(lastReportPath));
dom.saveAsBtn.addEventListener('click', () => lastReportPath && api.saveReportAs(lastReportPath));
dom.againBtn.addEventListener('click', () => {
  setPhase('idle');
  render();
});

dom.aboutBtn.addEventListener('click', () => dom.aboutDialog.showModal());

// The scope string is long and easy to mistype; copying it is the difference
// between a 30-second step and a stuck user.
const copyScope = el('copyScope');
copyScope.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el('gScope').textContent.trim());
    copyScope.textContent = 'Copied';
  } catch {
    // Clipboard can be refused; selecting the text is the fallback.
    getSelection().selectAllChildren(el('gScope'));
    copyScope.textContent = 'Selected';
  }
  setTimeout(() => { copyScope.textContent = 'Copy'; }, 1600);
});

// External links are declarative: the URL lives in the markup, the main process
// checks it against an allowlist, and the OS browser opens it.
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-external]');
  if (!target) return;
  event.preventDefault();
  api.openExternal(target.getAttribute('data-external'));
});

api.onLog(appendLog);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  state = await api.getState();
  dom.aboutPath.textContent = 'Your Documents folder, written with 0600 permissions.';
  setPhase('idle');
  render();
})();

})();
