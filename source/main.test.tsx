import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import process from 'node:process';
import {DatabaseSync} from 'node:sqlite';
import test, {type ExecutionContext} from 'ava';
import {type Config} from './store/config.js';
import {
	type BackloggedUsage,
	type Era,
	type HistoryData,
	type IngestResult,
	type LoadResult,
	type ReadWarning,
	type ReadWarningReporter,
	type Totals,
	type UsageRecord,
} from './store/local-store.js';
import {
	type CollectorFactory,
	type DashboardView,
	type Logger,
	type RecordUsageOptions,
	type RunOptions,
	type RunStore,
	runBackfillClaude,
	runBackfillOpencode,
	runBackfillPi,
	runCollect,
	runDashboard,
	runPermissions,
	runRecordClaudeHook,
	runRecordOpencode,
	runRecordPi,
	type UsagePush,
	type UsageStore,
} from './main.js';
import {type StreamProblem, type StreamSinks} from './capture/helper.js';
import {KeyboardCollector} from './capture/keyboard.js';
import {
	type PermissionReport,
	type PermissionSource,
} from './capture/permissions.js';
import {type PushAttempt, type PushBacklog} from './store/push.js';
import {type UsagePushBacklog} from './store/usage-push.js';
import {
	type HelperError,
	keyEventAt,
	type RawEvent,
} from './capture/raw-event.js';
import {
	InProcessRunLogSource,
	type RunLogEntry,
	type RunLogSource,
} from './run-log.js';
import {
	type Collector,
	type EventStream,
	type Pusher,
	type Shutdown,
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
	aiUsageCollectionName: 'ai_usage',
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
An era with nothing in it. Only its number matters here: a test that wants a run
to end with a backlog fills the store's `waiting` with these, and what one holds
is a Flush's business rather than this file's.
*/
function era(stamp: number): Era {
	return {
		stamp: new Date(stamp),
		leftClicks: 0,
		rightClicks: 0,
		movementMeters: 0,
		pressTotal: 0,
		keyCounts: {},
	};
}

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
	The Push Backlog, which is a length here and nothing more: what a Drain
	carries is `push.test.ts`'s, and a run that Pushed something here would be
	reaching for Atlas.

	A test that wants a run to end with ground still to make up fills this in.
	*/
	readonly waiting: Era[] = [];
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

	backlog(): readonly Era[] {
		return this.waiting;
	}

	markPushed(): void {
		// Nothing here is ever acknowledged, so nothing ever leaves this list.
	}

	close(): void {
		if (this.closed === 0) {
			this.closed += 1;
		}
	}
}

/*
The Push, standing in. What the composition root has to get right about it is
where it is built from, where its reports go, and that it is closed with
everything else; what a Drain carries is `push.test.ts`'s.

A Drain here reports through the callback the run built it with, the way the
real one does — which is what makes the routing assertable without a server that
is down. What it reports is `pushed`: one era by default, the steady state, and
a test that wants the gathered case says how many.
*/
class FakePusher implements Pusher {
	readonly backlogs: PushBacklog[] = [];
	drains = 0;
	closed = 0;
	onAttempt: ((attempt: PushAttempt) => void) | undefined;
	pushed = 1;
	/*
	A Drain that could not reach MongoDB, as a run against a dead host has. The
	eras it did not carry stay in the backlog, which is the store's to say.
	*/
	failsWith: Error | undefined;

	async drain(): Promise<void> {
		this.drains += 1;

		this.onAttempt?.(
			this.failsWith === undefined
				? {at: new Date(), ok: true, pushed: this.pushed}
				: {at: new Date(), ok: false, pushed: 0, error: this.failsWith},
		);
	}

