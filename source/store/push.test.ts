import test from 'ava';
import {type MongoClient} from 'mongodb';
import {type Config} from './config.js';
import {type Era} from './local-store.js';
import {
	type Collection,
	type Database,
	type PushAttempt,
	type PushBacklog,
	Pusher,
} from './push.js';

/*
Fakes
-----
Two, and they stand in for the two things the Pusher reaches outside itself for:
the slice of the driver it writes through, and the Local Store's Push Backlog.

The driver fake is async on purpose: a synchronous fake would let a missing
`await` in the Pusher pass every test here while losing data against a real
server.
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
	/*
	Blocks a write on a gate the test holds, so a Drain can be caught in flight.
	Counted on entry rather than on completion, so a test can tell that a write
	has *begun* and is blocked.
	*/
	hold?: () => Promise<void>;
	started = 0;

	constructor(name: string) {
		this.collectionName = name;
	}

	/*
	Upsert semantics as the driver has them: `upsert: false` matches nothing
	and writes nothing, which is what catches a Pusher that dropped the option
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

		// Replaced in place, so a document's position says which era wrote it.
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
		this.started += 1;
		await this.hold?.();

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
The Push Backlog as the Pusher reaches for it.

Acknowledging takes the era out of the backlog, as the Local Store's own
`markPushed` does. A fake that left it there would let a Drain that pushed the
same era twice pass every test in this file.
*/
class FakeBacklog implements PushBacklog {
	#eras: Era[];
	readonly marks: Array<{stamp: Date; at: Date}> = [];
	/*
	A store that has gone away underneath the Drain: it answered the read that
	built the backlog and then would not take the acknowledgement.
	*/
	failMarksWith?: Error;

	constructor(eras: readonly Era[]) {
		this.#eras = [...eras];
	}

