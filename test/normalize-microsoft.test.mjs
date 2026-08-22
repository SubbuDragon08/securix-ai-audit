/**
 * The Microsoft path, exercised without a tenant.
 *
 * Everything between "Graph returned records" and "the report shows a row" is
 * pure logic, and it is the part most likely to be wrong the first time this
 * runs in someone else's tenant — Purview's `auditData` is an untyped bag whose
 * casing and shape vary by workload, and a parsing mistake shows up as a blank
 * column rather than an error.
 *
 * The fixtures are modelled on real CopilotInteraction record shapes, including
 * the awkward ones: auditData as a JSON string, camelCase envelopes, missing
 * timestamps, unmapped AppHost values.
 *
 * Assertions are written against what an ADMIN should see, not against the
 * current implementation, so they stay meaningful if the internals change.
 *
 *   node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyLabelNames, normalizeMicrosoft, sortEvents } from '../dist/normalize.js';
import { renderReport } from '../dist/report.js';

const here = dirname(fileURLToPath(import.meta.url));
const RECORDS = JSON.parse(
  readFileSync(join(here, 'fixtures', 'copilot-audit-records.json'), 'utf8'),
);

const OPTS = { includeRaw: false };
const events = normalizeMicrosoft(RECORDS, OPTS);
const byCase = (fragment) =>
  events.find((e) => e.id === RECORDS.find((r) => r._case.includes(fragment)).id);

// ---------------------------------------------------------------------------
// Record selection and dropping
// ---------------------------------------------------------------------------

test('drops only the record with no usable timestamp', () => {
  // 10 fixtures in, exactly one has no timestamp anywhere.
  assert.equal(RECORDS.length, 10);
  assert.equal(events.length, 9);
  assert.ok(
    !events.some((e) => e.user === 'ghost@contoso.com'),
    'a record with no timestamp must be dropped rather than given a guessed date',
  );
});

test('every surviving event has a valid ISO timestamp', () => {
  for (const e of events) {
    assert.ok(Number.isFinite(Date.parse(e.timestamp)), `bad timestamp: ${e.timestamp}`);
  }
});

test('falls back to auditData.CreationTime when the envelope has no date', () => {
  const e = byCase('No envelope timestamp');
  assert.equal(e.timestamp, '2026-08-20T12:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('user identities are lower-cased so they group correctly', () => {
  const e = byCase('Standard Copilot Chat');
  // Purview returns mixed case; ungrouped "A.Okafor@" vs "a.okafor@" would
  // split one person into two rows in Top Users.
  assert.equal(e.user, 'a.okafor@contoso.com');
});

test('falls back to userId when userPrincipalName is absent', () => {
  const e = byCase('No userPrincipalName');
  assert.equal(e.user, 'system.account@contoso.com');
});

// ---------------------------------------------------------------------------
// Shape tolerance — the parts most likely to break against a real tenant
// ---------------------------------------------------------------------------

test('parses auditData delivered as a JSON string', () => {
  const e = byCase('JSON STRING');
  assert.equal(e.app, 'Word');
  assert.deepEqual(e.accessedResources, ['Board Deck Q3.pptx (File)']);
});

test('parses camelCase envelopes as well as PascalCase', () => {
  const e = byCase('camelCase');
  assert.equal(e.app, 'Outlook');
  assert.deepEqual(e.accessedResources, ['Q3 Forecast.xlsx (File)']);
});

test('survives a record with no CopilotEventData at all', () => {
  const e = byCase('No CopilotEventData');
  assert.ok(e, 'record must still produce an event');
  assert.equal(e.accessedResources.length, 0);
  // Falls back to the service name rather than rendering blank.
  assert.equal(e.app, 'Copilot');
});

// ---------------------------------------------------------------------------
// Surface naming
// ---------------------------------------------------------------------------

test('maps bizchat to the name admins actually recognise', () => {
  assert.equal(byCase('Standard Copilot Chat').app, 'Microsoft 365 Copilot Chat');
});

test('passes an unmapped AppHost through readably instead of blanking it', () => {
  // Microsoft adds surfaces regularly; an unknown one must degrade gracefully.
  assert.equal(byCase('Unknown AppHost').app, 'Some New Surface');
});

test('keeps the operation verbatim so agent activity stays distinguishable', () => {
  assert.equal(byCase('Agent surface').operation, 'AIAppInteraction');
  assert.equal(byCase('Standard Copilot Chat').operation, 'CopilotInteraction');
});

// ---------------------------------------------------------------------------
// Grounded resources — the security payload of the whole report
// ---------------------------------------------------------------------------

test('extracts grounded file names with their type', () => {
  const e = byCase('Standard Copilot Chat');
  assert.ok(e.accessedResources.includes('FY26 Headcount Plan.xlsx (File)'));
  assert.ok(e.accessedResources.includes('Severance Policy v4.docx (File)'));
});

test('de-duplicates repeated resources within one record', () => {
  const e = byCase('Duplicate resources');
  assert.deepEqual(e.accessedResources, ['Pricing Model 2026.xlsx (File)']);
});

test('captures the model name when Microsoft reports it', () => {
  assert.equal(byCase('Standard Copilot Chat').model, 'gpt-4o');
  assert.equal(byCase('Agent surface').model, 'gpt-4.1');
});

test('never invents resources for records that grounded on nothing', () => {
  assert.deepEqual(byCase('Unknown AppHost').accessedResources, []);
});

// ---------------------------------------------------------------------------
// Sensitivity labels
// ---------------------------------------------------------------------------

test('carries raw label GUIDs through before resolution', () => {
  const e = byCase('Standard Copilot Chat');
  assert.equal(e.sensitivityLabels.length, 2);
  assert.ok(e.sensitivityLabels.includes('8faca7b8-8d20-48a3-8ea2-0f96310a848e'));
});

test('resolves label GUIDs to display names, case-insensitively', () => {
  const names = new Map([
    // Graph returns mixed-case GUIDs; the lookup must not care.
    ['8FACA7B8-8D20-48A3-8EA2-0F96310A848E'.toLowerCase(), 'Highly Confidential'],
    ['1f2e3d4c-5b6a-7988-9a0b-1c2d3e4f5a6b', 'Confidential \\ Finance'],
  ]);
  const resolved = applyLabelNames(events, names);
  const e = resolved.find((x) => x.id === byCase('Standard Copilot Chat').id);
  assert.deepEqual(e.sensitivityLabels.sort(), ['Confidential \\ Finance', 'Highly Confidential']);
});

test('leaves unknown label GUIDs untouched rather than blanking them', () => {
  const resolved = applyLabelNames(events, new Map([['not-a-real-id', 'Nope']]));
  const e = resolved.find((x) => x.id === byCase('Standard Copilot Chat').id);
  assert.ok(e.sensitivityLabels.every((l) => l.includes('-')), 'GUIDs should survive unresolved');
});

test('an empty label map is a no-op, not a wipe', () => {
  const resolved = applyLabelNames(events, new Map());
  assert.deepEqual(resolved, events);
});

// ---------------------------------------------------------------------------
// End to end: does an admin actually SEE this in the report?
// ---------------------------------------------------------------------------

test('renders a Microsoft-only report containing the real values', () => {
  const labelled = applyLabelNames(
    events,
    new Map([['8faca7b8-8d20-48a3-8ea2-0f96310a848e', 'Highly Confidential']]),
  );
  const html = renderReport(sortEvents(labelled), {
    generatedAt: '2026-08-22T00:00:00.000Z',
    windowStart: '2026-08-19T00:00:00.000Z',
    windowEnd: '2026-08-21T00:00:00.000Z',
    tenantLabel: 'contoso.com',
    toolVersion: 'test',
    redacted: false,
    results: [
      { provider: 'microsoft', events: labelled, truncated: false, warnings: [], diagnostics: {} },
    ],
  });

  const payload = JSON.parse(
    html.slice(
      html.indexOf('type="application/json">') + 'type="application/json">'.length,
      html.indexOf('</script>', html.indexOf('type="application/json">')),
    ),
  );

  assert.equal(payload.meta.primaryProvider, 'microsoft', 'must render the single-provider layout');
  assert.equal(payload.rows.length, 9);
  assert.ok(
    payload.dict.users.includes('a.okafor@contoso.com'),
    'the user dictionary must carry real identities',
  );
  assert.ok(
    payload.dict.apps.includes('Microsoft 365 Copilot Chat'),
    'surfaces must reach the report',
  );
  assert.ok(
    payload.dict.resources.some((r) => r.startsWith('FY26 Headcount Plan.xlsx')),
    'grounded files must reach the report — this drives Most-read tenant files',
  );
  assert.ok(
    payload.dict.labels.includes('Highly Confidential'),
    'resolved label names must reach the report, not GUIDs',
  );
});

test('report escapes a resource name that would otherwise break out of the script tag', () => {
  // A tenant user can name a file anything, including </script>.
  const hostile = normalizeMicrosoft(
    [
      {
        id: 'hostile-1',
        createdDateTime: '2026-08-20T09:00:00Z',
        operation: 'CopilotInteraction',
        userPrincipalName: 'x@contoso.com',
        auditData: {
          CopilotEventData: {
            AppHost: 'Teams',
            AccessedResources: [{ Name: '</script><img src=x onerror=alert(1)>', Type: 'File' }],
          },
        },
      },
    ],
    OPTS,
  );

  const html = renderReport(hostile, {
    generatedAt: '2026-08-22T00:00:00.000Z',
    windowStart: '2026-08-19T00:00:00.000Z',
    windowEnd: '2026-08-21T00:00:00.000Z',
    tenantLabel: 'contoso.com',
    toolVersion: 'test',
    redacted: false,
    results: [
      { provider: 'microsoft', events: hostile, truncated: false, warnings: [], diagnostics: {} },
    ],
  });

  assert.ok(!html.includes('</script><img'), 'raw closing tag must not survive into the document');
  assert.ok(html.includes('\\u003c/script\\u003e'), 'it must be present but escaped');
});
