/**
 * Product identity and the one piece of vendor configuration that matters.
 *
 * ## The Entra client id
 *
 * The desktop app signs admins in through a **multi-tenant** Entra application
 * that SecuriX owns. That is what turns a seven-step app-registration wizard
 * into a single "Connect Microsoft 365" click: the admin never registers
 * anything, they just consent to an app whose publisher is you.
 *
 * `SECURIX_ENTRA_CLIENT_ID` must be set at build time. Until it is, the app
 * boots into a setup screen instead of pretending to work — a placeholder GUID
 * would otherwise fail at the Microsoft sign-in page with an opaque
 * `unauthorized_client`, which is a terrible first impression for a security
 * tool.
 *
 * See README § "Registering the SecuriX multi-tenant app" for the registration
 * steps this value comes from.
 *
 * ## Why Google is different
 *
 * There is no Google equivalent of a multi-tenant app the admin can simply
 * consent to. Admin SDK scopes require Google OAuth verification before an
 * external client may request them, so a distributed desktop binary cannot ship
 * a shared Google client id without completing that review. Until it is done,
 * Google onboarding stays bring-your-own: the admin creates an **Internal**
 * Desktop client in their own Cloud project, which needs no verification at all.
 */

/** Replaced at build time; see `scripts/build-app.mjs`. */
const PLACEHOLDER_CLIENT_ID = 'REPLACE_WITH_SECURIX_ENTRA_CLIENT_ID';

export const BRAND = {
  appName: 'SecuriX AI Audit',
  shortName: 'AI Audit',
  vendor: 'SecuriX',
  website: 'https://securix.app',
  /** Shown in the report footer and the app's About line. */
  tagline: 'Free AI prompt audit for Microsoft 365 and Google Workspace',
} as const;

/**
 * Multi-tenant Entra app owned by the vendor.
 *
 * `organizations` (not `common`) restricts sign-in to work and school accounts:
 * a personal Microsoft account can never hold a tenant audit role, so offering
 * it only produces confusing failures.
 */
export const ENTRA = {
  clientId: process.env['SECURIX_ENTRA_CLIENT_ID']?.trim() || PLACEHOLDER_CLIENT_ID,
  tenant: 'organizations',
  authority: 'login.microsoftonline.com',
} as const;

/** False until the vendor has registered the app and rebuilt with its id. */
export const isEntraConfigured = (clientId: string = ENTRA.clientId): boolean =>
  clientId !== PLACEHOLDER_CLIENT_ID &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId);

/**
 * Tenant-wide admin consent URL.
 *
 * Some tenants disable user consent entirely; there, an admin must grant on
 * behalf of the organisation before any sign-in succeeds. Surfacing this link
 * turns an `AADSTS65001` dead end into a one-click fix.
 */
export const adminConsentUrl = (clientId: string, redirectUri: string): string =>
  `https://${ENTRA.authority}/${ENTRA.tenant}/v2.0/adminconsent?` +
  new URLSearchParams({
    client_id: clientId,
    scope: 'https://graph.microsoft.com/AuditLogsQuery.Read.All',
    redirect_uri: redirectUri,
  }).toString();
