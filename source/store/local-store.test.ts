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
import {type Snapshot} from '../state.js';
import {type Config} from './config.js';
import {instantFromLocalFields, type LocalFields} from './local-time.js';
import {
	type HistoryData,
	type IngestResult,
	LocalStore,
	type LoadResult,
	type ReadWarning,
	type TimeSeriesPoint,
	type UsageRecord,
} from './local-store.js';
import {type Range} from './ranges.js';

const ZONE = 'UTC';

function configAt(localStorePath: string, timeZone = ZONE): Config {
	return {
		mongoUri: 'mongodb://localhost/test',
		dbName: 'test',
		collectionName: 'telemetry',
		heatmapCollectionName: 'keyboard_heatmap',
		aiUsageCollectionName: 'ai_usage',
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
does not clutter the test output — the same job `push.test.ts`'s
`FakeLogger` does for the Push seam. The default reporter writes to stderr,
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

	// One failure, reported once. The entry the Run Log draws is built from this
	// — and so is the sentence the terminal prints — which is why the seam hands
	// over what went wrong rather than only that something did.
	t.is(warnings.length, 1);
	t.regex(String(warnings[0]?.error), /Bogus\/Zone/v);
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
	db.exec('PRAGMA user_version = 4');
	db.close();

	t.throws(() => new LocalStore(configAt(path)), {
		message: /schema version 4/v,
	});
});

test('a file whose version lies about its tables fails at open', t => {
	const path = storePath(t);
	const db = new DatabaseSync(path);
	// A version the CLI knows and none of the tables it writes that version with.
	db.exec('PRAGMA user_version = 1');
	db.close();

	// The failure is the drift guard's own "no such table", and it still has to
	// arrive as the store's error rather than as a bare one from three frames
	// down. A file is no more openable for having lied about its version.
	t.throws(() => new LocalStore(configAt(path)), {
		message: /Could not open the Local Store at .*no such table/v,
	});

	/*
	And it is left exactly as it was. The probe runs inside the migration
	transaction, so a version-1 file with no era family is refused instead of
	being half-migrated to the current version with a usage table and no eras — which
	would be a file this CLI could then never open again.
	*/
	t.is(
		query(path, 'SELECT user_version FROM pragma_user_version')[0]?.[
			'user_version'
		],
		1,
	);
	t.deepEqual(query(path, 'SELECT name FROM sqlite_master'), []);
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

/*
The second family: Usage Records Ingested through the store's own face, tested
on a real file for the reason the era tests are — durability is the one thing a
fake of SQLite cannot stand in for.
*/

/*
One Usage Record as a Harness would hand it over. The buckets are chosen so a
price is exact: `kimi-k2.5` is flat (miss 4, hit 0.7, out 21), and 500 fresh +
300 miss + 200 hit + 100 out is 0.00544 CNY.
*/
function usageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		harness: 'Claude Code',
		recordedAt: new Date(1_000_000),
		prompt_tokens: 1000,
		completion_tokens: 100,
		total_tokens: 1100,
		prompt_cache_hit_tokens: 200,
		prompt_cache_miss_tokens: 300,
		...overrides,
	};
}

function idOf(result: IngestResult): number {
	if (result.status !== 'ingested') {
		throw new Error('expected an ingested record');
	}

	return result.id;
}

test('an Ingest writes one usage row, priced from its own tokens', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	const result = store.ingest(
		usageRecord({model: 'kimi-k2.5', recordedAt: new Date(1_000_000)}),
	);
	store.close();

	t.deepEqual(result, {status: 'ingested', id: 1, costYuan: 0.00544});
	t.deepEqual(query(path, 'SELECT * FROM usage_records'), [
		{
			id: 1,
			recorded_at: 1_000_000,
			harness: 'Claude Code',
			// No caller-supplied cwd or model: both nullable columns, both NULL.
			cwd: null,
			model: 'kimi-k2.5',
			cost_yuan: 0.00544,
			prompt_tokens: 1000,
			completion_tokens: 100,
			total_tokens: 1100,
			prompt_cache_hit_tokens: 200,
			prompt_cache_miss_tokens: 300,
			// Unknown, not none: the caller reported no Tool Calls or Skills.
			tool_calls: null,
			skills: null,
			// NULL until a Push acknowledges the record.
			pushed_at: null,
		},
	]);
});

