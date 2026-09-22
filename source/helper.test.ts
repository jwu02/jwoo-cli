/*
The helper module, driven against real processes.

This is the one module that talks to the helper process, so it is the one place
a fake proves less than the real thing. `--self-check` is the seam that makes
that affordable: it prints one sample of every event type and exits before
creating a tap, so these tests need no permission, no input, and no live
capture. It is the same reason the helper has that mode at all.

The other fixtures are not the helper. They are `/bin/cat` and a path that does
not exist, chosen because each produces something the helper cannot be asked to
produce on demand — a line split across two reads, and a failure to start.
*/

import {execFileSync} from 'node:child_process';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {EventStream, HELPER_PATH, type StreamProblem} from './helper.js';
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

test('a line split across two reads is reassembled', async t => {
	/*
	Cat delivers the file in whatever chunks the pipe gives it, which is the
	shape a real stdout has and a single `data` handler would silently drop.
	Two events, written together and read as one buffer, is enough to catch a
	splitter that does not hold a remainder.
	*/
	const directory = await mkdtemp(join(tmpdir(), 'eventstream-'));
	const file = join(directory, 'events.jsonl');
	await writeFile(
		file,
		[
			'{"type":"keyDown","timestampNs":1,"keycode":0,"flagsRaw":256}',
			'{"type":"keyUp","timestampNs":2,"keycode":0,"flagsRaw":256}',
			'',
		].join('\n'),
	);

	const seen = recorder();
	const stream = new EventStream({
		helperPath: '/bin/cat',
		helperArgs: [file],
		onEvent(event) {
			seen.events.push(event);
		},
		onProblem: quiet(),
	});

	stream.start();
	await until(() => seen.events.length >= 2, 'both lines');
	stream.stop();

	t.deepEqual(
		seen.events.map(event => event.type),
		['keyDown', 'keyUp'],
	);
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
