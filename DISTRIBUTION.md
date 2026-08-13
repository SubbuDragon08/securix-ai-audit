# Shipping this as a lead magnet

Everything here is work only you can do — it involves your Azure tenant, your
certificates, and your website. The app itself is finished and builds today.

**Order matters.** Do 1 → 2 → 3. Skipping straight to a public download without
signing is the single most common way a tool like this dies in evaluation.

---

## 1. Register the SecuriX multi-tenant app  *(required — 10 minutes)*

This is what turns a seven-step wizard into one click. You register once; every
admin who downloads the app just consents to it.

1. [Entra admin center](https://entra.microsoft.com) → **App registrations** → **New registration**.
2. **Name:** `SecuriX AI Audit`. This string is what admins see on the consent
   screen, so it should look like something a CISO would approve.
3. **Supported account types:** *Accounts in any organizational directory
   (Any Microsoft Entra ID tenant — Multitenant)*. This is the setting that makes
   it work for other people's tenants; single-tenant is the default and is wrong here.
4. **Redirect URI:** platform **Mobile and desktop applications**, value
   `http://localhost`. Entra allows any port on a `http://localhost` reply URL for
   public clients, which is why the app can bind an ephemeral port and never
   collide with something already on 3000.
5. **API permissions** → Microsoft Graph → **Delegated** → `AuditLogsQuery.Read.All` → Add.
6. **Authentication** → **Allow public client flows** → **Yes** → Save.
   (No client secret. A distributed desktop app cannot keep one, and Entra
   public clients must not have one.)
7. **Branding & properties** → set the logo, publisher, and a link to
   `https://securix.app`. Consider [publisher verification](https://learn.microsoft.com/entra/identity-platform/publisher-verification-overview) —
   it puts a blue "Verified" badge on the consent screen and materially raises
   the number of admins who click Accept.
8. Copy the **Application (client) ID**.

Then build with it baked in:

```bash
export SECURIX_ENTRA_CLIENT_ID="<the guid you just copied>"
npm run dist:mac
```

Until that variable is set, the app builds and runs but shows a "This build is
not configured" banner and disables Microsoft sign-in — deliberately, so a
misbuilt binary fails loudly at your desk instead of silently at a customer's.

### What the admin sees

> **SecuriX AI Audit** wants to
> *Read audit log data* — Allows the app to read and query audit log data on your behalf.
> ☐ Consent on behalf of your organization
> **[Accept]  [Cancel]**

### If admins report `AADSTS65001` or "need admin approval"

Their tenant has user consent disabled, so someone with Privileged Role
Administrator must grant tenant-wide. Send them this URL with your client id
substituted:

```
https://login.microsoftonline.com/organizations/v2.0/adminconsent
  ?client_id=<YOUR_CLIENT_ID>
  &scope=https://graph.microsoft.com/AuditLogsQuery.Read.All
  &redirect_uri=http://localhost
```

`src/brand.ts` exports `adminConsentUrl()` which builds exactly this.

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
