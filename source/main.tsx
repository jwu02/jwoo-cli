/*
What each subcommand does.

The composition root, and the only place the Pusher is built — which is what
builds the `MongoClient` — and the only place the Local Store is opened. It owns
both lifetimes and closes them on every path, because a client left open keeps
the process alive after the work has finished.

There is one run skeleton, and the commands that collect differ from each other
by a **mode**: one value carrying where their reports go and how their run ends.
`collect` and the dashboard are the two modes. A mode is not a command —
`permissions` answers a question and never opens a Session, so it is a command
with no mode at all.

The Local Store is opened before the preflight and before anything is drawn, and
that order is the whole of ADR-0012's fail-fast rule: it is the one write a Flush
is required to reach, so a store that cannot be opened is a run that would spend
hours collecting into a retry that can never succeed. The Pusher's half of the
same order is the reverse — MongoDB is best-effort, so a Pusher that cannot reach
it, or cannot be built at all, is a run that carries on.

Nine entry points stand at the top of it — `runCollect`, `runDashboard`,
`runPermissions`, `runRecordClaudeHook`, `runRecordOpencode`, `runRecordPi`,
`runBackfillClaude`, `runBackfillOpencode` and `runBackfillPi` — one per
command, each taking no
more than the command reads and each named for what it runs. Which one a command
line means is decided a module up, in `cli.tsx`, which is also the only caller
that supplies the real permissions source: nothing here imports the command
type, so a pairing of command and entry point cannot be stated twice and drift.

The usage commands are the ones that do not collect: each reads one Harness's
artifact — from stdin, or from the projects directory or database a Backfill
scans — Ingests what it projects and Drains the Usage Backlog, and owns none of
the run skeleton above — which is why their section is its own, and why their
store type is a narrower slice of the same file.

The pieces arrive as options rather than being reached for directly: this module
is where permission, store, state and Collector meet, and a test that had to
build a real one of each could not check the meeting.

The Collectors are one of those pieces, and their default is here rather than in
the entry point (ADR-0008). Which Collector owns which event is a decision about
collection, and the entry point is a module that runs the CLI on import — so a
switch kept there was reached by no test at all.
*/

