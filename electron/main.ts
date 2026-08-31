/**
 * Electron main process.
 *
 * Security posture
 * ----------------
 * This binary is downloaded from a website and run by Global Admins, so the
 * renderer is treated as untrusted even though we wrote it:
 *
 *  - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
 *    The renderer has no `require`, no `process`, no filesystem.
 *  - The only bridge is the narrow, validated API in `preload.ts`.
 *  - A CSP with no `connect-src` — the UI cannot make network requests at all.
 *    Every outbound call originates in this process, against a fixed host list.
 *  - Navigation and `window.open` are blocked outright; external links are
 *    handed to the OS browser only after passing an allowlist.
 *  - OAuth runs in the **system browser**, never an embedded BrowserWindow.
 *    An in-app webview for sign-in is the pattern phishing kits use, it hides
 *    the address bar the admin needs to verify, and Google blocks it outright.
 *
 * The app makes no outbound request of its own — no telemetry, no update ping,
 * no licence check. Lead capture happens on the website, before download, which
 * is what keeps "nothing leaves your machine" literally true.
 */

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getGoogleToken, getMicrosoftToken, SessionStore, type TokenSet } from '../src/auth.js';
import { BRAND, ENTRA, isEntraConfigured } from '../src/brand.js';
import { CancelledError } from '../src/http.js';
import { log, setLogSink, type LogLevel } from '../src/log.js';
import {
  DEFAULT_COPILOT_OPERATIONS,
  DEFAULT_GEMINI_APPLICATIONS,
  runAudit,
  VERSION,
  type RunConfig,
} from '../src/run.js';
import { buildDemoScan } from '../src/shadow/demo.js';
import { runShadowScan } from '../src/shadow/scanner.js';
import type { Provider } from '../src/types.js';

// ---------------------------------------------------------------------------
// Shared types with the renderer (kept in sync by hand; the surface is small)
// ---------------------------------------------------------------------------

interface ConnectionState {
  connected: boolean;
  account?: string;
}

interface Settings {
  days: number;
  pseudonymize: boolean;
  staySignedIn: boolean;
  googleClientId: string;
  googleClientSecret: string;
}

interface SecureStorageStatus {
  available: boolean;
  /** Why persistence is unavailable, shown next to the disabled checkbox. */
  reason?: string;
}

interface AppState {
  version: string;
  brand: { appName: string; vendor: string; website: string; tagline: string };
  entraConfigured: boolean;
  secureStorage: SecureStorageStatus;
  microsoft: ConnectionState;
  google: ConnectionState;
  settings: Settings;
  lastReportPath?: string;
}

