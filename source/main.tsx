/*
What each subcommand does.

The composition root, and the only place a `MongoClient` is built. It owns the
client's lifetime and closes it on every path, because a client left open keeps
the process alive after the work has finished.

The pieces arrive as options rather than being reached for directly: this module
is where permission, store, state and Collector meet, and a test that had to
build a real one of each could not check the meeting. `cli.tsx` is the caller
that supplies the real ones.

The Collectors are one of those pieces, and their default is here rather than in
the entry point (ADR-0008). Which Collector owns which event is a decision about
collection, and the entry point is a module that runs the CLI on import — so a
switch kept there was reached by no test at all.
*/

import process from 'node:process';
import {type Command} from './args.js';
import {type Config, loadConfig} from './config.js';
import {
	defaultHelperStderr,
	defaultProblemReporter,
	EventStream as HelperStream,
	requestInputMonitoring as askForInputMonitoring,
	type StreamProblem,
	type StreamSinks,
} from './helper.js';
import {MongoHistorySource, type HistorySource} from './history.js';
import {type ReadWarning, type ReadWarningReporter} from './local-store.js';
import {KeyboardCollector} from './keyboard.js';
import {MouseCollector} from './mouse.js';
import {type PermissionReport, type PermissionSource} from './permissions.js';
import {type RawEvent} from './raw-event.js';
import {
	collectionEntry,
	flushEntry,
	helperEntry,
	historyEntry,
	InProcessRunLogSource,
	type RunLogSource,
	storageEntry,
} from './run-log.js';
import {
	type Collector,
	CollectionSession,
	type EventStream,
	type FlushAttempt,
	processSignal,
	type Shutdown,
	type ShutdownSignal,
} from './session.js';
import {TelemetryState} from './state.js';
import {MongoTelemetryStore, type TelemetryStore} from './storage.js';
import {InProcessTelemetrySource, type TelemetrySource} from './telemetry.js';

/*
What a factory hands back: the Collectors, and the helper stream they read if
they read one.

The stream is part of the answer rather than a separate option because whether
there is one at all is the same question as whether there are Collectors. A
denied grant means no Collectors, and a stream started anyway would spawn a
helper with no tap to open — which reports an exit and a problem on the
degraded path that is supposed to be quiet.
*/
export type CollectorSetup = {
	readonly collectors: readonly Collector[];
	readonly stream?: EventStream;
};

/*
The helper's stream as the wiring reaches for it: the Session's slice of it,
plus the one thing the Collectors need, which is somewhere to attach the handler
their events arrive on.

Structural rather than the class in `helper.ts`, which has private fields
and so cannot be stood in for — and a stand-in is the whole point of the seam.
*/
export type EventSource = EventStream & {
	onEvent(handler: (event: RawEvent) => void): void;
};

/*
Given the preflight report, hands back the Collectors that should run. The
decision about what a missing grant disables stays in `permissions.ts` — the
report names it — and the factory only decides what to build, or whether to
build nothing at all.

The state is handed over rather than built by the factory, because the Session
flushes *this* state. A factory that built its own would give the Collectors
somewhere to count that nothing ever reads: the Session's own state would report
no activity, `run()` skips a Flush entirely on that, and the run would end
cleanly having written nothing at all.
*/
export type CollectorFactory = (
	report: PermissionReport,
	state: TelemetryState,
) => CollectorSetup;

