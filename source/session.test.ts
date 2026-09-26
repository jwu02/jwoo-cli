import test from 'ava';
import {
	type Collector,
	CollectionSession,
	type EventStream,
	type FlushAttempt,
	type FlushStore,
	type Pusher,
	type SessionOptions,
	type ShutdownReason,
	type ShutdownSignal,
} from './session.js';
import {TelemetryState} from './state.js';

/*
A stand-in for the OS. The Session takes shutdown from a source rather than
calling `process.on` itself, so a test can fire a signal without signalling the
test runner — a test that did that would kill ava on the way to its own
assertion.
*/
class FakeShutdownSignal implements ShutdownSignal {
	#listeners: Array<(shutdown: ShutdownReason) => void> = [];
	uninstalled = 0;

	onShutdown(listener: (shutdown: ShutdownReason) => void): () => void {
		this.#listeners.push(listener);
		return () => {
			this.uninstalled += 1;
			this.#listeners = this.#listeners.filter(entry => entry !== listener);
		};
	}

	fire(signal: NodeJS.Signals): void {
		for (const listener of this.#listeners) {
			listener({signal});
		}
	}
}

/*
The Local Store, standing in. Synchronous, because the real one is: `node:sqlite`
carries no promise, and a fake that answered with one would let the Session go on
waiting for a write that had already finished.

It holds no way to catch a Flush mid-write, and that is the point rather than a
gap — a synchronous call cannot be interrupted, so there is no such state for a
test to put one in.
*/
class FakeStore implements FlushStore {
	#failures: number;
	readonly trace: string[];
	readonly snapshots: Array<Record<string, unknown>> = [];
	closed = 0;

	constructor(failures = 0, trace: string[] = []) {
		this.#failures = failures;
		this.trace = trace;
	}

	flush(snapshot: never): Date | undefined {
		this.snapshots.push(snapshot);

		if (this.#failures > 0) {
			this.#failures -= 1;
			this.trace.push('flush:failed');
			return undefined;
		}

		this.trace.push('flush:ok');
		return new Date();
	}

	close(): void {
		this.closed += 1;
		this.trace.push('store:close');
	}
}

/*
The Push, standing in, recording *when* it was asked to Drain rather than what
it did with one — the Session decides the timing, and what a Drain carries is
`push.test.ts`'s business.

Single-flight, as the real one is, and a pass finishes on a macrotask the way a
round trip to a server does: a second ask in the same turn of the event loop
finds the pass in flight and joins it.
*/
class FakePusher implements Pusher {
	readonly #hold: (() => Promise<void>) | undefined;
	#inFlight: Promise<void> | undefined;
	readonly trace: string[];
	passes = 0;
	closed = 0;
	/*
	A Drain the Pusher cannot carry out at all, which is not the same as one that
	failed against the server: the seam itself is broken, and the promise rejects
	rather than the attempt reporting.
	*/
	failWith?: Error;

	constructor(trace: string[] = [], hold?: () => Promise<void>) {
		this.trace = trace;
		this.#hold = hold;
	}

	async #pass(): Promise<void> {
		await this.#hold?.();
		await delay(0);

		if (this.failWith) {
			throw this.failWith;
		}
	}

	async drain(): Promise<void> {
		if (this.#inFlight === undefined) {
			this.passes += 1;
			this.trace.push('drain');
			this.#inFlight = this.#pass().finally(() => {
				this.#inFlight = undefined;
			});
		}

		await this.#inFlight;
	}

	async close(): Promise<void> {
		this.closed += 1;
		this.trace.push('pusher:close');
	}
}

type TestSession = {
	readonly session: CollectionSession;
	readonly signal: FakeShutdownSignal;
	readonly store: FakeStore;
	readonly state: TelemetryState;
};

