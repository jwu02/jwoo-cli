/*
The helper module, driven against real processes.

This is the one module that talks to the helper process, so it is the one place
a fake proves less than the real thing. `--self-check` is the seam that makes
that affordable: it prints one sample of every event type and exits before
creating a tap, so these tests need no permission, no input, and no live
capture. It is the same reason the helper has that mode at all.

The other fixtures are not the helper. They are `/bin/cat`, `/bin/sh` and a path
that does not exist, chosen because each produces something the helper cannot be
asked to produce on demand — a line split across two reads, something said on
stderr, and a failure to start.

The preflight reader's tests at the bottom are the exception to all of this: a
pure function over whole-stdout strings, it needs no process at all.
*/

import {execFileSync} from 'node:child_process';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {
	EventStream,
	HELPER_PATH,
	type StreamProblem,
	preflightFrom,
} from './helper.js';
import {type RawEvent} from './raw-event.js';

test('the helper path is the committed binary beside the source', t => {
	/*
	The path is relative to the *compiled* module, so a wrong number of `../` is
	invisible until something tries to run the helper — which on a machine
	without the grant is a path nobody exercises. Every caller — the stream, the
	one-shot runner, `permissions.ts` — takes it from here, which is what lets
	one test catch a wrong `../` for all of them.
	*/
	t.true(HELPER_PATH.endsWith('helper/bin/eventtap'));
});

/*
Spawning a process is slower than anything else in this suite, and ava's default
is generous enough to cover it but not to cover a hang. Bounded here so a broken
stream fails with a message rather than by timing the whole run out.
*/
const WAIT_MS = 5000;

/*
Polls rather than resolving from the callback, because what is being asserted is
that the events arrive at all — a promise resolved by `onProblem` would pass a
test that never fired the path under test.
*/
async function until(isDone: () => boolean, what: string): Promise<void> {
	const started = Date.now();
	while (!isDone()) {
		if (Date.now() - started > WAIT_MS) {
			throw new Error(`timed out waiting for ${what}`);
		}

		// eslint-disable-next-line no-await-in-loop -- polling, one check at a time.
		await delay(10);
	}
}

type Recorder = {
	readonly events: RawEvent[];
	readonly problems: StreamProblem[];
};

function recorder(): Recorder {
	return {events: [], problems: []};
}

/*
Categories rather than instances, because `defaultProblemReporter` writes to
stderr and a test that printed a wall of warnings would be hiding the result.
*/
function quiet(): (problem: StreamProblem) => void {
	return () => {
		// Recorded by the caller's own `onProblem` where it matters; silenced
		// here so a passing suite does not narrate every exit.
	};
}

test('the helper streams every event type it prints', async t => {
	const seen = recorder();
	const stream = new EventStream({
		/*
		`--self-check`, deliberately, not a bare run. A bare run opens a real
		tap on this machine and then sits in a run loop waiting for input that
		a test suite is not going to produce.
		*/
		helperArgs: ['--self-check'],
		onEvent(event) {
			seen.events.push(event);
		},
		onProblem(problem) {
			seen.problems.push(problem);
		},
	});

	stream.start();
	await until(() => seen.events.length >= 7, 'the self-check output');
	stream.stop();

	t.deepEqual(
		seen.events.map(event => event.type),
		[
			'keyDown',
			'keyUp',
			'flagsChanged',
			'mouseMoved',
			'mouseDown',
			'mouseUp',
			'error',
		],
	);

	// The sample error line is an event like any other here. Deciding what to
	// do about it belongs to the caller, which is why it is not a problem.
	t.true(
		seen.problems.every(problem => problem.kind !== 'unreadable-line'),
		'every line the helper prints must parse',
	);
});

/*
The helper's lines, written out for `/bin/cat` to print back. Built from the
wire format rather than from anything the code under test exports, so a change
to the format shows up here rather than being followed by these tests.
*/
const A_PRESS = '{"type":"keyDown","timestampNs":1,"keycode":0,"flagsRaw":256}';
const A_RELEASE = '{"type":"keyUp","timestampNs":2,"keycode":0,"flagsRaw":256}';

