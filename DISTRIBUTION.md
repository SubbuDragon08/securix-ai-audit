# Shipping this as a lead magnet

Everything here is work only you can do — it involves your Azure tenant, your
certificates, and your website. The app itself is finished and builds today.

**Order matters.** Do 1 → 2 → 3. Skipping straight to a public download without
signing is the single most common way a tool like this dies in evaluation.

---

## 1. Register the SecuriX multi-tenant app  *(required — 10 minutes)*

This is what turns a seven-step wizard into one click. You register once; every
admin who downloads the app just consents to it.

### Before you start

- **Which tenant?** Whichever Entra tenant you control long-term — this
  registration becomes your permanent publisher identity. Every customer consent
  screen will name it, and moving it later means every customer re-consents.
- **What role?** Application Developer or higher. Global Administrator is not
  required to create it (only to consent in a given tenant).
- **No Azure subscription needed.** App registrations are free and live in Entra,
  not in a subscription.

### Path A — Portal (recommended; no tooling required)

1. Sign in to **[entra.microsoft.com](https://entra.microsoft.com)** with your
   SecuriX/Catalyst Ops tenant account.

2. **Applications** → **App registrations** → **+ New registration**.

3. **Name:** `SecuriX AI Audit`
   This exact string is what admins see on the consent screen. Make it look like
   something a CISO would approve.

4. **Supported account types:** select
   **Accounts in any organizational directory (Any Microsoft Entra ID tenant — Multitenant)**

   > This is the whole point and it is **not** the default. "Single tenant" — the
   > preselected option — produces an app that works only in your own tenant and
   > fails for every customer with `AADSTS50020`.
   >
   > Do **not** pick the "…and personal Microsoft accounts" variant: a personal
   > account can never hold a tenant audit role, so it only creates confusing
   > failures.

5. **Redirect URI:** leave blank here. **Register**.

6. On the **Overview** page, copy **Application (client) ID**. That GUID is your
   `SECURIX_ENTRA_CLIENT_ID`.

7. **Authentication** → **+ Add a platform** → **Mobile and desktop applications**
   → tick the custom URI box and enter exactly:

   ```
   http://localhost
   ```

   No port, no path. Entra allows any port at runtime on a `http://localhost`
   reply URL for public clients, which is why the app can bind an ephemeral port
   and never collide with something already using 3000.

8. Still on **Authentication**, scroll to **Advanced settings** →
   **Allow public client flows** → **Yes** → **Save**.

   > The single most commonly missed step. Without it, sign-in fails with
   > `AADSTS7000218` / "client_assertion or client_secret".

9. **API permissions** → **+ Add a permission** → **Microsoft Graph** →
   **Delegated permissions** → search `AuditLogsQuery` → tick
   **AuditLogsQuery.Read.All** → **Add permissions**.

   Then remove the default `User.Read` if present — this app does not need it,
   and a shorter consent screen converts better.

10. *(Optional but worth it)* **Branding & properties** → add your logo, publisher
    name, and `https://securix.app`. Then complete
    [publisher verification](https://learn.microsoft.com/entra/identity-platform/publisher-verification-overview)
    to get the blue **Verified** badge on the consent screen. It measurably raises
    the number of admins who click Accept.

### Path B — Azure CLI (faster, scriptable)

Not installed on your machine as of writing: `brew install azure-cli` first.

```bash
az login

# Delegated AuditLogsQuery.Read.All on Microsoft Graph.
# Graph resource app id is the same in every tenant.
GRAPH_APP_ID=00000003-0000-0000-c000-000000000000
SCOPE_ID=1d9e7ac3-0eca-442c-82f9-e92625af6e6d

# Verify that GUID against your own tenant before trusting it:
az ad sp show --id "$GRAPH_APP_ID" \
  --query "oauth2PermissionScopes[?value=='AuditLogsQuery.Read.All'].{id:id,value:value}" -o table

az ad app create \
  --display-name "SecuriX AI Audit" \
  --sign-in-audience AzureADMultipleOrgs \
  --is-fallback-public-client true \
  --public-client-redirect-uris "http://localhost" \
  --required-resource-accesses "[{\"resourceAppId\":\"$GRAPH_APP_ID\",\"resourceAccess\":[{\"id\":\"$SCOPE_ID\",\"type\":\"Scope\"}]}]" \
  --query appId -o tsv
```

The printed `appId` is your `SECURIX_ENTRA_CLIENT_ID`.

### Verify the registration is actually correct

Two settings silently break everything if wrong. Check both:

```bash
az ad app show --id <YOUR_CLIENT_ID> \
  --query "{audience:signInAudience, publicClient:isFallbackPublicClient, redirects:publicClient.redirectUris}"
```

Expect:

```json
{
  "audience": "AzureADMultipleOrgs",
  "publicClient": true,
  "redirects": ["http://localhost"]
}
```

In the portal instead: **Overview** should read *"Supported account types: Multiple
organizations"*, and **Authentication** should show **Allow public client flows: Yes**.

### Use it

```bash
cd "/Users/subramanyanbalakrishnan/VS Code/FreeTool"
cp .env.example .env
# set SECURIX_ENTRA_CLIENT_ID=<the guid>
npm run app
```

The amber "not configured" banner disappears and **Connect Microsoft 365** becomes
clickable. The client id is inlined at build time, so `.env` changes need a
rebuild — `npm run app` does that for you.

### Test it against a tenant that is not yours

Your own tenant will succeed even if you accidentally left the app single-tenant,
because the app is *registered* there. The multi-tenant path is only proven by a
second tenant — a customer, a partner, or a free
[Microsoft 365 developer tenant](https://developer.microsoft.com/microsoft-365/dev-program).

### What the admin sees

> **SecuriX AI Audit** wants to
> *Read audit logs data from all services* — Allows the app to read and query
> audit logs from all services, on behalf of the signed-in user.
> ☐ Consent on behalf of your organization
> **[Accept]  [Cancel]**

Because `AuditLogsQuery.Read.All` requires admin consent, only a Global
Administrator or Privileged Role Administrator can accept. Note that consenting
grants the app the permission; the signed-in user still needs an audit role
(Audit Reader / Audit Manager / Global Reader) for queries to return data.

### If admins report `AADSTS65001` or "need admin approval"

Their tenant has user consent disabled, so an admin must grant tenant-wide. Send
them this URL with your client id substituted:

```
https://login.microsoftonline.com/organizations/v2.0/adminconsent
  ?client_id=<YOUR_CLIENT_ID>
  &scope=https://graph.microsoft.com/AuditLogsQuery.Read.All
  &redirect_uri=http://localhost
```

`src/brand.ts` exports `adminConsentUrl()` which builds exactly this.

### Common failures

| Error | Cause |
|---|---|
| `AADSTS50020` user account from identity provider does not exist in tenant | App is single-tenant. Set **signInAudience** to `AzureADMultipleOrgs`. |
| `AADSTS7000218` request body must contain `client_assertion` or `client_secret` | **Allow public client flows** is still **No**. |
| `AADSTS50011` redirect URI mismatch | `http://localhost` missing from the **Mobile and desktop applications** platform, or added under **Web** by mistake. |
| `AADSTS65001` consent required | Expected in tenants with user consent disabled — use the admin consent URL above. |
| Sign-in works, Purview returns 403 | Consent is fine; the account lacks an audit role. Grant Audit Reader in Purview. |

---

## 2. Code signing  *(required before any public download)*

You said you have neither certificate yet. The pipeline is wired and disabled in
`electron-builder.yml` — here is what to buy and what to flip.

Unsigned, your users see:

| Platform | What happens |
|---|---|
| macOS | *"SecuriX AI Audit is damaged and can't be opened. You should move it to the Trash."* — Gatekeeper's message for unsigned quarantined apps. Most people will not try to work around it, and the ones who would *shouldn't*. |
| Windows | *"Windows protected your PC"* SmartScreen wall with **Don't run** as the default button. |

### macOS — Apple Developer Program, $99/yr

1. Enrol at [developer.apple.com](https://developer.apple.com/programs/), then create a
   **Developer ID Application** certificate and install it in your login keychain.
2. Create an app-specific password at [account.apple.com](https://account.apple.com) for notarization.
3. In `electron-builder.yml`, delete `identity: null` and uncomment:

```yaml
mac:
  identity: "Developer ID Application: Your Org (TEAMID)"
  notarize:
    teamId: TEAMID
```

4. Build with credentials in the environment:

```bash
export APPLE_ID="you@securix.app"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"
export SECURIX_ENTRA_CLIENT_ID="<guid>"
npm run dist:mac
```

electron-builder signs, submits to Apple, waits, and staples the ticket.
Notarization usually takes 2–15 minutes.

Verify before you publish:

```bash
spctl --assess --type execute -vv "release/mac-arm64/SecuriX AI Audit.app"
# expect: accepted / source=Notarized Developer ID
stapler validate "release/mac-arm64/SecuriX AI Audit.app"
```

### Windows — OV or EV certificate, ~$200–400/yr

- **OV** is cheaper but starts with zero SmartScreen reputation; expect warnings
  for the first few hundred downloads while it accrues.
- **EV** clears SmartScreen immediately. For a security vendor's first public download,
  the premium is usually worth it.
- Modern electron-builder prefers [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)
  over a local `.pfx`; the `azureSignOptions` block is stubbed in `electron-builder.yml`.

Verify:

```powershell
signtool verify /pa /v "release\SecuriX AI Audit Setup 0.1.0.exe"
```

### Publish checksums either way

```bash
shasum -a 256 release/*.dmg release/*.exe > release/SHA256SUMS.txt
```

Put them on the download page. Security buyers actually check.

---

## 3. The website download flow

You chose a website gate, which is the right call: the app makes **zero**
outbound calls of its own — no telemetry, no licence check, no update ping — so
"nothing leaves your machine" survives a reviewer pointing a proxy at it. Keep it
that way. The moment the binary phones home, that claim is gone and it is the
first thing anyone technical will find.

```
securix.app/ai-audit
   ├─ [ work email ] → [ Get the free tool ]
   ├─ POST to your CRM / list
   └─ returns download links + SHA256SUMS
        ├─ SecuriX AI Audit-0.1.0-arm64.dmg     (Apple Silicon)
        ├─ SecuriX AI Audit-0.1.0.dmg           (Intel Mac)
        └─ SecuriX AI Audit Setup 0.1.0.exe     (Windows)
```

Suggested page copy, drawn from what the tool actually proves:

> **Find out what your employees are telling Copilot.**
> A free, open-source desktop app. Connects to your own Microsoft 365 or Google
> Workspace tenant with read-only audit permissions, and produces a dashboard of
> every AI prompt in the last 7 days — who, when, from which app, and which
> internal files the assistant read to answer.
>
> Runs entirely on your laptop. No data is sent to SecuriX. No account required.
> [ Get the free tool ]

Detect the visitor's platform and lead with the matching button; put the other
two behind "Other downloads".

### The follow-up that converts

The honest limitation of this tool *is* the pitch for your product, so put it in
the follow-up email rather than inside the app:

> Your report covers **sanctioned** Copilot and Gemini — the AI your tenant knows
> about. It cannot see ChatGPT, Claude, Cursor, or coding agents on personal
> accounts, because none of that touches your audit log at all.
>
> That gap is what SecuriX closes.

This is a strong lead-qualification signal too: anyone who runs the tool and sees
1,200 Copilot interactions across 18 users has just discovered they have an AI
governance problem, on their own screen, with their own data.

---

## 4. Release checklist

```bash
export SECURIX_ENTRA_CLIENT_ID="<guid>"
npm run typecheck
npm run app:build && npm run app                 # smoke-test the GUI
npm run dist:mac                                 # or dist:win / dist
shasum -a 256 release/*.dmg release/*.exe > release/SHA256SUMS.txt
```

- [ ] `SECURIX_ENTRA_CLIENT_ID` set — the app shows **no** "not configured" banner
- [ ] Connect Microsoft 365 opens the **system browser**, not a window inside the app
- [ ] Consent screen shows your name, logo, and ideally a verified-publisher badge
- [ ] macOS build passes `spctl --assess` as *Notarized Developer ID*
- [ ] Windows build passes `signtool verify /pa`
- [ ] Downloaded build runs on a machine that has never seen the source
- [ ] `SHA256SUMS.txt` published next to the binaries
- [ ] Proxy the running app and confirm the only hosts are Microsoft's and Google's

---

## Cost and effort summary

| Item | Cost | Effort | Blocking? |
|---|---|---|---|
| Entra multi-tenant registration | free | 10 min | **Yes** — Microsoft sign-in is disabled without it |
| Entra publisher verification | free | ~1 day | No, but lifts consent conversion |
| Apple Developer Program | $99/yr | 1–2 days approval | **Yes** for a public `.dmg` |
| Windows OV/EV certificate | $200–400/yr | 1–5 days vetting | **Yes** for a public `.exe` |
| Google OAuth verification | free | weeks, possible security assessment | No — Google stays bring-your-own until then |
| Website download page | your infra | a few hours | **Yes** |
