# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A terminal dashboard for personal activity telemetry. It observes mouse and keyboard input on
the author's own machine, accumulates counts in memory, and flushes them to MongoDB Atlas, where
a personal website (`jwoo`) renders them as a heatmap. This repo is a TypeScript port of a
Python client (`activity-telemetry-client`).

`CONTEXT.md` is the authoritative glossary and `docs/adr/` records the decisions behind the
design. Read both before naming anything or proposing a change.

## Commands

The ambient `node` is older than the `engines` floor (`>=22.20.0`) and `tsx` fails with a
misleading loader error when it is used. Prepend the pinned version:

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # or: nvm use
```

| Command                                        | What it does                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `npm test`                                     | The whole gate: prettier `--check`, `xo`, `tsc --noEmit`, then `ava`. |
| `npx ava source/state.test.ts`                 | One test file.                                                        |
| `npx ava --match 'click counters'`             | One test by name.                                                     |
| `npm run build`                                | `tsc --project tsconfig.build.json` → `dist/`, tests excluded.        |
| `npm run dev`                                  | The same build, in watch mode.                                        |
| `node --env-file=.env dist/cli.js`             | The dashboard, which collects while it is open. Needs `MONGO_URI`.    |
| `node --env-file=.env dist/cli.js collect`     | Collect and Flush, with no TUI.                                       |
| `node --env-file=.env dist/cli.js permissions` | Report the macOS grants and exit.                                     |
| `./helper/build.sh`                            | Rebuild the native capture helper. Needs Xcode CLI tools.             |

The helper is not part of `npm test`: `prettier` and `xo` do not read `.swift`, so the JS gate
neither checks nor covers it. Build it by hand after changing it and commit the binary with the
source.

No test reaches the network or another installation, and none may start a server: the `ava` step
has to pass on a clone of this repo alone. Its scratch space is its own — the temp directory
`local-store.test.ts` makes is a file this repo does not ship, and no other checkout can see it.
The Key Label wire format was once checked by importing the website's
`jwoo/lib/telemetry/key-layout.ts`, and that test is gone — the label set is pinned here
instead, by hand, against the website's reader rather than against its module.

Tabs, not spaces (`.editorconfig`). Formatting is `@vdemedes/prettier-config` and `npm test`
enforces it rather than advising it.

`.env` is gitignored and loaded by the `--env-file` flag, not by the code. `config.ts` stays a
pure function of an injected environment (`loadConfig(env = process.env)`), which is what lets
`config.test.ts` pass an exact set of variables per test — do not add a `loadEnvFile` call inside
it. `config.ts` is the only place any environment variable is read.

## Architecture

### Seams, and no database server in the test suite

`push.ts` is the one seam with MongoDB behind it, and it is a write seam: it declares its own
narrow slice of the driver's types — `Collection`, `Database` — and nothing else in the codebase
imports `mongodb`. Every test drives a hand-written in-memory fake; there is no test **server**
and no test container. `telemetry.ts` and `run-log.ts` are two more seams, and neither has a
database behind it at all — see _The live view reads its own seam_ and _The Run Log reads its
own seam_ below.

`local-store.ts` is the one module tested against real files, which is the exception ADR-0012's
amendment to the gate carves out: the store _is_ the thing under test, and a fake of SQLite
would be a fake of the one component whose whole job is to be durable. Its tests make a temp
directory and hand it back, run in-process, and reach no network — so the `ava` step still
passes on a clone of this repo alone.

The narrow types are deliberately faithful about async-ness, and that is load-bearing.
`Collection.replaceOne` returns a Promise because the driver's does — a fake that lied about it
would let a missing `await` pass every test while losing data against a real server.

`main.tsx` is the composition root and the only place a `MongoClient` is built. It owns the
client's lifetime and closes it on every path, because a client left open keeps the process
alive after the work has finished. `cli.tsx` is only the entry point above it: it parses argv
and reports a failure's message rather than its stack.

`main.tsx` supplies the Collectors too, and the default factory is its own rather than the
entry point's, along with the things that factory reaches for — the helper stream it builds, the
grant it asks for, and where the helper's problems are reported (ADR-0008). A test can
therefore drive the real factory through `collect` with a stream of its own, which is how
delivery is executed rather than described. The stream is built _with_ that reporter rather than
having one attached afterwards: a stream's own problems — a line of stdout that would not parse,
an exit — are settled when it is constructed, so `createStream` takes the reporter and the
caller that builds a stream owns where its problems go.

**Delivery is a loop, and every Collector is total** (ADR-0008). Each event is handed to every
Collector, and each ignores by name what it does not own — the shape `mouse.ts` always had, and
the one `keyboard.ts` now shares. Nothing outside a Collector states which events are its, so a
new Collector is a new module and one entry in the list. A new wire event type is forced into
view by the `--self-check` pin in `helper.test.ts`, which fails until it is considered,
and the delivery tests in `main.test.tsx` are what execute the ownership for every type the
format carries. The helper's failure line is delivered like any other event, owned by nobody,
and reported by that wiring.

### Three subcommands, and no others

`args.ts` parses argv into exactly three commands: no argument opens the dashboard, `collect`
runs collection headlessly, `permissions` reports the macOS grants. Parsing is a pure function
of argv, so what a command line means is testable without a process — `cli.tsx` is what hands it
the real `process.argv` and lets meow exit on a bad one.

A bare `dashboard` is not a second spelling of the default, and there are no flags to forward:
`allowUnknownFlags` is off, so a typo'd `--dry-run` is refused rather than silently ignored.
That refusal is meow's and happens by exiting, which is why the one test covering it runs the
entry point in a child process — in-process it would take the test runner down with it.

The collector must not be reachable only through the TUI (ADR-0001), which is why `collect` is a
subcommand and not a key. `main.tsx` reaches `tui.tsx` — the module that imports ink and react —
through a dynamic import, so a headless run never loads either.

**The dashboard collects too.** It runs the same preflight and the same Session `collect` does,
and mounts the view over the run; `collect` is the way to run without a view, not the way to
collect. The dependency runs the other way round as well: `q` arrives as input in a raw-mode
terminal and never generates a SIGINT, so a view that comes down is what ends the run —
`stop()` releases the promise `run()` handed back. On a signal the reverse happens: the run ends
and `DashboardView.ended` is what brings the frame down, so a TUI cannot outlive its run and go
on claiming to be live.

### The permission preflight degrades, it does not stop

`permissions.ts` asks the helper (`--preflight`) rather than checking anything itself, because
`IOHIDCheckAccess` is the check ADR-0006 says to trust and the grant follows an ancestor process
rather than this script's path. A missing grant comes back as a report naming the Collectors it
disables; the composition root then builds fewer Collectors. Nothing exits on `disabled`.

It throws only when the helper cannot be _asked_ — a missing binary, a crash, a hang — or when the
helper answered and its stdout carried no report, which is treated as the same broken install.
Neither is a missing permission, and the two must not be confused.

**The helper's stdout has one reader.** `raw-event.ts`'s line parser is the only place a line is
decoded, and `helper.ts` is the only module that reads the helper's stdout — the stream and
`preflightFrom` (split it, parse each line through the shared parser, last preflight line wins)
both go through that parser. `permissions.ts` holds only policy — what the answer means for which
Collectors — and contains no line parsing or JSON decoding; its report function takes the parsed
`PreflightEvent` wire type, whose access field is narrowed to the helper's three-value vocabulary
in the format module. A preflight line with no message is dropped like any other malformed line,
so stdout that carries only such lines reports "printed no permission report".

### The live view reads its own seam

`telemetry.ts` is a seam of its own beside the Local Store's: `TelemetrySource.read()` returns the
counters for the run that is happening now. The in-process implementation reads Telemetry State,
and the read is **synchronous** — there is nothing to await, and saying otherwise would be a
pretence. Moving collection to a separate process makes it a socket and the read a promise, and
that change lands in `telemetry.ts` and `use-telemetry.ts` and nowhere near the view, which asks
a `TelemetrySource` and does not know what is behind it.

**A successful Flush clears Telemetry State**, so a view reading the accumulator alone would
watch every counter fall back to zero at the Flush Interval and call that live. The Session
therefore reports each Flush attempt through `onFlush`, with the Snapshot it wrote, and the
source adds a _successful_ one to a running total. Gating on success is load-bearing rather than
defensive: a failed Flush leaves Telemetry State whole so the same counters are retried, and
adding them here as well would count the same presses twice.

The grant belongs to the reading rather than to the view. `LiveTelemetry` is a union of
`collecting` and `disabled` instead of totals plus an `enabled` flag, because a machine with no
grant produces counters that are zero in exactly the way a machine nobody has touched does — and
the user who has just granted the permission is the one who cannot tell them apart.

`session.ts` is where the Flush Interval and the final Flush live. It is a plain module with
`run()`/`stop()`, and `run()` resolves only once the final Flush and the close have finished —
`await`ing it is a complete shutdown, not the start of one. The signal listeners are released
_after_ the run rather than inside the handler, so a second Ctrl-C cannot cut a Flush short.

**A Flush in flight blocks the final one.** Telemetry State is cleared only after a successful
write, so a Flush still waiting on the database has not cleared it — and a final Flush started
alongside would snapshot the same counters and insert them twice. `stop()` awaits the in-flight
Flush first. `Shutdown.finalFlush` then reports whether the counters actually made it, and
`main.tsx` sets a non-zero exit code when they did not, because a shell reads the exit code and
not the log.

The shutdown source is injectable. `processSignal` is the real one and the only place
`process.on` is called; a test raises a signal through a fake, because a real SIGTERM inside the
suite would take ava down with it.

`snapshot()` and `clear()` are separate methods on purpose: Telemetry State is cleared only
after a successful Flush, which is what makes retrying the same interval possible. A failed
Flush returns `undefined` and leaves the state intact.

### The Run Log reads its own seam

`run-log.ts` sits beside the other three: `RunLogSource.read()` returns the entries of the run
that is happening now, and the read is **synchronous** for the same reason `telemetry.ts`'s is.
The in-process implementation owns a buffer capped at six entries and hands back a copy, so the
buffer has exactly one author. Appending is not on the seam — a view is given the reading face —
and `main.tsx` is what calls it, in both commands. `sessionFor` turns each `onFlush` attempt into
an entry before passing the attempt on, so the log lists Flush _attempts_ rather than intervals,
and `collect` records into a log nothing reads back, because the terminal and the exit code are
what a headless run reports through. A Flush entry is spelled by the same formatters the totals
are, so a number that appears twice in one frame reads the same way twice.

**The mode decides where a problem goes.** The dashboard hands the factory a reporter that appends
an entry per helper problem — its error line, a line of stdout that would not parse, its exit —
with `helper.ts`'s own sentence as the entry's text, so a problem is not printed into the middle
of the frame; `collect` leaves the reporter out and keeps the `[eventtap]` warnings on stderr it
has always had. A caller that supplied a reporter of its own keeps it, in either mode, so the
mode is what decides the default rather than the rule. Both commands append one entry when the run
starts with no grant, naming the Collectors it took out, which is what puts a missing grant on
the landing view without the live-view key being pressed — the live view's own report is
untouched. `problemMessage` in `helper.ts` is the one spelling of a problem, shared by the stderr
reporter and the entry, and the entry constructors (`flushEntry`, `helperEntry`, `historyEntry`,
`storageEntry`, `collectionEntry`) live beside the buffer because the two texts are one decision:
the line the block draws and the full text the diagnostics view draws.

**In dashboard mode the frame is the only output** (ADR-0010). Nothing writes to stderr while the
frame is up, because Ink draws over its own last frame and a stray line shifts every frame after
it. So the helper's stderr chatter is dropped rather than passed through — `EventStream` takes an
`onHelperStderr` sink, and the dashboard hands it one that does nothing, while `collect` keeps
`defaultHelperStderr` — and the write seam's warnings become entries: `sessionFor` builds the
store with the logger the mode's warnings go to, which is `storageEntry`'s one use (`Storage`).
The preflight is unaffected, being written before the frame mounts, and so is the end of a run:
`reportShutdown`'s message about a lost final Flush and the non-zero exit code beside it are
written after the frame is down, which is the first moment the terminal can be written to again.

**A failed Flush is reported once.** Neither the Session nor the store warns about one; the
`onFlush` attempt is the report, and the composition root decides what it is worth — an entry
under a frame, a line on stderr without one. The Session therefore takes no logger at all, which
is what makes the old duplication unrepresentable rather than merely absent.

**The read seam reports the same way** (#23), and for the same reason. A failed read is a fact
about this run rather than about the range on screen, so the Local Store raises a `ReadWarning`
— one thing now, the failure, where it was once a union — and the composition root answers it
with an entry; `messageOf` is the one spelling of it, as `problemMessage` is. The seam's
default reporter is the stderr warning it has always written, which is what a run with no view to
draw an entry in keeps. So the history view draws one compact red pointer line where the driver's
sentence used to replace the dashboard: the sentence is in the log, whole, one `d` away.

The block is drawn under the history and live views rather than inside one, because the dashboard
lands on the history view and that view knows nothing about this run — a session whose every Flush
failed would otherwise open on a frame with nothing to say about it. **The third view is the
exception** (#22): `d` draws those same entries whole, one per entry with its summary and its full
text, from the same source through the same hook, so the line the block had to cut is readable
without the block drawing a truncated copy of it underneath.

### The native helper emits raw events and nothing else

`helper/eventtap.swift` owns a listen-only `CGEventTap` and prints one JSON event per line on
stdout — keycode, `flagsRaw`, `timestampNs`, mouse position and button. It is built by
`helper/build.sh` and the binary is committed, because requiring Xcode CLI tools on install would
make the repo impossible to clone and run (ADR-0002).

**`flagsRaw` is emitted uninterpreted on purpose.** The measured trap (ADR-0006) is that
F1–F12 set `kCGEventFlagMaskSecondaryFn` too, so their raw flags are byte-identical to a bare Fn
press — `0x800100`. Fn is identifiable _only_ as keycode 63 on a `flagsChanged` event; nothing
may infer it from the flag bit. Any decoding rule added to `eventtap.swift` would be untestable
here, and belongs in TypeScript instead (ADR-0003):

- **The helper never maps a keycode to a Key Label.** It has no label table and does not know
  what a Key Label is; `key-labels.ts` does that on the TypeScript side.
- **It does no DPI conversion.** `TelemetryState.addMouseMovement(pixels)` takes pixels and
  applies `MOUSE_DPI` itself.
- **It does not de-duplicate auto-repeat**, even though macOS exposes
  `kCGKeyboardEventAutorepeat`. A held-keys set in TypeScript is testable against synthetic
  events; a flag is not.

Failures are reported as a JSON line with a `type` of `error` and a non-zero exit, never as
silence, so a consumer can tell "no input" from "no permission". `--self-check` prints one sample
of each event type and exits without creating a tap — it is the only way to check the wire format
with no permission and no live input, and it asserts the event mask has not drifted.

`--preflight` prints the Input Monitoring grant as one JSON line and exits **0 whatever the
answer**, because a denied grant is the caller's ordinary case to report on rather than this
process's failure. Both report-only modes exit before a run loop or a tap exists, so neither can
prompt — which is what lets the CLI ask on a startup path with nobody at the keyboard. It is the
only permission check the helper makes, and `permissions.ts` is its only caller.

### Time arithmetic is the subtle part

`local-time.ts` and `ranges.ts` exist because a local day is not always 24 hours. Boundaries are
stepped in wall-clock space and re-resolved to instants with a two-pass offset lookup; the
second pass in `instantFromLocalFields` is what stops a day bin that straddles a DST transition
from landing an hour out. The transition cases are asserted in `ranges.test.ts`.

`bucketBoundaries` returns N+1 ascending instants, and that list _is_ the bucket identity: display
bucket `i` is `[b[i], b[i+1])`, and a row lands in one by it and nothing else. The `$bucket` that
used to consume the list was Mongo query language and went with the Mongo read (ADR-0012); the
grouping is JavaScript over rows in `local-store.ts` now, bounded by the same list. See ADR-0007
for why the website's `$dateTrunc`-plus-client-keys approach was not ported: it makes bucket
identity an agreement between MongoDB's ICU and JavaScript's `Intl`, and this CLI cannot hold up
its half of that agreement. **Do not "fix" the divergence by porting `generateBuckets`**, and note
that no timezone _name_ ever crosses the wire.

### React layering

The TUI is Ink 7 on React 19, and it reaches no further than these modules: `tui.tsx`, `app.tsx`,
`history-view.tsx`, `live-view.tsx`, `totals-view.tsx`, `run-log-view.tsx`,
`diagnostics-view.tsx`, `use-telemetry.ts`, `use-run-log.ts` and
`use-window.ts` are the only ones that import `ink` or `react` — most of them `.tsx`, the hooks
`.ts` because they hold no markup. Everything else is plain TypeScript, which is what ADR-0001
requires of the Collector so that the move to a separate process is a different entry point
rather than a rewrite. Tests render through `ink-testing-library`.

**The frame is the window, and the window is the terminal's** (ADR-0011). `use-window.ts` is the
only reader of `stdout.rows`, subscribed to the stream's `resize`; `app.tsx` gives the root box
that value as a `minHeight` — a floor rather than a size, so a terminal shorter than the content
grows the frame instead of compressing it — with a `flexGrow` spacer above the keys line, and
`tui.tsx` renders into the alternate screen so what the dashboard drew goes when it exits. A
stream that reports no height (a pipe, or a stream with no terminal behind it) reports `rows` of
absent or 0, and the frame is then the height of its content as it always was.

The history and live views draw the same three lines — Clicks, Mouse Distance, Press Total — and
share `totals-view.tsx` rather than each spelling them, with the number formats alongside in
`format.ts`. Only the heading above the block says which view it is, so a difference between
them would be a bug rather than a difference of meaning.

`main.tsx` also carries the `.tsx` extension and imports neither ink nor react; it reaches
`tui.tsx` dynamically. That is a constraint to keep, not a coincidence: a module on the
`collect` path that started importing ink statically would drag it into a headless run.

`history-view.tsx` is presentational and synchronous, tested by rendering a fixed answer. There
is no loading hook and no loading state: the read is synchronous, so `app.tsx` asks the store
during render and hands the view what came back — "nothing there" is drawn from data and "could
not ask" from the failure, and "nothing yet" was a state only a read that took time could be in.
`use-telemetry.ts` and `live-view.tsx` split the same way: the hook polls and holds nothing but
the timer, and the view takes a reading plus the two facts outside it that it draws — the instant
the run began, read in `main.tsx` where the run starts, and the zone that instant is spelled in,
which is the one clock this view has. `use-run-log.ts` splits that way against both
of the modules that draw its entries — `run-log-view.tsx` and `diagnostics-view.tsx` take entries
and a zone. Each poll is owned by the component that draws it rather than held in `app.tsx`, so a
tick re-renders that component's own subtree and not the view above it: the Run Log block is on
screen under the history and live views, and the history view is not re-rendered once a second on
its account.

**Which view is up is one value, and the keys are absolute** (#22). `app.tsx` holds a
`history | live | diagnostics` union rather than a flag per view, and every view key names the
view it wants: `d` opens diagnostics from anywhere, `t` and `w` are the history view at their
range, `l` is the live view, `q` quits. Nothing toggles and there is no way back to "whatever was
showing". That one value also decides the block: every view but diagnostics gets it, written as
the exclusion rather than as the two views that want it, so a view added later inherits the block
rather than quietly losing it.

**Unmount the Ink root in any test that leaves a polling hook mounted.** A pending `setInterval`
holds ava's worker open, and the run ends in `✘ Timed out while running tests` rather than in a
failed assertion. `t.teardown(() => { unmount(); })` is the whole fix — and since the Run Log
block is under the history and live views and the diagnostics view polls the same entries, that
is every test that mounts the dashboard, not only the ones that switch views.

`HistorySource` arrives as a prop because it is a lifetime, not because a hook is keyed on it:
it is the Local Store, which `main.tsx` opens and closes, and a view that built its own would
have nothing to close it with. `TelemetrySource` is handed to the live view the same way.

A failed read comes back as `{ok: false, message}` rather than throwing. A throw raised during a
render is an unhandled error, which ends the process by default — the TUI would exit instead of
drawing the error.

## Vocabulary is a contract

Use `CONTEXT.md`'s terms exactly — Flush, Snapshot, Telemetry State, Activity, Key Label, Key
Counts, Press Total, Mouse Distance, Collector, Range, Key Ranking, Heatmap. Every glossary
entry names the synonyms it avoids (`save`/`persist`/`sync` for Flush, `keycode`/`scancode` for
Key Label, `period`/`window` for Range). Two that are easy to get wrong:

- **Key Ranking is not a Heatmap.** Both are renderings of Key Counts. The website draws a
  keyboard (Heatmap); the CLI draws a bar list ordered by count (Key Ranking). Only the Heatmap
  needs the Label → Physical Key mapping, and the CLI has no `key-layout.ts`.
- **Range is calendar-aligned** — local midnight, or local Monday midnight — unlike the
  website's rolling 24h/30d/1y. A heading that says "Today" has to mean today.

Key Labels are a wire format, not an implementation detail (ADR-0004). A label with no matching
entry in the website's `jwoo/lib/telemetry/key-layout.ts` vanishes from the heatmap with no
error anywhere, so adding or renaming one requires a matching website change. Key Counts must
stay flat numeric scalars and `createdAt` must stay a real BSON Date.

`source/key-labels.ts` is the ported table and `key-labels.test.ts` is what holds it in place.
The label set is asserted there as a literal list, not derived from the table, so a rename has to
be made in two places on purpose. It is the only guard: nothing here compiles or reads
`key-layout.ts`, so a label this CLI emits that the website has not been taught is caught by
nobody, and disappears in silence exactly as ADR-0004 warns.

Never name anything `Daemon`, `Service`, or `Agent` (ADR-0001). App tracking and Windows support
are documented as deliberately absent rather than missing, and the glossary should not drift
back toward them.

If a change contradicts an existing ADR, surface the conflict explicitly rather than quietly
overriding it.

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles use their default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
