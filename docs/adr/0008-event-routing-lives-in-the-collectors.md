# Event routing lives in the Collectors

The only statement of which Collector owns which event was a switch inside the entry point
(`cli.tsx`), reached by no test: swapping the two Collectors' arms left the suite green. We
decided that each Collector's `handle()` is total over the helper's `RawEvent` — it is shown
every event and ignores by name what it does not own, as the Mouse Collector already did —
and that delivery is a loop over the Collectors in the composition root. The entry point
states no event ownership.

## Considered Options

- **A central, tested router module** keeping `handle(KeyEvent)` narrow. Rejected: a module
  whose entire content is a routing table would be the shallowest module in the repo, holding
  event ownership at a distance from the Collectors that own it. Neither shape is
  compiler-enforced — the listed-cases convention is prose, not types — so the table's
  "one place to consider a new event type" is about reading, not safety.

## Consequences

- A new Collector is one module and no switch; a new wire event type must be considered in
  each Collector's ignore list instead of one switch. The forcing functions are the
  `--self-check` pin in `helper.test.ts`, which fails until a new wire type is added
  to it, and the delivery tests, which drive real Collectors over every wire type.
- The helper's `error` line stays an event like any other: delivered by the stream, ignored
  by the Collectors, and reported by the wiring that consumes it. This was previously a
  decision recorded only in a test comment; it is recorded here.
- The Collector's interface to the Session remains `start()`/`stop()` and nothing else
  (ADR-0001). Delivery is the composition root's business, which is what keeps the planned
  move to a separate process a different entry point rather than a rewrite.
