import test from 'ava';
import {type MongoClient} from 'mongodb';
import {type Config} from './config.js';
import {TelemetryState} from './state.js';
import {
	type Collection,
	type Database,
	MongoTelemetryStore,
} from './storage.js';

/*
Fakes
-----
An in-memory stand-in for the slice of the driver this store touches. It is
async on purpose: a synchronous fake would let a missing `await` in the store
pass every test here while losing data against a real server.
*/

class FakeCollection implements Collection {
	readonly name: string;
	readonly indexes = new Map<string, number>();
	readonly documents: Array<Record<string, unknown>> = [];
	failInsertsWith?: Error;
	failIndexesWith?: Error;

	constructor(name: string) {
		this.name = name;
	}

	async createIndex(
		_keys: Record<string, 1 | -1>,
		options: {expireAfterSeconds: number},
	): Promise<string> {
		if (this.failIndexesWith) {
			throw this.failIndexesWith;
		}

		this.indexes.set('createdAt_1', options.expireAfterSeconds);
		return 'createdAt_1';
	}

	async insertOne(
		document: Record<string, unknown>,
	): Promise<{insertedId: string}> {
		if (this.failInsertsWith) {
			throw this.failInsertsWith;
		}

		this.documents.push(document);
		return {insertedId: `id-${this.documents.length}`};
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

/*
Records warnings for assertions without echoing them, so an expected warning
does not clutter the test output.
*/
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

function stateWithActivity() {
	const state = new TelemetryState({mouseDpi: 72});
	state.addLeftClick();
	state.addRightClick();
	state.addRightClick();
	// 36 pixels at 72 DPI is half an inch, so 0.0127m.
	state.addMouseMovement(36);
	state.addKeyPress('A');
	state.addKeyPress('A');
	state.addKeyPress('Return');
	return state;
}

/*
Store construction is what kicks off index creation, and that is deliberately
fire-and-forget, so tests wait for the work rather than for the constructor.
*/
async function buildStore(
	database: Database,
	logger: FakeLogger = new FakeLogger(),
) {
	const store = new MongoTelemetryStore(config, database, {logger});
	await settle();
	return store;
}

async function settle(): Promise<void> {
	await new Promise(resolve => {
		setImmediate(resolve);
	});
}

test('flush writes a telemetry document and a key count document', async t => {
	const database = new FakeDatabase();
	const store = await buildStore(database);

	const result = await store.flush(stateWithActivity().snapshot());

	// The two collections hand out independent id sequences.
	t.deepEqual(result, ['id-1', 'id-1']);

	const [telemetry] = database.collection('telemetry').documents;
	const [heatmap] = database.collection('keyboard_heatmap').documents;

	t.is(telemetry?.['leftClicks'], 1);
	t.is(telemetry?.['rightClicks'], 2);
	t.is(telemetry?.['movementMeters'], 0.0127);
	t.is(telemetry?.['keysPressed'], 3);
	t.is(telemetry?.['apps'], undefined);

	// Key Counts are the document's top-level fields, not a nested object.
	t.is(heatmap?.['A'], 2);
	t.is(heatmap?.['Return'], 1);
});

test('both documents in a flush share one createdAt', async t => {
	const database = new FakeDatabase();
	const store = await buildStore(database);

	await store.flush(stateWithActivity().snapshot());

	const telemetry = database.collection('telemetry').documents[0];
	const heatmap = database.collection('keyboard_heatmap').documents[0];

	t.true(telemetry?.['createdAt'] instanceof Date);
	t.is(telemetry?.['createdAt'], heatmap?.['createdAt']);
});

test('flush skips the key count document when no keys were pressed', async t => {
	const database = new FakeDatabase();
	const store = await buildStore(database);
	const state = new TelemetryState();
	state.addLeftClick();

	const result = await store.flush(state.snapshot());

	t.is(result?.length, 1);
	t.is(database.collection('telemetry').documents.length, 1);
	t.is(database.collection('keyboard_heatmap').documents.length, 0);
});

test('flush reports failure so the caller can keep the state', async t => {
	const database = new FakeDatabase();
	const logger = new FakeLogger();
	const store = await buildStore(database, logger);
	database.collection('keyboard_heatmap').failInsertsWith = new Error('boom');

	const result = await store.flush(stateWithActivity().snapshot());

	// `undefined` rather than throwing is the whole contract: the caller keeps
	// Telemetry State and retries the same data next interval.
	t.is(result, undefined);
	t.is(logger.warnings.length, 1);
});

test('creating the TTL indexes is idempotent', async t => {
	const database = new FakeDatabase();

	await buildStore(database);
	await buildStore(database);

	t.is(database.collection('telemetry').indexes.get('createdAt_1'), 31_536_000);
	t.is(
		database.collection('keyboard_heatmap').indexes.get('createdAt_1'),
		2_592_000,
	);
});

test('without an injected database the store builds one from MongoClient', async t => {
	const database = new FakeDatabase();
	const client = new FakeMongoClient(database);

	const store = new MongoTelemetryStore(
		config,
		undefined,
		{logger: new FakeLogger()},
		client as unknown as MongoClient,
	);
	await settle();

	// The configured database name is what selects the database. Reaching
	// `collection()` straight off the client — as this store used to — is a
	// TypeError against a real driver, and no fake-backed test would see it.
	t.deepEqual(client.databasesRequested, ['test']);
	t.deepEqual(await store.flush(stateWithActivity().snapshot()), [
		'id-1',
		'id-1',
	]);
});

test('close() closes a client the store owns', async t => {
	const client = new FakeMongoClient(new FakeDatabase());
	const store = new MongoTelemetryStore(
		config,
		undefined,
		{logger: new FakeLogger()},
		client as unknown as MongoClient,
	);

	await store.close();

	t.is(client.closeCalls, 1);
});

test('a failed TTL index is a warning, not a crash', async t => {
	const logger = new FakeLogger();
	const database = new FakeDatabase();
	database.collection('telemetry').failIndexesWith = new Error('denied');

	// Construction must not throw, and the rejection must not escape as an
	// unhandled rejection either.
	const store = new MongoTelemetryStore(config, database, {logger});
	await settle();

	t.is(database.collection('telemetry').indexes.size, 0);
	// The second collection is still attempted after the first one failed.
	t.is(
		database.collection('keyboard_heatmap').indexes.get('createdAt_1'),
		2_592_000,
	);
	t.is(logger.warnings.length, 1);
	t.regex(logger.warnings[0]!.message, /TTL index/v);

	// And the store is still usable.
	t.deepEqual(await store.flush(stateWithActivity().snapshot()), [
		'id-1',
		'id-1',
	]);
});
