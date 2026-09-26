/*
The Local Store, against real SQLite files.

This is the one test in the repo that touches the disk, and ADR-0012 amends the
gate to say so: the rule was never "no test database", it was "no test
*server*". Every seam above the store still has a hand-written fake; the store
itself is the thing under test, and a fake of SQLite would be a fake of the one
component whose entire job is to be durable. So the files are real, each one
lives in a directory the test makes and gives back, and nothing here reaches the
network — a bare clone passes.
*/

import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test, {type ExecutionContext} from 'ava';
import {type Config} from './config.js';
import {instantFromLocalFields, type LocalFields} from './local-time.js';
import {
	type HistoryData,
	LocalStore,
	type LoadResult,
	type ReadWarning,
	type TimeSeriesPoint,
} from './local-store.js';
import {type Range} from './ranges.js';
import {type Snapshot} from './state.js';

const ZONE = 'UTC';

function configAt(localStorePath: string, timeZone = ZONE): Config {
	return {
		mongoUri: 'mongodb://localhost/test',
		dbName: 'test',
		collectionName: 'telemetry',
		heatmapCollectionName: 'keyboard_heatmap',
		flushIntervalSeconds: 300,
		mouseDpi: 72,
		collectionTtlSeconds: 31_536_000,
		heatmapTtlSeconds: 2_592_000,
		timeZone,
		localStorePath,
	};
}

/*
A directory one test owns and gives back.

The store's file lives here, and so do the `-wal` and `-shm` files SQLite puts
beside it — which is why the whole directory goes rather than the one path. It
is under the OS's temp directory rather than the repo's, so nothing a test
writes can be committed by accident and the suite still passes on a bare clone.
*/
function temporaryDirectory(t: ExecutionContext): string {
	const directory = mkdtempSync(join(tmpdir(), 'jwoo-cli-test-'));

	t.teardown(() => {
		rmSync(directory, {recursive: true, force: true});
	});

	return directory;
}

function storePath(t: ExecutionContext): string {
	return join(temporaryDirectory(t), 'telemetry.db');
}

/*
What a test says happened in an interval. `keysPressed` is deliberately absent:
it is derived below, because it is the invariant `TelemetryState` maintains and
a fixture that could state the two apart would eventually test a state the
Collectors cannot produce.
*/
type Activity = {
	leftClicks?: number;
	rightClicks?: number;
	movementMeters?: number;
	keyCounts?: Record<string, number>;
};

function snapshot({
	leftClicks = 0,
	rightClicks = 0,
	movementMeters = 0,
	keyCounts = {},
}: Activity = {}): Snapshot {
	return {
		leftClicks,
		rightClicks,
		movementMeters,
		keysPressed: Object.values(keyCounts).reduce(
			(total, count) => total + count,
			0,
		),
		keyCounts,
		apps: {},
	};
}

/*
A clock the test owns. The property the stamp guard exists for is about a clock
that moves the wrong way across a restart, and no test can make the real one do
that — so the store takes its clock as an argument, the way the Session takes
its shutdown source.
*/
type Clock = {
	read(): number;
	set(next: number): void;
};

function clockAt(instant: number): Clock {
	let now = instant;

	return {
		read: () => now,
		set(next: number): void {
			now = next;
		},
	};
}

/*
A Flush at a chosen instant. The test says *when* the era was observed and the
store decides what to stamp it — which is the whole point of the guard, and the
reason these tests never name a stamp they expect to be handed back except to
assert that it did not move.
*/
function flushAt(
	store: LocalStore,
	clock: Clock,
	at: Date,
	activity: Activity = {},
): void {
	clock.set(at.getTime());
	store.flush(snapshot(activity));
}

/*
A second connection to the same file, so a test asserts on what is on disk
rather than on what the store says is. Rows are spread into plain objects
because the driver hands them back with a null prototype, and a deep-equal
against a literal would fail on that alone.
*/
function query(path: string, sql: string): Array<Record<string, unknown>> {
	const db = new DatabaseSync(path);

	try {
		return db
			.prepare(sql)
			.all()
			.map(row => ({...row}));
	} finally {
		db.close();
	}
}

