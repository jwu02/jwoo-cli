# jwoo-cli

Personal activity telemetry for a single user. A terminal dashboard observes mouse and keyboard
input on the author's own machine, accumulates counts in memory, and periodically Flushes them
to a Local Store on the same machine — SQLite, and the only source the dashboard's own history
reads. A best-effort Push carries the same eras on to MongoDB Atlas, where a personal website
renders them as a mouse and keyboard heatmap (ADR-0012).

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
system zone. `LOCAL_STORE_PATH` moves the Local Store, which otherwise lives at
`~/Library/Application Support/activity-telemetry/telemetry.db`.

## CLI

Every run line carries `--disable-warning=ExperimentalWarning`: `node:sqlite` is experimental in
Node and says so on stderr at import.

```console
$ npm run build
$ node --disable-warning=ExperimentalWarning --env-file=.env dist/cli.js  # the dashboard
$ node --disable-warning=ExperimentalWarning --env-file=.env dist/cli.js collect  # without the dashboard
$ node --disable-warning=ExperimentalWarning --env-file=.env dist/cli.js permissions  # the macOS grants
```

The dashboard collects while it is open, and shows three views of what it collects: Today and
This week, read back from the Local Store, a live view of the run in progress, and the Run Log
drawn whole. `t` and `w` switch the range, `l` the live view, `d` the diagnostics view, `q`
quits. It fills the terminal it was opened in — the frame is a screenful whenever it has less in
it than that, with the keys on its last line — and gives the screen back when it exits, so the
shell's own output is where it was.

`collect` is a subcommand rather than a key inside the dashboard, because collection is not
something that only exists inside a rendered Ink tree (ADR-0001). It runs in the foreground and
stops when it exits — there is no background process. `SIGINT` and `SIGTERM` both end with a
final Flush, so quitting does not lose the counters accumulated since the last Flush Interval.

A Flush writes the Local Store, and nothing else: the write is local, synchronous, and the only
one the run is required to reach. Push is best-effort and happens afterwards, off the Flush
path. An era that does not reach Atlas waits in the **Push Backlog** and is retried oldest-first
on the next Drain — at startup and after each Flush — under the stamp it was written with, so a
retry overwrites rather than duplicates. A Push that has not happened costs the website an era;
it never costs the CLI one, and the exit code does not depend on it. A store that cannot be
opened is the opposite case: it ends the run at startup, before anything is drawn, because a run
that cannot record is a run that would collect into a retry that can never succeed (ADR-0012).

The live view draws what the run has observed since it started — not since the last Flush, which
would fall back to zero every five minutes. What it has written is not drawn there: the Run Log
underneath it is the flush record, one line per attempt with the counts it wrote or that it
failed, and `d` draws those entries whole. A machine whose Input Monitoring grant is missing
draws as disabled rather than as zeroes, because nothing has arrived yet and nothing is being
collected are the same numbers and not the same thing.

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
