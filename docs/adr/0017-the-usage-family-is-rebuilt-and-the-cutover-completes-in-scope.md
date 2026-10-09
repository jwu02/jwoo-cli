# The usage family is rebuilt from the artifacts, and the Cutover completes in scope

> Grilled across #66–#69 (2026-10-03 → 2026-10-08); recorded and executed in #70
> (2026-10-09). It records the wire fields the Usage Record family gained, and the runbook
> that emptied the Local Store's usage rows, deleted the pre-cutover documents a rebuild
> supersedes, and left the ones no artifact can rebuild.
> Amends ADR-0013's "deleted by `_id` type" consequence: the cleanup is scoped, not
> wholesale.

Every Usage Record carries how many Tool Calls its Harness made and the names of the Skill
Invocations it made. Because Ingest drops a duplicate (ADR-0013), no per-row repair can add
those fields to records already Ingested: the past is filled by **rebuilding the usage
family** — the Local Store's usage rows are emptied, the three Backfills re-run, and the
Usage Backlog Drains. The never-completed **Cutover** is finished **in scope** at the same
time: the pre-cutover documents a rebuild supersedes are deleted, and the ones no artifact
can rebuild are kept and stay field-less forever.

## The two fields

The Usage Record gains `tool_calls` — one scalar count of the Tool Calls the assistant made
in the record's span — and `skills` — the Skill Invocation names in order, repeats kept. A
Skill Invocation that the Harness reports as a tool call counts inside `tool_calls` too:
Claude's `Skill` block and OpenCode's `skill` part do, while Pi's `<skill>` tag is a user
message and adds no count. Both are **optional, and absent means unknown**, while `0` and
`[]` mean genuinely none. There is no stored distinct-skill count:
the list is the record and its length is the count, so a second number would be a second
encoding of one fact. No invariant such as `tool_calls >= skills.length` is asserted or
relied on, because a Harness need not report the two from the same set of events.

Three glossary entries carry the words — **Tool Call**, **Skill**, **Skill Invocation** — and
the Harness entry's banned sense of "tool" is disambiguated in the first.

**The wire is twelve fields.** The pushed document gains `tool_calls` (a number or `null`)
and `skills` (an array of strings or `null`), and the existing "absent becomes `null`, never a
missing key" rule extends to them, so the website's aggregation never reads an absent key on a
document a Backfill wrote. The kept legacy documents predate the rule and have no such key at
all; a missing key and a `null` both mean unknown to the reader. The
content `_id` is **unchanged**: still `<recorded_at>#<sha256 of model plus the five token
buckets>`, so a re-Push converges on the same key and an existing content-keyed document is
overwritten by its rebuild rather than duplicated beside it.

**The single derivation point stays the projection.** All three Harness projections are still
the one place the two fields are derived. Claude's transcript walk counts the turn's
`tool_use` blocks and adds a `Skill` block's `input.skill` to the list; the Pi projection
counts the message's `toolCall` blocks and takes the turn's Skill list as an argument the
session walk and the Shim both supply; OpenCode's message projection takes the count and names
the database read or the Shim derives from its `part` rows. A Harness that reports neither
leaves both fields absent, which is unknown.

**The Local Store moves to v3 additively.** Two columns (`tool_calls` integer, `skills` text
holding a JSON array) are added by `ALTER TABLE`, so every existing row reads back with both
absent — unknown — and a v2 store on any machine upgrades in place. Ingest, dedup and the
priced-once rule are untouched: this added a field, not a fill path.

## Why a rebuild

A Usage Record's identity is content (ADR-0013), so a per-row repair is not available: a
"repair" that re-Ingested the same turn would drop as a duplicate and write nothing. The
fields can only reach the past by re-ingesting turns that are no longer in the store from the
Harness artifacts that still hold them, which is the definition of a Backfill. Emptying the
usage rows first is what lets the Backfill's Ingest face — the same face a live hook uses —
land them all, and the content `_id` makes the re-Push of any document that survives
convergent rather than additive.

## Completing the Cutover in scope

The Cutover (CONTEXT.md) ends by clearing the retired scripts' documents once the re-backfill
has Pushed. ADR-0013 recorded that cleanup as a deletion "by `_id` type"; #66's audit found
that a blanket wipe would destroy records no artifact can rebuild, so the cleanup here is
scoped by **Harness, `_id` type and time** instead:

- **Deleted** — every ObjectId-keyed OpenCode document, and every ObjectId-keyed Claude Code
  document at or after the earliest surviving transcript's instant. These are the documents a
  rebuild **supersedes**; leaving them would double-count the rebuilt records on the
  dashboard.
- **Kept** — every ObjectId-keyed Claude Code document _before_ the earliest surviving
  transcript, and every ObjectId-keyed DeepSeek Harness document. No artifact can rebuild
  them, so they survive and stay field-less (unknown) permanently rather than being guessed
  at.
- **Never read** — content-keyed documents are untouched by the cleanup. A rebuilt record
  overwrites its own content key; a content-keyed document no surviving artifact can rebuild
  is an orphan the rebuild leaves as it was.