/*
What the default factory reaches outside itself for, and the whole reason it is
reachable from a test: the stream the Collectors read, the grant they need, and
where the helper's own failure lines go. A granted run can then be driven end to
end with a stream of the caller's own, and a denied one watched asking for the
grant, without a capture process and without a TCC prompt (ADR-0002).

All of them are what a real run wants when nothing is supplied, so none is
required.
*/
export type CollectorFactoryOptions = {
	/*
	The stream the Collectors read, built with the sinks its byproducts go to.
	The default is the real one, which spawns the helper lazily in its own
	`start()` and never before.

	The sinks are handed over rather than reached for afterwards because both are
	settled when a stream is built: a helper that could not run, a line of stdout
	that would not parse and an exit are reported by the stream itself, and so is
	the helper's own stderr as it arrives. A caller building one of its own
	reports them where it was told to — which is the only way the dashboard can
	keep them off the terminal (ADR-0010).
	*/
	readonly createStream?: (sinks: StreamSinks) => EventSource;
	/*
	Called once, on a run whose report says the grant is missing. macOS will not
	show the prompt to a process with nobody at the keyboard, so the one run
	that asks is the one where the user has just been told it is absent.
	*/
	readonly requestInputMonitoring?: () => void;
	/*
	Where the helper's problems go: its own failure line, a line of stdout that
	would not parse, and its exit. A caller that wants to see that one happened,
	or to keep it out of a test's output, supplies this.

	The failure line arrives as an event like any other and is owned by no
	Collector, so the wiring that consumes the stream is what reports it
	(ADR-0008). It defaults to a stderr warning, because a failure that reached
	nothing would leave a run looking exactly like an idle machine — and the
	dashboard, which has a frame to keep whole, appends Run Log entries instead.
	*/
	readonly onProblem?: (problem: StreamProblem) => void;
	/*
	Where the helper's own diagnostics go: the tap's notes, written to its
	stderr. Passed through to this process's stderr by default, which is what a
	terminal run wants, and dropped by the dashboard, where anything arriving
	mid-draw corrupts the frame (ADR-0010).
	*/
	readonly onHelperStderr?: (chunk: string) => void;
};

/*
The default factory: which Collectors the grant allows, and the stream they
read.

Nothing here exits on `disabled`: a machine whose grant is missing still runs,
reports the grant, and waits to be stopped, which is what keeps this the same
shape as any other degraded run.
*/
export function defaultCollectorFactory({
	createStream,
	requestInputMonitoring = askForInputMonitoring,
	onProblem = defaultProblemReporter,
	onHelperStderr = defaultHelperStderr,
}: CollectorFactoryOptions): CollectorFactory {
	/*
	The default stream is built here rather than as a default above, because it
	has to be told where its byproducts go and only this has read that yet. It
	is handed the same sinks the caller's would be, so there is one rule rather
	than one for each: whatever builds the stream says where they go, and the
	helper is where they land.
	*/
	const sinks: StreamSinks = {onProblem, onHelperStderr};
	const buildStream =
		createStream ?? ((where: StreamSinks) => new HelperStream(where));

	return (report, state) => {
		if (report.status !== 'granted') {
			requestInputMonitoring();
			/*
			No stream either. A denied grant means no tap, so a helper started
			anyway would have nothing to open, exit, and report itself as a
			problem on a path that is meant to degrade quietly.
			*/
			return {collectors: []};
		}

		/*
		Constructed, not started. The helper is spawned by the Session, through
		the stream it owns — nothing about building the Collectors should open a
		process: a run stopped before it starts would then leave one behind, and
		owning that lifetime is the Session's whole job.
		*/
		const stream = buildStream(sinks);

		return {collectors: collectorsOver(stream, state, onProblem), stream};
	};
}

/*
A Collector as the wiring needs it: the `start()`/`stop()` the Session asks for,
and the `handle()` the events arrive on.

Declared here rather than widened into `session.ts`, because the Session starts
and stops a Collector and nothing else (ADR-0001) — delivery is the composition
root's business (ADR-0008).
*/
type EventCollector = Collector & {
	handle(event: RawEvent): void;
};

/*
Both Collectors read the one tap, so both are built over one stream. Spawning
per Collector would mean two taps racing on the same events and two grants to
keep (ADR-0006).

Both also count into the one Telemetry State the Session flushes, which arrives
as an argument rather than being built here. Building one here would compile,
run, and write nothing at all.

Delivery is a loop over the Collectors rather than a switch that decides between
them, which is the whole of ADR-0008: nothing here states which Collector owns
which event, each is shown all of them and ignores by name what it does not own,
and a new Collector is a new entry in the list below and no edit anywhere else.
*/
function collectorsOver(
	stream: EventSource,
	state: TelemetryState,
	onProblem: (problem: StreamProblem) => void,
): EventCollector[] {
	const collectors: EventCollector[] = [
		new KeyboardCollector({state}),
		new MouseCollector({state}),
	];

	/*
	Wired before the stream can start. The Session starts the stream and then
	the Collectors, so a listener attached afterwards would miss whatever
	arrived in between — and losing input is the one thing a Collector must not
	do quietly.
	*/
	stream.onEvent(event => {
		for (const collector of collectors) {
			collector.handle(event);
		}

		/*
		The helper's own failure line, which is an event like any other: the
		Collectors have just been shown it and none of them owns it. It is on
		stdout rather than stderr precisely so it cannot be missed, and it belongs
		with the stream's own problems — both are statements about why there is no
		input rather than about a key or a click.
		*/
		if (event.type === 'error') {
			onProblem({kind: 'error-line', error: event});
		}
	});

	return collectors;
}

