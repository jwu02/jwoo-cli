/*
The storage seam.

Everything that knows about MongoDB lives behind `TelemetryStore`, so the
Flush orchestration can be tested against an in-memory fake and no test needs
a running database — the property the Python suite had and the reason its
storage tests were worth keeping.

The store depends on a narrowed `Database` rather than on the driver's own
types, so a fake can stand in. The shape is kept faithful to the driver —
including the fact that every call returns a Promise — because a fake that
lies about that cannot catch a store that forgets to await.
*/

import {MongoClient} from 'mongodb';
import {type Config} from './config.js';
import {type Snapshot} from './state.js';

/*
The slice of a driver `Collection` this store actually calls. Every method is
async because the driver's are; declaring them sync would let a missing
`await` pass every fake-backed test and still lose data against a real server.
*/
export type Collection = {
	readonly name: string;
	createIndex(
		keys: Record<string, 1 | -1>,
		options: {expireAfterSeconds: number},
	): Promise<unknown>;
	insertOne(document: Record<string, unknown>): Promise<{insertedId: unknown}>;
};

/*
The slice of a driver `Db` this store actually calls.
*/
export type Database = {
	collection(name: string): Collection;
};

/*
`MongoClient` is not itself a `Database` — it hands one out by name, which is
where the configured database name comes in.
*/
function databaseOf(client: MongoClient, dbName: string): Database {
	return client.db(dbName) as unknown as Database;
}

/*
The documents one Flush writes, and the collections they go to.

A Key Count Document is written only when keys were pressed during the
interval. Its fields are the Key Labels themselves — that flat shape, not a
nested object, is the wire format the website reads.
*/
function documentsFor(
	snapshot: Snapshot,
	createdAt: Date,
	telemetryCollection: Collection,
	heatmapCollection: Collection,
): ReadonlyArray<[Collection, Record<string, unknown>]> {
	type Write = [Collection, Record<string, unknown>];

	const keyCountDocument = {createdAt, ...snapshot.keyCounts};
	const optional: Array<Write | undefined> =
		Object.keys(snapshot.keyCounts).length > 0
			? [[heatmapCollection, keyCountDocument]]
			: [];

	return [
		[
			telemetryCollection,
			{
				createdAt,
				leftClicks: snapshot.leftClicks,
				rightClicks: snapshot.rightClicks,
				movementMeters: snapshot.movementMeters,
				keysPressed: snapshot.keysPressed,
			},
		] satisfies Write,
		...optional.filter((entry): entry is Write => entry !== undefined),
	];
}

// A flushed interval's inserted ids, or `undefined` when the write failed. The
// caller keeps Telemetry State on `undefined` and retries the same data next
// interval.
export type FlushResult = string[] | undefined;

export type TelemetryStore = {
	flush(snapshot: Snapshot): Promise<FlushResult>;
	close(): Promise<void>;
};

export type MongoTelemetryStoreOptions = {
	readonly logger?: Pick<Console, 'warn'>;
};

export class MongoTelemetryStore implements TelemetryStore {
	readonly #logger: Pick<Console, 'warn'>;
	readonly #telemetryCollection: Collection;
	readonly #heatmapCollection: Collection;
	readonly #indexes: ReadonlyArray<{
		collection: Collection;
		expireAfterSeconds: number;
	}>;

	/*
	Present only when this store owns the connection. An injected database is
	someone else's to close.
	*/
	readonly #client: MongoClient | undefined;

	constructor(
		config: Config,
		database?: Database,
		{logger = console}: MongoTelemetryStoreOptions = {},
		// Test seam for the real-client path. Otherwise unused.
		clientOverride?: MongoClient,
	) {
		this.#logger = logger;

		/*
		An injected database means someone else owns the connection, so this
		store must not open — or later close — one of its own. `MongoClient`
		connects lazily, so constructing one is not a network call and this
		constructor does not need to be async.
		*/
		this.#client = database
			? undefined
			: (clientOverride ?? new MongoClient(config.mongoUri));
		const resolved =
			database ??
			// Non-null in exactly the branch where there is no database.
			databaseOf(this.#client!, config.dbName);

		this.#telemetryCollection = resolved.collection(config.collectionName);
		this.#heatmapCollection = resolved.collection(config.heatmapCollectionName);
		this.#indexes = [
			{
				collection: this.#telemetryCollection,
				expireAfterSeconds: config.collectionTtlSeconds,
			},
			{
				collection: this.#heatmapCollection,
				expireAfterSeconds: config.heatmapTtlSeconds,
			},
		];

		// Deliberately not awaited: a database that is slow or down must not
		// block the caller from starting collection.
		void this.#createTtlIndexes();
	}

	async #createTtlIndexes(): Promise<void> {
		// A failing index is a warning, never fatal: collection that cannot age
		// out is still collection.
		for (const {collection, expireAfterSeconds} of this.#indexes) {
			try {
				// eslint-disable-next-line no-await-in-loop -- one collection at a time, so a slow index cannot delay the next attempt.
				await collection.createIndex({createdAt: 1}, {expireAfterSeconds});
			} catch (error) {
				this.#logger.warn(
					`Failed to create TTL index on ${collection.name}`,
					error,
				);
			}
		}
	}

	async flush(snapshot: Snapshot): Promise<FlushResult> {
		// One timestamp for both documents, so the interval they describe is
		// unambiguous in the reader.
		const createdAt = new Date();

		// Sequential, and stopping at the first failure, so a retry re-writes
		// the telemetry document rather than leaving a duplicate behind.
		const insertedIds: string[] = [];
		try {
			for (const [collection, document] of documentsFor(
				snapshot,
				createdAt,
				this.#telemetryCollection,
				this.#heatmapCollection,
			)) {
				// eslint-disable-next-line no-await-in-loop -- sequential on purpose; see above.
				const result = await collection.insertOne(document);
				insertedIds.push(String(result.insertedId));
			}
		} catch (error) {
			this.#logger.warn('Failed to flush telemetry documents', error);
			return undefined;
		}

		return insertedIds;
	}

	async close(): Promise<void> {
		await this.#client?.close();
	}
}
