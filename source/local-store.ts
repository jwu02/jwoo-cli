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
import {type Config} from './config.js';
import {bucketBoundaries, type Range} from './ranges.js';
import {type Snapshot} from './state.js';

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
*/
function inTransaction(db: DatabaseSync, work: () => void): void {
	db.exec('BEGIN');

	try {
		work();
		db.exec('COMMIT');
	} catch (error) {
		try {
			db.exec('ROLLBACK');
		} catch {
			// Nothing to undo; the real error is rethrown below.
		}

		throw error;
	}
}

const SCHEMA_VERSION = 1;

/*
The schema models the **era**, not the wire.

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
const SCHEMA = `
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
The file's schema version, and the drift guard beside it.

A store this CLI has never written to reports `user_version` 0 — and so does an
empty file and a foreign one — so the schema is created *without* `IF NOT
EXISTS`. A table of that name already present is an error rather than something
to build around, because a file that already has an `eras` table this module did
not make is not a file this module can safely write to.
*/
function migrate(db: DatabaseSync): void {
	const version = numberAt(
		db.prepare('PRAGMA user_version').get(),
		'user_version',
	);

	if (version === SCHEMA_VERSION) {
		return;
	}

	if (version !== 0) {
		throw new Error(
			`the file is schema version ${version}, and this CLI writes version ${SCHEMA_VERSION}`,
		);
	}

	inTransaction(db, () => {
		db.exec(SCHEMA);
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
