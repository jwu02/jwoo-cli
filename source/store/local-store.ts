/*
The Local Store: SQLite on this machine, and the source of truth for the
history view.

ADR-0012 split the one write in two. A **Flush** writes an era here — a local
fsync rather than a network round trip — and the history view reads it back from
here. MongoDB is a best-effort **Push** target, drained from the Push Backlog
below; nothing in this module knows that MongoDB exists.

`node:sqlite` carries no promise, and the repo's rule — declare async only where
the real thing is async — applies with full force. `flush`, `backlog`, `load`
and `close` return their answers directly, because there is nothing to await.
Saying otherwise would be a pretence, and it would put a wait in a view that has
nothing to wait for.

The read vocabulary lives here because this is the module that answers it: the
history view asks this file the same three questions it used to ask MongoDB, and
`HistorySource` below is the whole of that seam.
*/

import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {type Snapshot} from '../state.js';
import {type Config} from './config.js';
import {canonicalModelName, computeCostYuan} from './pricing.js';
import {bucketBoundaries, type Range} from './ranges.js';

/*
A row as the driver hands it back.

Declared here rather than taken from the driver's own `SQLOutputValue`, for the
reason `push.ts` declares its own slices of the Mongo driver: a module names
only what it uses. Unlike those slices this one is not async-shaped, because
`node:sqlite` is not async — and that is the fact the whole module rests on.
*/
type Row = Record<string, unknown>;

/*
The columns are all NOT NULL and the driver hands INTEGER and REAL back as
`number`, so a non-number here would mean the schema and this module had drifted
apart. The default is for `MAX(stamp)` over a table with no eras in it, which
really is NULL — the one case a zero is an answer rather than a cover-up: a
store that has written nothing has no newest stamp, which is older than any it
will hand out.
*/
function numberAt(row: Row | undefined, column: string): number {
	const value = row?.[column];
	return typeof value === 'number' ? value : 0;
}

function stringAt(row: Row, column: string): string {
	const value = row[column];
	return typeof value === 'string' ? value : String(value);
}

/*
A nullable TEXT column: the string, or `undefined` for the driver's NULL. Unlike
`stringAt` it does not stringify, because `undefined` and `'undefined'` are very
different answers for a column whose whole contract is that it may be absent.
*/
function optionalStringAt(row: Row, column: string): string | undefined {
	const value = row[column];
	return typeof value === 'string' ? value : undefined;
}

/*
The dedup window, in milliseconds: a record whose model and five token buckets
match one already stored within this distance of its own `recorded_at` is the
same point event arriving again (ADR-0013). Symmetric and inclusive, the window
`ai-usage/usage-lib.mjs` always used.
*/
const DEDUP_WINDOW_MS = 5000;

/*
An error's own sentence, which is worth showing: "file is not a database" tells
the user more than "something went wrong".

Exported because a failed read is spelled in two places — the `message` this
module answers with, and the Run Log entry built from the warning it raises —
and one spelling is what stops the two drifting into saying one failure two ways.
*/
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/*
One transaction, so that a write which fails partway leaves nothing behind. A
rollback that fails is swallowed on purpose: if the transaction never opened —
a closed database, say — there is nothing to undo, and SQLite's "no transaction
is active" would replace the error that actually went wrong.

`IMMEDIATE` takes the write lock at `BEGIN` rather than at the first write, which
is what lets Ingest hold the lock across a read *and* a write — see `ingest`. The
default is `DEFERRED`, what a write that is the whole transaction wants.
*/
function inTransaction<T>(
	db: DatabaseSync,
	work: () => T,
	mode: 'DEFERRED' | 'IMMEDIATE' = 'DEFERRED',
): T {
	db.exec(`BEGIN ${mode}`);

	try {
		const value = work();
		db.exec('COMMIT');
		return value;
	} catch (error) {
		try {
			db.exec('ROLLBACK');
		} catch {
			// Nothing to undo; the real error is rethrown below.
		}

		throw error;
	}
}

const SCHEMA_VERSION = 2;