export type Logger = Pick<Console, 'log' | 'warn'>;

/*
What the dashboard needs to draw itself, handed over as one object because it is
one decision: the view draws three sources, and which sources those are is what
the composition root decides. The Run Log arrives as its reading face — a view
can see what the run did and cannot add to it.

`ended` is the run's lifetime as the view sees it. A run can end without the
view asking — a SIGTERM while the dashboard is open — and a frame left on screen
afterwards would go on claiming to be live.
*/
export type DashboardView = {
	readonly history: HistorySource;
	readonly telemetry: TelemetrySource;
	readonly runLog: RunLogSource;
	readonly timeZone: string;
	/*
	When the run began, read here rather than in the view. The live view's totals
	are counted from this instant, so it belongs to the run and not to the frame
	that draws it — the same reason a Run Log entry's `at` is stamped out here.
	*/
	readonly startedAt: Date;
	readonly ended: Promise<void>;
};

export type RunOptions = CollectorFactoryOptions & {
	readonly permissions: PermissionSource;
	/*
	Which Collectors run, and the stream they read if they read one. Absent from
	a CLI run, which wants the default — and `cli.tsx`, which still supplies the
	permission source, no longer supplies this (ADR-0008).

	The stream is not an option of its own beside this one. Whether there is one
	at all is the same question as whether there are Collectors, and a stream
	supplied here but not known to the factory would be one that nothing is
	reading: a run that starts every Collector and feeds it no events.
	*/
	readonly collectors?: CollectorFactory;
	readonly shutdown?: ShutdownSignal;
	readonly logger?: Logger;
	/*
	The write seam as the composition root reaches for it, built with the logger
	its warnings go to — the shape `createHistorySource` has, and for the same
	reason. What the seam reports is settled when it is built, so a caller
	building one of its own reports where it was told to; that is what lets a
	test drive a TTL index the server would not create to an entry, or to the
	terminal, without a database. There is no test **server** in this repo, and
	the store builds a `MongoClient`.
	*/
	readonly createStore?: (logger: Pick<Console, 'warn'>) => TelemetryStore;
	/*
	The read seam as the dashboard reaches for it, built with the reporter its
	warnings go to — the shape `createStream` has, and for the same reason. What
	the seam reports is settled when it is built, so a caller building one of
	its own reports where it was told to; that is what lets a test drive the
	routing without a database, and what the source the dashboard supplies is.
	*/
	readonly createHistorySource?: (
		onWarning: ReadWarningReporter,
	) => HistorySource;
	readonly state?: TelemetryState;
	/*
	The Run Log the run appends to. An option for the reason `state` is one: a
	test that wants to see what a run recorded supplies its own and reads it
	afterwards, and in `collect` — where there is no view to read one — that is
	the only way to see it at all.
	*/
	readonly runLog?: InProcessRunLogSource;
	/*
	An option so a test can set a Flush Interval without an environment to load
	one from. `loadConfig` reads the real environment, and the tests have none.
	*/
	readonly config?: Config;
	/*
	The dashboard's one dependency on ink, as an option for the same reason as
	the rest: mounting a real Ink root needs a TTY, and what this module owns is
	the sources' lifetime rather than the view.
	*/
	readonly renderApp?: (view: DashboardView) => Promise<void>;
};

/*
Both permissions and collection. Exported so the preflight can be exercised on
its own — it is the answer to a question the user can ask without collecting.
*/
export async function runPermissions(
	options: RunOptions,
	{announceGranted = false}: {announceGranted?: boolean} = {},
): Promise<PermissionReport> {
	const logger = options.logger ?? console;
	const report = await options.permissions.preflight();

	/*
	Silent in `collect`, where a granted grant is the unremarkable case and a
	line about it would be noise on every start. The `permissions` subcommand is
	the one that was *asked*, so it answers either way.
	*/
	if (report.status === 'granted') {
		if (announceGranted) {
			logger.log('Input Monitoring is granted.');
		}

		return report;
	}

	for (const {note} of report.disabled) {
		logger.warn(note);
	}

	logger.log(report.message);

	return report;
}

