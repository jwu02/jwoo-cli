import process from 'node:process';
import test from 'ava';
import {type Config} from './config.js';
import {
	type HistoryData,
	type HistorySource,
	type LoadResult,
} from './history.js';
import {
	type CollectorFactory,
	type Logger,
	type RunOptions,
	run,
} from './main.js';
import {KeyboardCollector} from './keyboard.js';
import {type PermissionReport, type PermissionSource} from './permissions.js';
import {keyEventAt} from './raw-event.js';
import {
	type Collector,
	type EventStream,
	type ShutdownReason,
	type ShutdownSignal,
} from './session.js';
import {TelemetryState} from './state.js';
import {type FlushResult, type TelemetryStore} from './storage.js';

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
twice.
*/
const BARE = 256;

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

Deliberately not reached through `options.stream`. That option exists so a test
can avoid a capture process, and going through it would test the arrangement the
tests use rather than the one the CLI does.
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
Countered by the success case above, which must *not* set it. A shell reads the
exit code, so a lost final Flush has to reach it rather than only the log.
*/
test('a failed final Flush exits non-zero, because the counters are lost', async t => {
	const test_ = harness(granted());
	test_.options.state?.addLeftClick();
	const failing: TelemetryStore = {
		async flush(): Promise<FlushResult> {
			return undefined;
		},
		async close(): Promise<void> {
			// Nothing to release.
		},
	};

	const previous = process.exitCode;
	try {
		const running = run({kind: 'collect'}, {...test_.options, store: failing});
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
The dashboard path is the one that mounts ink, so this asserts the contract
around it rather than the view: the source is closed on the way out, and it is
the one the caller supplied rather than a `MongoClient` built behind its back.
*/
test('the dashboard renders through the supplied history source and closes it', async t => {
	const test_ = harness(granted());
	const closed: number[] = [];
	const rendered: HistorySource[] = [];
	const source: HistorySource = {
		async load(): Promise<LoadResult> {
			return {ok: true, data: data()};
		},
		async close(): Promise<void> {
			closed.push(1);
		},
	};

	await run(
		{kind: 'dashboard'},
		{
			...test_.options,
			historySource: source,
			async renderApp(passed) {
				rendered.push(passed);
			},
		},
	);

	t.deepEqual(rendered, [source], 'the caller supplies the source, not Mongo');
	t.deepEqual(closed, [1], 'closed even though rendering returned');
	t.is(test_.permissions.calls.length, 0, 'the dashboard does not preflight');
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
				historySource: {
					async load(): Promise<LoadResult> {
						return {ok: true, data: data()};
					},
					async close(): Promise<void> {
						closed.push(1);
					},
				},
				async renderApp() {
					throw new Error('no tty');
				},
			},
		),
		{message: 'no tty'},
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
