/**
 * Shadow-scanner orchestrator.
 *
 * Mirrors `run.ts` on the audit side: the pure place that composes the
 * detectors into one structured `ScanReport`, streams progress through the
 * shared log sink (so the GUI sees it over IPC), and stays free of any Electron
 * dependency so it can be unit-tested with no machine state.
 *
 * Layers, in order of reliability:
 *   A (host-config) — MCP client configs, provider keys, tool footprint. Always
 *                     safe; only reads the current user's own files.
 *   B (host-live)   — localhost listeners fingerprinted for MCP. Loopback only.
 *   C (network)     — the authorised /24 sweep. Phase 4; refused here.
 */

import { hostname, platform, userInfo } from 'node:os';

import { log } from '../log.js';
import { discoverProviderKeys } from './credentials.js';
import { discoverFootprint } from './footprint.js';
import { discoverLocalListeners } from './localPorts.js';
import { discoverMcpServers } from './mcpConfigs.js';
import { attachRego } from './rego.js';
import {
  emptyCounts,
  SEVERITY_ORDER,
  type Finding,
  type ScanOptions,
  type ScanReport,
} from './types.js';

function sortFindings(findings: Finding[]): Finding[] {
  const rank = (s: Finding['severity']): number => SEVERITY_ORDER.indexOf(s);
  return [...findings].sort((a, b) => rank(a.severity) - rank(b.severity));
}

export async function runShadowScan(
  opts: ScanOptions = {},
  signal?: AbortSignal,
): Promise<ScanReport> {
  const started = Date.now();
  const hostConfig = opts.hostConfig !== false;
  const hostLive = opts.hostLive !== false;
  const network = opts.network === true; // Phase 4 — see below

  const findings: Finding[] = [];
  const warnings: string[] = [];

  if (hostConfig) {
    log.step('Reading AI client configurations');
    const mcp = discoverMcpServers({ home: opts.home });
    log.ok(`${mcp.length} MCP server declaration${mcp.length === 1 ? '' : 's'} found.`);
    findings.push(...mcp);

    log.step('Checking for direct-to-provider API keys');
    const keys = discoverProviderKeys({ home: opts.home });
    log.ok(`${keys.length} provider key${keys.length === 1 ? '' : 's'} present on this host.`);
    findings.push(...keys);

    log.step('Inventorying AI tools and agent frameworks');
    const fp = discoverFootprint({ home: opts.home });
    log.ok(`${fp.length} AI tool${fp.length === 1 ? '' : 's'} detected.`);
    findings.push(...fp);
  }

  if (hostLive && !signal?.aborted) {
    log.step('Scanning localhost for live MCP servers');
    const live = await discoverLocalListeners(signal);
    warnings.push(...live.warnings);
    log.ok(`${live.findings.length} live local endpoint${live.findings.length === 1 ? '' : 's'} found.`);
    findings.push(...live.findings);
  }

  if (network) {
    // The authorised /24 sweep lands in Phase 4 behind its own consent gate.
    // Guarded here so the option shape is stable and can never scan by accident.
    warnings.push('Network scanning is not enabled in this build.');
  }

  const withRego = attachRego(sortFindings(findings));

  const counts = emptyCounts();
  for (const f of withRego) counts[f.severity]++;

  return {
    generatedAt: new Date().toISOString(),
    host: { platform: platform(), hostname: safeHostname(), user: safeUser() },
    findings: withRego,
    counts,
    scanned: { hostConfig, hostLive, network: false },
    warnings,
    elapsedMs: Date.now() - started,
  };
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return 'this machine';
  }
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'you';
  }
}
