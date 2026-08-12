/**
 * Synthetic dataset for `--demo`.
 *
 * Two jobs: it lets an admin see exactly what the report looks like before
 * granting any OAuth consent (a meaningful trust step for a tool asking for
 * audit-read on a whole tenant), and it gives the project an end-to-end test
 * path that needs no live tenant.
 *
 * The generator is seeded, so the same command always produces the same report
 * and screenshots stay stable.
 */

import type { PromptEvent, ProviderResult } from './types.js';

/** mulberry32 — small, fast, deterministic. Not for anything security-bearing. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MS_USERS = [
  'a.okafor@contoso.com', 'j.lindqvist@contoso.com', 'p.raman@contoso.com',
  'm.delacruz@contoso.com', 's.novak@contoso.com', 'r.mbeki@contoso.com',
  't.yamamoto@contoso.com', 'l.moreau@contoso.com', 'd.fitzgerald@contoso.com',
  'k.haddad@contoso.com', 'c.eriksen@contoso.com', 'n.varga@contoso.com',
];
const GOOGLE_USERS = [
  'b.adeyemi@contoso.com', 'e.rossi@contoso.com', 'w.chen@contoso.com',
  'i.petrov@contoso.com', 'f.dubois@contoso.com', 'g.singh@contoso.com',
];

const MS_APPS: Array<[string, number]> = [
  ['Microsoft 365 Copilot Chat', 34], ['Teams', 22], ['Word', 14],
  ['Outlook', 12], ['Excel', 8], ['PowerPoint', 6], ['Loop', 2], ['SharePoint', 2],
];
const MS_OPS: Array<[string, number]> = [
  ['CopilotInteraction', 82], ['AIAppInteraction', 18],
];
const GOOGLE_APPS: Array<[string, number]> = [
  ['Gmail', 30], ['Docs', 24], ['Gemini App', 18], ['Meet', 12],
  ['Sheets', 9], ['Slides', 5], ['Chat', 2],
];
const GOOGLE_OPS: Array<[string, number]> = [
  ['Generate Text', 34], ['Summarize', 26], ['Conversation', 22],
  ['Refine Text', 11], ['Generate Image', 7],
];

const RESOURCES = [
  'FY26 Headcount Plan.xlsx (File)', 'Board Deck Q3.pptx (File)',
  'Customer Master List.xlsx (File)', 'Severance Policy v4.docx (File)',
  'Pricing Model 2026.xlsx (File)', 'Security Incident 4471.docx (File)',
  'Acquisition - Project Kestrel.docx (File)', 'Payroll Export Jan.csv (File)',
  'Engineering Roadmap.docx (File)', 'Support Escalations.xlsx (File)',
];
const LABELS = ['Confidential', 'Highly Confidential', 'Internal'];

function weightedPick<T>(rand: () => number, table: Array<[T, number]>): T {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return table[0]![0];
}

/** Zipf-ish index so a few heavy users dominate, as they do in reality. */
const skewedIndex = (rand: () => number, length: number): number =>
  Math.min(length - 1, Math.floor(Math.pow(rand(), 2.1) * length));

export function buildDemoData(days: number): {
  events: PromptEvent[];
  results: ProviderResult[];
} {
  const rand = seededRandom(20260812);
  const events: PromptEvent[] = [];
  const now = Date.now();
  const dayMs = 86_400_000;

  let msCount = 0;
  let googleCount = 0;

  for (let day = days - 1; day >= 0; day--) {
    const date = new Date(now - day * dayMs);
    const weekday = date.getUTCDay();
    // Weekends are quiet; adoption trends upward across the window.
    const weekendFactor = weekday === 0 || weekday === 6 ? 0.18 : 1;
    const growth = 0.75 + ((days - day) / days) * 0.6;

    const msToday = Math.round((90 + rand() * 60) * weekendFactor * growth);
    const googleToday = Math.round((45 + rand() * 35) * weekendFactor * growth);

    for (let i = 0; i < msToday; i++) {
      // Business hours with a lunch dip.
      const hour = 7 + Math.floor(Math.pow(rand(), 0.85) * 11);
      const ts = new Date(date);
      ts.setUTCHours(hour, Math.floor(rand() * 60), Math.floor(rand() * 60), 0);

      const touchesData = rand() < 0.42;
      const resources = touchesData
        ? Array.from({ length: 1 + Math.floor(rand() * 3) }, () => RESOURCES[Math.floor(rand() * RESOURCES.length)]!)
        : [];
      const labelled = touchesData && rand() < 0.28;

      events.push({
        id: `demo-ms-${msCount++}`,
        timestamp: ts.toISOString(),
        provider: 'microsoft',
        user: MS_USERS[skewedIndex(rand, MS_USERS.length)]!,
        app: weightedPick(rand, MS_APPS),
        operation: weightedPick(rand, MS_OPS),
        clientIp: `10.${20 + Math.floor(rand() * 8)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`,
        model: rand() < 0.7 ? 'gpt-4o' : 'gpt-4.1',
        accessedResources: [...new Set(resources)],
        sensitivityLabels: labelled ? [LABELS[Math.floor(rand() * LABELS.length)]!] : [],
      });
    }

    for (let i = 0; i < googleToday; i++) {
      const hour = 7 + Math.floor(Math.pow(rand(), 0.85) * 11);
      const ts = new Date(date);
      ts.setUTCHours(hour, Math.floor(rand() * 60), Math.floor(rand() * 60), 0);

      events.push({
        id: `demo-g-${googleCount++}`,
        timestamp: ts.toISOString(),
        provider: 'google',
        user: GOOGLE_USERS[skewedIndex(rand, GOOGLE_USERS.length)]!,
        app: weightedPick(rand, GOOGLE_APPS),
        operation: weightedPick(rand, GOOGLE_OPS),
        clientIp: `10.${40 + Math.floor(rand() * 4)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`,
        accessedResources: rand() < 0.5 ? [`Surface: ${rand() < 0.5 ? 'Help Me Write' : 'Side Panel'}`] : [],
        sensitivityLabels: [],
      });
    }
  }

  const results: ProviderResult[] = [
    {
      provider: 'microsoft',
      events: events.filter((e) => e.provider === 'microsoft'),
      truncated: false,
      warnings: [],
      diagnostics: { mode: 'demo', source: 'synthetic' },
    },
    {
      provider: 'google',
      events: events.filter((e) => e.provider === 'google'),
      truncated: false,
      warnings: [],
      diagnostics: { mode: 'demo', source: 'synthetic' },
    },
  ];

  return { events, results };
}