	/*
	The run's last Push. Nothing here reaches MongoDB, so what it leaves is what
	the store was already holding — which is what the composition root's Shutdown
	report is drawn from, and why the eras a test wants stranded are put in the
	store rather than in this.
	*/
	async settle(): Promise<number> {
		await this.drain();
		return this.backlogs[0]?.backlog().length ?? 0;
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
	/*
	Where each run's Drain attempts were sent, one per run — the same idea as the
	logger above, and the only way to see the mode's routing from outside a run.
	*/
	readonly pushAttempts: Array<(attempt: PushAttempt) => void>;
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
	const pushAttempts: Array<(attempt: PushAttempt) => void> = [];

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
		pushAttempts,
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
			Built the way the real one is, and handed the logger and the attempt
			sink the composition root decided the mode's Push reports go through.
			*/
			createPusher(backlog, pushLogger, onAttempt) {
				pusher.backlogs.push(backlog);
				pusher.onAttempt = onAttempt;
				pushLoggers.push(pushLogger);
				pushAttempts.push(onAttempt);
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

	const running = runCollect(test_.options);
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

	const running = runCollect(test_.options);
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

	const running = runCollect(test_.options);
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

	await runCollect({
		...test_.options,
		collectors(_report, state) {
			const keyboard = new KeyboardCollector({state});
			keyboard.handle(keyEventAt('keyDown', 0, BARE));
			return {collectors: [keyboard]};
		},
	});

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

	await runCollect({
		...test_.options,
		collectors: () => ({collectors: [], stream: tracedStream(trace)}),
	});

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

	await runCollect({
		...withoutFactory(test_.options),
		createStream() {
			streams.push(1);
			return new FakeStream();
		},
		requestInputMonitoring() {
			requests.push(1);
		},
	});

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

	const running = runCollect({
		...withoutFactory(test_.options),
		createStream: () => stream,
		requestInputMonitoring() {
			requests.push(1);
		},
	});

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

	const running = runCollect({
		...withoutFactory(test_.options),
		createStream: () => stream,
		onProblem(problem) {
			problems.push(problem);
		},
		requestInputMonitoring: noGrantRequest,
	});

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
A shell reads the exit code rather than the log, so a lost final Flush has to
reach the value the entry point reads — `cli.tsx` is what turns it into a code,
and this is the half of that a test can hold.
*/
test('a failed final Flush resolves with a Shutdown that says the counters are lost', async t => {
	const test_ = harness(granted());
	test_.options.state?.addLeftClick();

	const running = runCollect({
		...test_.options,
		createStore: () => FAILING_STORE,
	});
	test_.shutdown.fire('SIGTERM');

	const {finalFlush} = await running;

	t.false(finalFlush);
	t.regex(test_.logger.warnings.at(-1) ?? '', /lost|failed/v);
});

test('collect names the signal it stopped on', async t => {
	const test_ = harness(granted());

	const running = runCollect(test_.options);
	test_.shutdown.fire('SIGINT');
	await running;

	t.regex(test_.logger.lines.at(-1) ?? '', /SIGINT/v);
});

test('permissions reports the grant and collects nothing', async t => {
	const test_ = harness(denied());

	await runPermissions(test_.options);

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

	await runDashboard({
		...test_.options,
		async renderApp(view) {
			atRender = new Date();
			rendered.push(view);
		},
	});

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

	await runDashboard({
		...test_.options,
		async renderApp(view) {
			readings.push(view.telemetry.read());
		},
	});

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

	await runDashboard({
		...test_.options,
		async renderApp(view) {
			telemetry = view.telemetry;
		},
	});

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
	/*
	How the run ended, which is the other thing this hands back rather than
	leaves behind: the entry point reads the exit code off it, so a test that
	wants to know what a shell would see asks here.
	*/
	readonly shutdown: Shutdown;
};

async function logged(
	events: readonly RawEvent[],
	store?: RunStore,
): Promise<Logged> {
	const test_ = harness(granted());
	const stream = new FakeStream();
	const state = new TelemetryState();
	let runLog: RunLogSource | undefined;

	const running = runDashboard({
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
	});

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
	const shutdown = await running;

	return {entries: runLog?.read() ?? [], state, stderr, shutdown};
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
	const {entries, state, shutdown} = await logged(
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
	/*
	The counters never made it, so the run did not end cleanly — and says so as
	a value rather than by setting a process-wide code under the test runner.
	*/
	t.false(shutdown.finalFlush);
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

	const running = runDashboard({
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
	});

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

	await runDashboard({
		...test_.options,
		runLog,
		async renderApp(view) {
			view.history.load('today', new Date());
		},
	});

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

	const running = runCollect({
		...withoutFactory(test_.options),
		runLog,
		createStream: () => stream,
		requestInputMonitoring: noGrantRequest,
	});

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

	const running = runCollect({
		...test_.options,
		createStore: () => store,
		config: {...CONFIG, flushIntervalSeconds: 0.005},
	});

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
		await runDashboard({
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
		});
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
async function sinksFor(
	entry: (options: RunOptions) => Promise<unknown>,
): Promise<StreamSinks> {
	const test_ = harness(granted());
	const stream = new FakeStream();
	let sinks: StreamSinks | undefined;

	test_.shutdown.fire('SIGINT');

	await entry({
		...withoutFactory(test_.options),
		createStream(where) {
			sinks = where;
			return stream;
		},
		requestInputMonitoring: noGrantRequest,
		async renderApp(view) {
			await view.ended;
		},
	});

	if (sinks === undefined) {
		throw new Error('the factory built no stream');
	}

	return sinks;
}

test('a dashboard sends the helper’s stderr nowhere, and collect sends it to the terminal', async t => {
	const dashboard = await sinksFor(runDashboard);
	const collect = await sinksFor(runCollect);

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

	await runDashboard({
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
	});

	t.deepEqual(written, [], 'the frame is the only output');
	t.deepEqual(
		runLog.read().map(entry => [entry.class, entry.summary]),
		[['Push', 'Failed to create TTL index on telemetry']],
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
	await runCollect({...test_.options, runLog});

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

	await runDashboard({
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
	});

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

	const running = runCollect({...test_.options, runLog});
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
		runDashboard({
			...test_.options,
			async renderApp() {
				throw new Error('no tty');
			},
		}),
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
for (const [kind, entry] of [
	['collect', runCollect],
	['dashboard', runDashboard],
] as const) {
	test(`a store that cannot be opened ends a ${kind} run before the preflight`, async t => {
		const test_ = harness(granted());
		let rendered = 0;

		await t.throwsAsync(
			entry({
				...test_.options,
				createStore() {
					throw new Error(
						'Could not open the Local Store at /tmp/telemetry.db: file is not a database',
					);
				},
				async renderApp() {
					rendered += 1;
				},
			}),
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

	await t.throwsAsync(runCollect(test_.options), {
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

	const running = runCollect(test_.options);
	test_.shutdown.fire('SIGINT');
	await running;

	t.is(test_.pusher.backlogs[0], test_.store, 'the store is the Push Backlog');
	t.true(test_.pusher.drains > 0, 'and the run asked for a Drain');
	t.is(test_.store.closed, 1);
	t.is(test_.pusher.closed, 1);
});

/*
A Drain that failed, which is what a run against a dead host has: one red entry
per attempt, repeating for as long as the problem lasts, wearing the driver's
own sentence. The Flush entries beside it say the write landed; this one says
the copy did not go anywhere, which is a different thing (ADR-0012).

The attempts are the run's own, reported by the seam the composition root built
and through the sink it handed that seam — so what is under test is the routing,
and not `push.ts`'s half of it.
*/
test('a failed Drain is one red entry in dashboard mode', async t => {
	const test_ = harness(granted());
	const runLog = new InProcessRunLogSource();
	test_.pusher.failsWith = new Error('connect ECONNREFUSED 127.0.0.1');

	await runDashboard({
		...test_.options,
		runLog,
		async renderApp() {
			/*
				The frame comes down here, and the run ends — which is what asks
				for the last Drain, so both attempts the run makes are its own.
				*/
			test_.shutdown.fire('SIGINT');
		},
	});

	const failures = runLog.read();
	t.true(test_.pusher.drains > 0, 'the run really did Drain');
	t.is(
		failures.length,
		test_.pusher.drains,
		'one entry per attempt, and nothing else recorded',
	);
	t.true(
		failures.every(entry => entry.class === 'Push' && entry.failed === true),
		'which is what draws them red',
	);
	t.is(failures[0]?.summary, 'connect ECONNREFUSED 127.0.0.1');
});

/*
The two Drain attempts that are not worth a line, and the one that is. One era
is the steady state, where the Flush's own entry already said what happened; two
or more is a backlog that had stopped moving and has started again, which no
other line in the block would show.

The run's own Drains report one era each, so the entries asserted here are the
hand-driven ones — and "the steady state records nothing" is asserted by the
same list rather than by a second run.
*/
test('a gathered Drain is one plain entry, and a single era is none at all', async t => {
	const test_ = harness(granted());
	const runLog = new InProcessRunLogSource();

	await runDashboard({
		...test_.options,
		runLog,
		async renderApp() {
			const sink = test_.pushAttempts[0];
			sink?.({at: new Date(), ok: true, pushed: 4});
			sink?.({at: new Date(), ok: true, pushed: 1});
			sink?.({at: new Date(), ok: true, pushed: 1234});
			test_.shutdown.fire('SIGINT');
		},
	});

	t.deepEqual(
		runLog.read().map(entry => [entry.class, entry.failed, entry.summary]),
		[
			['Push', undefined, 'Pushed 4 eras'],
			['Push', undefined, 'Pushed 1,234 eras'],
		],
	);
});

/*
A headless run's half of the same decision, and the reason it cannot be made by
handing the seam a logger and hoping: it has no frame to draw an entry in, so
the sentences the entries would have carried go to the terminal instead.

Both sentences are asserted, because "the same sentences" is the whole of what
`collect` promises — a run that printed only the failures would leave a backlog
draining in silence.
*/
test('collect sends the Push seam’s sentences to the terminal', async t => {
	const failed = harness(granted());
	const failedLog = new InProcessRunLogSource();
	failed.pusher.failsWith = new Error('connect ECONNREFUSED 127.0.0.1');
	failed.shutdown.fire('SIGINT');

	const gathered = harness(granted());
	gathered.pusher.pushed = 3;
	gathered.shutdown.fire('SIGINT');

	await runCollect({...failed.options, runLog: failedLog});
	await runCollect(gathered.options);

	t.true(
		failed.logger.warnings.includes('connect ECONNREFUSED 127.0.0.1'),
		'what the block would have drawn red',
	);
	t.true(
		gathered.logger.warnings.includes('Pushed 3 eras'),
		'and what it would have said about a backlog moving again',
	);
	t.deepEqual(
		failedLog.read(),
		[],
		'and nothing appends an entry no view would ever draw',
	);
});

/*
The one place the two modes' texts can differ, and the reason a headless run
gets the full text rather than the folded sentence: a frame has one row to an
entry, so the block draws a driver's multi-line message with its breaks taken
out — and there is no block here, and no diagnostics view behind a keypress
either, so the folding would leave the rest of what the driver said nowhere.
*/
test('a driver’s multi-line message reaches a headless run whole', async t => {
	const test_ = harness(granted());
	test_.pusher.failsWith = new Error('server selection timed out\nafter 30s');
	test_.shutdown.fire('SIGINT');

	await runCollect(test_.options);

	t.true(
		test_.logger.warnings.includes('server selection timed out\nafter 30s'),
		'breaks and all, which is what the diagnostics view would have drawn',
	);
});

/*
What the run leaves behind, said at the end of it — and the one report a run
makes that changes nothing. The eras are in the Local Store, the next run's
startup Drain will carry them, and the exit code is the Flush's to set: a Push
that has not happened costs the website an era and never the CLI one (ADR-0012).
*/
test('a backlog that survives the run is logged, and is not a failed run', async t => {
	const test_ = harness(granted());
	test_.store.waiting.push(era(1), era(2));
	/*
	MongoDB is down, which is the only way a backlog survives a run: every Drain
	fails, the eras stay in the Local Store, and the run ends anyway — with the
	website's copies owed and nothing for the exit code to say about them.
	*/
	test_.pusher.failsWith = new Error('connect ECONNREFUSED 127.0.0.1');
	test_.shutdown.fire('SIGTERM');

	const {finalFlush} = await runCollect(test_.options);

	t.true(finalFlush, 'a Push the CLI owes nobody costs it nothing');
	t.is(test_.logger.lines.at(-1), '2 eras await Push.');
});

/*
The count in that sentence is the same quantity `Pushed N eras` carries, and it
is spelled the same way: a backlog of four figures is reachable — an afternoon
offline at the Flush Interval — and `1234` beside a frame's `1,234` would read
as two different numbers.
*/
test('the stranded count is spelled the way the totals are', async t => {
	const test_ = harness(granted());
	test_.store.waiting.push(
		...Array.from({length: 1234}, (_, index) => era(index)),
	);
	test_.shutdown.fire('SIGTERM');

	await runCollect(test_.options);

	t.is(test_.logger.lines.at(-1), '1,234 eras await Push.');
});

/*
One era is still "await Push", and the sentence has to read as one — the same
care `collectionEntry` takes over naming one Collector rather than two.
*/
test('one stranded era is spelled as one', async t => {
	const test_ = harness(granted());
	test_.store.waiting.push(era(1));
	test_.shutdown.fire('SIGTERM');

	await runCollect(test_.options);

	t.is(test_.logger.lines.at(-1), '1 era awaits Push.');
});

test('a run that left no backlog behind says nothing about one', async t => {
	const test_ = harness(granted());
	test_.shutdown.fire('SIGTERM');

	await runCollect(test_.options);

	t.false(
		test_.logger.lines.some(line => line.includes('await Push')),
		'a backlog of none is not a line',
	);
});

/*
A Collector that cannot start is a broken install rather than a missing grant,
so it still reaches the caller — through the view's lifetime rather than in
spite of it.
*/
test('a Collector that throws on start stops the dashboard and propagates', async t => {
	const test_ = harness(granted());

	await t.throwsAsync(
		runDashboard({
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
		}),
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

/*
`usage record-claude-hook`, and the three things it reaches outside itself for
------------------------------------------------------------------------------

The store's usage faces, the Usage Push seam, and the transcript. The transcript
is a real file in a temp directory rather than a fake: the walk's own subject is
`usage-transcript.test.ts`, and a stand-in for `readFileSync` would fake the one
thing this command hands a path to.
*/

/*
The store, standing in: Ingest, the Usage Backlog, and the close. It dedups by
whole-record equality, which is what a re-walk of one transcript produces — the
real store compares a fingerprint within ±5s, and what the command does with
either answer is the same.
*/
class FakeUsageStore implements UsageStore {
	readonly records: UsageRecord[] = [];
	readonly waiting: BackloggedUsage[] = [];
	closes = 0;
	/*
	A store that will not take a record — a full disk, a file that went away —
	as `ingest` sees one. It throws, as the real one does, and the command is
	what turns that into the hook contract's exit 0.
	*/
	failIngest?: Error;
	/*
	Every Ingested record comes back Unpriced, which is the state the command
	has a stderr line for (ADR-0015).
	*/
	unpriced = false;
	/*
	And a store that will not close, which fails *after* the command's catch
	has already run — the one path a bare `finally` would let escape.
	*/
	failClose?: Error;

	ingest(record: UsageRecord): IngestResult {
		if (this.failIngest) {
			throw this.failIngest;
		}

		if (
			this.records.some(
				stored => JSON.stringify(stored) === JSON.stringify(record),
			)
		) {
			return {status: 'duplicate'};
		}

		this.records.push(record);
		return {
			status: 'ingested',
			id: this.records.length,
			costYuan: this.unpriced ? undefined : 1,
		};
	}

	/*
	The classify half `--dry-run` drives. Whole-record equality — the same key
	`ingest` dedups on above — so a preview and a real run agree on what is
	already there.
	*/
	duplicatesExisting(record: UsageRecord): boolean {
		return this.records.some(
			stored => JSON.stringify(stored) === JSON.stringify(record),
		);
	}

	usageBacklog(): readonly BackloggedUsage[] {
		return this.waiting;
	}

	/*
	An acknowledged record leaves the backlog, the way the real store's does —
	which is what makes "what is left after a Drain" the command's own read
	rather than something this fake has to be told.
	*/
	markUsagePushed(id: number): void {
		const index = this.waiting.findIndex(record => record.id === id);
		if (index !== -1) {
			this.waiting.splice(index, 1);
		}
	}

	close(): void {
		this.closes += 1;

		if (this.failClose) {
			throw this.failClose;
		}
	}
}

/*
The Usage Push seam, standing in. A successful pass carries everything and
acknowledges it, so the count the command reads back afterwards is the count
this fake left behind; a failed one acknowledges what it did carry first — none
by default, or `pushesBeforeFailing` — and says so through the sink the command
built it with.
*/
class FakeUsagePusher implements UsagePush {
	#onAttempt: ((attempt: PushAttempt) => void) | undefined;
	drains = 0;
	closes = 0;
	failsWith?: Error;
	/*
	How many records a failing Drain carries and acknowledges before it fails,
	modeling the real seam's partial batch. Zero is a Drain that fails before
	anything lands.
	*/
	pushesBeforeFailing = 0;
	backlog: UsagePushBacklog | undefined;

	attach(
		onAttempt: (attempt: PushAttempt) => void,
		backlog: UsagePushBacklog,
	): void {
		this.#onAttempt = onAttempt;
		this.backlog = backlog;
	}

	async drain(): Promise<void> {
		this.drains += 1;

		if (this.failsWith !== undefined) {
			/*
			Copied before it is acknowledged. `usageBacklog()` hands back the
			store's own live array, and `markUsagePushed` splices it — iterating
			that same array would skip every record after the first.
			*/
			const carried = [...(this.backlog?.usageBacklog() ?? [])].slice(
				0,
				this.pushesBeforeFailing,
			);
			for (const record of carried) {
				this.backlog?.markUsagePushed(record.id, new Date());
			}

			this.#onAttempt?.({
				at: new Date(),
				ok: false,
				pushed: carried.length,
				error: this.failsWith,
			});
			return;
		}

		const carried = [...(this.backlog?.usageBacklog() ?? [])];
		for (const record of carried) {
			this.backlog?.markUsagePushed(record.id, new Date());
		}

		this.#onAttempt?.({at: new Date(), ok: true, pushed: carried.length});
	}

	async close(): Promise<void> {
		this.closes += 1;
	}
}

/*
The hook payload, built with camelCase arguments so the tests below do not have
to spell Claude Code's field names at every call site. `transcript_path` and
`agent_transcript_path` are written verbatim because they are what the wiring
sends; a missing one is dropped by `JSON.stringify`, as the real payload would
have it.
*/
function hookPayload({
	event = 'Stop',
	transcript,
	agentTranscript,
	cwd,
}: {
	readonly event?: string;
	readonly transcript?: string;
	readonly agentTranscript?: string;
	readonly cwd?: string;
}): Record<string, unknown> {
	/* eslint-disable @typescript-eslint/naming-convention -- the hook JSON's own field names. */
	return {
		hook_event_name: event,
		transcript_path: transcript,
		agent_transcript_path: agentTranscript,
		cwd,
	};
	/* eslint-enable @typescript-eslint/naming-convention */
}

/*
One transcript file a test owns, under the OS's temp directory so nothing a
fixture writes can be committed by accident — and never `~/.claude`, which the
gate may not touch.
*/
function hookTranscript(
	t: ExecutionContext,
	lines: ReadonlyArray<Record<string, unknown>>,
): string {
	const directory = mkdtempSync(join(tmpdir(), 'jwoo-cli-hook-test-'));
	t.teardown(() => {
		rmSync(directory, {recursive: true, force: true});
	});

	const file = join(directory, 'session.jsonl');
	writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
	return file;
}

/* eslint-disable @typescript-eslint/naming-convention -- the transcript's own Anthropic field names, the same exception `usage-transcript.test.ts` makes. */
const HOOK_TURN = [
	{
		type: 'user',
		message: {role: 'user', content: 'hello'},
		timestamp: '2026-08-18T07:00:00.000Z',
	},
	{
		type: 'assistant',
		message: {
			id: 'req-1',
			model: 'kimi-k2.7-code',
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_read_input_tokens: 20,
			},
		},
		timestamp: '2026-08-18T07:00:01.000Z',
	},
];

/*
A second turn with different tokens, so that counting records says which of two
transcripts was walked.
*/
const SECOND_TURN = [
	{
		type: 'user',
		message: {role: 'user', content: 'again'},
		timestamp: '2026-08-18T07:01:00.000Z',
	},
	{
		type: 'assistant',
		message: {
			id: 'req-2',
			model: 'kimi-k2.7-code',
			usage: {input_tokens: 7, output_tokens: 3},
		},
		timestamp: '2026-08-18T07:01:01.000Z',
	},
];

function backloggedUsage(id: number): BackloggedUsage {
	return {
		id,
		recordedAt: new Date('2026-08-18T07:00:00.000Z'),
		harness: 'Claude Code',
		cwd: undefined,
		model: 'kimi-k2.7-code',
		costYuan: 1,
		prompt_tokens: 120,
		completion_tokens: 50,
		total_tokens: 170,
		prompt_cache_hit_tokens: 20,
		prompt_cache_miss_tokens: 100,
	};
}
/* eslint-enable @typescript-eslint/naming-convention */

type UsageRun = {
	readonly store: FakeUsageStore;
	readonly pusher: FakeUsagePusher;
	readonly written: string[];
	/*
	How many times the command asked for a Push seam. Zero is the answer "no
	Pusher without a URI" is asserted with, because a stand-in is always
	supplied and the command must not reach for it.
	*/
	readonly pusherBuilt: number;
};

/*
One `usage record-claude-hook` invocation, with everything it reaches outside
itself stood in for. `input` is the hook payload — an object, stringified, or a
raw string for the malformed-stdin case.
*/
async function runHook(
	input: unknown,
	{
		/*
		A whole Config rather than a URI, because a destructuring default cannot
		tell "this config has no `MONGO_URI`" from "the caller did not say" — and
		the URI-free case is one of the things a test has to be able to ask for.
		*/
		config = CONFIG,
		store = new FakeUsageStore(),
		pusher = new FakeUsagePusher(),
	}: {
		readonly config?: Config;
		readonly store?: FakeUsageStore;
		readonly pusher?: FakeUsagePusher;
	} = {},
): Promise<UsageRun> {
	const written: string[] = [];
	let pusherBuilt = 0;

	const options: RecordUsageOptions = {
		config,
		stdin: async () =>
			typeof input === 'string' ? input : JSON.stringify(input),
		stderr(message) {
			written.push(message);
		},
		createUsageStore: () => store,
		createUsagePusher(backlog, onAttempt) {
			pusherBuilt += 1;
			pusher.attach(onAttempt, backlog);
			return pusher;
		},
	};

	await runRecordClaudeHook(options);

	return {store, pusher, written, pusherBuilt};
}

/*
The whole of the demoable path: a Stop payload, a transcript, a record out the
other end. The Harness literal and the cwd come from the command and the
payload, which is what says this is the Claude command rather than a Backfill.
*/
test('a Stop hook walks the transcript, Ingests its turns and reports Recorded.', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);

	const {store, pusher, written, pusherBuilt} = await runHook(
		hookPayload({transcript, cwd: '/projects/site'}),
	);

	t.is(store.records.length, 1);
	t.is(store.records[0]?.harness, 'Claude Code');
	t.is(store.records[0]?.cwd, '/projects/site');
	t.is(store.records[0]?.prompt_tokens, 120, 'input + cache');
	t.is(store.records[0]?.completion_tokens, 50);
	t.deepEqual(written, ['Recorded.']);
	t.is(pusherBuilt, 1);
	t.is(pusher.drains, 1, 'the invocation touches the Backlog');
	t.is(store.closes, 1, 'and closes the store it opened');
});

/*
The second pipe of the demo, and the rule that makes every Stop safe: the walk
re-visits the whole transcript, and the drop rule turns the re-visit into
Duplicates rather than a second copy.
*/
test('the same hook again is Duplicate., and still drains', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const store = new FakeUsageStore();

	await runHook(hookPayload({transcript}), {store});
	const second = await runHook(hookPayload({transcript}), {store});

	t.deepEqual(second.written, ['Duplicate.']);
	t.is(second.store.records.length, 1);
	t.is(second.pusher.drains, 1, 'the invocation touched the Backlog anyway');
	t.is(second.pusher.closes, 1);
});

test('agent_transcript_path wins, and transcript_path is the fallback', async t => {
	const main = hookTranscript(t, HOOK_TURN);
	const agent = hookTranscript(t, [...HOOK_TURN, ...SECOND_TURN]);

	const viaMain = await runHook(hookPayload({transcript: main}));
	t.is(
		viaMain.store.records.length,
		1,
		'transcript_path is walked when no agent one was sent',
	);

	const viaAgent = await runHook(
		hookPayload({transcript: main, agentTranscript: agent}),
	);
	t.is(viaAgent.store.records.length, 2, 'and the agent transcript wins');
});

/*
ApiReqDone is dead and is not ported (spec #53), so an event outside the two the
wiring sends Ingests nothing — but the invocation still happens, and the
Backlog it may carry is still drained.
*/
test('an event outside Stop and SubagentStop is a no-op that still drains', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const store = new FakeUsageStore();
	store.waiting.push(backloggedUsage(1));

	const {written, pusher} = await runHook(
		hookPayload({event: 'ApiReqDone', transcript}),
		{store},
	);

	t.deepEqual(store.records, []);
	t.deepEqual(written, []);
	t.is(pusher.drains, 1);
});

test('a missing transcript is a no-op run that still drains', async t => {
	const gone = join(tmpdir(), 'no-such-transcript.jsonl');
	const {store, written, pusher} = await runHook(
		hookPayload({transcript: gone}),
	);

	t.deepEqual(store.records, []);
	t.deepEqual(written, []);
	t.is(pusher.drains, 1);
	t.is(store.closes, 1);
});

test('an unreadable hook payload is a stderr line, and still drains', async t => {
	const {store, written, pusher} = await runHook('not json');

	t.deepEqual(store.records, []);
	t.regex(written[0] ?? '', /Could not read the hook input/v);
	t.is(pusher.drains, 1);
});

/*
The rule that separates the two failures: a store that could not take a record
is not one to hand the Backlog to, so the tail waits for the next invocation
(ADR-0012) — and the run still ends clean, because a hook that failed loudly
would surface inside the agent (ADR-0016).
*/
test('a failed Ingest skips the drain, and reports rather than throws', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const store = new FakeUsageStore();
	store.failIngest = new Error('database is locked');

	const {pusher, written} = await runHook(hookPayload({transcript}), {store});

	t.true(written.some(line => line.includes('database is locked')));
	t.is(pusher.drains, 0);
	t.is(store.closes, 1);
});

test('a store that cannot be opened is a stderr line, not a throw', async t => {
	const written: string[] = [];

	await runRecordClaudeHook({
		config: CONFIG,
		stdin: async () => JSON.stringify(hookPayload({})),
		stderr(message) {
			written.push(message);
		},
		createUsageStore() {
			throw new Error('Could not open the Local Store: file is not a database');
		},
		createUsagePusher() {
			throw new Error('no store, so no Drain');
		},
	});

	t.true(written.some(line => line.includes('file is not a database')));
});

/*
The Push is best-effort and the Ingest is not (ADR-0016): with no `MONGO_URI`
there is no seam to build, the records still land, and the Backlog is not even
mentioned — a config without a URI is a chosen state, not a stuck one.
*/
test('no Pusher is built without a MONGO_URI, and the records still land', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const store = new FakeUsageStore();
	store.waiting.push(backloggedUsage(1), backloggedUsage(2));

	const {pusher, pusherBuilt, written} = await runHook(
		hookPayload({transcript}),
		{store, config: {...CONFIG, mongoUri: undefined}},
	);

	t.is(store.records.length, 1);
	t.is(pusherBuilt, 0);
	t.is(pusher.drains, 0);
	t.true(written.includes('Recorded.'));
	t.false(
		written.some(line => line.includes('await Push')),
		'nothing is said about a Backlog nobody was asked to drain',
	);
});

/*
What the count is for: a Drain that could not happen leaves its records where
they were, and the number is what the operator sees when they look. A Drain that
did happen leaves nothing to say.
*/
test('a surviving Usage Backlog is a stderr line, and a carried one is not', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const stranded = new FakeUsageStore();
	stranded.waiting.push(backloggedUsage(1), backloggedUsage(2));
	const strandedPusher = new FakeUsagePusher();
	strandedPusher.failsWith = new Error('connect ECONNREFUSED 127.0.0.1');

	const failed = await runHook(hookPayload({transcript}), {
		store: stranded,
		pusher: strandedPusher,
	});

	t.true(
		failed.written.some(line => line.includes('connect ECONNREFUSED')),
		'what happened',
	);
	t.is(
		failed.written.at(-1),
		'2 usage records await Push.',
		'and how much is left',
	);

	const carried = new FakeUsageStore();
	carried.waiting.push(backloggedUsage(1));
	const clean = await runHook(hookPayload({transcript}), {store: carried});

	t.false(
		clean.written.some(line => line.includes('await Push')),
		'a Backlog that drained says nothing',
	);
});

test('one stranded record is spelled as one', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const store = new FakeUsageStore();
	store.waiting.push(backloggedUsage(1));
	const pusher = new FakeUsagePusher();
	pusher.failsWith = new Error('down');

	const {written} = await runHook(hookPayload({transcript}), {store, pusher});

	t.is(written.at(-1), '1 usage record awaits Push.');
});

/*
The Drain happens on every record-command run, even one that Ingested nothing:
the Backlog may hold older records, and this invocation is a chance to carry
them. A transcript with no turns is that run.
*/
test('an invocation that Ingested nothing still drains', async t => {
	const empty = hookTranscript(t, []);
	const store = new FakeUsageStore();
	store.waiting.push(backloggedUsage(1));

	const {pusher} = await runHook(hookPayload({transcript: empty}), {store});

	t.deepEqual(store.records, []);
	t.is(pusher.drains, 1);
	t.is(store.waiting.length, 0, 'and the older record was carried');
});

test('an Unpriced record is a per-record stderr line, and the run still lands it', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const store = new FakeUsageStore();
	store.unpriced = true;

	const {written} = await runHook(hookPayload({transcript}), {store});

	t.true(
		written.includes('no pricing for kimi-k2.7-code; cost left null'),
		'ADR-0015: absent pricing is not an absent record',
	);
	t.true(written.includes('Recorded.'));
	t.is(store.records.length, 1);
});

/*
The half of the hook contract a Run Log cannot show and an exit code cannot
either: the agent's stdout stays clean. The entry point is handed a stderr sink
and no stdout one, so this is the assertion that nothing crept in through a
`console.log` somewhere on the path.
*/
test('nothing reaches stdout on any path', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const written: string[] = [];
	const original = process.stdout.write;

	process.stdout.write = function (chunk: string) {
		written.push(chunk);
		return original.call(process.stdout, chunk);
	};

	try {
		await runHook(hookPayload({transcript}));
		await runHook('not json');
	} finally {
		process.stdout.write = original;
	}

	t.deepEqual(written, []);
});

/*
The other event Claude Code stops on, and the reason the set has two members:
a SubagentStop is the same walk over the subagent's own transcript.
*/
test('a SubagentStop hook records from the subagent transcript too', async t => {
	const transcript = hookTranscript(t, SECOND_TURN);

	const {store, written} = await runHook(
		hookPayload({event: 'SubagentStop', transcript}),
	);

	t.is(store.records.length, 1);
	t.true(written.includes('Recorded.'));
});

/*
The last thing that can fail, and the one a bare `finally` lets past the catch
that was meant to hold it. It is a line, like every other problem, and the run
still ends clean (ADR-0016).
*/
test('a store that will not close is a stderr line, not a throw', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const store = new FakeUsageStore();
	store.failClose = new Error('database is locked');

	const {written} = await runHook(hookPayload({transcript}), {store});

	t.true(written.some(line => line.includes('database is locked')));
	t.is(store.closes, 1);
});

/*
And the Push seam that cannot be built at all: a `MONGO_URI` that parses as a
string but not as a URI throws in the seam's constructor, before any Drain. No
Drain was attempted, so no count is owed — but the reason reaches stderr.
*/
test('a Push seam that cannot be built is a stderr line, not a throw', async t => {
	const transcript = hookTranscript(t, HOOK_TURN);
	const store = new FakeUsageStore();
	const written: string[] = [];

	await runRecordClaudeHook({
		config: CONFIG,
		stdin: async () =>
			JSON.stringify(hookPayload({transcript, cwd: '/projects/site'})),
		stderr(message) {
			written.push(message);
		},
		createUsageStore: () => store,
		createUsagePusher() {
			throw new Error('Invalid scheme, expected connection string to start');
		},
	});

	t.is(store.records.length, 1, 'the Ingest still landed');
	t.true(written.some(line => line.includes('Invalid scheme')));
	t.false(written.some(line => line.includes('await Push')));
});

/*
`usage record-opencode`, and what it adds to the Claude command's shape
------------------------------------------------------------------------------

The same store, seam and reporting, over one OpenCode `info` blob instead of a
transcript. The projection itself is `usage-opencode.test.ts`'s subject; what is
driven here is the command around it — the harness literal it owns, the one
record a payload becomes, and the ADR-0016 paths it shares with the Claude
command but must reach through its own entry point.
*/

/* eslint-disable @typescript-eslint/naming-convention -- the OpenCode message's own field names, the same exception `usage-opencode.test.ts` makes. */
function opencodeMessage(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		role: 'assistant',
		time: {created: 1_755_500_000_000, completed: 1_755_500_001_000},
		modelID: 'kimi-k2.7-code',
		path: {cwd: '/projects/site', root: '/projects/site'},
		cost: 0.42,
		tokens: {
			input: 100,
			output: 50,
			reasoning: 10,
			cache: {read: 20, write: 5},
		},
		...overrides,
	});
}
/* eslint-enable @typescript-eslint/naming-convention */

