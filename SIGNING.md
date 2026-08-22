# Free Windows code signing via SignPath Foundation

Everything in the repository is ready. What remains is an application to
SignPath Foundation and five values pasted into GitHub. Budget an afternoon of
your time plus one to three weeks of their review.

**Why this works:** SignPath Foundation gives open-source projects free
Authenticode certificates. They do not verify *you* — they verify that the
binary came from your public repository, and vouch for that with their own name.
That is why the signing must happen inside CI: a locally built `.exe` cannot be
signed, by design.

---

## Before you apply — the checklist they actually grade

| Requirement | Status | Notes |
|---|---|---|
| OSI-approved licence, no dual licensing | ✅ | MIT |
| Public repository | ✅ | `github.com/SubbuDragon08/FreeTool` |
| No proprietary code | ✅ | Zero runtime dependencies |
| Documented functionality | ✅ | README, DISTRIBUTION.md, TESTING.md |
| Has an uninstaller | ✅ | NSIS installer registers one |
| Verifiable automated build from source | ✅ | `.github/workflows/release.yml` |
| Published code signing policy | ✅ | [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) |
| Published privacy policy | ✅ | [PRIVACY.md](PRIVACY.md) |
| Correct PE metadata (product, version) | ✅ | Set in `electron-builder.yml` |
| Manual approval per release | ✅ | Workflow waits for your approval |
| **Already released in signable form** | ⬜ | **Do this first — see below** |
| **MFA on GitHub and SignPath** | ⬜ | **Your action** |
| Not a hacking or pen-testing tool | ✅ | Read-only auditing of your own tenant |
| Actively maintained | ⬜ | Keep committing; a dead repo gets rejected |

Two of these are on you, and one of them gates the rest.

---

## Step 1 — Cut an unsigned release first

They will not review a project with no releases. "Already released in signable
form" means there is a downloadable Windows binary today, signature or not.

```bash
# Add the Entra client id as a repository variable first (see Step 3), then:
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds Windows, macOS, and Linux, notices that
`SIGNPATH_API_TOKEN` is absent, publishes everything unsigned, and says so in the
log. That release is what you point SignPath at.

## Step 2 — Turn on MFA

Non-negotiable for the programme, and it applies to every account with access to
the repository or the SignPath organisation.

- GitHub: **Settings → Password and authentication → Two-factor authentication**
- SignPath: enable it when you create the account

## Step 3 — Apply

Go to <https://signpath.org/> and use the **Apply** link.

You will be asked for the repository URL, a description, and the licence.
Point them at:

- Repository: `https://github.com/SubbuDragon08/FreeTool`
- Code signing policy: `.../blob/master/CODE_SIGNING_POLICY.md`
- Privacy policy: `.../blob/master/PRIVACY.md`
- Release: the tag from Step 1

A description that helps, because "audit tool" reads adjacent to the tooling they
explicitly exclude:

> A read-only reporting tool for IT administrators. It signs into the
> administrator's *own* Microsoft 365 or Google Workspace tenant using standard
> OAuth with read-only audit scopes, fetches that tenant's AI prompt audit logs,
> and renders a local HTML report. It runs entirely on the operator's machine,
> has no backend, and transmits nothing. It contains no exploitation,
> credential-harvesting, or penetration-testing capability — it reads audit logs
> the administrator already owns, through documented vendor APIs.

## Step 4 — Configure the repository

Once approved, SignPath gives you an organisation id, a project slug, a signing
policy slug, an artifact configuration slug, and an API token.

**Settings → Secrets and variables → Actions**

Variables (not secrets — these are not confidential):

| Name | Example |
|---|---|
| `SECURIX_ENTRA_CLIENT_ID` | `6b49046e-…` |
| `SIGNPATH_ORGANIZATION_ID` | from the portal |
| `SIGNPATH_PROJECT_SLUG` | `freetool` |
| `SIGNPATH_SIGNING_POLICY` | `release-signing` |
| `SIGNPATH_ARTIFACT_CONFIG` | `initial` |

Secret:

| Name | Value |
|---|---|
| `SIGNPATH_API_TOKEN` | submitter token from the portal |

### The artifact configuration is the part people get wrong

An NSIS installer is a container. If the artifact configuration signs only the
outer `.exe`, then after installation the application executable sitting on disk
is **unsigned** — which defeats AppLocker and WDAC publisher rules, and looks
wrong to EDR. That is exactly the audience for this tool.

In the SignPath portal, define the artifact configuration so it recurses into the
installer and signs the nested PE files as well as the installer itself. If you
are unsure how to express that, send SignPath support the artifact — they help
with this routinely for Electron projects.

The workflow verifies the result with `Get-AuthenticodeSignature` and fails the
build if anything came back unsigned, so a misconfiguration cannot silently ship.

## Step 5 — Cut a signed release

```bash
git tag v0.1.1
git push origin v0.1.1
```

The workflow pauses at the signing request. Approve it in the SignPath portal
(this is the manual gate the programme requires), and the signed binaries flow
back and attach to the GitHub Release.

Verify on a clean Windows machine:

```powershell
Get-AuthenticodeSignature ".\SecuriX AI Audit Setup 0.1.1 x64.exe" | Format-List
# Status should be Valid, signed by SignPath Foundation
```

---

## What signing does and does not fix

**Fixes:** the "Unknown publisher" dialog, the missing publisher name in the UAC
prompt, and most EDR heuristics that key off unsigned binaries. It also lets
enterprise customers allow-list you by publisher certificate in AppLocker or
WDAC, which is often the difference between "we can deploy this" and "we can't".

**Does not immediately fix:** SmartScreen reputation. Microsoft builds reputation
per certificate over downloads and time. A brand-new certificate — including a
Foundation one — can still show *"Windows protected your PC"* for the first while.
It clears as downloads accumulate. Only an EV certificate skips the queue, and
those are not free.

Because of that, the download page should say plainly what to expect and how to
verify, rather than leaving people to guess.

## Windows Server notes

Your audience runs this on jump boxes and admin workstations, so:

- **Desktop Experience is required.** Windows Server Core has no GUI; the
  Electron app cannot run there. Use the CLI (`npx ai-audit-lens`) instead.
- **Silent install** for fleet deployment:
  ```powershell
  .\"SecuriX AI Audit Setup 0.1.1 x64.exe" /S
  .\"SecuriX AI Audit Setup 0.1.1 x64.exe" /S /allusers   # machine-wide
  ```
- **IE Enhanced Security Configuration** on Server can interfere with the OAuth
  browser handoff. The app opens the default browser and always prints the URL as
  a fallback, so sign-in can be completed on another machine if needed.
- **Per-user by default** so an analyst without local admin can still run it;
  `/allusers` forces machine-wide.

## If SignPath declines

Fallbacks, cheapest first:

| Option | Cost | Note |
|---|---|---|
| **Microsoft Store** | $19 one-time | Microsoft signs it for you — SmartScreen disappears entirely, and you get a distribution channel |
| **Azure Trusted Signing** | ~$10/month | Cheapest commercial option; `azureSignOptions` in `electron-builder.yml` |
| **Certum OSS certificate** | ~€30/year | Popular with independent Windows developers |
| Ship unsigned + SHA256SUMS | Free | Not advisable for a security vendor's tool |