/*
An instant at a local wall-clock reading. Written as fields rather than as a
`Z`-suffixed literal because the point of the DST cases below is that a local
day is not always 24 hours — a UTC literal would be asserting against a zone
that has no transitions in it.
*/
function localInstant(
	fields: Partial<LocalFields> & Pick<LocalFields, 'year' | 'month' | 'day'>,
	timeZone = ZONE,
): Date {
	return instantFromLocalFields(
		{hour: 0, minute: 0, second: 0, millisecond: 0, ...fields},
		timeZone,
	);
}

/*
A read, or a failed test. `load` returns its failure as a value rather than
throwing, so a test that expects an answer has to say what it does when there
isn't one.
*/
function dataFrom(store: LocalStore, range: Range, now: Date): HistoryData {
	const result = store.load(range, now);

	if (!result.ok) {
		throw new Error(`expected a read, got: ${result.message}`);
	}

	return result.data;
}

/*
The message of a read that failed, or a failed test. The mirror of `dataFrom`,
for the same reason: `load` answers with a value either way, so a test that
expects one answer has to say what it does when it gets the other.
*/
function messageFrom(result: LoadResult): string {
	if (result.ok) {
		throw new Error('expected a failed read');
	}

	return result.message;
}

function sumOf(
	points: readonly TimeSeriesPoint[],
	field: 'leftClicks' | 'rightClicks' | 'movementMeters' | 'keyPresses',
): number {
	return points.reduce((total, point) => total + point[field], 0);
}

/*
Records warnings for assertions without echoing them, so an expected warning
does not clutter the test output — the same job `storage.test.ts`'s
`FakeLogger` does for the write seam. The default reporter writes to stderr,
which is right for a run and wrong for a suite that is deliberately provoking
the failure.
*/
function warningRecorder() {
	const warnings: ReadWarning[] = [];

	return {
		warnings,
		report(warning: ReadWarning) {
			warnings.push(warning);
		},
	};
}

test('a Flush writes one era row and one row per Key Label', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	const stamp = store.flush(
		snapshot({
			leftClicks: 1,
			rightClicks: 2,
			movementMeters: 0.0127,
			keyCounts: {A: 2, Return: 1},
		}),
	);
	store.close();

	t.true(stamp instanceof Date);
	t.deepEqual(query(path, 'SELECT * FROM eras'), [
		{
			stamp: stamp?.getTime(),
			left_clicks: 1,
			right_clicks: 2,
			// Metres, after DPI — the store does no arithmetic on it.
			movement_meters: 0.0127,
			press_total: 3,
			// NULL until a Push acknowledges the era.
			pushed_at: null,
		},
	]);
	t.deepEqual(
		query(path, 'SELECT label, count FROM era_key_counts ORDER BY label'),
		[
			{label: 'A', count: 2},
			{label: 'Return', count: 1},
		],
	);
});

test('a Flush writes no Key Count rows when no keys were pressed', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	store.flush(snapshot({leftClicks: 1}));
	store.close();

	t.is(query(path, 'SELECT * FROM eras').length, 1);
	t.is(query(path, 'SELECT * FROM era_key_counts').length, 0);
});

test('a retry under an outstanding stamp overwrites its era rather than duplicating it', t => {
	const path = storePath(t);
	const clock = clockAt(1_000_000);
	const store = new LocalStore(configAt(path), {now: clock.read});

	/*
	Something else holds the write lock, so the Flush fails the way a Flush
	fails: not by throwing at the caller, but by handing back `undefined` so the
	caller keeps Telemetry State and tries again.
	*/
	const blocker = new DatabaseSync(path);
	blocker.exec('BEGIN IMMEDIATE');

	t.is(store.flush(snapshot({leftClicks: 1, keyCounts: {A: 1}})), undefined);

	// The transaction is the whole of the failure: nothing half-written is left
	// for the retry to trip over.
	t.deepEqual(query(path, 'SELECT * FROM eras'), []);

	blocker.exec('ROLLBACK');
	blocker.close();

	// The next interval: the same Telemetry State plus whatever arrived since,
	// since a failed Flush clears nothing.
	clock.set(1_060_000);
	const stamp = store.flush(
		snapshot({leftClicks: 2, rightClicks: 1, keyCounts: {A: 2, Return: 1}}),
	);
	store.close();

	// The era keeps the stamp of the attempt that first tried to record it. It
	// was observed then, and the bucket it belongs in is decided by that.
	t.is(stamp?.getTime(), 1_000_000);

	t.deepEqual(query(path, 'SELECT * FROM eras'), [
		{
			stamp: 1_000_000,
			left_clicks: 2,
			right_clicks: 1,
			movement_meters: 0,
			press_total: 3,
			pushed_at: null,
		},
	]);

	// Rewritten, not added to: the failed attempt's `A: 1` is gone rather than
	// summed into the retry's `A: 2`.
	t.deepEqual(
		query(path, 'SELECT label, count FROM era_key_counts ORDER BY label'),
		[
			{label: 'A', count: 2},
			{label: 'Return', count: 1},
		],
	);
});

