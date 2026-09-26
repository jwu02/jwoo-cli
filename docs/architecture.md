# Architecture

The module-depth design behind the rules in `CLAUDE.md`. `CONTEXT.md` is the glossary and
`docs/adr/` records the decisions; this doc is the shape those decisions left in the code, and
each section names the invariants its module must hold.

## Directory layout

`source/` is grouped by the import graph rather than by a generic layering: `capture/` (the
helper, the wire format, the Key Label tables — `key-labels.ts` pins what a keycode is called,
`key-character.ts` what a key event produces — and the Collectors), `store/` (the Local Store,
the Pusher, the Range arithmetic, config), `views/` (the Ink layer). What is left at the root is
the run: `cli.tsx`, `main.tsx`, `args.ts`, `session.ts`, `telemetry.ts`, `run-log.ts`, `state.ts`
and `format.ts` — each reads across the groups, so filing one under a group would move a
boundary edge rather than remove it.

Two constraints hold the layout in place. `tsconfig.json` sets `rootDir: "source"` and `dist/`
mirrors that tree, so moving `cli.tsx` moves `dist/cli.js` and with it the `bin` entry. And
`helper.ts` finds the Swift binary by `import.meta.url` arithmetic (two levels up from
`capture/`), which `helper.test.ts` asserts by _resolution_, not by suffix — a suffix check
cannot fail on a wrong number of `../`. Tests sit beside their subject and moved with it; ava's
default globs find them there and read the directory as the test name's prefix.

## The Local Store has two faces, and the Push is a seam over its backlog

`store/local-store.ts` owns the SQLite file and answers through it twice. The **write face** —
`flush(snapshot)`, returning the stamp it wrote under or `undefined` — is what the Session
Flushes through; the **read face** is the one-method `HistorySource` (`load(range, now)`) the
history view draws. They are one object rather than two readers of it, and `main.tsx` names the
whole of it once as `RunStore = FlushStore & PushBacklog & HistorySource` — which is what makes
the view read back exactly what the Flush wrote.

Both faces are synchronous, because `node:sqlite` has no promise in it, so the history view asks
during render with no loading state to draw. The Push is the one seam here that really does wait
— `Pusher.drain()` is async because a round trip to Atlas is.

**Opening the store is the one thing in a run that fails fast** — in `main.tsx`, before the
preflight and before anything is drawn, because the Local Store is the only write a Flush is
required to reach. The Pusher built over it is the opposite case: a run carries on when Atlas is
merely unreachable (ADR-0012).

**The Push is a Drain over the store's backlog, and never a wait on the Flush path.** The
backlog is the store's own query (`pushed_at IS NULL ORDER BY stamp`), walked oldest era first
and stopped at the first failure so it stays a tail rather than a scatter of holes. One Drain
fires as the run starts and one after each successful Flush, and neither is awaited: a hanging
Atlas must not delay the next local write. What a Drain found reaches the Run Log through the
same callback shape a Flush attempt does.

## Seams, and no database server in the test suite

`push.ts` is the one seam with MongoDB behind it, and it is a write seam: it declares its own
narrow slice of the driver's types (`Collection`, `Database`), and no module but `push.ts` and
its own test imports `mongodb`. Every test drives a hand-written in-memory fake — no test
server, no container. The narrow types are deliberately faithful about async-ness, and that is
load-bearing: `Collection.replaceOne` returns a Promise because the driver's does, so a fake
that lied about it would let a missing `await` pass every test while losing data against a real
server.

`main.tsx` is the composition root and the only place a `Pusher` is built. It owns the Local
Store's lifetime and the Pusher's — and, through it, the `MongoClient`'s — and closes both on
every path, because a client left open keeps the process alive after the work has finished.
**Each command has its own entry point.** `runCollect` and `runDashboard` take the collection
type, which is one type because their field sets coincide; `runPermissions` takes a narrow type
holding the permission source and a logger — the two things that command reads — which the
collection type satisfies structurally, so one object can be handed to either. `cli.tsx` is the entry point
above them all: it parses argv, dispatches to the one the command names, and reports a failure's
message rather than its stack. The dispatch is the whole of the pairing between a command and
the entry point that runs it, and it lives there rather than here so the pairing is stated once
— which is why the composition root imports no command type at all, and why the `permissions`
command is the one that announces a grant: it is the one that was asked.

