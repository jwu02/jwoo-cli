/*
The Push seam.

Everything that knows about MongoDB lives here, so a Drain can be tested against
an in-memory fake and no test needs a running database — no test *server*, which
is the rule ADR-0012 leaves in place after deleting the Mongo read.

This is the Flush's old write seam with its job narrowed. A Flush writes the
Local Store now, and this carries those eras to MongoDB afterwards, best-effort:
the website's copy of the record rather than the record itself. Nothing on the
Flush path waits for it.

The Pusher depends on a narrowed `Database` rather than on the driver's own
types, so a fake can stand in. The shape is kept faithful to the driver —
including the fact that every call returns a Promise — because a fake that
lies about that cannot catch a Pusher that forgets to await.
*/

import {MongoClient} from 'mongodb';
import {type Config} from './config.js';
import {type Era} from './local-store.js';

/*
The slice of a driver `Collection` this seam actually calls. Every method is
async because the driver's are; declaring them sync would let a missing
`await` pass every fake-backed test and still lose data against a real server.

Writes go through `replaceOne` with `upsert` and never `insertOne`: the
documents are keyed by the era's stamp (see `documentId`), which is what makes a
re-Push overwrite what a lost acknowledgement landed rather than add to it
(ADR-0009).
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
The slice of a driver `Db` this seam actually calls.
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
A written document's `_id`: the era's stamp plus the collection's name.

This is the idempotency key (ADR-0009). It is derived only from the stamp, so an
era Pushed again under the same stamp produces the same `_id`s and upserts over
whatever an earlier attempt left behind — while a later era, whose stamp is new,
keys fresh documents. Both readers sum every top-level field except `_id` and
`createdAt`, so the field costs them nothing (ADR-0004).
*/
function documentId(createdAt: Date, collectionName: string): string {
	return `${createdAt.toISOString()}#${collectionName}`;
}

/*
One write a Push makes: which collection, the key the document is filed
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
The documents one era is Pushed as, and the collections they go to.

Both are stamped with the era's own stamp, which is the whole of ADR-0009's
idempotency: an era Pushed a day late lands where it happened, keyed by when it
happened, and not by when the Drain got round to it.

A Key Count Document is written only when keys were pressed during the era. Its
fields are the Key Labels themselves — that flat shape, not a nested object, is
the wire format the website reads.

The Key Counts arrive normalised from the Local Store and are flattened back
here, which is the whole of the difference between the store's schema and the
wire: the website's reader is unchanged by any of this (ADR-0004, ADR-0012).
*/
function documentsFor(
	era: Era,
	telemetryCollection: Collection,
	heatmapCollection: Collection,
): readonly Write[] {
	return [
		writeOf(telemetryCollection, era.stamp, {
			leftClicks: era.leftClicks,
			rightClicks: era.rightClicks,
			movementMeters: era.movementMeters,
			// The glossary's Press Total, under the wire field's own name.
			keysPressed: era.pressTotal,
		}),
		...(Object.keys(era.keyCounts).length > 0
			? [writeOf(heatmapCollection, era.stamp, {...era.keyCounts})]
			: []),
	];
}

/*
A Drain attempt, as an observer outside the Pusher sees it: when it ran, whether
it reached the end of the backlog, and how many eras it acknowledged on the way.
A failure carries the driver's own error, which is the part of it worth reading.

Shaped like `FlushAttempt` and reported the same way — through a callback, with
the composition root deciding where the news belongs, because a seam cannot know
whether there is a frame on screen to put an entry in (ADR-0010).
*/
export type PushAttempt =
	| {readonly at: Date; readonly ok: true; readonly pushed: number}
	| {
			readonly at: Date;
			readonly ok: false;
			readonly pushed: number;
			readonly error: unknown;
	  };

/*
The Push Backlog, as the Pusher reaches for it: the eras no Push has
acknowledged, oldest first, and the acknowledgement that takes one out.

The Local Store satisfies this and is the only implementation; it is declared
here rather than there for the reason `session.ts` declares its own slice of a
stream — a module names what it uses, and what a Drain needs of the store is
this and nothing else.
*/
export type PushBacklog = {
	backlog(): readonly Era[];
	markPushed(stamp: Date, at: Date): void;
};

/*
Where this seam's warnings go. One thing reaches it: a TTL index the server
would not create, raised once as the Pusher is built and never fatal. A failed
Drain does not — the attempt reports that, and the caller that receives it knows
where the news belongs (ADR-0010).

The dashboard hands over a logger that appends Run Log entries, which keeps a
startup warning out of the middle of the frame; a headless run keeps the
terminal.
*/
export type PusherOptions = {
	/*
	An injected database means someone else owns the connection, so this Pusher
	both writes through it and leaves it open.
	*/
	readonly database?: Database;
	readonly logger?: Pick<Console, 'warn'>;
	/*
	Called once per Drain that found something to carry. A Drain with an empty
	backlog reports nothing: it did not attempt anything, and a line per idle
	interval would be noise in a six-entry window.
	*/
	readonly onAttempt?: (attempt: PushAttempt) => void;
	/*
	Builds the client a connection uses, for the one caller that needs a stand-in
	for the real one. It is a factory rather than a client because a connection is
	opened more than once — see `#reopen` — and a test that could only stand in
	for the first would not see the second.
	*/
	readonly createClient?: () => MongoClient;
};