test('a successful Flush closes the retry, so the next Flush opens a new era', t => {
	const path = storePath(t);
	const clock = clockAt(1_000_000);
	const store = new LocalStore(configAt(path), {now: clock.read});

	const first = store.flush(snapshot({leftClicks: 1}));
	// The clock has not moved, so the guard is the only thing keeping the two
	// eras apart.
	const second = store.flush(snapshot({leftClicks: 1}));
	store.close();

	t.is(first?.getTime(), 1_000_000);
	t.is(second?.getTime(), 1_000_001);
	t.is(query(path, 'SELECT * FROM eras').length, 2);
});

test('reopening seeds the stamp guard from the file', t => {
	const path = storePath(t);
	const clock = clockAt(1_000_000);

	const first = new LocalStore(configAt(path), {now: clock.read});
	const stamp = first.flush(snapshot({leftClicks: 1}));
	first.close();

	// A new process in the same millisecond — the case a guard that lives only
	// in memory cannot survive, and the whole of why the seeding exists.
	const reopened = new LocalStore(configAt(path), {now: clock.read});
	const next = reopened.flush(snapshot({leftClicks: 1}));
	reopened.close();

	t.is(stamp?.getTime(), 1_000_000);
	t.is(next?.getTime(), 1_000_001);
});

test('reopening cannot reuse a stamp, even after the clock steps backwards', t => {
	const path = storePath(t);
	const clock = clockAt(1_000_000);

	const first = new LocalStore(configAt(path), {now: clock.read});
	first.flush(snapshot({leftClicks: 1}));
	first.close();

	/*
	An NTP correction, a laptop that was asleep, a VM with no clock of its own:
	all of them arrive here, with a stamp already on disk ahead of `now`. Against
	a primary key, handing out that stamp again would merge two eras into one.
	*/
	clock.set(1_000_000 - 86_400_000);

	const reopened = new LocalStore(configAt(path), {now: clock.read});
	const next = reopened.flush(snapshot({leftClicks: 1}));
	reopened.close();

	t.is(next?.getTime(), 1_000_001);
	t.deepEqual(
		query(path, 'SELECT stamp FROM eras ORDER BY stamp').map(
			row => row['stamp'],
		),
		[1_000_000, 1_000_001],
	);
});

test('the backlog is every era no Push has acknowledged, oldest first', t => {
	const path = storePath(t);
	const clock = clockAt(1_000_000);
	const store = new LocalStore(configAt(path), {now: clock.read});

	store.flush(snapshot({leftClicks: 1, keyCounts: {A: 1}}));
	clock.set(1_060_000);
	store.flush(snapshot({rightClicks: 2, movementMeters: 0.5}));
	clock.set(1_120_000);
	store.flush(snapshot({leftClicks: 3, keyCounts: {Return: 4}}));

	const backlog = store.backlog();

	t.deepEqual(
		backlog.map(era => era.stamp.getTime()),
		[1_000_000, 1_060_000, 1_120_000],
	);
	// Whole eras, not just their stamps: the Push builds the wire documents
	// from these, so everything it needs has to be here.
	t.deepEqual(backlog[0], {
		stamp: new Date(1_000_000),
		leftClicks: 1,
		rightClicks: 0,
		movementMeters: 0,
		pressTotal: 1,
		keyCounts: {A: 1},
	});
	t.deepEqual(backlog[1]?.keyCounts, {});
	store.close();
});

