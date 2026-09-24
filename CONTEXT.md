# Telemetry

Personal activity telemetry for a single user. A local CLI observes mouse and keyboard
input on the author's own machine, accumulates counts in memory, and periodically writes
them to MongoDB Atlas, where a personal website renders them as a mouse and keyboard
heatmap.

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
Writing a Snapshot to storage. Telemetry State is cleared only on a successful Flush; a failed
Flush leaves it intact so the same data is retried on the next interval, overwriting what the
failed attempt wrote rather than adding to it (ADR-0009).
_Avoid_: save, persist, sync, upload, commit

**Flush Interval**:
How long Telemetry State accumulates before a Flush is attempted.

**Era**:
The Activity accumulated between one successful Flush and the next — what one Telemetry State
holds while it is being written. A Flush that fails stays in its era: the retry writes the same
era's documents again, under the same stamp, rather than opening a new one (ADR-0009).
_Avoid_: epoch, generation, attempt (an attempt is one try; an era can span several)

**Telemetry Document**:
One flushed interval's mouse and keyboard totals.

**Key Count Document**:
One flushed interval's Key Counts, written only when keys were pressed during it.

### The reader

**Physical Key**:
A key on the M3 Air 13" UK layout, named for where it sits rather than what it prints.
Key Labels map onto Physical Keys; the reader discards any label it does not recognise, without
error.
_Avoid_: using Physical Key for a Key Label or vice versa — they are different identities either
side of a one-way mapping

Note that the mapping is the _website's_ reader. The CLI has no `key-layout.ts` and no Physical
Key: it ranks Key Labels as they arrive, so a label the website would discard still appears here.

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
it wrote, or that it failed; the problems the helper and the reads reported; what the write seam
reported about itself; and collection that started disabled by a missing permission. It holds
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
  is already over is what the exit code and the database are for.