`main.tsx` supplies the Collectors too, and the default factory is its own rather than the entry
point's, along with what that factory reaches for — the helper stream it builds, the grant it
asks for, and where the helper's problems are reported (ADR-0008). The stream is built _with_
that reporter rather than having one attached afterwards: a stream's own problems (a line of
stdout that would not parse, an exit) are settled when it is constructed, so `createStream` takes
the reporter and the caller that builds a stream owns where its problems go.

**A mode is what a collecting command decides, and it is not a command.** `collect` and the
dashboard are the two modes; the three subcommands are the commands. `permissions` answers a
question and opens no Session, so it is a command with no mode — the distinction is what keeps a
third session-running command composition rather than a third copy of the flow. One skeleton,
`runCollection` in `main.tsx`, performs open → preflight → session → complete → report → close for
both modes and holds no branch of its own: the mode is the only thing it is told about. The value
it is told about is a `RunMode`, built per run by one of two factories — `collectMode` and
`dashboardMode` — and it has three stages rather than one flat shape, because the lifecycle
decides what exists when. `sinks` — where each report goes — is needed to open the store, before
the preflight has been asked; `hooks` is built _from_ the preflight's report and the Telemetry
State; and `complete` drives the Session to its Shutdown, which is the dashboard's view
choreography and, for `collect`, only `run()`. The dashboard's Telemetry Source is built in
`hooks` from the report and the state, and what a mode builds there and needs again in `complete`
is carried through the skeleton untouched — the skeleton never looks at it. Two invariants hold
`runCollection` in place: nothing in it names a command, and a change to the order of a run lands
once.

**Delivery is a loop, and every Collector is total** (ADR-0008). Each event is handed to every
Collector, and each ignores by name what it does not own — the shape `mouse.ts` always had, and
the one `keyboard.ts` now shares. Nothing outside a Collector states which events are its, so a
new Collector is a new module and one entry in the list. A new wire event type is forced into
view by the `--self-check` pin in `helper.test.ts`; the delivery tests in `main.test.tsx` are
what execute the ownership for every type the format carries. The helper's failure line is
delivered like any other event, owned by nobody, and reported by that wiring.

## Three subcommands, and no others

`args.ts` parses argv into exactly three commands: no argument opens the dashboard, `collect`
runs collection headlessly, `permissions` reports the macOS grants. Parsing is a pure function of
argv, so what a command line means is testable without a process — `cli.tsx` hands it the real
`process.argv` and lets meow exit on a bad one, which is why the one test covering that runs the
entry point in a child process: in-process it would take the runner down with it.

A bare `dashboard` is not a second spelling of the default, and `allowUnknownFlags` is off, so a
typo'd `--dry-run` is refused rather than silently ignored. `collect` is a subcommand and not a
key because the collector must not be reachable only through the TUI (ADR-0001).

**The dashboard collects too.** It runs the same preflight and the same Session `collect` does,
and mounts the view over the run; `collect` is the way to run without a view, not the way to
collect. The dependency runs the other way round as well: `q` arrives as input in a raw-mode
terminal and never generates a SIGINT, so a view that comes down is what ends the run — `stop()`
releases the promise `run()` handed back. On a signal the reverse happens: the run ends and
`DashboardView.ended` is what brings the frame down, so a TUI cannot outlive its run and go on
claiming to be live.

## The permission preflight degrades, it does not stop

`permissions.ts` asks the helper (`--preflight`) rather than checking anything itself, because
`IOHIDCheckAccess` is the check ADR-0006 says to trust and the grant follows an ancestor process
rather than this script's path. A missing grant comes back as a report naming the Collectors it
disables; the composition root then builds fewer Collectors. Nothing exits on `disabled`.