import {statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {COUNT_FORMAT} from './format.js';
import {type Config, loadConfig} from './store/config.js';
import {
	defaultHelperStderr,
	defaultProblemReporter,
	EventStream as HelperStream,
	requestInputMonitoring as askForInputMonitoring,
	type StreamProblem,
	type StreamSinks,
} from './capture/helper.js';
import {
	defaultReadWarningReporter,
	type HistorySource,
	type IngestResult,
	LocalStore,
	messageOf,
	type ReadWarningReporter,
	type UsageRecord,
} from './store/local-store.js';
import {KeyboardCollector} from './capture/keyboard.js';
import {
	UsagePusher as MongoUsagePusher,
	type UsagePushBacklog,
} from './store/usage-push.js';
import {
	projectOpencodeMessage,
	readOpencodeDatabase,
} from './usage/usage-opencode.js';
import {projectPiMessage, readPiSessions} from './usage/usage-pi.js';
import {findTranscripts, walkTranscript} from './usage/usage-transcript.js';
import {MouseCollector} from './capture/mouse.js';
import {
	type PermissionReport,
	type PermissionSource,
} from './capture/permissions.js';
/*
The class is this module's name for the real Push; the type it is held as is
`session.ts`'s slice of it, which a stand-in can satisfy — the same split
`EventStream as HelperStream` above makes.
*/
import {
	type PushAttempt,
	type PushBacklog,
	Pusher as MongoPusher,
} from './store/push.js';
import {type RawEvent} from './capture/raw-event.js';
import {
	collectionEntry,
	flushEntry,
	helperEntry,
	historyEntry,
	InProcessRunLogSource,
	pushEntry,
	pushWarningEntry,
	type RunLogSource,
} from './run-log.js';
import {
	type Collector,
	CollectionSession,
	type EventStream,
	type FlushAttempt,
	type FlushStore,
	type Pusher,
	processSignal,
	type Shutdown,
	type ShutdownSignal,
} from './session.js';
import {TelemetryState} from './state.js';
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

/*
The Local Store as this module opens it: the three faces a command wires, which
are the write face the Session Flushes through, the Push Backlog the Pusher
drains, and the read face the history view draws.

Faces rather than the class, so a test can hand over a stand-in without a SQLite
file — the rule ADR-0012 leaves in place, a fake for every seam above the store.
There is one store behind all three, which is the point of the file being the
source of truth: the view reads back exactly what the Flush wrote.
*/
export type RunStore = FlushStore & PushBacklog & HistorySource;

/*
What a run reaches the outside through, built once and closed on every path.
*/
type RunDeps = {
	readonly store: RunStore;
	readonly pusher: Pusher;
};

/*
The two things the `permissions` command reads, and the whole of what that
command is handed: it asks a question and reports the answer, so it opens no
store, starts no Session and draws no frame. Stated on its own because the
entry point's signature is what says what the command depends on.

`RunOptions` carries both, so a caller that wired a collection run can hand the
same object to this entry point without converting it.
*/
export type PermissionsOptions = {
	readonly permissions: PermissionSource;
	readonly logger?: Logger;
};

export type RunOptions = CollectorFactoryOptions &
	PermissionsOptions & {
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
		/*
		The Local Store, as the composition root opens it, built with the reporter
		the read face's warnings go to. The one implementation is the file itself, so
		a caller supplying this is a test handing over a stand-in — which is what
		lets an unopenable store, a Flush that fails, or a read that fails be driven
		without a SQLite file and without leaving one behind.

		The reporter is handed over rather than reached for afterwards, the shape
		`createStream` and `createPusher` both have: what a seam reports is settled
		when it is built, so a caller building one of its own reports where it was
		told to. A reader is the third face of the store, not a module beside it, so
		there is no second seam to supply.
		*/
		readonly createStore?: (onWarning: ReadWarningReporter) => RunStore;
		/*
		The Push seam, built over the store's Push Backlog and with both things it
		reports through: the logger its own warnings go to, and the sink each Drain
		attempt goes to — the shape `createStore` has, and for the same reason. A
		caller supplying this is a test: what a Drain carries is `push.test.ts`'s,
		and what a test wants here is a Drain that does nothing rather than one that
		reaches for Atlas.
		*/
		readonly createPusher?: (
			backlog: PushBacklog,
			logger: Pick<Console, 'warn'>,
			onAttempt: (attempt: PushAttempt) => void,
		) => Pusher;
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
The `permissions` entry point: a command with no mode, because it answers a
question and opens no Session.

Reached twice, and the flag is the whole of the difference. The command was
*asked*, so it reports a grant either way; a collection run asks the same
question on its way to the Collectors, where a granted grant is the
unremarkable case and a line about it would be noise on every start.
*/
export async function runPermissions(
	options: PermissionsOptions,
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
The store faces a usage command reaches: Ingest, and the close that ends the
invocation's lifetime around the Backlog the Push seam is handed. Narrower than
`RunStore` on purpose — nothing here opens a Session, Flushes an era or reads
history — and the Local Store is the only implementation.

The Backlog half is `UsagePushBacklog` rather than a second spelling of it: the
store is what the seam is built over, so the two member signatures are one
declaration, and the command itself never acknowledges a write.
*/
export type UsageStore = UsagePushBacklog & {
	ingest(record: UsageRecord): IngestResult;
	close(): void;
};

/*
The Usage Push seam as a usage command reaches it: one pass over the Usage
Backlog, and the close that ends the connection it was made through. `store/`'s
`UsagePusher` is the only implementation, and a stand-in satisfies this — the
same split `session.ts`'s `Pusher` makes.

Two of the seam's methods rather than the class, because those are the two the
command calls: it neither reads the backlog nor acknowledges a write itself, so
both stay the seam's business.
*/
export type UsagePush = Pick<MongoUsagePusher, 'drain' | 'close'>;

/*
How a usage command builds its Push seam, when it builds one at all. One
spelling for the record commands and the Backfill, so the two `createUsagePusher`
options cannot drift apart.
*/
type UsagePusherFactory = (
	backlog: UsagePushBacklog,
	onAttempt: (attempt: PushAttempt) => void,
) => UsagePush;

/*
What a `usage` record command is handed, each an option for the reason the
collecting commands' are: a test that could not stand these in would open a
store, a connection and a terminal, and the ADR-0016 contract is exactly what a
test has to be able to drive down every path of.

The three record commands — `record-claude-hook`, `record-opencode` and
`record-pi` — take the same set, because they differ by what arrives on stdin and
nothing else: one Harness's artifact, one walk or projection, and the same Ingest
and Drain around it.

`stdin` and `stderr` are the two ends of that contract: the payload arrives on
one and every diagnostic leaves on the other. Stdout is never written, and that
is a property of the code below rather than of a sink it could be handed.
*/
export type RecordUsageOptions = {
	readonly stdin?: () => Promise<string>;
	readonly stderr?: (message: string) => void;
	readonly clock?: () => Date;
	readonly config?: Config;
	readonly createUsageStore?: () => UsageStore;
	/*
	Built over the store's Usage Backlog and with the one thing it reports
	through: each Drain attempt. The default is the real seam, and it is built
	only when there is a `MONGO_URI` — so a caller supplying this is always a
	test, and "no Pusher without a URI" is asserted by this never being called.
	*/
	readonly createUsagePusher?: UsagePusherFactory;
};

/*
The store faces a Backfill reaches, which are the record commands' plus the
classify half of Ingest. `--dry-run` is exactly that SELECT: every candidate
classed against the real store, nothing written. A caller supplying this is a
test, and the Local Store is the only implementation.
*/
export type BackfillStore = UsageStore & {
	duplicatesExisting(record: UsageRecord): boolean;
};

/*
What a Backfill is handed — the three Backfills' one set.

Most of it is the record commands' — config, store, seam, stderr, clock — and
the differences are what makes a Backfill the operator's command rather than a
hook: an artifact to scan and a `--since` to bound it, a stdout to carry the
summary, and a `dryRun` that turns the whole thing into a classify-only preview.
The two sinks are the two faces of an operator run: the summary on stdout, every
diagnostic on stderr.

`root` and `database` are the two spellings of that positional artifact — a
projects or sessions directory, or a SQLite file — and each entry point reads
only its own.
*/
export type BackfillOptions = {
	readonly root?: string;
	readonly database?: string;
	readonly since?: Date;
	readonly dryRun?: boolean;
	readonly stdout?: (message: string) => void;
	readonly stderr?: (message: string) => void;
	readonly clock?: () => Date;
	readonly config?: Config;
	readonly createUsageStore?: () => BackfillStore;
	readonly createUsagePusher?: UsagePusherFactory;
};

/*
How a Backfill ended, as a value rather than a throw — the shape `Shutdown` has,
and for the same reason: `cli.tsx` is the only place an exit code is set, so it
reads this rather than the module ending the process itself. `failed` is the
Backfill's own failure — a scan or a store it could not reach; a Usage Backlog
that survived is not that, because a Push is best-effort.
*/
export type BackfillResult = {
	readonly failed: boolean;
};

/*
A projected Usage Record before its Harness. Both commands' projections answer
this shape — the transcript walk's `TranscriptCandidate` and the OpenCode
projection's `OpencodeCandidate` are the same fields under different names — and
the Ingest face pairs it with the literal the command owns.
*/
type UsageCandidate = Omit<UsageRecord, 'harness'>;

/*
Where a record command's diagnostics go: one line per problem, on stderr.
*/
type Reporter = (message: string) => void;

/*
The hook events this command answers: Stop and SubagentStop only. ApiReqDone is
dead — wired nowhere, present in no transcript — and is not ported (spec #53),
so any other event is a no-op run that still drains.
*/
const HOOK_EVENTS = new Set(['Stop', 'SubagentStop']);

/*
The Harness literals, owned here because a Harness never self-reports its name:
neither the hook JSON nor OpenCode's `info` carries a harness field, and the
command that Ingests decides the string (CONTEXT.md).
*/
const CLAUDE_HARNESS = 'Claude Code';
const OPENCODE_HARNESS = 'OpenCode';
const PI_HARNESS = 'Pi';

/*
The fields of the hook JSON this command reads. Every one optional and read
defensively, because the payload is Claude Code's rather than ours: a field that
is missing or is not a string is absent rather than an error, which is what lets
a partial payload still Ingest the turns its transcript does hold.
*/
type HookInput = {
	readonly hook_event_name?: string | undefined;
	readonly cwd?: string | undefined;
	readonly transcript_path?: string | undefined;
	readonly agent_transcript_path?: string | undefined;
};

/*
The three `usage` record entry points. Each is one Harness's artifact projected
into Usage Records and handed to the same Ingest face.

All run inside their Harness's own wiring — Claude Code's hooks, OpenCode's and
Pi's Shims — so ADR-0016 decides their whole shape: exit 0 on every path of their
own, stdout silent, every problem on stderr. Nothing here throws, and that is the
contract rather than a style: `cli.tsx` turns a throw into a non-zero code, and a
hook that failed loudly would surface an error into the session it was hired to
observe.

What differs between them is what arrives on stdin and how it becomes
candidates — the transcript walk that re-visits every turn, the one OpenCode
message the Shim sends, or the finished Pi assistant message its Shim sends. That
is the whole of the callback each hands over; the store's lifetime, the Ingest,
the reporting and the end-of-invocation Drain around it are `runUsageRecord`, one
path for all three.
*/
export async function runRecordClaudeHook(
	options: RecordUsageOptions = {},
): Promise<void> {
	await runUsageRecord(options, CLAUDE_HARNESS, async report => {
		let input: HookInput | undefined;
		try {
			input = parseHookInput(await (options.stdin ?? readStdin)());
		} catch (error) {
			report(`Could not read the hook input: ${messageOf(error)}`);
		}

		if (input === undefined || !HOOK_EVENTS.has(input.hook_event_name ?? '')) {
			return [];
		}

		/*
		The transcript is always walked — the retired hook's `input.usage`
		shortcut is not ported (spec #53): the walk sees every turn, gives each
		its own `recorded_at`, and re-walking is safe because Ingest drops
		duplicates. A missing or unreadable transcript is no turns, not a
		failure.
		*/
		return walkTranscript(
			input.agent_transcript_path ?? input.transcript_path,
			{cwd: input.cwd, clock: options.clock},
		);
	});
}

/*
The `usage record-opencode` entry point: one JSON document — the `info` blob the
Shim's `message.updated` event carried, plus the Tool Call count and Skill names
it derived from the message's `part` events — on stdin, projected to the one
Usage Record it represents.

No event guard here. The Shim's `time.completed` guard is what makes a delivered
payload a finished turn, and it lives there because OpenCode's event fires on
every message-row write. A message with no tokens is a skip, not a failure; a
payload that is not a JSON object, or one with no `time.created` to place it in
history, is reported, and the invocation drains all the same. A payload from a
Shim that predates the two extra fields is the bare `info` blob, and both fields
stay unknown.
*/
export async function runRecordOpencode(
	options: RecordUsageOptions = {},
): Promise<void> {
	await runUsageRecord(options, OPENCODE_HARNESS, async report => {
		let candidate;
		try {
			const {info, toolCalls, skills} = parseOpencodeInput(
				await (options.stdin ?? readStdin)(),
			);
			candidate = projectOpencodeMessage(info, {toolCalls, skills});
		} catch (error) {
			report(`Could not read the OpenCode input: ${messageOf(error)}`);
			return [];
		}

		return candidate === undefined ? [] : [candidate];
	});
}

/*
The `usage record-pi` entry point: one JSON document — the finished pi assistant
message the Shim observed, the `cwd` its context carried, and the turn's Skill
list — on stdin, projected through the shared Pi projection into the one Usage
Record it represents.

No event guard here either. The Shim's `message_end` guard is what makes a
delivered payload a finished assistant message, and it lives there because pi's
event fires for user and tool-result messages too. A message with no tokens is a
skip, not a failure; a payload that is not a JSON object, or a usage-bearing
message with no timestamp to place it in history, is reported, and the
invocation drains all the same. The projection is the same pure function the
Backfill walks sessions with, so the two paths share one flatten rule.
*/
export async function runRecordPi(
	options: RecordUsageOptions = {},
): Promise<void> {
	await runUsageRecord(options, PI_HARNESS, async report => {
		let candidate;
		try {
			const {message, cwd, skills} = parsePiInput(
				await (options.stdin ?? readStdin)(),
			);
			candidate = projectPiMessage(message, cwd, skills);
		} catch (error) {
			report(`Could not read the Pi input: ${messageOf(error)}`);
			return [];
		}

		return candidate === undefined ? [] : [candidate];
	});
}

/*
One record command, end to end: open the store, project the payload into
candidates, Ingest them, Drain the Usage Backlog, close.

The order and the catches are the whole of ADR-0016. The config and the store
are the two things that can fail before the command's own work, and each is a
line rather than a throw. A failed Ingest skips the Drain — a store that could
not take a record is not one to hand the backlog to — while an invocation that
Ingested nothing still drains, because the Backlog may hold older records.
Closing is last and has its own catch, because it fails after the body's catch
has already run, and a store that would not close must not take the exit code
with it.
*/
async function runUsageRecord(
	options: RecordUsageOptions,
	harness: string,
	candidatesFor: (report: Reporter) => Promise<readonly UsageCandidate[]>,
): Promise<void> {
	const report = options.stderr ?? writeStderr;

	/*
	The first thing that can fail, and it is already inside the contract: a
	`ConfigError` — a `FLUSH_INTERVAL_SECONDS` that is not a number — would
	otherwise leave this module as a throw, and a hook that failed loudly is the
	one thing ADR-0016 forbids. An unreadable config costs the records of this
	invocation and nothing else.
	*/
	let config: Config;
	try {
		config = options.config ?? loadConfig();
	} catch (error) {
		report(messageOf(error));
		return;
	}

	let store: UsageStore;
	try {
		store = (options.createUsageStore ?? (() => new LocalStore(config)))();
	} catch (error) {
		report(messageOf(error));
		return;
	}

	try {
		const candidates = await candidatesFor(report);
		reportIngested(ingestAll(candidates, harness, store), report);
		const drain = await drainUsageBacklog(options, config, store, report);
		reportUsageBacklog(drain, report);
	} catch (error) {
		/*
		The contract again: whatever went wrong after the store opened — a store
		that would not take a record, a backlog that would not read, a
		connection that would not close — is a line on stderr and an exit 0,
		never a throw.
		*/
		report(messageOf(error));
	} finally {
		try {
			store.close();
		} catch (error) {
			report(messageOf(error));
		}
	}
}

/*
What an Ingest pass did, as the two callers read it. A record command reports
each unpriced model as it goes and one line for the invocation; a Backfill
aggregates the models and folds the counts into its summary. One loop serves
both, because both come through the same Ingest face.
*/
type IngestTally = {
	readonly ingested: number;
	readonly duplicates: number;
	/*
	The model of each Ingested record that priced null, in order; `undefined`
	for a record with no model at all. A list rather than a count so the record
	command can say one line per record, and a Backfill can aggregate it.
	*/
	readonly unpricedModels: ReadonlyArray<string | undefined>;
};

/*
Ingest one payload's candidates. Synchronous, and it throws on the one failure
it can meet — a store that would not take a record — with the caller's catch
doing the reporting that a failed Ingest is due; what it must not do is return
as if the run had gone well.
*/
function ingestAll(
	candidates: readonly UsageCandidate[],
	harness: string,
	store: UsageStore,
): IngestTally {
	let ingested = 0;
	let duplicates = 0;
	const unpricedModels: Array<string | undefined> = [];

	for (const candidate of candidates) {
		const result = store.ingest({...candidate, harness});

		if (result.status === 'duplicate') {
			duplicates += 1;
			continue;
		}

		ingested += 1;

		if (result.costYuan === undefined) {
			unpricedModels.push(candidate.model);
		}
	}

	return {ingested, duplicates, unpricedModels};
}

/*
What a record command owes about an Ingest pass.

Unpriced is the accepted state rather than a defect (ADR-0015), so the record
stands and one line per unpriced record makes it visible — which model went
uncovered is the useful part. Then one line for the invocation rather than one
per record: every Stop re-walks the whole transcript, so a per-record line would
grow without bound over a session, and an OpenCode payload is one record, so the
two commands' lines mean the same thing. An invocation that Ingested anything
says "Recorded."; one that only dropped duplicates says "Duplicate."; one with
no candidates at all says nothing.
*/
function reportIngested(
	{ingested, duplicates, unpricedModels}: IngestTally,
	report: Reporter,
): void {
	for (const model of unpricedModels) {
		report(`no pricing for ${modelName(model)}; cost left null`);
	}

	if (ingested > 0) {
		report('Recorded.');
	} else if (duplicates > 0) {
		report('Duplicate.');
	}
}

/*
The model a record names, or the name used for one that named none. An unnamed
model is Unpriced like any other (ADR-0015: absent pricing is not an absent
record), and neither report may print an empty key for it.
*/
function modelName(model: string | undefined): string {
	return model ?? 'an unnamed model';
}

/*
How a Drain went, as the two commands that run one read it: whether one was
attempted at all, how much it carried, and what is left in the Usage Backlog.

A record command says the remainder on stderr; a Backfill folds it into its
stdout summary. Both read the same numbers rather than one re-reading the store.
*/
type DrainOutcome = {
	readonly attempted: boolean;
	readonly pushed: number;
	readonly remaining: number;
};

/*
One pass over the Usage Backlog at the end of the invocation (CONTEXT.md,
Drain).

Skipped only when there is no `MONGO_URI`: Ingest is the required write and Push
is best-effort (ADR-0016), so a deliberately URI-free config still lands its
records. How much is left is read back from the store afterwards — a Push that
failed leaves its records there, and that count is what the next invocation
starts from, and what a Backfill reports as `remaining`.

A failed Drain is said through `report`, because the seam reports attempts and
this is the only thing that knows where a usage command's stderr is. A
successful one says nothing here: the records it carried are gone from the
backlog, and that absence is the report.
*/
async function drainUsageBacklog(
	{createUsagePusher}: Pick<RecordUsageOptions, 'createUsagePusher'>,
	config: Config,
	backlog: UsagePushBacklog,
	report: Reporter,
): Promise<DrainOutcome> {
	if (config.mongoUri === undefined) {
		report('No MONGO_URI; nothing was Pushed.');
		return noDrain(backlog);
	}

	const buildPusher =
		createUsagePusher ??
		((
			forBacklog: UsagePushBacklog,
			onAttempt: (attempt: PushAttempt) => void,
		) => new MongoUsagePusher(config, forBacklog, {onAttempt}));

	/*
	What the seam last reported. A failed attempt still carries the count it
	acknowledged before it failed, so this is taken on both paths: a partial
	Drain has Pushed some records, and the summary owes that number rather than
	zero. The unacknowledged tail stays in the backlog and is counted below.
	*/
	let pushed = 0;

	let pusher: UsagePush;
	try {
		pusher = buildPusher(backlog, attempt => {
			pushed = attempt.pushed;

			if (!attempt.ok) {
				report(messageOf(attempt.error));
			}
		});
	} catch (error) {
		/*
		A URI that is present but unparseable throws here rather than in
		`drain()` — the seam builds its client up front. No Drain was attempted,
		so no count is owed, but the reason has to reach stderr (ADR-0016).
		*/
		report(messageOf(error));
		return noDrain(backlog);
	}

	try {
		await pusher.drain();
	} finally {
		await pusher.close();
	}

	return {attempted: true, pushed, remaining: backlog.usageBacklog().length};
}

/*
No Drain was attempted, so nothing was carried and everything is still waiting.
*/
function noDrain(backlog: UsagePushBacklog): DrainOutcome {
	return {
		attempted: false,
		pushed: 0,
		remaining: backlog.usageBacklog().length,
	};
}

/*
What a record command owes about a Drain: the count still waiting, and nothing
when none was attempted. A URI-free config is a chosen state, so a command that
never had a seam to build says nothing about the Backlog — the records it just
landed simply wait for the next run that has a URI.
*/
function reportUsageBacklog(
	{attempted, remaining}: DrainOutcome,
	report: Reporter,
): void {
	if (!attempted || remaining === 0) {
		return;
	}

	report(
		remaining === 1
			? '1 usage record awaits Push.'
			: `${COUNT_FORMAT.format(remaining)} usage records await Push.`,
	);
}

/*
`usage backfill-claude`, `usage backfill-opencode` and `usage backfill-pi`: one
Harness's own artifacts through the same Ingest face the live commands use.

A Backfill is the operator's command, not a hook's, so it keeps the operator
convention rather than ADR-0016: its own failure — a scan it could not make, a
store it could not reach — comes back as `failed`, with the reason on stderr,
and `cli.tsx` is what turns that into exit 1. A surviving Usage Backlog is
neither: a Push is best-effort, so the run comes back clean with the remainder
in its summary.

No bulk variant and no transaction around the scan: every candidate goes through
`store.ingest` one at a time, which is what makes a re-run idempotent — a second
pass over the same artifacts drops as duplicates by the same rule that makes a
live command dedup-safe, so a crash mid-Backfill is healed by running it again.

`--dry-run` drives the classify face instead of the write face: every candidate
is compared against the real store and nothing is written or Pushed. Its known
limit rides along — two identical candidates in one scan both report a
would-Ingest, because neither is stored yet to be found (spec #53).

`--since` bounds each candidate by its own `recorded_at`; a source may also skip
work before that filter (the Claude walk's file-mtime pre-skip, and the Pi walk's
inside its own scan), which is why the bound arrives at the source rather than
only beside it.

The three commands differ by a source and nothing else: which artifact the
positional names, how it is read, which Harness literal the records carry, and
what one scanned unit is called in the summary. Everything around that — the
config, the store's lifetime, the classify preview, the Ingest pass, the Drain,
the summary and the operator exit code — is `runBackfill`, once.
*/
export async function runBackfillClaude(
	options: BackfillOptions = {},
): Promise<BackfillResult> {
	return runBackfill(options, CLAUDE_BACKFILL);
}

export async function runBackfillOpencode(
	options: BackfillOptions = {},
): Promise<BackfillResult> {
	return runBackfill(options, OPENCODE_BACKFILL);
}

export async function runBackfillPi(
	options: BackfillOptions = {},
): Promise<BackfillResult> {
	return runBackfill(options, PI_BACKFILL);
}

/*
What one scan yields: how many units it read and the candidates they produced.
The Claude walk counts transcripts and the OpenCode read counts assistant
message rows, and the summary prints whichever noun the source names.
*/
type BackfillScan = {
	readonly scanned: number;
	readonly candidates: readonly UsageCandidate[];
};

/*
One Backfill's half of the difference. Everything else is the shared runner's.
*/
type BackfillSource = {
	/*
	What one scanned unit is, for the summary line.
	*/
	readonly scannedNoun: string;
	/*
	The Harness literal the command owns (CONTEXT.md, Harness).
	*/
	readonly harness: string;
	/*
	The artifact the operator named, or the Harness's own.
	*/
	readonly pathFrom: (options: BackfillOptions) => string;
	/*
	Read it. Throws on a scan the operator asked for but could not make; a row or
	file it cannot read is a skip inside, not a throw.
	*/
	readonly scan: (path: string, options: BackfillOptions) => BackfillScan;
	/*
	How that failure reads on stderr.
	*/
	readonly scanFailure: (path: string, error: unknown) => string;
};

/*
Claude Code's half: the whole projects directory, `subagents/` included, and a
file-mtime pre-skip before `--since`'s per-record filter. A transcript's mtime is
at least its last turn's time, so a file older than the bound cannot hold a turn
at or after it and is skipped before it is read; a file touched recently enough
to read still yields only its turns at or after the bound.
*/
const CLAUDE_BACKFILL: BackfillSource = {
	scannedNoun: 'transcripts',
	harness: CLAUDE_HARNESS,
	pathFrom: ({root}) => root ?? defaultProjectsDirectory(),
	scan(root, options) {
		const files = findTranscripts(root);
		const scanned = files.filter(file => !isOlderThan(file, options.since));
		return {
			scanned: scanned.length,
			candidates: candidatesFrom(scanned, options),
		};
	},
	scanFailure: (root, error) => `Could not scan ${root}: ${messageOf(error)}`,
};

/*
OpenCode's half: its own SQLite database, opened read-only, one candidate per
assistant message row. The reader is the whole of the scan — there is no
pre-skip, because there is no file older than a bound to skip before reading a
database that is read as one unit.
*/
const OPENCODE_BACKFILL: BackfillSource = {
	scannedNoun: 'messages',
	harness: OPENCODE_HARNESS,
	pathFrom: ({database}) => database ?? defaultOpencodeDatabase(),
	scan: (database, options) =>
		readOpencodeDatabase(database, {since: options.since}),
	scanFailure: (database, error) =>
		`Could not read ${database}: ${messageOf(error)}`,
};

/*
Pi's half: its own sessions directory, walked recursively for `.jsonl` files
that open with a v3 session header. Nested per-run session files come in for
free and worker transcripts are excluded by that header rule rather than by a
path — the scan is one function, because the header is what both admits the file
and supplies the `cwd` every record of it carries.

The `--since` pre-skip lives inside that walk, before a file is read, for the
same reason the Claude source's does: a session file's mtime is at least its last
message's time.
*/
const PI_BACKFILL: BackfillSource = {
	scannedNoun: 'sessions',
	harness: PI_HARNESS,
	pathFrom: ({root}) => root ?? defaultPiSessionsDirectory(),
	scan: (root, options) => readPiSessions(root, {since: options.since}),
	scanFailure: (root, error) => `Could not scan ${root}: ${messageOf(error)}`,
};

/*
One Backfill, end to end, for any Harness.
*/
async function runBackfill(
	options: BackfillOptions,
	source: BackfillSource,
): Promise<BackfillResult> {
	const report = options.stderr ?? writeStderr;
	const writeSummary = options.stdout ?? writeStdout;

	let config: Config;
	try {
		config = options.config ?? loadConfig();
	} catch (error) {
		report(messageOf(error));
		return {failed: true};
	}

	let store: BackfillStore;
	try {
		store = (options.createUsageStore ?? (() => new LocalStore(config)))();
	} catch (error) {
		report(messageOf(error));
		return {failed: true};
	}

	try {
		const path = source.pathFrom(options);

		let scan: BackfillScan;
		try {
			scan = source.scan(path, options);
		} catch (error) {
			report(source.scanFailure(path, error));
			return {failed: true};
		}

		const {scanned, candidates} = scan;

		if (options.dryRun === true) {
			const classified = classifyCandidates(candidates, source.harness, store);
			writeSummary(
				summaryLine({
					scanned,
					candidates: candidates.length,
					ingested: classified.wouldIngest,
					duplicates: classified.duplicates,
					pushed: 0,
					remaining: 0,
					dryRun: true,
					noun: source.scannedNoun,
				}),
			);
			return {failed: false};
		}

		const {ingested, duplicates, unpricedModels} = ingestAll(
			candidates,
			source.harness,
			store,
		);
		const unpriced = countUnpriced(unpricedModels);
		const {pushed, remaining} = await drainUsageBacklog(
			options,
			config,
			store,
			report,
		);

		writeSummary(
			summaryLine({
				scanned,
				candidates: candidates.length,
				ingested,
				duplicates,
				pushed,
				remaining,
				dryRun: false,
				noun: source.scannedNoun,
			}),
		);

		/*
		The per-record line the record commands emit is suppressed here — a
		thousand-record scan would spam one per record — and distinct unpriced
		models are reported once each with their count (spec #53).
		*/
		for (const [model, count] of unpriced) {
			writeSummary(unpricedLine(model, count));
		}

		return {failed: false};
	} catch (error) {
		report(messageOf(error));
		return {failed: true};
	} finally {
		try {
			store.close();
		} catch (error) {
			report(messageOf(error));
		}
	}
}

/*
Where a Backfill scans when the operator names no root: Claude Code's own
directory. Tests always name one, so nothing in the gate reaches `~/.claude`.
*/
function defaultProjectsDirectory(): string {
	return join(homedir(), '.claude', 'projects');
}

/*
Where `backfill-opencode` reads when the operator names no database: OpenCode's
own. Tests always name one, so nothing in the gate reaches `~/.local/share`.
*/
function defaultOpencodeDatabase(): string {
	return join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/*
Where `backfill-pi` scans when the operator names no root: pi's own sessions
directory. Tests always name one, so nothing in the gate reaches `~/.pi`.
*/
function defaultPiSessionsDirectory(): string {
	return join(homedir(), '.pi', 'agent', 'sessions');
}

/*
Whether a transcript is too old to hold a turn at or after `since`. The bound
holds for a file's mtime and its last turn's `recorded_at`; a file that fails
this is skipped before it is read, which is the whole point of the pre-skip.
*/
function isOlderThan(file: string, since: Date | undefined): boolean {
	if (since === undefined) {
		return false;
	}

	try {
		return statSync(file).mtime.getTime() < since.getTime();
	} catch {
		/*
		A file that went away between the walk and this stat is not the scan
		failing: the pre-skip is best-effort for exactly this reason, and the walk
		that follows degrades an unreadable transcript to zero candidates on its
		own.
		*/
		return false;
	}
}

/*
Every candidate the scanned files hold, with `--since` applied to each record's
own `recorded_at`. A turn the bound excludes is not a candidate; the file it
lived in was still scanned.
*/
function candidatesFrom(
	files: readonly string[],
	{since, clock}: BackfillOptions,
): readonly UsageCandidate[] {
	return files.flatMap(file =>
		walkTranscript(file, {clock}).filter(
			candidate =>
				since === undefined ||
				candidate.recordedAt.getTime() >= since.getTime(),
		),
	);
}

/*
The SELECT half of the Backfill: whether the store already holds each candidate,
and nothing else. `--dry-run`'s whole body, and the reason it can be trusted as
a preview — it is the same classify `ingest` would run, only read.
*/
function classifyCandidates(
	candidates: readonly UsageCandidate[],
	harness: string,
	store: BackfillStore,
): {readonly wouldIngest: number; readonly duplicates: number} {
	let wouldIngest = 0;
	let duplicates = 0;

	for (const candidate of candidates) {
		if (store.duplicatesExisting({...candidate, harness})) {
			duplicates += 1;
		} else {
			wouldIngest += 1;
		}
	}

	return {wouldIngest, duplicates};
}

/*
A Backfill's unpriced models, counted by name. The record commands' per-record
line is suppressed here — a thousand-record scan would spam one per record — so
each distinct model is named once with its count (ADR-0015: absent pricing is
not an absent record). A record with no model at all counts under one name, so
the summary does not print an unreadable key.
*/
function countUnpriced(
	models: ReadonlyArray<string | undefined>,
): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();

	for (const model of models) {
		const name = modelName(model);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}

	return counts;
}

/*
A Backfill's summary, as one line on stdout. The field order is the spec's:
scanned, candidates, ingested, duplicates dropped, pushed, remaining. A dry run
has no Drain to report, so its line ends at the two counts it can know —
would-Ingest and duplicates found — and says nothing about a Push it never
attempted.

`scanned` is what the source actually read — transcripts read, or assistant
message rows — and `noun` is the source's name for one: the Claude walk's
`--since` pre-skip is a file not read, and so not scanned, which is what makes
the pre-skip visible in the summary rather than only in the candidates it saved.
*/
type BackfillSummary = {
	readonly scanned: number;
	readonly candidates: number;
	readonly ingested: number;
	readonly duplicates: number;
	readonly pushed: number;
	readonly remaining: number;
	readonly dryRun: boolean;
	readonly noun: string;
};

function summaryLine({
	scanned,
	candidates,
	ingested,
	duplicates,
	pushed,
	remaining,
	dryRun,
	noun,
}: BackfillSummary): string {
	const counts = dryRun
		? [
				`${COUNT_FORMAT.format(ingested)} would-ingest`,
				`${COUNT_FORMAT.format(duplicates)} duplicates found`,
			]
		: [
				`${COUNT_FORMAT.format(ingested)} ingested`,
				`${COUNT_FORMAT.format(duplicates)} duplicates dropped`,
				`${COUNT_FORMAT.format(pushed)} pushed`,
				`${COUNT_FORMAT.format(remaining)} remaining`,
			];

	return [
		`scanned ${COUNT_FORMAT.format(scanned)} ${noun}`,
		`${COUNT_FORMAT.format(candidates)} candidates`,
		...counts,
	].join(', ');
}

/*
One distinct unpriced model, with how many records it left null. The record
commands' line, aggregated: same sentence, with the count a Backfill's volume
needs.
*/
function unpricedLine(model: string, count: number): string {
	const records =
		count === 1 ? '1 record' : `${COUNT_FORMAT.format(count)} records`;

	return `no pricing for ${model}; cost left null (${records})`;
}

/*
Where a Backfill's summary goes: stdout, because it is the answer to a question
the operator asked rather than a diagnostic. Every problem still goes to
stderr, so a script reading the summary line is not confused by it.
*/
function writeStdout(message: string): void {
	process.stdout.write(`${message}\n`);
}

/*
The hook payload, as far as this command trusts it: only the four fields it
reads are taken, and each only when it is a string.
*/
function parseHookInput(raw: string): HookInput {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('the hook input was not a JSON object');
	}

	const record = parsed as Record<string, unknown>;
	const text = (key: string): string | undefined => {
		const value = record[key];
		return typeof value === 'string' ? value : undefined;
	};

	/* eslint-disable @typescript-eslint/naming-convention -- the hook JSON's own field names, which Claude Code writes. */
	return {
		hook_event_name: text('hook_event_name'),
		cwd: text('cwd'),
		transcript_path: text('transcript_path'),
		agent_transcript_path: text('agent_transcript_path'),
	};
	/* eslint-enable @typescript-eslint/naming-convention */
}

/*
An array of strings, taking only its string entries. Anything else is undefined,
which the callers read as unknown rather than an empty list.
*/
function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: undefined;
}

/*
The Pi payload, as far as this command trusts it: the finished assistant message
the Shim observed, the `cwd` its context carried, and the Skill list the Shim
built from the turn's user messages. The message is left as it arrived — the
shared projection is what validates it — while `cwd` is taken only when it is a
string, because the session may have none, and `skills` only when it is an array
of strings. An older Shim sends no Skill list, and undefined is that unknown.
*/
function parsePiInput(raw: string): {
	message: unknown;
	cwd: string | undefined;
	skills: string[] | undefined;
} {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('the Pi input was not a JSON object');
	}

	const {message, cwd, skills} = parsed as Record<string, unknown>;
	return {
		message,
		cwd: typeof cwd === 'string' ? cwd : undefined,
		skills: stringArray(skills),
	};
}