function build(options: Partial<SessionOptions> = {}): TestSession {
	const store = (options.store as FakeStore | undefined) ?? new FakeStore();
	const state = options.state ?? new TelemetryState();
	const signal =
		(options.shutdown as FakeShutdownSignal | undefined) ??
		new FakeShutdownSignal();

	return {
		store,
		state,
		signal,
		session: new CollectionSession({
			store,
			state,
			collectors: options.collectors ?? [],
			stream: options.stream,
			flushIntervalSeconds: options.flushIntervalSeconds ?? 300,
			shutdown: signal,
			pusher: options.pusher,
			onFlush: options.onFlush,
		}),
	};
}

function collector(): Collector & {started: number; stopped: number} {
	return {
		started: 0,
		stopped: 0,
		start() {
			this.started += 1;
		},
		stop() {
			this.stopped += 1;
		},
	};
}

/*
A stand-in for the helper's stream, recording the order it was opened and closed
relative to the Collectors. Ordering is the whole point of it: events have to be
flowing before anything is listening, and must have stopped before the final
Flush takes its Snapshot.
*/
type Traced = {readonly log: string[]};

function eventStream(trace: Traced): EventStream {
	return {
		start() {
			trace.log.push('stream:start');
		},
		stop() {
			trace.log.push('stream:stop');
		},
	};
}

function tracedCollector(trace: Traced, name: string) {
	return {
		started: 0,
		stopped: 0,
		start() {
			this.started += 1;
			trace.log.push(`${name}:start`);
		},
		stop() {
			this.stopped += 1;
			trace.log.push(`${name}:stop`);
		},
	};
}

async function delay(ms: number): Promise<void> {
	await new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

/*
Waits for Flushes to land rather than sleeping a fixed number of milliseconds
and hoping. A fixed sleep is a race against a shared machine, and these tests
already have a bounded number of Flushes to wait for.
*/
async function until(
	isSatisfied: () => boolean,
	{timeoutMs = 2000, what}: {timeoutMs?: number; what: string},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (!isSatisfied()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}

		// eslint-disable-next-line no-await-in-loop -- polling, one check at a time.
		await delay(5);
	}
}

test('Activity is flushed on the Flush Interval, and Telemetry State cleared', async t => {
	const {session, signal, store, state} = build({flushIntervalSeconds: 0.005});
	state.addLeftClick();

	const running = session.run();
	await until(() => store.snapshots.length === 1, {what: 'the interval Flush'});
	signal.fire('SIGTERM');
	const shutdown = await running;

	// The interval, not the shutdown: nothing was added between the two.
	t.is(shutdown.signal, 'SIGTERM');
	t.is(shutdown.reason, 'signal');
	t.true(shutdown.finalFlush);
	t.is(store.snapshots.length, 1);
	t.is(store.snapshots[0]?.['leftClicks'], 1);
	t.is(state.snapshot().leftClicks, 0);
});

/*
The rule this issue adds. Ctrl-C (SIGINT) and `kill` (SIGTERM) both have to end
with a Flush, or the counters since the last interval are lost on quit.
*/
for (const signalName of ['SIGINT', 'SIGTERM'] as const) {
	test(`${signalName} flushes the interval in progress before exiting`, async t => {
		const {session, signal, store, state} = build({flushIntervalSeconds: 300});

		const running = session.run();
		state.addKeyPress('A');
		state.addMouseMovement(72);
		signal.fire(signalName);
		const shutdown = await running;

		t.is(shutdown.signal, signalName);
		t.true(shutdown.finalFlush);
		t.is(store.snapshots.length, 1);
		t.is(store.snapshots[0]?.['movementMeters'], 0.0254);
		t.is(store.snapshots[0]?.['keysPressed'], 1);
		t.is(state.snapshot().keysPressed, 0);
		t.is(store.closed, 1);
	});
}

test('shutdown with no Activity writes nothing', async t => {
	const {session, signal, store} = build();

	const running = session.run();
	signal.fire('SIGTERM');
	await running;

	t.is(store.snapshots.length, 0);
	t.is(store.closed, 1);
});

