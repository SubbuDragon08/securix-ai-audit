/**
 * Shared types for the Shadow AI & Agent Surface Scanner.
 *
 * The scanner's whole job is to make one thing legible to a non-technical
 * security leader: *here are the concrete pathways by which our IP and client
 * data can reach an external AI provider, on a machine we control.* Every
 * detector, wherever it looks, produces the same `Finding` shape so the report
 * and the SecuriX handoff never have to care which layer a risk came from.
 *
 * Privacy invariant, enforced by a test: a Finding never carries a secret
 * *value*. We record that a credential exists and where — never what it is.
 */

/** Ranked so the report can sort and headline the worst first. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * The class of data an agent or MCP server can reach. This is what turns a
 * dry finding into a sentence a CISO feels — "an external model can read your
 * *database*" lands differently from "a server is configured".
 */
export type DataDomain =
  | 'filesystem'
  | 'database'
  | 'source-code'
  | 'email'
  | 'browser'
  | 'cloud'
  | 'messaging'
  | 'secrets'
  | 'knowledge'
  | 'network'
  | 'unknown';

export type FindingKind =
  | 'mcp-server' // an MCP server declared in an AI client's config (headline signal)
  | 'provider-key' // a direct-to-provider API key present on the host
  | 'ai-tool' // an AI client / desktop app installed
  | 'agent-framework' // an agent framework present (LangChain, CrewAI, …)
  | 'local-listener' // a server listening on localhost right now
  | 'exposed-endpoint'; // (Phase 4) a network-reachable MCP server on the subnet

/** Which SecuriX control closes a given pathway. Drives the CTA on each card. */
export type Control = 'llm-gateway' | 'mcp-gateway' | 'both';

/** Which discovery layer produced a finding — stated in the report for honesty. */
export type Layer = 'host-config' | 'host-live' | 'network';

export interface Evidence {
  /** A file path or host:port. Safe to display — never a secret value. */
  location: string;
  /** Optional pre-sanitised detail line. */
  detail?: string;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  /** Short, human title, e.g. "MCP server exposes a database to Cursor". */
  title: string;
  /** One-sentence statement of the risk. */
  summary: string;
  /** The concrete data-leak pathway, written for a CISO. */
  pathway: string;
  dataDomains: DataDomain[];
  evidence: Evidence[];
  control: Control;
  /** Draft Rego preview (populated by rego.ts). */
  rego?: string;
  layer: Layer;
}

export interface HostInfo {
  platform: NodeJS.Platform;
  hostname: string;
  user: string;
}

export interface ScanReport {
  generatedAt: string;
  host: HostInfo;
  findings: Finding[];
  counts: Record<Severity, number>;
  /**
   * What was actually attempted. Distinguishes "scanned, found nothing" (a
   * clean bill of health) from "not scanned" (e.g. the network layer was
   * declined) — the report must never imply the second is the first.
   */
  scanned: { hostConfig: boolean; hostLive: boolean; network: boolean };
  warnings: string[];
  elapsedMs: number;
}

/** Options passed from the UI/IPC into the orchestrator. */
export interface ScanOptions {
  /** Layer A: read AI client configs, dotfiles, app inventory. Default true. */
  hostConfig?: boolean;
  /** Layer B: enumerate + fingerprint localhost listeners. Default true. */
  hostLive?: boolean;
  /**
   * Layer C: the authorised /24 sweep. Phase 4 — refused here unless the caller
   * has passed the authorisation gate. Present in the type so the shape is
   * stable across phases.
   */
  network?: boolean;
  /**
   * Override the home directory (tests point this at fixtures). Real runs leave
   * it undefined and the detectors use os.homedir().
   */
  home?: string;
}

export const emptyCounts = (): Record<Severity, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});