/*
The OpenCode payload, as far as this command trusts it: the `info` document the
Shim delivered and the two fields it derived from the message's `part` events.
A Shim that predates those fields sent the bare `info` object, so `info` may be
the whole payload; either way the projection takes the two fields from the
context, and a payload that carries neither leaves both undefined, which is
unknown rather than none.
*/
function parseOpencodeInput(raw: string): {
	info: unknown;
	toolCalls: number | undefined;
	skills: string[] | undefined;
} {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('the OpenCode input was not a JSON object');
	}

	const record = parsed as Record<string, unknown>;
	const {info, toolCalls, skills} = record;
	if (typeof info !== 'object' || info === null) {
		return {info: parsed, toolCalls: undefined, skills: undefined};
	}

	return {
		info,
		toolCalls: typeof toolCalls === 'number' ? toolCalls : undefined,
		skills: stringArray(skills),
	};
}

/*
All of stdin, which is where the wiring delivers the one JSON payload — Claude
Code's hook payload, OpenCode's one `info` blob through the Shim, or Pi's one
message document through its Shim. Decoded as
UTF-8 while it is read rather than after concatenation, so a multi-byte
character split across two chunks cannot come out as replacement characters.
*/
async function readStdin(): Promise<string> {
	process.stdin.setEncoding('utf8');

	let data = '';
	for await (const chunk of process.stdin) {
		data += chunk as string;
	}

	return data;
}

