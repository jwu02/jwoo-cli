# Telemetry

Personal activity telemetry for a single user. A local CLI observes mouse and keyboard
input on the author's own machine, accumulates counts in memory, periodically Flushes
them to a Local Store on the same machine, and Pushes them to MongoDB Atlas, where a
personal website renders them as a mouse and keyboard heatmap. The same Local Store carries
a second family — AI usage Ingested from coding-agent Harnesses — which Pushes by the same
rules. The CLI reads only the Local Store; MongoDB is write-only to it (ADR-0012).

## Language

### Collection

**Collector**:
A component that observes one kind of input — mouse or keyboard — and contributes counts
to Telemetry State.
_Avoid_: listener, tracker, monitor, agent, hook

**Activity**:
Countable input observed since the last Flush. Decides whether a Flush is attempted at all.
_Avoid_: events, traffic, signal

**Collector Disabled**:
A Collector that is running but producing nothing because the macOS permission it needs has
not been granted. The remaining Collectors keep working; a missing permission degrades
collection rather than stopping the CLI.
_Avoid_: failed, errored, offline, unhealthy

**Key Label**:
The identity recorded for a key: the uppercase printable character it produces (`A`, `$`,
`!`), or a fixed name for a key that produces none (`Return`, `Left Cmd`, `Fn`). Labels are
always those of a UK Mac keyboard, regardless of the host machine, and a key that maps to no
label is dropped silently.
_Avoid_: keycode, key name, key id, virtual keycode, scancode

**Key Counts**:
How many times each Key Label was pressed during an interval. Ordered by label rather than by
time, so the sequence of presses is not recoverable.
_Avoid_: keyboard heatmap (that is the rendering — see Heatmap)

**Press Total**:
The number of key presses in an interval, summed across all Key Labels.

**Mouse Distance**:
Pointer travel during an interval, in metres, derived from accumulated pixel movement and the
configured DPI.
_Avoid_: movement, mouse movement

**Heatmap**:
The rendering of Key Counts as a coloured keyboard. A presentation of Key Counts, not the
counts themselves. The website's rendering; the CLI draws a Key Ranking instead — see below.

### Accumulation and persistence

**Telemetry State**:
The in-memory accumulator holding everything observed since the last successful Flush.

**Snapshot**:
An immutable copy of Telemetry State, safe to hand to storage.
_Avoid_: dump, export, freeze

**Flush**:
Writing a Snapshot to the Local Store. Telemetry State is cleared only on a successful Flush;
a failed Flush leaves it intact so the same Activity is retried on the next interval rather
than lost (ADR-0009).
_Avoid_: save, persist, sync, upload, commit (and Push — that is the write to MongoDB, not this)

**Flush Interval**:
How long Telemetry State accumulates before a Flush is attempted.

**Era**:
The Activity accumulated between one successful Flush and the next — what one Telemetry State
holds while it is being written. A Flush that fails stays in its era: the retry completes the
same era rather than opening a new one. The era keeps the stamp of the write that recorded it,
and a Push retries under that stamp, overwriting rather than duplicating (ADR-0009).
_Avoid_: epoch, generation, attempt (an attempt is one try; an era can span several)

**Telemetry Document**:
One flushed interval's mouse and keyboard totals.

**Key Count Document**:
One flushed interval's Key Counts, written only when keys were pressed during it.

**Local Store**:
The durable local record of every era this machine has Flushed: the CLI's only source for the
history view, and the only write a Flush is required to reach. It is one machine's record — it
holds what this machine observed and nothing else — and MongoDB is never read to fill it
(ADR-0012).
_Avoid_: cache (nothing here is a copy of the database), local database, journal, log file

**Push**:
Writing a Flushed era or an Ingested Usage Record to MongoDB, where the website reads it.
Best-effort: whatever fails to Push waits in a backlog and is retried — an era under its own
stamp (ADR-0009), a Usage Record under its content (ADR-0013) — overwriting what a lost
acknowledgement landed rather than adding to it. A Push that has not happened costs the
website what it was carrying; it never costs the CLI anything.
_Avoid_: save, persist, sync, upload, commit (and Flush — that is the write to the Local Store,
not this)

**Push Backlog**:
Flushed eras not yet Pushed — the tail of the Local Store past the last successful Push. A fact
about the network rather than about the run: it exists while the machine is offline and drains
without ceremony once Pushes land again.
_Avoid_: queue, pending writes, failed Flushes (the Flushes succeeded)

