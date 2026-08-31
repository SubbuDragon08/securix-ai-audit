/**
 * The one bridge between the sandboxed renderer and the main process.
 *
 * This file is the app's trust boundary, so it is deliberately dull: a fixed
 * list of channels, no dynamic channel names, no passthrough of `ipcRenderer`
 * itself, and nothing from `node:` reachable on the other side. Everything the
 * UI can ask for is enumerated here, and every argument is re-validated in the
 * main process regardless of what this file appears to guarantee.
 *
 * Runs sandboxed, so it must stay CommonJS with no Node imports beyond
 * `electron` — which is why the build emits it as `preload.cjs`.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export type LogLevel = 'step' | 'info' | 'ok' | 'warn' | 'error' | 'debug' | 'progress';

export interface LogEvent {
  level: LogLevel;
  message: string;
  at: number;
}

const api = {
  getState: () => ipcRenderer.invoke('app:getState'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('app:saveSettings', settings),
  connect: (provider: 'microsoft' | 'google') => ipcRenderer.invoke('app:connect', provider),
  disconnect: () => ipcRenderer.invoke('app:disconnect'),
  run: (options: { providers: string[]; demo?: boolean }) => ipcRenderer.invoke('app:run', options),
  cancel: () => ipcRenderer.invoke('app:cancel'),
  openReport: (path: string) => ipcRenderer.invoke('app:openReport', path),
  showInFolder: (path: string) => ipcRenderer.invoke('app:showInFolder', path),
  saveReportAs: (path: string) => ipcRenderer.invoke('app:saveReportAs', path),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),

  // Shadow AI & Agent Surface Scanner (Tab 2).
  shadowScan: (options: { demo?: boolean }) => ipcRenderer.invoke('shadow:scan', options),
  shadowCancel: () => ipcRenderer.invoke('shadow:cancel'),

  /**
   * Subscribe to progress. Returns an unsubscribe function.
   *
   * The raw `IpcRendererEvent` is dropped rather than forwarded — it carries a
   * `sender` handle that would hand the renderer a way back into IPC.
   */
  onLog: (callback: (event: LogEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: LogEvent): void => callback(payload);
    ipcRenderer.on('audit:log', listener);
    return () => ipcRenderer.removeListener('audit:log', listener);
  },
};

contextBridge.exposeInMainWorld('auditApi', api);

export type AuditApi = typeof api;
