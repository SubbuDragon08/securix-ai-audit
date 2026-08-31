# Planning — Shadow AI & Agent Surface Scanner (Tab 2)

Architectural plan for adding a **Shadow AI & Agent Surface Scanner** as a second
tab in the existing SecuriX AI Audit desktop app. **No code yet** — this is for
approval first, per the build process.

Goal: let a CISO / Head of IT run one click and *see the concrete pathways by
which their IP and client data can leak to external AI providers* on a machine
and network they control — then understand that an **LLM Gateway + Managed MCP
Gateway (SecuriX)** is how you take back control of that traffic.

---

## 1. What changes vs. the original (Gemini) prompt, and why

The idea is strong. Four things in the original spec would either not work,
mislead a technical buyer, or damage the product. Corrected here.

| Original spec | Problem | This plan |
|---|---|---|
| Frontend in **Next.js** | Our app is plain HTML/CSS/JS behind a hardened Electron shell with **zero runtime deps** and CSP `connect-src 'none'`. Next.js adds hundreds of deps and a build server, gutting the auditability that a security tool sells on. | Reuse the existing pattern. Tab 2 is more HTML/CSS/JS. No framework, no new runtime deps. |
| Detect egress by matching **netstat → `api.openai.com`** | `netstat`/`lsof` show **IPs, not hostnames**. Verified: openai→Cloudflare, google→Google edge, **no PTR records** — you cannot map a live connection back to the provider. Snapshot-only, ephemeral. | Detect provider access from **configuration** (keys, client configs), which is reliable and static. Drop live-connection sniffing. |
| Read **other processes' env vars** (`LANGCHAIN_API_KEY`) | OS-blocked: Windows needs debug privilege, macOS SIP forbids it, Linux `/proc/pid/environ` is own-process-only. `tasklist` shows no command line on Windows. | Read **the current user's own** configs and dotfiles (which we're allowed to). Detect key *presence*, never the value. |
| Subnet sweep labelled **"passive"** | A multi-host port sweep is **active reconnaissance**. Calling it passive to a CISO is a credibility-ender, and a silent scan reads as malware. | Labelled honestly as an **authorised active scan**, behind a consent gate, scoped to the local /24, throttled. |

**Net effect:** the flagship signal moves from unreliable network sniffing to
**MCP client-config discovery** — which is more reliable, catches the common
case Gemini's approach misses (stdio-transport servers aren't on any port), and
directly answers "what internal data is reachable by an external LLM."

---

## 2. The detection design — three layers, honest about each

Findings are gathered in three layers of decreasing reliability and increasing
blast radius. The report states which layer each finding came from, so we never
oversell.

### Layer A — This host, configuration (reliable, always runs)

No network, no consent gate needed — it only reads the current user's own files.
This is the layer that produces the "aha," and it works on a jump host or a dev
box even when nothing is running live.

1. **MCP client-config discovery — the headline signal.**
   Parse the MCP server declarations in each installed AI client's own config:
   - Claude Desktop — `~/Library/Application Support/Claude/claude_desktop_config.json` (mac), `%APPDATA%\Claude\...` (win), `~/.config/Claude/...` (linux)
   - Cursor — `~/.cursor/mcp.json` + project `.cursor/mcp.json`
   - VS Code / Copilot — `.vscode/mcp.json`, user settings
   - Windsurf / Codeium — `~/.codeium/windsurf/mcp_config.json`
   - Claude Code — `~/.claude.json`, project `.mcp.json`
   - Cline, Continue, and similar

   Each declaration reveals: the **server name**, **transport** (stdio/http/sse),
   the **command + args** (for stdio — e.g. a `postgres` server pointing at
   `prod-db.internal:5432`), the **URL** (for http), and **which data domain it
   grants** (filesystem paths, database DSNs, GitHub/Jira tokens, a browser).
   *(Verified: a `claude_desktop_config.json` already exists on this dev machine.)*

   The finding a CISO sees: *"Cursor on this host has an MCP server exposing
   `prod-db.internal` to Anthropic's models — your customer data is one prompt
   from leaving your control."*

2. **Provider-credential presence (name + location only, never the value).**
   Look for the *existence* of provider keys in the user's own dotfiles and
   common project `.env` files: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
   `GOOGLE_API_KEY`, `LANGCHAIN_API_KEY`, etc.
   **Hard privacy rule: we record the variable name and file path, we never read,
   store, display, or transmit the secret value.** This is a governance finding
   ("an unmanaged, direct-to-provider key exists here, outside any gateway"), not
   a secret-harvesting operation. Getting this wrong would make the tool itself
   the threat, so it is a design invariant enforced in code and covered by tests.