/*
The Telemetry State a run counts into, built once and handed to the Collectors
as well as to the Session. Two states is the quiet failure this arrangement
exists to prevent, and it is quieter than it looks: the Session skips a Flush
when its own state has no activity, so a run counting into a different state
writes nothing, flushes nothing, and still reports success.

The DPI comes from Config for the same reason. Mouse Distance is pixels over
DPI, and `addMouseMovement` applies it — against the DPI *this* state was built
with, not the one the Collector might have preferred.
*/
function stateFor(options: RunOptions, config: Config): TelemetryState {
	return options.state ?? new TelemetryState({mouseDpi: config.mouseDpi});
}

/*
The Session, built the same way whichever command asked for one.

A missing grant degrades collection rather than stopping the CLI: the factory is
given the report and builds only what it allows, and whatever it does build
still runs. Nothing here exits on `disabled`.

The factory is the one supplied or the default, which is what makes the default
reachable by a test rather than only by running the CLI. The stream comes back
from it rather than from an option of its own — see `CollectorSetup`.
*/
function sessionFor(
	options: RunOptions,
	{
		config,
		state,
		report,
		runLog,
		problemReporter,
		helperStderr,
		storeLogger,
		onFlush,
	}: {
		readonly config: Config;
		readonly state: TelemetryState;
		readonly report: PermissionReport;
		readonly runLog: InProcessRunLogSource;
		/*
		Where the helper's problems go on a run whose caller supplied no reporter
		of its own. Left out by `collect`, which keeps the stderr reporter it has
		always had; the dashboard appends entries instead, because the frame is
		the only output there.
		*/
		readonly problemReporter?: (problem: StreamProblem) => void;
		/*
		Where the helper's own diagnostics go, on the same terms: left out by
		`collect`, which passes them through to the terminal it always has, and a
		sink that drops them in dashboard mode, where a line arriving mid-draw
		corrupts the frame (ADR-0010).
		*/
		readonly helperStderr?: (chunk: string) => void;
		/*
		Where the write seam's warnings go. Left out by `collect`, which keeps
		the store's own default — a line on stderr; the dashboard appends
		entries, which is what puts a TTL index the server would not create in
		the Run Log rather than in the middle of the frame.
		*/
		readonly storeLogger?: Pick<Console, 'warn'>;
		/*
		Whatever else wants to hear about a Flush, which is the live view — the
		one observer whose counters depend on whether the write landed.
		*/
		readonly onFlush?: (attempt: FlushAttempt) => void;
	},
): CollectionSession {
	/*
	A sink the caller supplied is the one that runs — a caller that asked to
	receive these itself has said where it wants them — so the mode's is the
	default and not the rule. The `undefined` of a mode that left one out is
	what `defaultCollectorFactory` reads as "the stderr one".
	*/
	const factoryOptions: CollectorFactoryOptions = {
		...options,
		onProblem: options.onProblem ?? problemReporter,
		onHelperStderr: options.onHelperStderr ?? helperStderr,
	};
	const setup = (options.collectors ?? defaultCollectorFactory(factoryOptions))(
		report,
		state,
	);

	/*
	Built with the logger its warnings go to, whichever builder is used: a
	caller's own receives it, and so does the real store — which is the whole of
	what keeps a TTL index it could not create off the frame (ADR-0010).
	`console` when nothing said otherwise, which is the store's own default and
	what a headless run keeps.
	*/
	const buildStore =
		options.createStore ??
		((logger: Pick<Console, 'warn'>) =>
			new MongoTelemetryStore(config, undefined, {logger}));

	return new CollectionSession({
		store: buildStore(storeLogger ?? console),
		state,
		collectors: setup.collectors,
		stream: setup.stream,
		flushIntervalSeconds: config.flushIntervalSeconds,
		shutdown: options.shutdown ?? processSignal,
		/*
		The Run Log is written here rather than by an observer, because both
		commands record Flushes and only one of them has a view to hear about
		them. A Flush is attempted only when there was Activity, so these are
		attempts and not intervals (CONTEXT.md).
		*/
		onFlush(attempt) {
			runLog.append(flushEntry(attempt));
			onFlush?.(attempt);
		},
	});
}

