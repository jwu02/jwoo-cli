# jwoo-cli

Personal activity telemetry for a single user. A terminal dashboard observes mouse and keyboard
input on the author's own machine, accumulates counts in memory, and periodically writes them to
MongoDB Atlas, where a personal website renders them as a mouse and keyboard heatmap.

See `CONTEXT.md` for the vocabulary and `docs/adr/` for the decisions behind it.

## Requirements

Node 22 LTS. `.nvmrc` pins the major:

```bash
$ nvm use
```

`engines` requires `>=22.20.0`.

## Install

```bash
$ npm install
```

## Environment

`MONGO_URI` is required and has no default. Copy the template and fill in the connection string:

```console
$ cp .env.example .env
```

`.env` is gitignored and loaded with Node's own `--env-file`, so there is no dotenv dependency.
`ACTIVITY_DB_NAME`, `FLUSH_INTERVAL_SECONDS`, and `MOUSE_DPI` fall back to the values shown in
`.env.example`. `TZ` is read for the history view's day and hour boundaries, falling back to the
system zone.

## CLI

```console
$ npm run build
$ node --env-file=.env dist/cli.js              # the dashboard
$ node --env-file=.env dist/cli.js collect      # collect, without the dashboard
$ node --env-file=.env dist/cli.js permissions  # report the macOS grants
```

`collect` is a subcommand rather than a key inside the dashboard, because collection is not
something that only exists inside a rendered Ink tree (ADR-0001). It runs in the foreground and
stops when it exits — there is no background process. `SIGINT` and `SIGTERM` both end with a
final Flush, so quitting does not lose the counters accumulated since the last Flush Interval.

A missing macOS permission degrades collection rather than stopping the CLI: the Collectors it
affects are disabled and named, and everything else carries on. `permissions` reports the same
preflight on its own, as a question you can ask without collecting anything.

## Native helper

Input capture is a small Swift binary owning a listen-only `CGEventTap`, because Node cannot
observe global input on macOS for this use case and cannot see the Fn key at all (ADR-0002). It
emits raw events as JSON lines on stdout — keycode, modifier flags, timestamp, mouse position and
button — and all counting happens in TypeScript (ADR-0003).

The built binary is committed, so `npm install` is all you need to run it. It asks for **Input
Monitoring**, and only that: a listen-only tap never needs Accessibility.

```console
$ ./helper/bin/eventtap            # stream raw events
$ ./helper/bin/eventtap --request  # ask macOS for Input Monitoring first
$ ./helper/bin/eventtap --preflight    # report the grant as one JSON line and exit
$ ./helper/bin/eventtap --self-check   # print one sample of each event type and exit
```

If the grant is missing the helper prints a JSON error line and exits, rather than crashing or
going quiet. Grant it in System Settings → Privacy & Security → Input Monitoring.

`--preflight` is what the CLI's permission preflight calls. It asks `IOHIDCheckAccess` — the
check ADR-0006 recorded as the only one to trust — and exits 0 whatever the answer, because a
denied grant is the caller's ordinary case to report on rather than this process's failure.
Neither report-only mode prompts, so the CLI can ask on a startup path with nobody at the
keyboard.

Rebuild it after changing `helper/eventtap.swift`, and commit the rebuilt binary alongside:

```console
$ ./helper/build.sh
```
