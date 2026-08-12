# AI Audit Lens

**See every Copilot and Gemini prompt in your tenant — without sending a single byte to anyone.**

A free, open-source, single-command utility for enterprise IT admins. It signs into
*your* Microsoft 365 or Google Workspace tenant with *your* admin credentials, pulls the
AI prompt audit logs, and writes a self-contained HTML dashboard to your desktop.

```
npx ai-audit-lens --demo          # see the report first, with synthetic data
```

![The generated dashboard](docs/screenshot.png)

---

## Why this exists

Most organisations turned on Microsoft 365 Copilot or Gemini for Workspace without a
way to answer three questions their auditors are about to ask:

1. **Who is actually using it?** Licence counts are not usage.
2. **What tenant data is the assistant reading?** Copilot grounds answers on SharePoint,
   OneDrive, and mailbox content — the audit log names those files.
3. **Is it touching classified material?** Sensitivity labels on grounded resources are
   in the log, and nobody is looking at them.

The data is already in Purview and the Admin SDK. The gap is that getting at it means
an async Graph API, a paginated Reports API, and a spreadsheet afternoon. This closes
that gap in one command.

## Zero-trust by construction

This tool is asking for audit-read across your whole tenant, so it should have to earn that.

| Property | How it is enforced |
|---|---|
| **No third-party server** | There is no backend. The CLI contacts exactly six hosts, all first-party: `login.microsoftonline.com` (or `--ms-authority`), `graph.microsoft.com`, `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com` (one cosmetic "signed in as" lookup), and `admin.googleapis.com`. Verify with `--verbose` or a proxy. |
| **No secrets on disk** | Tokens live in process memory and die with the process. `--save-session` opts into a `0600` cache; it is off by default because a Global Admin refresh token on disk is a standing credential, not a one-shot report. |
| **Read-only scopes** | `AuditLogsQuery.Read.All` and `admin.reports.audit.readonly`. Neither can mutate tenant state. |
| **PKCE on every flow** | S256 code challenges, constant-time `state` validation, loopback listener bound to `127.0.0.1` and torn down after one callback. |
| **You own the app registration** | No shared multi-tenant app ID. You register the client, you consent to it, you can delete it afterwards. |
| **No prompt content** | Prompt and response bodies are never mapped into the report. `--include-raw` attaches full payloads to the `--json` stream only; the HTML never embeds them. |
| **Zero dependencies** | The runtime `dependencies` block in `package.json` is empty. Nothing to audit but this repo. |

The generated HTML embeds your audit records, so it is written `0600` and should be
handled with the same rules as the audit log itself.

**One honest caveat about the report:** the HTML loads Tailwind from
`cdn.tailwindcss.com` and Chart.js from `cdn.jsdelivr.net` when you open it, both pinned
to exact versions. Your audit data is never sent anywhere — these are inbound script
fetches — but they are two requests your browser makes to hosts you did not choose. Open
the file on an air-gapped machine and it still renders: you get the tables, the numbers,
and the KPI tiles, with the charts absent. If you would rather have no external requests
at all, vendor both libraries into `TEMPLATE` in [`src/report.ts`](src/report.ts).

---

## Setup

Pick one or both clouds. Each takes about two minutes, once.

<details open>
<summary><b>Microsoft 365 Copilot — Entra ID app registration</b></summary>

**Prerequisites:** a licence that includes Purview Audit (most M365 E3/E5 and Business
Premium plans), unified auditing enabled, and an account with **Audit Reader**,
**Audit Manager**, or **Global Reader**.