	backlog(): readonly Era[] {
		return [...this.#eras];
	}

	markPushed(stamp: Date, at: Date): void {
		if (this.failMarksWith) {
			throw this.failMarksWith;
		}

		this.marks.push({stamp, at});
		this.#eras = this.#eras.filter(
			candidate => candidate.stamp.getTime() !== stamp.getTime(),
		);
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
	// Unused here: these tests drive the Push, which writes the wire format and
	// leaves the Local Store alone.
	localStorePath: '/tmp/jwoo-cli-test/telemetry.db',
};

const AT_10 = new Date('2026-09-25T10:00:00.000Z');
const AT_11 = new Date('2026-09-25T11:00:00.000Z');

/*
One era, as the Local Store hands it to a Drain: Key Counts normalised, Press
Total under the glossary's name rather than the wire's.
*/
function era(stamp: Date, overrides: Partial<Era> = {}): Era {
	return {
		stamp,
		leftClicks: 1,
		rightClicks: 2,
		// 36 pixels at 72 DPI is half an inch, so 0.0127m.
		movementMeters: 0.0127,
		pressTotal: 3,
		keyCounts: {A: 2, Return: 1},
		...overrides,
	};
}

/*
The Pusher, its backlog and the database it writes through, wired the way the
composition root wires them.

Construction is what kicks off index creation, and that is deliberately
fire-and-forget, so this waits for the work rather than for the constructor.
*/
async function build(
	eras: readonly Era[] = [],
	{
		database = new FakeDatabase(),
		logger = new FakeLogger(),
	}: {database?: FakeDatabase; logger?: FakeLogger} = {},
) {
	const backlog = new FakeBacklog(eras);
	const attempts: PushAttempt[] = [];
	const pusher = new Pusher(config, backlog, {
		database,
		logger,
		onAttempt(attempt) {
			attempts.push(attempt);
		},
	});

	await settle();
	return {pusher, backlog, attempts, logger, database};
}

async function settle(): Promise<void> {
	await new Promise(resolve => {
		setImmediate(resolve);
	});
}

test('a Drain Pushes the backlog oldest first, and acknowledges each era', async t => {
	const {pusher, backlog, database, attempts} = await build([
		era(AT_10),
		era(AT_11),
	]);

	await pusher.drain();

	// The order the documents landed in is the order they were written in: the
	// fake replaces a document in place and appends otherwise.
	const telemetry = database.collection('telemetry').documents;
	t.deepEqual(
		telemetry.map(document => document['createdAt']),
		[AT_10, AT_11],
	);
	t.deepEqual(
		backlog.marks.map(mark => mark.stamp),
		[AT_10, AT_11],
	);
	t.deepEqual(backlog.backlog(), [], 'the backlog drained to nothing');
	/*
	And the ground it covered is what the attempt reports, which is what the Run
	Log's gathered-ground entry counts: two eras is the smallest Drain that made
	up ground rather than keeping up with it.
	*/
	t.is(attempts.length, 1, 'one attempt, however many eras it carried');
	t.is(attempts[0]?.pushed, 2);
	t.true(attempts[0]?.ok === true, 'which reached the end of the backlog');
});

test('an era is Pushed under its own stamp, in the wire shape', async t => {
	const {pusher, database} = await build([era(AT_10)]);

	await pusher.drain();

	const [telemetry] = database.collection('telemetry').documents;
	const [heatmap] = database.collection('keyboard_heatmap').documents;

	// The era's own stamp, not the Push's clock: an era the website missed for a
	// day lands where it happened (ADR-0009, ADR-0012).
	t.is(telemetry?.['_id'], `${AT_10.toISOString()}#telemetry`);
	t.is(telemetry?.['createdAt'], AT_10);
	t.true(telemetry?.['createdAt'] instanceof Date);

	t.is(telemetry?.['leftClicks'], 1);
	t.is(telemetry?.['rightClicks'], 2);
	t.is(telemetry?.['movementMeters'], 0.0127);
	// Press Total, under the wire field's name (ADR-0004).
	t.is(telemetry?.['keysPressed'], 3);
	t.is(telemetry?.['apps'], undefined);

	// Key Counts are the document's top-level fields, not a nested object.
	t.is(heatmap?.['A'], 2);
	t.is(heatmap?.['Return'], 1);
	t.is(heatmap?.['createdAt'], AT_10);
});

test('an era with no Key Counts Pushes no Key Count Document', async t => {
	const {pusher, database} = await build([era(AT_10, {keyCounts: {}})]);

	await pusher.drain();

	t.is(database.collection('telemetry').documents.length, 1);
	t.is(database.collection('keyboard_heatmap').documents.length, 0);
});

test('a Drain stops at the first failure, leaving the tail in the backlog', async t => {
	const {pusher, backlog, database} = await build([era(AT_10), era(AT_11)]);
	database.collection('keyboard_heatmap').failWritesWith = new Error('boom');

	await pusher.drain();

	// The first era's Key Count Document is where the Drain stopped. Its
	// Telemetry Document landed and is not acknowledged, so the next Drain
	// writes both again under the same stamp — an upsert, not a duplicate.
	t.is(database.collection('telemetry').documents.length, 1);
	t.deepEqual(backlog.marks, []);
	t.is(database.collection('telemetry').documents[0]?.['createdAt'], AT_10);
	t.is(
		backlog.backlog().length,
		2,
		'neither the failed era nor the one behind it left the backlog',
	);
});

test('a Drain reports the attempt it made, and never throws', async t => {
	const {pusher, attempts} = await build([era(AT_10)]);

	await pusher.drain();

	t.is(attempts.length, 1);
	t.true(attempts[0]?.ok);
	t.is(attempts[0]?.pushed, 1);
	t.true(attempts[0]?.at instanceof Date);
});

test('a Drain that failed reports the failure and the ground it covered', async t => {
	const {pusher, attempts, database} = await build([era(AT_10), era(AT_11)]);
	database.collection('telemetry').failWritesWith = new Error('boom');

	await pusher.drain();

	t.is(attempts.length, 1);
	const [attempt] = attempts;
	t.false(attempt?.ok);

	// The message is the driver's own, which is what the entry will draw.
	const failed = attempt?.ok === false ? attempt : undefined;
	t.is(failed?.pushed, 0);
	t.is(String(failed?.error), 'Error: boom');
});

test('a Drain with an empty backlog writes nothing and says nothing', async t => {
	const {pusher, attempts, database, backlog} = await build();

	await pusher.drain();

	/*
	Silent rather than an empty attempt: a Drain with nothing to carry did not
	try anything, and an entry per idle interval would push the Flush lines out
	of the Run Log's six-entry window.
	*/
	t.deepEqual(attempts, []);
	t.is(database.collection('telemetry').documents.length, 0);
	t.is(database.collection('keyboard_heatmap').documents.length, 0);
	t.is(backlog.marks.length, 0);
});

/*
The single-flight rule. A Drain is fired after every successful Flush and once
at startup, so a Flush Interval that lands while a previous Drain is still
waiting on a slow Atlas must join it rather than start a second attempt at the
same eras.
*/
test('a Drain asked for while one is running joins it', async t => {
	const {pusher, backlog, database} = await build([era(AT_10)]);

	let release: (() => void) | undefined;
	const gate = new Promise<void>(resolve => {
		release = () => {
			resolve();
		};
	});
	const telemetry = database.collection('telemetry');
	telemetry.hold = async () => gate;

	const first = pusher.drain();
	await until(() => telemetry.started === 1, 'the first write to start');
	const second = pusher.drain();

	release?.();
	await Promise.all([first, second]);

	t.is(telemetry.started, 1, 'the era was written once');
	t.is(telemetry.documents.length, 1);
	t.is(backlog.marks.length, 1);
});

/*
A lost acknowledgement is the case ADR-0009 exists for: the write landed but the
Drain never heard so, which leaves the era in the backlog. The next Drain writes
it again under its own stamp, where the upsert replaces what is there.
*/
test('an era Pushed again under its own stamp overwrites rather than duplicates', async t => {
	const {pusher, backlog, database} = await build([era(AT_10)]);
	database.collection('telemetry').failAfterWriteWith = new Error('timed out');

	await pusher.drain();

	t.is(
		database.collection('telemetry').documents.length,
		1,
		'the acknowledgement was lost, not the write',
	);
	t.deepEqual(backlog.marks, [], 'an unacknowledged era stays in the backlog');

	database.collection('telemetry').failAfterWriteWith = undefined;
	await pusher.drain();

	t.is(
		database.collection('telemetry').documents.length,
		1,
		'the re-Push replaced it rather than adding beside it',
	);
	t.is(backlog.marks.length, 1);
});

test('a backlog that cannot be read is a reported failure, not a throw', async t => {
	const attempts: PushAttempt[] = [];
	const pusher = new Pusher(
		config,
		{
			backlog(): readonly Era[] {
				throw new Error('the store is closed');
			},
			markPushed() {
				// Never reached: the Drain stops at the read.
			},
		},
		{
			database: new FakeDatabase(),
			logger: new FakeLogger(),
			onAttempt(attempt) {
				attempts.push(attempt);
			},
		},
	);

	await pusher.drain();

	t.is(attempts.length, 1);
	t.false(attempts[0]?.ok);
	const failed = attempts[0]?.ok === false ? attempts[0] : undefined;
	t.is(String(failed?.error), 'Error: the store is closed');
});

/*
The other half of a store that will not answer. A backlog that cannot be *read*
was already a reported failure; an era the store will not *acknowledge* was not,
and a Drain that rejects is a Drain whose failure nobody hears — `settled`
swallows the rejection on the way out of the Session, and the class promises a
Drain never throws.
*/
test('a store that will not acknowledge an era is a reported failure, not a throw', async t => {
	const {pusher, backlog, attempts, database} = await build([era(AT_10)]);
	backlog.failMarksWith = new Error('the store is closed');

	await pusher.drain();

	t.is(
		database.collection('telemetry').documents.length,
		1,
		'the write landed',
	);
	t.deepEqual(backlog.marks, [], 'and it went unacknowledged');
	t.is(backlog.backlog().length, 1, 'so the era is still waiting');
	t.is(attempts.length, 1);
	t.false(attempts[0]?.ok);
	const failed = attempts[0]?.ok === false ? attempts[0] : undefined;
	t.is(String(failed?.error), 'Error: the store is closed');
});

/*
A store that would not acknowledge is not a connection that failed, and the
reconnect ADR-0009's ordering costs a handshake. Keeping the two failures in a
catch each is what makes the difference sayable.
*/
test('an era the store would not acknowledge leaves the connection open', async t => {
	const database = new FakeDatabase();
	const client = new FakeMongoClient(database);
	const backlog = new FakeBacklog([era(AT_10)]);
	const attempts: PushAttempt[] = [];
	const pusher = new Pusher(config, backlog, {
		logger: new FakeLogger(),
		createClient: () => client as unknown as MongoClient,
		onAttempt(attempt) {
			attempts.push(attempt);
		},
	});
	await settle();
	backlog.failMarksWith = new Error('the store is closed');

	await pusher.drain();

	t.is(client.closeCalls, 0, 'the connection is not what failed');
	t.false(attempts[0]?.ok);

	// And the next Drain writes through the same one rather than opening another.
	backlog.failMarksWith = undefined;
	await pusher.drain();

	t.is(client.databasesRequested.length, 1, 'one connection, still open');
	t.deepEqual(backlog.backlog(), []);
	t.is(database.collection('telemetry').documents.length, 1);
});

/*
The indexes belong to the collection, not to the connection, and a connection is
only reopened because a Drain against it failed — so a reconnect is the worst
moment to ask again, not the best. These two pin the ask at once per Pusher,
whichever way the first one went.
*/
test('a landed ask for the TTL indexes is not repeated on a later connection', async t => {
	const database = new FakeDatabase();
	const {pusher, logger} = await build([era(AT_10), era(AT_11)], {database});
	const telemetry = database.collection(config.collectionName);
	t.is(
		telemetry.indexes.get('createdAt_1'),
		31_536_000,
		'the first ask landed',
	);

	// A failed Drain drops the connection, so the next one opens a fresh client
	// — and asks again, were the ask about the connection rather than the
	// collection. It is left failing so that a second ask would be heard.
	telemetry.failWritesWith = new Error('down');
	await pusher.drain();
	telemetry.failWritesWith = undefined;
	telemetry.failIndexesWith = new Error('denied');
	await pusher.drain();

	t.is(logger.warnings.length, 0, 'and it was not asked a second time');
	t.is(telemetry.indexes.get('createdAt_1'), 31_536_000);
});

/*
The regression this guard was added for: while Mongo is down, every Flush
Interval fails a Drain, drops the connection and opens another. An ask per
connection is a warning per connection — with a five-minute Flush Interval, an
afternoon of Atlas being unreachable would be a Run Log of nothing but that line.
*/
test('a failed ask for the TTL indexes is not repeated on the next connection', async t => {
	const database = new FakeDatabase();
	const telemetry = database.collection(config.collectionName);
	// Set before the Pusher exists: asking is part of what building one does.
	telemetry.failIndexesWith = new Error('denied');

	const {pusher, logger, backlog} = await build([era(AT_10)], {database});
	t.is(logger.warnings.length, 1, 'the ask failed, and said so');
	t.deepEqual(
		[...telemetry.indexes],
		[],
		'so there is no index to show for it',
	);

	// Two connections later — one dropped by a failed Drain, one opened by the
	// Drain after it — the ask is still the one the Pusher started with.
	telemetry.failWritesWith = new Error('down');
	await pusher.drain();
	telemetry.failWritesWith = undefined;
	await pusher.drain();

	t.is(logger.warnings.length, 1, 'and it was not asked again');
	t.deepEqual(backlog.backlog(), [], 'while the era itself still went out');
});

test('creating the TTL indexes is idempotent', async t => {
	const database = new FakeDatabase();

	await build([], {database});
	await build([], {database});

	t.is(database.collection('telemetry').indexes.get('createdAt_1'), 31_536_000);
	t.is(
		database.collection('keyboard_heatmap').indexes.get('createdAt_1'),
		2_592_000,
	);
});

test('a failed TTL index is a warning, not a crash', async t => {
	const database = new FakeDatabase();
	database.collection('telemetry').failIndexesWith = new Error('denied');

	// Construction must not throw, and the rejection must not escape as an
	// unhandled rejection either.
	const {pusher, backlog, logger} = await build([era(AT_10)], {database});

	t.is(database.collection('telemetry').indexes.size, 0);
	// The second collection is still attempted after the first one failed.
	t.is(
		database.collection('keyboard_heatmap').indexes.get('createdAt_1'),
		2_592_000,
	);
	t.is(logger.warnings.length, 1);
	t.regex(logger.warnings[0]!.message, /TTL index/v);

	// And the Pusher is still usable.
	await pusher.drain();
	t.is(backlog.marks.length, 1);
});

test('without an injected database the Pusher builds one from MongoClient', async t => {
	const database = new FakeDatabase();
	const client = new FakeMongoClient(database);
	const backlog = new FakeBacklog([era(AT_10)]);

	const pusher = new Pusher(config, backlog, {
		logger: new FakeLogger(),
		createClient: () => client as unknown as MongoClient,
	});
	await settle();

	// The configured database name is what selects the database. Reaching
	// `collection()` straight off the client — as this seam once did — is a
	// TypeError against a real driver, and no fake-backed test would see it.
	t.deepEqual(client.databasesRequested, ['test']);

	await pusher.drain();
	t.is(database.collection('telemetry').documents.length, 1);
});

test('close() closes a client the Pusher owns, and twice is survivable', async t => {
	const client = new FakeMongoClient(new FakeDatabase());
	const pusher = new Pusher(config, new FakeBacklog([]), {
		logger: new FakeLogger(),
		createClient: () => client as unknown as MongoClient,
	});

	await pusher.close();
	await pusher.close();

	t.is(client.closeCalls, 1);
});

/*
A client whose first connection attempt failed is finished: the driver closes its
topology, and every later operation on it answers "Topology is closed" rather
than trying again. A Pusher that kept one would never Push again for the rest of
the run — the machine that started up with Atlas unreachable is the machine the
Push Backlog exists for, so the next Drain has to open a fresh connection.
*/
test('a Drain that failed opens a fresh connection for the next one', async t => {
	const dead = new FakeDatabase();
	const live = new FakeDatabase();
	const clients: FakeMongoClient[] = [];
	const backlog = new FakeBacklog([era(AT_10)]);
	const pusher = new Pusher(config, backlog, {
		logger: new FakeLogger(),
		createClient() {
			// The first connection is the one the Pusher is built with, the second
			// the one the next Drain opens.
			const client = new FakeMongoClient(clients.length === 0 ? dead : live);
			clients.push(client);
			return client as unknown as MongoClient;
		},
	});
	await settle();

	// The first attempt cannot land, as an attempt against a dead host cannot.
	dead.collection(config.collectionName).failWritesWith = new Error('boom');
	await pusher.drain();

	t.is(clients.length, 1, 'the connection it was built with');
	t.is(backlog.backlog().length, 1, 'and the era is still waiting');

	await pusher.drain();

	t.is(clients.length, 2, 'the second attempt opened its own connection');
	t.is(clients[0]?.closeCalls, 1, 'and the finished one was closed, not kept');
	t.deepEqual(backlog.backlog(), [], 'the era went out on the new one');
	t.is(live.collection(config.collectionName).documents.length, 1);
});

/*
Waits for something the Drain reaches on its own rather than sleeping a fixed
number of milliseconds and hoping.
*/
async function until(
	isSatisfied: () => boolean,
	what: string,
	{timeoutMs = 2000}: {timeoutMs?: number} = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (!isSatisfied()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}

		// eslint-disable-next-line no-await-in-loop -- polling, one check at a time.
		await new Promise(resolve => {
			setTimeout(resolve, 5);
		});
	}
}