async function runOpencode(
	input: unknown,
	{
		config = CONFIG,
		store = new FakeUsageStore(),
		pusher = new FakeUsagePusher(),
	}: {
		readonly config?: Config;
		readonly store?: FakeUsageStore;
		readonly pusher?: FakeUsagePusher;
	} = {},
): Promise<UsageRun> {
	const written: string[] = [];
	let pusherBuilt = 0;

	await runRecordOpencode({
		config,
		stdin: async () =>
			typeof input === 'string' ? input : JSON.stringify(input),
		stderr(message) {
			written.push(message);
		},
		createUsageStore: () => store,
		createUsagePusher(backlog, onAttempt) {
			pusherBuilt += 1;
			pusher.attach(onAttempt, backlog);
			return pusher;
		},
	});

	return {store, pusher, written, pusherBuilt};
}

/*
The demoable path: one Shim payload in, one OpenCode-attributed record out. The
Harness literal is the command's, not the payload's — OpenCode's message carries
no harness field.
*/
test('one OpenCode message is projected, Ingested and reported Recorded.', async t => {
	const {store, pusher, written, pusherBuilt} =
		await runOpencode(opencodeMessage());

	t.is(store.records.length, 1);
	t.is(store.records[0]?.harness, 'OpenCode');
	t.is(store.records[0]?.model, 'kimi-k2.7-code');
	t.is(store.records[0]?.cwd, '/projects/site');
	t.is(store.records[0]?.prompt_tokens, 135, 'reasoning bills as miss-input');
	t.is(store.records[0]?.prompt_cache_hit_tokens, 20);
	t.is(store.records[0]?.prompt_cache_miss_tokens, 115);
	t.is(store.records[0]?.completion_tokens, 50);
	t.is(store.records[0]?.total_tokens, 185, 'prompt + completion');
	t.is(
		store.records[0]?.recordedAt.getTime(),
		1_755_500_000_000,
		'time.created, not the completed instant the Shim fires at',
	);
	t.deepEqual(written, ['Recorded.']);
	t.is(pusherBuilt, 1);
	t.is(pusher.drains, 1, 'the invocation touches the Backlog');
	t.is(store.closes, 1);
});

