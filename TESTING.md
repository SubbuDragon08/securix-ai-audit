# Running and testing locally

Short answer to "do I need a `.env`?": **not to test.** A `.env` is only needed to
exercise the *real* Microsoft sign-in, and even then it holds one non-secret GUID.

---

## Level 0 — no credentials at all (start here, ~2 minutes)

This exercises the entire pipeline end to end with synthetic data: normalisation,
aggregation, chart rendering, the HTML writer, and the whole GUI. Nothing is
configured, nothing is signed into, no network call is made.

```bash
npm install
npm run app
```

Then click **Preview with sample data**. You get a report of ~1,168 interactions
across 18 users and the finished dashboard opens in your browser.

The app will show an amber *"This build is not configured"* banner and Microsoft
sign-in will be greyed out. **That is correct** — it means the build has no Entra
client id yet, which is exactly the state you are in until you do
[DISTRIBUTION.md § 1](DISTRIBUTION.md).

Same thing from the terminal:

```bash
npm run cli -- --demo
```

> Running from **VS Code's integrated terminal**? Both commands handle it. VS Code
> exports `ELECTRON_RUN_AS_NODE=1`, which would otherwise make Electron boot as
> plain Node and die with `Cannot read properties of undefined (reading 'whenReady')`.
> `scripts/start-app.mjs` strips it.

---

## Level 1 — real Google Workspace data (no `.env` needed)

Google is bring-your-own-client, and you paste the two values **into the app's UI**,
not into a file. Nothing to configure at build time.

1. `npm run app`
2. Expand **Google setup** on the Google card
3. Follow the 5 steps (Cloud Console → enable Admin SDK API → Internal consent
   screen → Desktop OAuth client), paste the client ID and secret
4. Click **Connect Google Workspace** → your browser opens for consent
5. Click **Generate report**

Requires a Super Admin account and a Gemini for Workspace licence. Gemini audit
logging only starts from **2025-06-20**, so earlier windows return nothing — that
is Google's retention, not a bug.

---

## Level 2 — real Microsoft 365 data (this is where `.env` comes in)

Microsoft sign-in needs a multi-tenant Entra app id compiled into the build.
Register it once ([DISTRIBUTION.md § 1](DISTRIBUTION.md), ~10 minutes), then:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
SECURIX_ENTRA_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Then rebuild and run:

```bash
npm run app
```

The banner disappears and **Connect Microsoft 365** becomes clickable.

### Why it must be rebuilt, not just re-run

The client id is inlined into the bundle by esbuild at build time, so the shipped
binary never reads the end user's environment. `npm run app` rebuilds first, so
editing `.env` and re-running is enough — but `.env` changes will *not* affect an
already-built `.dmg`.

`.env` is gitignored. It holds a client **identifier**, not a secret: Entra public
clients have no client secret by design, and the id is visible in the sign-in URL
anyway.

### Expect the Purview wait

On a real tenant, the Microsoft side is asynchronous and commonly takes 5–20
minutes. The app shows a live elapsed timer and a notice explaining this. It is
not frozen. **Cancel** aborts immediately.

---

## Testing the packaged app

```bash
npm run dist:mac      # -> release/*.dmg
npm run dist:win      # -> release/*.exe   (build on Windows for best results)
npm run dist:linux    # -> release/*.AppImage
```

Unsigned local builds will be blocked by Gatekeeper on macOS. To test one anyway:

```bash
xattr -dr com.apple.quarantine "release/mac-arm64/SecuriX AI Audit.app"
open "release/mac-arm64/SecuriX AI Audit.app"
```

Do **not** ship telling users to do this — get the certificates instead.

---

## Verifying the privacy claim yourself

The most valuable test, and the one a prospect will run:

```bash
# macOS/Linux — watch every outbound connection the app makes
sudo lsof -i -P -n | grep -i securix
```

Or point it at a proxy (`HTTPS_PROXY=http://127.0.0.1:8080`) and confirm the only
hosts are `login.microsoftonline.com`, `graph.microsoft.com`,
`accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`,
and `admin.googleapis.com`. Nothing goes to securix.app.

---

## Useful CLI flags while testing

```bash
npm run cli -- --demo --days 30            # bigger synthetic dataset
npm run cli -- --demo --pseudonymize       # alias mode
npm run cli -- --demo --json > events.json # normalised events
npm run cli -- --verbose ...               # every URL, status code, retry
AI_AUDIT_LENS_DEBUG=1 npm run cli -- ...   # full stack traces
```

---

## Troubleshooting the dev loop

| Symptom | Cause |
|---|---|
| `Cannot read properties of undefined (reading 'whenReady')` | `ELECTRON_RUN_AS_NODE=1`. Use `npm run app`, not `electron` directly. |
| Banner says "not configured" | `SECURIX_ENTRA_CLIENT_ID` unset. Expected until you register the Entra app; sample data still works. |
| **Connect Google** stays greyed out | The client ID field is empty. It enables as soon as you type. |
| **Stay signed in** is greyed out | Linux without a keyring — see the Linux notes in the README. |
| Changed `.env`, nothing happened | Rebuild: `npm run app` (not a bare `electron` invocation). |
| `ar failed (exit code 72)` | Building `.deb`/`.rpm` on macOS. `npm run dist:linux` now builds AppImage only off-Linux; use Docker for the rest. |
