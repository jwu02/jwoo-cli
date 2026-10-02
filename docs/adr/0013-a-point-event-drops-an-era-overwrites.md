# A point event drops, an era overwrites

> Grilled in #44 (2026-09-30); recorded when the Push seam (#45) was specified.
> Amended in #49 (2026-10-02): the cutover clears the ObjectId-keyed documents instead of
> accepting their duplication.

The Local Store holds two document families, and a retry reaches each through a different
door — so one store now carries two dedup rules, and they are deliberately not the same
rule.

An era's retry **overwrites**. A failed Flush leaves Telemetry State intact (ADR-0009), so
what re-Flushes is the same era carrying **more** Activity — a Snapshot that grew, which no
content hash recognises. What identifies it is the era itself, carried under its stamp; the
retry writes the same `_id`s and the upsert overwrites the partial write.

A Usage Record's re-Ingest **drops**. A record is a point event whose identity is content:
the same turn Ingested again — a Stop hook re-firing, a backfill walking a transcript the
live hook already covered — carries the same fingerprint and the same transcript-derived
`recorded_at`, so an overwrite would write nothing new. First writer wins; the duplicate
Ingest is dropped, and reports itself as a duplicate rather than as a write.

## The fingerprint

The fingerprint is the model plus the five token buckets, compared within a symmetric ±5s
window around `recorded_at` — the window `ai-usage/usage-lib.mjs` always used, moved here
because Mongo stopped being queried for dedup (ADR-0012). It deliberately **excludes**
`harness` and `cwd`: two Harnesses producing identical model and token counts within the
window would collapse into one record. That is an accepted ceiling, marked by a comment
where the comparison is built.

The fingerprint is not a stored column: the store compares the six fingerprint columns
inside the ±5s window, and the fingerprint string exists only where it is consumed, which
is the Push seam's `_id` (below). A derived column would be a second encoding of the same
fact to keep in step.

## Why the content still keys the Mongo side

Mongo is never read (ADR-0012), so the write itself must be idempotent. A Usage Record's
`_id` is `<recorded_at>#<sha256 of the fingerprint>`, written through `replaceOne` upsert —
the same shape an era's stamp gives its documents (ADR-0009). The consequence is
convergence without a query: a Local Store wiped and re-Ingested from the same transcripts
Pushes the same `_id`s, and the upsert overwrites rather than duplicates.

## Consequences

- The two rules are not symmetric and must not be "unified". Making the record overwrite
  loses nothing today but hides a real duplicate the day a caller Ingests a _corrected_
  record; making the era drop loses Activity outright, because its retry is not the same
  Snapshot. If a rule ever moves, it moves with a new ADR.
- Records the retired `ai-usage/` scripts wrote straight to Mongo under driver-assigned
  ObjectIds carry no content `_id`, so a CLI backfill over the same turns would duplicate
  them. The cutover clears them instead — once the re-backfill's Usage Backlog has drained,
  the ObjectId-keyed documents are deleted by `_id` type, one command and no reconciliation
  machinery — so the overlap window never materializes (#49).
- Dedup granularity is the record's own. A turn's summed tokens is one record — the
  corrected Usage Record definition — so the window's ambiguity is bounded by how the
  Harness reports.