1. [Entra admin center](https://entra.microsoft.com) → **Applications** → **App registrations** → **New registration**.
2. Name it `AI Audit Lens`. Supported account types: **Single tenant**. Skip the redirect URI. **Register**.
3. Copy the **Application (client) ID** and **Directory (tenant) ID** from the Overview page.
4. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**
   → search `AuditLogsQuery` → tick **AuditLogsQuery.Read.All** → **Add**.
5. Click **Grant admin consent for \<your tenant\>**. This is required; the tool cannot consent for you.
6. **Authentication** → scroll to **Advanced settings** → set **Allow public client flows** to **Yes** → **Save**.

```bash
npx ai-audit-lens --ms-tenant <tenant-id> --ms-client-id <client-id>
```

You will get a device code to enter at `microsoft.com/devicelogin`. Prefer a browser
redirect instead? Add `--ms-auth browser`, and register
`http://localhost:3000/callback` as a **Mobile and desktop applications** redirect URI
in step 2.

</details>

<details open>
<summary><b>Google Gemini for Workspace — OAuth client</b></summary>

**Prerequisites:** a Gemini for Workspace licence (Gemini audit logging began
**2025-06-20**; earlier windows return nothing), and a **Super Admin** account.

1. [Google Cloud Console](https://console.cloud.google.com) → create or select a project.
2. **APIs & Services** → **Library** → search **Admin SDK API** → **Enable**.
3. **APIs & Services** → **OAuth consent screen** → **Internal** → fill in the app name and support email.
4. On **Scopes**, add `https://www.googleapis.com/auth/admin.reports.audit.readonly`.
5. **Credentials** → **Create credentials** → **OAuth client ID** → Application type: **Desktop app**.
6. Copy the **Client ID** and **Client secret**.

```bash
npx ai-audit-lens --google-client-id <id> --google-client-secret <secret>
```

Your browser opens for consent; the callback returns to a loopback listener on this machine.

> Google's client secret for a Desktop app is [not treated as confidential](https://developers.google.com/identity/protocols/oauth2#installed) —
> it identifies the app, it does not authorise it. This tool never writes it to disk.

</details>

Both configured? Run them together:

```bash
npx ai-audit-lens --provider both \
  --ms-tenant "$AZURE_TENANT_ID" --ms-client-id "$AZURE_CLIENT_ID" \
  --google-client-id "$GOOGLE_CLIENT_ID" --google-client-secret "$GOOGLE_CLIENT_SECRET"
```

Credentials can also come from the environment: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

---

## Usage

```
ai-audit-lens [options]
```

| Option | Default | Notes |
|---|---|---|
| `--days <n>` | `7` | History window. Both clouds retain ~180 days. |
| `--provider <p>` | auto | `microsoft`, `google`, or `both`. Defaults to whatever is configured. |
| `--out <path>` | `./ai-audit-report-<date>.html` | |
| `--timeout <minutes>` | `15` | Overall deadline, including the Purview wait. |
| `--max-records <n>` | `50000` | Per-provider collection cap. |
| `--no-open` | | Do not launch the browser at the end. |
| `--json` | | Also emit normalised events to stdout (stderr carries the progress log, so `> events.json` is clean). |
| `--pseudonymize` | | Replace identities with per-run aliases and drop IPs. For works-council / GDPR contexts. The mapping is never written anywhere. |
| `--include-raw` | | Attach untouched provider payloads to `--json`. Not embedded in the HTML — raw records dwarf the report and would make it unopenable. |
| `--save-session` | | Cache refresh tokens `0600` under `~/.ai-audit-lens`. |
| `--verbose` | | Log every URL, status code, and retry decision. |
| `--demo` | | Synthetic report. No network, no auth. |

### About the Purview wait

The Microsoft side is an **asynchronous** API: you create a query, then poll it until the
service has finished searching. On a small tenant that is under a minute. On a large one
it is commonly 5–20 minutes, and it is not unusual for a 7-day query to exceed the
15-minute default deadline. That is a property of Purview, not of this tool.

When the deadline hits, the query keeps running server-side and the tool prints its id:

```bash
ai-audit-lens --provider microsoft --ms-query-id 168ec429-084b-a489-90d8-504a87846305
```

That resumes from the finished query and skips the wait entirely. Raise `--timeout 30`
if you would rather just wait it out.

### Why `operationFilters` and not `recordTypeFilters`

Filtering the unified audit log for Copilot looks like it should use
`recordTypeFilters: ["copilotInteraction"]`. It does not work: that property is typed as
the Graph `auditLogRecordType` enum, and **that enum has no Copilot member in v1.0** —
sending one returns `400`. Copilot records are selected by `operationFilters` instead
(`CopilotInteraction` for the core surfaces, `AIAppInteraction` for newer agent
surfaces), which is an unconstrained string collection.

If Microsoft renames these, override without waiting for a release:

```bash
ai-audit-lens --ms-operations CopilotInteraction,AIAppInteraction,SomeNewOperation
```

The same escape hatch exists for Google: `--google-apps gemini_in_workspace_apps,...`.

---

## What the report shows

A single HTML file, openable offline (Tailwind and Chart.js load from CDN; everything
else is inline), that works in light and dark mode:

- **KPI tiles** — total interactions, active users, busiest day, and how many
  interactions were *grounded on tenant data* with a count of those touching
  sensitivity-labelled content.
- **Prompt volume over time** — daily interactions, split by platform when both are present.
- **Top users** — the ten heaviest users.
- **Surfaces** and **Activity types** — where the assistant was invoked and what it was asked to do.
- **Interaction log** — searchable, sortable, paginated, with the grounded resources per
  row and CSV export (generated in-browser; nothing is uploaded).

Every filter re-scopes the whole page, so the charts and the table never disagree.

---

## Building a distributable executable

Three options, in the order most people should reach for them.

### 1. Bun — a true single-file binary (recommended)

Bun embeds its own runtime, so the recipient needs nothing installed. This is the right
choice for a tool you hand to an admin who will not run `npm install`.

```bash
npm install                                 # dev deps only; there are no runtime deps
npm run build:bun                           # current platform -> dist-bin/ai-audit-lens
node scripts/build-binaries.mjs             # all platforms
node scripts/build-binaries.mjs windows-x64 linux-x64   # or pick targets
```

Targets: `darwin-arm64`, `darwin-x64`, `windows-x64`, `linux-x64`, `linux-arm64`.
Output lands in `dist-bin/` as `ai-audit-lens-<version>-<platform>[.exe]`. Expect ~57 MB
for a native build and ~100–110 MB for cross-compiled targets, which carry unstripped
debug symbols. That is the embedded Bun runtime; it does not vary with your code. Compress
before distributing — these gzip to roughly a third.

**Signing matters more than the build.** An unsigned binary downloaded from the internet
is exactly the thing you are teaching admins not to run:

```bash
# macOS — needs an Apple Developer ID
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: Your Org (TEAMID)" dist-bin/ai-audit-lens-0.1.0-macos-arm64
xcrun notarytool submit dist-bin/ai-audit-lens-0.1.0-macos-arm64.zip \
  --apple-id you@example.com --team-id TEAMID --wait
xcrun stapler staple dist-bin/ai-audit-lens-0.1.0-macos-arm64

# Windows — needs an EV or OV code-signing certificate
signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 \
  /a dist-bin/ai-audit-lens-0.1.0-windows-x64.exe
```

Ship SHA-256 sums alongside the downloads:

```bash
shasum -a 256 dist-bin/* > dist-bin/SHA256SUMS.txt
```

### 2. Node SEA — no Bun, but Node 20+ on the build machine

Node's Single Executable Application support needs a **CommonJS** entry, which is what
`npm run bundle` produces.

```bash
npm run bundle                              # -> build/ai-audit-lens.cjs (~94 KB)
cat > sea-config.json <<'JSON'
{ "main": "build/ai-audit-lens.cjs", "output": "build/sea-prep.blob", "disableExperimentalSEAWarning": true }
JSON
node --experimental-sea-config sea-config.json
cp "$(command -v node)" build/ai-audit-lens
npx postject build/ai-audit-lens NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

On macOS you must strip the existing signature before injecting (`codesign --remove-signature`)
and re-sign afterwards.

### 3. `pkg` — legacy, only if you are pinned to it

The original `vercel/pkg` is archived and does not handle modern ESM. Use the maintained
fork against the CommonJS bundle:

```bash
npm run bundle
npx @yao-pkg/pkg build/ai-audit-lens.cjs \
  --targets node20-macos-arm64,node20-win-x64,node20-linux-x64 --out-path dist-bin
```

### Or just publish to npm

`npx` is the lowest-friction path for anyone who already has Node, and it sidesteps
code-signing entirely:

```bash
npm run build && npm publish --access public
```

`files` is scoped to `dist/`, so the published package is the compiled JS and nothing else.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `403` on the Microsoft side | Three things must all be true: `AuditLogsQuery.Read.All` is **admin-consented**, the signed-in account holds Audit Reader / Audit Manager / Global Reader, and the tenant is licensed for Purview Audit. |
| `Could not start device sign-in` | **Allow public client flows** is still **No** on the app registration. |
| Purview query succeeds with 0 records | Unified auditing may be off, or nobody used Copilot in the window. Widen with `--days 30`. |
| `404` on `/security/auditLog/queries` | The Audit Search API is unavailable in US Gov L4/L5 and 21Vianet clouds. Use `Search-UnifiedAuditLog` in Exchange Online PowerShell there. |
| `403` on the Google side | Sign in as a **Super Admin**, confirm the Admin SDK API is enabled in the backing Cloud project, and that the consent screen grants the reports scope. |
| Google returns nothing | Gemini logging starts **2025-06-20** and requires a Gemini for Workspace licence. An unlicensed tenant logs nothing at all. |
| Hangs behind a corporate proxy | Set `HTTPS_PROXY`, and `NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem` if TLS is inspected. |
| Report is enormous | Lower `--max-records`, or narrow `--days`. Above 50 000 events the charts cover the most recent slice and the report says so. |

Stack traces: `AI_AUDIT_LENS_DEBUG=1 ai-audit-lens ...`

## Project layout

```
src/
  index.ts       CLI parsing, orchestration, partial-failure handling
  auth.ts        Entra device-code + loopback PKCE; Google loopback PKCE
  fetch.ts       Purview async query lifecycle; Reports API pagination
  normalize.ts   Provider records -> unified PromptEvent (defensive, schema-drift tolerant)
  report.ts      Dictionary-encoded payload + the HTML dashboard template
  http.ts        Retry, backoff with jitter, Retry-After, deadlines, timeouts
  demo.ts        Seeded synthetic dataset for --demo
  log.ts         stderr logger and TTY-aware progress
  types.ts       Shared domain types
```

```bash
npm run typecheck   # tsc --noEmit
npm run build       # -> dist/ (ESM, what npx runs)
npm run bundle      # -> build/ai-audit-lens.cjs (CJS, for SEA/pkg)
npm run dev -- --demo
```

## Known limitations

- **Purview latency is the bottleneck**, not collection. See the resume flow above.
- **Copilot audit records name grounded resources, not prompt text.** Prompt and response
  content lives in the users' mailboxes and is reachable through eDiscovery, not here.
  That is a deliberate boundary.
- **Google exposes less detail than Microsoft.** `gemini_in_workspace_apps` carries the
  app, action, and feature source, but no equivalent of `AccessedResources` — so the
  "grounded on tenant data" tile is effectively Microsoft-only today.
- **No delegated / service-account mode.** This is an interactive admin tool by design.
  Domain-wide delegation would make it schedulable and is the obvious next step.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with, endorsed by, or sponsored by Microsoft or Google. "Microsoft 365
Copilot", "Microsoft Purview", "Google Workspace", and "Gemini" are trademarks of their
respective owners.
