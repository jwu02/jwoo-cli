import test from 'ava';
import {type MongoClient} from 'mongodb';
import {ConfigError, type Config, loadConfig} from './config.js';
import {type BackloggedUsage} from './local-store.js';
import {type PushAttempt} from './push.js';
import {
	type UsageCollection,
	UsagePusher,
	type UsagePushBacklog,
} from './usage-push.js';

/*
Fakes
-----
Two, standing in for the two things this seam reaches outside itself for: the
slice of the driver it writes through, and the Local Store's Usage Backlog.

The driver fake is async on purpose: a synchronous one would let a missing
`await` in the seam pass every test here while losing data against a real
server.
*/

class FakeCollection implements UsageCollection {
	readonly collectionName: string;
	/*
	Every document as it currently stands, in the order it first landed. A
	replace keeps the position, which is what lets an order assertion read the
	order the writes went out in.
	*/
	readonly documents: Array<Record<string, unknown>> = [];
	/*
	The size of each `bulkWrite` call, so a batching test can read the shape of
	the drain without counting documents.
	*/
	readonly batchSizes: number[] = [];
	readonly orderedOptions: boolean[] = [];
	/*
	Every write's `upsert` flag, so the pin can assert the write is an upsert
	rather than a match that would silently drop a new content key.
	*/
	readonly upserts: boolean[] = [];
	/*
	The 1-based call to fail on, standing in for a server that takes the first
	batch and then refuses the next — the failure the tail rule stops at.
	*/
	failOnCall?: number;
	/*
	Records the batch and *then* rejects, standing in for a write whose
	acknowledgement was lost rather than its effect.
	*/
	failAfterWriteWith?: Error;
	failWritesWith?: Error;

	constructor(name: string) {
		this.collectionName = name;
	}

	async bulkWrite(
		operations: Parameters<UsageCollection['bulkWrite']>[0],
		options: {ordered: boolean},
	): Promise<unknown> {
		this.batchSizes.push(operations.length);
		this.orderedOptions.push(options.ordered);
		this.upserts.push(...operations.map(({replaceOne}) => replaceOne.upsert));

		const writes = () => {
			for (const {replaceOne} of operations) {
				const {filter, replacement} = replaceOne;
				const existing = this.documents.findIndex(
					document => document['_id'] === filter._id,
				);

				if (existing === -1) {
					this.documents.push(replacement);
				} else {
					this.documents[existing] = replacement;
				}
			}
		};

		if (this.failAfterWriteWith) {
			const error = this.failAfterWriteWith;
			writes();
			throw error;
		}

		if (this.failWritesWith) {
			throw this.failWritesWith;
		}

		if (this.failOnCall === this.batchSizes.length) {
			throw new Error('boom');
		}

		writes();
		return {ok: 1};
	}
}

class FakeDatabase {
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
one out by name, and it is the thing a one-shot seam closes.
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
The Usage Backlog as the seam reaches for it. Acknowledging takes the record out
of the backlog, as the Local Store's own `markUsagePushed` does — a fake that
left it there would let a drain that pushed the same record twice pass every
test here.
*/
class FakeBacklog implements UsagePushBacklog {
	#records: BackloggedUsage[];
	readonly marks: Array<{id: number; at: Date}> = [];
	failMarksWith?: Error;

	constructor(records: readonly BackloggedUsage[]) {
		this.#records = [...records];
	}