test('an acknowledgement takes an era out of the backlog and stamps when', t => {
	const path = storePath(t);
	const clock = clockAt(1_000_000);
	const store = new LocalStore(configAt(path), {now: clock.read});

	store.flush(snapshot({leftClicks: 1}));
	clock.set(1_060_000);
	store.flush(snapshot({leftClicks: 2}));
	clock.set(1_120_000);
	store.flush(snapshot({leftClicks: 3}));

	store.markPushed(new Date(1_060_000), new Date(1_200_000));

	/*
	The store answers the query and nothing more. Acknowledging the middle era
	leaves a hole, and keeping the backlog a *tail* is the Drain's business
	rather than this one's: it works oldest-first and stops at the first
	failure (ADR-0012).
	*/
	t.deepEqual(
		store.backlog().map(era => era.stamp.getTime()),
		[1_000_000, 1_120_000],
	);
	t.is(
		query(path, 'SELECT pushed_at FROM eras WHERE stamp = 1060000')[0]?.[
			'pushed_at'
		],
		1_200_000,
	);

	// A stamp the store never handed out acknowledges nothing, which is the
	// right answer for a Pusher that somehow names one.
	t.notThrows(() => {
		store.markPushed(new Date(999), new Date(1_200_000));
	});
	store.close();
});

test('the read face sums a Range into Totals', t => {
	const path = storePath(t);
	const clock = clockAt(0);
	const store = new LocalStore(configAt(path), {now: clock.read});

	// Monday, which is in this week and not in today.
	flushAt(store, clock, localInstant({year: 2026, month: 3, day: 9, hour: 9}), {
		leftClicks: 100,
	});
	flushAt(
		store,
		clock,
		localInstant({year: 2026, month: 3, day: 10, hour: 9}),
		{
			leftClicks: 1,
			movementMeters: 1.5,
			keyCounts: {A: 2},
		},
	);
	flushAt(
		store,
		clock,
		localInstant({year: 2026, month: 3, day: 10, hour: 9, minute: 30}),
		{leftClicks: 2, rightClicks: 3},
	);

	const now = localInstant({year: 2026, month: 3, day: 10, hour: 12});

	t.deepEqual(dataFrom(store, 'today', now).totals, {
		leftClicks: 3,
		rightClicks: 3,
		movementMeters: 1.5,
		pressTotal: 2,
	});

	// Yesterday is in this week and not in today, which is what makes the two
	// Ranges different questions rather than one with a different label.
	t.is(dataFrom(store, 'week', now).totals.leftClicks, 103);

	/*
	Push is invisible to the read. The store is one file either way, and an era
	the website has not been told about yet is still this machine's history.
	*/
	for (const era of store.backlog()) {
		store.markPushed(era.stamp, new Date(2_000_000));
	}

	t.deepEqual(store.backlog(), []);
	t.is(dataFrom(store, 'today', now).totals.leftClicks, 3);
	store.close();
});

test('Key Ranking orders Key Labels by count, ties broken by label', t => {
	const path = storePath(t);
	const clock = clockAt(0);
	const store = new LocalStore(configAt(path), {now: clock.read});

	flushAt(store, clock, localInstant({year: 2026, month: 3, day: 9, hour: 9}), {
		keyCounts: {A: 2, B: 5},
	});
	flushAt(
		store,
		clock,
		localInstant({year: 2026, month: 3, day: 9, hour: 10}),
		{
			keyCounts: {A: 3, Return: 1},
		},
	);

	const now = localInstant({year: 2026, month: 3, day: 9, hour: 12});
	const {keyRanking} = dataFrom(store, 'today', now);
	store.close();

	// A and B are both on 5, so the order is total rather than whatever the
	// database happened to return.
	t.deepEqual(keyRanking, [
		{label: 'A', count: 5},
		{label: 'B', count: 5},
		{label: 'Return', count: 1},
	]);
});

test('the time series has a point for every bucket, and sums to the totals', t => {
	const path = storePath(t);
	const clock = clockAt(0);
	const store = new LocalStore(configAt(path), {now: clock.read});

	// Bucket one and bucket two, one of them empty.
	flushAt(store, clock, localInstant({year: 2026, month: 3, day: 9, hour: 1}), {
		leftClicks: 2,
		rightClicks: 1,
		movementMeters: 0.25,
		keyCounts: {A: 3},
	});
	flushAt(store, clock, localInstant({year: 2026, month: 3, day: 9, hour: 5}), {
		leftClicks: 4,
		keyCounts: {B: 1, Return: 1},
	});

	const now = localInstant({year: 2026, month: 3, day: 9, hour: 12});
	const data = dataFrom(store, 'today', now);
	store.close();

	// 00:00 through 12:00 inclusive on the way out, so thirteen buckets.
	t.is(data.timeSeries.length, 13);
	t.is(
		data.timeSeries[0]?.bucket,
		localInstant({year: 2026, month: 3, day: 9}).toISOString(),
	);
	t.is(data.timeSeries[1]?.leftClicks, 2);
	// A quiet hour is a zero rather than a gap, or the chart would have a hole
	// where nothing happened.
	t.is(data.timeSeries[2]?.leftClicks, 0);
	t.is(data.timeSeries[5]?.keyPresses, 2);

	// The series is the totals, drawn one bucket at a time. Anything else means
	// a row landed in no bucket, or in two.
	t.is(sumOf(data.timeSeries, 'leftClicks'), data.totals.leftClicks);
	t.is(sumOf(data.timeSeries, 'rightClicks'), data.totals.rightClicks);
	t.is(sumOf(data.timeSeries, 'movementMeters'), data.totals.movementMeters);
	t.is(sumOf(data.timeSeries, 'keyPresses'), data.totals.pressTotal);
});