test('a caller cannot supply a cost: the model is canonicalized and priced here', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	// A relay id the alias table maps to a priced name. The alias is an identity
	// mechanism as well as a pricing one: the canonical name is what is stored
	// and what the fingerprint carries (ADR-0013, ADR-0015).
	const result = store.ingest(usageRecord({model: 'deepseek/deepseek-flash'}));
	store.close();

	t.is(result.status, 'ingested');
	t.is(
		query(path, 'SELECT model FROM usage_records')[0]?.['model'],
		'deepseek-v4.1-flash',
	);
	// Priced rather than Unpriced, which is the whole point of the alias.
	t.not(
		query(path, 'SELECT cost_yuan FROM usage_records')[0]?.['cost_yuan'],
		null,
	);
});

test("an Ingest prices at the record's own instant, peak or off-peak", t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	const buckets = {
		prompt_tokens: 1000,
		completion_tokens: 100,
		prompt_cache_hit_tokens: 200,
		prompt_cache_miss_tokens: 300,
	} as const;

	// 01:00Z is 09:00 Beijing, the peak window opening; 12:00Z is 20:00 Beijing,
	// off-peak, and the same record prices at half. A wall clock at Ingest would
	// price both the same.
	const peak = store.ingest(
		usageRecord({
			model: 'deepseek-v4-flash',
			recordedAt: new Date('2026-01-01T01:00:00.000Z'),
			...buckets,
		}),
	);
	const offpeak = store.ingest(
		usageRecord({
			model: 'deepseek-v4-flash',
			recordedAt: new Date('2026-01-01T12:00:00.000Z'),
			...buckets,
		}),
	);
	store.close();

	// Peak is exactly double off-peak for this model, and the two records differ
	// only in their instant.
	t.deepEqual(peak, {status: 'ingested', id: 1, costYuan: 0.00332});
	t.deepEqual(offpeak, {status: 'ingested', id: 2, costYuan: 0.00166});
});

test('an Unpriced model still Ingests, with a null cost', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	const result = store.ingest(usageRecord({model: 'mystery-1'}));
	store.close();

	// Unpriced is the accepted state, not a defect: the record lands, its cost is
	// the marker (ADR-0015).
	t.deepEqual(result, {status: 'ingested', id: 1, costYuan: undefined});
	t.is(
		query(path, 'SELECT cost_yuan FROM usage_records')[0]?.['cost_yuan'],
		null,
	);
});

test("a re-Ingest inside the window drops, leaving the first writer's row", t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	const first = store.ingest(
		usageRecord({
			model: 'kimi-k2.5',
			recordedAt: new Date(1_000_000),
			cwd: '/first',
		}),
	);
	/*
	A different Harness and cwd, one second later, same model and buckets. The
	fingerprint excludes both — two Harnesses producing identical counts within
	the window collapse into one record — which is the accepted ceiling ADR-0013
	marks (and the code comment beside the comparison repeats).
	*/
	const second = store.ingest(
		usageRecord({
			model: 'kimi-k2.5',
			recordedAt: new Date(1_001_000),
			cwd: '/second',
			harness: 'OpenCode',
		}),
	);
	store.close();

	t.is(first.status, 'ingested');
	t.deepEqual(second, {status: 'duplicate'});

	// Dropped, not overwritten: the row is the first writer's, cwd and harness
	// and all (ADR-0013).
	t.deepEqual(query(path, 'SELECT cwd, harness FROM usage_records'), [
		{cwd: '/first', harness: 'Claude Code'},
	]);
});