test('the same OpenCode message again is Duplicate., and still drains', async t => {
	const store = new FakeUsageStore();

	await runOpencode(opencodeMessage(), {store});
	const second = await runOpencode(opencodeMessage(), {store});

	t.deepEqual(second.written, ['Duplicate.']);
	t.is(second.store.records.length, 1);
	t.is(second.pusher.drains, 1);
});

/*
The no-token skip: an aborted generation is a no-op run, not a zero-cost record
— and the Backlog it may carry is still drained, as on every record-command
invocation.
*/
test('a message with no tokens is a no-op run that still drains', async t => {
	const {store, written, pusher} = await runOpencode(
		opencodeMessage({tokens: {}}),
	);

	t.deepEqual(store.records, []);
	t.deepEqual(written, []);
	t.is(pusher.drains, 1);
});

test('an unreadable OpenCode payload is a stderr line, and still drains', async t => {
	const {store, written, pusher} = await runOpencode('not json');

	t.deepEqual(store.records, []);
	t.regex(written[0] ?? '', /Could not read the OpenCode input/v);
	t.is(pusher.drains, 1);
});

/*
The Shim's document: the `info` blob plus the two fields it derived from the
message's `part` events. Both reach the record, unchanged — repeats kept.
*/
test('an OpenCode payload carries its Tool Call count and Skill list', async t => {
	const info: unknown = JSON.parse(opencodeMessage());
	const {store} = await runOpencode({
		info,
		toolCalls: 3,
		skills: ['commit', 'implement', 'commit'],
	});

	t.is(store.records.length, 1);
	t.is(store.records[0]?.toolCalls, 3);
	t.deepEqual(store.records[0]?.skills, ['commit', 'implement', 'commit']);
});