/*
The write seam's warnings, as Run Log entries.

A logger rather than a reporter, because a logger is the shape the store offers
and it is not the store's business whether there is a frame to keep quiet. What
it raises through one is a TTL index it could not create — raised as it is
built, before any Flush has happened — and in dashboard mode that is an entry
rather than a line of stderr in the middle of the drawing (ADR-0010).

The extra arguments a warning was given are kept, because they are where a
driver's error travels.
*/
function storeLoggerFor(runLog: InProcessRunLogSource): Pick<Console, 'warn'> {
	return {
		warn(message: string, ...extra: unknown[]) {
			runLog.append(storageEntry(message, extra, new Date()));
		},
	};
}

/*
The end of a run, reported the same way whichever command was running.

A final Flush that failed means the counters were still in Telemetry State when
the store closed, so they are gone and the run did not end cleanly. Said
plainly, and as a non-zero exit code, because a shell reads the exit code and
not the log.
*/
function reportShutdown({signal, finalFlush}: Shutdown, logger: Logger): void {
	if (!finalFlush) {
		logger.warn(
			'The final Flush failed; the counters since the last Flush were lost.',
		);
		process.exitCode = 1;
		return;
	}

	logger.log(
		signal === undefined
			? 'Stopped.'
			: `Received ${signal}; flushed and stopped.`,
	);
}

async function runCollect(options: RunOptions): Promise<void> {
	const logger = options.logger ?? console;
	const config = options.config ?? loadConfig();
	const {runLog, report} = await preflightWithLog(options);
	const session = sessionFor(options, {
		config,
		state: stateFor(options, config),
		report,
		runLog,
		/*
		A headless run has no frame to keep whole, so a Flush that failed is a
		line on stderr. It is said from the attempt the Session reports rather
		than by the Session or the store, because this is the one place that
		knows which command it is answering (ADR-0010).

		A failed *final* Flush is then warned about twice — here, and once more
		by `reportShutdown` below — which is the shape this has always had, and
		the two lines say different things: one that the write failed, the other
		that the counters were lost with it.
		*/
		onFlush(attempt) {
			if (!attempt.ok) {
				logger.warn('Flush failed; counters will retry on the next Flush');
			}
		},
	});

	reportShutdown(await session.run(), logger);
}

/*
The preflight, and the Run Log it leaves behind.

One place rather than one per command, because the order is the whole of it: the
log is built before the preflight runs, so that a run starting with no grant has
the entry in it before the first frame is drawn. A third command would otherwise
have to know that, and the way to get it wrong looks like nothing at all.

Built in `collect` too, even though nothing draws it: the Run Log is the record
of a run, and a `collect` run is one. Nothing reads it back there — the terminal
is where a headless run reports, and its exit code is what a shell reads — but a
caller that supplied one can see afterwards what the run found.
*/
async function preflightWithLog(
	options: RunOptions,
): Promise<{runLog: InProcessRunLogSource; report: PermissionReport}> {
	const runLog = options.runLog ?? new InProcessRunLogSource();
	const report = await runPermissions(options);

	/*
	Only where there is something to say. A run that was granted starts with an
	empty log, which the block draws as "nothing yet" — a line about a check that
	passed would be an entry about nothing happening.
	*/
	if (report.status === 'disabled') {
		runLog.append(collectionEntry(report, new Date()));
	}

	return {runLog, report};
}