/*
The era family: the schema models the **era**, not the wire.

`stamp` is the primary key, and that is what makes a Flush idempotent: a retry
under the same stamp replaces its row rather than adding a second one beside it
(ADR-0009). `era_key_counts` normalises Key Counts to one row per Key Label per
era; they are flattened back into the wire shape at Push time, so ADR-0004's
flat Key Count Document survives at that seam untouched.

`pushed_at` is NULL until a Push acknowledges the era. The Push Backlog is the
query for the rows where it is still NULL — not a second structure to keep in
step with this one.

Nothing ages out. This is the record of every era this machine has Flushed;
MongoDB's TTL indexes remain MongoDB's.
*/
const ERA_SCHEMA = `
CREATE TABLE eras (
	stamp           INTEGER PRIMARY KEY NOT NULL,
	left_clicks     INTEGER NOT NULL,
	right_clicks    INTEGER NOT NULL,
	movement_meters REAL    NOT NULL,
	press_total     INTEGER NOT NULL,
	pushed_at       INTEGER
);

CREATE TABLE era_key_counts (
	era_stamp INTEGER NOT NULL REFERENCES eras(stamp),
	label     TEXT    NOT NULL,
	count     INTEGER NOT NULL,
	PRIMARY KEY (era_stamp, label)
);
`;

/*
The Usage Record family, added at version 2.

Its columns are named exactly as the wire fields, so the Push seam maps a stored
row to a document without renaming. `id` is the implicit rowid and nothing more:
a point event has no natural stamp, so there is no content-derived local key and
none of the era's outstanding-stamp machinery. `cost_yuan` is priced once at
Ingest and never recomputed (ADR-0014); NULL is the Unpriced marker (ADR-0015).

This table carries no `IF NOT EXISTS`, for the era schema's reason: a file this
module did not make is a file it cannot safely write to. It is created only when
the version says it is absent, so the guard is the version itself.
*/
const USAGE_SCHEMA = `
CREATE TABLE usage_records (
	id                       INTEGER PRIMARY KEY,
	recorded_at              INTEGER NOT NULL,
	harness                  TEXT    NOT NULL,
	cwd                      TEXT,
	model                    TEXT,
	cost_yuan                REAL,
	prompt_tokens            INTEGER NOT NULL,
	completion_tokens        INTEGER NOT NULL,
	total_tokens             INTEGER NOT NULL,
	prompt_cache_hit_tokens  INTEGER NOT NULL,
	prompt_cache_miss_tokens INTEGER NOT NULL,
	pushed_at                INTEGER
);

CREATE INDEX usage_records_fingerprint ON usage_records (
	model,
	prompt_tokens,
	completion_tokens,
	total_tokens,
	prompt_cache_hit_tokens,
	prompt_cache_miss_tokens,
	recorded_at
);
`;

/*
The file's schema version, and the drift guard beside it.

A store this CLI has never written to reports `user_version` 0 — and so does an
empty file and a foreign one — so each family is created *without* `IF NOT
EXISTS`. A table of that name already present is an error rather than something
to build around, because a file that already has an `eras` table this module did
not make is not a file this module can safely write to.

The step from version 1 to 2 is additive — the era family is untouched, and the
usage family is created beside it — so the whole migration is one transaction
and an existing store upgrades in place.
*/
function migrate(db: DatabaseSync): void {
	const version = numberAt(
		db.prepare('PRAGMA user_version').get(),
		'user_version',
	);

	if (version === SCHEMA_VERSION) {
		return;
	}

	if (version > SCHEMA_VERSION) {
		throw new Error(
			`the file is schema version ${version}, and this CLI writes version ${SCHEMA_VERSION}`,
		);
	}

	inTransaction(db, () => {
		if (version < 1) {
			db.exec(ERA_SCHEMA);
		} else if (version < 2) {
			/*
			A file at version 1 says the era family is here, so one without it is
			not a file this CLI wrote — the drift the missing `IF NOT EXISTS`
			catches for a fresh file. Probe inside the transaction, so the write
			lock is held and the failure rolls back rather than leaving a
			half-migrated file behind. SQLite's own "no such table" is the report,
			exactly as it is when a prepared statement names a table that is gone.
			*/
			db.prepare('SELECT 1 FROM eras').get();
		}

		if (version < 2) {
			db.exec(USAGE_SCHEMA);
		}

		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	});
}

/*
Opening is synchronous and it throws, and it is where *every* way of being
unable to record shows up — a directory that cannot be made, a file that is not
a database, a version from the future — so it is where the run should end, at
startup, before a frame is drawn and before hours of collection go into a retry
that can never succeed.

The prepared statements are built by the constructor rather than here, and are
part of the same phase: a file that reports this schema version but carries
none of its tables is a file this module cannot write to, and the statement
that will not compile against it is how that is found out. `LocalStore` wraps
the two together so the failure reads as one.
*/
function openDatabase(path: string): DatabaseSync {
	// The default path is under Application Support, which a machine that has
	// never run this CLI does not have yet.
	mkdirSync(dirname(path), {recursive: true});

	const db = new DatabaseSync(path);
	// WAL, so the write's fsync lands in the log rather than in the file the
	// frame is being drawn from.
	db.exec('PRAGMA journal_mode = WAL');
	// A hook process and a dashboard run can write this one file at once — Stop
	// and SubagentStop may even fire together — so a writer waits for the lock
	// rather than failing on the first collision. Every write here is a handful
	// of rows, so a second is already generous.
	db.exec('PRAGMA busy_timeout = 1000');
	migrate(db);
	return db;
}