/*
`cat` printing a file of lines, with everything it produces recorded. Cat
delivers the file in whatever chunks the pipe gives it, which is the shape a
real stdout has — and the helper cannot be asked to print a broken line or to
exit under its own steam, which is why the other two tests below want it too.
*/
async function catStream(
	seen: Recorder,
	lines: readonly string[],
	onProblem: (problem: StreamProblem) => void = quiet(),
): Promise<EventStream> {
	const directory = await mkdtemp(join(tmpdir(), 'eventstream-'));
	const file = join(directory, 'events.jsonl');
	// Newline-terminated, as the helper writes every line.
	await writeFile(file, [...lines, ''].join('\n'));

	return new EventStream({
		helperPath: '/bin/cat',
		helperArgs: [file],
		onEvent(event) {
			seen.events.push(event);
		},
		onProblem,
	});
}

test('a line split across two reads is reassembled', async t => {
	/*
	Two events, written together and read as one buffer, is enough to catch a
	splitter that does not hold a remainder — which is what a single `data`
	handler would silently drop.
	*/
	const seen = recorder();
	const stream = await catStream(seen, [A_PRESS, A_RELEASE]);

	stream.start();
	await until(() => seen.events.length >= 2, 'both lines');
	stream.stop();

	t.deepEqual(
		seen.events.map(event => event.type),
		['keyDown', 'keyUp'],
	);
});

/*
A line that is not an event. One bad line in a stream that runs for hours must
not end collection, so it is skipped — but it is *said*, and that is the half
that matters: a wire format that broke would otherwise look exactly like a
machine nobody is touching.

The dashboard turns this into a Run Log entry and `collect` into a `[eventtap]`
warning, and both are only as good as this report arriving at all.
*/
test('a line that would not parse is reported rather than dropped', async t => {
	const seen = recorder();
	const stream = await catStream(
		seen,
		['{"type":"keyDown"}', A_PRESS],
		problem => {
			seen.problems.push(problem);
		},
	);

	stream.start();
	await until(() => seen.events.length > 0, 'the event after the bad line');
	stream.stop();

	/*
	Filtered, because `cat` exiting at the end of the file is a problem of its
	own and may have arrived too — the test below this one is about that one.
	*/
	t.deepEqual(
		seen.problems.filter(problem => problem.kind === 'unreadable-line'),
		[{kind: 'unreadable-line', line: '{"type":"keyDown"}'}],
	);
	t.is(seen.events.length, 1, 'and the line after it still arrived');
});

/*
A helper that has gone says so, because nothing else can: a dead helper and an
idle machine produce the same counters, and this report is the whole of the
difference. `cat` exiting at the end of its file is as close as a test can get
to a tap that has shut down.
*/
test('a helper that exits is reported, so its death is not silence', async t => {
	const seen = recorder();
	const stream = await catStream(seen, [A_PRESS], problem => {
		seen.problems.push(problem);
	});

	stream.start();
	await until(() => seen.problems.length > 0, 'the exit');
	stream.stop();

	t.deepEqual(seen.problems, [{kind: 'exited', code: 0, signal: undefined}]);
	t.is(seen.events.length, 1, 'and what it printed first still arrived');
});

test('a helper that cannot start is reported rather than thrown', async t => {
	/*
	The broken-install case, which `permissions.ts` draws the same line around:
	this is a helper that cannot be *asked*, not a missing grant, and the
	difference is worth a message naming the binary and how to rebuild it.
	*/
	const seen = recorder();
	const stream = new EventStream({
		helperPath: join(tmpdir(), 'eventtap-that-does-not-exist'),
		onEvent(event) {
			seen.events.push(event);
		},
		onProblem(problem) {
			seen.problems.push(problem);
		},
	});

	stream.start();
	await until(() => seen.problems.length > 0, 'the spawn failure');
	stream.stop();

	const [problem] = seen.problems;

	/*
	Asserted rather than thrown, so a report of the wrong kind fails here with
	the kind it was, instead of passing as a thrown error the test expected.
	*/
	t.is(problem?.kind, 'error-line');

	if (problem?.kind !== 'error-line') {
		return;
	}

	t.is(problem.error.code, 'helperUnavailable');
	t.regex(problem.error.message, /helper\/build\.sh/v);
	t.deepEqual(seen.events, []);
});

