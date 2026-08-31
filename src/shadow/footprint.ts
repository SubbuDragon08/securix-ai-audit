/**
 * AI tool & agent-framework footprint — indicative context.
 *
 * This layer answers "how much AI is on this machine at all". On its own an
 * installed tool is not a leak, so these are low/info findings — but breadth
 * matters to a CISO ("this one host has five AI clients and two agent
 * frameworks"), and each tool is a potential carrier for the higher-severity
 * MCP and credential findings.
 *
 * Detection is presence-based (app bundles, per-user config directories) and
 * explicitly labelled indicative — a footprint is not proof of active use.
 */

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import type { Finding, Severity } from './types.js';

interface Tool {
  name: string;
  kind: 'ai-tool' | 'agent-framework';
  /** Any of these existing counts as present. */
  macApps?: string[];
  /** Home-relative paths (config/cache dirs), any platform. */
  homePaths?: string[];
  /** Windows: %LOCALAPPDATA%\Programs sub-dirs. */
  winPrograms?: string[];
  severity: Severity;
  note: string;
}

const TOOLS: Tool[] = [
  {
    name: 'Claude Desktop',
    kind: 'ai-tool',
    macApps: ['Claude.app'],
    homePaths: [join('.config', 'Claude')],
    winPrograms: ['Claude'],
    severity: 'info',
    note: 'A desktop LLM client that can host MCP servers.',
  },
  {
    name: 'Cursor',
    kind: 'ai-tool',
    macApps: ['Cursor.app'],
    homePaths: ['.cursor'],
    winPrograms: ['cursor'],
    severity: 'info',
    note: 'An AI code editor with MCP support and direct model access.',
  },
  {
    name: 'Windsurf',
    kind: 'ai-tool',
    macApps: ['Windsurf.app'],
    homePaths: [join('.codeium', 'windsurf')],
    winPrograms: ['Windsurf'],
    severity: 'info',
    note: 'An AI code editor (Codeium) with MCP support.',
  },
  {
    name: 'ChatGPT Desktop',
    kind: 'ai-tool',
    macApps: ['ChatGPT.app'],
    winPrograms: ['ChatGPT'],
    severity: 'info',
    note: 'A desktop client that sends prompts to OpenAI.',
  },
  {
    name: 'Claude Code',
    kind: 'ai-tool',
    homePaths: ['.claude'],
    severity: 'info',
    note: 'An agentic coding CLI with MCP support.',
  },
  {
    name: 'Continue',
    kind: 'ai-tool',
    homePaths: ['.continue'],
    severity: 'info',
    note: 'An IDE AI assistant with MCP support.',
  },
  {
    name: 'Aider',
    kind: 'ai-tool',
    homePaths: ['.aider', '.aider.conf.yml'],
    severity: 'low',
    note: 'An agentic coding tool that edits your repo via an LLM.',
  },
  {
    name: 'Ollama',
    kind: 'ai-tool',
    macApps: ['Ollama.app'],
    homePaths: ['.ollama'],
    winPrograms: ['Ollama'],
    severity: 'low',
    note: 'A local model runner — inference stays on-device but is ungoverned.',
  },
  {
    name: 'CrewAI',
    kind: 'agent-framework',
    homePaths: ['.crewai'],
    severity: 'low',
    note: 'A multi-agent framework that can act autonomously.',
  },
  {
    name: 'AutoGen',
    kind: 'agent-framework',
    homePaths: ['.autogen'],
    severity: 'low',
    note: 'A multi-agent orchestration framework.',
  },
];

export interface FootprintOptions {
  home?: string;
}

function macAppRoots(home: string): string[] {
  return ['/Applications', join(home, 'Applications')];
}

function present(tool: Tool, home: string): boolean {
  const p = platform();
  if (p === 'darwin' && tool.macApps) {
    for (const root of macAppRoots(home)) {
      if (tool.macApps.some((a) => existsSync(join(root, a)))) return true;
    }
  }
  if (p === 'win32' && tool.winPrograms) {
    const base = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    if (tool.winPrograms.some((w) => existsSync(join(base, 'Programs', w)))) return true;
  }
  if (tool.homePaths?.some((rel) => existsSync(join(home, rel)))) return true;
  return false;
}

let seq = 0;

export function discoverFootprint(opts: FootprintOptions = {}): Finding[] {
  const home = opts.home ?? homedir();
  const findings: Finding[] = [];

  for (const tool of TOOLS) {
    if (!present(tool, home)) continue;
    const isFramework = tool.kind === 'agent-framework';
    findings.push({
      id: `tool-${++seq}`,
      kind: tool.kind,
      severity: tool.severity,
      title: `${tool.name} is installed on this host`,
      summary: `${tool.name} is present. ${tool.note}`,
      pathway: isFramework
        ? `${tool.name} can run autonomous agents that call external models and tools with no central oversight.`
        : `${tool.name} sends prompts to an AI provider. Without a gateway, what it sends is neither filtered nor audited.`,
      dataDomains: ['network'],
      evidence: [{ location: tool.name, detail: 'installed (indicative — presence, not proof of use)' }],
      control: isFramework ? 'both' : 'llm-gateway',
      layer: 'host-config',
    });
  }
  return findings;
}