test('the series still sums to its totals across a DST transition', t => {
	const path = storePath(t);
	const zone = 'America/New_York';
	const clock = clockAt(0);
	const store = new LocalStore(configAt(path, zone), {now: clock.read});

	/*
	Sunday 8 March 2026 is 23 hours long in New York: 02:00 EST becomes 03:00
	EDT. The eras below sit on either side of the skipped hour, half an hour
	apart on the wall clock and in the same local day.
	*/
	const eras: Array<{at: Date; leftClicks: number}> = [
		// The week before, which the Range must not reach into.
		{
			at: localInstant({year: 2026, month: 2, day: 28, hour: 10}, zone),
			leftClicks: 100,
		},
		{
			at: localInstant({year: 2026, month: 3, day: 7, hour: 22}, zone),
			leftClicks: 1,
		},
		{
			at: localInstant(
				{year: 2026, month: 3, day: 8, hour: 1, minute: 30},
				zone,
			),
			leftClicks: 2,
		},
		{
			at: localInstant(
				{year: 2026, month: 3, day: 8, hour: 3, minute: 30},
				zone,
			),
			leftClicks: 4,
		},
	];

	for (const era of eras) {
		clock.set(era.at.getTime());
		store.flush(snapshot({leftClicks: era.leftClicks}));
	}

	// Sunday evening, so the week is Monday the 2nd to Monday the 9th — the
	// only window in which the transition is inside the Range.
	const now = localInstant({year: 2026, month: 3, day: 8, hour: 23}, zone);
	const data = dataFrom(store, 'week', now);
	store.close();

	// Seven daily buckets: Monday the 2nd through Sunday the 8th. The eighth
	// day of the week has lost an hour, and a boundary list built by adding
	// fixed days would have found an eighth bucket somewhere.
	t.is(data.timeSeries.length, 7);
	t.is(data.totals.leftClicks, 7);
	t.is(sumOf(data.timeSeries, 'leftClicks'), 7);

	/*
	Both sides of the skip land in the same local day, which is exactly what a
	fixed 24-hour step gets wrong — and the whole reason the boundary list is
	computed rather than added up.
	*/
	const eighth = data.timeSeries.find(
		point =>
			point.bucket ===
			localInstant({year: 2026, month: 3, day: 8}, zone).toISOString(),
	);
	t.is(eighth?.leftClicks, 6);
});

test('a Range with no eras reads as zeroes rather than nothing', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	const now = localInstant({year: 2026, month: 3, day: 9, hour: 12});
	const data = dataFrom(store, 'today', now);
	store.close();

	t.deepEqual(data.totals, {
		leftClicks: 0,
		rightClicks: 0,
		movementMeters: 0,
		pressTotal: 0,
	});
	t.deepEqual(data.keyRanking, []);
	t.is(data.timeSeries.length, 13);
	t.true(
		data.timeSeries.every(
			point =>
				point.leftClicks === 0 &&
				point.rightClicks === 0 &&
				point.movementMeters === 0 &&
				point.keyPresses === 0,
		),
	);
	// The range and the zone travel with the answer, so the view labels its
	// buckets in the zone they were computed in.
	t.is(data.range, 'today');
	t.is(data.timeZone, ZONE);
});

