/**
 * Provider-credential presence — bounded, name-and-path only.
 *
 * A direct-to-provider API key sitting on a developer's machine means prompts
 * and data go straight to OpenAI / Anthropic / Google with no gateway in
 * between: no DLP on the prompt, no audit trail, no policy. That is a
 * governance finding worth surfacing.
 *
 * PRIVACY INVARIANT (enforced by a test): this module records that a key
 * *exists*, which provider it belongs to, and the file it lives in. It never
 * reads, stores, returns, logs, or transmits the secret *value*. The matcher is
 * written to key on the variable *name* only; nothing after the `=` is ever
 * captured. If that ever changes, `test/shadow-privacy.test.mjs` fails.
 *
 * Scope is deliberately bounded to the user's own dotfiles and `.env` files in
 * a short list of common dev directories — never a full-disk secret sweep,
 * which would be slow, invasive, and frightening.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Evidence, Finding } from './types.js';
import { commonDevRoots } from './mcpConfigs.js';

/** Provider → a regex that matches its key *name* only. */
const PROVIDERS: Array<{ provider: string; re: RegExp }> = [
  { provider: 'OpenAI', re: /\bOPENAI_API_KEY\b|\bOPENAI_KEY\b/ },
  { provider: 'Azure OpenAI', re: /\bAZURE_OPENAI_API_KEY\b|\bAZURE_OPENAI_KEY\b/ },
  { provider: 'Anthropic', re: /\bANTHROPIC_API_KEY\b|\bCLAUDE_API_KEY\b/ },
  { provider: 'Google Gemini', re: /\bGEMINI_API_KEY\b|\bGOOGLE_API_KEY\b|\bGOOGLE_GENERATIVE_AI_API_KEY\b/ },
  { provider: 'Mistral', re: /\bMISTRAL_API_KEY\b/ },
  { provider: 'Cohere', re: /\bCOHERE_API_KEY\b/ },
  { provider: 'Groq', re: /\bGROQ_API_KEY\b/ },
  { provider: 'Perplexity', re: /\bPERPLEXITY_API_KEY\b/ },
  { provider: 'Together', re: /\bTOGETHER_API_KEY\b/ },
  { provider: 'Replicate', re: /\bREPLICATE_API_TOKEN\b/ },
  { provider: 'Hugging Face', re: /\bHUGGING?FACE(?:HUB)?_(?:API_)?(?:TOKEN|KEY)\b|\bHF_TOKEN\b/ },
  { provider: 'LangChain / LangSmith', re: /\bLANG(?:CHAIN|SMITH)_API_KEY\b/ },
  { provider: 'OpenRouter', re: /\bOPENROUTER_API_KEY\b/ },
  { provider: 'DeepSeek', re: /\bDEEPSEEK_API_KEY\b/ },
];

/** Files that commonly hold exported keys, relative to home. */
const HOME_FILES = [
  '.zshrc',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zprofile',
  '.zshenv',
  join('.config', 'fish', 'config.fish'),
  '.netrc',
];

/** Env filenames to check in each dev root (shallow, root only). */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.production'];

export interface CredentialScanOptions {
  home?: string;
  /** Extra absolute files to inspect (tests inject fixtures). */
  extraFiles?: string[];
}

/**
 * Read a file and return the set of provider key *names* present. Only the
 * matched variable name is ever returned — never the line, never the value.
 */
function keysInFile(path: string): Array<{ provider: string; name: string }> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  // Cap the read surface; a huge file is not a dotfile we care about.
  if (text.length > 2_000_000) text = text.slice(0, 2_000_000);

  const hits: Array<{ provider: string; name: string }> = [];
  const seen = new Set<string>();
  for (const { provider, re } of PROVIDERS) {
    const m = re.exec(text);
    if (m && !seen.has(provider)) {
      seen.add(provider);
      // m[0] is the matched NAME token only — never a value.
      hits.push({ provider, name: m[0] });
    }
  }
  return hits;
}

let seq = 0;

export function discoverProviderKeys(opts: CredentialScanOptions = {}): Finding[] {
  const home = opts.home ?? homedir();

  const files = [
    ...HOME_FILES.map((f) => join(home, f)),
    ...commonDevRoots(home).flatMap((root) => ENV_FILES.map((f) => join(root, f))),
    ...(opts.extraFiles ?? []),
  ];

  // provider → evidence (which files), so we emit one finding per provider.
  const byProvider = new Map<string, { names: Set<string>; evidence: Evidence[] }>();

  for (const file of files) {
    for (const { provider, name } of keysInFile(file)) {
      let entry = byProvider.get(provider);
      if (!entry) {
        entry = { names: new Set(), evidence: [] };
        byProvider.set(provider, entry);
      }
      entry.names.add(name);
      // Dedupe evidence by path.
      if (!entry.evidence.some((e) => e.location === file)) {
        entry.evidence.push({ location: file, detail: `${name} is set here (value not read)` });
      }
    }
  }

  const findings: Finding[] = [];
  for (const [provider, { names, evidence }] of byProvider) {
    findings.push({
      id: `key-${++seq}`,
      kind: 'provider-key',
      severity: 'high',
      title: `Direct ${provider} API access is configured on this host`,
      summary: `An ${provider} API key (${[...names].join(', ')}) is present, so this machine can call ${provider} with no gateway in between.`,
      pathway:
        `Any script or agent on this host can send prompts — and whatever data they include — straight to ${provider} ` +
        `using this key. There is no DLP on the prompt, no central audit of what was sent, and no policy that can stop a leak.`,
      dataDomains: ['secrets', 'network'],
      evidence,
      control: 'llm-gateway',
      layer: 'host-config',
    });
  }
  return findings;
}