const DEFAULT_SETTINGS: Settings = {
  days: 7,
  pseudonymize: false,
  staySignedIn: false,
  googleClientId: '',
  googleClientSecret: '',
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Is token persistence backed by real, OS-managed encryption?
 *
 * macOS (Keychain) and Windows (DPAPI) are always genuine. **Linux is not.**
 * When no keyring is running, Chromium falls back to a `basic` backend that
 * "encrypts" with a hardcoded key — and `isEncryptionAvailable()` still returns
 * true. Persisting a Global Admin refresh token under a hardcoded key is
 * plaintext with extra steps, so we detect the backend and refuse.
 *
 * `getSelectedStorageBackend` is Linux-only, hence the guarded call.
 */
function secureStorageStatus(): SecureStorageStatus {
  if (!safeStorage.isEncryptionAvailable()) {
    return { available: false, reason: 'This system has no OS credential store available.' };
  }

  if (process.platform === 'linux') {
    // `basic_text` is Chromium's hardcoded-key fallback; `unknown` means it
    // could not determine a backend. Neither is a credential store.
    const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
    if (backend === 'basic_text' || backend === 'unknown') {
      return {
        available: false,
        reason:
          'No system keyring detected, so Linux would fall back to hardcoded-key storage. ' +
          'Install gnome-keyring or kwallet to enable this. Until then tokens stay in memory only.',
      };
    }
  }

  return { available: true };
}

/**
 * Preferences and, optionally, refresh tokens.
 *
 * Preferences are plain JSON. Tokens are encrypted with `safeStorage`, backed by
 * the OS keychain — so "stay signed in" does not mean "Global Admin refresh
 * token in a world-readable JSON file", which is what the CLI's
 * `--save-session` had to settle for. If the platform cannot genuinely encrypt,
 * we refuse to persist rather than silently downgrade.
 */
class Store {
  private readonly dir = app.getPath('userData');
  private readonly settingsFile = join(this.dir, 'settings.json');
  private readonly tokenFile = join(this.dir, 'session.bin');

  constructor() {
    mkdirSync(this.dir, { recursive: true });
  }

  readSettings(): Settings {
    try {
      const raw = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Partial<Settings>;
      return {
        days: clampDays(raw.days),
        pseudonymize: raw.pseudonymize === true,
        staySignedIn: raw.staySignedIn === true,
        googleClientId: typeof raw.googleClientId === 'string' ? raw.googleClientId.trim() : '',
        googleClientSecret:
          typeof raw.googleClientSecret === 'string' ? raw.googleClientSecret.trim() : '',
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  writeSettings(settings: Settings): void {
    writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }

  readTokens(): Record<string, TokenSet> {
    if (!existsSync(this.tokenFile) || !secureStorageStatus().available) return {};
    try {
      const plain = safeStorage.decryptString(readFileSync(this.tokenFile));
      return JSON.parse(plain) as Record<string, TokenSet>;
    } catch {
      // A keychain rotation or a different machine invalidates the blob.
      // Re-authenticating is the correct recovery, not an error dialog.
      return {};
    }
  }

  writeTokens(entries: Record<string, TokenSet>): void {
    if (!secureStorageStatus().available) return;
    writeFileSync(this.tokenFile, safeStorage.encryptString(JSON.stringify(entries)), {
      mode: 0o600,
    });
  }

  clearTokens(): void {
    rmSync(this.tokenFile, { force: true });
  }
}

const clampDays = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 180 ? n : 7;
};

/**
 * `SessionStore` subclass that keeps tokens in the OS keychain.
 *
 * `runAudit` takes a `SessionStore`; overriding get/set is enough to redirect
 * where it persists without the core knowing Electron exists.
 */
class KeychainSessionStore extends SessionStore {
  private entries: Record<string, TokenSet>;
  private persist: boolean;

  constructor(
    private readonly store: Store,
    persist: boolean,
  ) {
    super(false);
    this.persist = persist;
    this.entries = persist ? store.readTokens() : {};
  }

  /**
   * Change where tokens are kept **without dropping the live session**.
   *
   * This exists because rebuilding the store on every settings save silently
   * signed the user out: with "stay signed in" off, a fresh instance starts
   * with an empty map, so changing the history dropdown — which saves settings —
   * discarded the tokens acquired seconds earlier. Turning persistence off must
   * forget the *disk* copy only; the in-memory session belongs to this process
   * and outlives any preference change.
   */
  setPersist(enabled: boolean): void {
    if (enabled === this.persist) return;
    this.persist = enabled;
    if (enabled) {
      this.store.writeTokens(this.entries);
    } else {
      this.store.clearTokens();
    }
  }

  override get(key: string): TokenSet | undefined {
    return this.entries[key];
  }

  override set(key: string, token: TokenSet): void {
    this.entries[key] = token;
    if (this.persist) this.store.writeTokens(this.entries);
  }

  override clear(): void {
    this.entries = {};
    this.store.clearTokens();
  }

  /** Accounts currently held, for rendering the connect cards. */
  accountFor(prefix: string): string | undefined {
    const hit = Object.entries(this.entries).find(([k]) => k.startsWith(prefix));
    return hit?.[1].account;
  }

  hasFresh(prefix: string): boolean {
    return Object.entries(this.entries).some(
      ([k, t]) => k.startsWith(prefix) && (t.expiresAt > Date.now() || Boolean(t.refreshToken)),
    );
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let store: Store;
let session: KeychainSessionStore;
let currentRun: AbortController | null = null;
let currentScan: AbortController | null = null;

/** Hosts the app itself may open in the user's browser. */
const EXTERNAL_ALLOWLIST = new Set([
  'securix.app',
  'www.securix.app',
  'entra.microsoft.com',
  'console.cloud.google.com',
  'admin.google.com',
  'learn.microsoft.com',
  'developers.google.com',
  'microsoft.com',
  'www.microsoft.com',
]);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 720,
    minHeight: 600,
    title: BRAND.appName,
    show: false,
    backgroundColor: '#f9f9f7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // Renderer devtools are a debugging convenience, not something a
      // downloaded security tool should ship enabled.
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadFile(join(__dirname, 'ui', 'index.html'));

  // Nothing in this app should ever navigate. Any attempt is either a bug or
  // an injection, and both deserve the same answer.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Open a URL in the OS browser, but only if we recognise the host. */
function openExternal(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    if (!EXTERNAL_ALLOWLIST.has(url.hostname)) {
      log.warn(`Blocked an attempt to open a non-allowlisted host: ${url.hostname}`);
      return false;
    }
    void shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Progress plumbing
// ---------------------------------------------------------------------------

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

setLogSink((level: LogLevel, message: string) => {
  send('audit:log', { level, message, at: Date.now() });
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function buildState(lastReportPath?: string): AppState {
  const settings = store.readSettings();
  const secure = secureStorageStatus();
  return {
    version: VERSION,
    brand: {
      appName: BRAND.appName,
      vendor: BRAND.vendor,
      website: BRAND.website,
      tagline: BRAND.tagline,
    },
    entraConfigured: isEntraConfigured(),
    secureStorage: secure,
    microsoft: {
      connected: session.hasFresh('microsoft:'),
      account: session.accountFor('microsoft:'),
    },
    google: {
      connected: session.hasFresh('google:'),
      account: session.accountFor('google:'),
    },
    settings,
    lastReportPath,
  };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** Every handler validates its own input; the renderer is not trusted. */
function registerIpc(): void {
  ipcMain.handle('app:getState', () => buildState());

  ipcMain.handle('app:saveSettings', (_event, raw: unknown) => {
    const input = (raw ?? {}) as Partial<Settings>;
    const current = store.readSettings();
    const next: Settings = {
      days: clampDays(input.days ?? current.days),
      pseudonymize: input.pseudonymize === true,
      // Cannot opt into persistence the platform cannot do securely.
      staySignedIn: input.staySignedIn === true && secureStorageStatus().available,
      googleClientId:
        typeof input.googleClientId === 'string' ? input.googleClientId.trim().slice(0, 200) : '',
      googleClientSecret:
        typeof input.googleClientSecret === 'string'
          ? input.googleClientSecret.trim().slice(0, 200)
          : '',
    };
    store.writeSettings(next);
    // Adjust persistence in place. Rebuilding the store here would discard the
    // live session on every preference change — which is exactly the bug that
    // made "Connect" appear to reset whenever a dropdown moved.
    session.setPersist(next.staySignedIn);
    return buildState();
  });

  ipcMain.handle('app:connect', async (_event, rawProvider: unknown) => {
    const provider = rawProvider === 'google' ? 'google' : 'microsoft';
    const settings = store.readSettings();
    try {
      if (provider === 'microsoft') {
        if (!isEntraConfigured()) {
          throw new Error(
            'This build has no Entra application id. See README § "Registering the SecuriX multi-tenant app".',
          );
        }
        await getMicrosoftToken({
          tenantId: ENTRA.tenant,
          clientId: ENTRA.clientId,
          scopes: ['https://graph.microsoft.com/AuditLogsQuery.Read.All'],
          // A GUI signs in through the browser; device code is the CLI's answer
          // to having no window, which does not apply here.
          mode: 'browser',
          port: 0,
          authority: ENTRA.authority,
          interactiveTimeoutMs: 10 * 60_000,
          session,
        });
      } else {
        if (!settings.googleClientId) {
          throw new Error('Add your Google OAuth client id in Google setup first.');
        }
        await getGoogleToken({
          clientId: settings.googleClientId,
          clientSecret: settings.googleClientSecret || undefined,
          scopes: ['https://www.googleapis.com/auth/admin.reports.audit.readonly'],
          port: 0,
          interactiveTimeoutMs: 10 * 60_000,
          session,
        });
      }
      return { ok: true, state: buildState() };
    } catch (err) {
      return { ok: false, error: (err as Error).message, state: buildState() };
    }
  });

  ipcMain.handle('app:disconnect', () => {
    session.clear();
    return buildState();
  });

  ipcMain.handle('app:run', async (_event, raw: unknown) => {
    if (currentRun) return { ok: false, error: 'A report is already running.' };

    const input = (raw ?? {}) as { providers?: unknown; demo?: unknown };
    const requested = Array.isArray(input.providers) ? input.providers : [];
    const providers = (['microsoft', 'google'] as Provider[]).filter((p) => requested.includes(p));
    const demo = input.demo === true;

    if (!demo && providers.length === 0) {
      return { ok: false, error: 'Connect at least one platform first.' };
    }

    const settings = store.readSettings();
    const controller = new AbortController();
    currentRun = controller;

    const config: RunConfig = {
      providers,
      days: settings.days,
      maxRecords: 50_000,
      timeoutMs: 15 * 60_000,
      port: 0,
      pseudonymize: settings.pseudonymize,
      includeRaw: false,
      demo,
      microsoft: isEntraConfigured()
        ? {
            tenantId: ENTRA.tenant,
            clientId: ENTRA.clientId,
            authority: ENTRA.authority,
            auth: 'browser',
            operations: DEFAULT_COPILOT_OPERATIONS,
          }
        : undefined,
      google: settings.googleClientId
        ? {
            clientId: settings.googleClientId,
            clientSecret: settings.googleClientSecret || undefined,
            applications: DEFAULT_GEMINI_APPLICATIONS,
          }
        : undefined,
    };

    try {
      const outcome = await runAudit(config, {
        session,
        signal: controller.signal,
        // Reports land in Documents, not a working directory the user has to
        // hunt for — this app has no cwd worth speaking of.
        defaultOutDir: app.getPath('documents'),
      });
      return {
        ok: true,
        outPath: outcome.outPath,
        totalEvents: outcome.totalEvents,
        uniqueUsers: outcome.uniqueUsers,
        elapsedSeconds: outcome.elapsedSeconds,
        allFailed: outcome.allFailed,
        providerErrors: outcome.results
          .filter((r) => r.error)
          .map((r) => ({ provider: r.provider, error: r.error })),
        state: buildState(outcome.outPath),
      };
    } catch (err) {
      const cancelled = err instanceof CancelledError;
      return {
        ok: false,
        cancelled,
        error: cancelled ? 'Cancelled.' : (err as Error).message,
        state: buildState(),
      };
    } finally {
      currentRun = null;
    }
  });

  ipcMain.handle('app:cancel', () => {
    currentRun?.abort();
    return { ok: true };
  });

  ipcMain.handle('app:openReport', async (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || !existsSync(rawPath)) return { ok: false };
    // openPath would hand an arbitrary file to the OS handler; forcing the
    // file:// URL keeps this to "open an HTML report in a browser".
    await shell.openExternal(pathToFileURL(rawPath).href);
    return { ok: true };
  });

  ipcMain.handle('app:showInFolder', (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || !existsSync(rawPath)) return { ok: false };
    shell.showItemInFolder(rawPath);
    return { ok: true };
  });

  ipcMain.handle('app:openExternal', (_event, rawUrl: unknown) =>
    typeof rawUrl === 'string' ? { ok: openExternal(rawUrl) } : { ok: false },
  );

  ipcMain.handle('app:saveReportAs', async (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || !existsSync(rawPath) || !mainWindow) return { ok: false };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `ai-audit-report-${new Date().toISOString().slice(0, 10)}.html`,
      filters: [{ name: 'HTML report', extensions: ['html'] }],
    });
    if (canceled || !filePath) return { ok: false };
    writeFileSync(filePath, readFileSync(rawPath), { mode: 0o600 });
    return { ok: true, path: filePath };
  });

  // -------------------------------------------------------------------------
  // Shadow AI & Agent Surface Scanner (Tab 2)
  //
  // Host-only scan (Layers A + B): reads the current user's own AI configs and
  // fingerprints localhost. No consent gate needed — it touches no other
  // machine. The authorised /24 network sweep (Layer C) is a later phase with
  // its own gate; there is deliberately no IPC for it yet, so this build cannot
  // scan the network by accident.
  // -------------------------------------------------------------------------

  ipcMain.handle('shadow:scan', async (_event, raw: unknown) => {
    if (currentScan) return { ok: false, error: 'A scan is already running.' };

    const input = (raw ?? {}) as { demo?: unknown };
    if (input.demo === true) {
      return { ok: true, report: buildDemoScan() };
    }

    const controller = new AbortController();
    currentScan = controller;
    try {
      const report = await runShadowScan({ hostConfig: true, hostLive: true }, controller.signal);
      return { ok: true, report };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      currentScan = null;
    }
  });

  ipcMain.handle('shadow:cancel', () => {
    currentScan?.abort();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// A second instance would race the first for the loopback OAuth port and the
// token file. Focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    store = new Store();
    session = new KeychainSessionStore(store, store.readSettings().staySignedIn);
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Defence in depth: even if a renderer were compromised, deny it the ability
  // to spawn windows or attach webviews.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
