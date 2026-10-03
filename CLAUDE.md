# CLAUDE.md

## What this is

A terminal dashboard for personal activity telemetry. It observes mouse and keyboard input on
the author's own machine, accumulates counts in memory, and Flushes them to a Local Store on
that machine — SQLite, and the only source the history view reads — while a best-effort Push
carries the same eras on to MongoDB Atlas, where a personal website (`jwoo`) renders them as a
heatmap. This repo is a TypeScript port of a Python client (`activity-telemetry-client`).

`CONTEXT.md` is the authoritative glossary and `docs/adr/` records the decisions behind the
design. Read both before naming anything or proposing a change.

`docs/architecture.md` is the same design at module depth — the Local Store's two faces, the
Push Drain, the Collector loop, the preflight, the sync rules, the React wall — and each section
names the invariants its module must hold. Before editing `store/`, `session.ts`, `push.ts`,
`helper/`, `permissions.ts`, `args.ts`, or anything under `views/`, read that module's section.

## Commands

The ambient `node` is older than the `engines` floor (`>=22.20.0`) and `tsx` fails with a
misleading loader error when it is used. Prepend the pinned version (`.nvmrc` pins the same
one):

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # or: nvm use
```

- `npm test` — the gate: prettier `--check`, `xo`, `tsc --noEmit`, then `ava`. Its failures are
  errors to fix, not advice.
- `npx ava source/state.test.ts`, or `npx ava --match '…'` — one file, one test.
- `npm run build` / `npm run dev` — `tsc --project tsconfig.build.json` to `dist/`, tests
  excluded / the same in watch mode.
- `./helper/build.sh` — rebuild the native capture helper. Needs Xcode CLI tools.

Run lines carry `--disable-warning=ExperimentalWarning --env-file=.env` and need `MONGO_URI` —
for example, the dashboard is `node --disable-warning=ExperimentalWarning --env-file=.env
dist/cli.js`, which collects while it is open. `collect` after that runs collection headlessly;
`permissions` reports the macOS grants and exits. The `usage` lines are the ones that are not
that shape. `usage record-claude-hook` and `usage record-opencode` each read one Harness
artifact on stdin (a Claude Code hook payload, or one OpenCode `info` blob the Shim delivers),
Ingest it, drain the Usage Backlog, and exit 0 on every path of their own (ADR-0016) — no
`.env` needed, so a `MONGO_URI` in the environment is the only thing an offline run has to
avoid. `usage backfill-claude [root]` takes the operator convention instead: it reads nothing on
stdin, needs no `.env`, and exits 1 when its own scan or store fails, while a surviving Usage
Backlog is not a failure.

The flag is on every run line because `node:sqlite` is experimental and says so on stderr the
moment it is imported — and `main.tsx` imports the Local Store on every path, whichever
subcommand asked. `npm test` needs it too, which is why it sits in `package.json`'s
`ava.nodeArguments` beside `tsx`.

The helper's `.swift` source is outside the gate — `prettier` and `xo` do not read it; what the
gate exercises is the binary committed beside it (`helper.test.ts` spawns it for `--self-check`,
`--preflight`, and to watch `stop()` kill it). So a rebuild left uncommitted passes the gate it
should have failed: build by hand after changing the source and commit the binary with it.

The OpenCode Shim (`opencode-plugin/jwoo.mjs`) is outside the gate the same way, excluded by
`xo.config.js` and `.prettierignore`: OpenCode's plugin loader is what runs it, and what the gate
exercises is the command and projection behind it. `npm run build` before the Shim can spawn
anything — `dist/` is gitignored.

No test reaches the network or another installation, and none may start a server: the `ava` step
has to pass on a clone of this repo alone. The exceptions are the Local Store and the OpenCode
reader, tested against real files — a temp directory their tests make and hand back, never
`~/.local/share/opencode` — because a fake of SQLite would fake the one thing whose whole job is
to sit on disk, whether the CLI is writing it or reading OpenCode's.

`.env` is gitignored and loaded by the `--env-file` flag, not by the code. `config.ts` is the
only place any environment variable is read, and stays a pure function of an injected
environment (`loadConfig(env = process.env)`) — which is what lets `config.test.ts` pass an exact
set of variables per test. No `loadEnvFile` call inside it.

## Layout

`source/` is grouped by the import graph rather than by a generic layering: `capture/` (the
helper, the wire format, the Key Label tables, the Collectors), `store/` (the Local Store, the
Pusher and the Usage Push seam, the Range arithmetic, the Pricing table, config), `usage/` (the
Harness artifact projections — the Claude transcript walk and the OpenCode message projection),
`views/` (the Ink layer).
What is left at the root is the
run: `cli.tsx`, `main.tsx`, `args.ts`, `session.ts`, `telemetry.ts`, `run-log.ts`, `state.ts`,
`format.ts` — each reads across the groups, so filing one under a group would move a boundary
edge rather than remove it. Tests
sit beside their subject and moved with it; ava's default globs find them there and read the
directory as the test name's prefix.

Two walls hold the layout in place, each a property rather than a list: no module but `push.ts`
imports `mongodb` as a value (`usage-push.ts` and its test take the driver's types type-only),
and no file outside `views/` imports `ink` or `react` —
`main.tsx` reaches `tui.tsx` only through a dynamic import, so a headless run never loads either.
`docs/architecture.md` carries the rest of the why, including why `cli.tsx` must stay at the
root and how `helper.ts` finds the Swift binary.

## Vocabulary is a contract

Use `CONTEXT.md`'s terms exactly — Flush, Snapshot, Telemetry State, Activity, Key Label, Key
Counts, Press Total, Mouse Distance, Collector, Range, Key Ranking, Heatmap. Every glossary entry
names the synonyms it avoids (`save`/`persist`/`sync` for Flush, `keycode`/`scancode` for Key
Label, `period`/`window` for Range). Two that are easy to get wrong:

- **Key Ranking is not a Heatmap.** Both are renderings of Key Counts. The website draws a
  keyboard (Heatmap); the CLI draws a bar list ordered by count (Key Ranking). Only the Heatmap
  needs the Label → Physical Key mapping, and the CLI has no `key-layout.ts`.
- **Range is calendar-aligned** — local midnight, or local Monday midnight — unlike the website's
  rolling 24h/30d/1y. A heading that says "Today" has to mean today.

Key Labels are a wire format, not an implementation detail (ADR-0004). A label with no matching
entry in the website's `jwoo/lib/telemetry/key-layout.ts` vanishes from the heatmap with no error
anywhere, so adding or renaming one requires a matching website change. Nothing here compiles or
reads that file — `key-labels.test.ts` pins the label set as a literal list, so a rename is two
deliberate edits, and `key-character.test.ts` pins what each keycode and flag word resolves to; a
character `key-character.ts` adds (the Shift/Option characters, the Fn overlays) has to be
checked against the website by hand, or it vanishes exactly as ADR-0004 warns. Key Counts must
stay flat numeric scalars and `createdAt` must stay a real BSON Date.

Never name anything `Daemon`, `Service`, or `Agent` (ADR-0001). App tracking and Windows support
are documented as deliberately absent rather than missing. If a change contradicts an existing
ADR, surface the conflict explicitly rather than quietly overriding it.

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles use their default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
