# Code signing policy

This document is a requirement of the SignPath Foundation free code signing
programme and describes who can change this software, who can authorise a
signature, and how a published binary is tied back to public source.

## Attribution

Free code signing for Windows binaries is provided by
**[SignPath.io](https://signpath.io/)**, with a certificate from the
**[SignPath Foundation](https://signpath.org/)**.

SignPath Foundation does not audit this code. Its signature attests that the
binary was produced by this project's automated build from the public source in
this repository — not that the software is fit for any purpose. Trust in the
software itself still rests on this repository being open and reviewable.

## Roles

| Role | Who | Responsibility |
|---|---|---|
| **Author** | Subramanyan B (@SubbuDragon08) | Writes and changes code. |
| **Reviewer** | Subramanyan B (@SubbuDragon08) | Reviews changes before they reach `master`. |
| **Approver** | Subramanyan B (@SubbuDragon08) | Authorises each signing request in SignPath. |

This is currently a single-maintainer project, so one person holds all three
roles. That is disclosed here rather than hidden. As contributors join, this
table will be updated so that Author and Reviewer are distinct people for any
change that reaches a signed release.

All accounts with access to this repository or to the SignPath organisation have
**multi-factor authentication enabled**, as the programme requires.

## How a signed release is produced

1. A maintainer pushes a `v*` tag.
2. GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml))
   builds the installers on GitHub-hosted runners from the tagged commit.
   Nothing is built locally, and no local artifact is ever submitted.
3. The unsigned Windows installers are uploaded as a GitHub Actions artifact and
   submitted to SignPath.
4. **A human approves the signing request in SignPath.** Every release is
   approved individually; there is no automatic signing.
5. The signed artifacts are returned to the workflow, their signatures are
   verified with `Get-AuthenticodeSignature`, and they are attached to the
   GitHub Release together with `SHA256SUMS.txt`.

The build inputs are fully public. The only build-time configuration value,
`SECURIX_ENTRA_CLIENT_ID`, is stored as a repository **variable** rather than a
secret precisely so that anyone can rebuild a tag and obtain the same binary. It
is a public OAuth client identifier and carries no credential.

## What is signed

- The NSIS installer (`SecuriX AI Audit Setup <version> <arch>.exe`)
- The portable executable
- The application executable inside the installer

Signed files carry `ProductName`, `CompanyName`, and `FileVersion` metadata
matching this project and the released version, so that enterprise allow-listing
(AppLocker or WDAC publisher rules) can target them precisely.

## What the application does

Two read-only tools for IT and security administrators: a **Tenant Audit** that
reads the administrator's own Microsoft 365 / Google Workspace AI audit logs over
documented vendor APIs, and a **Shadow AI Scanner** that inspects the local
machine — the current user's own AI-client configuration files and its own
loopback interface — to inventory unmanaged AI agents, MCP servers, and the
presence of AI provider API keys. The scanner is host-only, touches no other
machine, and never reads the value of any credential. Neither tool contains
exploitation, credential-harvesting, or penetration-testing capability.

## Privacy

This application collects nothing. It has no backend, no telemetry, no update
check, and no licence check. See [PRIVACY.md](PRIVACY.md) for the full statement
and the exact list of hosts it contacts.

## Reporting a problem

Security issues, or any binary that appears to be signed but did not come from
this repository, should be reported by opening an issue at
<https://github.com/SubbuDragon08/securix-ai-audit/issues> or by emailing
<subramanyan.b@catalystops.in>.