/*
The retry rule the store's write face states, seen from the Session: a failed
Flush leaves Telemetry State whole, so the next attempt writes the same counters
rather than losing them — here, the one key press appears in both attempts.
*/
test('a failed Flush keeps Telemetry State for the next attempt', async t => {
	const store = new FakeStore(1);
	/*
	Wide enough that exactly one interval Flush can land before the shutdown,
	which is what makes the second Snapshot the retry rather than a race with a
	third attempt.
	*/
	const {session, signal, state} = build({
		store,
		flushIntervalSeconds: 0.02,
	});
	state.addKeyPress('A');

	const running = session.run();
	await until(() => store.snapshots.length === 1, {
		what: 'the failed interval Flush',
	});
	t.is(state.snapshot().keysPressed, 1, 'state survived the failed Flush');

	signal.fire('SIGTERM');
	const shutdown = await running;

	t.true(shutdown.finalFlush, 'the retry succeeded');
	t.is(store.snapshots.length, 2);
	t.is(store.snapshots[1]?.['keysPressed'], 1);
	t.is(state.snapshot().keysPressed, 0);
});

/*
The other half of the same rule: counters that never reached storage must not be
reported as though they had, or the exit code tells a shell the opposite of what
happened.
*/
test('a failed final Flush is reported as such, and leaves the state whole', async t => {
	const store = new FakeStore(Infinity);
	const {session, signal, state} = build({store});
	state.addKeyPress('A');

	const running = session.run();
	signal.fire('SIGTERM');
	const shutdown = await running;

	t.false(shutdown.finalFlush);
	t.is(shutdown.reason, 'signal');
	t.is(state.snapshot().keysPressed, 1, 'the counters were not cleared');
	t.is(store.closed, 1);
});

test('stop() reports the outcome of its final Flush', async t => {
	const store = new FakeStore(Infinity);
	const {session, state} = build({store});
	state.addLeftClick();

	const shutdown = await session.stop();

	t.is(shutdown.reason, 'stop');
	t.is(shutdown.signal, undefined);
	t.false(shutdown.finalFlush);
});

test('Every Collector is started and stopped once', async t => {
	const mouse = collector();
	const keyboard = collector();
	const {session, signal} = build({collectors: [mouse, keyboard]});

	const running = session.run();
	t.is(mouse.started, 1);
	signal.fire('SIGINT');
	await running;

	t.is(mouse.stopped, 1);
	t.is(keyboard.started, 1);
	t.is(keyboard.stopped, 1);
});

/*
The stream's lifetime, which the Session owns rather than any Collector: the
Collectors and the helper have to start and stop together, and a stream hidden
inside one Collector's `start()` is a lifetime nobody can see.

The order is the assertion, not just the calls. Events have to be flowing before
anything is listening, and the helper must have stopped before the final Flush
takes its Snapshot — otherwise the last interval is read while counts are still
arriving.
*/
test('the stream is opened before the Collectors and closed before the Flush', async t => {
	const trace: Traced = {log: []};
	const mouse = tracedCollector(trace, 'mouse');
	const keyboard = tracedCollector(trace, 'keyboard');
	const {session, signal, state} = build({
		collectors: [mouse, keyboard],
		stream: eventStream(trace),
	});
	state.addLeftClick();

	const running = session.run();
	signal.fire('SIGINT');
	await running;

	t.deepEqual(trace.log, [
		'stream:start',
		'mouse:start',
		'keyboard:start',
		'stream:stop',
		'mouse:stop',
		'keyboard:stop',
	]);
});

test('a Collector that throws on start still closes the stream', async t => {
	/*
	The stream is started before the Collectors, so skipping it on the failure
	path would leave a capture process running with nothing to feed — which is
	the leak the whole lifetime exists to prevent.
	*/
	const trace: Traced = {log: []};
	const broken: Collector = {
		start() {
			trace.log.push('broken:start');
			throw new Error('the helper could not be spawned');
		},
		stop() {
			trace.log.push('broken:stop');
		},
	};
	const {session} = build({collectors: [broken], stream: eventStream(trace)});

	await t.throwsAsync(session.run(), {
		message: 'the helper could not be spawned',
	});

	t.deepEqual(trace.log, ['stream:start', 'broken:start', 'stream:stop']);
});

test('stop() is idempotent, so a signal racing a quit flushes once', async t => {
	const {session, store, state} = build();
	state.addLeftClick();

	await session.stop();
	await session.stop();

	t.is(store.snapshots.length, 1);
	t.is(store.closed, 1);
});