/*
The TUI, which collects while it is open. The alternative — a dashboard that
draws counters nothing is counting into — is a view that is empty by
construction, and `collect` is already the way to run without a dashboard.

Both sources are built here and handed down rather than constructed inside a
component: the load effect is keyed on the history source, so a new identity per
render would reload forever.

`tui.js` is reached through a dynamic import rather than a static one, and that
is load-bearing rather than tidy: it is the module that pulls in ink and react,
and `collect` must not load either (ADR-0001).
*/
async function runDashboard(options: RunOptions): Promise<void> {
	const logger = options.logger ?? console;
	const config = options.config ?? loadConfig();
	/*
	The same instance the view reads, because the log the wiring appends to and
	the one on screen have to be one object — or the block would show a run that
	never did anything.

	The dashboard runs the same preflight `collect` does, and it is not only for
	the Collectors: the report is what lets the live view say "collection is
	disabled" rather than draw zeroes, which are the same numbers and not the
	same thing.
	*/
	const {runLog, report} = await preflightWithLog(options);
	const state = stateFor(options, config);
	const telemetry = new InProcessTelemetrySource({report, state});
	const session = sessionFor(options, {
		config,
		state,
		report,
		runLog,
		/*
		The helper's problems become entries rather than lines of stderr, which
		would land in the middle of the frame. Appended here and not in a view:
		an entry is a fact about the run, and the block polls what it finds.
		*/
		problemReporter(problem) {
			runLog.append(helperEntry(problem, new Date()));
		},
		/*
		The helper's other output goes nowhere at all. Its notes — a tap
		re-enabled, the listener announcing itself — are written to stderr for a
		terminal to read, and a frame has no room for them: Ink draws by
		overwriting the lines it last drew, so a line landing mid-draw leaves the
		rest of the frame off by one from where Ink thinks it is. Nothing that
		matters goes with it — a statement about collection arrives as an event
		on stdout, and those become entries.
		*/
		helperStderr: discardHelperStderr,
		/*
		The write seam's warnings, likewise: entries rather than lines of
		stderr.
		*/
		storeLogger: storeLoggerFor(runLog),
		onFlush(attempt) {
			telemetry.recordFlush(attempt);
		},
	});

	/*
	The read seam's warnings become entries, as the helper's do and for the same
	reason: the dashboard lands on the history view, and the sentence a failed
	read carries is a fact about this run rather than about the range on screen.
	The view draws a pointer and the log holds the whole of it — drawn in both
	places it would be one failure said twice, one of them across the frame.
	*/
	const reportReadWarning = (warning: ReadWarning): void => {
		runLog.append(historyEntry(warning, new Date()));
	};

	const source =
		options.createHistorySource?.(reportReadWarning) ??
		new MongoHistorySource(config, undefined, {onWarning: reportReadWarning});

	/*
	A statement rather than `options.renderApp ?? (await import(...)).renderApp`,
	which would import ink on every path — including the one where the caller
	supplied a renderer precisely so that it would not.
	*/
	let render = options.renderApp;
	if (render === undefined) {
		({renderApp: render} = await import('./tui.js'));
	}

	/*
	When the run began: the instant before the Session starts the Collectors,
	which is the moment the live view's totals count from. Taken here, next to
	the call that begins the run, so it is that instant rather than whenever a
	frame happened to be drawn — a dashboard that opens slowly still says when
	the run it is drawing began.
	*/
	const startedAt = new Date();

	/*
	Started before the view is mounted, so the counters are already moving by the
	time the first frame is drawn.
	*/
	const running = session.run();

	/*
	`run()`, saying only *that* it ended rather than how. The view has to come
	down when a signal ends the run, and the rejection has to be claimed here or
	a Collector that could not start would end the process outright, before the
	`await` below can report it as the failure it is.
	*/
	const ended = running.then(noop).catch(noop);

	try {
		await render({
			history: source,
			telemetry,
			runLog,
			timeZone: config.timeZone,
			startedAt,
			ended,
		});
	} finally {
		/*
		Stopped rather than left to a signal: `q` arrives as input in a raw-mode
		terminal and never generates one, so this is the only thing that knows the
		view has gone.
		*/
		await session.stop();
		await source.close();
	}

	reportShutdown(await running, logger);
}

/*
A no-op rather than an arrow, because the lint rule that forbids an empty
function body is the point: there is genuinely nothing to do here, and one name
says so once.
*/
function noop(): void {
	// See the call site: the failure is reported by `await running`, not here.
}

/*
A sink that drops what it is handed, for the one caller that wants one: the
helper's stderr under a frame. Named rather than an arrow for the same reason
`noop` is — an empty body is the intent here, and a name is what says so.
*/
function discardHelperStderr(): void {
	// See the call site: the helper's notes have nowhere to go under a frame.
}

export async function run(
	command: Command,
	options: RunOptions,
): Promise<void> {
	switch (command.kind) {
		case 'dashboard': {
			return runDashboard(options);
		}

		case 'collect': {
			return runCollect(options);
		}

		case 'permissions': {
			await runPermissions(options, {announceGranted: true});
		}
	}
}
