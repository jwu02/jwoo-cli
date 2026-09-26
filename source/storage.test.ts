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
	readonly collectionName: string;
	readonly indexes = new Map<string, number>();
	readonly documents: Array<Record<string, unknown>> = [];
	failWritesWith?: Error;
	/*
	Records the write and *then* rejects, standing in for a write whose
	acknowledgement was lost rather than its effect — a timeout after the
	server applied it.
	*/
	failAfterWriteWith?: Error;
	failIndexesWith?: Error;

	constructor(name: string) {
		this.collectionName = name;
	}

	/*
	Upsert semantics as the driver has them: `upsert: false` matches nothing
	and writes nothing, which is what catches a store that dropped the option
	it depends on.
	*/
	#upsert(
		filter: {_id: string},
		replacement: Record<string, unknown>,
		options: {upsert: boolean},
	): {upsertedId?: string; matchedCount?: number} {
		const existing = this.documents.findIndex(
			document => document['_id'] === filter._id,
		);

		if (existing === -1) {
			if (!options.upsert) {
				return {matchedCount: 0};
			}

			this.documents.push(replacement);
			return {upsertedId: String(replacement['_id'])};
		}

		// Replaced in place, so a document's position says which Flush wrote it.
		this.documents[existing] = replacement;
		return {matchedCount: 1};
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

	async replaceOne(
		filter: {_id: string},
		replacement: Record<string, unknown>,
		options: {upsert: boolean},
	): Promise<{upsertedId?: string; matchedCount?: number}> {
		if (this.failAfterWriteWith) {
			const error = this.failAfterWriteWith;
			this.#upsert(filter, replacement, options);
			throw error;
		}

		if (this.failWritesWith) {
			throw this.failWritesWith;
		}

		return this.#upsert(filter, replacement, options);
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
	// Unused here: these tests drive the Mongo seam, which ADR-0012 retires.
	localStorePath: '/tmp/jwoo-cli-test/telemetry.db',
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

	const [telemetry] = database.collection('telemetry').documents;
	const [heatmap] = database.collection('keyboard_heatmap').documents;

	// The result names exactly the documents the collections now hold: each id
	// is the Flush's stamp plus the collection's name (ADR-0009).
	t.deepEqual(result, [telemetry?.['_id'], heatmap?.['_id']]);

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
	database.collection('keyboard_heatmap').failWritesWith = new Error('boom');

	const result = await store.flush(stateWithActivity().snapshot());

	// `undefined` rather than throwing is the whole contract: the caller keeps
	// Telemetry State and retries the same data next interval.
	t.is(result, undefined);

	/*
	And it is the *whole* of the report. A warning here as well would be one
	failure said twice, in a place that cannot know whether there is a frame on
	screen to draw it in — the caller that received the `undefined` is the one
	that decides where the news belongs (ADR-0010).
	*/
	t.deepEqual(logger.warnings, []);
});

test('a Flush that failed after writing is overwritten by the retry, not duplicated', async t => {
	const database = new FakeDatabase();
	const store = await buildStore(database);
	database.collection('keyboard_heatmap').failWritesWith = new Error('boom');

	await store.flush(stateWithActivity().snapshot());

	// The partial Flush left its Telemetry Document behind.
	const [partial] = database.collection('telemetry').documents;
	t.is(partial?.['keysPressed'], 3);

	// The retry is the same Telemetry State plus the next interval's Activity —
	// one accumulator that kept counting, not a second one.
	const state = stateWithActivity();
	state.addKeyPress('Escape');
	database.collection('keyboard_heatmap').failWritesWith = undefined;

	const result = await store.flush(state.snapshot());

	t.is(result?.length, 2);
	t.is(database.collection('telemetry').documents.length, 1);
	t.is(database.collection('keyboard_heatmap').documents.length, 1);

	// The surviving Telemetry Document holds the union, and it carries the
	// failed attempt's createdAt: the reader buckets on that field, so the era
	// lands where its first attempt put it.
	const [telemetry] = database.collection('telemetry').documents;
	t.is(telemetry?.['keysPressed'], 4);
	t.is(telemetry?.['createdAt'], partial?.['createdAt']);

	const [heatmap] = database.collection('keyboard_heatmap').documents;
	t.is(heatmap?.['A'], 2);
	t.is(heatmap?.['Return'], 1);
	t.is(heatmap?.['Escape'], 1);
});

test('a retry that fails again keeps overwriting the same documents', async t => {
	const database = new FakeDatabase();
	const store = await buildStore(database);
	const heatmap = database.collection('keyboard_heatmap');
	heatmap.failWritesWith = new Error('boom');

	await store.flush(stateWithActivity().snapshot());

	const state = stateWithActivity();
	state.addKeyPress('Escape');
	await store.flush(state.snapshot());
	t.is(database.collection('telemetry').documents.length, 1);

	state.addKeyPress('Escape');
	heatmap.failWritesWith = undefined;
	await store.flush(state.snapshot());

	// Two failed attempts and one success still leave one document per
	// collection, holding everything the era observed.
	t.is(database.collection('telemetry').documents.length, 1);
	t.is(heatmap.documents.length, 1);
	t.is(database.collection('telemetry').documents[0]?.['keysPressed'], 5);
	t.is(heatmap.documents[0]?.['Escape'], 2);
});

test('a write the driver reported as failed but that landed is overwritten too', async t => {
	const database = new FakeDatabase();
	const store = await buildStore(database);
	database.collection('telemetry').failAfterWriteWith = new Error('timed out');

	await store.flush(stateWithActivity().snapshot());

	// The Telemetry Document is there even though the Flush reported failure —
	// the acknowledgement was lost, not the write.
	t.is(database.collection('telemetry').documents.length, 1);

	database.collection('telemetry').failAfterWriteWith = undefined;
	await store.flush(stateWithActivity().snapshot());

	// The retry must land on the same document rather than beside it.
	t.is(database.collection('telemetry').documents.length, 1);
});

test('a successful Flush closes the retry, so the next Flush writes fresh documents', async t => {
	const database = new FakeDatabase();
	const store = await buildStore(database);

	await store.flush(stateWithActivity().snapshot());

	const state = new TelemetryState({mouseDpi: 72});
	state.addKeyPress('Escape');
	await store.flush(state.snapshot());

	// Two eras, two Telemetry Documents. The second Flush must not overwrite
	// the first, or a successful interval would lose its data to the next one.
	const telemetry = database.collection('telemetry').documents;
	t.is(telemetry.length, 2);
	t.is(telemetry[0]?.['keysPressed'], 3);
	t.is(telemetry[1]?.['keysPressed'], 1);

	const heatmaps = database.collection('keyboard_heatmap').documents;
	t.is(heatmaps.length, 2);
	t.is(heatmaps[0]?.['A'], 2);
	t.is(heatmaps[1]?.['Escape'], 1);
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
	const result = await store.flush(stateWithActivity().snapshot());
	t.is(result?.length, 2);
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
	const result = await store.flush(stateWithActivity().snapshot());
	t.is(result?.length, 2);
});
