import process from 'node:process';
import test from 'ava';
import {type Config} from './config.js';
import {
	type Era,
	type HistoryData,
	type LoadResult,
	type ReadWarning,
	type ReadWarningReporter,
	type Totals,
} from './local-store.js';
import {
	type CollectorFactory,
	type DashboardView,
	type Logger,
	type RunOptions,
	type RunStore,
	run,
} from './main.js';
import {type StreamProblem, type StreamSinks} from './helper.js';
import {KeyboardCollector} from './keyboard.js';
import {type PermissionReport, type PermissionSource} from './permissions.js';
import {type PushBacklog} from './push.js';
import {type HelperError, keyEventAt, type RawEvent} from './raw-event.js';
import {
	InProcessRunLogSource,
	type RunLogEntry,
	type RunLogSource,
} from './run-log.js';
import {
	type Collector,
	type EventStream,
	type Pusher,
	type ShutdownReason,
	type ShutdownSignal,
} from './session.js';
import {TelemetryState} from './state.js';
import {type LiveTelemetry, type TelemetrySource} from './telemetry.js';

const CONFIG: Config = {
	mongoUri: 'mongodb://example.invalid',
	dbName: 'test',
	collectionName: 'telemetry',
	heatmapCollectionName: 'keyboard_heatmap',
	flushIntervalSeconds: 3600,
	mouseDpi: 72,
	collectionTtlSeconds: 1,
	heatmapTtlSeconds: 1,
	timeZone: 'Europe/London',
	/*
	Unused here: every test in this file hands the composition root a store
	rather than letting it open the file, so a run never touches this path.
	*/
	localStorePath: '/tmp/jwoo-cli-test/telemetry.db',
};

/*
NonCoalesced, which every captured event carried, as `keyboard.test.ts` does.
Spelled here rather than imported from a test file, which ava would then run
twice. SecondaryFn is here for Fn, which is counted off a `flagsChanged` event
rather than a `keyDown` (ADR-0006).
*/
const BARE = 256;
const SECONDARY_FN = 8_388_608;
const FN = 63;
const A_KEY = 0;

/*
The Local Store, standing in: a store that writes, or one that fails a set
number of Flushes and then writes.

The budget is what makes a *mid-run* failure testable: the Flush that fails has
to be an interval's rather than the last one's, so that the retry lands and the
run ends cleanly — which is the only shape in which "one failure, one report"
can be counted.

Synchronous, as `session.test.ts`'s is and for the same reason: the real store
carries no promise, and the write face the Session reaches for has none either.

`close` is idempotent, as the Local Store's is. Two things close it on the way
out of a run — the Session, and the composition root on the paths a run never
reached — and only one of them does the work.

It is the read face too, and a field rather than a construction argument for it:
the harness's store exists before the run that builds the real one, and the
composition root hands the reporter over as it builds it.
*/
class FakeStore implements RunStore {
	#failures: number;
	readonly snapshots: Array<Record<string, unknown>> = [];
	/*
	Where a read's warning goes. Silent until the composition root says
	otherwise, because the default reporter writes to stderr and a test that is
	not about the routing should not hear about it.
	*/
	onWarning: ReadWarningReporter = noop;
	/*
	What a read answers with, and the warnings it raises on the way. A store
	whose read fails is this pair, which is what makes the seam's two ends —
	the answer and the report — separately assertable.
	*/
	readResult: LoadResult = {ok: true, data: data()};
	readWarnings: readonly ReadWarning[] = [];
	reads = 0;
	closed = 0;

	constructor(failures = 0) {
		this.#failures = failures;
	}

	/*
	No arguments: which range was asked for is not what any test here is about —
	a store handed the real one answers the same way — and naming them would be
	pretending otherwise. The count is kept, because "the view asked" is.
	*/
	load(): LoadResult {
		this.reads += 1;

		for (const warning of this.readWarnings) {
			this.onWarning(warning);
		}

		return this.readResult;
	}

	flush(snapshot: never): Date | undefined {
		if (this.#failures > 0) {
			this.#failures -= 1;
			return undefined;
		}

		this.snapshots.push(snapshot);
		return new Date();
	}

	/*
	The Push Backlog, which is empty: what a Drain carries is `push.test.ts`'s,
	and a run that Pushed something here would be reaching for Atlas.
	*/
	backlog(): readonly Era[] {
		return [];
	}

	markPushed(): void {
		// Nothing is in the backlog, so nothing is ever acknowledged.
	}

	close(): void {
		if (this.closed === 0) {
			this.closed += 1;
		}
	}
}

/*
The Push, standing in. What the composition root has to get right about it is
where it is built from and that it is closed with everything else; what a Drain
carries is `push.test.ts`'s.
*/
class FakePusher implements Pusher {
	readonly backlogs: PushBacklog[] = [];
	drains = 0;
	closed = 0;

	async drain(): Promise<void> {
		this.drains += 1;
	}

	async close(): Promise<void> {
		if (this.closed === 0) {
			this.closed += 1;
		}
	}
}

/*
Waits for something the run reaches on its own — a Flush Interval firing —
rather than for a fixed time, so a test is not racing the timer's resolution.
*/
async function until(isSatisfied: () => boolean, what: string): Promise<void> {
	for (let attempts = 0; attempts < 200; attempts += 1) {
		if (isSatisfied()) {
			return;
		}

		// eslint-disable-next-line no-await-in-loop -- polling, one check at a time.
		await new Promise(resolve => {
			setTimeout(resolve, 5);
		});
	}

	throw new Error(`timed out waiting for ${what}`);
}

class FakeShutdownSignal implements ShutdownSignal {
	#listeners: Array<(shutdown: ShutdownReason) => void> = [];
	/*
	Held until someone is listening, the way a real signal is: `run()` installs
	its listener only after the dashboard's dynamic import has resolved, so a
	signal fired before then must not be dropped.
	*/
	#pending: ShutdownReason | undefined;

	onShutdown(listener: (shutdown: ShutdownReason) => void): () => void {
		const pending = this.#pending;
		if (pending !== undefined) {
			this.#pending = undefined;
			listener(pending);
			// Delivered at once, so there is nothing left to unsubscribe from.
			return noop;
		}

		this.#listeners.push(listener);
		return () => {
			this.#listeners = this.#listeners.filter(entry => entry !== listener);
		};
	}

	fire(signal: NodeJS.Signals): void {
		if (this.#listeners.length === 0) {
			this.#pending = {signal};
			return;
		}

		for (const listener of this.#listeners) {
			listener({signal});
		}
	}
}