/*
The stamp a Flush landed under, or `undefined` when it did not.

Named for the stamp rather than for the write's outcome, because the stamp is
what the caller gets and the one fact it has about the era it just wrote. There
is no result type to go with it: the write is the whole of the report, and a
Flush that failed says so by answering `undefined` (ADR-0010).
*/
export type FlushStamp = Date | undefined;

/*
One era, as the Push Backlog hands it out. The Push builds the wire documents
from this — flat Key Counts, a real BSON `createdAt` — so the store's own schema
stops at this boundary.
*/
export type Era = {
	readonly stamp: Date;
	readonly leftClicks: number;
	readonly rightClicks: number;
	readonly movementMeters: number;
	readonly pressTotal: number;
	readonly keyCounts: Readonly<Record<string, number>>;
};

/*
One Usage Record as a caller hands it to Ingest.

The five token buckets keep the wire's own names, because they are the wire's —
the columns are named as the fields, and `pricing.ts` already names them this
way, so one spelling runs from the Harness through the store to the document.

`costYuan` is deliberately absent. The face prices the record from its own
tokens at its own `recordedAt` (ADR-0014); a caller that could supply a cost
could supply one that contradicts them.

`recordedAt` is a `Date` at this boundary and epoch milliseconds in the schema —
the same split the era stamp makes.
*/
export type UsageRecord = {
	readonly harness: string;
	readonly cwd?: string | undefined;
	readonly model?: string | undefined;
	readonly recordedAt: Date;
	readonly prompt_tokens: number;
	readonly completion_tokens: number;
	readonly total_tokens: number;
	readonly prompt_cache_hit_tokens: number;
	readonly prompt_cache_miss_tokens: number;
};

/*
A stored Usage Record, as the Usage Backlog hands it out: the record that was
Ingested, plus the id its row was written under and the cost the face priced for
it — `undefined` when Unpriced.
*/
export type BackloggedUsage = UsageRecord & {
	readonly id: number;
	readonly costYuan: number | undefined;
};

/*
What Ingest did: wrote the record, reporting the row it wrote and the cost it
priced, or found the record already present and dropped it (ADR-0013). A
duplicate is a reported outcome rather than an error — the two are told apart by
the tag, and neither is a failure.
*/
export type IngestResult =
	| {
			readonly status: 'ingested';
			readonly id: number;
			readonly costYuan: number | undefined;
	  }
	| {readonly status: 'duplicate'};

export type Totals = {
	readonly leftClicks: number;
	readonly rightClicks: number;
	readonly movementMeters: number;
	readonly pressTotal: number;
};

/*
One Key Label and how often it was pressed. Ordered by count rather than by
label, which is what makes it a ranking rather than Key Counts — see the
CONTEXT.md entry.
*/
export type RankedKey = {
	readonly label: string;
	readonly count: number;
};

export type KeyRanking = readonly RankedKey[];

export type TimeSeriesPoint = {
	readonly bucket: string;
	readonly leftClicks: number;
	readonly rightClicks: number;
	readonly movementMeters: number;
	readonly keyPresses: number;
};

export type HistoryData = {
	readonly range: Range;
	/*
	The zone the buckets were aligned to. Carried so the view cannot label
	instants in a different zone than the one they were computed in.
	*/
	readonly timeZone: string;
	readonly totals: Totals;
	readonly keyRanking: KeyRanking;
	readonly timeSeries: readonly TimeSeriesPoint[];
};

/*
Typed failure as a value, rather than a rejection. A rejection raised during a
render is an unhandled rejection, which ends the process by default, so the TUI
would exit instead of drawing the error. The driver's own message travels with
it so that a caller still holding the result can say what went wrong.
*/
export type LoadResult =
	{ok: true; data: HistoryData} | {ok: false; message: string};

/*
The read face, and the whole of what the history view asks for.

Declared here rather than in the view because this module is what answers it —
the seam is one method wide, and `LocalStore` is its only implementation. It is
deliberately not async: `node:sqlite` has no promise in it, and a signature that
promised one would put a wait in a view that has nothing to wait for.

`close` is not part of it. A view reads this file and does not open it; the
composition root owns that lifetime, as it does every other one.
*/
export type HistorySource = {
	load(range: Range, now: Date): LoadResult;
};

