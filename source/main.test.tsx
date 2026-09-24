import process from 'node:process';
import test from 'ava';
import {type Config} from './config.js';
import {
	type HistoryData,
	type HistorySource,
	type LoadResult,
	type ReadWarning,
	type ReadWarningReporter,
	type Totals,
} from './history.js';
import {
	type CollectorFactory,
	type DashboardView,
	type Logger,
	type RunOptions,
	run,
} from './main.js';
import {type StreamProblem} from './helper.js';
import {KeyboardCollector} from './keyboard.js';
import {type PermissionReport, type PermissionSource} from './permissions.js';
import {type HelperError, keyEventAt, type RawEvent} from './raw-event.js';
import {
	InProcessRunLogSource,
	type RunLogEntry,
	type RunLogSource,
} from './run-log.js';
import {
	type Collector,
	type EventStream,
	type ShutdownReason,
	type ShutdownSignal,
} from './session.js';
import {TelemetryState} from './state.js';
import {type FlushResult, type TelemetryStore} from './storage.js';
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

class FakeStore implements TelemetryStore {
	readonly snapshots: Array<Record<string, unknown>> = [];
	closed = 0;

	async flush(snapshot: never): Promise<FlushResult> {
		this.snapshots.push(snapshot);
		return ['id'];
	}

	async close(): Promise<void> {
		this.closed += 1;
	}
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

	constructor(report: PermissionReport) {
		this.#report = report;
	}

