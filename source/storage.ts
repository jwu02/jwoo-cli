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

Writes go through `replaceOne` with `upsert` and never `insertOne`: the
documents are keyed by the Flush's stamp (see `documentId`), which is what
makes a retried Flush overwrite what it wrote before rather than add to it.
*/
export type Collection = {
	readonly collectionName: string;
	createIndex(
		keys: Record<string, 1 | -1>,
		options: {expireAfterSeconds: number},
	): Promise<unknown>;
	replaceOne(
		filter: {_id: string},
		replacement: Record<string, unknown>,
		options: {upsert: boolean},
	): Promise<unknown>;
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
A written document's `_id`: the Flush's stamp plus the collection's name.

This is the idempotency key (ADR-0009). It is derived only from the stamp, so
a Flush retried under the same stamp produces the same `_id`s and upserts over
whatever its earlier attempt left behind — while a Flush of a later era, whose
stamp is new, keys fresh documents. Both readers sum every top-level field
except `_id` and `createdAt`, so the field costs them nothing (ADR-0004).
*/
function documentId(createdAt: Date, collectionName: string): string {
	return `${createdAt.toISOString()}#${collectionName}`;
}

/*
One write a Flush makes: which collection, the key the document is filed
under, and the document itself — `_id` and `createdAt` included, each written
in exactly one place.
*/
type Write = {
	readonly collection: Collection;
	readonly id: string;
	readonly document: Record<string, unknown>;
};

function writeOf(
	collection: Collection,
	createdAt: Date,
	fields: Record<string, unknown>,
): Write {
	const id = documentId(createdAt, collection.collectionName);
	return {collection, id, document: {_id: id, createdAt, ...fields}};
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
): readonly Write[] {
	return [
		writeOf(telemetryCollection, createdAt, {
			leftClicks: snapshot.leftClicks,
			rightClicks: snapshot.rightClicks,
			movementMeters: snapshot.movementMeters,
			keysPressed: snapshot.keysPressed,
		}),
		...(Object.keys(snapshot.keyCounts).length > 0
			? [writeOf(heatmapCollection, createdAt, {...snapshot.keyCounts})]
			: []),
	];
}

// The ids of the documents a successful Flush wrote — one per collection,
// each the `documentId` of the Flush's stamp — or `undefined` when the write
// failed. The caller keeps Telemetry State on `undefined` and retries the
// same counters next interval; the retry upserts rather than duplicates.
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
	The stamp of a Flush that failed and is still owed. Its Telemetry State was
	not cleared, so the next Flush carries the same counters plus whatever
	arrived since — and writes under the same stamp, which is what turns that
	retry into an overwrite of the failed attempt's documents instead of a
	second copy beside them. Opened by any failure and cleared by the first
	success; opened on every failure rather than only where a write is known
	to have landed, because a write that timed out may have been applied
	anyway, and only its own stamp can overwrite it.
	*/
	#outstandingStamp: Date | undefined;

	/*
	The newest stamp this store has handed out, in epoch milliseconds. A stamp
	identifies the documents of one era, so two eras must never share one —
	not even two Flushes that land in the same millisecond, which is why a
	fresh stamp is made to repeat nobody rather than trusted to the clock.
	*/
	#latestStampMs = 0;

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
					`Failed to create TTL index on ${collection.collectionName}`,
					error,
				);
			}
		}
	}

	/*
	A stamp no Flush of this store has used before: the wall clock, nudged
	forward past the previous stamp when the clock has not moved yet. At worst
	a document's createdAt leads real time by a millisecond — a price worth
	never keying two eras' documents alike.
	*/
	#freshStamp(): Date {
		this.#latestStampMs = Math.max(Date.now(), this.#latestStampMs + 1);
		return new Date(this.#latestStampMs);
	}

	async flush(snapshot: Snapshot): Promise<FlushResult> {
		// One timestamp for both documents, so the interval they describe is
		// unambiguous in the reader — and reused from a failed Flush, so the
		// retry of the same Telemetry State keys the same documents.
		const createdAt = this.#outstandingStamp ?? this.#freshStamp();

		// Sequential, and stopping at the first failure. Sequential is safe
		// rather than duplicating: each document is an upsert keyed by this
		// stamp, so a retry rewrites what the failed attempt landed instead of
		// adding a second copy of it (ADR-0009).
		const writtenIds: string[] = [];
		try {
			for (const {collection, id, document} of documentsFor(
				snapshot,
				createdAt,
				this.#telemetryCollection,
				this.#heatmapCollection,
			)) {
				// eslint-disable-next-line no-await-in-loop -- sequential on purpose; see above.
				await collection.replaceOne({_id: id}, document, {upsert: true});
				writtenIds.push(id);
			}
		} catch (error) {
			this.#logger.warn('Failed to flush telemetry documents', error);
			this.#outstandingStamp ??= createdAt;
			return undefined;
		}

		this.#outstandingStamp = undefined;
		return writtenIds;
	}

	async close(): Promise<void> {
		await this.#client?.close();
	}
}