/*
A no-op rather than an arrow, because the lint rule that forbids an empty
function body is the point: there is genuinely nothing to release here, and the
shared constant says so once.
*/
function noop(): void {
	// Nothing to unsubscribe from; see the call site.
}

/*
The grant request, stubbed rather than left to the default. A granted run never
makes it, and the default spawns the real helper and asks macOS for a prompt
nobody is there to answer — which would hang the suite rather than fail it.
*/
function noGrantRequest(): void {
	throw new Error('a granted run must not ask for the grant');
}

/*
The terminal's stderr, held for the length of one synchronous call.

What these tests pin is what does or does not reach the terminal, and the
reporter that decides it writes to `process.stderr` and nowhere else — there is
nothing in the run to stand in for. The window is the call rather than the test,
because ava runs the tests in this file concurrently and a whole-run window
would swallow another test's output along with it.
*/
function captureStderr(call: () => void): string[] {
	const written: string[] = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk: string) => {
		written.push(chunk);
		return true;
	};

	try {
		call();
	} finally {
		process.stderr.write = original;
	}

	return written;
}

/*
The same question asked of a whole run rather than of one call, because a frame
is up for a whole run: what a Flush Interval writes, and what a retry writes,
are not inside any single call a test can wrap.

It records *and forwards*. A window this long may overlap another test's, and a
window that swallowed would take that test's output down with it — the only
thing this one takes is a copy.
*/
function watchStderr(): {written: string[]; restore: () => void} {
	const written: string[] = [];
	const original = process.stderr.write;
	process.stderr.write = function (chunk: string) {
		written.push(chunk);
		return original.call(process.stderr, chunk);
	};

	return {
		written,
		restore() {
			process.stderr.write = original;
		},
	};
}

/*
The helper's own failure line, as `--self-check` prints one and as the stream
delivers it: an event like any other, owned by no Collector.
*/
const FAILURE: HelperError = {
	type: 'error',
	code: 'tapDisabled',
	message: 'the event tap was disabled',
};

/*
A grant, as `permissions.ts` would report it. Built here rather than through
`permissionReport` so a test can grant one Collector and not the other — which
the helper cannot currently produce, but the factory is typed against.
*/
function granted(): PermissionReport {
	return {status: 'granted'};
}

function denied(): PermissionReport {
	return {
		status: 'disabled',
		access: 'denied',
		disabled: [
			{collector: 'mouse', note: 'mouse off'},
			{collector: 'keyboard', note: 'keyboard off'},
		],
		message: 'Input Monitoring is denied for this helper.',
	};
}

class FakePermissions implements PermissionSource {
	readonly #report: PermissionReport;
	readonly calls: number[] = [];
	/*
	A helper that cannot be asked at all — a missing binary, a crash, a hang —
	which `permissions.ts` raises rather than reporting as a missing grant.
	*/
	failWith?: Error;

	constructor(report: PermissionReport) {
		this.#report = report;
	}

	async preflight(): Promise<PermissionReport> {
		this.calls.push(this.calls.length);

		if (this.failWith) {
			throw this.failWith;
		}

		return this.#report;
	}
}

function logger(): Logger & {lines: string[]; warnings: string[]} {
	const lines: string[] = [];
	const warnings: string[] = [];

	return {
		lines,
		warnings,
		log(message: string) {
			lines.push(message);
		},
		warn(message: string) {
			warnings.push(message);
		},
	};
}

