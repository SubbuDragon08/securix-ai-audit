/**
 * MCP client-configuration discovery — the headline detector.
 *
 * Every mainstream AI client (Claude Desktop, Cursor, Windsurf, VS Code,
 * Claude Code, Continue …) declares the MCP servers it can drive in a JSON
 * config file in the user's own home directory. Those declarations are the
 * single most valuable signal this whole tool produces, because they state, in
 * plain text:
 *
 *   - which external model client is installed,
 *   - which MCP servers it is wired to,
 *   - and *what each server can reach* — a filesystem path, a database DSN, a
 *     GitHub token, a browser.
 *
 * That is the exact sentence a CISO needs to hear: "Cursor on this host has an
 * MCP server pointing at `prod-db.internal` — your customer data is one prompt
 * from leaving your control." It is reliable (static files we are allowed to
 * read), and it catches the common case a network scan misses entirely:
 * stdio-transport servers, which are subprocesses on no network port at all.
 *
 * Privacy: we read server *definitions*. Where a definition embeds an `env`
 * block, we record only that credentials are present and their variable names —
 * never the values.
 */

import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import type { DataDomain, Evidence, Finding, Severity } from './types.js';

// ---------------------------------------------------------------------------
// Where clients keep their config
// ---------------------------------------------------------------------------

interface ClientConfig {
  /** Display name of the AI client, used verbatim in the finding. */
  client: string;
  /** Path relative to home (already platform-resolved). */
  relPath: string;
  /** Key under which servers live: most use `mcpServers`, VS Code uses `servers`. */
  serversKey: 'mcpServers' | 'servers';
}

