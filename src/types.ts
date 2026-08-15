/**
 * Shared domain types.
 *
 * The whole tool funnels two very different audit schemas (Microsoft Purview
 * unified audit records and Google Workspace Reports activities) into one
 * `PromptEvent` shape so that `report.ts` never has to know which cloud a row
 * came from.
 */

export type Provider = 'microsoft' | 'google';

/**
 * One AI interaction, normalised across providers.
 *
 * Deliberately narrow: this is the *only* structure that reaches the HTML
 * report. Prompt and response bodies are never mapped into it unless the
 * operator explicitly passes `--include-raw`, and even then they land in
 * `raw`, not in an indexed field.
 */
export interface PromptEvent {
  /** Stable per-record id (Purview record id / Google uniqueQualifier). */
  id: string;
  /** ISO-8601 UTC instant of the interaction. */
  timestamp: string;
  provider: Provider;
  /** UPN or primary email, lower-cased. `unknown` when the log omits it. */
  user: string;
  /** Human-facing surface: "Teams", "Word", "Gmail", "Docs", … */
  app: string;
  /** Provider-native operation / event name, kept verbatim for forensics. */
  operation: string;
  /**
   * Where in the UI the assistant was invoked from (Google `feature_source`:
   * "Help Me Write", "Side Panel"). Microsoft does not expose an equivalent.
   */
  surface?: string;
  /** Caller IP when the audit record exposes one. */
  clientIp?: string;
  /** Model name when the provider reports it (Copilot ModelTransparencyDetails). */
  model?: string;
  /** Names of tenant resources the assistant read while answering. */
  accessedResources: string[];
  /** Sensitivity/classification labels observed on those resources. */
  sensitivityLabels: string[];
  /** Untouched provider payload. Populated only with `--include-raw`. */
  raw?: unknown;
}

/** Per-provider outcome, including partial-success bookkeeping. */
export interface ProviderResult {
  provider: Provider;
  events: PromptEvent[];
  /** True when a record cap or a deadline stopped collection early. */
  truncated: boolean;
  /** Non-fatal problems worth surfacing in the report header. */
  warnings: string[];
  /** Fatal error for this provider; other providers still render. */
  error?: string;
  /** Free-form diagnostics rendered in the report footer. */
  diagnostics: Record<string, string | number | boolean>;
}

/** Everything the report needs that is not an event. */
export interface ReportMeta {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  tenantLabel: string;
  toolVersion: string;
  redacted: boolean;
  results: ProviderResult[];
}

export interface TimeWindow {
  /** Inclusive start, ISO-8601 UTC. */
  start: string;
  /** Exclusive end, ISO-8601 UTC. */
  end: string;
}
