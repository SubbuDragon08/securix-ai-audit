/**
 * Localhost listener discovery (Layer B) — what is running right now.
 *
 * Enumerates the TCP ports that processes on *this* machine are LISTENING on
 * (which we are allowed to see for our own user), then fingerprints the
 * loopback address for MCP / Server-Sent-Events endpoints. This catches an MCP
 * server that is live at this moment and ties it to the process behind it.
 *
 * It is strictly local: every probe targets 127.0.0.1. No other host is
 * touched — that is the authorised /24 sweep in Layer C (Phase 4), gated
 * separately. Failures (no `lsof`, restricted shell) degrade to a warning, not
 * an error.
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

import type { Finding } from './types.js';

const run = promisify(execFile);

interface Listener {
  process: string;
  pid: string;
  port: number;
}

/** Ports worth probing even for a generic process, from the datasheet. */
const CANDIDATE_PORTS = new Set([3000, 3001, 5000, 5173, 8000, 8080, 8787, 11434]);

/** Processes that commonly host an MCP / agent dev server. */
const AI_PROCESS = /node|python|python3|deno|bun|uvicorn|uv|fastmcp|ruby|go/i;

/** Cap total probes so a busy machine can't make this slow. */
const MAX_PROBES = 40;

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

async function listenersUnix(): Promise<Listener[]> {
  // -nP: numeric host+port; -iTCP -sTCP:LISTEN: only listening TCP sockets.
  const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
    timeout: 8000,
    maxBuffer: 4_000_000,
  });
  const out: Listener[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+(\d+)\s.*?(?:\[[^\]]+\]|[\d.*]+):(\d+)\s+\(LISTEN\)/.exec(line);
    if (!m) continue;
    out.push({ process: m[1] ?? '?', pid: m[2] ?? '?', port: Number(m[3]) });
  }
  return out;
}

async function listenersWindows(): Promise<Listener[]> {
  const [{ stdout: netstat }, { stdout: tasks }] = await Promise.all([
    run('netstat', ['-ano', '-p', 'TCP'], { timeout: 8000, maxBuffer: 4_000_000 }),
    run('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000, maxBuffer: 4_000_000 }),
  ]);

  const pidName = new Map<string, string>();
  for (const line of tasks.split('\n')) {
    const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
    if (cols.length >= 2 && cols[0] && cols[1]) pidName.set(cols[1], cols[0]);
  }

  const out: Listener[] = [];
  for (const line of netstat.split('\n')) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (!m) continue;
    const pid = m[2] ?? '?';
    out.push({ process: pidName.get(pid) ?? 'pid ' + pid, pid, port: Number(m[1]) });
  }
  return out;
}

async function enumerate(): Promise<Listener[]> {
  const listeners = platform() === 'win32' ? await listenersWindows() : await listenersUnix();
  // Dedupe by port; keep the first (owning) process.
  const byPort = new Map<number, Listener>();
  for (const l of listeners) if (!byPort.has(l.port)) byPort.set(l.port, l);
  return [...byPort.values()];
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

interface Probe {
  isMcp: boolean;
  isSse: boolean;
  hint: string;
}

async function fingerprint(port: number): Promise<Probe | undefined> {
  for (const path of ['/sse', '/mcp', '/']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'GET',
        headers: { accept: 'text/event-stream, application/json' },
        signal: controller.signal,
        redirect: 'manual',
      });
      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      const isSse = ct.includes('text/event-stream');
      // Read a small slice of the body for JSON-RPC / MCP tokens.
      let body = '';
      try {
        const reader = res.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          body = value ? new TextDecoder().decode(value).slice(0, 2000) : '';
          await reader.cancel();
        }
      } catch {
        /* streaming SSE endpoints may hang the read — the header already told us */
      }
      const isMcp = /"jsonrpc"|"tools\/list"|"notifications\/|modelcontextprotocol|"mcp"/i.test(body) || isSse;
      if (isMcp) {
        return { isMcp: true, isSse, hint: isSse ? 'Server-Sent Events endpoint' : 'JSON-RPC endpoint' };
      }
    } catch {
      // connection refused / timeout on this path — try the next
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let seq = 0;

export interface LocalPortResult {
  findings: Finding[];
  warnings: string[];
}

export async function discoverLocalListeners(signal?: AbortSignal): Promise<LocalPortResult> {
  const findings: Finding[] = [];
  const warnings: string[] = [];

  let listeners: Listener[];
  try {
    listeners = await enumerate();
  } catch {
    return {
      findings,
      warnings: ['Could not enumerate local listening ports on this system (a restricted shell can cause this).'],
    };
  }

  const worth = listeners.filter((l) => CANDIDATE_PORTS.has(l.port) || AI_PROCESS.test(l.process));
  let probes = 0;

  for (const l of worth) {
    if (signal?.aborted || probes >= MAX_PROBES) break;
    probes++;
    const fp = await fingerprint(l.port);
    if (!fp) continue;
    findings.push({
      id: `live-${++seq}`,
      kind: 'local-listener',
      severity: 'high',
      title: `A live MCP server is listening on port ${l.port}`,
      summary: `Process "${l.process}" is serving an MCP endpoint (${fp.hint}) on 127.0.0.1:${l.port} right now.`,
      pathway:
        `An MCP server is running on this host and can be driven by any AI client configured to reach it. ` +
        `Whatever tools it exposes — files, databases, internal APIs — are available to a model with no gateway in front.`,
      dataDomains: ['network', 'unknown'],
      evidence: [{ location: `127.0.0.1:${l.port}`, detail: `served by ${l.process} (pid ${l.pid})` }],
      control: 'mcp-gateway',
      layer: 'host-live',
    });
  }

  return { findings, warnings };
}
