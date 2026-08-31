/**
 * Shadow scanner — detection logic and the privacy invariant, no live machine.
 *
 * Detectors are pointed at fixtures via their injection options (`home`,
 * `extraGlobalPaths`, `extraFiles`, `scanProjects:false`) so the tests never
 * read the real machine's configs or dotfiles and are deterministic.
 *
 *   node --test test/shadow-scanner.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverMcpServers } from '../dist/shadow/mcpConfigs.js';
import { discoverProviderKeys } from '../dist/shadow/credentials.js';
import { attachRego } from '../dist/shadow/rego.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'shadow');

// Real-looking secret values that appear in the fixtures. The privacy test
// asserts NONE of these ever appear in scanner output.
const SECRET_VALUES = [
  'ghp_FAKE1234567890abcdefFAKE',
  'S3cretP@ss',
  'sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234567890',
  'sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234567890',
];

function mcp() {
  return discoverMcpServers({
    home: '/nonexistent-home',
    scanProjects: false,
    extraGlobalPaths: [
      { client: 'Claude Desktop', path: join(FIX, 'claude_with_servers.json'), serversKey: 'mcpServers' },
      { client: 'VS Code', path: join(FIX, 'vscode_mcp.json'), serversKey: 'servers' },
    ],
  });
}

// ---------------------------------------------------------------------------
// MCP config discovery — the headline detector
// ---------------------------------------------------------------------------

test('discovers every declared MCP server across config shapes', () => {
  const f = mcp();
  // 4 in the Claude file + 1 in the VS Code `servers` file.
  assert.equal(f.length, 5);
  assert.ok(f.every((x) => x.kind === 'mcp-server' && x.layer === 'host-config'));
});

test('a database server pointing at an internal host is CRITICAL', () => {
  const pg = mcp().find((x) => x.summary.includes('postgres-prod'));
  assert.ok(pg, 'postgres server should be found');
  assert.equal(pg.severity, 'critical');
  assert.ok(pg.dataDomains.includes('database'));
  assert.ok(/internal or production/i.test(pg.pathway), 'must call out internal exposure');
});

test('a filesystem server is high severity and classified as filesystem', () => {
  const fs = mcp().find((x) => x.summary.includes('filesystem'));
  assert.equal(fs.severity, 'high');
  assert.ok(fs.dataDomains.includes('filesystem'));
});

test('an env block is reported by NAME only, never value', () => {
  const gh = mcp().find((x) => x.summary.includes('github'));
  assert.ok(gh.dataDomains.includes('secrets'), 'env presence adds the secrets domain');
  const evidence = JSON.stringify(gh.evidence);
  assert.ok(evidence.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), 'the variable name is shown');
  assert.ok(!evidence.includes('ghp_FAKE'), 'the token VALUE must never appear');
});

test('a connection string with a password is redacted in the target', () => {
  const pg = mcp().find((x) => x.summary.includes('postgres-prod'));
  const blob = JSON.stringify(pg);
  assert.ok(!blob.includes('S3cretP@ss'), 'the DB password must be redacted');
});

test('classifies http/sse transports from url-based servers', () => {
  const sse = mcp().find((x) => x.summary.includes('remote-sse'));
  assert.ok(sse, 'sse server found');
  // internal 10.x host → escalated
  assert.ok(['high', 'critical'].includes(sse.severity));
});

// ---------------------------------------------------------------------------
// Credential presence — name + path only
// ---------------------------------------------------------------------------

test('detects provider keys by name without reading the value', () => {
  const keys = discoverProviderKeys({
    home: '/nonexistent-home',
    extraFiles: [join(FIX, 'fake-home-dotenv')],
  });
  const providers = keys.map((k) => k.title);
  assert.ok(providers.some((t) => t.includes('OpenAI')));
  assert.ok(providers.some((t) => t.includes('Anthropic')));

  const blob = JSON.stringify(keys);
  assert.ok(blob.includes('OPENAI_API_KEY'), 'the variable name is surfaced');
  assert.ok(!blob.includes('sk-proj-FAKE'), 'the OpenAI value must never appear');
  assert.ok(!blob.includes('sk-ant-api03'), 'the Anthropic value must never appear');
});

// ---------------------------------------------------------------------------
// The privacy invariant — the whole tool's most important guarantee
// ---------------------------------------------------------------------------

test('PRIVACY: no secret value from any fixture ever reaches scanner output', () => {
  const findings = [
    ...mcp(),
    ...discoverProviderKeys({ home: '/nonexistent-home', extraFiles: [join(FIX, 'fake-home-dotenv')] }),
  ];
  const blob = JSON.stringify(attachRego(findings));
  for (const secret of SECRET_VALUES) {
    assert.ok(!blob.includes(secret), `secret value leaked into output: ${secret.slice(0, 12)}…`);
  }
});

// ---------------------------------------------------------------------------
// Rego previews
// ---------------------------------------------------------------------------

test('every finding gets a labelled draft Rego preview', () => {
  const withRego = attachRego(mcp());
  for (const f of withRego) {
    assert.ok(f.rego, 'each finding has a rego draft');
    assert.ok(f.rego.startsWith('# DRAFT'), 'the draft is clearly labelled');
    assert.ok(/package securix\./.test(f.rego), 'it is a SecuriX-namespaced policy');
  }
});