/** Global (per-user) client config locations, resolved for the platform. */
function globalConfigs(home: string): ClientConfig[] {
  const p = platform();
  const appSupport =
    p === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : p === 'win32'
        ? (process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'))
        : join(home, '.config');

  return [
    { client: 'Claude Desktop', relPath: join(appSupport, 'Claude', 'claude_desktop_config.json'), serversKey: 'mcpServers' },
    { client: 'Claude Code', relPath: join(home, '.claude.json'), serversKey: 'mcpServers' },
    { client: 'Cursor', relPath: join(home, '.cursor', 'mcp.json'), serversKey: 'mcpServers' },
    { client: 'Windsurf', relPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'), serversKey: 'mcpServers' },
    { client: 'Continue', relPath: join(home, '.continue', 'config.json'), serversKey: 'mcpServers' },
  ];
}

/**
 * Project-level config filenames. Scanned shallowly under common dev roots so
 * we catch per-repo MCP setups without a full-disk crawl.
 */
const PROJECT_CONFIGS: Array<{ client: string; rel: string; serversKey: 'mcpServers' | 'servers' }> = [
  { client: 'Claude Code (project)', rel: '.mcp.json', serversKey: 'mcpServers' },
  { client: 'Cursor (project)', rel: join('.cursor', 'mcp.json'), serversKey: 'mcpServers' },
  { client: 'VS Code (project)', rel: join('.vscode', 'mcp.json'), serversKey: 'servers' },
];

/** Bounded set of directories developers actually keep repos in. */
export function commonDevRoots(home: string): string[] {
  return [
    home,
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Projects'),
    join(home, 'projects'),
    join(home, 'code'),
    join(home, 'Code'),
    join(home, 'dev'),
    join(home, 'Developer'),
    join(home, 'src'),
    join(home, 'git'),
    join(home, 'repos'),
    join(home, 'workspace'),
    join(home, 'work'),
  ];
}

// ---------------------------------------------------------------------------
// Raw server shapes (defensive — configs are hand-edited and vary)
// ---------------------------------------------------------------------------

interface RawServer {
  command?: string;
  args?: unknown;
  url?: string;
  type?: string;
  env?: Record<string, unknown>;
  transport?: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // missing or malformed — not an error, just nothing here
  }
}

function serversFrom(doc: Record<string, unknown>, key: string): Record<string, RawServer> {
  const raw = doc[key];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, RawServer>;
  // Some VS Code files nest under `mcp.servers`.
  const mcp = doc['mcp'];
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
    const inner = (mcp as Record<string, unknown>)['servers'];
    if (inner && typeof inner === 'object') return inner as Record<string, RawServer>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Classification: what can this server reach, and how bad is that?
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS: Array<[DataDomain, RegExp]> = [
  ['database', /postgres|postgre|mysql|mariadb|sqlite|mongo|mongodb|redis|\bsql\b|\bdb\b|database|supabase|snowflake|bigquery|clickhouse/i],
  ['filesystem', /filesystem|file-?system|\bfiles?\b|\bfs\b|directory|\bpath\b|desktop-commander/i],
  ['source-code', /github|gitlab|bitbucket|\bgit\b|source|repo|jira|linear|sentry/i],
  ['email', /gmail|\bemail\b|\bimap\b|\bsmtp\b|outlook|\bmail\b/i],
  ['browser', /puppeteer|playwright|browser|chrome|chromium|webscrape|fetch|firecrawl/i],
  ['messaging', /slack|discord|telegram|\bteams\b|whatsapp/i],
  ['cloud', /\baws\b|\bgcp\b|azure|\bs3\b|cloudflare|kubernetes|k8s|terraform|docker/i],
  ['knowledge', /notion|confluence|obsidian|google-?drive|gdrive|sharepoint|\bdrive\b|memory|vector/i],
];

/** Private / internal / production hints that escalate a finding to critical. */
const INTERNAL_HINTS =
  /(\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)|(\b192\.168\.\d{1,3}\.\d{1,3}\b)|(\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b)|\.internal\b|\.corp\b|\.local\b|\.lan\b|\bprod\b|\bproduction\b|\bstaging\b/i;

function argsToStrings(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  return args.filter((a): a is string => typeof a === 'string');
}

interface Classified {
  domains: DataDomain[];
  severity: Severity;
  internal: boolean;
  hasCredentials: boolean;
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
  target: string; // a safe, human summary of what it points at (no secrets)
}

function classify(name: string, server: RawServer): Classified {
  const args = argsToStrings(server.args);
  // The searchable surface: server name, command, args, url. NOT env values.
  const hay = [name, server.command ?? '', ...args, server.url ?? ''].join(' ');

  const domains = new Set<DataDomain>();
  for (const [domain, re] of DOMAIN_KEYWORDS) if (re.test(hay)) domains.add(domain);

  const hasCredentials = !!server.env && Object.keys(server.env).length > 0;
  if (hasCredentials) domains.add('secrets');

  const transport: Classified['transport'] = server.url
    ? server.type === 'http' || server.type === 'streamable-http'
      ? 'http'
      : 'sse'
    : server.command
      ? 'stdio'
      : 'unknown';

  if (domains.size === 0) domains.add(transport === 'stdio' ? 'unknown' : 'network');

  const internal = INTERNAL_HINTS.test(hay);

  // Severity by capability, escalated when it points at internal/production data.
  // An MCP endpoint on an internal address is an exposed control surface even
  // when we can't classify what it reaches, so `internal` alone lifts it to high.
  const acts = ['database', 'filesystem', 'source-code', 'email', 'cloud', 'secrets'];
  const strong = [...domains].some((d) => acts.includes(d));
  let severity: Severity = 'medium';
  if (strong && internal) severity = 'critical';
  else if (strong || internal) severity = 'high';

  // A safe one-line summary of the target: the url host, or the last arg that
  // looks like a resource. Never the env, never a full secret.
  let target = '';
  if (server.url) {
    try {
      target = new URL(server.url).host;
    } catch {
      target = server.url.slice(0, 60);
    }
  } else {
    const resourceish = args.find((a) => /:\/\/|@|\.internal|\.local|\/|\\/.test(a));
    target = resourceish ? redactSecrets(resourceish) : (server.command ?? '');
  }

  return { domains: [...domains], severity, internal, hasCredentials, transport, target };
}

/** Strip anything that looks like a password/token out of a connection string. */
function redactSecrets(s: string): string {
  // postgres://user:PASSWORD@host → postgres://user:***@host
  let out = s.replace(/(:\/\/[^:/@\s]+:)[^@/\s]+@/g, '$1***@');
  // key=VALUE or key:VALUE where key looks secret
  out = out.replace(/((?:pass(?:word)?|token|secret|key)\s*[=:]\s*)\S+/gi, '$1***');
  return out.length > 80 ? out.slice(0, 79) + '…' : out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface McpDiscoveryOptions {
  home?: string;
  /** Extra absolute config paths (tests inject fixtures here). */
  extraGlobalPaths?: Array<{ client: string; path: string; serversKey: 'mcpServers' | 'servers' }>;
  /** Whether to shallow-scan common dev roots for project configs. Default true. */
  scanProjects?: boolean;
  /** Directory-exists probe, injectable for tests. Defaults to real fs. */
}

let findingSeq = 0;
const nextId = (kind: string): string => `${kind}-${++findingSeq}`;

/** Reset the id counter — tests call this for deterministic ids. */
export function resetIds(): void {
  findingSeq = 0;
}

export function discoverMcpServers(opts: McpDiscoveryOptions = {}): Finding[] {
  const home = opts.home ?? homedir();
  const findings: Finding[] = [];
  const seen = new Set<string>(); // dedupe identical server across duplicate files

  const sources: Array<{ client: string; path: string; serversKey: 'mcpServers' | 'servers' }> = [
    ...globalConfigs(home).map((c) => ({ client: c.client, path: c.relPath, serversKey: c.serversKey })),
    ...(opts.extraGlobalPaths ?? []),
  ];

  if (opts.scanProjects !== false) {
    for (const root of commonDevRoots(home)) {
      for (const pc of PROJECT_CONFIGS) {
        sources.push({ client: pc.client, path: join(root, pc.rel), serversKey: pc.serversKey });
      }
    }
  }

  for (const src of sources) {
    const doc = readJson(src.path);
    if (!doc) continue;
    const servers = serversFrom(doc, src.serversKey);

    for (const [name, server] of Object.entries(servers)) {
      if (!server || typeof server !== 'object') continue;
      const c = classify(name, server);

      // Dedupe on client+name+target so the same repo opened twice isn't doubled.
      const key = `${src.client}|${name}|${c.target}`;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push(buildFinding(src.client, name, server, c, src.path));
    }
  }

  return findings;
}

function buildFinding(
  client: string,
  name: string,
  server: RawServer,
  c: Classified,
  path: string,
): Finding {
  const domainLabel = c.domains.filter((d) => d !== 'unknown' && d !== 'network');
  const capability =
    domainLabel.length > 0 ? domainLabel.join(', ') : c.transport === 'stdio' ? 'local tools' : 'a network service';

  const evidence: Evidence[] = [
    { location: path, detail: `Server "${name}" (${c.transport}) declared for ${client}` },
  ];
  if (c.target) evidence.push({ location: c.target, detail: 'reachable target' });
  if (c.hasCredentials && server.env) {
    // Names only — never values.
    evidence.push({ location: 'embedded credentials', detail: `env: ${Object.keys(server.env).join(', ')}` });
  }

  const internalClause = c.internal
    ? ' It points at what looks like an internal or production resource, so real company data is directly in scope.'
    : '';

  return {
    id: nextId('mcp'),
    kind: 'mcp-server',
    severity: c.severity,
    title: `${client} can drive an MCP server with access to ${capability}`,
    summary: `"${name}" grants an external AI model access to ${capability} through ${client}.`,
    pathway:
      `When a developer prompts ${client}, the model can call the "${name}" MCP server to reach ${capability}. ` +
      `Anything it reads can be sent to the model provider as context — outside any DLP, audit, or policy.` +
      internalClause,
    dataDomains: c.domains,
    evidence,
    control: 'mcp-gateway',
    layer: 'host-config',
  };
}