	async preflight(): Promise<PermissionReport> {
		this.calls.push(this.calls.length);
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
	readonly logger: ReturnType<typeof logger>;
	readonly reports: PermissionReport[];
	readonly collectors: Array<ReturnType<typeof collector>>;
};

function harness(report: PermissionReport): Harness {
	const permissions = new FakePermissions(report);
	const shutdown = new FakeShutdownSignal();
	const store = new FakeStore();
	const lines = logger();
	const reports: PermissionReport[] = [];
	const collectors: Array<ReturnType<typeof collector>> = [];

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
		logger: lines,
		reports,
		collectors,
		options: {
			permissions,
			shutdown,
			store,
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
A database that has gone away, as the Session sees one: a Flush that writes
nothing and leaves Telemetry State alone to be retried.
*/
const FAILING_STORE: TelemetryStore = {
	async flush(): Promise<FlushResult> {
		return undefined;
	},
	async close(): Promise<void> {
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
				store: FAILING_STORE,
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
function stubHistory(closed: number[] = []): HistorySource {
	return {
		async load(): Promise<LoadResult> {
			return {ok: true, data: data()};
		},
		async close(): Promise<void> {
			closed.push(1);
		},
	};
}

test('the dashboard renders through the supplied sources, and stops the run', async t => {
	const test_ = harness(granted());
	const closed: number[] = [];
	const source = stubHistory(closed);
	const rendered: DashboardView[] = [];
	test_.options.state?.addLeftClick();

	await run(
		{kind: 'dashboard'},
		{
			...test_.options,
			createHistorySource: () => source,
			async renderApp(view) {
				rendered.push(view);
			},
		},
	);

	t.deepEqual(
		rendered.map(view => view.history),
		[source],
		'the caller supplies the source, not Mongo',
	);
	t.is(rendered[0]?.timeZone, 'Europe/London', 'the zone comes from Config');
	t.deepEqual(closed, [1], 'closed even though rendering returned');

	/*
	The dashboard collects, and the view coming down is what ends the run — `q`
	never generates a signal, so nothing else would.
	*/
	t.is(test_.collectors[0]?.started, 1);
	t.is(test_.collectors[0]?.stopped, 1);
	t.is(test_.store.snapshots.length, 1, 'the final Flush happened anyway');
	t.is(test_.store.closed, 1);
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
			createHistorySource: () => stubHistory(),
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
			createHistorySource: () => stubHistory(),
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
	store?: TelemetryStore,
): Promise<Logged> {
	const test_ = harness(granted());
	const stream = new FakeStream();
	const state = new TelemetryState();
	let runLog: RunLogSource | undefined;

	const running = run(
		{kind: 'dashboard'},
		{
			...withoutFactory(test_.options),
			...(store && {store}),
			state,
			createStream: () => stream,
			requestInputMonitoring: noGrantRequest,
			createHistorySource: () => stubHistory(),
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
			createStream(onProblem) {
				report = onProblem;
				return stream;
			},
			requestInputMonitoring: noGrantRequest,
			createHistorySource: () => stubHistory(),
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
The read seam's entries, and the other half of the change to the history view:
a read that failed is one line in the log rather than a driver sentence drawn
across the frame, and a bucket the boundaries never named is one too.

The source is the caller's own, reporting through the reporter it was handed
the way the real one does — the arrangement the delivery tests above use for
the helper's stream, and for the same reason: the real source opens a
connection, and what has to be exercised is the routing rather than the read.
*/
function reportingHistory(
	result: LoadResult,
	...warnings: readonly ReadWarning[]
): (onWarning: ReadWarningReporter) => HistorySource {
	return onWarning => ({
		async load(): Promise<LoadResult> {
			for (const warning of warnings) {
				onWarning(warning);
			}

			return result;
		},
		async close(): Promise<void> {
			// Nothing to release: the stand-in holds no connection.
		},
	});
}

/*
What the seam's warnings come to once a dashboard run has had them: the entries
the view was handed, read back after the run so the final Flush has landed.

`load` is driven from the renderer because that is what the view does on mount,
and the source is the composition root's — so this is the only way a test can
reach the reporter it gave that source.
*/
async function entriesFromRead(
	createHistorySource: (onWarning: ReadWarningReporter) => HistorySource,
): Promise<readonly RunLogEntry[]> {
	const test_ = harness(granted());
	const runLog = new InProcessRunLogSource();

	await run(
		{kind: 'dashboard'},
		{
			...test_.options,
			runLog,
			createHistorySource,
			async renderApp(view) {
				await view.history.load('today', new Date());
			},
		},
	);

	return runLog.read();
}

test('a failed history read is an entry carrying the driver’s message', async t => {
	const entries = await entriesFromRead(
		reportingHistory(
			{ok: false, message: 'connect ECONNREFUSED'},
			{
				kind: 'failed-read',
				error: new Error('connect ECONNREFUSED'),
			},
		),
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
A read that answered, with one bucket the boundaries never named. Nothing
failed and the dashboard drew, so it is an entry rather than a failure — the
point of it is that the reader drops the bucket loudly rather than in silence.
*/
test('a read that ignored a bucket is an entry, and not a failure', async t => {
	const entries = await entriesFromRead(
		reportingHistory(
			{ok: true, data: data()},
			{
				kind: 'ignored-buckets',
				buckets: ['default'],
			},
		),
	);

	t.is(entries.length, 1);
	t.is(entries[0]?.class, 'History');
	t.is(entries[0]?.failed, undefined);
	t.is(
		entries[0]?.summary,
		'Ignored 1 time series bucket(s) outside the range boundaries',
	);
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
			createHistorySource: () => stubHistory(),
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
A quit is not the only way out of the dashboard, and the source must be closed
on the way out of all of them — a `MongoClient` left open holds the process.
*/
test('the history source is closed even when rendering throws', async t => {
	const test_ = harness(granted());
	const closed: number[] = [];

	await t.throwsAsync(
		run(
			{kind: 'dashboard'},
			{
				...test_.options,
				createHistorySource: () => stubHistory(closed),
				async renderApp() {
					throw new Error('no tty');
				},
			},
		),
		{message: 'no tty'},
	);

	t.deepEqual(closed, [1]);
	t.is(test_.store.closed, 1, 'and the run behind it was stopped');
});

/*
A Collector that cannot start is a broken install rather than a missing grant,
so it still reaches the caller — through the view's lifetime rather than in
spite of it.
*/
test('a Collector that throws on start stops the dashboard and propagates', async t => {
	const test_ = harness(granted());
	const closed: number[] = [];

	await t.throwsAsync(
		run(
			{kind: 'dashboard'},
			{
				...test_.options,
				createHistorySource: () => stubHistory(closed),
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

	t.deepEqual(closed, [1]);
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
