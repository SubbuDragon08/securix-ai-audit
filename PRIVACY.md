# Privacy policy

**SecuriX AI Audit & Shadow Scanner collects no data whatsoever.**

There is no backend service, no analytics, no telemetry, no crash reporting, no
update check, and no licence check. The application never contacts SecuriX or
any host operated by us. Nothing about you, your tenant, your machine, or your
usage is transmitted anywhere.

This is verifiable rather than merely asserted — see *How to check* below.

The app has two tools; each is covered below.

## Tool 1 — Tenant Audit

The Tenant Audit reads AI prompt audit logs from **your own** Microsoft 365 or
Google Workspace tenant, using **your own** administrator credentials, and writes
an HTML report to **your own** disk. Every step happens on the machine you run it
on.

| Data | Where it goes |
|---|---|
| Audit records fetched from your tenant | Held in memory, written into the HTML report on your local disk, then discarded when the process exits |
| The generated report | Your Documents folder, created with `0600` permissions (owner-readable only) |
| OAuth access and refresh tokens | Process memory. Discarded on exit unless you tick **Stay signed in**, which stores them encrypted in your OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret) |
| Your Google OAuth client id and secret | A local settings file readable only by your user account |
| Prompt and response text | **Never read.** The tool requests only metadata: who, when, from which app, and which files the assistant opened |

## Tool 2 — Shadow AI & Agent Scanner

The Shadow Scanner runs entirely on the machine you launch it on. It reads the
current user's own AI-client configuration files and dotfiles, and probes the
loopback address (`127.0.0.1`) to fingerprint local servers. It contacts **no
network host at all**, touches **no other machine**, and writes nothing to disk
unless you choose to save a report.

| Data | How it is handled |
|---|---|
| AI client MCP configs (Claude, Cursor, VS Code, …) | Read from your home directory to list the servers declared and what they can reach. Held in memory for the on-screen results only. |
| Provider API keys in dotfiles / `.env` files | The tool records that a key **exists**, which provider it is, and the file it lives in. **It never reads, stores, displays, or transmits the secret value.** The matcher keys on the variable *name* only. |
| Localhost ports | Enumerated for your own user's processes and probed at `127.0.0.1` to detect MCP servers. No other address is contacted. |
| Installed AI tools | Detected by the presence of app bundles / config directories. |
| Scan results | Displayed in the app. Nothing is sent anywhere; nothing is written to disk unless you export a report. |

The "never read a key value" rule is not just a promise — it is enforced by an
automated test (`test/shadow-scanner.test.mjs`) that fails the build if any
secret value from a fixture ever appears in scanner output.

The Shadow Scanner does **not** scan your local network in this version. A future
version may add an opt-in local-subnet scan, and it will require you to
explicitly confirm you are authorised to scan that network before it runs.

## Hosts the application contacts

Only first-party Microsoft and Google endpoints, and only to fetch your own data:

- `login.microsoftonline.com` — Microsoft sign-in
- `graph.microsoft.com` — Purview audit search and sensitivity label names
- `accounts.google.com`, `oauth2.googleapis.com` — Google sign-in
- `openidconnect.googleapis.com` — one lookup to display which account signed in
- `admin.googleapis.com` — Google Admin SDK Reports

The generated HTML report additionally loads two pinned libraries from
`cdn.tailwindcss.com` and `cdn.jsdelivr.net` when you open it in a browser.
These are inbound script fetches; no audit data is sent to them. The report still
renders its tables and numbers with no network access at all — only the charts
require those libraries.

## Permissions requested

All read-only. None can modify anything in your tenant.

| Platform | Scope | Purpose |
|---|---|---|
| Microsoft | `AuditLogsQuery.Read.All` | Read Copilot interaction audit records |
| Microsoft | `SensitivityLabel.Read` | Turn sensitivity label GUIDs into readable names |
| Google | `admin.reports.audit.readonly` | Read Gemini activity from the Reports API |

You can revoke Microsoft access at any time under **Enterprise applications** in
the Entra admin center, and Google access by deleting the OAuth client in your
own Google Cloud project.

## How to check this yourself

Do not take the above on trust. Run the application behind a proxy, or watch its
connections directly:

```bash
# macOS / Linux
sudo lsof -i -P -n | grep -i securix
```

You will see connections only to the hosts listed above. The source is public at
<https://github.com/SubbuDragon08/securix-ai-audit> and the released binaries are built
from it by GitHub Actions.

## Your report is sensitive

The HTML report embeds real audit records from your tenant. Treat it with the
same handling rules as the audit log itself. The tool writes it `0600` for that
reason, and offers a `--pseudonymize` option that replaces user identities with
per-run aliases and drops IP addresses.

## Contact

<subramanyan.b@catalystops.in> · <https://securix.app>

Last updated: 2026-08-22
