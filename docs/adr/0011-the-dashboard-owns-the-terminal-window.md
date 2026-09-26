# The dashboard owns the terminal window

> **Status note (2026-09-26).** ADR-0012 renamed two of the seams this ADR lists as
> `use-window.ts`'s neighbours: `storage.ts` is `push.ts` now, and `history.ts` is gone — the
> Local Store answers the read itself. The point the list makes is untouched: `use-window.ts` is
> not a seam, because a window is a property of the stream being drawn into rather than of
> something that could change behind it.

Ink sizes its root to the terminal's **width** and leaves the height to the content
(`rootNode.yogaNode.setWidth`, and nothing else). So a frame was exactly as tall as what it
held: the dashboard drew five lines at the top of a fifty-line terminal, the keys line sat
wherever the content happened to end and moved when a counter gained a digit, and the shell's
own scrollback stayed on screen around and behind it — a dashboard sharing a screen with the
commands that started it. `height="100%"` at the top of the tree does nothing about this, for
the same reason: a percentage of a height nobody set resolves against nothing.

## Considered Options

- **`useWindowSize`**, Ink's own hook. Rejected: it reports the fallback from
  `terminal-size` when the stream has no rows of its own, which reads the environment (and can
  involve spawning `tput`). A frame's shape should not depend on what a machine's environment
  says it is, and the read this needs is one property and one subscription. This does not
  remove that fallback from the process — Ink's own fullscreen decision asks the same question
  of the same stream — but it keeps the height the CLI lays its frame out in from depending on
  it. The fallback is only consulted where `rows` is missing, which on a TTY it is not.
- **`height={rows}`** on the root box. Rejected on measurement: Ink's `Box` defaults
  `flexShrink` to 1, so a frame with more in it than the window has room for is _compressed_ to
  fit — a five-line window drew a nineteen-line frame as five lines with the text of different
  rows on top of one another. That is worse than a frame too tall for the screen, and it
  corrupts the one thing the view exists to show.
- **`height` plus `overflow="hidden"`.** Ink does clip when a box says so
  (`render-node-to-output.js`), and the frame would then be exactly the window in every case.
  Rejected because of which lines it loses: the clip is at the bottom of the box, so what goes
  is the end of the record — and the end of the record is where the newest diagnostics entries
  are, and the keys line after them. A frame that is too tall loses its _top_ instead, since
  the frame is written from the top of the screen and the terminal scrolls: what goes out of
  view is a heading, and what stays is the part that has just happened.
- **Leave the frame the height of its content.** This is the status quo the change is for.

## The decision

**The dashboard draws a frame as tall as the terminal and takes the alternate screen.**

- `use-window.ts` reads the height: `stdout.rows`, subscribed to the stream's `resize` event,
  the same event Ink listens for. It is not a fifth seam beside `storage.ts`, `history.ts`,
  `telemetry.ts` and `run-log.ts` — those exist because the thing behind them could change (a
  database, a socket), whereas a window is a property of the stream being drawn into, and
  `ink-testing-library` already hands a test the stream to change.
- **A stream with no height has no window to fill.** `rows` is absent on a pipe and 0 on a
  stream with no terminal behind it, and both mean the frame stays the height of its content,
  as it was before. A frame sized to 0 would be a frame drawn in no lines.
- `app.tsx` sets `minHeight` on the root box — **a floor, not a size** — and puts the keys
  under a `flexGrow` spacer, so the slack sits between the record and the keys rather than
  under the frame. A floor is met by growing, which is what a terminal too short for the
  content gets: a frame taller than the window rather than a squeezed one.
- `tui.tsx` renders with `alternateScreen: true`, so the dashboard is what is on screen while
  it runs and the scrollback is exactly as it was when it exits. Ink enters the alternate
  screen only when stdout is a TTY and the run is interactive, so a piped or CI run is
  unaffected.

## Consequences

- **The frame is now a screenful whenever the content fits**, which is the shape Ink's
  fullscreen handling is written for: no trailing newline after the last line, and incremental
  erase between frames instead of a rewrite. (With more content than the window, Ink clears the
  whole screen per frame instead, which is its own established path for a frame that overflows.)
  Neither is observable in the suite: `ink-testing-library` hands Ink a stream that is not a
  TTY, and `isFullscreen` is gated on that, so the erase behaviour is Ink's business — the
  height this change decides is what the tests pin.
- **A terminal shorter than the content shows the bottom of the frame rather than the top.**
  The frame grows past the window and is written from the top of the screen, so the terminal
  scrolls and what goes out of view is the heading, or the first of the diagnostics entries;
  the keys line and the newest of the run stay. The alternatives both cost more: compressing
  the frame into the window draws lines over one another, and clipping it loses the newest
  entries and the keys line instead.
- **The alternate screen changes what an early write costs.** Anything written to stderr while
  the frame is up is now drawn onto the alternate screen and discarded with it, rather than
  being left in the scrollback to be scrolled back to. ADR-0010 already forbids that write, so
  the two decisions fit — and the one message that is written around a frame, `reportShutdown`
  on a lost final Flush, is written after Ink has left the alternate screen, which keeps it in
  the scrollback beside the exit code that says the same thing.
- **Nothing tests the alternate screen.** It is an option handed to Ink, and observing it would
  mean asserting Ink's own escape sequences — the same reason `q` is not asserted in
  `app.test.tsx`. The height is tested, through a fake stream that is given `rows` and made to
  emit `resize`, which is the pair a terminal hands a real run.
- It is inert where there is no terminal: a redirected or CI run gets the frames it always got,
  no alternate screen and no floor under them.