/*
One connection to MongoDB: the two collections a Push writes through, and the
client behind them when this Pusher is the one that opened it.
*/
type Connection = {
	readonly client: MongoClient | undefined;
	readonly telemetry: Collection;
	readonly heatmap: Collection;
};

/*
Pushes the Push Backlog to MongoDB.

Single-flight: a Drain asked for while one is running joins it rather than
starting a second, so a hanging Atlas costs one attempt in flight however many
Flushes land behind it. Never throws — every way it can fail, a write or a store
that will not answer, is caught and reported through `onAttempt`, because a Drain
is fired from a Flush path that must not be brought down by a network the
website's copy depends on.
*/
export class Pusher {
	readonly #config: Config;
	readonly #backlog: PushBacklog;
	readonly #logger: Pick<Console, 'warn'>;
	readonly #onAttempt: ((attempt: PushAttempt) => void) | undefined;
	readonly #database: Database | undefined;
	readonly #createClient: () => MongoClient;

	#connection: Connection | undefined;
	#inFlight: Promise<void> | undefined;
	#closed = false;
	#indexesAsked = false;

	constructor(
		config: Config,
		backlog: PushBacklog,
		{
			database,
			logger = console,
			onAttempt,
			createClient = () => new MongoClient(config.mongoUri),
		}: PusherOptions = {},
	) {
		this.#config = config;
		this.#backlog = backlog;
		this.#logger = logger;
		this.#onAttempt = onAttempt;
		this.#database = database;
		this.#createClient = createClient;

		/*
		Opened here rather than at the first Drain, so the TTL indexes are asked
		for as this seam is built and before any Flush has happened — the behaviour
		it has always had.
		*/
		this.#open();
	}

	/*
	Opens a connection.

	`MongoClient` connects lazily, so constructing one is not a network call and
	neither is this — which matters, because it runs before the preflight and
	before the frame.
	*/
	#open(): Connection {
		const client =
			this.#database === undefined ? this.#createClient() : undefined;
		const resolved =
			this.#database ??
			// Non-null in exactly the branch where there is no database.
			databaseOf(client!, this.#config.dbName);

		const connection: Connection = {
			client,
			telemetry: resolved.collection(this.#config.collectionName),
			heatmap: resolved.collection(this.#config.heatmapCollectionName),
		};
		this.#connection = connection;

		// Deliberately not awaited: a database that is slow or down must not
		// block the caller from starting collection.
		void this.#createTtlIndexes(connection);

		return connection;
	}

	/*
	Forgets this connection and closes the client behind it, so that the next
	Drain opens a fresh one.

	Called after every Drain that failed, because a client whose *first*
	connection attempt failed is finished: the driver closes its topology and
	every later operation on it answers "Topology is closed" instead of trying
	again. Keeping it would mean a machine that started up with Atlas unreachable
	never Pushed anything again — for the rest of the run, however long — which is
	the one thing the Push Backlog exists to prevent.

	Reconnecting on *any* failure rather than only on a network one is deliberate:
	the driver does not offer a reliable way to tell "the server said no" from
	"there was no server", and an extra handshake per failed interval is a price
	worth paying for a backlog that always moves again.
	*/
	async #reopen(): Promise<void> {
		const {client} = this.#connection ?? {};
		this.#connection = undefined;

		await client?.close();
	}

	/*
	The connection a Push writes through, opening one if the last Drain closed it.
	*/
	#connected(): Connection {
		return this.#connection ?? this.#open();
	}

	/*
	The TTL indexes are MongoDB's, as they always were. The Local Store keeps
	every era; what ages out of Atlas is Atlas's business (ADR-0012).

	Asked once per Pusher, and the flag is set before the asking rather than
	after it. A connection is only ever reopened *because* a Drain against it
	failed, so the server was unreachable a moment ago: asking again there would
	be a failed ask and a second warning per Flush Interval — the noise the Run
	Log's six-entry window exists to keep out — to learn what the first ask
	already said. One ask per run is what this seam has always made, and a
	reconnect is not a reason to change it.
	*/
	async #createTtlIndexes({telemetry, heatmap}: Connection): Promise<void> {
		if (this.#indexesAsked) {
			return;
		}

		this.#indexesAsked = true;