It throws only when the helper cannot be _asked_ — a missing binary, a crash, a hang — or when
the helper answered and its stdout carried no report, which is treated as the same broken
install. Neither is a missing permission, and the two must not be confused.

**The helper's stdout has one reader.** `raw-event.ts`'s line parser is the only place a line is
decoded; the stream and `preflightFrom` (split it, parse each line through the shared parser,
last preflight line wins) both go through that parser. `permissions.ts` holds only policy — what
the answer means for which Collectors — and takes the parsed `PreflightEvent` wire type. A
preflight line with no message is dropped like any other malformed line, so stdout that carries
only such lines reports "printed no permission report".

## The live view reads its own seam

`telemetry.ts` is a seam of its own beside the Local Store's: `TelemetrySource.read()` returns
the counters for the run that is happening now, the in-process implementation reading Telemetry
State, and the read is **synchronous** — there is nothing to await, and saying otherwise would be
a pretence. Moving collection to a separate process makes it a socket and the read a promise, and
that change lands in `telemetry.ts` and `use-telemetry.ts` and nowhere near the view.

**A successful Flush clears Telemetry State**, so a view reading the accumulator alone would
watch every counter fall back to zero at the Flush Interval and call that live. The Session
therefore reports each Flush attempt through `onFlush`, and the source adds a _successful_ one to
a running total. Gating on success is load-bearing rather than defensive: a failed Flush leaves
Telemetry State whole so the same counters are retried, and adding them here as well would count
the same presses twice.

The grant belongs to the reading rather than to the view. `LiveTelemetry` is a union of
`collecting` and `disabled` instead of totals plus an `enabled` flag, because a machine with no
grant produces counters that are zero in exactly the way a machine nobody has touched does — and
the user who has just granted the permission is the one who cannot tell them apart.

`session.ts` is where the Flush Interval and the final Flush live. `run()` resolves only once the
final Flush and the close have finished — awaiting it is a complete shutdown, not the start of
one. The signal listeners are released _after_ the run rather than inside the handler, so a
second Ctrl-C cannot cut a Flush short. The shutdown source is injectable: `processSignal` is the
real one and the only place `process.on` is called; a test raises a signal through a fake.

**The Flush write is honest-sync, and there is no in-flight Flush to wait for.** `FlushStore`
carries no Promise on any of its three methods, because `node:sqlite` has none: an interval's
Flush has already landed or already failed by the time anything can ask the run to end, so a
final Flush cannot snapshot the same uncleared counters and write them twice. The ordering
`stop()` owns: the Drain already in flight waited out, then the final Flush, then the awaited
last Drain, then the backlog counted while the store can still answer it, then a synchronous
store close and the Mongo client's. `Shutdown.finalFlush` reports whether the counters actually
made it, and `main.tsx` sets a non-zero exit code when they did not — a shell reads the exit
code, not the log.

`snapshot()` and `clear()` are separate methods on purpose: Telemetry State is cleared only after
a successful Flush, which is what makes retrying the same interval possible.

## The Run Log reads its own seam

`run-log.ts` sits beside the other three: `RunLogSource.read()` returns the entries of the run
that is happening now, synchronous for the same reason `telemetry.ts`'s read is. The buffer is
capped at six entries and handed back as a copy, so it has exactly one author; appending is not
on the seam — `main.tsx` is what calls it, in both commands. `sessionFor` turns each `onFlush`
attempt into an entry, so the log lists Flush _attempts_ rather than intervals, and a Flush entry
is spelled by the same formatters the totals are, so a number that appears twice in one frame
reads the same way twice. `collect` records into a log nothing reads back, because the terminal
and the exit code are what a headless run reports through.

