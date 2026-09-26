# A Flush writes idempotently, keyed by its stamp

> **Status note (2026-09-25).** ADR-0012 moves the stamp's home. The Flush writes the era to the
> Local Store under its stamp — a primary key, so the retry overwrites as it did — and the Push
> writes the era's documents to MongoDB under the same stamp, upserting. The stamp guard is
> seeded from the Local Store's newest stamp at open, so a stamp repeats nobody across runs
> either.

A Flush writes two documents sequentially — the Telemetry Document, then the Key Count
Document when keys were pressed. Nothing makes the pair atomic, and nothing has to: Telemetry
State is cleared only after a successful Flush, so a failed Flush retries on the next Flush
Interval. But the retry, before this decision, re-inserted. If the Key Count Document's write
failed after the Telemetry Document's had landed, the retry wrote a **second** Telemetry
Document for the same era, and the history view — which sums Telemetry Documents — silently
doubled Press Total, Clicks and Mouse Distance. The inflation was invisible precisely because
the totals and the time series still reconciled with each other (#12).

## The options, and why the simple ones lose

- **Write the Key Count Document first.** Moves the duplicate onto the other document rather
  than removing it: a write that fails after the first landed still leaves the first behind,
  and a duplicated Key Count Document inflates every key in the Heatmap by the same rule that
  a duplicated Telemetry Document inflates the totals.
- **One transaction.** Atlas is a replica set, so transactions exist, but they grow the
  storage seam by a session's worth of driver surface for a two-document write — and every
  fake in the suite would have to lie about that surface too.
- **Idempotent writes.** Chosen.

## The decision

Every document a Flush writes is keyed by `_id = "<stamp>#<collection name>"` (`documentId`),
where the stamp is the Flush's `createdAt`, and written through `replaceOne(…, {upsert: true})`
rather than `insertOne`. `insertOne` is gone from the `Collection` slice.

The stamp is what makes this work, and choosing it is the whole subtlety. A failed Flush's
Telemetry State is not cleared, so the retry on the next interval carries the same counters
**plus whatever arrived since** — it is not the same Snapshot, and no content hash recognises
it. What identifies it is the era: everything observed since the last successful Flush. The
store therefore keeps a failed Flush's stamp outstanding (`#outstandingStamp`) and the retry
writes under it, so its documents key the same `_id`s and the upsert overwrites the partial
write instead of adding to it. The first success closes the era and the next Flush stamps
fresh documents.

### Why the stamp is not recomputed from the clock

The issue sketched `_id` as `createdAt` truncated to the Flush Interval. Under the Session's
actual retry semantics that key never matches: consecutive attempts are at least one interval
apart, so truncating to that same interval sends every retry to a different bucket. The stamp
must be **carried** across the retry, not recomputed — which is also why the store owns it and
the Session never sees it. Carrying it costs one `Date` field and buys convergence; recomputing
it buys nothing and dedupes nothing.

### Why a fresh stamp never repeats

`#freshStamp` nudges the wall clock forward past the previous stamp when the clock has not
moved yet. Two eras in the same millisecond would otherwise key the same documents, and the
second era's upsert would overwrite the first era's data — a loss, not a duplicate. The
Session paces Flushes an interval apart, so the clock repeating is unreachable in practice;
the store does not lean on its caller's pacing for correctness. The price is a `createdAt`
that can lead real time by a millisecond.

### What a failure opens

The outstanding stamp is opened on **every** failure, not only where a write is known to have
landed: a write that timed out may have been applied by the server anyway — the
acknowledgement was lost, not the write — and only its own stamp can overwrite it. When
nothing landed, the reuse is harmless: there is nothing under the old stamp to overwrite.

## Schema

ADR-0004 froze the write-side shape: Key Counts stay flat numeric scalars and `createdAt`
stays a real BSON Date. Both hold. `_id` is the one field every reader already excludes —
`keyCountsPipeline` filters it out of the unfold, `totalsPipeline` names its fields, and the
website's reader does the same — so keying a document costs the readers nothing. Documents
written before this change carry driver-assigned ObjectIds; the two id kinds coexist, because
no reader reads `_id`.

A document's `createdAt` is its era's stamp — when the first write attempt happened — and the
counters it carries may include Activity observed after that instant, whatever arrived while
the era was being retried. The readers bucket on `createdAt`, so an era lands where its first
attempt put it; the skew is bounded by how long a broken write takes to heal.

## Consequences

- A partial write converges. However many times a Flush of the same Telemetry State fails,
  the collections end with one document per collection for the era, holding the union.
- A crash between the two writes is safe by a different route: the crash loses the in-memory
  state, so nothing is retried into a duplicate — the era's Telemetry Document remains as the
  only record of its counters rather than becoming one of two.
- The deduplication lives entirely inside `storage.ts`. The Session's contract is unchanged —
  `undefined` means keep Telemetry State — and the fake-backed suite exercises the convergence
  directly, including the acknowledgement-lost case.
- One store per Telemetry State remains the shape: two stores would hold two outstanding
  eras, and each era's retry would overwrite only its own documents. `main.tsx` builds one.