	usageBacklog(): readonly BackloggedUsage[] {
		return [...this.#records];
	}

	markUsagePushed(id: number, at: Date): void {
		if (this.failMarksWith) {
			throw this.failMarksWith;
		}

		this.marks.push({id, at});
		this.#records = this.#records.filter(candidate => candidate.id !== id);
	}
}

const config: Config = {
	mongoUri: 'mongodb://localhost/test',
	dbName: 'test',
	collectionName: 'telemetry',
	heatmapCollectionName: 'keyboard_heatmap',
	aiUsageCollectionName: 'ai_usage',
	flushIntervalSeconds: 300,
	mouseDpi: 72,
	collectionTtlSeconds: 31_536_000,
	heatmapTtlSeconds: 2_592_000,
	timeZone: 'UTC',
	localStorePath: '/tmp/jwoo-cli-test/telemetry.db',
};

const AT_10 = new Date('2026-09-25T10:00:00.000Z');
const AT_11 = new Date('2026-09-25T11:00:00.000Z');
const AT_12 = new Date('2026-09-25T12:00:00.000Z');

/*
One record, as the Local Store hands it to a drain: cost already priced at
Ingest (`undefined` when Unpriced), the model already canonicalized.
*/
function record(overrides: Partial<BackloggedUsage> = {}): BackloggedUsage {
	/* eslint-disable @typescript-eslint/naming-convention -- the five buckets keep the wire's column names. */
	return {
		id: 1,
		recordedAt: AT_10,
		harness: 'Claude Code',
		cwd: '/Users/jwu02/Developer',
		model: 'claude-sonnet-4-5',
		costYuan: 1.23,
		prompt_tokens: 1000,
		completion_tokens: 200,
		total_tokens: 1200,
		prompt_cache_hit_tokens: 300,
		prompt_cache_miss_tokens: 700,
		...overrides,
	};
	/* eslint-enable @typescript-eslint/naming-convention */
}

function build(
	records: readonly BackloggedUsage[] = [],
	{database = new FakeDatabase()}: {database?: FakeDatabase} = {},
) {
	const backlog = new FakeBacklog(records);
	const attempts: PushAttempt[] = [];
	const pusher = new UsagePusher(config, backlog, {
		database,
		onAttempt(attempt) {
			attempts.push(attempt);
		},
	});

	return {pusher, backlog, attempts, database};
}

function collectionOf(database: FakeDatabase): FakeCollection {
	return database.collection(config.aiUsageCollectionName);
}

/*
The wire pin, one-sided per ADR-0004: the website is not compiled against this,
so a change here is a deliberate edit on both sides or not at all. The keys are
closed — an eleventh field fails the pin — and every value's type is asserted
because the website's aggregation reads them as those types.
*/
test('a record Pushes as the ten-field wire document, and nothing else', async t => {
	const {pusher, database} = build([record()]);

	await pusher.drain();

	const [document] = collectionOf(database).documents;
	t.deepEqual(
		Object.keys(document!).toSorted(),
		[
			'_id',
			'harness',
			'cwd',
			'model',
			'cost_yuan',
			'prompt_tokens',
			'completion_tokens',
			'total_tokens',
			'prompt_cache_hit_tokens',
			'prompt_cache_miss_tokens',
			'recorded_at',
		].toSorted(),
		'the exact key set: no createdAt, no TTL field, no extra',
	);

	t.is(document!['harness'], 'Claude Code');
	t.is(document!['cwd'], '/Users/jwu02/Developer');
	t.is(document!['model'], 'claude-sonnet-4-5');
	t.is(document!['cost_yuan'], 1.23);

	// A real BSON Date, not the epoch milliseconds the Local Store holds.
	t.true(document!['recorded_at'] instanceof Date);
	t.is(document!['recorded_at'], AT_10);

	// The five buckets are integers.
	for (const field of [
		'prompt_tokens',
		'completion_tokens',
		'total_tokens',
		'prompt_cache_hit_tokens',
		'prompt_cache_miss_tokens',
	]) {
		t.is(typeof document![field], 'number', `${field} is a number`);
		t.true(Number.isSafeInteger(document![field]), `${field} is an integer`);
	}

	t.is(document!['prompt_tokens'], 1000);
	t.is(document!['completion_tokens'], 200);
	t.is(document!['total_tokens'], 1200);
	t.is(document!['prompt_cache_hit_tokens'], 300);
	t.is(document!['prompt_cache_miss_tokens'], 700);

	t.is(document!['createdAt'], undefined, 'no createdAt');

	// A write that upserts rather than one that only matches.
	t.deepEqual(collectionOf(database).upserts, [true]);
});

/*
The collection the website reads, pinned through the loader rather than through
a hand-written Config: the seam writes wherever config points, and config points
at `ai_usage` when the environment says nothing about it.
*/
test('the seam writes the default ai_usage collection', async t => {
	const database = new FakeDatabase();
	const pusher = new UsagePusher(
		// eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable names are SCREAMING_SNAKE_CASE.
		loadConfig({MONGO_URI: 'mongodb://localhost/test'}),
		new FakeBacklog([record()]),
		{database},
	);

	await pusher.drain();

	t.is(collectionOf(database).collectionName, 'ai_usage');
	t.is(collectionOf(database).documents.length, 1);
});

/*
The absent half of the wire doc: a nullable field is `null` and never missing,
so the key set is the same ten whichever record went out — and `cost_yuan` is
`number | null`, the Unpriced marker (ADR-0015).
*/
test('an absent cwd, model or cost is null rather than a missing key', async t => {
	const {pusher, database} = build([
		record({cwd: undefined, model: undefined, costYuan: undefined}),
	]);

	await pusher.drain();

	const [document] = collectionOf(database).documents;
	t.is(document!['cwd'], null);
	t.is(document!['model'], null);
	t.is(document!['cost_yuan'], null);
	t.deepEqual(
		Object.keys(document!).toSorted(),
		[
			'_id',
			'harness',
			'cwd',
			'model',
			'cost_yuan',
			'prompt_tokens',
			'completion_tokens',
			'total_tokens',
			'prompt_cache_hit_tokens',
			'prompt_cache_miss_tokens',
			'recorded_at',
		].toSorted(),
	);
});

/*
The harness literals are the command's, never the payload's — the three
CONTEXT.md's Harness entry names, and the three the website groups by. Pi is the
deliberate third: the list is a one-sided pin, so a fourth Harness is an edit
here and nowhere else that silently passes.
*/
test('the harness literal is carried through verbatim', async t => {
	const {pusher, database} = build([
		record({id: 1, harness: 'Claude Code'}),
		record({id: 2, harness: 'OpenCode', recordedAt: AT_11}),
		record({id: 3, harness: 'Pi', recordedAt: AT_12}),
	]);

	await pusher.drain();

	t.deepEqual(
		collectionOf(database).documents.map(document => document['harness']),
		['Claude Code', 'OpenCode', 'Pi'],
	);
});

/*
The `_id` pin: `<recorded_at toISOString>#<sha256 hex of model + the five
buckets>`. The digest is a literal, computed from the input written beside it,
so a change to what feeds the hash is a deliberate edit here and in the seam.
*/
test('a record is keyed by its instant and a hash of its content', async t => {
	const {pusher, database} = build([record()]);

	await pusher.drain();

	const [document] = collectionOf(database).documents;
	t.is(
		document!['_id'],
		'2026-09-25T10:00:00.000Z#c1c75ba684939571f2e196bc57e2a9e7280595bd4468e598cadba9c935a45a42',
	);
});

/*
The id is content-derived, so records that differ in the fingerprint key apart —
and ones that differ only in a field the fingerprint excludes (cost, which is
priced not identified; harness and cwd, ADR-0013's accepted ceiling) collapse
onto the same key and the upsert keeps one document.
*/
test('the content hash covers the model and the five buckets, and nothing else', async t => {
	const {pusher, backlog, database} = build([
		record({id: 1}),
		record({id: 2, model: 'claude-opus-4-1'}),
		// eslint-disable-next-line @typescript-eslint/naming-convention -- the wire bucket name.
		record({id: 3, completion_tokens: 201}),
		record({id: 4, costYuan: 9.99}),
		record({id: 5, cwd: '/tmp/elsewhere'}),
		record({id: 6, harness: 'OpenCode'}),
	]);

	await pusher.drain();

	const collection = collectionOf(database);
	t.is(
		new Set(collection.documents.map(document => document['_id'])).size,
		3,
		'three fingerprints — model, a bucket — and three fields excluded',
	);
	t.is(
		collection.documents.length,
		3,
		'the excluded fields collapsed in place',
	);
	t.is(backlog.marks.length, 6, 'every record was acknowledged');
});

/*
ADR-0013: the write lands but the acknowledgement is lost, so the record stays
in the backlog. The next drain writes it again under the same content `_id`,
where the upsert replaces it rather than adding a second copy.
*/
test('a record Pushed again under its own key overwrites rather than duplicates', async t => {
	const {pusher, backlog, database} = build([record()]);
	collectionOf(database).failAfterWriteWith = new Error('timed out');

	await pusher.drain();

	t.is(collectionOf(database).documents.length, 1, 'the write landed');
	t.deepEqual(backlog.marks, [], 'but it went unacknowledged');

	collectionOf(database).failAfterWriteWith = undefined;
	await pusher.drain();

	t.is(
		collectionOf(database).documents.length,
		1,
		'the re-Push replaced it rather than adding beside it',
	);
	t.is(backlog.marks.length, 1);
});

test('a Drain carries the backlog oldest recorded_at first, and acknowledges each', async t => {
	const {pusher, backlog, database, attempts} = build([
		record({id: 1, recordedAt: AT_10}),
		record({id: 2, recordedAt: AT_11}),
	]);

	await pusher.drain();

	t.deepEqual(
		collectionOf(database).documents.map(document => document['recorded_at']),
		[AT_10, AT_11],
	);
	t.deepEqual(
		backlog.marks.map(mark => mark.id),
		[1, 2],
	);
	t.deepEqual(backlog.usageBacklog(), [], 'the backlog drained to nothing');
	t.is(attempts.length, 1, 'one attempt, however many records it carried');
	t.is(attempts[0]?.pushed, 2);
	t.true(attempts[0]?.ok === true);
});

test('a Drain stops at the first failed batch and leaves the tail in the backlog', async t => {
	const records = Array.from({length: 501}, (_, index) =>
		record({id: index + 1, recordedAt: new Date(AT_10.getTime() + index)}),
	);
	const {pusher, backlog, database, attempts} = build(records);
	// The first batch lands; the second is refused.
	collectionOf(database).failOnCall = 2;

	await pusher.drain();

	t.is(collectionOf(database).documents.length, 500, 'the first batch landed');
	t.is(backlog.marks.length, 500, 'and was acknowledged');
	t.is(backlog.usageBacklog().length, 1, 'the tail stayed in the backlog');

	const [attempt] = attempts;
	t.is(attempts.length, 1);
	t.false(attempt?.ok);
	const failed = attempt?.ok === false ? attempt : undefined;
	t.is(failed?.pushed, 500, 'the attempt reports the ground it covered');
	t.is(String(failed?.error), 'Error: boom');
});

test('a Drain carries a large backlog in ordered bulkWrite batches', async t => {
	const records = Array.from({length: 501}, (_, index) =>
		record({id: index + 1, recordedAt: new Date(AT_10.getTime() + index)}),
	);
	const {pusher, backlog, database, attempts} = build(records);

	await pusher.drain();

	const collection = collectionOf(database);
	t.deepEqual(collection.batchSizes, [500, 1], '~500-doc batches');
	t.deepEqual(collection.orderedOptions, [true, true]);
	t.is(collection.documents.length, 501);
	t.deepEqual(backlog.usageBacklog(), []);
	t.is(attempts[0]?.pushed, 501);
});

test('a Drain with an empty backlog writes nothing and says nothing', async t => {
	const {pusher, attempts, database, backlog} = build();

	await pusher.drain();

	t.deepEqual(attempts, []);
	t.is(collectionOf(database).documents.length, 0);
	t.is(backlog.marks.length, 0);
});

test('a backlog that cannot be read is a reported failure, not a throw', async t => {
	const attempts: PushAttempt[] = [];
	const pusher = new UsagePusher(
		config,
		{
			usageBacklog(): readonly BackloggedUsage[] {
				throw new Error('the store is closed');
			},
			markUsagePushed() {
				// Never reached: the drain stops at the read.
			},
		},
		{
			database: new FakeDatabase(),
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

test('a store that will not acknowledge a record is a reported failure, not a throw', async t => {
	const {pusher, backlog, attempts, database} = build([record()]);
	backlog.failMarksWith = new Error('the store is closed');

	await pusher.drain();

	t.is(collectionOf(database).documents.length, 1, 'the write landed');
	t.deepEqual(backlog.marks, [], 'and it went unacknowledged');
	t.is(backlog.usageBacklog().length, 1, 'so the record is still waiting');
	t.is(attempts.length, 1);
	t.false(attempts[0]?.ok);
});

/*
The one-shot lifetime: a client this seam opened is closed, and an injected
database means someone else owns the connection and closes it.
*/
test('close() closes a client the seam owns, and twice is survivable', async t => {
	const client = new FakeMongoClient(new FakeDatabase());
	const pusher = new UsagePusher(config, new FakeBacklog([]), {
		createClient: () => client as unknown as MongoClient,
	});

	t.deepEqual(client.databasesRequested, ['test'], 'the configured database');
	await pusher.close();
	await pusher.close();

	t.is(client.closeCalls, 1);
});

test('an injected database is written through and left open', async t => {
	const database = new FakeDatabase();
	const {pusher} = build([record()], {database});

	await pusher.drain();
	await pusher.close();

	t.is(database.collection(config.aiUsageCollectionName).documents.length, 1);
});

/*
`mongoUri` is optional in Config because the usage paths tolerate its absence
(ADR-0016), so the refusal moves to the seam that actually needs it — here, via
the client `push.ts` builds. A usage command checks for the URI before building
one, and this is what the check is protecting against.
*/
test('a UsagePusher with no MONGO_URI refuses to start', t => {
	const error = t.throws(
		() =>
			new UsagePusher({...config, mongoUri: undefined}, new FakeBacklog([])),
		{instanceOf: ConfigError},
	);

	t.regex(error.message, /MONGO_URI/v);
});