/*
An older Shim sends the bare `info` blob, with no tool data; that absence is
unknown for both fields, not none, and the payload must still Ingest.
*/
test('an OpenCode payload with no tool data still Ingests, leaving both unknown', async t => {
	const {store, written} = await runOpencode(opencodeMessage());

	t.deepEqual(written, ['Recorded.']);
	t.is(store.records.length, 1);
	t.is(store.records[0]?.toolCalls, undefined);
	t.is(store.records[0]?.skills, undefined);
});

/*
`usage record-pi`, and the one document its Shim delivers
---------------------------------------------------------

The same store, seam and reporting, over the Pi Shim's document — the finished
assistant message plus the context's `cwd` — instead of an OpenCode blob. The
projection is `usage-pi.test.ts`'s subject and the session walk's fixture
`piMessage` is reused here; what is driven is the command around it: the Pi
Harness literal it owns, the `cwd` the payload carries, and the ADR-0016 paths
it shares with its two siblings.
*/

/*
The Shim's document: the message the event delivered and the `cwd` the context
carried. A raw string is passed through for the malformed-stdin case.
*/
function piRecordPayload(
	message: unknown = piMessage(),
	cwd: string | undefined = '/projects/site',
	skills?: readonly string[],
): Record<string, unknown> {
	return skills === undefined ? {message, cwd} : {message, cwd, skills};
}

async function runPi(
	input: unknown,
	{
		config = CONFIG,
		store = new FakeUsageStore(),
		pusher = new FakeUsagePusher(),
	}: {
		readonly config?: Config;
		readonly store?: FakeUsageStore;
		readonly pusher?: FakeUsagePusher;
	} = {},
): Promise<UsageRun> {
	const written: string[] = [];
	let pusherBuilt = 0;

	await runRecordPi({
		config,
		stdin: async () =>
			typeof input === 'string' ? input : JSON.stringify(input),
		stderr(message) {
			written.push(message);
		},
		createUsageStore: () => store,
		createUsagePusher(backlog, onAttempt) {
			pusherBuilt += 1;
			pusher.attach(onAttempt, backlog);
			return pusher;
		},
	});

	return {store, pusher, written, pusherBuilt};
}

/*
The demoable path: one Shim document in, one Pi-attributed record out. The
Harness literal is the command's — pi's message carries no harness field — and
the `cwd` is the one the context handed the Shim.
*/
test('one Pi message is projected, Ingested and reported Recorded.', async t => {
	const {store, pusher, written, pusherBuilt} = await runPi(piRecordPayload());

	t.is(store.records.length, 1);
	t.is(store.records[0]?.harness, 'Pi');
	t.is(store.records[0]?.model, 'kimi-k2.7-code');
	t.is(store.records[0]?.cwd, '/projects/site');
	t.is(store.records[0]?.prompt_tokens, 128, 'input + both cache writes');
	t.is(store.records[0]?.prompt_cache_hit_tokens, 20);
	t.is(store.records[0]?.prompt_cache_miss_tokens, 108);
	t.is(store.records[0]?.completion_tokens, 50);
	t.is(
		store.records[0]?.total_tokens,
		178,
		"prompt + completion, never pi's totalTokens",
	);
	t.is(
		store.records[0]?.recordedAt.getTime(),
		1_755_500_000_000,
		"the message's own timestamp",
	);
	t.deepEqual(written, ['Recorded.']);
	t.is(pusherBuilt, 1);
	t.is(pusher.drains, 1, 'the invocation touches the Backlog');
	t.is(store.closes, 1);
});

/*
The Shim's Skill list and the message's own toolCall blocks both reach the
record. The list is the Shim's derivation (it observed the user message) and is
carried through unchanged, repeats kept.
*/
test('a Pi payload carries its Skill list and its Tool Call count', async t => {
	const {store} = await runPi(
		piRecordPayload(
			piMessage({
				content: [
					{type: 'toolCall', id: 'c1', name: 'bash', arguments: {}},
					{type: 'toolCall', id: 'c2', name: 'read', arguments: {}},
				],
			}),
			'/projects/site',
			['commit', 'review', 'commit'],
		),
	);

	t.is(store.records.length, 1);
	t.is(store.records[0]?.toolCalls, 2);
	t.deepEqual(store.records[0]?.skills, ['commit', 'review', 'commit']);
});

/*
An older Shim sends no Skill list, and that absence is unknown, not none: the
payload must still Ingest.
*/
test('a Pi payload with no Skill list still Ingests, leaving Skills unknown', async t => {
	const {store, written} = await runPi(piRecordPayload());

	t.deepEqual(written, ['Recorded.']);
	t.is(store.records.length, 1);
	t.is(store.records[0]?.skills, undefined);
	t.is(store.records[0]?.toolCalls, 0);
});

test('the same Pi message again is Duplicate., and still drains', async t => {
	const store = new FakeUsageStore();

	await runPi(piRecordPayload(), {store});
	const second = await runPi(piRecordPayload(), {store});

	t.deepEqual(second.written, ['Duplicate.']);
	t.is(second.store.records.length, 1);
	t.is(second.pusher.drains, 1);
});

/*
The no-token skip: a message whose buckets are all absent or zero is a no-op
run, not a zero-cost record — and the Backlog is still drained.
*/
test('a Pi message with no tokens is a no-op run that still drains', async t => {
	const {store, written, pusher} = await runPi(
		piRecordPayload(piMessage({usage: {}})),
	);

	t.deepEqual(store.records, []);
	t.deepEqual(written, []);
	t.is(pusher.drains, 1);
});

test('an unreadable Pi payload is a stderr line, and still drains', async t => {
	const {store, written, pusher} = await runPi('not json');

	t.deepEqual(store.records, []);
	t.regex(written[0] ?? '', /Could not read the Pi input/v);
	t.is(pusher.drains, 1);
});

/*
`usage backfill-claude`, and the projects directory it walks
------------------------------------------------------------

The same store, seam and transcript walk the record commands use, over a tree of
fixture `.jsonl` files instead of one path. The walk itself is
`usage-transcript.test.ts`'s subject; what is driven here is the command around
it — the whole directory scanned (subagents included), every candidate through
the one Ingest face, `--dry-run` against the classify face, `--since` twice
over, and the operator's exit-1 contract.
*/

/*
The store the Backfill tests drive, which is the record commands' fake plus the
one thing their tests never needed: an Ingested record joins the Usage Backlog.

The real store's backlog is exactly its unpushed rows, so the summary's `pushed`
and `remaining` are only meaningful against a store that models that. The shared
fake keeps `waiting` and `records` apart because the record commands' tests seed
a backlog by hand; this one closes the gap for the Backfill, where the records
that await Push are the records the run just wrote.
*/
class FakeBackfillStore extends FakeUsageStore {
	override ingest(record: UsageRecord): IngestResult {
		const result = super.ingest(record);

		if (result.status === 'ingested') {
			this.waiting.push({
				...record,
				id: result.id,
				costYuan: result.costYuan,
			});
		}

		return result;
	}
}