/*
What a read reports about itself besides its answer: it failed, and the driver's
own error travels with it.

One thing rather than the union this used to be, and one thing rather than a
bare `unknown` a reader would have to guess the meaning of. `ignored-buckets` was
the other arm, and it was `$bucket`'s sentinel: grouping rows in JavaScript,
bounded by the same boundary list that defines the buckets, leaves no bucket for
a stranger to land in — so it retired with the Mongo read (ADR-0012), and the tag
that told the two apart went with it. A kind with one value is not a kind.
*/
export type ReadWarning = {
	readonly error: unknown;
};

export type ReadWarningReporter = (warning: ReadWarning) => void;

/*
Where a warning goes when nothing has said otherwise: stderr, which is what the
read seam has always done and what it keeps doing. There is no view on a
`collect` run to draw an entry in, so the terminal is where a headless run
reports — and the dashboard supplies its own reporter instead, which is the
whole of the difference between the two modes.

The error travels as a second argument rather than inside the sentence, so the
driver's own stack prints as the driver wrote it.
*/
export const defaultReadWarningReporter: ReadWarningReporter = warning => {
	console.warn('Failed to read telemetry history', warning.error);
};

export type LocalStoreOptions = {
	/*
	Where this store's read warnings go. The dashboard hands over a reporter
	that appends Run Log entries, so a read that failed is one line in the log
	rather than a driver sentence drawn across the frame.
	*/
	readonly onWarning?: ReadWarningReporter;
	/*
	The clock, in epoch milliseconds. Injected for the reason `session.ts` takes
	its shutdown source as an argument: no test can make the real clock step
	backwards, and a stamp that repeats across runs is the one thing this store
	must never allow.
	*/
	readonly now?: () => number;
};

export class LocalStore implements HistorySource {
	readonly #onWarning: ReadWarningReporter;
	readonly #now: () => number;
	readonly #timeZone: string;
	readonly #db: DatabaseSync;
	readonly #selectEras;
	readonly #selectRanking;
	readonly #selectBacklog;
	readonly #selectBacklogKeyCounts;
	readonly #insertEra;
	readonly #clearKeyCounts;
	readonly #insertKeyCount;
	readonly #markPushed;
	readonly #classifyUsage;
	readonly #insertUsage;
	readonly #selectUsageBacklog;
	readonly #markUsagePushed;

	#closed = false;

	/*
	The stamp of a Flush that failed and is still owed. Cleared by the first
	success, which is what makes the *next* Flush open a new era rather than
	overwrite this one.

	Its Telemetry State was not cleared, so the next Flush carries the same
	Activity plus whatever arrived since — and writes under the same stamp,
	which is what turns that retry into a rewrite of the era the failed attempt
	was going to leave instead of a second era beside it. Opened on every
	failure rather than only where a write is known to have landed: the
	transaction in `flush` means there is nothing to overwrite in practice, but
	the call is the same either way, and a stamp that turns out to be unused
	costs nothing but the millisecond it names.
	*/
	#outstandingStamp: number | undefined;

	/*
	The newest stamp this store has handed out, in epoch milliseconds, seeded
	from the file's own newest stamp.

	That seeding is what makes "a stamp repeats nobody" a promise about the
	store rather than about one process (ADR-0009). A clock that steps backwards
	across a restart — an NTP correction, a timezone-less VM, a laptop whose
	battery went flat — would otherwise hand out a stamp an earlier run had
	already used, and against a primary key that is a merge of two eras rather
	than a rewrite of one.
	*/
	#latestStampMs: number;

