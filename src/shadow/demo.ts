/**
 * Synthetic shadow-scan report for the "Preview" button.
 *
 * Mirrors `demo.ts` on the audit side: lets a CISO see exactly what the scanner
 * surfaces before running it for real, and gives the UI stable, screenshot-able
 * output on a clean machine that has no real shadow AI on it. Seeded and
 * deterministic — never touches disk or the network.
 */

import { hostname } from 'node:os';

import { attachRego } from './rego.js';
import { emptyCounts, SEVERITY_ORDER, type Finding, type ScanReport } from './types.js';

const demoFindings: Finding[] = [
  {
    id: 'mcp-1',
    kind: 'mcp-server',
    severity: 'critical',
    title: 'Cursor can drive an MCP server with access to a production database',
    summary: '"postgres-prod" grants an external AI model access to a database through Cursor.',
    pathway:
      'When a developer prompts Cursor, the model can call the "postgres-prod" MCP server to reach a database. ' +
      'Anything it reads can be sent to the model provider as context — outside any DLP, audit, or policy. ' +
      'It points at what looks like an internal or production resource, so real company data is directly in scope.',
    dataDomains: ['database'],
    evidence: [
      { location: '~/.cursor/mcp.json', detail: 'Server "postgres-prod" (stdio) declared for Cursor' },
      { location: 'prod-db.internal:5432', detail: 'reachable target' },
    ],
    control: 'mcp-gateway',
    layer: 'host-config',
  },
  {
    id: 'mcp-2',
    kind: 'mcp-server',
    severity: 'high',
    title: 'Claude Desktop can read the filesystem via an MCP server',
    summary: '"filesystem" grants an external AI model access to filesystem through Claude Desktop.',
    pathway:
      'When a developer prompts Claude Desktop, the model can call the "filesystem" MCP server to read local ' +
      'files and send their contents to the provider as context — with no DLP or audit in between.',
    dataDomains: ['filesystem'],
    evidence: [
      { location: '~/Library/Application Support/Claude/claude_desktop_config.json', detail: 'Server "filesystem" (stdio)' },
      { location: '/Users/dev/company', detail: 'reachable target' },
    ],
    control: 'mcp-gateway',
    layer: 'host-config',
  },
  {
    id: 'mcp-3',
    kind: 'mcp-server',
    severity: 'high',
    title: 'An MCP server carries a GitHub token to reach your source code',
    summary: '"github" grants an external AI model access to source-code through Claude Desktop.',
    pathway:
      'The model can call the "github" MCP server to read repositories using a stored access token, exposing ' +
      'proprietary source to the provider with no oversight.',
    dataDomains: ['source-code', 'secrets'],
    evidence: [
      { location: '~/Library/Application Support/Claude/claude_desktop_config.json', detail: 'Server "github" (stdio)' },
      { location: 'embedded credentials', detail: 'env: GITHUB_PERSONAL_ACCESS_TOKEN' },
    ],
    control: 'mcp-gateway',
    layer: 'host-config',
  },
  {
    id: 'key-1',
    kind: 'provider-key',
    severity: 'high',
    title: 'Direct OpenAI API access is configured on this host',
    summary: 'An OpenAI API key (OPENAI_API_KEY) is present, so this machine can call OpenAI with no gateway in between.',
    pathway:
      'Any script or agent on this host can send prompts — and whatever data they include — straight to OpenAI ' +
      'using this key. There is no DLP on the prompt, no central audit of what was sent, and no policy that can stop a leak.',
    dataDomains: ['secrets', 'network'],
    evidence: [{ location: '~/.zshrc', detail: 'OPENAI_API_KEY is set here (value not read)' }],
    control: 'llm-gateway',
    layer: 'host-config',
  },
  {
    id: 'live-1',
    kind: 'local-listener',
    severity: 'high',
    title: 'A live MCP server is listening on port 8080',
    summary: 'Process "python3" is serving an MCP endpoint (Server-Sent Events endpoint) on 127.0.0.1:8080 right now.',
    pathway:
      'An MCP server is running on this host and can be driven by any AI client configured to reach it. ' +
      'Whatever tools it exposes are available to a model with no gateway in front.',
    dataDomains: ['network', 'unknown'],
    evidence: [{ location: '127.0.0.1:8080', detail: 'served by python3 (pid 48221)' }],
    control: 'mcp-gateway',
    layer: 'host-live',
  },
  {
    id: 'mcp-4',
    kind: 'mcp-server',
    severity: 'medium',
    title: 'An MCP server can browse the web on the model’s behalf',
    summary: '"puppeteer" grants an external AI model access to browser through Windsurf.',
    pathway:
      'The model can drive a headless browser to fetch and submit web content, which can be used to move data ' +
      'out of the environment without touching a monitored egress path.',
    dataDomains: ['browser'],
    evidence: [{ location: '~/.codeium/windsurf/mcp_config.json', detail: 'Server "puppeteer" (stdio)' }],
    control: 'mcp-gateway',
    layer: 'host-config',
  },
  {
    id: 'tool-1',
    kind: 'ai-tool',
    severity: 'info',
    title: 'Cursor is installed on this host',
    summary: 'Cursor is present. An AI code editor with MCP support and direct model access.',
    pathway: 'Cursor sends prompts to an AI provider. Without a gateway, what it sends is neither filtered nor audited.',
    dataDomains: ['network'],
    evidence: [{ location: 'Cursor', detail: 'installed (indicative — presence, not proof of use)' }],
    control: 'llm-gateway',
    layer: 'host-config',
  },
];

export function buildDemoScan(): ScanReport {
  const findings = attachRego([...demoFindings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  ));
  const counts = emptyCounts();
  for (const f of findings) counts[f.severity]++;

  return {
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, hostname: safeHost(), user: 'demo' },
    findings,
    counts,
    scanned: { hostConfig: true, hostLive: true, network: false },
    warnings: [],
    elapsedMs: 180,
  };
}

function safeHost(): string {
  try {
    return hostname();
  } catch {
    return 'this machine';
  }
}
