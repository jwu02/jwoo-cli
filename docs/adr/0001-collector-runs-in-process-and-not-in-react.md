# The Collector runs in the CLI process, and must not depend on React

The Python original was a headless daemon; this CLI is TUI-first. We chose a single process
where the Collector runs inside the CLI and stops when it exits, rather than a daemon
supervised by launchd. Collection therefore only happens while the terminal is open — accepted
for now, with a background process as a later step.

The load-bearing constraint is that the Collector is a plain module with `start()`/`stop()` that
owns its own listeners and timers and **imports nothing from React**. If it were started from a
component's `useEffect` and torn down on unmount, the planned move to a separate process would
mean rewriting the orchestration layer. Kept as a module, that move is just a different entry
point with a socket in front of Telemetry State.

## Considered Options

- **Launchd-supervised daemon from the start.** Rejected: debugging a plist, a TCC grant, and
  the install step before there is any UI worth looking at.
- **TUI-supervised detached child.** Rejected for now, not forever — it is the intended next step.

## Consequences

Nothing may be named `Daemon` or `Service`; the vocabulary in `CONTEXT.md` deliberately excludes
them until the process model actually changes.