	constructor(
		config: Config,
		{
			onWarning = defaultReadWarningReporter,
			now = Date.now,
		}: LocalStoreOptions = {},
	) {
		this.#onWarning = onWarning;
		this.#now = now;
		this.#timeZone = config.timeZone;

		/*
		One `try` around opening *and* preparing, because they are one phase. A
		file that claims this schema version and carries none of its tables
		opens cleanly and then fails on the first statement naming one, and that
		failure belongs under "could not open the store": the caller is about to
		exit either way, and a bare "no such table: eras" would not say which
		file, or which of the two things to go and look at. See `openDatabase`.
		*/
		try {
			const db = openDatabase(config.localStorePath);
			this.#db = db;

			const prepare = (sql: string) => db.prepare(sql);

			this.#selectEras = prepare(`
				SELECT stamp, left_clicks, right_clicks, movement_meters, press_total
				FROM eras
				WHERE stamp >= ? AND stamp < ?
				ORDER BY stamp
			`);
			this.#selectRanking = prepare(`
				SELECT label, SUM(count) AS count
				FROM era_key_counts
				WHERE era_stamp >= ? AND era_stamp < ?
				GROUP BY label
			`);
			this.#selectBacklog = prepare(`
				SELECT stamp, left_clicks, right_clicks, movement_meters, press_total
				FROM eras
				WHERE pushed_at IS NULL
				ORDER BY stamp
			`);
			this.#selectBacklogKeyCounts = prepare(`
				SELECT counts.era_stamp AS era_stamp, counts.label AS label, counts.count AS count
				FROM era_key_counts AS counts
				JOIN eras ON eras.stamp = counts.era_stamp
				WHERE eras.pushed_at IS NULL
				ORDER BY counts.era_stamp
			`);
			this.#insertEra = prepare(`
				INSERT INTO eras (stamp, left_clicks, right_clicks, movement_meters, press_total, pushed_at)
				VALUES (?, ?, ?, ?, ?, NULL)
				ON CONFLICT(stamp) DO UPDATE SET
					left_clicks     = excluded.left_clicks,
					right_clicks    = excluded.right_clicks,
					movement_meters = excluded.movement_meters,
					press_total     = excluded.press_total
			`);
			this.#clearKeyCounts = prepare(
				'DELETE FROM era_key_counts WHERE era_stamp = ?',
			);
			this.#insertKeyCount = prepare(
				'INSERT INTO era_key_counts (era_stamp, label, count) VALUES (?, ?, ?)',
			);
			this.#markPushed = prepare(
				'UPDATE eras SET pushed_at = ? WHERE stamp = ?',
			);

			/*
			The fingerprint compared in SQL, column by column, against the six
			stored columns inside the ±5s window. `IS` rather than `=` so a NULL
			model matches a NULL model, the way the fingerprint intends. The
			`BETWEEN` bounds are inclusive, so the window is closed at ±5s.

			`harness` and `cwd` are deliberately not among the columns: two
			Harnesses producing identical model and token counts within the window
			collapse into one record. That is the accepted ceiling ADR-0013 marks,
			and it is here, at the comparison, rather than in the prose above.
			*/
			this.#classifyUsage = prepare(`
				SELECT 1 AS found
				FROM usage_records
				WHERE model IS ?
					AND prompt_tokens = ?
					AND completion_tokens = ?
					AND total_tokens = ?
					AND prompt_cache_hit_tokens = ?
					AND prompt_cache_miss_tokens = ?
					AND recorded_at BETWEEN ? AND ?
				LIMIT 1
			`);
			this.#insertUsage = prepare(`
				INSERT INTO usage_records (
					recorded_at, harness, cwd, model, cost_yuan,
					prompt_tokens, completion_tokens, total_tokens,
					prompt_cache_hit_tokens, prompt_cache_miss_tokens, pushed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
			`);
			this.#selectUsageBacklog = prepare(`
				SELECT id, recorded_at, harness, cwd, model, cost_yuan,
					prompt_tokens, completion_tokens, total_tokens,
					prompt_cache_hit_tokens, prompt_cache_miss_tokens
				FROM usage_records
				WHERE pushed_at IS NULL
				ORDER BY recorded_at, id
			`);
			this.#markUsagePushed = prepare(
				'UPDATE usage_records SET pushed_at = ? WHERE id = ?',
			);

			/*
			One query at open, and the whole of why a stamp cannot repeat across
			runs. `MAX` over an empty table is NULL, which reads as 0 — older than
			any stamp this store will hand out.
			*/
			this.#latestStampMs = numberAt(
				db.prepare('SELECT MAX(stamp) AS stamp FROM eras').get(),
				'stamp',
			);
		} catch (error) {
			throw new Error(
				`Could not open the Local Store at ${config.localStorePath}: ${messageOf(error)}`,
				{cause: error},
			);
		}
	}

	/*
	A stamp no era in this file has used: the wall clock, nudged forward past
	the newest stamp when the clock has not moved yet. At worst an era's stamp
	leads real time by a millisecond — a price worth never keying two eras
	alike.
	*/
	#freshStamp(): number {
		this.#latestStampMs = Math.max(this.#now(), this.#latestStampMs + 1);
		return this.#latestStampMs;
	}

	/*
	One era and its Key Counts, in one transaction.

	This is the one place the store is stronger than the pair of sequential
	upserts ADR-0009 was written for: there is no window in which an era's
	totals are on disk and its Key Counts are not, so a failure leaves nothing
	behind rather than half an era.
	*/
	#writeEra(stamp: number, snapshot: Snapshot): void {
		/*
		`pushed_at` is deliberately not in the update list. Re-writing an era
		does not un-push it: the only way to reach that branch with a non-NULL
		`pushed_at` is to re-use a stamp the store already handed out, which the
		guard above makes impossible — and a Push that landed is a fact this
		statement has no business taking back.
		*/
		this.#insertEra.run(
			stamp,
			snapshot.leftClicks,
			snapshot.rightClicks,
			snapshot.movementMeters,
			snapshot.keysPressed,
		);

		/*
		Cleared rather than upserted, because a retry's Snapshot is a union: a
		label the first attempt carried and the second one did not would
		otherwise survive as a row nothing accounts for.
		*/
		this.#clearKeyCounts.run(stamp);

		for (const [label, count] of Object.entries(snapshot.keyCounts)) {
			this.#insertKeyCount.run(stamp, label, count);
		}
	}

	/*
	Ranked here rather than in SQL: `GROUP BY` output order is unspecified, so a
	list ordered by the database would reshuffle between loads. Ties break on
	the label so the order is total.

	Ties are the reason this is an array and not a `Record`. JavaScript orders
	the integer-like keys of an object numerically, so building one and reading
	it back would put `'2'` before `'10'` regardless of what the counts said.
	*/
	#rankingBetween(since: number, until: number): KeyRanking {
		return this.#selectRanking
			.all(since, until)
			.filter(row => numberAt(row, 'count') > 0)
			.map(row => ({
				label: stringAt(row, 'label'),
				count: numberAt(row, 'count'),
			}))
			.toSorted((a, b) =>
				a.count === b.count ? compare(a.label, b.label) : b.count - a.count,
			);
	}

	/*
	One point per bucket, in order, with the buckets that collected nothing read
	as zero — a quiet hour has to be a short bar rather than a gap in the chart.

	`boundaries` is the bucket identity (ADR-0007), so the rows are placed by it
	and nothing else: bucket `i` is `[boundaries[i], boundaries[i + 1])`.

	Rows and boundaries both ascend, so a single forward walk places every row.
	The query has already confined the rows to `[first, last)`, which is what
	lets the walk only ever move forward and never run off either end.
	*/
	#seriesBetween(
		boundaries: readonly Date[],
		since: number,
		until: number,
	): readonly TimeSeriesPoint[] {
		const starts = boundaries.slice(0, -1).map(boundary => boundary.getTime());
		const points = starts.map(start => ({
			bucket: new Date(start).toISOString(),
			leftClicks: 0,
			rightClicks: 0,
			movementMeters: 0,
			keyPresses: 0,
		}));

		let bucket = 0;
		for (const row of this.#selectEras.all(since, until)) {
			const stamp = numberAt(row, 'stamp');

			while (bucket + 1 < starts.length && starts[bucket + 1]! <= stamp) {
				bucket += 1;
			}

			const point = points[bucket]!;
			point.leftClicks += numberAt(row, 'left_clicks');
			point.rightClicks += numberAt(row, 'right_clicks');
			point.movementMeters += numberAt(row, 'movement_meters');
			point.keyPresses += numberAt(row, 'press_total');
		}

		return points;
	}

	/*
	The write face the Session flushes through.

	`undefined` rather than a throw is the whole contract, exactly as it was
	against MongoDB: the caller keeps Telemetry State and retries the same
	Activity next interval. It is also the *whole* of the report — a warning
	here as well would be one failure said twice, in a place that cannot know
	whether there is a frame on screen to draw it in (ADR-0010).
	*/
	flush(snapshot: Snapshot): FlushStamp {
		const stamp = this.#outstandingStamp ?? this.#freshStamp();

		try {
			inTransaction(this.#db, () => {
				this.#writeEra(stamp, snapshot);
			});
		} catch {
			this.#outstandingStamp ??= stamp;
			return undefined;
		}

		this.#outstandingStamp = undefined;
		return new Date(stamp);
	}

	/*
	The Push Backlog: every era no Push has acknowledged, oldest first.

	"A tail past the last successful Push" is this query and not a second
	structure to keep in step. Order is the point — a Drain works from the
	oldest, so a backlog that is still behind stays a tail rather than a
	scatter of holes.
	*/
	backlog(): readonly Era[] {
		const counts = new Map<number, Record<string, number>>();

		for (const row of this.#selectBacklogKeyCounts.all()) {
			const stamp = numberAt(row, 'era_stamp');
			const forEra = counts.get(stamp) ?? {};
			forEra[stringAt(row, 'label')] = numberAt(row, 'count');
			counts.set(stamp, forEra);
		}

		return this.#selectBacklog.all().map(row => {
			const stamp = numberAt(row, 'stamp');

			return {
				stamp: new Date(stamp),
				leftClicks: numberAt(row, 'left_clicks'),
				rightClicks: numberAt(row, 'right_clicks'),
				movementMeters: numberAt(row, 'movement_meters'),
				pressTotal: numberAt(row, 'press_total'),
				keyCounts: counts.get(stamp) ?? {},
			};
		});
	}

	/*
	An era leaves the Push Backlog when a Push acknowledged it.

	A stamp this store never handed out updates nothing, which is the right
	answer for a caller that names one: nothing was acknowledged because
	nothing was there.
	*/
	markPushed(stamp: Date, at: Date): void {
		this.#markPushed.run(at.getTime(), stamp.getTime());
	}

	/*
	The SELECT half of Ingest: whether a record with this fingerprint — its
	model, canonicalized, plus its five token buckets — is already stored within
	±5s of its own `recorded_at`. It writes nothing, which is what lets a
	Backfill's `--dry-run` classify every candidate against the real store
	without touching it.

	The comparison deliberately excludes `harness` and `cwd`. Two Harnesses that
	produce identical model and token counts within the window collapse into one
	record: the accepted ceiling ADR-0013 names, and the reason the fingerprint is
	what it is. The known limit rides along — two identical candidates in one
	scan both classify as new, since neither is stored yet; the real Ingest drops
	the second.

	The model is canonicalized before it is compared, so a relay id and the name
	its alias maps to are the same record here — which is what makes the alias
	table an identity mechanism and not only a pricing one (ADR-0013, ADR-0015).
	*/
	duplicatesExisting(record: UsageRecord): boolean {
		const at = record.recordedAt.getTime();
		const found = this.#classifyUsage.get(
			canonicalModelName(record.model) ?? null,
			record.prompt_tokens,
			record.completion_tokens,
			record.total_tokens,
			record.prompt_cache_hit_tokens,
			record.prompt_cache_miss_tokens,
			at - DEDUP_WINDOW_MS,
			at + DEDUP_WINDOW_MS,
		);

		return found !== undefined;
	}

	/*
	The write face for Usage Records: classify, then insert. A duplicate is
	dropped and reported rather than written over (ADR-0013), so the first
	writer's row stands; anything else is INSERTed and its row id handed back.

	Synchronous, and it throws on failure rather than answering with a value:
	`node:sqlite` has no promise in it, and the command layer owns the error and
	the exit-code contract (ADR-0016) — a hook command that must never fail its
	agent catches this, it does not come back as a return value.

	The cost is priced here, not supplied by the caller: the model is
	canonicalized, then priced from the record's own tokens at the record's own
	`recordedAt` (ADR-0014). A model the table does not cover stores a NULL cost
	— Unpriced, still a record (ADR-0015) — and the result says so with
	`costYuan` undefined.
	*/
	ingest(record: UsageRecord): IngestResult {
		const model = canonicalModelName(record.model);
		const costYuan = computeCostYuan(model, record, record.recordedAt);

		/*
		Classify and insert are one transaction, and `IMMEDIATE` so the write lock
		is held from the start. Stop and SubagentStop fire near-simultaneously and
		the dashboard may hold the file too, so without this two processes would
		both read an empty window and both INSERT — the duplicate the drop rule
		exists to prevent, written by the very concurrency `busy_timeout` was set
		for. With the lock taken before the classify, the second writer waits and
		then sees the first's committed row, and drops.
		*/
		return inTransaction(
			this.#db,
			(): IngestResult => {
				if (this.duplicatesExisting(record)) {
					return {status: 'duplicate'};
				}

				const {lastInsertRowid} = this.#insertUsage.run(
					record.recordedAt.getTime(),
					record.harness,
					record.cwd ?? null,
					model ?? null,
					costYuan ?? null,
					record.prompt_tokens,
					record.completion_tokens,
					record.total_tokens,
					record.prompt_cache_hit_tokens,
					record.prompt_cache_miss_tokens,
				);

				return {status: 'ingested', id: Number(lastInsertRowid), costYuan};
			},
			'IMMEDIATE',
		);
	}

	/*
	The Usage Backlog: every Ingested record no Push has acknowledged, oldest
	`recorded_at` first and the rowid breaking ties, so the order is total and a
	Drain walks a tail rather than a scatter of holes (ADR-0012).

	Same idiom as the era backlog — the query is the backlog, not a second
	structure to keep in step — and its own query because the two families order
	by different keys: an era by its stamp, a record by `recorded_at`.
	*/
	usageBacklog(): readonly BackloggedUsage[] {
		/* eslint-disable @typescript-eslint/naming-convention -- the five buckets keep the wire's column names. */
		return this.#selectUsageBacklog.all().map(row => ({
			id: numberAt(row, 'id'),
			recordedAt: new Date(numberAt(row, 'recorded_at')),
			harness: stringAt(row, 'harness'),
			cwd: optionalStringAt(row, 'cwd'),
			model: optionalStringAt(row, 'model'),
			costYuan:
				typeof row['cost_yuan'] === 'number' ? row['cost_yuan'] : undefined,
			prompt_tokens: numberAt(row, 'prompt_tokens'),
			completion_tokens: numberAt(row, 'completion_tokens'),
			total_tokens: numberAt(row, 'total_tokens'),
			prompt_cache_hit_tokens: numberAt(row, 'prompt_cache_hit_tokens'),
			prompt_cache_miss_tokens: numberAt(row, 'prompt_cache_miss_tokens'),
		}));
		/* eslint-enable @typescript-eslint/naming-convention */
	}

	/*
	An Ingested record leaves the Usage Backlog when a Push acknowledged it,
	under the row id `ingest` handed out. An id this store never wrote updates
	nothing, the right answer for a Pusher that names one.
	*/
	markUsagePushed(id: number, at: Date): void {
		this.#markUsagePushed.run(at.getTime(), id);
	}

	/*
	The read face: the history view's three questions, answered from this file.

	The view calls this during render, which is what the synchronous signature
	is for: there is nothing to wait on, so there is no loading state to draw and
	no answer to hold in state until it arrives. `HistorySource` is the shape a
	view reaches for, and this is the one implementation.

	The failure comes back as a value rather than a throw, for the reason
	`LoadResult` gives, and it is reported through the warning reporter on the
	way — the dashboard draws an entry, a headless run warns on stderr.
	*/
	load(range: Range, now: Date): LoadResult {
		try {
			/*
			Inside the `try`, not before it. Stepping boundaries throws for a
			zone Intl cannot resolve, and a throw escaping here would end the
			process rather than draw an error — the exact failure this return
			type exists to prevent.
			*/
			const boundaries = bucketBoundaries(range, now, this.#timeZone);
			const since = boundaries[0]!.getTime();
			/*
			Exclusive, and the same window the Key Ranking uses. A row that falls
			in no bucket must not be counted in a ranking either — the ranking is
			the same range asked a different question.
			*/
			const until = boundaries.at(-1)!.getTime();
			const timeSeries = this.#seriesBetween(boundaries, since, until);

			return {
				ok: true,
				data: {
					range,
					timeZone: this.#timeZone,
					totals: totalsOf(timeSeries),
					keyRanking: this.#rankingBetween(since, until),
					timeSeries,
				},
			};
		} catch (error) {
			this.#onWarning({error});
			return {ok: false, message: messageOf(error)};
		}
	}

	/*
	Total, because a second close has to be survivable: the Session closes on
	the way out of a run that may have failed anywhere, and "database is not
	open" replacing the error that actually ended the run would be a worse
	report than no report at all.
	*/
	close(): void {
		if (this.#closed) {
			return;
		}

		this.#closed = true;
		this.#db.close();
	}
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/*
Totals are the series added up, rather than a second aggregate query over the
same window.

That is the point of them being here at all: the view draws the totals *above*
the bars they came from, so "the series sums to the totals" has to hold by
construction. A `SUM` in SQL and a running total in JavaScript are two
different additions — same rows, different order, and REAL `movement_meters`
means the difference is a real one rather than a rounding artifact — so the two
numbers would agree until the day they quietly did not. Adding the points in
bucket order is exactly the arithmetic the view would do to check.
*/
function totalsOf(points: readonly TimeSeriesPoint[]): Totals {
	const totals: {
		leftClicks: number;
		rightClicks: number;
		movementMeters: number;
		pressTotal: number;
	} = {leftClicks: 0, rightClicks: 0, movementMeters: 0, pressTotal: 0};

	for (const point of points) {
		totals.leftClicks += point.leftClicks;
		totals.rightClicks += point.rightClicks;
		totals.movementMeters += point.movementMeters;
		/* `keyPresses` on a point is Press Total: ADR-0004's wire field is
		`keysPressed`, and the glossary's name for the quantity is Press Total. */
		totals.pressTotal += point.keyPresses;
	}

	return totals;
}
