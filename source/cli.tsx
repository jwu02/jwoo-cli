#!/usr/bin/env node
/*
The entry point.

Argument parsing, the subcommands and the permission preflight live behind it;
what is left here is deciding what a command line means, what a failure prints,
and which Collectors to build. A `ConfigError` or a `PreflightError` is reported
rather than thrown: its message is the useful part, and a stack trace is not.

  Usage
    $ jwoo-cli            the dashboard: history, read from Atlas
    $ jwoo-cli collect    collect input and Flush it, without the dashboard
    $ jwoo-cli permissions  report the macOS grants collection needs
*/

import process from 'node:process';
import {parseArguments} from './args.js';
import {
	defaultProblemReporter,
	EventStream,
	requestInputMonitoring,
} from './event-stream.js';
import {KeyboardCollector} from './keyboard.js';
import {type CollectorFactory, run} from './main.js';
import {MouseCollector} from './mouse.js';
import {HelperPermissionSource} from './permissions.js';
import {type Collector} from './session.js';
import {type TelemetryState} from './state.js';

/*
Both Collectors read the one tap, so both are built over one stream. Spawning
per Collector would mean two taps racing on the same events and two grants to
keep (ADR-0006).

Both also count into the one Telemetry State the Session flushes, which arrives
as an argument rather than being built here. Building one here would compile,
run, and write nothing at all.

Nothing here imports ink or react, and that is load-bearing rather than tidy: a
module on the `collect` path that started importing either would drag the whole
TUI into a headless run (ADR-0001). `main.js` reaches `tui.js` through a dynamic
import for the same reason.
*/
function collectorsFrom(
	stream: EventStream,
	state: TelemetryState,
): Collector[] {
	const keyboard = new KeyboardCollector({state});
	const mouse = new MouseCollector({state});

	/*
	Wired before the stream can start. The Session starts the stream and then
	the Collectors, so a listener attached afterwards would miss whatever
	arrived in between — and losing input is the one thing a Collector must not
	do quietly.
	*/
	stream.onEvent(event => {
		switch (event.type) {
			case 'keyDown':
			case 'keyUp':
			case 'flagsChanged': {
				keyboard.handle(event);
				return;
			}

			case 'mouseMoved':
			case 'mouseDown':
			case 'mouseUp': {
				mouse.handle(event);
				return;
			}

			case 'error': {
				/*
				The helper's own failure line. It is on stdout rather than
				stderr precisely so it cannot be missed, and it belongs with the
				stream's own problems: both are statements about why there is no
				input rather than about a key or a click.
				*/
				defaultProblemReporter({kind: 'error-line', error: event});
				break;
			}

			case 'preflight': {
				/*
				Unreachable from a streaming run: `--preflight` exits before a
				tap exists, so the helper never prints one while emitting
				events. Named rather than folded into a `default` so that adding
				an event type to the wire format has to be considered here.
				*/
				break;
			}
		}
	});

	return [keyboard, mouse];
}

/*
Which Collectors the grant allows.

The decision about what a missing grant disables stays in `permissions.ts` — the
report names it — and this only decides what to build. Nothing exits on
`disabled`: a machine whose grant is missing still runs, reports the grant, and
waits to be stopped, which is what keeps this the same shape as any other
degraded run.

A denied grant is also the one case worth asking about. macOS will not show the
prompt to a process with nobody at the keyboard (ADR-0002), so the request goes
out on the run where the user has just been told it is missing.
*/
const collectorsFromReport: CollectorFactory = (report, state) => {
	if (report.status !== 'granted') {
		requestInputMonitoring();
		/*
		No stream either. A denied grant means no tap, so a helper started
		anyway would have nothing to open, exit, and report itself as a problem
		on a path that is meant to degrade quietly.
		*/
		return {collectors: []};
	}

	/*
	Constructed, not started. The helper is spawned by the Session, through the
	stream it owns — nothing about building the Collectors should open a
	process: a run stopped before it starts would then leave one behind, and
	owning that lifetime is the Session's whole job.
	*/
	const stream = new EventStream({});

	return {collectors: collectorsFrom(stream, state), stream};
};

try {
	await run(parseArguments(), {
		permissions: new HelperPermissionSource(),
		collectors: collectorsFromReport,
	});
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