/*
The Session asks a stream to start and stop and nothing else, so a trace of
those two calls is the whole of what "the Session owned it" means.
*/
function tracedStream(trace: string[]): EventStream {
	return {
		start() {
			trace.push('start');
		},
		stop() {
			trace.push('stop');
		},
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

type Harness = {
	readonly options: RunOptions;
	readonly permissions: FakePermissions;
	readonly shutdown: FakeShutdownSignal;
	readonly store: FakeStore;
	readonly pusher: FakePusher;
	readonly logger: ReturnType<typeof logger>;
	readonly reports: PermissionReport[];
	readonly collectors: Array<ReturnType<typeof collector>>;
	/*
	The logger the composition root built the Push seam with, one per run. What
	its warnings are worth is decided by where that logger puts them, and there
	is no other way to reach it from outside a run.
	*/
	readonly pushLoggers: Array<Pick<Console, 'warn'>>;
};

function harness(report: PermissionReport): Harness {
	const permissions = new FakePermissions(report);
	const shutdown = new FakeShutdownSignal();
	const store = new FakeStore();
	const pusher = new FakePusher();
	const lines = logger();
	const reports: PermissionReport[] = [];
	const collectors: Array<ReturnType<typeof collector>> = [];
	const pushLoggers: Array<Pick<Console, 'warn'>> = [];

	const buildCollectors: CollectorFactory = seen => {
		reports.push(seen);
		const built = collector();
		collectors.push(built);
		return {collectors: [built]};
	};

	return {
		permissions,
		shutdown,
		store,
		pusher,
		logger: lines,
		reports,
		collectors,
		pushLoggers,
		options: {
			permissions,
			shutdown,
			/*
			The harness's store, opened here and not by the composition root — the
			composition root's own opening of the real one is asserted below.

			The reporter is taken and kept, because that is what the composition
			root does with it and a store that dropped it would make the routing
			untestable: the seam reports through what it was built with.
			*/
			createStore(onWarning: ReadWarningReporter) {
				store.onWarning = onWarning;
				return store;
			},
			/*
			Built the way the real one is, and handed the logger the composition
			root decided the mode's warnings go through.
			*/
			createPusher(backlog, pushLogger) {
				pusher.backlogs.push(backlog);
				pushLoggers.push(pushLogger);
				return pusher;
			},
			state: new TelemetryState(),
			logger: lines,
			config: CONFIG,
			collectors: buildCollectors,
		},
	};
}

test('collect builds every Collector the grant allows', async t => {
	const test_ = harness(granted());

	const running = run({kind: 'collect'}, test_.options);
	test_.shutdown.fire('SIGINT');
	await running;

	t.deepEqual(test_.reports, [{status: 'granted'}]);
	t.is(test_.collectors[0]?.started, 1);
	t.is(test_.collectors[0]?.stopped, 1);
});

/*
The rule from `CONTEXT.md`: a missing permission degrades collection rather than
stopping the CLI. What it must not do is exit, so the run reaches its shutdown
and the disabled Collectors are reported by name.
*/
test('a missing grant disables both Collectors without stopping the CLI', async t => {
	const test_ = harness(denied());

	const running = run({kind: 'collect'}, test_.options);
	test_.shutdown.fire('SIGTERM');
	await running;

	t.is(test_.reports[0]?.status, 'disabled');
	t.deepEqual(test_.logger.warnings, ['mouse off', 'keyboard off']);
	t.regex(test_.logger.lines[0] ?? '', /Input Monitoring is denied/v);
});

/*
The Flush the issue asks for. The counters are added straight to Telemetry State
here, so what is under test is that a signal reaches a Flush before the store
closes — not where the counting came from. The factory's own half of that is
covered below.
*/
test('collect Flushes on shutdown before the store closes', async t => {
	const test_ = harness(granted());
	test_.options.state?.addLeftClick();

	const running = run({kind: 'collect'}, test_.options);
	/*
	The Flush Interval here is an hour, so the only Flush there can be is the one
	the signal causes: a Snapshot present after a SIGINT is the final Flush and
	nothing else.
	*/
	test_.shutdown.fire('SIGINT');
	await running;

	t.is(test_.store.snapshots.length, 1);
	t.is(test_.store.snapshots[0]?.['leftClicks'], 1);
	t.is(test_.store.closed, 1);
});

/*
The gap the two tests above leave, and the one that matters most.

Both reach into Telemetry State directly — `test_.options.state?.addLeftClick()`
— so both would pass a `runCollect` that handed the Collectors a *different*
state from the one it flushes. That run counts into a state nothing reads, and
because the Session skips a Flush when its own state shows no activity, it
writes nothing at all and still reports success.

So this one counts through the factory's own context, using a real Collector,
and requires the count to come out of the store.
*/
test('a Collector counts into the State the Session flushes', async t => {
	const test_ = harness(granted());

	/*
	Raised before the run begins, which the fake delivers to the first listener
	to arrive. That makes the whole run resolve without a race, and the factory
	has still run by the time it does — so the press below has been counted by
	the time the final Flush takes its Snapshot.
	*/
	test_.shutdown.fire('SIGINT');

	await run(
		{kind: 'collect'},
		{
			...test_.options,
			collectors(_report, state) {
				const keyboard = new KeyboardCollector({state});
				keyboard.handle(keyEventAt('keyDown', 0, BARE));
				return {collectors: [keyboard]};
			},
		},
	);

	t.is(test_.store.snapshots.length, 1);
	t.deepEqual(test_.store.snapshots[0]?.['keyCounts'], {A: 1});
});

/*
The half of the wiring that is invisible from outside, and the reason a run can
look healthy while collecting nothing: a factory that builds a stream the
Session never hears about compiles, starts every Collector, and feeds them no
events at all.

Through a factory the caller supplied rather than the default one, so that the
stream can be traced without spawning a helper at all. The default factory's own
stream is covered below, over a stream of the same kind.
*/
test('a stream the factory supplies is started and stopped by the Session', async t => {
	const test_ = harness(granted());
	const trace: string[] = [];

	test_.shutdown.fire('SIGINT');

	await run(
		{kind: 'collect'},
		{
			...test_.options,
			collectors: () => ({collectors: [], stream: tracedStream(trace)}),
		},
	);

	t.deepEqual(trace, ['start', 'stop']);
});

/*
A stand-in for the helper's stream: the one the real factory builds, wires and
hands to the Session. There is no fake tap to point a real one at, and no
permission to collect under, so this is what makes the default factory reachable
from a test at all.
*/
class FakeStream implements EventStream {
	#resolveStarted: () => void = noop;
	#handler: ((event: RawEvent) => void) | undefined;
	/*
	Resolved by `start()`, so a test can deliver an event into a run that is
	genuinely under way. The handler is attached before then, but an event
	emitted before `start()` would reach a run that has not begun, and one
	emitted after the signal would arrive after the final Flush had taken its
	Snapshot.
	*/
	readonly started = new Promise<void>(resolve => {
		this.#resolveStarted = resolve;
	});

	starts = 0;
	stops = 0;

	onEvent(handler: (event: RawEvent) => void): void {
		this.#handler = handler;
	}

	start(): void {
		this.starts += 1;
		this.#resolveStarted();
	}

	stop(): void {
		this.stops += 1;
	}

	emit(event: RawEvent): void {
		this.#handler?.(event);
	}
}

/*
The harness's options with its factory taken back out, for the tests that are
about the factory the composition root supplies when none was given. Every other
test in this file injects one, so that it does not spawn a capture process.
*/
function withoutFactory(options: RunOptions): RunOptions {
	const {collectors: _injected, ...rest} = options;
	return rest;
}

/*
On a denied report the default factory builds nothing at all — no Collector, and
no stream either, because a helper with no tap to open would exit and report
itself as a problem on a path meant to degrade quietly. The grant is asked for
exactly once, on the run where the user has just been told it is missing.
*/
test('a denied grant builds no Collectors and asks for it once', async t => {
	const test_ = harness(denied());
	const requests: number[] = [];
	const streams: number[] = [];

	test_.shutdown.fire('SIGTERM');

	await run(
		{kind: 'collect'},
		{
			...withoutFactory(test_.options),
			createStream() {
				streams.push(1);
				return new FakeStream();
			},
			requestInputMonitoring() {
				requests.push(1);
			},
		},
	);

	t.is(requests.length, 1);
	t.is(streams.length, 0);
	t.is(test_.store.closed, 1, 'and the run still reaches its shutdown');
});

/*
The statement of event ownership, executed for the first time: the factory the
composition root supplies when none was given, driving real Collectors over a
stream this test can see into.

Nothing here goes through an option that replaces the factory, which is the
point of the test. The event is delivered through the stream the factory itself
built and wired, and the count has to come out of the store — so a factory that
built a second stream, or wired no handler at all, fails here rather than
collecting nothing quietly.
*/
test('an event through the factory’s own stream reaches the final Flush', async t => {
	const test_ = harness(granted());
	const stream = new FakeStream();
	const requests: number[] = [];

	const running = run(
		{kind: 'collect'},
		{
			...withoutFactory(test_.options),
			createStream: () => stream,
			requestInputMonitoring() {
				requests.push(1);
			},
		},
	);

	await stream.started;
	stream.emit(keyEventAt('keyDown', 0, BARE));

	test_.shutdown.fire('SIGINT');
	await running;

	t.is(requests.length, 0, 'a granted run asks for nothing');
	t.is(stream.starts, 1);
	t.is(stream.stops, 1, 'and the Session closes what the factory built');
	t.is(test_.store.snapshots.length, 1);
	t.deepEqual(test_.store.snapshots[0]?.['keyCounts'], {A: 1});
});

/*
Delivery, over the Collectors the composition root builds when no factory was
supplied (ADR-0008).

Everything the wire format carries is shown to every Collector and each decides
for itself which events it owns, so what is asserted is the Snapshot as a whole
rather than one number: an event that landed somewhere it does not belong shows
up as a counter that should have stayed at zero, and a Collector the loop forgot
shows up as its own counters never moving.
*/
type Delivery = {
	readonly snapshot: Record<string, unknown> | undefined;
	readonly problems: StreamProblem[];
};

async function deliver(events: readonly RawEvent[]): Promise<Delivery> {
	const test_ = harness(granted());
	const stream = new FakeStream();
	const problems: StreamProblem[] = [];

	const running = run(
		{kind: 'collect'},
		{
			...withoutFactory(test_.options),
			createStream: () => stream,
			onProblem(problem) {
				problems.push(problem);
			},
			requestInputMonitoring: noGrantRequest,
		},
	);

	/*
	Delivered after `start()`, so they reach a run that is genuinely under way,
	and before the signal, so the final Flush takes its Snapshot over all of
	them. The Flush Interval here is an hour, so that is the only Flush there
	can be.
	*/
	await stream.started;
	for (const event of events) {
		stream.emit(event);
	}

	test_.shutdown.fire('SIGINT');
	await running;

	return {snapshot: test_.store.snapshots[0], problems};
}

test('a key event is counted by the Keyboard Collector and by nothing else', async t => {
	/*
	Fn is the third kind of key event on the wire, and the one that is not a
	`keyDown`: it is counted off the flag bit on a `flagsChanged` (ADR-0006), so
	its flags word is composed here the way `keyboard.test.ts` composes its own.
	*/
	// eslint-disable-next-line no-bitwise -- a fixture spelling the flags word, not production code.
	const fnHeld = BARE | SECONDARY_FN;

	const {snapshot, problems} = await deliver([
		keyEventAt('keyDown', A_KEY, BARE),
		keyEventAt('keyUp', A_KEY, BARE),
		keyEventAt('flagsChanged', FN, fnHeld),
	]);

	t.deepEqual(snapshot?.['keyCounts'], {A: 1, Fn: 1});
	t.is(snapshot?.['leftClicks'], 0);
	t.is(snapshot?.['rightClicks'], 0);
	t.is(snapshot?.['movementMeters'], 0, 'no key press moves the pointer');
	t.deepEqual(problems, [], 'and none of it is a problem to report');
});

test('a mouse event is counted by the Mouse Collector and by nothing else', async t => {
	const {snapshot} = await deliver([
		// Two moves, because a distance needs two points: the first move is the
		// baseline. One inch at the configured DPI, so the metres are its own.
		{type: 'mouseMoved', timestampNs: 0, x: 0, y: 0},
		{type: 'mouseMoved', timestampNs: 0, x: CONFIG.mouseDpi, y: 0},
		{type: 'mouseDown', timestampNs: 0, x: 0, y: 0, button: 'left'},
		{type: 'mouseDown', timestampNs: 0, x: 0, y: 0, button: 'right'},
		{type: 'mouseUp', timestampNs: 0, x: 0, y: 0, button: 'left'},
	]);

	t.is(snapshot?.['movementMeters'], 0.0254);
	t.is(snapshot?.['leftClicks'], 1);
	t.is(snapshot?.['rightClicks'], 1, 'a button release is not a second click');
	t.deepEqual(snapshot?.['keyCounts'], {}, 'no click is a key press');
});

/*
A preflight line is on the wire but not in a streaming run: `--preflight` exits
before a tap exists, so the helper never prints one while emitting events. What
is pinned here is that it is harmless if one ever arrives — no Collector owns
it, no counter moves, and so there is no Activity and not even a Flush.
*/
test('a preflight line is delivered and lands nowhere', async t => {
	const {snapshot, problems} = await deliver([
		{
			type: 'preflight',
			inputMonitoring: 'granted',
			message: 'Input Monitoring is granted.',
		},
	]);

	t.is(snapshot, undefined, 'no Activity, so no Flush was attempted');
	t.deepEqual(problems, []);
});

test('the helper’s failure line reaches the reporter and no Collector', async t => {
	const {snapshot, problems} = await deliver([FAILURE]);

	t.deepEqual(problems, [{kind: 'error-line', error: FAILURE}]);
	t.is(snapshot, undefined, 'and there is nothing in it to count');
});

/*
A store that cannot be written — a full disk, a file that went away — as the
Session sees one: a Flush that writes nothing and leaves Telemetry State alone
to be retried.
*/
const FAILING_STORE: RunStore = {
	flush(): Date | undefined {
		return undefined;
	},
	/*
	A store that writes nothing still reads: the two faces are one file, and a
	read is not what this store is standing in for.
	*/
	load(): LoadResult {
		return {ok: true, data: data()};
	},
	backlog(): readonly Era[] {
		return [];
	},
	markPushed() {
		// Nothing is in the backlog, so nothing is ever acknowledged.
	},
	close() {
		// Nothing to release.
	},
};

/*
Countered by the success case above, which must *not* set it. A shell reads the
exit code, so a lost final Flush has to reach it rather than only the log.
*/
test('a failed final Flush exits non-zero, because the counters are lost', async t => {
	const test_ = harness(granted());
	test_.options.state?.addLeftClick();

	const previous = process.exitCode;
	try {
		const running = run(
			{kind: 'collect'},
			{
				...test_.options,
				createStore: () => FAILING_STORE,
			},
		);
		test_.shutdown.fire('SIGTERM');
		await running;

		t.is(process.exitCode, 1);
		t.regex(test_.logger.warnings.at(-1) ?? '', /lost|failed/v);
	} finally {
		process.exitCode = previous;
	}
});

test('collect names the signal it stopped on', async t => {
	const test_ = harness(granted());

	const running = run({kind: 'collect'}, test_.options);
	test_.shutdown.fire('SIGINT');
	await running;

	t.regex(test_.logger.lines.at(-1) ?? '', /SIGINT/v);
});

test('permissions reports the grant and collects nothing', async t => {
	const test_ = harness(denied());

	await run({kind: 'permissions'}, test_.options);

	t.is(test_.permissions.calls.length, 1);
	t.is(test_.store.snapshots.length, 0);
	t.is(test_.store.closed, 0);
});

/*
The dashboard path is the one that mounts ink, so these assert the contract
around it rather than the view: which sources the caller's are, that they are
released on the way out, and that the run behind them starts and stops with the
view.

`renderApp` returns immediately in every case here, which is what a `q` looks
like from `main`'s side — the view comes down, and the composition root is what
tells the run to stop.
*/
test('the dashboard renders through the supplied sources, and stops the run', async t => {
	const test_ = harness(granted());
	const rendered: DashboardView[] = [];
	let atRender: Date | undefined;
	test_.options.state?.addLeftClick();
	// Before the run is asked for, so the start it reports can be shown to be
	// this run's rather than an import-time value or the drawing's own.
	const before = new Date();

	await run(
		{kind: 'dashboard'},
		{
			...test_.options,
			async renderApp(view) {
				atRender = new Date();
				rendered.push(view);
			},
		},
	);

	/*
	The view reads the store the Flush wrote, rather than a reader opened
	beside it — which is the whole of ADR-0012's read side, and the one thing
	this assertion can say about it.
	*/
	t.deepEqual(
		rendered.map(view => view.history),
		[test_.store],
		'the store is what the history view reads',
	);
	t.is(rendered[0]?.timeZone, 'Europe/London', 'the zone comes from Config');

	/*
	The start the live view reports: this run's own, read where the run begins
	rather than stamped at module load — it falls inside the window this test was
	running for, and before the frame that draws it.
	*/
	const startedAt = rendered[0]?.startedAt;
	t.true(
		startedAt !== undefined &&
			atRender !== undefined &&
			before <= startedAt &&
			startedAt <= atRender,
		'the start is this run’s, and it precedes the frame',
	);
	/*
	The dashboard collects, and the view coming down is what ends the run — `q`
	never generates a signal, so nothing else would.
	*/
	t.is(test_.collectors[0]?.started, 1);
	t.is(test_.collectors[0]?.stopped, 1);
	t.is(test_.store.snapshots.length, 1, 'the final Flush happened anyway');
	t.is(test_.store.closed, 1, 'closed even though rendering returned');
	t.deepEqual(test_.logger.lines, ['Stopped.']);
});

/*
The dashboard asks the same question `collect` does. It is not only for the
Collectors: the report is what lets the live view tell a machine nobody has
touched from a machine with no grant, which is the distinction the view exists
to draw.
*/
test('a missing grant reaches the live view as a disabled reading', async t => {
	const test_ = harness(denied());
	const readings: LiveTelemetry[] = [];

	await run(
		{kind: 'dashboard'},
		{
			...test_.options,
			async renderApp(view) {
				readings.push(view.telemetry.read());
			},
		},
	);

	t.is(test_.permissions.calls.length, 1, 'the dashboard preflights');
	t.deepEqual(readings, [
		{
			status: 'disabled',
			message: 'Input Monitoring is denied for this helper.',
		},
	]);
});

/*
The wiring between the run and the view, which neither module's own test can
see: the Session reports each Flush attempt and the source is what hears about
it. Without it the dashboard draws counters that never move.

Read after the run rather than during it, so the final Flush has landed — and
landed means it cleared Telemetry State. The store is the harness's, which
writes, so whether the Flush reached storage is not in question here; the click
below is therefore in the reading at all only because the source folded that
Flush in. That is what makes this one number the whole assertion.
*/
test('a Flush is counted into the live totals', async t => {
	const test_ = harness(granted());
	let telemetry: TelemetrySource | undefined;
	test_.options.state?.addLeftClick();

	await run(
		{kind: 'dashboard'},
		{
			...test_.options,
			async renderApp(view) {
				telemetry = view.telemetry;
			},
		},
	);

	t.deepEqual(totalsOf(telemetry?.read()), {
		leftClicks: 1,
		rightClicks: 0,
		movementMeters: 0,
		pressTotal: 0,
	});
});

function totalsOf(reading: LiveTelemetry | undefined): Totals | undefined {
	return reading?.status === 'collecting' ? reading.totals : undefined;
}

/*
The Run Log's two ends, which neither module's own test can see: the Session
reports each Flush attempt, and the composition root is what turns one into an
entry. Dashboard mode, over the factory the composition root builds when none
was given — so the counts in an entry are the ones the Collectors collected,
through the stream that factory built and wired.

The entries are read back from the source the *view* was handed rather than from
one the test supplied, so a Run Log the view does not share with the session
fails here instead of drawing an empty block forever.
*/
type Logged = {
	readonly entries: readonly RunLogEntry[];
	readonly state: TelemetryState;
	/*
	What delivering the events wrote to the terminal. A dashboard run writes
	nothing, which is the half of the contract a Run Log entry cannot show: a
	`[eventtap]` line printed once the frame is up corrupts the drawing.
	*/
	readonly stderr: readonly string[];
};

async function logged(
	events: readonly RawEvent[],
	store?: RunStore,
): Promise<Logged> {
	const test_ = harness(granted());
	const stream = new FakeStream();
	const state = new TelemetryState();
	let runLog: RunLogSource | undefined;

	const running = run(
		{kind: 'dashboard'},
		{
			...withoutFactory(test_.options),
			...(store && {createStore: () => store}),
			state,
			createStream: () => stream,
			requestInputMonitoring: noGrantRequest,
			async renderApp(view) {
				runLog = view.runLog;
				/*
				What `tui.tsx` does: the frame stays up until the run ends, and
				the Run Log is read once it has — so the final Flush has landed.
				*/
				await view.ended;
			},
		},
	);

	await stream.started;
	// Held across the delivery rather than the run: `handle` and the reporter it
	// ends in are synchronous, so this window is the whole of what a run writes
	// as the events arrive, and nothing else's.
	const stderr = captureStderr(() => {
		for (const event of events) {
			stream.emit(event);
		}
	});

	test_.shutdown.fire('SIGINT');
	await running;

	return {entries: runLog?.read() ?? [], state, stderr};
}

/*
A Flush that wrote, as an entry: the three counts the Flush carried, in the
spellings the totals above the block use. Nothing is counted by hand here — the
events go in through the helper's own stream and come out of the log.
*/
test('a Flush that landed is an entry with the counts it wrote', async t => {
	const {entries} = await logged([
		keyEventAt('keyDown', A_KEY, BARE),
		// One inch at the configured DPI, in ten steps of a tenth of it: a
		// distance needs two points, and the first move is the baseline.
		{type: 'mouseMoved', timestampNs: 0, x: 0, y: 0},
		{type: 'mouseMoved', timestampNs: 0, x: CONFIG.mouseDpi * 10, y: 0},
		{type: 'mouseDown', timestampNs: 0, x: 0, y: 0, button: 'left'},
	]);

	t.is(entries.length, 1);
	const [entry] = entries;
	t.is(entry?.class, 'Flush');
	t.is(entry?.failed, undefined);
	t.is(entry?.summary, 'Clicks 1 · Mouse Distance 0.3 m · Press Total 1');
});

/*
The failure the block exists for, and the reason its line says the write is
coming back: the counters were never cleared, so the same Snapshot is retried on
the next Flush Interval (ADR-0009).
*/
test('a Flush that failed is an entry that will retry, with the counters still held', async t => {
	/*
	The counters never made it, so the run ends non-zero and sets the exit code
	— which ava's worker reads when it exits. Left set, it would end this file
	non-zero with every test in it passing.
	*/
	const previous = process.exitCode;
	try {
		const {entries, state} = await logged(
			[keyEventAt('keyDown', A_KEY, BARE)],
			FAILING_STORE,
		);

		t.is(entries.length, 1);
		t.is(entries[0]?.class, 'Flush');
		t.true(entries[0]?.failed === true, 'which is what draws it red');
		t.is(entries[0]?.summary, 'failed — will retry');
		t.true(
			state.hasActivity(),
			'left whole, so the Flush is retried rather than lost',
		);
	} finally {
		process.exitCode = previous;
	}
});

/*
A Flush is attempted only when there was Activity, so the log lists attempts and
not intervals: an idle run records nothing, which is what keeps the block from
filling with lines about writes that never happened.
*/
test('an interval with no Activity is not an entry', async t => {
	const {entries} = await logged([]);

	t.deepEqual(entries, []);
});

/*
The other half of what the block is for, and the half a terminal cannot show
once the frame is up: the helper's failure line is an entry rather than a
`[eventtap]` warning printed into the middle of the drawing.

Both halves are asserted together on purpose. An entry *and* the warning would
be the same failure reported twice, and only the pair of assertions can tell
that from the one report this is meant to be.
*/
test('the helper’s failure line is an entry, and nothing goes to stderr', async t => {
	const {entries, stderr} = await logged([FAILURE]);

	t.deepEqual(
		stderr,
		[],
		'the entry is the report, and there is not a second one',
	);
	t.is(entries.length, 1);
	t.is(entries[0]?.class, 'Helper');
	t.true(entries[0]?.failed === true, 'which is what draws it red');
	t.is(entries[0]?.summary, FAILURE.message);
});

/*
The two problems no event carries: a line of stdout that would not parse, and a
helper that has exited. They are the stream's own, so the factory hands the
stream it builds the reporter they go to — and this is that wiring, driven
through a stand-in that reports them the way the real stream does, without a
capture process behind it.
*/
test('an unreadable line and a helper exit are entries too', async t => {
	const test_ = harness(granted());
	const stream = new FakeStream();
	const runLog = new InProcessRunLogSource();
	let report: ((problem: StreamProblem) => void) | undefined;

	const running = run(
		{kind: 'dashboard'},
		{
			...withoutFactory(test_.options),
			runLog,
			createStream({onProblem}) {
				report = onProblem;
				return stream;
			},
			requestInputMonitoring: noGrantRequest,
			async renderApp(view) {
				await view.ended;
			},
		},
	);

	await stream.started;
	report?.({kind: 'unreadable-line', line: 'not an event'});
	report?.({kind: 'exited', code: 1, signal: undefined});
	test_.shutdown.fire('SIGINT');
	await running;

	t.deepEqual(
		runLog.read().map(entry => [entry.class, entry.summary]),
		[
			['Helper', 'unreadable line on stdout: not an event'],
			[
				'Helper',
				'the capture helper exited (code 1); input is no longer being collected.',
			],
		],
	);
});

/*
The read seam's report, which has one thing in it now that the read is local: a
read that failed is one line in the log rather than a driver sentence drawn
across the frame.

The store is the caller's own, reporting through the reporter the composition
root handed it — the arrangement the delivery tests above use for the helper's
stream, and for the same reason: the real store is a file, and what has to be
exercised is the routing rather than the read. The report is raised from the
renderer's own `load`, because that is what the view does during render and the
store is the composition root's.
*/
async function entriesFromRead(
	result: LoadResult,
	...warnings: readonly ReadWarning[]
): Promise<readonly RunLogEntry[]> {
	const test_ = harness(granted());
	const runLog = new InProcessRunLogSource();
	test_.store.readResult = result;
	test_.store.readWarnings = warnings;

	await run(
		{kind: 'dashboard'},
		{
			...test_.options,
			runLog,
			async renderApp(view) {
				view.history.load('today', new Date());
			},
		},
	);

	return runLog.read();
}

test('a failed history read is an entry carrying the driver’s message', async t => {
	const entries = await entriesFromRead(
		{ok: false, message: 'connect ECONNREFUSED'},
		{error: new Error('connect ECONNREFUSED')},
	);

	t.is(entries.length, 1);
	t.is(entries[0]?.class, 'History');
	t.true(entries[0]?.failed === true, 'which is what draws it red');
	t.is(
		entries[0]?.summary,
		'connect ECONNREFUSED',
		'which the view used to draw in the middle of the frame',
	);
});

/*
A read that answered reports nothing, which is the half of the contract a
quiet machine needs: an entry per successful read would fill the six-line block
with news that nothing had gone wrong.
*/
test('a read that answered is not an entry', async t => {
	t.deepEqual(await entriesFromRead({ok: true, data: data()}), []);
});

/*
One command over, the same problem is still a line on the terminal. This is the
contract the change must not break, and the composition root is where it could
be broken: the reporter is chosen per mode, and a default applied in the wrong
place would take `collect`'s diagnostics away from a headless run.
*/
test('collect still prints helper problems to stderr', async t => {
	const test_ = harness(granted());
	const stream = new FakeStream();
	const runLog = new InProcessRunLogSource();

	const running = run(
		{kind: 'collect'},
		{
			...withoutFactory(test_.options),
			runLog,
			createStream: () => stream,
			requestInputMonitoring: noGrantRequest,
		},
	);

	await stream.started;
	const written = captureStderr(() => {
		stream.emit(FAILURE);
	});

	test_.shutdown.fire('SIGINT');
	await running;

	t.deepEqual(written, [`[eventtap] ${FAILURE.message}\n`]);
	t.deepEqual(
		runLog.read(),
		[],
		'a headless run reports through the terminal and its exit code',
	);
});

/*
One failure, one report — the half of the contract a headless run has.

The Session and the write seam both used to warn about the same failed Flush, so
a mid-run failure was said twice before anything else got to it, and the
deletion of both had to leave `collect` a warning it can still read (ADR-0010).
What is asserted is the whole of the warnings, so a report from the store, from
the Session or from anywhere else fails here as the second one it would be.

The Flush Interval is milliseconds and the store fails exactly once, so the
failure under test is an interval's and the final Flush lands: the run ends
cleanly, and nothing about a lost counter is mixed into what is counted here.
*/
test('collect warns once for a failed Flush, from the attempt itself', async t => {
	const test_ = harness(granted());
	const store = new FakeStore(1);
	test_.options.state?.addLeftClick();

	const running = run(
		{kind: 'collect'},
		{
			...test_.options,
			createStore: () => store,
			config: {...CONFIG, flushIntervalSeconds: 0.005},
		},
	);

	await until(
		() => test_.logger.warnings.length > 0,
		'the failed interval Flush',
	);
	test_.shutdown.fire('SIGTERM');
	await running;

	t.deepEqual(test_.logger.warnings, [
		'Flush failed; counters will retry on the next Flush',
	]);
	t.deepEqual(
		store.snapshots.map(snapshot => snapshot['leftClicks']),
		[1],
		'and the same counters were written by the retry',
	);
});

/*
A failed Flush mid-run, with a frame up — the claim the whole change rests on,
and the one place it can be checked end to end.

The store fails an interval's Flush on a run that is drawing, and the retry
after it lands, so both entries are the run's own doing. Nothing writes to
stderr for any of it: the Session has no logger to write with any more and the
store reports a failure as its return value, which leaves the entry as the one
report — and a `console.warn` left anywhere on the path would show up here as
the second one it would be (ADR-0010).

The window is the run rather than a call, because that is when a frame is up.
*/
test('a dashboard reports a failed Flush once, and writes nothing to stderr', async t => {
	const test_ = harness(granted());
	const runLog = new InProcessRunLogSource();
	const state = new TelemetryState();
	state.addLeftClick();

	const watch = watchStderr();
	try {
		await run(
			{kind: 'dashboard'},
			{
				...withoutFactory(test_.options),
				createStore: () => new FakeStore(1),
				runLog,
				state,
				config: {...CONFIG, flushIntervalSeconds: 0.005},
				createStream: () => new FakeStream(),
				requestInputMonitoring: noGrantRequest,
				async renderApp(view) {
					await until(
						() => runLog.read().some(entry => entry.failed === true),
						'the failed interval Flush',
					);
					test_.shutdown.fire('SIGINT');
					await view.ended;
				},
			},
		);
	} finally {
		watch.restore();
	}

	t.deepEqual(watch.written, [], 'the frame is the only output');
	const entries = runLog.read();
	t.deepEqual(
		entries.map(entry => [entry.class, entry.failed === true]),
		[
			['Flush', true],
			['Flush', false],
		],
		'the failure, and the retry that wrote the same counters',
	);
});

/*
The helper's own diagnostics, which are the one thing on a run that reaches the
terminal without anyone asking for it.

Both modes are asserted together because the change is a redirection rather than
a silencing: a dashboard that stopped the chatter by stopping it everywhere
would pass the first assertion and fail the second, and a `collect` run would
have lost the tap's notes without anyone deciding it should (ADR-0010).
*/
async function sinksFor(kind: 'collect' | 'dashboard'): Promise<StreamSinks> {
	const test_ = harness(granted());
	const stream = new FakeStream();
	let sinks: StreamSinks | undefined;

	test_.shutdown.fire('SIGINT');

	await run(
		{kind},
		{
			...withoutFactory(test_.options),
			createStream(where) {
				sinks = where;
				return stream;
			},
			requestInputMonitoring: noGrantRequest,
			async renderApp(view) {
				await view.ended;
			},
		},
	);

	if (sinks === undefined) {
		throw new Error('the factory built no stream');
	}

	return sinks;
}

test('a dashboard sends the helper’s stderr nowhere, and collect sends it to the terminal', async t => {
	const dashboard = await sinksFor('dashboard');
	const collect = await sinksFor('collect');

	t.deepEqual(
		captureStderr(() => {
			dashboard.onHelperStderr('banner\n');
		}),
		[],
		'nothing may write to stderr while the frame is up',
	);
	t.deepEqual(
		captureStderr(() => {
			collect.onHelperStderr('banner\n');
		}),
		['banner\n'],
		'and a headless run still reads what the helper said',
	);
});

/*
The write seam's warning, which is the one report a run can make that is not a
Flush: the TTL index the store asks the server for as it is built, and cannot
always have.

It is raised through the logger the store was built with, so what becomes of it
is the composition root's decision and not the store's — an entry under a frame,
a line on the terminal without one. The store is the harness's own here and the
warning is raised while the frame is up, because the routing is what is under
test; the real seam's half of it, that a TTL index it could not create is a
warning at all, is `push.test.ts`'s.
*/
test('the write seam’s warning is an entry in dashboard mode, and not a line on stderr', async t => {
	const test_ = harness(granted());
	const runLog = new InProcessRunLogSource();
	let written: readonly string[] = [];

	await run(
		{kind: 'dashboard'},
		{
			...test_.options,
			runLog,
			async renderApp(view) {
				written = captureStderr(() => {
					test_.pushLoggers[0]?.warn(
						'Failed to create TTL index on telemetry',
						new Error('not authorized'),
					);
				});

				/*
				The frame comes down when the run ends, so the signal is what
				ends it — and it is raised after the warning, so the warning is
				made while there is a frame to keep whole.
				*/
				test_.shutdown.fire('SIGINT');
				await view.ended;
			},
		},
	);

	t.deepEqual(written, [], 'the frame is the only output');
	t.deepEqual(
		runLog.read().map(entry => [entry.class, entry.summary]),
		[['Storage', 'Failed to create TTL index on telemetry']],
	);
	t.regex(
		runLog.read()[0]?.detail ?? '',
		/not authorized/v,
		'and the driver’s own error is kept in the full text',
	);
});

/*
The other half of the same decision, and the reason it cannot be made by
silencing the store: a headless run has no frame to draw an entry in, so its
warnings keep going where they have always gone.
*/
test('collect keeps the write seam’s warning on stderr', async t => {
	const test_ = harness(granted());
	const runLog = new InProcessRunLogSource();

	test_.shutdown.fire('SIGINT');
	await run({kind: 'collect'}, {...test_.options, runLog});

	t.deepEqual(
		captureStderr(() => {
			test_.pushLoggers[0]?.warn('Failed to create TTL index on telemetry');
		}),
		['Failed to create TTL index on telemetry\n'],
	);
	t.deepEqual(
		runLog.read(),
		[],
		'and nothing appends an entry no view would ever draw',
	);
});

/*
A run that starts with no grant says so in the log, which is the whole point of
the entry: the dashboard lands on the history view, and the live view's own
report is behind a key press.

The view's report is asserted here rather than left to the test above it,
because "an entry as well" and "an entry instead" are the two ways this could
have gone and only one of them leaves the disabled state explained in full.
*/
test('a missing grant is one entry on a run that never starts', async t => {
	const test_ = harness(denied());
	const runLog = new InProcessRunLogSource();
	let reading: LiveTelemetry | undefined;

	test_.shutdown.fire('SIGTERM');

	await run(
		{kind: 'dashboard'},
		{
			...withoutFactory(test_.options),
			runLog,
			createStream() {
				throw new Error('a denied grant builds no stream');
			},
			requestInputMonitoring() {
				// Stubbed: the real one asks macOS, and nobody is at this keyboard.
			},
			async renderApp(view) {
				reading = view.telemetry.read();
			},
		},
	);

	const entries = runLog.read();
	t.is(entries.length, 1, 'one grant, so one entry');
	t.is(entries[0]?.class, 'Collection');
	t.is(
		entries[0]?.failed,
		undefined,
		'a Collector the grant took out is not a failure (CONTEXT.md)',
	);
	t.regex(
		entries[0]?.summary ?? '',
		/Mouse and Keyboard collection is disabled: Input Monitoring is denied\./v,
	);
	t.is(
		entries[0]?.detail,
		'mouse off\nkeyboard off',
		'and the detail is the preflight’s own notes, which say where to grant it',
	);
	t.deepEqual(
		reading,
		{
			status: 'disabled',
			message: 'Input Monitoring is denied for this helper.',
		},
		'the live view draws the same report it always did',
	);
});

/*
`collect` records too, and there is no view to read it from — which is why the
composition root takes a Run Log as an option at all.
*/
test('collect records its Flush attempts as well', async t => {
	const test_ = harness(granted());
	const runLog = new InProcessRunLogSource();
	test_.options.state?.addLeftClick();

	const running = run({kind: 'collect'}, {...test_.options, runLog});
	test_.shutdown.fire('SIGINT');
	await running;

	const entries = runLog.read();
	t.is(entries.length, 1);
	t.regex(entries[0]?.summary ?? '', /Clicks 1/v);
});

/*
A quit is not the only way out of the dashboard, and the store must be closed on
the way out of all of them — an open file holds the process, and it is the same
file the view was reading.
*/
test('the store is closed even when rendering throws', async t => {
	const test_ = harness(granted());

	await t.throwsAsync(
		run(
			{kind: 'dashboard'},
			{
				...test_.options,
				async renderApp() {
					throw new Error('no tty');
				},
			},
		),
		{message: 'no tty'},
	);

	t.is(test_.store.closed, 1, 'the store the view was reading, closed once');
});

/*
The Local Store's fail-fast rule, which is the whole of ADR-0012's order: it is
the one write a Flush is required to reach, so a run that cannot open it ends at
startup rather than collecting for hours into a retry that can never succeed.

Before the preflight, which is what makes it quiet as well as early: no helper is
asked, and no frame is drawn over the store's own sentence.
*/
for (const kind of ['collect', 'dashboard'] as const) {
	test(`a store that cannot be opened ends a ${kind} run before the preflight`, async t => {
		const test_ = harness(granted());
		let rendered = 0;

		await t.throwsAsync(
			run(
				{kind},
				{
					...test_.options,
					createStore() {
						throw new Error(
							'Could not open the Local Store at /tmp/telemetry.db: file is not a database',
						);
					},
					async renderApp() {
						rendered += 1;
					},
				},
			),
			{message: /file is not a database/v},
		);

		t.deepEqual(test_.permissions.calls, [], 'nothing was asked of the helper');
		t.is(rendered, 0, 'and nothing was drawn');
	});
}

/*
The other side of the same order. A run that opened the store and then could not
get as far as the preflight — a helper that cannot be asked is a broken install —
still has a file open, and closing it is not the Session's to do: there is no
Session yet.
*/
test('a store already opened is closed when the preflight cannot answer', async t => {
	const test_ = harness(granted());
	test_.permissions.failWith = new Error(
		'the helper printed no permission report',
	);

	await t.throwsAsync(run({kind: 'collect'}, test_.options), {
		message: 'the helper printed no permission report',
	});

	t.is(test_.store.closed, 1);
	t.is(test_.pusher.closed, 1, 'and the Push went with it');
});

/*
The composition root's half of the Push: the store is what a Drain reads, so the
Pusher is built over the store itself and not over a copy of it, and it closes
with everything else on the way out.
*/
test('the Push is built over the store, and closed with the run', async t => {
	const test_ = harness(granted());
	test_.options.state?.addLeftClick();

	const running = run({kind: 'collect'}, test_.options);
	test_.shutdown.fire('SIGINT');
	await running;

	t.is(test_.pusher.backlogs[0], test_.store, 'the store is the Push Backlog');
	t.true(test_.pusher.drains > 0, 'and the run asked for a Drain');
	t.is(test_.store.closed, 1);
	t.is(test_.pusher.closed, 1);
});

/*
A Collector that cannot start is a broken install rather than a missing grant,
so it still reaches the caller — through the view's lifetime rather than in
spite of it.
*/
test('a Collector that throws on start stops the dashboard and propagates', async t => {
	const test_ = harness(granted());

	await t.throwsAsync(
		run(
			{kind: 'dashboard'},
			{
				...test_.options,
				collectors: () => ({
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
				}),
				async renderApp(view) {
					/*
					What `tui.tsx` does: the view stays up until the run ends, and
					the run has already ended badly here.
					*/
					await view.ended;
				},
			},
		),
		{message: 'no tap'},
	);

	t.is(
		test_.store.closed,
		1,
		'closed on the way out of a run that ended badly',
	);
});

function data(): HistoryData {
	return {
		range: 'today',
		timeZone: 'Europe/London',
		totals: {
			leftClicks: 0,
			rightClicks: 0,
			movementMeters: 0,
			pressTotal: 0,
		},
		keyRanking: [],
		timeSeries: [],
	};
}
