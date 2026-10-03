# The hook command never fails the agent

> Grilled in #48 (2026-09-30 → 2026-10-01); recorded before the first `usage`
> command lands.
> Amended in #51 (2026-10-02): the contract extends to the OpenCode Shim — the plugin is
> at least as quiet as the command it spawns.
> Amended in #65 (2026-10-03): the same extends to the Pi Shim — pi's extension runs inside
> pi's process too, and the handler is a catch-all with an un-awaited spawn.

`usage record-claude-hook` runs inside Claude Code's own wiring — Stop and
SubagentStop fire it as a child process of the agent's session. Its exit code
therefore carries no information: the command exits **0 on every path of its
own**, writes nothing to stdout, and reports every problem on stderr, where it
is visible only when someone looks. This deliberately overrides the CLI's
exit-code convention (`cli.tsx` reads a run's failure off the value it resolves
with): a hook process that failed loudly would surface an error into the
session it was hired to observe, and the one thing this contract must never do
is break the agent.

## What each failure degrades to

- **No `MONGO_URI`.** Ingest is the required write — the Local Store
  (ADR-0012) — and Push is best-effort, so the record still lands and the
  Usage Backlog's Drain is skipped with a stderr note. `loadConfig` stops
  requiring `MONGO_URI` outright: commands that Push require it, the hook
  command does not.
- **A missing or unreadable transcript.** The turn walk returns nothing; the
  run is a no-op that still drains whatever backlog it can.
- **A failed Drain.** The backlog stays a tail — the two-tail rule (ADR-0012)
  — and the next invocation that touches usage tries again; stderr says what
  happened and how much is left.

Failures before the command's own code runs — a missing `dist/cli.js` after a
pull, a node too old for `node:sqlite` — exit non-zero and surface as visible
non-blocking hook errors. That is accepted, and useful: those are install
problems rather than telemetry problems, and invisible telemetry is the
failure mode this contract otherwise risks.

## The Shim

`usage record-opencode` and `usage record-pi` are spawned by their Shims — OpenCode's plugin
and pi's extension (CONTEXT.md) — which, unlike Claude's hook wiring, run _inside_ the agent's
own process. The commands hold
the same contract as above: exit 0 on every path of its own, stdout silent, problems on
stderr. Each Shim holds it one notch stronger: its whole handler is wrapped in a
catch-all, so no exception escapes into the agent, and its one spawn is un-awaited with its
`error` swallowed — the plugin is at least as quiet as the
command it spawns. Failures before either runs — a missing `dist/cli.js` — still exit
non-zero and surface as visible non-blocking errors, as before; the spawn line's pinned node
keeps the too-old-node case out.

## Consequences

- The operator's view of a stuck Usage Backlog is the stderr drain report, not
  an exit code. If that proves invisible in practice, the door is a
  `usage status` command, not a change to this contract.
- The dashboard never shows usage: hooks Ingest in their own process, and the
  Usage Backlog drains only in the invocation that touched it. The wayfinder's
  "Run Log entries for usage" line (#42) was vacuous and is corrected there.
- "Hook" in the command's name is Claude Code's term for its own event wiring.
  It is not a Collector and never reaches the glossary's Collector sense.