/*
The hook contract's one output: a line per diagnostic, on stderr, so the agent's
stdout stays clean and an operator who looks can still see what happened.
*/
function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
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
Where a mode's reports go, as one value because it is one decision: the Push
seam reports a TTL index it could not create through a logger and each Drain
attempt through a callback, and the Local Store reports a failed read through a
reporter. All three are the mode's to answer — an entry under a frame, a line on
stderr without one — and none is the seam's business: they are handed over, as
the file to open is.
*/
type RunSinks = {
	readonly logger: Pick<Console, 'warn'>;
	readonly onReadWarning: ReadWarningReporter;
	readonly onPushAttempt: (attempt: PushAttempt) => void;
};

/*
Opens what a run reaches the outside through: the Local Store, and the Push over
it.

The store first, and it throws from here rather than from anywhere later — that
is the whole of ADR-0012's fail-fast rule, and this is the first thing either
command does. The Pusher is built over the store because the store *is* the Push
Backlog; a Pusher that could not be built closes the store it was handed, so a
bad `MONGO_URI` does not leave an open file behind on the way out.

Synchronous, because opening the store is: the file is opened and its statements
prepared on this thread, and the close on the failure path is the same call the
Session makes on the way out. There is nothing here for a caller to wait on, and
a promise in front of it would only be something to `await` before the run can
begin.
*/
function openRun(
	options: RunOptions,
	config: Config,
	{logger, onReadWarning, onPushAttempt}: RunSinks,
): RunDeps {
	const store = (
		options.createStore ??
		((onWarning: ReadWarningReporter) => new LocalStore(config, {onWarning}))
	)(onReadWarning);

	try {
		/*
		The default takes what it is handed rather than closing over this
		function's, so that each value travels by one route. A `createPusher` that
		ignores them is a caller saying it knows where its own reports go, which is
		the same thing the option means everywhere else.
		*/
		const buildPusher =
			options.createPusher ??
			((
				backlog: PushBacklog,
				pushLogger: Pick<Console, 'warn'>,
				onAttempt: (attempt: PushAttempt) => void,
			) => new MongoPusher(config, backlog, {logger: pushLogger, onAttempt}));

		return {store, pusher: buildPusher(store, logger, onPushAttempt)};
	} catch (error) {
		store.close();
		throw error;
	}
}