**Drain**:
Pushing a backlog, oldest entry first, stopping at the first failure so the backlog stays a
tail rather than a scatter of holes. The Push Backlog drains oldest era first; the Usage
Backlog drains oldest `recorded_at` first, at the end of the invocation that touched it.
_Avoid_: catch-up, retry loop, sync

### AI usage

**Harness**:
The coding agent whose usage a record attributes: Claude Code or OpenCode. The CLI names
the harness — the command that Ingests decides the string; a Harness never self-reports
its own name. DSH stays out of scope, in `ai-usage/` — see Deliberately absent.
_Avoid_: tool, client, agent (ADR-0001), provider, self-reported

**Shim**:
The OpenCode-side plugin file that observes OpenCode's `message.updated` and Ingests each
completed assistant message by spawning the CLI command. Source lives in this repo, installed
into OpenCode's plugin directory; it owns the guard and the spawn, nothing else.
_Avoid_: plugin, hook (Claude Code's term), bridge, adapter, watcher

**Usage Record**:
One LLM usage event as the Harness reports it — a turn's summed tokens or a single request's
— with its cost and its own `recorded_at`. A point event: identity is content, so a
re-Ingest near the same instant is dropped rather than rewritten (ADR-0013). An unpriced
model still Ingests: the record's cost is null, not the record absent.
_Avoid_: usage event (that is the helper's wire format), request, turn (neither names the
record), document (a Telemetry Document family word), invalid, incomplete (an unpriced
record is a record)

**Pricing**:
The CNY-per-1M-token rates a model is charged: cache-miss, cache-hit and output, with a
DeepSeek peak/off-peak split selected by Beijing time at the record's own `recorded_at`.
A model name prices only by exact match on its normalized form — the alias table, not a
substring, carries the variants. Applied once, at Ingest: a stored cost never reprices
when the rates change (ADR-0014, ADR-0015).
_Avoid_: rates, tariff, billing, cost (that is the computed number a record carries)

**Unpriced**:
A Usage Record whose model matches no Pricing entry. It Ingests all the same — absent
pricing is not an absent record — and priced-once means no later alias repairs it: the
null cost is permanent unless a repair door is ever built. The accepted state of a name
not yet covered, not a defect.
_Avoid_: unknown model, invalid, zero-cost, missing model

**Ingest**:
Writing a Usage Record to the Local Store. Dedup happens at Ingest time, inside the store,
so every caller — a live hook and a backfill alike — comes through the same face.
_Avoid_: record (the noun), save, persist, sync, insert, import, log, Flush

**Usage Backlog**:
Ingested Usage Records not yet Pushed. It drains at the end of the CLI invocation that
touched it — the usage commands, and nothing else, write usage — oldest `recorded_at` first,
stopping at the first failure so the tail stays a tail.
_Avoid_: queue, pending writes, failed Ingests

**Backfill**:
Ingesting Usage Records for turns that predate their Harness's live hook, by re-reading the
Harness's own artifacts — Claude Code's transcript files, OpenCode's SQLite database. A
Backfill Ingests through the same face as a live hook, and the same drop rule makes it
idempotent: re-running adds nothing. A scan of the past, not a second kind of record.
_Avoid_: import, migration, replay, bulk load, sync (and Drain — a Backfill's records join
the Usage Backlog, whose Drain still happens at the invocation's end)

**Cutover**:
The switch from scripts writing Usage Records straight to MongoDB to the CLI's
Ingest-then-Push path. It ends with the scripts' ObjectId-keyed documents cleared once the
re-backfill has Pushed.
_Avoid_: migration, cutover date (there is no single date — the wipe follows the first
successful backfill, not the calendar)

### The reader

**Physical Key**:
A key on the M3 Air 13" UK layout, named for where it sits rather than what it prints.
Key Labels map onto Physical Keys; the reader discards any label it does not recognise, without
error.
_Avoid_: using Physical Key for a Key Label or vice versa — they are different identities either
side of a one-way mapping

Note that the mapping is the _website's_ reader. The CLI has no `key-layout.ts` and no Physical
Key: it ranks Key Labels as they arrive, so a label the website would discard still appears here.

## The frame

**Frame**:
What the dashboard has on screen at one moment: the view that is up, the Run Log block under it,
and the keys line at the bottom. Ink draws each frame over the one before it, which is what makes
a stray write between frames cost every frame after it (ADR-0010).
_Avoid_: screen, page, and "view" — the view is what the frame holds

**Window**:
The room the terminal gives the frame. The frame is exactly this tall wherever the content is
shorter, with the slack sitting between the record and the keys line, and taller than it wherever
the content needs more; a stream with no terminal behind it has no window to give, and the frame is
then the height of its content (ADR-0011).
_Avoid_: screen, viewport, and "window" for a Range — that is a calendar interval read from storage,
and nothing here is related to it

## The live view

The dashboard's second view: what the run that is happening now has observed. It is available
only while the CLI is running, because that is all there is to show — there is no stored form of
a run in progress.

**Live Totals**:
Clicks, Mouse Distance and Press Total since the CLI started, rather than since the last Flush
Interval. They are Telemetry State plus everything this run has already Flushed, which is why
they do not fall back to zero at each Flush.
_Avoid_: session totals, current counters, live counts, and any reading that could be mistaken
for a Range — a Range is a calendar interval read from storage, which is the other view

The heading draws the start those totals are counted from: the local clock reading at which the
CLI's run began, in the same zone as every other clock in the frame, so how far back the totals
reach is stated rather than worked out from the wall clock. It is the run's own start rather than
the moment a frame happens to be drawn.

A run with no grant has no Live Totals at all, rather than totals of zero — see Collector
Disabled. The two are the same numbers and are not the same thing, and telling them apart is
what this view is for.

## The history view

**Range**:
The interval the history view shows: Today, from local midnight, or This week, from local Monday
midnight. Calendar-aligned in the viewer's own timezone rather than a rolling window, and the
unit the reader buckets in — hourly for Today, daily for This week.
_Avoid_: period, window, span, timeframe (and "24h"/"30d", which are the website's rolling
ranges rather than these)

**Key Ranking**:
The rendering of Key Counts as a list ordered by count, each Key Label drawn as a bar proportional
to the largest count and labelled with its own. A presentation of Key Counts, not the counts
themselves, and the CLI's rendering where the website's is a Heatmap. It is **not** a Heatmap: it
draws no keyboard, so it does not need the Label → Physical Key mapping, and it orders by count
where Key Counts order by label.
_Avoid_: leaderboard, top keys, keyboard heatmap, and Heatmap itself — the two render the same
Key Counts and are still different things

## The run log

**Run Log**:
The dashboard's record of what the current run did and hit: each Flush attempt with the counts
it wrote, or that it failed; Pushes that failed and backlogs that drained; the problems the
helper and the reads reported; what the write seam reported about itself; and collection that
started disabled by a missing permission. It holds
only this run — it exists while the CLI runs and is gone when it exits. A Flush is attempted
only when there is Activity, so the log lists attempts, not intervals. The full text of an entry
is one keypress away.
_Avoid_: activity log (Activity is countable input), event log (events are the helper's wire
format), flush history (history is the storage read — the other view), session log, log file
(nothing here is written to disk)

**Diagnostics View**:
The Run Log drawn whole: the entries the block under the other views holds, one per entry, each
with its second, its class, its summary and its full text, at the width of the terminal rather
than in a column. It is not a second record of the run — it is the one record, read in full —
which is why the block is not drawn beneath it.
_Avoid_: log view, debug view, detail pane, and any reading of it as a separate log

## Deliberately absent

These are not gaps. They are out of scope, and the vocabulary should not drift back toward them.

- **App tracking.** No frontmost-application Collector, no app whitelist. If it returns, it
  returns with a consumer that reads it.
- **Windows.** macOS only. Key Labels are UK Mac labels and would be wrong on a Windows keyboard.
- **Daemon.** There is no background process and no service. Collection happens only while the
  CLI is running. Do not name anything `Daemon`, `Service`, or `Agent`.
- **A log file.** The Run Log lives in memory for the current run only. Diagnosing a run that
  is already over is what the exit code and the Local Store are for.
- **More than one machine.** The Local Store is one machine's record and the history view reads
  only it; a second machine would Push a union to MongoDB that this CLI never shows. If it
  returns, it returns with an answer for whose era is whose.
- **DSH usage.** The DeepSeek Harness stays behind in the retired `ai-usage/` scripts. If it
  returns, it returns as a third Harness.
