/*
What each subcommand does.

The composition root, and the only place a `MongoClient` is built. It owns the
client's lifetime and closes it on every path, because a client left open keeps
the process alive after the work has finished.

The pieces arrive as options rather than being reached for directly: this module
is where permission, store, state and Collector meet, and a test that had to
build a real one of each could not check the meeting. `cli.tsx` is the caller
that supplies the real ones.
*/

import process from 'node:process';
import {type Command} from './args.js';
import {type Config, loadConfig} from './config.js';
import {MongoHistorySource, type HistorySource} from './history.js';
import {type PermissionReport, type PermissionSource} from './permissions.js';
import {
	type Collector,
	CollectionSession,
	processSignal,
	type ShutdownSignal,
} from './session.js';
import {TelemetryState} from './state.js';
import {MongoTelemetryStore, type TelemetryStore} from './storage.js';

/*
Given the preflight report, hands back the Collectors that should run. The
decision about what a missing grant disables stays in `permissions.ts` — the
report names it — and the factory only decides what to build, or whether to
build nothing at all.
*/
export type CollectorFactory = (report: PermissionReport) => Collector[];

export type Logger = Pick<Console, 'log' | 'warn'>;

export type RunOptions = {
	readonly permissions: PermissionSource;
	readonly collectors: CollectorFactory;
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
	the source's lifetime rather than the view.
	*/
	readonly renderApp?: (source: HistorySource) => Promise<void>;
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

async function runCollect(options: RunOptions): Promise<void> {
	const logger = options.logger ?? console;
	const config = options.config ?? loadConfig();
	const report = await runPermissions(options);

	const session = new CollectionSession({
		store: options.store ?? new MongoTelemetryStore(config),
		state: options.state ?? new TelemetryState(),
		/*
		A missing grant degrades collection rather than stopping the CLI: the
		factory is given the report and builds only what it allows, and whatever
		it does build still runs. Nothing here exits on `disabled`.
		*/
		collectors: options.collectors(report),
		flushIntervalSeconds: config.flushIntervalSeconds,
		shutdown: options.shutdown ?? processSignal,
		logger,
	});

	const {signal, finalFlush} = await session.run();

	if (!finalFlush) {
		/*
		The counters were still in Telemetry State when the store closed, so they
		are gone and the run did not end cleanly. Said plainly, and as a non-zero
		exit code, because a caller or a shell is otherwise told the opposite.
		*/
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

/*
The TUI. `source` is built here and handed down rather than constructed inside a
component: the load effect is keyed on it, so a new identity per render would
reload forever.

`tui.js` is reached through a dynamic import rather than a static one, and that
is load-bearing rather than tidy: it is the module that pulls in ink and react,
and `collect` must not load either (ADR-0001).
*/
async function runDashboard(options: RunOptions): Promise<void> {
	const source =
		options.historySource ??
		new MongoHistorySource(options.config ?? loadConfig());
	/*
	A statement rather than `options.renderApp ?? (await import(...)).renderApp`,
	which would import ink on every path — including the one where the caller
	supplied a renderer precisely so that it would not.
	*/
	let render = options.renderApp;
	if (render === undefined) {
		({renderApp: render} = await import('./tui.js'));
	}

	try {
		await render(source);
	} finally {
		await source.close();
	}
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