/*
Closes them, in the order they were opened: a Drain reads the store, so the store
outlives it, and the client is what the Drain wrote through.

Idempotent on both, and it has two owners: the Session closes them at the end of
a run, and this closes them on the paths a run never reached — a preflight that
threw, a Collector that would not start. Whichever gets there first does it.
*/
async function closeRun({store, pusher}: RunDeps): Promise<void> {
	store.close();
	await pusher.close();
}

/*
The Session, built the same way whichever mode asked for one.

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
		store,
		pusher,
		hooks,
	}: {
		readonly config: Config;
		readonly state: TelemetryState;
		readonly report: PermissionReport;
		readonly runLog: InProcessRunLogSource;
		/*
		The Local Store, opened by the caller rather than here: opening it is the
		fail-fast path, and it has to happen before the preflight and before
		anything is drawn — which is not something this function, reached after
		both, can arrange.
		*/
		readonly store: RunStore;
		readonly pusher: Pusher;
		readonly hooks: SessionHooks;
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
		onProblem: options.onProblem ?? hooks.problemReporter,
		onHelperStderr: options.onHelperStderr ?? hooks.helperStderr,
	};
	const setup = (options.collectors ?? defaultCollectorFactory(factoryOptions))(
		report,
		state,
	);

	return new CollectionSession({
		store,
		pusher,
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
			hooks.onFlush?.(attempt);
		},
	});
}