**The mode decides where a problem goes.** The dashboard hands the factory a reporter that
appends an entry per helper problem — its error line, a line of stdout that would not parse, its
exit — with `helper.ts`'s `problemMessage` as the one spelling, so a problem is not printed into
the middle of the frame; `collect` leaves the reporter out and keeps the `[eventtap]` warnings on
stderr it has always had. A caller that supplied a reporter of its own keeps it, in either mode.
Both commands append one entry when the run starts with no grant, naming the Collectors it took
out — which puts a missing grant on the landing view without the live-view key being pressed. The
entry constructors (`flushEntry`, `pushEntry`, `pushWarningEntry`, `helperEntry`, `historyEntry`,
`collectionEntry`) live beside the buffer because the two texts are one decision: the line the
block draws and the full text the diagnostics view draws.

**In dashboard mode the frame is the only output** (ADR-0010). Nothing writes to stderr while the
frame is up, because Ink draws over its own last frame and a stray line shifts every frame after
it. So the helper's stderr chatter is dropped rather than passed through — `EventStream` takes an
`onHelperStderr` sink, the dashboard hands it one that does nothing, and `collect` keeps
`defaultHelperStderr` — and the Push seam's warnings and Drain attempts become entries
(`pushWarningEntry`, `pushEntry`). The preflight is unaffected, being written before the frame
mounts; so is the end of a run — `reportShutdown`'s lost-final-Flush message and the non-zero
exit code beside it are written after the frame is down, the first moment the terminal can be
written to again.

