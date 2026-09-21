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

| Command                            | What it does                                                          |
| ---------------------------------- | --------------------------------------------------------------------- |
| `npm test`                         | The whole gate: prettier `--check`, `xo`, `tsc --noEmit`, then `ava`. |
| `npx ava source/state.test.ts`     | One test file.                                                        |
| `npx ava --match 'click counters'` | One test by name.                                                     |
| `npm run build`                    | `tsc --project tsconfig.build.json` → `dist/`, tests excluded.        |
| `npm run dev`                      | The same build, in watch mode.                                        |
| `node --env-file=.env dist/cli.js` | Run the TUI. Needs `MONGO_URI`; see `.env.example`.                   |

One test reads outside this repo: `key-labels.test.ts` imports `jwoo/lib/telemetry/key-layout.ts`
to check the Key Label wire format against the website's reader. `jwoo` has to be checked out
alongside this repo for the `ava` step to pass.

Tabs, not spaces (`.editorconfig`). Formatting is `@vdemedes/prettier-config` and `npm test`
enforces it rather than advising it.

`.env` is gitignored and loaded by the `--env-file` flag, not by the code. `config.ts` stays a
pure function of an injected environment (`loadConfig(env = process.env)`), which is what lets
`config.test.ts` pass an exact set of variables per test — do not add a `loadEnvFile` call inside
it. `config.ts` is the only place any environment variable is read.

## Architecture

### Two seams, and no database in the test suite

`storage.ts` (write) and `history.ts` (read) are mirrored seams. Each declares its own narrow
slice of the driver's types — `Collection`, `Database`, `AggregationCursor` — and nothing else
in the codebase imports `mongodb`. Every test drives a hand-written in-memory fake; there is no
test database and no test container.

The narrow types are deliberately faithful about async-ness, and that is load-bearing.
`Collection.insertOne` returns a Promise because the driver's does, and `Collection.aggregate`
is _synchronous_ because the driver's is — the `await` belongs on `toArray()`. A fake that lied
about either would let a missing `await` pass every test while losing data against a real server.

`cli.tsx` is the composition root and the only place a `MongoClient` is built. It owns the
client's lifetime and closes it in a `finally` around `waitUntilExit()`, because a client left
open keeps the process alive after the TUI has exited.

### The read path is built; the collection path is not

Only the history view is wired up. There is no Collector and no native capture helper yet — those
are issues #6 and #7 — and nothing calls `flush()` outside the tests. `TelemetryState`, the
storage seam, the aggregation pipelines, and the Key Label table (`key-labels.ts`) are ported and
tested.

`snapshot()` and `clear()` are separate methods on purpose: Telemetry State is cleared only
after a successful Flush, which is what makes retrying the same interval possible. A failed
Flush returns `undefined` and leaves the state intact.

### Time arithmetic is the subtle part

`local-time.ts` and `ranges.ts` exist because a local day is not always 24 hours. Boundaries are
stepped in wall-clock space and re-resolved to instants with a two-pass offset lookup; the
second pass in `instantFromLocalFields` is what stops a day bin that straddles a DST transition
from landing an hour out. The transition cases are asserted in `ranges.test.ts`.

`bucketBoundaries` returns N+1 ascending instants, and that list _is_ the bucket identity — it
is handed to MongoDB's `$bucket` unchanged, and display bucket `i` is `[b[i], b[i+1])`. See
ADR-0007 for why the website's `$dateTrunc`-plus-client-keys approach was not ported: it makes
bucket identity an agreement between MongoDB's ICU and JavaScript's `Intl`, and this CLI cannot
hold up its half of that agreement. **Do not "fix" the divergence by porting `generateBuckets`**,
and note that no timezone _name_ ever crosses the wire.

`aggregation.ts` builds pipelines as pure functions returning plain documents, so the pipeline
is the output a test asserts against.

### React layering

The TUI is Ink 7 on React 19, and the `.tsx` extension marks the whole of it: `cli.tsx`,
`app.tsx`, `history-view.tsx` and `use-history.ts` are the only modules that import `ink` or
`react`. Everything else is plain TypeScript, which is what ADR-0001 requires of the Collector
so that the move to a separate process is a different entry point rather than a rewrite. Tests
render through `ink-testing-library`.

`use-history.ts` holds the loading state machine — three states rather than a value plus a flag,
because "nothing yet", "nothing there" and "could not ask" draw completely differently — while
`history-view.tsx` is presentational and synchronous, tested by rendering a fixed `LoadState`.

`HistorySource` must be referentially stable: `app.tsx` takes it as a prop and the load effect
is keyed on it, so constructing one inside a component body reloads forever. That is why
`cli.tsx` builds it and passes it down.

A failed read resolves to `{ok: false, message}` rather than rejecting. A rejection raised
inside an effect is an unhandled rejection, which ends the process by default — the TUI would
exit instead of drawing the error.

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
be made in two places on purpose; and every label is checked against the website's own module,
which is imported rather than copied. That last test is the only one that reads outside this
repo: it needs the sibling `jwoo` checkout, and fails with a module-not-found without it rather
than skipping.

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