/*
The Session's mode-specific half, as `sessionFor` takes it.

Every field is optional, and a mode that leaves one out is a mode saying "the
default": `collect` leaves the problem reporter and the helper's stderr out and
keeps the stderr the CLI has always had, while the dashboard supplies both.
*/
type SessionHooks = {
	/*
	Where the helper's problems go on a run whose caller supplied no reporter of
	its own — the dashboard appends entries, because the frame is the only output
	there.
	*/
	readonly problemReporter?: (problem: StreamProblem) => void;
	/*
	Where the helper's own diagnostics go, on the same terms: a sink that drops
	them under a frame, where a line arriving mid-draw corrupts the drawing
	(ADR-0010).
	*/
	readonly helperStderr?: (chunk: string) => void;
	/*
	Whatever else wants to hear about a Flush, which is the live view — the one
	observer whose counters depend on whether the write landed.
	*/
	readonly onFlush?: (attempt: FlushAttempt) => void;
};

/*
What a mode answers at each point the skeleton reaches one. Three stages rather
than one flat shape, because the lifecycle decides what exists when: the sinks
are needed to open the store, before the preflight has been asked; the hooks are
built *from* the preflight's report and the Telemetry State, which do not exist
until after it; and the completion step needs the Session, which is last of all.
A mode built in one piece could only guess at what the later stages know.

`Carried` is whatever a mode builds in its hooks and needs again in its
completion step — the dashboard's Telemetry Source, which is built from the
report and the state and is then one of the sources the frame draws. The
skeleton hands it back and never looks at it.
*/
type RunMode<Carried> = {
	readonly sinks: RunSinks;
	readonly hooks: (
		report: PermissionReport,
		state: TelemetryState,
	) => ModeSetup<Carried>;
	readonly complete: (
		session: CollectionSession,
		deps: RunDeps,
		carried: Carried,
	) => Promise<Shutdown>;
};

