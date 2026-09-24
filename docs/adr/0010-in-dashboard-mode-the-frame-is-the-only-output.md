# In dashboard mode the frame is the only output

Ink draws by writing the whole frame over the one before it, positioned from its own idea of
the layout. A line written to stderr between two frames lands wherever the terminal's cursor
happens to be — inside the drawing, partway along a line — and the frame drawn after it does
not repair the damage: it is written at the offsets Ink computed, which the stray line has
already shifted. So the cost is not one line out of place. Every frame from then on is wrong,
and the longer the run the further out of step it gets.

Three things could write to stderr while a frame was up: the helper's own diagnostics, passed
through from its stderr; the `[eventtap]` lines the stream's problems were reported with; and
the write seam's warnings. Two of them were also duplicated reports — a failed Flush was
warned about by the Collection Session _and_ by the store, so even a terminal got one failure
twice.

## Considered options

- **Buffer stderr and replay it after the frame comes down.** Rejected: the frame's lifetime
  is a keypress away, so a note that a tap was re-enabled would be read long after it mattered
  and usually not at all. It also adds a buffer to own, bound and flush, for output the Run Log
  already holds the part of that matters.
- **Route everything into the frame.** Chosen for the statements that are _about_ the run, and
  rejected for the helper's chatter. The frame's block is a fixed small shape with one line
  per entry; the helper's stderr is unbounded prose from a child process, which the CLI can
  neither summarise nor bound. The lines that carry a fact — the helper's error, an unreadable
  line of stdout, its exit — are already delivered as events, and are what the entries are
  built from.
- **Leave it, and accept the corruption.** Rejected on the arithmetic above: the first stray
  line costs every frame after it.

## The decision

**In dashboard mode nothing writes to stderr while the frame is up.** Concretely:

- The helper's own stderr is dropped. `EventStream` takes a sink — `onHelperStderr`, this
  process's stderr when the caller supplies none — and the dashboard hands it one that does
  nothing. The stream's own problems keep the same treatment they already had: a Run Log entry
  (`Helper`) under a frame, an `[eventtap]` line on stderr without one.
- The write seam's warnings become entries too (`Storage`). The store raises the one thing on
  its side that is not a Flush — a TTL index it could not create, as it is built — through a
  logger, and `sessionFor` builds the store with the logger the mode's warnings go to. This is
  the fifth Run Log class; it is not folded into `Flush` because it happens before any Flush
  has been attempted, and a line about an index filed under one would read as something the
  write below it did.
- **A failed Flush is reported once per attempt.** The warning is deleted from the Session and
  from the store outright. `flush`'s `undefined` return is the store's whole report of a
  failure, and the `onFlush` attempt is the Session's; the composition root turns that attempt
  into a Run Log entry under a frame and into a line of stderr without one. Neither module
  knows which mode it is in, and neither can produce a second report of the same attempt. A
  _final_ Flush that fails is still followed by `reportShutdown`'s own sentence — that the
  counters are gone rather than coming back — under a frame and on a terminal alike. Those two
  lines have always coexisted and say different things; what changed is that each attempt now
  produces one of them rather than two.
- The end of a run is unchanged. The message about a final Flush that was lost, and the
  non-zero exit code beside it, are written after the frame is down, which is the first moment
  the terminal can be written to again — and the exit code is what a shell reads either way.
- The preflight is unaffected. The permission notes and the grant prompt are written before
  the frame is mounted, so they are not mid-run output at all.

## Consequences

- **The helper's diagnostics are lost in dashboard mode.** A tap that was re-enabled, the
  listener announcing itself — whatever the helper says on stderr — is dropped rather than
  drawn. This is the trade-off the decision costs: the CLI cannot tell a helper's note from
  its noise, so it drops the class rather than guess. `collect` is how to see it.
- **A failed Flush no longer says why.** The driver's error went out with the store's warning,
  so deleting the warning deletes the reason too: a failed entry says the counters are coming
  back and not what went wrong. Carrying it would mean a reason on `FlushResult`, which
  ADR-0009 fixed as the ids written or `undefined`, and that is a wider change than this one.
  The write seam's TTL warning still keeps its driver error, because the logger it travels
  through already carries one.
- The Session no longer takes a logger, and no longer reports a Flush at all. That is
  deliberate rather than incidental: it was the second report, and removing the option makes
  the duplication unrepresentable rather than merely absent.
- The quiet is a property of every module on the dashboard path, and nothing enforces it but
  the composition root's choice of sinks and the tests that pin it. A module added later that
  writes to `process.stderr` will corrupt the frame, and what will notice is a contract test:
  a dashboard run, over a store failing an interval Flush, with the terminal's stderr watched
  for the length of the run.
- This is hard to reverse. Every view and every entry that was rearranged here to keep stderr
  quiet would have to be rearranged back, and the deleted warnings would have to be put back
  into modules that no longer know whether anyone is watching.
- It is surprising without context: run the helper by hand and it prints a banner; run the
  dashboard and it does not. This ADR is the context — the banner is not missing, it is
  deliberately not drawn.