test('the dedup window is symmetric and closed at five seconds', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));
	const at = 1_000_000;
	store.ingest(usageRecord({model: 'kimi-k2.5', recordedAt: new Date(at)}));

	const isDuplicateAt = (offset: number) =>
		store.duplicatesExisting(
			usageRecord({model: 'kimi-k2.5', recordedAt: new Date(at + offset)}),
		);

	t.true(isDuplicateAt(5000));
	t.true(isDuplicateAt(-5000));
	t.false(isDuplicateAt(5001));
	t.false(isDuplicateAt(-5001));
	store.close();
});

test('a differing bucket or model is a different record, not a duplicate', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));
	store.ingest(usageRecord({model: 'kimi-k2.5'}));

	t.false(
		store.duplicatesExisting(
			usageRecord({model: 'kimi-k2.5', completion_tokens: 101}),
		),
	);
	t.false(store.duplicatesExisting(usageRecord({model: 'kimi-k2.6'})));
	store.close();
});

test('the classify face writes nothing', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	t.false(store.duplicatesExisting(usageRecord()));
	store.close();

	// The SELECT half of Ingest, which is what makes it safe for `--dry-run`.
	t.is(query(path, 'SELECT * FROM usage_records').length, 0);
});

test('the Usage Backlog is every unacknowledged record, oldest recorded_at first', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	/*
	Inserted out of order, and two at the same instant, so the order is the
	query's rather than insertion's: oldest `recorded_at`, rowid breaking ties.
	The differing completion counts keep the four fingerprints distinct.
	*/
	const late = store.ingest(
		usageRecord({recordedAt: new Date(3_000_000), completion_tokens: 1}),
	);
	const early = store.ingest(
		usageRecord({recordedAt: new Date(1_000_000), completion_tokens: 2}),
	);
	const tieA = store.ingest(
		usageRecord({recordedAt: new Date(2_000_000), completion_tokens: 3}),
	);
	const tieB = store.ingest(
		usageRecord({recordedAt: new Date(2_000_000), completion_tokens: 4}),
	);

	const backlog = store.usageBacklog();
	store.close();

	t.deepEqual(
		backlog.map(record => record.id),
		[idOf(early), idOf(tieA), idOf(tieB), idOf(late)],
	);
	// Whole records: the Push builds the wire documents from these.
	t.deepEqual(backlog[0], {
		id: idOf(early),
		recordedAt: new Date(1_000_000),
		harness: 'Claude Code',
		cwd: undefined,
		model: undefined,
		costYuan: undefined,
		prompt_tokens: 1000,
		completion_tokens: 2,
		total_tokens: 1100,
		prompt_cache_hit_tokens: 200,
		prompt_cache_miss_tokens: 300,
		toolCalls: undefined,
		skills: undefined,
	});
});

test('an acknowledgement takes a record out of the Usage Backlog', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	const first = store.ingest(
		usageRecord({recordedAt: new Date(1_000_000), completion_tokens: 1}),
	);
	const middle = store.ingest(
		usageRecord({recordedAt: new Date(2_000_000), completion_tokens: 2}),
	);
	const last = store.ingest(
		usageRecord({recordedAt: new Date(3_000_000), completion_tokens: 3}),
	);

	store.markUsagePushed(idOf(middle), new Date(4_000_000));

	// An id the store never handed out acknowledges nothing, which is the right
	// answer for a Pusher that somehow names one.
	t.notThrows(() => {
		store.markUsagePushed(999, new Date(4_000_000));
	});

	const remaining = store.usageBacklog().map(record => record.id);
	store.close();

	t.deepEqual(remaining, [idOf(first), idOf(last)]);
	t.is(
		query(
			path,
			`SELECT pushed_at FROM usage_records WHERE id = ${idOf(middle)}`,
		)[0]?.['pushed_at'],
		4_000_000,
	);
});

test('a v3 store round-trips a Tool Call count and a Skill list', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	const result = store.ingest(
		usageRecord({
			model: 'kimi-k2.5',
			toolCalls: 4,
			skills: ['commit', 'review', 'commit'],
		}),
	);
	const backlog = store.usageBacklog();
	store.close();

	t.is(result.status, 'ingested');
	// Order and repeats are the record: the list's length is the distinct count's
	// derivation, so nothing here may reorder or collapse it.
	t.is(backlog[0]?.toolCalls, 4);
	t.deepEqual(backlog[0]?.skills, ['commit', 'review', 'commit']);
});