/*
What the hooks stage hands back: what the Session is built with, and what the
completion step will be handed later.
*/
type ModeSetup<Carried> = {
	readonly session: SessionHooks;
	readonly carried: Carried;
};

/*
What a factory is handed: the run's own values, read once by the skeleton. The
mode is built per run rather than being a constant, because closing over these
is what lets a stage say where its reports go without being told again.
*/
type RunFacts = {
	readonly options: RunOptions;
	readonly config: Config;
	readonly runLog: InProcessRunLogSource;
	readonly logger: Logger;
};

type RunModeFactory<Carried> = (facts: RunFacts) => RunMode<Carried>;

/*
The headless mode, in which every report goes to the terminal.

The Push seam's warnings keep stderr, which is where a headless run reports: the
run's own logger is for the run's own report, and a TTL index the server would
not create is the seam's. Its Drain attempts go the other way — through the run's
logger, because they are sentences about this run rather than about the seam —
and both are stderr in a real one. The read face's warnings go the same way, and
are unreachable here: `collect` draws no history, so nothing asks the store a
question — the default is what a run that never reads keeps.

Nothing is carried: a headless run has no view to hand anything to.
*/
function collectMode({logger}: RunFacts): RunMode<undefined> {
	return {
		sinks: {
			logger: console,
			onReadWarning: defaultReadWarningReporter,
			/*
			What a Drain attempt says on the terminal: what the entry holds. There
			is one spelling of what a Push did, and this is that spelling going
			somewhere else — which is the whole of the difference between the two
			modes, and the reason the destination is the run's own logger rather
			than the console.

			The whole text rather than the summary, and the difference only shows
			when a driver's message ran to more than one line: folding one is the
			block's business, where an entry gets a single row, and a `collect` run
			has no block and no diagnostics view — so the sentence alone would
			leave the rest of what the driver said nowhere at all. A one-line
			message is its own full text, and prints once.
			*/
			onPushAttempt(attempt) {
				const entry = pushEntry(attempt);
				if (entry !== undefined) {
					logger.warn(entry.detail);
				}
			},
		},
		hooks: () => ({
			session: {
				/*
				A headless run has no frame to keep whole, so a Flush that failed is
				a line on stderr. It is said from the attempt the Session reports
				rather than by the Session or the store, because this is the one
				place that knows which mode it is answering (ADR-0010).

				A failed *final* Flush is then warned about twice — here, and once
				more by `reportShutdown` — which is the shape this has always had,
				and the two lines say different things: one that the write failed,
				the other that the counters were lost with it.
				*/
				onFlush(attempt) {
					if (!attempt.ok) {
						logger.warn('Flush failed; counters will retry on the next Flush');
					}
				},
			},
			carried: undefined,
		}),
		async complete(session) {
			return session.run();
		},
	};
}

/*
The mode the dashboard runs in: every report becomes a Run Log entry, because
the frame is the only output (ADR-0010). Nothing writes to stderr while it is
up: Ink draws by overwriting the lines it last drew, so a line landing mid-draw
leaves the rest of the frame off by one from where Ink thinks it is.

What it carries is the Telemetry Source, built here from the report and the
state so that the live view and the Session's Flush reports are two ends of one
object — a source the view drew and no Flush ever reached would show counters
that never move.
*/
function dashboardMode({
	options,
	config,
	runLog,
}: RunFacts): RunMode<InProcessTelemetrySource> {
	return {
		sinks: {
			/*
			The Push seam's warnings, as entries. A logger rather than a reporter,
			because a logger is the shape the seam offers and it is not the seam's
			business whether there is a frame to keep quiet. What it raises
			through one is a TTL index it could not create — raised as it is
			built, before any Flush has happened — and under a frame that is an
			entry rather than a line of stderr in the middle of the drawing.

			The extra arguments a warning was given are kept, because they are
			where a driver's error travels.
			*/
			logger: {
				warn(message: string, ...extra: unknown[]) {
					runLog.append(pushWarningEntry(message, extra, new Date()));
				},
			},
			/*
			The read face's warnings become entries, as the helper's do and for
			the same reason: the dashboard lands on the history view, and the
			sentence a failed read carries is a fact about this run rather than
			about the range on screen. The view draws a pointer and the log holds
			the whole of it — drawn in both places it would be one failure said
			twice, one of them across the frame.
			*/
			onReadWarning(warning) {
				runLog.append(historyEntry(warning, new Date()));
			},
			/*
			Each Drain attempt, as the dashboard records it. `pushEntry` answers
			`undefined` for the attempt that is not worth a line — one era, the
			steady state — and what it does answer with is appended here rather
			than by the seam, which cannot know whether there is a frame to draw
			it in (ADR-0010).
			*/
			onPushAttempt(attempt) {
				const entry = pushEntry(attempt);
				if (entry !== undefined) {
					runLog.append(entry);
				}
			},
		},
		hooks(report, state) {
			const telemetry = new InProcessTelemetrySource({report, state});

			return {
				session: {
					/*
					The helper's problems become entries rather than lines of
					stderr, which would land in the middle of the frame. Appended
					here and not in a view: an entry is a fact about the run, and
					the block polls what it finds.
					*/
					problemReporter(problem) {
						runLog.append(helperEntry(problem, new Date()));
					},
					/*
					The helper's other output goes nowhere at all. Its notes — a
					tap re-enabled, the listener announcing itself — are written
					to stderr for a terminal to read, and a frame has no room for
					them. Nothing that matters goes with them: a statement about
					collection arrives as an event on stdout, and those become
					entries.
					*/
					helperStderr: noop,
					/*
					The last leg of the live totals: the Session reports each
					Flush attempt and the source is what folds a successful one
					in. Without it the view draws counters that never move.
					*/
					onFlush(attempt) {
						telemetry.recordFlush(attempt);
					},
				},
				carried: telemetry,
			};
		},
		/*
		The dashboard's choreography, which is what it does instead of waiting on
		`run()`: the view goes up over a run that has already started, and comes
		down before the Shutdown is reported.
		*/
		async complete(session, deps, telemetry) {
			/*
			A statement rather than `options.renderApp ?? (await import(...)).renderApp`,
			which would import ink on every path — including the one where the
			caller supplied a renderer precisely so that it would not.
			*/
			let render = options.renderApp;
			if (render === undefined) {
				({renderApp: render} = await import('./views/tui.js'));
			}

			/*
			When the run began: the instant before the Session starts the
			Collectors, which is the moment the live view's totals count from.
			Taken here, next to the call that begins the run, so it is that
			instant rather than whenever a frame happened to be drawn — a
			dashboard that opens slowly still says when the run it is drawing
			began.
			*/
			const startedAt = new Date();

			/*
			Started before the view is mounted, so the counters are already moving
			by the time the first frame is drawn.
			*/
			const running = session.run();

			/*
			`run()`, saying only *that* it ended rather than how. The view has to
			come down when a signal ends the run, and the rejection has to be
			claimed here or a Collector that could not start would end the process
			outright, before the caller can report it as the failure it is.
			*/
			const ended = running.then(noop).catch(noop);

			try {
				await render({
					/*
					The store itself, and not a reader beside it: the history view
					reads what the Flush wrote, and one object is what makes that
					the same file rather than two that have to be kept in step
					(ADR-0012).
					*/
					history: deps.store,
					telemetry,
					runLog,
					timeZone: config.timeZone,
					startedAt,
					ended,
				});
			} finally {
				/*
				Stopped rather than left to a signal: `q` arrives as input in a
				raw-mode terminal and never generates one, so this is the only
				thing that knows the view has gone.

				Nothing closes the reader here. The store the view was reading is
				the one `stop()` closes, after the final Flush has landed — which
				is the order it has to be, since the Flush is what the view reads.
				*/
				await session.stop();
			}

			return running;
		},
	};
}