/*
One fixture projects directory, under the OS's temp directory so nothing a test
writes can be committed by accident — and never `~/.claude`, which the gate may
not touch. Keys are paths relative to the root, so `subagents/` nests the way it
does on disk.
*/
function transcriptTree(
	t: ExecutionContext,
	files: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>,
): string {
	const root = mkdtempSync(join(tmpdir(), 'jwoo-cli-backfill-test-'));
	t.teardown(() => {
		rmSync(root, {recursive: true, force: true});
	});

	for (const [relative, lines] of Object.entries(files)) {
		const file = join(root, relative);
		mkdirSync(dirname(file), {recursive: true});
		writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
	}

	return root;
}

type BackfillRun = {
	readonly store: FakeBackfillStore;
	readonly pusher: FakeUsagePusher;
	readonly stdout: string[];
	readonly stderr: string[];
	/*
	Whether the Backfill resolved clean, which `cli.tsx` reads as exit 0.
	*/
	readonly ok: boolean;
	readonly pusherBuilt: number;
};

/*
One `usage backfill-claude` invocation, with everything it reaches outside
itself stood in for.
*/
async function runBackfill({
	root,
	since,
	dryRun = false,
	config = CONFIG,
	store = new FakeBackfillStore(),
	pusher = new FakeUsagePusher(),
}: {
	readonly root: string;
	readonly since?: Date;
	readonly dryRun?: boolean;
	readonly config?: Config;
	readonly store?: FakeBackfillStore;
	readonly pusher?: FakeUsagePusher;
}): Promise<BackfillRun> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let pusherBuilt = 0;

	const result = await runBackfillClaude({
		root,
		since,
		dryRun,
		config,
		stdout(message) {
			stdout.push(message);
		},
		stderr(message) {
			stderr.push(message);
		},
		createUsageStore: () => store,
		createUsagePusher(backlog, onAttempt) {
			pusherBuilt += 1;
			pusher.attach(onAttempt, backlog);
			return pusher;
		},
	});

	return {store, pusher, stdout, stderr, ok: !result.failed, pusherBuilt};
}

/*
The demoable path: a projects directory in, its turns Ingested with the Harness
literal the command owns. `subagents/` is walked like any other directory, so
the subagent's turn is a record too.
*/
test('a Backfill walks the whole tree, including subagents, and summarizes it', async t => {
	const root = transcriptTree(t, {
		'project-a/session.jsonl': HOOK_TURN,
		'project-a/subagents/agent-1.jsonl': SECOND_TURN,
	});

	const {store, pusher, stdout, ok} = await runBackfill({root});

	t.true(ok);
	t.is(store.records.length, 2);
	t.true(store.records.every(record => record.harness === 'Claude Code'));
	t.is(pusher.drains, 1);
	t.is(store.closes, 1);
	t.deepEqual(stdout, [
		'scanned 2 transcripts, 2 candidates, 2 ingested, 0 duplicates dropped, 2 pushed, 0 remaining',
	]);
});

/*
The drop rule is what makes a Backfill idempotent: a second pass over the same
transcripts adds nothing, so a crash mid-scan is healed by running it again.
*/
test('re-running a Backfill adds nothing', async t => {
	const root = transcriptTree(t, {
		'project-a/session.jsonl': HOOK_TURN,
	});
	const store = new FakeBackfillStore();

	const first = await runBackfill({root, store});
	const second = await runBackfill({root, store});

	t.is(first.store.records.length, 1);
	t.is(second.store.records.length, 1, 'the drop rule held');
	t.deepEqual(second.stdout, [
		'scanned 1 transcripts, 1 candidates, 0 ingested, 1 duplicates dropped, 0 pushed, 0 remaining',
	]);
});

/*
`--dry-run` is the classify face, so the store is read and never written and no
Push is attempted at all.
*/
test('a dry run classifies every candidate and writes nothing', async t => {
	const root = transcriptTree(t, {
		'project-a/session.jsonl': HOOK_TURN,
		'project-a/subagents/agent-1.jsonl': SECOND_TURN,
	});

	const {store, pusher, stdout, pusherBuilt, ok} = await runBackfill({
		root,
		dryRun: true,
	});

	t.true(ok);
	t.deepEqual(store.records, [], 'nothing was Ingested');
	t.is(pusherBuilt, 0, 'and no seam was built');
	t.is(pusher.drains, 0);
	t.is(store.closes, 1, 'the store it read from is still closed');
	t.deepEqual(stdout, [
		'scanned 2 transcripts, 2 candidates, 2 would-ingest, 0 duplicates found',
	]);
});

/*
The documented limit of a dry run: two identical candidates in one scan both
report a would-ingest, because neither is stored yet for the second to find. The
real run below drops the second.
*/
test('two identical candidates both report a would-ingest in a dry run', async t => {
	const root = transcriptTree(t, {
		'project-a/session.jsonl': HOOK_TURN,
		'project-b/session.jsonl': HOOK_TURN,
	});

	const dry = await runBackfill({root, dryRun: true});
	t.deepEqual(dry.stdout, [
		'scanned 2 transcripts, 2 candidates, 2 would-ingest, 0 duplicates found',
	]);

	const real = await runBackfill({root});
	t.is(real.store.records.length, 1, 'the real run drops the second');
	t.deepEqual(real.stdout, [
		'scanned 2 transcripts, 2 candidates, 1 ingested, 1 duplicates dropped, 1 pushed, 0 remaining',
	]);
});

/*
`--since` is applied to each record's own `recorded_at`: a file touched recently
enough to read still yields only turns at or after the bound.
*/
test('--since filters each candidate on its own recorded_at', async t => {
	const root = transcriptTree(t, {
		'project-a/session.jsonl': HOOK_TURN,
		'project-a/later.jsonl': SECOND_TURN,
	});

	const since = new Date('2026-08-18T07:01:00.000Z');
	const {store, stdout} = await runBackfill({root, since});

	/*
	Both files are scanned — their mtimes are now — but only the later turn,
	timestamped at the bound itself, survives the per-record filter.
	*/
	t.is(store.records.length, 1);
	t.is(store.records[0]?.completion_tokens, 3);
	t.deepEqual(stdout, [
		'scanned 2 transcripts, 1 candidates, 1 ingested, 0 duplicates dropped, 1 pushed, 0 remaining',
	]);
});

/*
The pre-skip: a file whose mtime is older than the bound cannot hold a turn at
or after it, so it is not read at all — and `scanned` counts what was read.
*/
test('--since skips a file older than the bound without reading it', async t => {
	const root = transcriptTree(t, {
		'project-a/old.jsonl': HOOK_TURN,
		'project-a/new.jsonl': SECOND_TURN,
	});

	const old = new Date('2026-08-18T07:00:01.000Z');
	utimesSync(join(root, 'project-a/old.jsonl'), old, old);

	const since = new Date('2026-08-18T07:01:00.000Z');
	const {stdout} = await runBackfill({root, since});

	t.deepEqual(stdout, [
		'scanned 1 transcripts, 1 candidates, 1 ingested, 0 duplicates dropped, 1 pushed, 0 remaining',
	]);
});

/*
A root the scan cannot read is the Backfill's own failure, so it resolves false
— which `cli.tsx` turns into exit 1 — and says why on stderr.
*/
test('a root that cannot be scanned fails the Backfill', async t => {
	const root = join(tmpdir(), 'jwoo-cli-no-such-projects-dir');

	const {ok, stderr, store} = await runBackfill({root});

	t.false(ok);
	t.regex(stderr[0] ?? '', /Could not scan/v);
	t.is(store.closes, 1, 'the store is still closed on the failing path');
});

test('a store that cannot be opened fails the Backfill', async t => {
	const root = transcriptTree(t, {'project-a/session.jsonl': HOOK_TURN});
	const stderr: string[] = [];

	const result = await runBackfillClaude({
		root,
		config: CONFIG,
		stderr(message) {
			stderr.push(message);
		},
		createUsageStore() {
			throw new Error('Could not open the Local Store: file is not a database');
		},
	});

	t.true(result.failed);
	t.true(stderr.some(line => line.includes('file is not a database')));
});

/*
A store that will not take a record is the other half of the Backfill's own
failure: the run stops and resolves false rather than reporting a partial scan
as if it were whole.
*/
test('an Ingest that throws fails the Backfill', async t => {
	const root = transcriptTree(t, {'project-a/session.jsonl': HOOK_TURN});
	const store = new FakeBackfillStore();
	store.failIngest = new Error('database is locked');

	const {ok, stderr, pusher} = await runBackfill({root, store});

	t.false(ok);
	t.true(stderr.some(line => line.includes('database is locked')));
	t.is(pusher.drains, 0, 'a run that failed did not reach the Drain');
	t.is(store.closes, 1);
});

/*
A surviving Usage Backlog is not the Backfill's failure (the operator
convention): the Push is best-effort, so the run resolves clean with the
remainder in its summary.
*/
test('a surviving Usage Backlog is reported, not a failure', async t => {
	const root = transcriptTree(t, {'project-a/session.jsonl': HOOK_TURN});
	const store = new FakeBackfillStore();
	store.waiting.push(backloggedUsage(1));
	const pusher = new FakeUsagePusher();
	pusher.failsWith = new Error('connect ECONNREFUSED 127.0.0.1');

	const {ok, stdout, stderr} = await runBackfill({root, store, pusher});

	t.true(ok, 'a Push is best-effort');
	t.true(stderr.some(line => line.includes('connect ECONNREFUSED')));
	t.deepEqual(stdout, [
		'scanned 1 transcripts, 1 candidates, 1 ingested, 0 duplicates dropped, 0 pushed, 2 remaining',
	]);
});