test('a read that cannot be answered comes back as a value, and is reported', t => {
	const {warnings, report} = warningRecorder();
	const store = new LocalStore(configAt(storePath(t), 'Bogus/Zone'), {
		onWarning: report,
	});

	/*
	Stepping the boundaries throws for a zone Intl cannot resolve, and it throws
	*inside* the read rather than before it — which is the case this return type
	exists for. A rejection raised during a render is an unhandled rejection,
	which ends the process by default, and the TUI would exit rather than draw
	the error.
	*/
	const result = store.load(
		'today',
		localInstant({year: 2026, month: 3, day: 10}),
	);
	store.close();

	t.false(result.ok);
	// The driver's own sentence, passed through rather than replaced.
	t.regex(messageFrom(result), /Bogus\/Zone/v);

	// One failure, reported once. The entry the Run Log draws is built from
	// this, which is why the seam says what happened rather than only that
	// something did.
	t.is(warnings.length, 1);
	t.is(warnings[0]?.kind, 'failed-read');
});

test('a read from a closed store is a value rather than a rejection', t => {
	const store = new LocalStore(configAt(storePath(t)), {
		onWarning: warningRecorder().report,
	});
	store.close();

	// Closing is a way for a read to fail that has nothing to do with the file,
	// and it is reachable: the Session closes the store on the way out of a run
	// while a view may still be asking.
	t.false(
		store.load('today', localInstant({year: 2026, month: 3, day: 10})).ok,
	);
});

test('a file that is not a database fails at open', t => {
	const path = storePath(t);
	writeFileSync(path, 'this is not a SQLite file');

	const error = t.throws(() => new LocalStore(configAt(path)));

	// The path is the actionable part, so the store's error leads with it and
	// SQLite's own sentence follows rather than replacing it.
	t.regex(error.message, /Could not open the Local Store at /v);
	t.regex(error.message, /not a database/iv);
});

test('a path that cannot be opened fails at open', t => {
	const blocked = join(temporaryDirectory(t), 'a-file');
	writeFileSync(blocked, 'not a directory');

	// The Local Store is the only write a Flush is required to reach, so a run
	// that cannot record ends here — at startup, before the preflight and
	// before the frame — rather than after hours of collecting into a retry
	// that can never succeed.
	t.throws(() => new LocalStore(configAt(join(blocked, 'telemetry.db'))), {
		message: /Could not open the Local Store/v,
	});
});

test('a file this CLI did not write fails at open', t => {
	const path = storePath(t);
	const db = new DatabaseSync(path);
	db.exec('CREATE TABLE eras (whatever TEXT)');
	db.close();

	// The schema is created without `IF NOT EXISTS`, so a file that already has
	// an `eras` table is refused rather than written into. An empty file and a
	// foreign one are indistinguishable until something is asked of them, and
	// by then it is too late to be careful.
	t.throws(() => new LocalStore(configAt(path)), {message: /eras/v});
});

test('a file from a newer CLI fails at open', t => {
	const path = storePath(t);
	const db = new DatabaseSync(path);
	db.exec('PRAGMA user_version = 2');
	db.close();

	t.throws(() => new LocalStore(configAt(path)), {
		message: /schema version 2/v,
	});
});

test('a file whose version lies about its tables fails at open', t => {
	const path = storePath(t);
	const db = new DatabaseSync(path);
	// The version this CLI writes, and none of the tables it writes it with, so
	// `migrate` has no reason to look further and the schema is never created.
	db.exec('PRAGMA user_version = 1');
	db.close();

	// The failure is the prepared statement that names `eras`, not `migrate` —
	// and it still has to arrive as the store's error rather than as a bare
	// "no such table" from three frames down. A file is no more openable for
	// having lied about its version.
	t.throws(() => new LocalStore(configAt(path)), {
		message: /Could not open the Local Store at .*no such table/v,
	});
});

test('the store creates the directory its file lives in', t => {
	const path = join(
		temporaryDirectory(t),
		'Library',
		'Application Support',
		'activity-telemetry',
		'telemetry.db',
	);

	// Application Support does not exist on a machine that has never run this
	// CLI, and the default path is inside it.
	const store = new LocalStore(configAt(path));
	store.flush(snapshot({leftClicks: 1}));
	store.close();

	t.true(existsSync(path));
});

test('closing twice is survivable', t => {
	const store = new LocalStore(configAt(storePath(t)));

	store.close();
	// The Session closes on the way out of a run that may have failed anywhere,
	// and a second close reporting "database is not open" would replace the
	// error that actually ended the run.
	t.notThrows(() => {
		store.close();
	});
});