		const indexes = [
			{
				collection: telemetry,
				expireAfterSeconds: this.#config.collectionTtlSeconds,
			},
			{
				collection: heatmap,
				expireAfterSeconds: this.#config.heatmapTtlSeconds,
			},
		];

		// A failing index is a warning, never fatal: a collection that cannot age
		// out is still a collection.
		for (const {collection, expireAfterSeconds} of indexes) {
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
	One era, as the wire documents the website reads.

	Sequential, and stopping at the first failure. Sequential is safe rather than
	duplicating: each document is an upsert keyed by this era's stamp, so the next
	Drain rewrites what a failed attempt landed instead of adding a second copy
	of it (ADR-0009).
	*/
	async #push(era: Era): Promise<void> {
		const {telemetry, heatmap} = this.#connected();

		for (const {collection, id, document} of documentsFor(
			era,
			telemetry,
			heatmap,
		)) {
			// eslint-disable-next-line no-await-in-loop -- sequential on purpose; see above.
			await collection.replaceOne({_id: id}, document, {upsert: true});
		}
	}

	/*
	The Drain itself: oldest era first, stopping at the first failure so the
	backlog stays a tail rather than a scatter of holes.

	An era leaves the backlog when its write is acknowledged, and not before — so
	a Push whose acknowledgement was lost is written again under its own stamp,
	where the upsert replaces it rather than duplicating it.
	*/
	async #drain(): Promise<void> {
		let eras: readonly Era[];
		try {
			eras = this.#backlog.backlog();
		} catch (error) {
			/*
			A backlog that cannot be read at all — a store closed underneath the
			Drain — is still a Drain that failed, and worth saying rather than
			swallowing into silence.
			*/
			this.#onAttempt?.({at: new Date(), ok: false, pushed: 0, error});
			return;
		}

		if (eras.length === 0) {
			return;
		}

		let pushed = 0;
		for (const era of eras) {
			try {
				// eslint-disable-next-line no-await-in-loop -- oldest first, one era at a time; see `#drain`.
				await this.#push(era);
			} catch (error) {
				/*
				The connection goes with the failure, and the next Drain opens a
				fresh one. Reported after that, so the attempt's timestamp is the
				moment the work stopped rather than the moment a client closed.
				*/
				// eslint-disable-next-line no-await-in-loop -- nothing else is in flight: this Drain is single-flight.
				await this.#reopen();
				this.#onAttempt?.({at: new Date(), ok: false, pushed, error});
				return;
			}

			try {
				this.#backlog.markPushed(era.stamp, new Date());
			} catch (error) {
				/*
				The era reached MongoDB but the store would not acknowledge it, so
				it stays in the backlog and the next Drain writes it again under
				its own stamp — an upsert, not a second copy. The connection is
				left alone: it is not the thing that failed, and closing it would
				cost a handshake to fix nothing.
				*/
				this.#onAttempt?.({at: new Date(), ok: false, pushed, error});
				return;
			}

			pushed += 1;
		}

		this.#onAttempt?.({at: new Date(), ok: true, pushed});
	}

	/*
	Pushes the backlog, or joins the Drain already doing it.

	Async because the driver is: this is the one seam in the repo that really
	does wait, and it says so. A second call while one is in flight returns the
	same work rather than starting a second pass — the point of single-flight is
	that a hanging Atlas cannot accumulate attempts behind it.
	*/
	async drain(): Promise<void> {
		if (this.#inFlight === undefined) {
			this.#inFlight = this.#drain().finally(() => {
				this.#inFlight = undefined;
			});
		}

		await this.#inFlight;
	}

	/*
	The last Drain a run makes, and what it leaves behind: waits out any Drain
	already in flight, runs one fresh awaited pass over the Push Backlog, and
	answers how many eras are still unpushed.

	The wait is the whole point. A pass asked for while one is in flight would
	join it and never look at the era a final Flush has just written — and a
	Drain that carried the backlog it was built from looks like nothing at all
	going wrong. Waiting out the in-flight pass and then asking for a fresh one
	puts the final Flush's era in front of a pass that has not read the backlog
	yet.

	The pass itself is an ordinary Drain: the same attempt reporting, stopping at
	the first failure, and silent when there is nothing to carry.

	The count is read after that pass has had its say, because a pass
	acknowledges the eras it carried: counting first would report ground the run
	then made up. It is also a reading the store has to be open to answer —
	`backlog()` on a closed one is a driver error rather than an answer — so this
	is asked before the store closes, not after.
	*/
	async settle(): Promise<number> {
		await this.#inFlight;
		await this.drain();
		return this.#backlog.backlog().length;
	}

	/*
	Closes a client this Pusher owns, and nothing else. Closing twice is
	survivable, because the Session closes on the way out of a run that may have
	failed anywhere, and the composition root closes on paths the Session never
	reached.
	*/
	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}

		this.#closed = true;
		await this.#connection?.client?.close();
	}
}