**A failed Flush is reported once.** Neither the Session nor the store warns about one; the
`onFlush` attempt is the report, and the composition root decides what it is worth. The Session
therefore takes no logger at all. **The read seam reports the same way** (#23), and for the same
reason: a failed read is a fact about this run rather than about the range on screen, so the
Local Store raises a `ReadWarning`, the composition root answers it with an entry, and
`messageOf` is the one spelling of it. The history view draws one compact red pointer line; the
sentence is in the log, whole, one `d` away.

The block is drawn under the history and live views rather than inside one, because the dashboard
lands on the history view and that view knows nothing about this run. **The third view is the
exception** (#22): `d` draws those same entries whole, one per entry with its summary and its full
text, from the same source through the same hook.

## The native helper emits raw events and nothing else

`helper/eventtap.swift` owns a listen-only `CGEventTap` and prints one JSON event per line on
stdout — keycode, `flagsRaw`, `timestampNs`, mouse position and button. It is built by
`helper/build.sh` and the binary is committed, because requiring Xcode CLI tools on install would
make the repo impossible to clone and run (ADR-0002).

**`flagsRaw` is emitted uninterpreted on purpose.** The measured trap (ADR-0006) is that F1–F12
set `kCGEventFlagMaskSecondaryFn` too, so their raw flags are byte-identical to a bare Fn press.
Fn is identifiable _only_ as keycode 63 on a `flagsChanged` event; nothing may infer it from the
flag bit. Any decoding rule added to `eventtap.swift` would be untestable here, and belongs in
TypeScript instead (ADR-0003):

- The helper never maps a keycode to a Key Label — `key-character.ts` does that on the TypeScript
  side, reading the event against the table `key-labels.ts` pins.
- It does no DPI conversion — `TelemetryState.addMouseMovement(pixels)` takes pixels and applies
  `MOUSE_DPI` itself.
- It does not de-duplicate auto-repeat, even though macOS exposes
  `kCGKeyboardEventAutorepeat`. A held-keys set in TypeScript is testable against synthetic
  events; a flag is not.

Failures are reported as a JSON line with a `type` of `error` and a non-zero exit, never as
silence, so a consumer can tell "no input" from "no permission". `--self-check` prints one sample
of each event type and exits without creating a tap — the only way to check the wire format with
no permission and no live input, and it asserts the event mask has not drifted. `--preflight`
prints the Input Monitoring grant as one JSON line and exits **0 whatever the answer**, because a
denied grant is the caller's ordinary case to report on rather than this process's failure. Both
report-only modes exit before a run loop or a tap exists, so neither can prompt — which is what
lets the CLI ask on a startup path with nobody at the keyboard.

## Time arithmetic is the subtle part

`local-time.ts` and `ranges.ts` exist because a local day is not always 24 hours. Boundaries are
stepped in wall-clock space and re-resolved to instants with a two-pass offset lookup; the second
pass in `instantFromLocalFields` is what stops a day bin that straddles a DST transition from
landing an hour out. The transition cases are asserted in `ranges.test.ts`.

`bucketBoundaries` returns N+1 ascending instants, and that list _is_ the bucket identity:
display bucket `i` is `[b[i], b[i+1])`, and a row lands in one by it and nothing else. The
grouping is JavaScript over rows in `local-store.ts`, bounded by that list — the `$bucket` went
with the Mongo read (ADR-0012), and ADR-0007 records why the website's `$dateTrunc`-plus-client
-keys approach was not ported: it makes bucket identity an agreement between MongoDB's ICU and
JavaScript's `Intl`. **Do not "fix" the divergence by porting `generateBuckets`**, and no
timezone _name_ ever crosses the wire.

## React layering

The TUI is Ink 7 on React 19, and it reaches no further than `views/`. The rule is the property
rather than a list: every non-test file under `source/views/` imports `ink` or `react`, and no
file outside it imports either — most of them `.tsx`, the hooks `.ts` because they hold no
markup. That is what makes ADR-0001's wall checkable instead of enumerated, and what keeps the
headless `collect` path free of ink: `main.tsx` imports neither and reaches `tui.tsx` — the
module that imports ink and react — through a dynamic import, a constraint to keep rather than a
coincidence. Tests render through `ink-testing-library`.

**The frame is the window, and the window is the terminal's** (ADR-0011). `use-window.ts` is the
only reader of `stdout.rows`, subscribed to the stream's `resize`; `app.tsx` gives the root box
that value as a `minHeight` — a floor rather than a size, so a terminal shorter than the content
grows the frame instead of compressing it — with a `flexGrow` spacer above the keys line, and
`tui.tsx` renders into the alternate screen. A stream that reports no height (a pipe) reports
`rows` of absent or 0, and the frame is then the height of its content.

The history and live views draw the same three lines — Clicks, Mouse Distance, Press Total — and
share `totals-view.tsx`, with the number formats alongside in `format.ts`. Only the heading above
the block says which view it is, so a difference between them would be a bug rather than a
difference of meaning.

`history-view.tsx` is presentational and synchronous: no loading hook, no loading state — the
read is synchronous, so `app.tsx` asks the store during render and hands the view what came back
("nothing there" from data, "could not ask" from failure). `use-telemetry.ts` and `live-view.tsx`
split the same way: the hook polls and holds nothing but the timer, and the view takes a reading
plus the two facts outside it that it draws — the instant the run began and the zone it is
spelled in, read in `main.tsx` where the run starts. `use-run-log.ts` splits that way against
both modules that draw its entries. Each poll is owned by the component that draws it rather than
held in `app.tsx`, so a tick re-renders that subtree and not the view above it.

**Which view is up is one value, and the keys are absolute** (#22). `app.tsx` holds a
`history | live | diagnostics` union rather than a flag per view, and every view key names the
view it wants: `d` opens diagnostics from anywhere, `t` and `w` are the history view at their
range, `l` is the live view, `q` quits. Nothing toggles. That one value also decides the Run Log
block: every view but diagnostics gets it, written as the exclusion, so a view added later
inherits the block rather than quietly losing it.

**Unmount the Ink root in any test that leaves a polling hook mounted.** A pending `setInterval`
holds ava's worker open, and the run ends in `✘ Timed out while running tests` rather than in a
failed assertion. `t.teardown(() => { unmount(); })` is the whole fix — and since the Run Log
block is under the history and live views, that is every test that mounts the dashboard.

`HistorySource` arrives as a prop because it is a lifetime, not because a hook is keyed on it: it
is the Local Store, which `main.tsx` opens and closes. `TelemetrySource` is handed to the live
view the same way. A failed read comes back as `{ok: false, message}` rather than throwing — a
throw raised during a render is an unhandled error, which ends the process by default.
