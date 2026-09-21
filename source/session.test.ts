import test from 'ava';
import {
	type Collector,
	CollectionSession,
	type SessionOptions,
	type ShutdownReason,
	type ShutdownSignal,
} from './session.js';
import {TelemetryState} from './state.js';
import {type FlushResult, type TelemetryStore} from './storage.js';

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

class FakeStore implements TelemetryStore {
	#failures: number;
	readonly #hold: (() => Promise<void>) | undefined;
	readonly snapshots: Array<Record<string, unknown>> = [];
	closed = 0;
	/*
	Counted on entry rather than on completion, so a test can tell that a Flush
	has *begun* and is blocked — which is the state the duplicate-write bug needs.
	*/
	started = 0;

	constructor(failures = 0, hold?: () => Promise<void>) {
		this.#failures = failures;
		this.#hold = hold;
	}

	async flush(snapshot: never): Promise<FlushResult> {
		this.started += 1;
		await this.#hold?.();
		this.snapshots.push(snapshot);

		if (this.#failures > 0) {
			this.#failures -= 1;
			return undefined;
		}

		return ['id'];
	}

	async close(): Promise<void> {
		this.closed += 1;
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
			flushIntervalSeconds: options.flushIntervalSeconds ?? 300,
			shutdown: signal,
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
The retry rule from `storage.ts`, seen from the Session: a failed Flush leaves
Telemetry State whole, so the next attempt writes the same counters rather than
losing them — here, the one key press appears in both attempts.
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
The duplicate-write bug this test pins. Telemetry State is cleared only after a
successful write, so a Flush still waiting on the database has not cleared it —
and a final Flush started alongside it would snapshot the same counters and
insert them a second time, double-counting them in the heatmap. The final Flush
waits for the one in flight.
*/
test('a Flush still in flight is not written twice by the final Flush', async t => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>(resolve => {
		release = () => {
			resolve();
		};
	});
	const store = new FakeStore(0, async () => gate);
	const {session, signal, state} = build({
		store,
		flushIntervalSeconds: 0.005,
	});
	state.addKeyPress('A');

	const running = session.run();
	await until(() => store.started === 1, {what: 'the interval Flush to start'});

	// The signal lands while that Flush is still blocked on the store.
	signal.fire('SIGINT');
	release?.();
	const shutdown = await running;

	t.is(store.snapshots.length, 1, 'the counters were written once');
	t.is(store.snapshots[0]?.['keysPressed'], 1);
	t.true(shutdown.finalFlush, 'the in-flight Flush cleared the state');
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