/*
The end of a run, reported the same way whichever command was running.

A final Flush that failed means the counters were still in Telemetry State when
the store closed, so they are gone and the run did not end cleanly. Said plainly
here — and said again as an exit code by `cli.tsx`, which reads it off the
Shutdown this is handed rather than off a process-wide value set in here: a
shell reads the exit code and not the log, and which code it reads is the entry
point's decision rather than one the report can make for it.

A Push Backlog that survived the run is said after that, and it is the one thing
here that decides nothing: the eras are in the Local Store, the next run's
startup Drain will carry them, and what a Push owes the website is not an exit
code the CLI can be handed (ADR-0012).
*/
function reportShutdown(
	{signal, finalFlush, backlogLength}: Shutdown,
	logger: Logger,
): void {
	if (finalFlush) {
		logger.log(
			signal === undefined
				? 'Stopped.'
				: `Received ${signal}; flushed and stopped.`,
		);
	} else {
		logger.warn(
			'The final Flush failed; the counters since the last Flush were lost.',
		);
	}

	// Nothing is waiting, and a line saying so would be a line about nothing.
	if (backlogLength === 0) {
		return;
	}

	/*
	One era is still one to carry, so the sentence has to read as one — the same
	care `collectionEntry` takes over naming a single Collector. The count is
	spelled by the formatter the totals are, because the same number can appear in
	a frame a moment earlier: `Pushed 1,234 eras` and `1,234 eras await Push.` are
	one quantity, and it reads one way.
	*/
	const eras = COUNT_FORMAT.format(backlogLength);

	logger.log(
		backlogLength === 1 ? '1 era awaits Push.' : `${eras} eras await Push.`,
	);
}

/*
The preflight, and the entry it leaves in the Run Log.

One place rather than one per command, because the order is the whole of it: the
log is built — by the caller, before the store is opened — so that a run starting
with no grant has the entry in it before the first frame is drawn. A third
command would otherwise have to know that, and the way to get it wrong looks like
nothing at all.

Built in `collect` too, even though nothing draws it: the Run Log is the record
of a run, and a `collect` run is one. Nothing reads it back there — the terminal
is where a headless run reports, and its exit code is what a shell reads — but a
caller that supplied one can see afterwards what the run found.
*/
async function preflightWithLog(
	options: RunOptions,
	runLog: InProcessRunLogSource,
): Promise<PermissionReport> {
	const report = await runPermissions(options);

	/*
	Only where there is something to say. A run that was granted starts with an
	empty log, which the block draws as "nothing yet" — a line about a check that
	passed would be an entry about nothing happening.
	*/
	if (report.status === 'disabled') {
		runLog.append(collectionEntry(report, new Date()));
	}

	return report;
}

/*
One run, whichever mode asked for it: open, preflight, session, complete,
report, close.

The order is the whole of what the two flows used to state twice. The store is
opened first and it throws from there rather than from anywhere later — ADR-0012's
fail-fast rule, and the first thing any run does. Nothing is drawn until it has
opened, which is what keeps a store that cannot be opened quiet as well as early.
Both lifetimes are closed on every path, including the ones a run never reached.

How the run ended is resolved with rather than set as a process-wide value: the
entry point is what turns a Shutdown into an exit code, and it is the only place
that can — a `runCollect` called from a test would otherwise end the test runner
non-zero for a Flush the test was asserting on.

Nothing here says which command is running. What differs between the two is the
mode, and the mode is the only thing this function is told about.
*/
async function runCollection<Carried>(
	options: RunOptions,
	createMode: RunModeFactory<Carried>,
): Promise<Shutdown> {
	const logger = options.logger ?? console;
	const config = options.config ?? loadConfig();
	/*
	The Run Log the view reads and the wiring appends to is one object, or the
	block would show a run that never did anything. Built before the store,
	because the store's Push warnings become entries in it — and before the
	preflight for the reason `preflightWithLog` gives.
	*/
	const runLog = options.runLog ?? new InProcessRunLogSource();
	const mode = createMode({options, config, runLog, logger});
	const deps = openRun(options, config, mode.sinks);

	try {
		const report = await preflightWithLog(options, runLog);
		const state = stateFor(options, config);
		const setup = mode.hooks(report, state);
		const session = sessionFor(options, {
			config,
			state,
			report,
			runLog,
			...deps,
			hooks: setup.session,
		});

		const shutdown = await mode.complete(session, deps, setup.carried);
		reportShutdown(shutdown, logger);

		return shutdown;
	} finally {
		/*
		On every path, and not only the happy one: the Session closes both at the
		end of a run, and this catches the run that never got that far.
		*/
		await closeRun(deps);
	}
}

/*
A no-op rather than an arrow, because the lint rule that forbids an empty
function body is the point: there is genuinely nothing to do here, and one name
says so. It has two call sites, and each is deliberate: the helper's stderr,
which has nowhere to go under a frame, and the promise that says only *that* the
run ended, whose rejection the caller reports.
*/
function noop(): void {
	// See the call sites: nothing to do, on purpose, in both places.
}

/*
The two entry points that collect, one per command, and each named for the
command it runs. They differ by no more than the mode they hand the skeleton —
which is the whole reason a third collecting command is composition rather than
a third copy of the flow.

Neither is told which command it is: the command decided that, one module up.

Both resolve with the Shutdown, which is how the run ended rather than only that
it did, and the two commands end identically: `cli.tsx` reads the final Flush
out of it either way. `permissions` keeps its own return type, because it answers
a question and never has a run to report.
*/
export async function runCollect(options: RunOptions): Promise<Shutdown> {
	return runCollection(options, collectMode);
}

export async function runDashboard(options: RunOptions): Promise<Shutdown> {
	return runCollection(options, dashboardMode);
}
