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
	defaultProblemReporter,
	EventStream as HelperStream,
	requestInputMonitoring as askForInputMonitoring,
} from './event-stream.js';
import {MongoHistorySource, type HistorySource} from './history.js';
import {KeyboardCollector} from './keyboard.js';
import {MouseCollector} from './mouse.js';
import {type PermissionReport, type PermissionSource} from './permissions.js';
import {type RawEvent} from './raw-event.js';
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

Structural rather than the class in `event-stream.ts`, which has private fields
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
The two things the default factory reaches outside itself for, and the whole
reason it is reachable from a test: the stream the Collectors read, and the
grant they need. A granted run can then be driven end to end with a stream of
the caller's own, and a denied one watched asking for the grant, without a
capture process and without a TCC prompt (ADR-0002).

Both are what a real run wants when nothing is supplied, so neither is required.
*/
export type CollectorFactoryOptions = {
	/*
	The stream the Collectors read. The default is the real one, which spawns
	the helper lazily in its own `start()` and never before.
	*/
	readonly createStream?: () => EventSource;
	/*
	Called once, on a run whose report says the grant is missing. macOS will not
	show the prompt to a process with nobody at the keyboard, so the one run
	that asks is the one where the user has just been told it is absent.
	*/
	readonly requestInputMonitoring?: () => void;
};

/*
The default factory: which Collectors the grant allows, and the stream they
read.

Nothing here exits on `disabled`: a machine whose grant is missing still runs,
reports the grant, and waits to be stopped, which is what keeps this the same
shape as any other degraded run.
*/
export function defaultCollectorFactory({
	createStream = () => new HelperStream({}),
	requestInputMonitoring = askForInputMonitoring,
}: CollectorFactoryOptions): CollectorFactory {
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
		const stream = createStream();

		return {collectors: collectorsOver(stream, state), stream};
	};
}

/*
Both Collectors read the one tap, so both are built over one stream. Spawning
per Collector would mean two taps racing on the same events and two grants to
keep (ADR-0006).

Both also count into the one Telemetry State the Session flushes, which arrives
as an argument rather than being built here. Building one here would compile,
run, and write nothing at all.

The switch below is where event ownership is stated, and it is stated here
rather than in the entry point so that a test executes it (ADR-0008). It is not
where that decision leaves it — the end state is delivery to every Collector,
each ignoring what it does not own — and the change that gets there is #14.
*/
function collectorsOver(
	stream: EventSource,
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

export type Logger = Pick<Console, 'log' | 'warn'>;

/*
What the dashboard needs to draw itself, handed over as one object because it is
one decision: the view draws two sources, and which sources those are is what
the composition root decides.

`ended` is the run's lifetime as the view sees it. A run can end without the
view asking — a SIGTERM while the dashboard is open — and a frame left on screen
afterwards would go on claiming to be live.
*/
export type DashboardView = {
	readonly history: HistorySource;
	readonly telemetry: TelemetrySource;
	readonly timeZone: string;
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
	The store and the history source are options for the same reason the rest
	are, and each one builds a `MongoClient`: a test of the dispatch should not
	need a database, and there is no test database in this repo.
	*/
	readonly store?: TelemetryStore;
	readonly historySource?: HistorySource;
	readonly state?: TelemetryState;
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
		logger,
		onFlush,
	}: {
		readonly config: Config;
		readonly state: TelemetryState;
		readonly report: PermissionReport;
		readonly logger: Logger;
		readonly onFlush?: (attempt: FlushAttempt) => void;
	},
): CollectionSession {
	const setup = (options.collectors ?? defaultCollectorFactory(options))(
		report,
		state,
	);

	return new CollectionSession({
		store: options.store ?? new MongoTelemetryStore(config),
		state,
		collectors: setup.collectors,
		stream: setup.stream,
		flushIntervalSeconds: config.flushIntervalSeconds,
		shutdown: options.shutdown ?? processSignal,
		logger,
		onFlush,
	});
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
	const report = await runPermissions(options);
	const session = sessionFor(options, {
		config,
		state: stateFor(options, config),
		report,
		logger,
	});

	reportShutdown(await session.run(), logger);
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
	The dashboard runs the same preflight `collect` does, and it is not only for
	the Collectors: the report is what lets the live view say "collection is
	disabled" rather than draw zeroes, which are the same numbers and not the
	same thing.
	*/
	const report = await runPermissions(options);
	const state = stateFor(options, config);
	const telemetry = new InProcessTelemetrySource({report, state});
	const session = sessionFor(options, {
		config,
		state,
		report,
		logger,
		onFlush(attempt) {
			telemetry.recordFlush(attempt);
		},
	});

	const source = options.historySource ?? new MongoHistorySource(config);
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
			timeZone: config.timeZone,
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
