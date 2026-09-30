# Cost is priced once, at Ingest, at the record's own instant

> Grilled in #47 (2026-09-30); the charting note in #42, recorded where the code lands.

A Usage Record's `cost_yuan` is computed when the record Ingests — from the Pricing table,
at the record's own `recorded_at` — and stored with it. Nothing recomputes it afterwards:
the website reads the stored number, and a rate edit reaches only records Ingested after
it.

## Why the record's own instant

DeepSeek's peak/off-peak split turns on Beijing time at the instant priced, so the instant
is not a detail: the wall clock at Ingest would misprice every backfill — a transcript's
turns are hours or months old — and every hook delivery delayed across a peak boundary.
`recorded_at` is the only instant the record truly knows, which is why the fingerprint
uses it too (ADR-0013). The retired scripts priced at `recordedAt || new Date()`; that
fallback moves to the command layer, before the record exists — by the time a record
Ingests, its `recorded_at` is set.

## Consequences

- Editing the Pricing table never changes a stored cost. A rate correction is not a
  repair; history keeps the rate it was priced at, and mixed-rate history is expected.
- A rate typo is frozen into every record Ingested under it — which is why the Pricing and
  alias tables are pinned as literals by `pricing.test.ts`, making a rate edit two
  deliberate edits.
- The website never prices. It renders stored `cost_yuan` and stays unchanged when rates
  move.
- Unpriced is permanent by the same stroke: a fill-later door was proposed in #46 and
  declined — cost is not in the fingerprint (ADR-0013), so re-Ingesting the same
  transcripts drops as duplicate and the null stays null.