The time boundary is the earliest `recorded_at` among the Claude Backfill's candidates — the
earliest instant any surviving transcript can rebuild. It is a **time** scope, not a
record-by-record reconciliation: a document at or after that instant whose own transcript has
been pruned is deleted and accepted as lost (the "Pruned Orphan Resolution" gap #66 declined
to build machinery for), and no kept document can duplicate a rebuilt one because every
candidate is at or after the boundary.

## The runbook

A one-time operator procedure, not a CLI command — no `usage reset` exists by design.

1. **Size it.** Run each Backfill with `--dry-run` and record the summary line. Count
   `ai_usage` by `_id` type and Harness, and compute the earliest Claude candidate's
   `recorded_at` from the transcript walk. Confirm the candidate counts against the superseded
   document counts, and accept and record any gap rather than chase it.
2. **Back it up.** Dump `ai_usage` before deleting, so the scoped delete is reversible.
3. **Delete the superseded documents**, scoped and nothing else:
   - `{_id: {$type: 'objectId'}, harness: 'OpenCode'}`
   - `{_id: {$type: 'objectId'}, harness: 'Claude Code', recorded_at: {$gte: <earliest candidate>}}`
4. **Empty the usage rows.** `DELETE FROM usage_records` in the Local Store, leaving `eras`
   and `era_key_counts` untouched. The era family is not part of the usage family.
5. **Re-run the three Backfills.** Each Ingests and Drains through the same face a live hook
   uses.
6. **Verify.** The kept ObjectId documents still number what they did and carry no
   `tool_calls`/`skills` key — a missing key, which the website reads as unknown; the
   absent-becomes-`null` rule governs documents a Backfill wrote, not these. The rebuilt
   documents carry both; no two _rebuilt_ documents share a content fingerprint; no Usage
   Backlog remains.

## The 2026-10-09 run

Measured before anything was deleted:

| Backfill    | Artifacts         | Candidates | Would-ingest | Duplicates |
| ----------- | ----------------- | ---------- | ------------ | ---------- |
| Claude Code | 1,333 transcripts | 2,585      | 2,513        | 72         |
| OpenCode    | 1,990 messages    | 1,939      | 1,929        | 10         |
| Pi          | 152 sessions      | 4,535      | 30           | 4,505      |

`ai_usage` held 10,602 documents: 4,583 content-keyed and 6,019 ObjectId-keyed (Claude Code
4,014, OpenCode 1,907, DeepSeek 98). The earliest surviving Claude transcript was
`2026-08-19T02:42:30.143Z`, which put 2,624 Claude documents at or after the boundary
(deleted) and 1,390 before it (kept); the 39-document gap between 2,624 deleted and 2,585
candidates, plus the 4 in-scan duplicate candidates, is the accepted loss.

After the Local Store's 4,584 usage rows were emptied and the Backfills re-run:

| Backfill    | Ingested | Duplicates | Pushed |
| ----------- | -------- | ---------- | ------ |
| Claude Code | 2,581    | 4          | 2,581  |
| OpenCode    | 1,939    | 0          | 1,940  |
| Pi          | 4,545    | 4          | 4,545  |

Sizing, confirmed against the candidates: Claude's 2,624 deleted documents are 39 more than
its 2,585 candidates — the accepted loss above — while OpenCode's 1,939 candidates exceed its
1,907 deleted documents by 32, so nothing is lost and the rebuild recovers 32 records the
retired script never wrote. Pi had no superseded ObjectId documents, so its 4,545 records are
pure recovery. Claude's is the only gap.

`ai_usage` then held 9,075 rebuilt content-keyed documents — Claude Code 2,581, OpenCode
1,939, Pi 4,555 — beside 1,488 kept ObjectId documents (Claude Code 1,390, DeepSeek 98), none
of which carries either field. The 9,075 is the Backfills' 9,065 plus ten records a live Pi
session Ingested during and after the run; the Local Store held the same 9,075 Usage Records
with none awaiting Push. The four OpenCode records whose model (`hy3`) is Unpriced Ingests
with a null cost, as ever.

The cleanup found eleven pairs of identical-fingerprint documents among the **kept**
pre-boundary Claude documents — duplicates the retired scripts wrote, unreachable by any
rebuild and left as they are. They stay, so the run leaves the dashboard free of _rebuild_
duplication rather than of all legacy duplication; the criterion is that no record is counted
twice _because of the rebuild_. No rebuilt record duplicates another, and none duplicates a
kept document.

Counts move while a Harness session is open; the figures above are a snapshot at the moment of
verification, not a fixed point.

## Consequences

- A record that predates the feature, or whose Harness did not report it, reads unknown
  forever; the kept documents carry no key at all, which the website must read as unknown
  rather than zero. Filling them would need a new artifact, not a repair.
- The rebuild is repeatable: a second `--dry-run` after the run reports every candidate as a
  duplicate, and a second rebuild converges on the same `_id`s. The next schema change has a
  path.
- The website's aggregation and rendering of the two fields are a companion change in the site
  repository, not this one; this ADR pins the wire contract they read.