/*
A Drain that fails part-way still Pushed what it carried, and the summary owes
that count rather than zero: the two fields have to agree with each other.
*/
test('a partial Drain reports the records it did Push', async t => {
	const root = transcriptTree(t, {
		'project-a/session.jsonl': HOOK_TURN,
		'project-a/later.jsonl': SECOND_TURN,
	});
	const pusher = new FakeUsagePusher();
	pusher.failsWith = new Error('server selection timed out');
	pusher.pushesBeforeFailing = 1;

	const {ok, stdout, stderr} = await runBackfill({root, pusher});

	t.true(ok);
	t.true(stderr.some(line => line.includes('server selection timed out')));
	t.deepEqual(stdout, [
		'scanned 2 transcripts, 2 candidates, 2 ingested, 0 duplicates dropped, 1 pushed, 1 remaining',
	]);
});

/*
No `MONGO_URI` is a chosen state: the records still land, no seam is built, and
the summary says nothing was Pushed.
*/
test('no Backfill Push without a MONGO_URI, and the records still land', async t => {
	const root = transcriptTree(t, {'project-a/session.jsonl': HOOK_TURN});
	const store = new FakeBackfillStore();

	const {ok, stdout, stderr, pusherBuilt, pusher} = await runBackfill({
		root,
		store,
		config: {...CONFIG, mongoUri: undefined},
	});

	t.true(ok);
	t.is(store.records.length, 1);
	t.is(pusherBuilt, 0);
	t.is(pusher.drains, 0);
	t.true(stderr.includes('No MONGO_URI; nothing was Pushed.'));
	t.deepEqual(stdout, [
		'scanned 1 transcripts, 1 candidates, 1 ingested, 0 duplicates dropped, 0 pushed, 1 remaining',
	]);
});

/*
The per-record unpriced line is suppressed on a Backfill, and each distinct
unpriced model is named once with its count (spec #53).
*/
test('Unpriced models are aggregated once each in the summary', async t => {
	const root = transcriptTree(t, {
		'project-a/session.jsonl': HOOK_TURN,
		'project-a/later.jsonl': SECOND_TURN,
	});
	const store = new FakeBackfillStore();
	store.unpriced = true;

	const {stdout} = await runBackfill({root, store});

	t.deepEqual(stdout, [
		'scanned 2 transcripts, 2 candidates, 2 ingested, 0 duplicates dropped, 2 pushed, 0 remaining',
		'no pricing for kimi-k2.7-code; cost left null (2 records)',
	]);
});

/*
`usage backfill-opencode`, and the database it reads
---------------------------------------------------

The same shared runner, the same store and seam, over a fixture OpenCode
database instead of a tree of transcripts. The DB reader is
`usage-opencode.test.ts`'s subject; what is driven here is the command around
it — the OpenCode Harness literal, the message-row scan, `--dry-run`, `--since`,
and the same operator exit-1 contract.
*/