test('the shutdown listener is released once the Session has ended', async t => {
	const {session, signal} = build();

	const running = session.run();
	signal.fire('SIGTERM');
	await running;

	t.is(signal.uninstalled, 1);
});

/*
The way a dashboard ends. `q` is not a signal: the terminal is in raw mode while
the view is drawn, so the SIGINT it would otherwise generate is never sent, and
the only thing that knows the run is over is the caller that stopped it. Without
this, `run()` waits for a signal that cannot arrive.
*/
test('stop() ends the run, with no signal to name', async t => {
	const {session, store, state} = build({flushIntervalSeconds: 300});
	state.addLeftClick();

	const running = session.run();
	const stopped = await session.stop();
	const shutdown = await running;

	t.is(shutdown.reason, 'stop');
	t.is(shutdown.signal, undefined);
	t.true(shutdown.finalFlush);
	t.deepEqual(shutdown, stopped, 'run() reports the same shutdown');
	t.is(store.snapshots.length, 1);
	t.is(store.closed, 1);
});

/*
What a view outside the Session needs to draw a live total: Telemetry State is
cleared by a successful Flush, so the counters it was holding have to be handed
over at the moment they are written or they are gone.
*/
test('a Flush is reported with the counters it wrote', async t => {
	const attempts: FlushAttempt[] = [];
	const {session, signal, state} = build({
		onFlush(attempt) {
			attempts.push(attempt);
		},
	});
	state.addLeftClick();
	state.addKeyPress('A');

	const running = session.run();
	signal.fire('SIGTERM');
	await running;

	t.is(attempts.length, 1);
	t.true(attempts[0]?.ok);
	t.is(attempts[0]?.snapshot.leftClicks, 1);
	t.is(attempts[0]?.snapshot.keysPressed, 1);
	t.true(attempts[0]?.at instanceof Date);
});

/*
A failed Flush is reported as a failure and still carries its counters, because
the observer must not add them to a running total: Telemetry State was not
cleared, so they are still in there and would be counted twice.
*/
test('a failed Flush is reported as one, counters and all', async t => {
	const attempts: FlushAttempt[] = [];
	const {session, signal, state} = build({
		store: new FakeStore(Infinity),
		onFlush(attempt) {
			attempts.push(attempt);
		},
	});
	state.addLeftClick();

	const running = session.run();
	signal.fire('SIGTERM');
	await running;

	t.is(attempts.length, 1);
	t.false(attempts[0]?.ok);
	t.is(attempts[0]?.snapshot.leftClicks, 1);
});

/*
An idle interval attempts no write at all, and a Run Log that heard about one
would gain an entry for a write that never happened.
*/
test('an interval with no Activity reports nothing', async t => {
	const attempts: FlushAttempt[] = [];
	const {session, signal} = build({
		flushIntervalSeconds: 300,
		onFlush(attempt) {
			attempts.push(attempt);
		},
	});

	const running = session.run();
	signal.fire('SIGTERM');
	await running;

	t.deepEqual(attempts, []);
});

/*
A Collector that cannot start is a broken install rather than a missing grant,
so it still reaches the caller — but the store is closed on the way out either
way, or a failed start would leak the connection.
*/
test('a Collector that throws on start propagates, and the store still closes', async t => {
	const {session, store} = build({
		collectors: [
			{
				start() {
					throw new Error('no tap');
				},
				stop() {
					// Never reached: the Collector that threw is not stopped.
				},
			},
		],
	});

	await t.throwsAsync(session.run(), {message: 'no tap'});
	t.is(store.closed, 1);
});