test('a row written without either field reads back unknown, not zero', t => {
	const path = storePath(t);
	const store = new LocalStore(configAt(path));

	store.ingest(usageRecord());
	const backlog = store.usageBacklog();
	store.close();

	/*
	Absent is unknown, not none. `0` and `[]` are the Harness that reported
	genuinely no tools, which is a different fact from a Harness that never
	reported at all.
	*/
	t.is(backlog[0]?.toolCalls, undefined);
	t.is(backlog[0]?.skills, undefined);
	t.is(
		query(path, 'SELECT tool_calls, skills FROM usage_records')[0]?.[
			'tool_calls'
		],
		null,
	);
});

test('a v2 store migrates to v3 in place, its usage rows reading back unknown', t => {
	const path = storePath(t);
	const db = new DatabaseSync(path);
	/*
	The version-2 schema, written out as history rather than imported: this is
	the file the CLI that wrote version 2 leaves, with a usage row that predates
	the two new fields.
	*/
	db.exec(`
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
		INSERT INTO eras VALUES (1000, 1, 2, 0.5, 3, NULL);
		INSERT INTO era_key_counts VALUES (1000, 'A', 3);
		INSERT INTO usage_records VALUES (
			1, 1000000, 'Claude Code', NULL, 'kimi-k2.5', NULL,
			1000, 100, 1100, 200, 300, NULL
		);
		PRAGMA user_version = 2;
	`);
	db.close();

	const store = new LocalStore(configAt(path));
	const backlog = store.usageBacklog();
	store.close();

	t.is(
		query(path, 'SELECT user_version FROM pragma_user_version')[0]?.[
			'user_version'
		],
		3,
	);

	// The era family is exactly as it was: nothing aged out and nothing moved.
	t.deepEqual(query(path, 'SELECT * FROM eras'), [
		{
			stamp: 1000,
			left_clicks: 1,
			right_clicks: 2,
			movement_meters: 0.5,
			press_total: 3,
			pushed_at: null,
		},
	]);

	/*
	The pre-existing row survives the additive migration and its two new columns
	are NULL — the unknown state, not a zero the CLI invented.
	*/
	t.is(backlog.length, 1);
	t.is(backlog[0]?.toolCalls, undefined);
	t.is(backlog[0]?.skills, undefined);
	t.deepEqual(query(path, 'SELECT tool_calls, skills FROM usage_records'), [
		{tool_calls: null, skills: null},
	]);
});

test('a v1 store is migrated in place, keeping the era family', t => {
	const path = storePath(t);
	const db = new DatabaseSync(path);
	/*
	The version-1 schema, written out as history rather than imported: this is
	the file a user has on disk from the CLI that wrote version 1, and the
	migration has to meet it as it is.
	*/
	db.exec(`
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
		INSERT INTO eras VALUES (1000, 1, 2, 0.5, 3, NULL);
		INSERT INTO era_key_counts VALUES (1000, 'A', 3);
		PRAGMA user_version = 1;
	`);
	db.close();

	const store = new LocalStore(configAt(path));
	const result = store.ingest(usageRecord({recordedAt: new Date(1_000_000)}));
	const backlog = store.usageBacklog();
	store.close();

	// The usage family exists now, and the store is at the version this CLI
	// writes.
	t.is(result.status, 'ingested');
	t.is(backlog.length, 1);
	t.is(
		query(path, 'SELECT user_version FROM pragma_user_version')[0]?.[
			'user_version'
		],
		3,
	);

	// The era family is exactly as it was: nothing aged out and nothing moved.
	t.deepEqual(query(path, 'SELECT * FROM eras'), [
		{
			stamp: 1000,
			left_clicks: 1,
			right_clicks: 2,
			movement_meters: 0.5,
			press_total: 3,
			pushed_at: null,
		},
	]);
	t.deepEqual(query(path, 'SELECT * FROM era_key_counts'), [
		{era_stamp: 1000, label: 'A', count: 3},
	]);
});