/*
One fixture OpenCode database, built with `node:sqlite` under the OS's temp
directory — never OpenCode's own — with one session and the assistant messages
the test names.
*/
function opencodeDatabase(
	t: ExecutionContext,
	messages: ReadonlyArray<{
		readonly id: string;
		readonly data: string;
		readonly timeCreated?: number;
	}>,
	parts: ReadonlyArray<{
		readonly id: string;
		readonly messageId: string;
		readonly data: string;
	}> = [],
): string {
	const directory = mkdtempSync(join(tmpdir(), 'jwoo-cli-backfill-test-'));
	t.teardown(() => {
		rmSync(directory, {recursive: true, force: true});
	});

	const path = join(directory, 'opencode.db');
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE session (
			id TEXT PRIMARY KEY,
			directory TEXT NOT NULL
		);
		CREATE TABLE message (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES session(id),
			time_created INTEGER NOT NULL,
			data TEXT NOT NULL
		);
		CREATE TABLE part (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL REFERENCES message(id),
			session_id TEXT NOT NULL REFERENCES session(id),
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL
		);
		INSERT INTO session (id, directory) VALUES ('ses_1', '/home/me/project');
	`);

	const insert = db.prepare(
		'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
	);
	for (const message of messages) {
		insert.run(
			message.id,
			'ses_1',
			message.timeCreated ?? 1_755_500_000_000,
			message.data,
		);
	}

	const insertPart = db.prepare(
		'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
	);
	let time = 1_755_500_000_000;
	for (const part of parts) {
		insertPart.run(part.id, part.messageId, 'ses_1', time, time, part.data);
		time += 1;
	}

	db.close();
	return path;
}

/*
One `usage backfill-opencode` invocation, with everything it reaches outside
itself stood in for.
*/
async function runOpencodeBackfill({
	database,
	since,
	dryRun = false,
	config = CONFIG,
	store = new FakeBackfillStore(),
	pusher = new FakeUsagePusher(),
}: {
	readonly database: string;
	readonly since?: Date;
	readonly dryRun?: boolean;
	readonly config?: Config;
	readonly store?: FakeBackfillStore;
	readonly pusher?: FakeUsagePusher;
}): Promise<BackfillRun> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let pusherBuilt = 0;

	const result = await runBackfillOpencode({
		database,
		since,
		dryRun,
		config,
		stdout(message) {
			stdout.push(message);
		},
		stderr(message) {
			stderr.push(message);
		},
		createUsageStore: () => store,
		createUsagePusher(backlog, onAttempt) {
			pusherBuilt += 1;
			pusher.attach(onAttempt, backlog);
			return pusher;
		},
	});

	return {store, pusher, stdout, stderr, ok: !result.failed, pusherBuilt};
}

/*
The demoable path: a database in, one record per assistant message out, with the
Harness literal the command owns and the summary counting message rows.
*/
test('an OpenCode Backfill reads every assistant message and summarizes it', async t => {
	const database = opencodeDatabase(t, [
		{id: 'msg_1', data: opencodeMessage()},
		{
			id: 'msg_2',
			data: opencodeMessage({
				id: 'msg_2',
				tokens: {input: 5, output: 2, cache: {read: 1, write: 0}},
			}),
		},
		{id: 'msg_3', data: opencodeMessage({id: 'msg_3', role: 'user'})},
	]);

	const {store, pusher, stdout, ok} = await runOpencodeBackfill({database});

	t.true(ok);
	t.is(store.records.length, 2, 'the user row is not a message we read');
	t.true(store.records.every(record => record.harness === 'OpenCode'));
	t.is(pusher.drains, 1);
	t.is(store.closes, 1);
	t.deepEqual(stdout, [
		'scanned 2 messages, 2 candidates, 2 ingested, 0 duplicates dropped, 2 pushed, 0 remaining',
	]);
});

/*
The same join the projection's tests drive: a message's tool `part` rows become
its stored Tool Call count, and a `skill` part contributes its name on the way
through the Backfill.
*/
test('an OpenCode Backfill stores the Tool Calls and Skills of each message', async t => {
	const database = opencodeDatabase(
		t,
		[{id: 'msg_1', data: opencodeMessage()}],
		[
			{
				id: 'prt_1',
				messageId: 'msg_1',
				data: JSON.stringify({
					type: 'tool',
					tool: 'read',
					state: {status: 'completed', input: {}},
				}),
			},
			{
				id: 'prt_2',
				messageId: 'msg_1',
				data: JSON.stringify({
					type: 'tool',
					tool: 'skill',
					state: {status: 'completed', input: {name: 'implement'}},
				}),
			},
		],
	);

	const {store} = await runOpencodeBackfill({database});

	t.is(store.records.length, 1);
	t.is(store.records[0]?.toolCalls, 2);
	t.deepEqual(store.records[0]?.skills, ['implement']);
});

/*
The drop rule is the same one, so a re-run over the same database adds nothing.
*/
test('re-running an OpenCode Backfill adds nothing', async t => {
	const database = opencodeDatabase(t, [
		{id: 'msg_1', data: opencodeMessage()},
	]);
	const store = new FakeBackfillStore();

	const first = await runOpencodeBackfill({database, store});
	const second = await runOpencodeBackfill({database, store});

	t.is(first.store.records.length, 1);
	t.is(second.store.records.length, 1, 'the drop rule held');
	t.deepEqual(second.stdout, [
		'scanned 1 messages, 1 candidates, 0 ingested, 1 duplicates dropped, 0 pushed, 0 remaining',
	]);
});

/*
`--dry-run` classifies against the real store and writes nothing, as it does
for Claude.
*/
test('a dry run of the OpenCode Backfill classifies and writes nothing', async t => {
	const database = opencodeDatabase(t, [
		{id: 'msg_1', data: opencodeMessage()},
	]);

	const {store, pusherBuilt, stdout, ok} = await runOpencodeBackfill({
		database,
		dryRun: true,
	});

	t.true(ok);
	t.deepEqual(store.records, []);
	t.is(pusherBuilt, 0);
	t.deepEqual(stdout, [
		'scanned 1 messages, 1 candidates, 1 would-ingest, 0 duplicates found',
	]);
});

/*
`--since` bounds each message by its own `recorded_at`; the row's `time_created`
is read either way, so `scanned` still counts it.
*/
test('--since filters OpenCode messages on their own recorded_at', async t => {
	const database = opencodeDatabase(t, [
		{id: 'msg_1', data: opencodeMessage()}, // 1_755_500_000_000
		{
			id: 'msg_2',
			data: opencodeMessage({id: 'msg_2', time: {created: 1_700_000_000_000}}),
		},
	]);

	const {store, stdout} = await runOpencodeBackfill({
		database,
		since: new Date(1_750_000_000_000),
	});

	t.is(store.records.length, 1);
	t.deepEqual(stdout, [
		'scanned 2 messages, 1 candidates, 1 ingested, 0 duplicates dropped, 1 pushed, 0 remaining',
	]);
});

/*
A database the reader cannot open is the Backfill's own failure — the same
operator convention, with a message naming the read rather than the scan.
*/
test('a database that cannot be opened fails the OpenCode Backfill', async t => {
	const database = join(tmpdir(), 'jwoo-cli-no-such-opencode.db');

	const {ok, stderr, store} = await runOpencodeBackfill({database});

	t.false(ok);
	t.regex(stderr[0] ?? '', /Could not read/v);
	t.is(store.closes, 1, 'the store is still closed on the failing path');
});

/*
`usage backfill-pi`, and the session logs it walks
--------------------------------------------------

The same shared runner, the same store and seam, over a tree of fixture pi
session files. The projection and the header gate are `usage-pi.test.ts`'s
subject; what is driven here is the command around them — the Pi Harness
literal, the recursive scan, `--dry-run`, `--since` and the same operator
exit-1 contract.
*/

/*
One fixture assistant message, in pi's own field names — `cacheRead`,
`cacheWrite1h`, `totalTokens` — with an ignored `totalTokens` so a test can
catch the projection trusting it.
*/
function piMessage(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		role: 'assistant',
		content: [],
		api: 'anthropic-messages',
		provider: 'acme',
		model: 'kimi-k2.7-code',
		usage: {
			input: 100,
			output: 50,
			cacheRead: 20,
			cacheWrite: 5,
			cacheWrite1h: 3,
			totalTokens: 999,
		},
		stopReason: 'stop',
		timestamp: 1_755_500_000_000,
		...overrides,
	};
}

function piEntry(
	id: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: 'message',
		id,
		parentId: null,
		timestamp: '2026-08-18T07:00:01.000Z',
		message: piMessage(overrides),
	};
}

function piHeader(cwd = '/projects/site'): Record<string, unknown> {
	return {
		type: 'session',
		version: 3,
		id: 'sess-1',
		timestamp: '2026-08-18T07:00:00.000Z',
		cwd,
	};
}

/*
One fixture sessions root, under the OS's temp directory — never pi's own —
with the session files the test names. Keys are relative paths, so a nested
per-run `session.jsonl` nests the way it does on disk.
*/
function piSessionsTree(
	t: ExecutionContext,
	files: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>,
): string {
	const root = mkdtempSync(join(tmpdir(), 'jwoo-cli-pi-backfill-test-'));
	t.teardown(() => {
		rmSync(root, {recursive: true, force: true});
	});

	for (const [relative, lines] of Object.entries(files)) {
		const file = join(root, relative);
		mkdirSync(dirname(file), {recursive: true});
		writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
	}

	return root;
}

/*
One `usage backfill-pi` invocation, with everything it reaches outside itself
stood in for.
*/
async function runPiBackfill({
	root,
	since,
	dryRun = false,
	config = CONFIG,
	store = new FakeBackfillStore(),
	pusher = new FakeUsagePusher(),
}: {
	readonly root: string;
	readonly since?: Date;
	readonly dryRun?: boolean;
	readonly config?: Config;
	readonly store?: FakeBackfillStore;
	readonly pusher?: FakeUsagePusher;
}): Promise<BackfillRun> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let pusherBuilt = 0;

	const result = await runBackfillPi({
		root,
		since,
		dryRun,
		config,
		stdout(message) {
			stdout.push(message);
		},
		stderr(message) {
			stderr.push(message);
		},
		createUsageStore: () => store,
		createUsagePusher(backlog, onAttempt) {
			pusherBuilt += 1;
			pusher.attach(onAttempt, backlog);
			return pusher;
		},
	});

	return {store, pusher, stdout, stderr, ok: !result.failed, pusherBuilt};
}

/*
The demoable path: a sessions tree in, one record per pi assistant message out,
with the Harness literal the command owns and the `cwd` the session header
carries. The nested per-run `session.jsonl` is a v3 session like any other and
comes in for free.
*/
test('a Pi Backfill reads every session and summarizes it', async t => {
	const root = piSessionsTree(t, {
		'project-a/2026-08-18_session.jsonl': [
			piHeader('/projects/site'),
			piEntry('m1'),
		],
		'project-a/run-1/run-0/session.jsonl': [
			piHeader('/projects/other'),
			piEntry('m2', {usage: {input: 5, output: 2, cacheRead: 1}}),
		],
	});

	const {store, pusher, stdout, ok} = await runPiBackfill({root});

	t.true(ok);
	t.is(store.records.length, 2);
	t.true(store.records.every(record => record.harness === 'Pi'));
	t.is(store.records[0]?.cwd, '/projects/site');
	t.is(store.records[1]?.cwd, '/projects/other');
	t.is(store.records[0]?.prompt_tokens, 128, 'input + both cache writes');
	t.is(store.records[0]?.total_tokens, 178, 'prompt + completion');
	t.is(pusher.drains, 1);
	t.is(store.closes, 1);
	t.deepEqual(stdout, [
		'scanned 2 sessions, 2 candidates, 2 ingested, 0 duplicates dropped, 2 pushed, 0 remaining',
	]);
});

/*
The drop rule is the same one, so a re-run over the same sessions adds nothing.
*/
test('re-running a Pi Backfill adds nothing', async t => {
	const root = piSessionsTree(t, {
		'session.jsonl': [piHeader(), piEntry('m1')],
	});
	const store = new FakeBackfillStore();

	const first = await runPiBackfill({root, store});
	const second = await runPiBackfill({root, store});

	t.is(first.store.records.length, 1);
	t.is(second.store.records.length, 1, 'the drop rule held');
	t.deepEqual(second.stdout, [
		'scanned 1 sessions, 1 candidates, 0 ingested, 1 duplicates dropped, 0 pushed, 0 remaining',
	]);
});

/*
The two paths share one projection, so a record the live Shim Ingested and the
same message read back out of the session file are the same candidate — the
store's content fingerprint drops the second, and a Backfill run after live
capture has begun adds nothing.
*/
test('a Pi Backfill after a live record adds nothing', async t => {
	const root = piSessionsTree(t, {
		'session.jsonl': [piHeader(), piEntry('m1')],
	});
	const store = new FakeBackfillStore();

	const live = await runPi(piRecordPayload(piMessage(), '/projects/site', []), {
		store,
	});
	const backfill = await runPiBackfill({root, store});

	t.is(live.store.records.length, 1);
	t.is(
		backfill.store.records.length,
		1,
		'the live record deduped the backfill',
	);
	t.deepEqual(backfill.stdout, [
		'scanned 1 sessions, 1 candidates, 0 ingested, 1 duplicates dropped, 0 pushed, 0 remaining',
	]);
});

/*
`--dry-run` classifies against the real store and writes nothing, as it does
for the other two.
*/
test('a dry run of the Pi Backfill classifies and writes nothing', async t => {
	const root = piSessionsTree(t, {
		'session.jsonl': [piHeader(), piEntry('m1')],
	});

	const {store, pusherBuilt, stdout, ok} = await runPiBackfill({
		root,
		dryRun: true,
	});

	t.true(ok);
	t.deepEqual(store.records, []);
	t.is(pusherBuilt, 0);
	t.deepEqual(stdout, [
		'scanned 1 sessions, 1 candidates, 1 would-ingest, 0 duplicates found',
	]);
});

/*
`--since` is both halves at once: a file whose mtime is older than the bound is
not read — so `scanned` counts what was read — and a read file still yields only
its messages at or after the bound.
*/
test('--since pre-skips a Pi session by mtime and filters each record', async t => {
	const root = piSessionsTree(t, {
		'project-a/old.jsonl': [piHeader(), piEntry('m1')],
		'project-a/new.jsonl': [
			piHeader(),
			piEntry('m2'),
			piEntry('m3', {timestamp: 1_700_000_000_000}),
		],
	});

	const old = new Date(1_700_000_000_000);
	utimesSync(join(root, 'project-a/old.jsonl'), old, old);

	const {store, stdout} = await runPiBackfill({
		root,
		since: new Date(1_750_000_000_000),
	});

	t.is(store.records.length, 1);
	t.deepEqual(stdout, [
		'scanned 1 sessions, 1 candidates, 1 ingested, 0 duplicates dropped, 1 pushed, 0 remaining',
	]);
});

/*
A sessions root the walk cannot read is the Backfill's own failure, so it
resolves false — which `cli.tsx` turns into exit 1 — and says why on stderr.
*/
test('a sessions root that cannot be scanned fails the Pi Backfill', async t => {
	const root = join(tmpdir(), 'jwoo-cli-no-such-pi-sessions');

	const {ok, stderr, store} = await runPiBackfill({root});

	t.false(ok);
	t.regex(stderr[0] ?? '', /Could not scan/v);
	t.is(store.closes, 1, 'the store is still closed on the failing path');
});

/*
The per-record unpriced line is suppressed on a Backfill, and each distinct
unpriced model is named once with its count (ADR-0015).
*/
test('Unpriced Pi models are aggregated once each in the summary', async t => {
	const root = piSessionsTree(t, {
		'a.jsonl': [piHeader(), piEntry('m1')],
		'b.jsonl': [piHeader(), piEntry('m2', {usage: {input: 1, output: 1}})],
	});
	const store = new FakeBackfillStore();
	store.unpriced = true;

	const {stdout} = await runPiBackfill({root, store});

	t.deepEqual(stdout, [
		'scanned 2 sessions, 2 candidates, 2 ingested, 0 duplicates dropped, 2 pushed, 0 remaining',
		'no pricing for kimi-k2.7-code; cost left null (2 records)',
	]);
});
