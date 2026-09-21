import test from 'ava';
import {type MongoClient} from 'mongodb';
import {type Config} from './config.js';
import {
	type AggregationCursor,
	type Collection,
	type Database,
	type HistoryData,
	type TimeSeriesPoint,
	MongoHistorySource,
} from './history.js';
import {type Range} from './ranges.js';

/*
Fakes
-----
An in-memory stand-in for the slice of the driver this reader touches, in the
same spirit as `storage.test.ts`. `aggregate` is synchronous because the
driver's is — the `await` belongs on `toArray()` — and a fake that returned a
promise would let a reader that forgot to call `toArray()` pass every test here
while fetching nothing against a real server.
*/

type Pipeline = ReadonlyArray<Record<string, unknown>>;

class FakeCollection implements Collection {
	readonly name: string;
	readonly pipelines: Pipeline[] = [];
	respond: (pipeline: Pipeline) => unknown[] = () => [];
	failWith?: Error;

	constructor(name: string) {
		this.name = name;
	}

	aggregate(pipeline: Pipeline): AggregationCursor {
		this.pipelines.push(pipeline);
		return {
			toArray: async () => {
				if (this.failWith) {
					throw this.failWith;
				}

				return this.respond(pipeline);
			},
		};
	}
}

class FakeDatabase implements Database {
	readonly collections = new Map<string, FakeCollection>();

	collection(name: string): FakeCollection {
		const existing = this.collections.get(name);
		if (existing) {
			return existing;
		}

		const created = new FakeCollection(name);
		this.collections.set(name, created);
		return created;
	}
}

/*
Stands in for a real `MongoClient`, which is *not* itself a database: it hands
one out by name. That distinction is the whole point of this fake.
*/
class FakeMongoClient {
	readonly database: FakeDatabase;
	readonly databasesRequested: string[] = [];
	closeCalls = 0;

	constructor(database: FakeDatabase) {
		this.database = database;
	}

	db(dbName: string): FakeDatabase {
		this.databasesRequested.push(dbName);
		return this.database;
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
	}
}

class FakeLogger implements Pick<Console, 'warn'> {
	readonly warnings: Array<{message: string; error: unknown}> = [];

	warn(message: string, error: unknown): void {
		this.warnings.push({message, error});
	}
}

const config: Config = {
	mongoUri: 'mongodb://localhost/test',
	dbName: 'test',
	collectionName: 'telemetry',
	heatmapCollectionName: 'keyboard_heatmap',
	flushIntervalSeconds: 300,
	mouseDpi: 72,
	collectionTtlSeconds: 31_536_000,
	heatmapTtlSeconds: 2_592_000,
	timeZone: 'UTC',
};

// Local midday. 2026-09-21 is a Monday, 2026-09-23 a Wednesday.
const MONDAY_NOON = new Date('2026-09-21T12:00:00.000Z');
const WEDNESDAY_NOON = new Date('2026-09-23T12:00:00.000Z');

function totalsRow(overrides: Record<string, unknown> = {}) {
	return {
		_id: null,
		leftClicks: 10,
		rightClicks: 4,
		movementMeters: 12.5,
		pressTotal: 30,
		...overrides,
	};
}

function seriesRow(
	at: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		_id: new Date(at),
		leftClicks: 0,
		rightClicks: 0,
		movementMeters: 0,
		keyPresses: 0,
		...overrides,
	};
}

/*
The telemetry collection answers two different questions, so the fake picks a
reply by the shape of the pipeline it is handed. Asking the pipeline rather
than counting calls keeps the tests independent of the order the reader
happens to issue them in.
*/
function databaseWith({
	totals = [],
	keys = [],
	series = [],
}: {
	totals?: unknown[];
	keys?: unknown[];
	series?: unknown[];
} = {}): FakeDatabase {
	const database = new FakeDatabase();
	database.collection(config.collectionName).respond = pipeline =>
		hasBucketStage(pipeline) ? series : totals;
	database.collection(config.heatmapCollectionName).respond = () => keys;
	return database;
}

const hasBucketStage = (pipeline: Pipeline) =>
	pipeline.some(stage => '$bucket' in stage);

async function load(
	source: MongoHistorySource,
	range: Range,
	now: Date,
): Promise<HistoryData> {
	const result = await source.load(range, now);
	if (!result.ok) {
		throw new Error(`load failed: ${result.message}`);
	}

	return result.data;
}

const buildSource = (
	database: Database,
	logger = new FakeLogger(),
	overrides: Partial<Config> = {},
) => new MongoHistorySource({...config, ...overrides}, database, {logger});

/*
A load that is expected to fail. Throwing here rather than asserting keeps the
assertion out of a conditional, where ava cannot see that it runs.
*/
async function failureOf(
	source: MongoHistorySource,
	range: Range,
	now: Date,
): Promise<{ok: false; message: string}> {
	const result = await source.load(range, now);
	if (result.ok) {
		throw new Error(
			`expected a failure, got ${result.data.timeSeries.length} points`,
		);
	}

	return result;
}

