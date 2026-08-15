# Shipping this as a lead magnet

Everything here is work only you can do — it involves your Azure tenant, your
certificates, and your website. The app itself is finished and builds today.

**Order matters.** Do 1 → 2 → 3. Skipping straight to a public download without
signing is the single most common way a tool like this dies in evaluation.

---

## 0. Make sure you have an Entra tenant  *(do this first)*

**Check before anything else.** This is unauthenticated and takes a second:

```bash
curl -s "https://login.microsoftonline.com/YOURDOMAIN/v2.0/.well-known/openid-configuration" \
  | head -c 120
```

- JSON containing `issuer` → you have a tenant, skip to step 1.
- `AADSTS90002: Tenant not found` → **you have no tenant yet.** Create one below.

As of this writing, neither `catalystops.in` nor `securix.app` is backed by Entra,
and signing into the Entra portal with a **personal** Microsoft account
(`@outlook.com`, `@hotmail.com`, `@live.com`) fails with:

```
AADSTS16000: User account ... from identity provider 'live.com' does not exist
in tenant 'Microsoft Services' and cannot access the application ... (ADIbizaUX)
```

That error is the Entra portal itself refusing to load, not a problem with any
app registration. A personal Microsoft account has no directory to administer.

### Pick a tenant strategy

| Option | Cost | Good for |
|---|---|---|
| **A. Free Entra ID tenant** | Free forever | Getting the app registration done today. Entra ID Free includes unlimited app registrations. **Recommended to start.** |
| **B. Microsoft 365 Business on `securix.app`** | ~$6–22/user/mo, 1 month free | The proper long-term publisher identity, and a prerequisite for publisher verification. Business Premium also includes Purview Audit, so you can test the Microsoft path against your own tenant. |
| **C. M365 Developer Program** | Free | Now gated behind a Visual Studio Professional/Enterprise subscription or another qualifying program — not open to everyone any more. |

You can start with A and migrate to B later, but note the client id is tied to the
tenant that owns it: moving means a new client id and every customer re-consents.
If you expect SecuriX to be the shipping publisher name, B is worth doing before
you publish the download link.

### First, identify what your account actually is

A personal Microsoft account can be created with **any** email address, including a
corporate-looking one. `subramanyan.b@catalystops.in` is exactly that: a personal
account wearing a work address. It has no directory, which is why both the Entra
admin center *and* `portal.azure.com` reject it:

```
Selected user account does not exist in tenant 'Microsoft Services'
and cannot access the application 'c44b4083-...' (Azure Portal)
```

Confirm for any address:

```bash
curl -s -X POST "https://login.microsoftonline.com/common/GetCredentialType" \
  -H "Content-Type: application/json" \
  -d '{"username":"you@yourdomain.com"}' | python3 -m json.tool | grep -E "IfExistsResult|DomainType"
```

| `IfExistsResult` | Meaning |
|---|---|
| `0` + `DomainType: 3` | Real work account in an Entra tenant. Skip to step 1. |
| `5` | **Personal Microsoft account only.** No directory. You must create a tenant. |
| `1` | No such account anywhere. |

Visiting `portal.azure.com` does **not** reliably auto-provision a directory for a
personal account any more. You need a signup flow that explicitly creates a tenant,
and both of those require a card for identity verification.

### Option A — Microsoft 365 Business Basic on `securix.app` (recommended)

Creates a real tenant, a real work admin account, and the publisher identity you
actually want on customer consent screens. ~$6/user/month, first month free.

1. Open an **InPrivate / Incognito** window (a signed-in personal account is what
   produced the errors above, and browsers cling to it).
2. Go to **[microsoft.com/microsoft-365/business](https://www.microsoft.com/en-in/microsoft-365/business/microsoft-365-business-basic)**
   → **Try free for one month**.
3. When asked for an email, enter one you control on **`securix.app`**. Microsoft
   will say it needs to create an account — that is what you want.
4. Create the admin user, e.g. `admin@securixapp.onmicrosoft.com`. **Do not try to
   reuse the personal account.**
5. Complete signup. You are now Global Administrator of a new tenant.
6. Later, add `securix.app` as a **custom domain** (Entra → Custom domain names →
   add a DNS TXT record) so consent screens and admin logins use the product domain.

Then `https://login.microsoftonline.com/securixapp.onmicrosoft.com/v2.0/.well-known/openid-configuration`
returns JSON, `entra.microsoft.com` opens normally with the new admin account, and
step 1 works as written.

> Consider **Business Premium** (~$22/user/month) instead if you want to test the
> Microsoft path against your own tenant — it includes Purview Audit, which Basic
> does not.

### Option B — Azure free account (no Microsoft 365)

Cheaper if you only need the app registration and nothing else.

1. InPrivate window → **[azure.microsoft.com/free](https://azure.microsoft.com/free)**.
2. Sign in with the personal Microsoft account and complete signup. A card is
   required for identity verification; the Entra ID Free tier used here costs
   nothing and app registrations are unlimited.
3. Signup provisions a **Default Directory** — the tenant you were missing.
4. Go to **[portal.azure.com](https://portal.azure.com)** → search **Microsoft Entra
   ID**. It now loads.
5. *(Recommended)* Rename the directory to `SecuriX` and create a native admin
   (`admin@<something>.onmicrosoft.com`) rather than administering as the personal
   account.

The tradeoff: the tenant is a generic `*.onmicrosoft.com` directory, so it is a
weaker publisher identity than Option A. The client id is tied to whichever tenant
creates it — migrating later means a new client id and every customer re-consents.

### A note on testing with real data

A brand-new tenant has no Copilot activity, so the Microsoft side will connect
successfully and return **zero records**. That is correct behaviour, not a bug.

To see real Copilot data you need a tenant with Purview Audit (E3/E5 or Business
Premium) *and* Copilot licences with actual usage. In practice the cheapest route
is a design-partner customer running it against their own tenant — which is also
the intended use of the tool. Until then, **Preview with sample data** exercises
the full pipeline.

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
   **Delegated permissions**. Add **both**:

   | Permission | Why |
   |---|---|
   | `AuditLogsQuery.Read.All` | The Copilot audit records. Admin consent required. |
   | `SensitivityLabel.Read` | Resolves the label GUIDs those records carry into names such as "Highly Confidential". Least-privileged option for `/security/dataSecurityAndGovernance/sensitivityLabels`. |

   Then remove the default `User.Read` if present — this app does not need it,
   and a shorter consent screen converts better.

   > The tool degrades gracefully if `SensitivityLabel.Read` is declined: the
   > report renders with shortened GUIDs and an on-page note explaining why.
   > Nothing else is affected.

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
SCOPE_ID=1d9e7ac3-0eca-442c-82f9-e92625af6e6d   # AuditLogsQuery.Read.All

# Look up SensitivityLabel.Read the same way and add it as a second resourceAccess entry:
#   az ad sp show --id "$GRAPH_APP_ID" \
#     --query "oauth2PermissionScopes[?value=='SensitivityLabel.Read'].id" -o tsv

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