/*
What the helper says on stderr, and where it goes.

Its notes are diagnostics rather than events, and it writes them to stderr so
that stdout can be read as nothing but events. Where they end up from there is
the caller's: this process's stderr by default, which is what a terminal run
wants, and whatever sink was handed over otherwise — which is how a run with a
frame to keep whole stops them corrupting it (ADR-0010).

`sh` rather than `cat`, because the point is a child that says something on
stderr at all. `cat` reads a file to stdout and has no way to be asked.
*/
test('the helper’s stderr goes to the sink the stream was built with', async t => {
	const seen: string[] = [];
	const stream = new EventStream({
		helperPath: '/bin/sh',
		helperArgs: ['-c', 'echo banner 1>&2'],
		onHelperStderr(chunk) {
			seen.push(chunk);
		},
		onProblem: quiet(),
	});

	stream.start();
	await until(() => seen.length > 0, 'the helper’s stderr');
	stream.stop();

	// Joined, because a pipe delivers chunks rather than lines and this one is
	// free to arrive in more than one.
	t.is(seen.join(''), 'banner\n');
});

test('stopping kills the helper rather than leaving it running', async t => {
	/*
	A capture process that outlives the CLI keeps a tap open and keeps
	collecting, which is the leak ADR-0001's process model exists to avoid. The
	real helper is used because the thing under test is whether `kill()` reaches
	a process sitting in a run loop, and the real helper is one.

	`cat` is not used here: it holds no tap, and the question is specifically
	about a process that does not want to exit.
	*/
	const stream = new EventStream({
		onEvent: () => undefined,
		onProblem: quiet(),
	});

	stream.start();

	const {pid} = stream;
	if (pid === undefined) {
		throw new Error('the helper never started');
	}

	t.true(isAlive(pid), 'the helper should be running before stop()');

	/*
	Waited for rather than asserted on immediately: the signal is asynchronous,
	and checking on the next line would be racing the kernel.
	*/
	stream.stop();
	await until(() => !isAlive(pid), `the helper to exit (pid ${pid})`);

	t.false(isAlive(pid));
});

/*
`process.kill(pid, 0)` sends no signal and only asks whether the process exists,
throwing ESRCH once it does not. EPERM means it exists but belongs to someone
else, which cannot happen here and is treated as alive rather than as gone.
*/
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

test('stop before start does nothing', t => {
	// The Session stops the Collectors it started, and a Collector that threw
	// on the way up is stopped too — so this path is reachable rather than
	// theoretical.
	const stream = new EventStream({
		onEvent: () => undefined,
		onProblem: quiet(),
	});

	t.notThrows(() => {
		stream.stop();
	});
});

test('the helper path resolves to the committed binary', t => {
	/*
	The synchronous form, for the same reason the one-shot runner wraps
	`execFile` by hand. Synchronous rather than hand-wrapped because a
	`--preflight` run answers and exits, so there is nothing here worth being
	concurrent with.
	*/
	const stdout = execFileSync(HELPER_PATH, ['--preflight'], {encoding: 'utf8'});

	t.regex(stdout, /"type":"preflight"/v);
});

// ---------------------------------------------------------------------------
// Reading a one-shot answer out of stdout
//
// The preflight reader is transport, not policy: given the whole stdout of a
// run, it finds the report. These drive it as a pure function over strings,
// beside the one-shot runner it reads for.
// ---------------------------------------------------------------------------

/*
`--preflight`'s answer, as the helper prints it: one JSON line on stdout. Built
from the wire format rather than from anything the code under test exports, so
a change to the format is visible here.
*/
function preflightLine(access: string): string {
	return `${JSON.stringify({
		type: 'preflight',
		inputMonitoring: access,
		message: `Input Monitoring is ${access} for this helper.`,
	})}\n`;
}

test('the preflight reader finds the report among other lines', t => {
	/*
	`stdout` carries the report and stderr carries diagnostics, but nothing
	enforces that downstream — anything else on stdout is skipped rather than
	believed.
	*/
	t.is(
		preflightFrom(`noise\n${preflightLine('denied')}`)?.inputMonitoring,
		'denied',
	);
});

test('the preflight reader keeps the last preflight line', t => {
	/*
	Last wins, so a diagnostic that happens to start with a brace and parse
	cannot preempt the report printed after it.
	*/
	const stdout = preflightLine('denied') + preflightLine('granted');

	t.is(preflightFrom(stdout)?.inputMonitoring, 'granted');
});

test('stdout with no preflight line yields no report', t => {
	/*
	An error line parses as an event like any other and is still not the
	answer: the reader keeps preflight lines and nothing else.
	*/
	t.is(preflightFrom(''), undefined);
	t.is(
		preflightFrom(
			'{"message":"no tap","code":"inputMonitoringDenied","type":"error"}\n',
		),
		undefined,
	);
	t.is(preflightFrom('noise\nnot json\n'), undefined);
});