function sumOf(points: readonly TimeSeriesPoint[]) {
	const summed = {leftClicks: 0, rightClicks: 0, keyPresses: 0};

	for (const point of points) {
		summed.leftClicks += point.leftClicks;
		summed.rightClicks += point.rightClicks;
		summed.keyPresses += point.keyPresses;
	}

	return summed;
}

/*
The `since` of a pipeline is its first stage's lower bound. Both the totals
pipeline and the time series open with a `$match` on `createdAt`, so this reads
either without caring which is which.
*/
function sinceOf(pipeline: Pipeline): unknown {
	const [match] = pipeline as [
		{$match: {createdAt: {$gte: unknown}}},
		...unknown[],
	];
	return match.$match.createdAt.$gte;
}

test('load reads totals, key counts and the time series', async t => {
	const database = databaseWith({
		totals: [totalsRow()],
		keys: [
			{_id: 'A', count: 5},
			{_id: 'Return', count: 2},
		],
	});

	const data = await load(buildSource(database), 'today', MONDAY_NOON);

	t.is(data.totals.leftClicks, 10);
	t.is(data.totals.rightClicks, 4);
	t.is(data.totals.movementMeters, 12.5);
	t.is(data.totals.pressTotal, 30);

	t.is(database.collection(config.collectionName).pipelines.length, 2);
	t.is(database.collection(config.heatmapCollectionName).pipelines.length, 1);
});

test('every pipeline scopes to the same instant — local midnight', async t => {
	const database = databaseWith();

	await load(buildSource(database), 'today', MONDAY_NOON);

	// Totals, key counts and the chart all describe one interval. The website
	// leaves totals unfiltered, which is the divergence ADR-0007 records.
	const expected = new Date('2026-09-21T00:00:00.000Z');
	const pipelines = [
		...database.collection(config.collectionName).pipelines,
		...database.collection(config.heatmapCollectionName).pipelines,
	];

	t.is(pipelines.length, 3);
	for (const pipeline of pipelines) {
		t.deepEqual(sinceOf(pipeline), expected);
	}
});

test('the range is read in the configured timezone', async t => {
	const database = databaseWith();

	// Shanghai is eight hours ahead, so local midnight is 16:00Z the day before.
	await load(
		buildSource(database, new FakeLogger(), {timeZone: 'Asia/Shanghai'}),
		'today',
		MONDAY_NOON,
	);

	for (const pipeline of database.collection(config.collectionName).pipelines) {
		t.deepEqual(sinceOf(pipeline), new Date('2026-09-20T16:00:00.000Z'));
	}
});

test('an empty database reads as zeroes, not as an empty frame', async t => {
	const database = databaseWith();

	const data = await load(buildSource(database), 'today', MONDAY_NOON);

	// The first-run case the issue is built around: historical data already in
	// Mongo, but nothing collected in this Range.
	t.deepEqual(data.totals, {
		leftClicks: 0,
		rightClicks: 0,
		movementMeters: 0,
		pressTotal: 0,
	});
	t.deepEqual(data.keyRanking, []);

	// Local midnight to the bucket after noon: 13 buckets, one per hour.
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
});

test('a bucket with no documents is a zero, and the series stays ordered', async t => {
	const database = databaseWith({
		series: [
			seriesRow('2026-09-21T00:00:00.000Z', {leftClicks: 3}),
			// 01:00 is absent: nothing was collected that hour.
			seriesRow('2026-09-21T02:00:00.000Z', {leftClicks: 5}),
		],
	});

	const data = await load(buildSource(database), 'today', MONDAY_NOON);

	t.is(data.timeSeries.length, 13);
	t.is(data.timeSeries[0]!.bucket, '2026-09-21T00:00:00.000Z');
	t.is(data.timeSeries[0]!.leftClicks, 3);
	t.is(data.timeSeries[1]!.bucket, '2026-09-21T01:00:00.000Z');
	t.is(data.timeSeries[1]!.leftClicks, 0);
	t.is(data.timeSeries[2]!.leftClicks, 5);
});

/*
The property the whole boundary design exists to protect: because the chart and
the totals are scoped identically, the buckets have to add up to the totals. If
a bucket were ever missed — the failure mode of generating keys client-side and
asking the server to match them — this is what would catch it.
*/
test('the buckets sum to the totals', async t => {
	const database = databaseWith({
		totals: [totalsRow({leftClicks: 6, rightClicks: 3, pressTotal: 9})],
		series: [
			seriesRow('2026-09-21T00:00:00.000Z', {
				leftClicks: 1,
				rightClicks: 1,
				keyPresses: 4,
			}),
			seriesRow('2026-09-21T05:00:00.000Z', {
				leftClicks: 5,
				rightClicks: 2,
				keyPresses: 5,
			}),
		],
	});

	const data = await load(buildSource(database), 'today', MONDAY_NOON);

	const summed = sumOf(data.timeSeries);
	t.is(summed.leftClicks, data.totals.leftClicks);
	t.is(summed.rightClicks, data.totals.rightClicks);
	t.is(summed.keyPresses, data.totals.pressTotal);
});