/*
The Push's timing, which is the Session's whole share of it: a Drain is asked
for once as the run starts — for a backlog an earlier run left behind — and
after every Flush that landed, because the era that Flush wrote is the one worth
carrying.

A Flush that failed asks for none. Its era was never written, so there is
nothing new to carry, and the backlog a Drain would walk is the one the last
Drain already walked.
*/
test('a Drain is asked for after a Flush that landed, and not after one that failed', async t => {
	const trace: string[] = [];
	// Set up to fail exactly one Flush, so the retry is an interval's rather
	// than the shutdown's.
	const store = new FakeStore(1, trace);
	const pusher = new FakePusher(trace);
	const {session, signal, state} = build({
		store,
		pusher,
		flushIntervalSeconds: 0.005,
	});
	state.addLeftClick();

	const running = session.run();
	await until(() => store.snapshots.length === 1, {what: 'the failed Flush'});
	await until(() => store.snapshots.length === 2, {
		what: 'the Flush that retried it',
	});

	signal.fire('SIGTERM');
	await running;

	t.deepEqual(trace, [
		'drain', // The backlog this run started with
		'flush:failed',
		'flush:ok',
		'drain', // Asked for by the Flush that landed
		'drain', // One last attempt on the way out
		'store:close',
		'pusher:close',
	]);
});

/*
The order on the way out, which is the whole of ADR-0012's shutdown rule: the
Drain in flight is waited out, the final Flush lands, one last Drain is asked
for and awaited, and only then do the store and the Mongo client close — the
store after the Drain because the Drain reads it.
*/
test('the last Drain is awaited before the store and the client close', async t => {
	const trace: string[] = [];
	const store = new FakeStore(0, trace);
	const pusher = new FakePusher(trace);
	const {session, signal, state} = build({store, pusher});
	state.addLeftClick();

	const running = session.run();
	signal.fire('SIGTERM');
	await running;

	t.deepEqual(trace, [
		'drain', // The startup backlog, which `stop()` waits out first
		'flush:ok',
		'drain', // Asked for by the final Flush, and awaited before anything closes
		'store:close',
		'pusher:close',
	]);
	t.is(store.closed, 1);
	t.is(pusher.closed, 1);
});

/*
The Flush rule ADR-0012 turns on. A Drain waits on a network the CLI does not
control, and the write that matters is the local one — so a Drain still hanging
must not hold up the next Flush, let alone the run.
*/
test('a Flush is not delayed by a Drain still in flight', async t => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>(resolve => {
		release = () => {
			resolve();
		};
	});
	const store = new FakeStore();
	const pusher = new FakePusher([], async () => gate);
	const {session, signal, state} = build({
		store,
		pusher,
		flushIntervalSeconds: 0.005,
	});
	state.addLeftClick();

	const running = session.run();
	await until(() => store.snapshots.length === 1, {what: 'the first Flush'});
	state.addLeftClick();
	await until(() => store.snapshots.length === 2, {
		what: 'a second Flush, with the startup Drain still hanging',
	});

	// Released so the shutdown below is not waiting on the gate too.
	release?.();
	signal.fire('SIGTERM');
	const shutdown = await running;

	t.true(shutdown.finalFlush);
	t.is(store.closed, 1);
});

/*
A Drain that rejects is not the Session's to report — the Pusher reports through
its own attempt callback — but it must not reach the Flush path either. The
Session fires Drains without awaiting them, so an unheld rejection would end the
process rather than the run.
*/
test('a Drain that rejects does not bring the run down', async t => {
	const trace: string[] = [];
	const store = new FakeStore(0, trace);
	const pusher = new FakePusher(trace);
	pusher.failWith = new Error('the push seam is broken');

	const {session, signal, state} = build({store, pusher});
	state.addLeftClick();

	const running = session.run();
	signal.fire('SIGTERM');
	const shutdown = await running;

	t.true(shutdown.finalFlush, 'the local write was unaffected');
	t.is(store.closed, 1);
});

/*
The permission report decides which Collectors exist; the Session is handed the
Collectors and never sees the report. A Session built with Collections for a
grant the machine does not have runs them anyway — which is what makes this a
boundary rather than a coincidence.
*/
test('the Session runs the Collectors it is given, whatever the grant says', async t => {
	const keyboard = collector();
	const {session, signal} = build({collectors: [keyboard]});

	const running = session.run();
	signal.fire('SIGTERM');
	await running;

	t.is(keyboard.started, 1);
});