3. **AI tool & agent-framework footprint (indicative).**
   Presence of desktop LLM apps (Claude, ChatGPT, Cursor, Copilot, Cody) and
   agent frameworks (LangChain, CrewAI, LlamaIndex, AutoGPT) via installed-app
   detection and project lockfiles/markers. Marked "indicative," not definitive,
   because a footprint is not proof of active use.

### Layer B — This host, live (reliable, always runs)

4. **Localhost listening servers.**
   Enumerate ports this user's processes are LISTENING on
   (`lsof -iTCP -sTCP:LISTEN` / `netstat -ano` + PID→process — we can see our own
   user's processes), then fingerprint `127.0.0.1:<port>` for an MCP HTTP/SSE
   endpoint or a known agent dev server. Catches servers running right now and
   ties each to a process name.

### Layer C — Local network (authorised, gated, throttled)

5. **Exposed MCP/agent servers on neighbouring hosts.**
   The **local /24 sweep** — only the subnet this machine is attached to
   (e.g. `172.16.27.0/24`, 254 hosts), only the target ports (3000, 3001, 5000,
   8000, 8080), **throttled** (~20 concurrent, short timeouts), **abortable**,
   and **only after the operator ticks "I am authorised to scan this network."**
   Open ports are HTTP-fingerprinted for MCP JSON-RPC / SSE signatures.

   Honest limitation stated in the report: this finds only **network-bound
   HTTP-transport** MCP servers — not localhost-only or stdio ones. It is the
   cross-machine layer, deliberately narrow.

### Explicit non-goals (stated in the report and the privacy doc)

- No reading/exfiltrating of secret values.
- No deep packet inspection or continuous egress monitoring (needs eBPF/WinPcap — excluded by design).
- No scanning beyond the local /24; no enterprise-wide sweep.
- No endpoint agents on employee machines.
- Scan results **stay on the machine** — nothing is sent to SecuriX. (The tool keeps its no-backend posture; only the tenant-audit tab uses the network, and only to the vendors' own APIs.)

---

## 3. The "Aha!" → SecuriX bridge

Each finding maps to a concrete data-leak pathway and the SecuriX control that
closes it, with a **draft** Open Policy Agent (Rego) preview.

| Finding | The leak pathway (what the CISO sees) | SecuriX control | Draft artifact |
|---|---|---|---|
| Direct provider API keys on host | Prompts + data go straight to OpenAI/Anthropic with no DLP, no audit, no policy | **LLM Gateway** — route all provider traffic through one policy-enforced egress; keys held centrally | Rego: allow/deny + DLP redaction on prompts |
| MCP server exposing internal DB/filesystem to an external model | An external LLM can read `prod-db` / source / mailboxes on demand | **Managed MCP Gateway** — broker every MCP tool call with auth, authz, audit | Rego: gate `tools/call` by tool + data domain |
| Unauthenticated MCP endpoint on the network | Any host on the LAN can drive that server's tools | MCP Gateway + network policy | Rego: require identity before `tools/list` |
| Shadow agent framework running unmanaged | Autonomous agent taking actions with no oversight | LLM Gateway + MCP Gateway | Rego: draft-only guardrails |

Every Rego block is labelled **"Preview — SecuriX enforces this in Draft-Only
mode first, so nothing breaks."** — matching the datasheet's non-disruptive
promise. The free tool *shows* the policy; SecuriX *enforces* it.

**The meta-finding** that closes every report: *"You have N direct paths to
external AI with no central policy or audit. SecuriX is the control plane."* →
CTA to securix.app.

---

## 4. Architecture inside the existing app

Reuses the current hardened pattern exactly. **Pure logic in `src/shadow/`
(unit-testable with no tenant, like `normalize.ts`); Electron `main` does IPC +
`child_process` + sockets; the sandboxed renderer only renders.** The renderer
keeps CSP `connect-src 'none'` — it never scans; all network/OS work happens in
main. This preserves the security posture that makes the tool credible.

```
src/shadow/
  types.ts        Finding, Severity, ScanReport, DataDomain
  scanner.ts      orchestrator → structured ScanReport (mirrors run.ts)
  mcpConfigs.ts   Layer A1: MCP client-config discovery (the gold mine)
  credentials.ts  Layer A2: provider-key PRESENCE (name+path only)
  footprint.ts    Layer A3: AI app / framework footprint
  localPorts.ts   Layer B: localhost LISTEN enumeration + fingerprint
  netSweep.ts     Layer C: authorised, throttled /24 sweep + MCP fingerprint
  rego.ts         draft Rego preview per finding
  report.ts       single-file HTML "Agent Risk Report" (mirrors src/report.ts)

electron/main.ts   + new IPC handlers (below), calling src/shadow/*
electron/preload.ts + new bridge surface (below)
ui/                 add a tab bar; Tab 1 = existing audit, Tab 2 = scanner
```

Reuses existing `src/http.ts` (timeouts, abort, retry) and `src/log.ts` (sink →
IPC progress) so the scanner streams progress to the UI exactly like the audit
side already does.

### New IPC (main), all inputs re-validated in main

- `shadow:getNetwork` → the detected local subnet + host count, to render in the consent gate.
- `shadow:scanHost` → Layers A + B. **No consent gate** (own machine only). Runs on click.
- `shadow:scanNetwork` → Layer C. **Refuses unless `{ authorized: true }` is passed and re-validated**, and clamps the range to the local /24.
- `shadow:cancel` → aborts an in-flight scan (reuses the AbortController pattern).
- `shadow:exportReport` → writes the HTML Agent Risk Report (0600), like `app:saveReportAs`.

### Preload bridge additions (narrow, typed)

`shadow.getNetwork()`, `shadow.scanHost()`, `shadow.scanNetwork(opts)`,
`shadow.cancel()`, `shadow.exportReport()`, `shadow.onProgress(cb)` — same
contextBridge discipline as the audit API.

### Two-tier consent (important UX + safety)

- **Host scan (Layers A+B): safe, one click.** Own machine, no network reconnaissance. Gives real value even if the user never runs the network scan.
- **Network scan (Layer C): gated.** A screen naming the exact range and host count (*"probe up to 254 machines on `172.16.27.0/24` — your SOC may see this"*) with the authorisation checkbox. The scan cannot start without it.

### UI

A simple tab bar under the header: **Tenant Audit** | **Shadow Scanner**. Tab 2:
brief framing text → "Run host scan" (instant) → optional "Also scan my local
network" (gated) → a scannable risk dashboard grouped by severity
(*"Critical: 3 data-exfiltration paths to external AI"*), each finding as a card
with the pathway, the SecuriX control, and the Rego draft. No raw terminal logs.
Export → shareable HTML report the CISO forwards internally (that forward is the
lead loop).

---

## 5. Testing (no real agents, no live network needed)

- `test/fixtures/mcp-configs/` — real-shaped Claude/Cursor/VS Code configs (stdio + http + a DB-exposing server) → unit-test `mcpConfigs.ts` parsing and data-domain classification.
- `test/fixtures/dotenv/` — files with key *names* → assert `credentials.ts` reports name+path and **never** the value (a guard test that fails if a secret value ever appears in output).
- `mock-agent-traffic.mjs` — a **zero-dependency** `node:http` server (not Express — we keep zero runtime deps) that emits MCP SSE headers on a port → integration-test the localhost fingerprinter.
- `netSweep.ts` — unit-test range math, throttle/concurrency cap, and abort; point it at the mock server on loopback. Never hits a real LAN in CI.
- Wire into the existing `node --test` suite and CI, alongside the audit tests.

---

## 6. Honesty & positioning guardrails (so a CISO trusts it)

Combining a tenant-audit tool with a network scanner means the whole product is
no longer "nothing leaves your machine." The plan bakes in honesty:

- The scanner tab and the marketing say plainly **"this scans your local network"** — no "passive" language.
- Consent gate names the exact scope before any host is touched.
- Secret *values* are never read — enforced in code and by a test.
- The report states each finding's layer and its limitations (e.g. "network sweep sees only HTTP-transport servers").
- Scan results never leave the machine.

Consequence to accept: a scanner won't qualify for **free** SignPath Foundation
signing. Windows signing moves to a ~€30/yr paid cert (Certum) or Azure Trusted
Signing. Not a blocker; just no longer the free path.

---

## 7. Proposed build phases (each independently shippable & testable)

1. **Types + host scan (Layers A+B)** — `types.ts`, `mcpConfigs.ts`, `credentials.ts`, `footprint.ts`, `localPorts.ts`, `scanner.ts` + fixtures/tests. Pure `src/`, no UI yet. *This alone is a working, valuable scanner.*
2. **UI: tab bar + host-scan dashboard** — wire IPC, render findings, severity grouping.
3. **Rego drafts + HTML report export + SecuriX CTAs** — the bridge.
4. **Layer C network sweep** — consent gate, throttled `/24`, fingerprinting, abort. Gated last so 1–3 are provably safe first.
5. **Signing/packaging update** — paid-cert path, docs.

---

## Open questions for your approval

1. **Provider-key detection depth.** Home dir + dotfiles + shell rc + common project `.env` locations only (bounded, fast) — or a wider scan? I recommend **bounded** — a full-disk secret scan is invasive, slow, and scary. *(name+path only either way.)*
2. **Report brand.** Reuse the audit report's look for one consistent "SecuriX" artifact — agreed?
3. **Phase 1 first?** I'd build phases 1–2 (host scan + UI, the safe high-value core), get your eyes on real output from *your* machine, then do the network sweep. Good?

On approval I'll start with Phase 1 (`src/shadow/` + fixtures + tests), nothing
touching the network until the gated Phase 4.