test('the week buckets by day from Monday', async t => {
	const database = databaseWith();

	const data = await load(buildSource(database), 'week', WEDNESDAY_NOON);

	// Monday, Tuesday, Wednesday, and the bucket the current day is in.
	t.is(data.timeSeries.length, 3);
	t.is(data.timeSeries[0]!.bucket, '2026-09-21T00:00:00.000Z');
	t.is(data.timeSeries[2]!.bucket, '2026-09-23T00:00:00.000Z');
});

/*
Ranked on this side rather than by `$group`, whose output order is unspecified.
The digit labels are the reason it matters: JavaScript orders object keys
numerically, so a `Record` would silently reorder `'2'` and `'10'` and the list
would jitter between loads.
*/
test('key counts are ranked by count, then by label', async t => {
	const database = databaseWith({
		keys: [
			{_id: '2', count: 5},
			{_id: 'A', count: 3},
			{_id: '10', count: 5},
			{_id: 'Z', count: 0},
			{_id: 'B', count: -1},
		],
	});

	const data = await load(buildSource(database), 'today', MONDAY_NOON);

	t.deepEqual(data.keyRanking, [
		{label: '10', count: 5},
		{label: '2', count: 5},
		{label: 'A', count: 3},
	]);
});

test('a bucket outside the boundaries is dropped and warned about', async t => {
	const logger = new FakeLogger();
	const database = databaseWith({
		series: [
			// `$bucket`'s `default` label, and a date the boundaries never named.
			{_id: 'out-of-range', leftClicks: 900, keyPresses: 900},
			seriesRow('2020-01-01T00:00:00.000Z', {leftClicks: 900}),
		],
	});

	const data = await load(buildSource(database, logger), 'today', MONDAY_NOON);

	// Silently zero-filling these would hide a boundary bug; counting them
	// would invent a bucket that does not exist.
	t.is(sumOf(data.timeSeries).leftClicks, 0);
	t.is(logger.warnings.length, 1);
	t.regex(logger.warnings[0]!.message, /boundar/v);
});

test('a failed read is a value, and the raw error reaches the log', async t => {
	const logger = new FakeLogger();
	const database = databaseWith();
	const failure = new Error('connection reset');
	database.collection(config.collectionName).failWith = failure;

	/*
	Resolved rather than rejected, deliberately. A rejected promise inside an
	effect is an unhandled rejection, which ends the process by default — the
	TUI would exit instead of drawing an error. The message is what the view
	renders; the raw error goes to the log.
	*/
	const {message} = await failureOf(
		buildSource(database, logger),
		'today',
		MONDAY_NOON,
	);

	t.is(message, 'connection reset');
	t.is(logger.warnings.length, 1);
	t.is(logger.warnings[0]!.error, failure);
});

/*
Working out the boundaries can throw before a query is ever issued — a zone
Intl cannot resolve is enough. That has to be a value too: it is the same
promise, and a rejection escaping it ends the process just as surely.
*/
test('a failure before the query is still a value', async t => {
	const logger = new FakeLogger();
	const source = buildSource(databaseWith(), logger, {timeZone: 'Bogus/Zone'});

	const {message} = await failureOf(source, 'today', MONDAY_NOON);

	t.true(message.length > 0);
	t.is(logger.warnings.length, 1);
});

test('without an injected database the reader builds one from MongoClient', async t => {
	const database = new FakeDatabase();
	const client = new FakeMongoClient(database);

	const source = new MongoHistorySource(
		config,
		undefined,
		{logger: new FakeLogger()},
		client as unknown as MongoClient,
	);

	await load(source, 'today', MONDAY_NOON);

	// The configured database name is what selects the database. Reaching
	// `collection()` straight off the client is a TypeError against a real
	// driver, and no fake-backed test would see it.
	t.deepEqual(client.databasesRequested, ['test']);
});

test('close() closes a client the reader owns', async t => {
	const client = new FakeMongoClient(new FakeDatabase());
	const source = new MongoHistorySource(
		config,
		undefined,
		{logger: new FakeLogger()},
		client as unknown as MongoClient,
	);

	await source.close();

	t.is(client.closeCalls, 1);
});

test('close() leaves an injected database alone', async t => {
	// An injected database belongs to whoever passed it in — closing it here
	// would pull the connection out from under them.
	const source = buildSource(new FakeDatabase());

	await t.notThrowsAsync(source.close());
});
