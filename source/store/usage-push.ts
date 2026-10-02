/*
The Usage Push seam.

The sibling of `push.ts`, and deliberately not a second tail inside it: the era
Pusher's contract is era-specific — a `settle()` that answers one number, TTL
indexes, a connection reopened for a long run — while this seam is one-shot.
Connect, carry the Usage Backlog oldest `recorded_at` first, stop at the first
failed batch, close. Nothing on the Flush path reaches it; the command that
Ingested the records awaits it at the end of its own invocation.

The driver's types arrive type-only and the database structurally, so the wall
`push.ts` holds stays held: no module but the era Pusher imports `mongodb` as a
value. The one client this seam opens comes from `createMongoClient`, which
`push.ts` exports for exactly this reason.

What makes a re-Push converge is the `_id`: derived from the record's content
(ADR-0013), so a store wiped and re-Ingested from the same transcripts writes the
same ids and the upsert overwrites what a lost acknowledgement landed rather
than adding a second copy beside it. The wire document itself is exactly the ten
fields the website already reads — no TTL, no `createdAt` (spec #53).
*/

import {createHash} from 'node:crypto';
import type {MongoClient} from 'mongodb';
import {type Config} from './config.js';
import {type BackloggedUsage} from './local-store.js';
import {createMongoClient, type PushAttempt} from './push.js';

/*
The slice of a driver `Collection` this seam actually calls.

`bulkWrite` rather than one `replaceOne` per record: a first drain can carry a
couple of thousand records, and per-document round trips turn seconds into
minutes. The operations are `replaceOne` upserts, so the batch keeps ADR-0013's
idempotency — each is keyed by the record's content `_id`, not appended.

Declared here rather than reused from `push.ts` because the era Pusher writes
two documents per era with `replaceOne` and asks for TTL indexes; this seam
writes one document per record in bulk and asks for no index. A module names
what it uses.
*/
export type UsageCollection = {
	readonly collectionName: string;
	bulkWrite(
		operations: readonly UsageWrite[],
		options: {ordered: boolean},
	): Promise<unknown>;
};

/*
One `replaceOne` upsert, as the driver's bulk-write operation spells it. `upsert`
is the literal `true` because this seam has no other mode: a write that only
matched would silently drop a record whose content key is new.
*/
type UsageWrite = {
	readonly replaceOne: {
		readonly filter: {_id: string};
		readonly replacement: Record<string, unknown>;
		readonly upsert: true;
	};
};

/*
The slice of a driver `Db` this seam calls.
*/
export type UsageDatabase = {
	collection(name: string): UsageCollection;
};

/*
`MongoClient` is not itself a `UsageDatabase` — it hands one out by name, which
is where the configured database name comes in.
*/
function databaseOf(client: MongoClient, dbName: string): UsageDatabase {
	return client.db(dbName) as unknown as UsageDatabase;
}

/*
How many records one `bulkWrite` carries. Large enough that a ~1,800-record first
drain is a handful of round trips, small enough that a failed batch is a bounded
amount of work to re-push.
*/
const BATCH_SIZE = 500;

/*
A record's `_id`: its own instant, then a hash of its content.

The instant first, because it is what makes a document findable by eye; the
content hash after it is what makes the key stable across a re-Push (ADR-0013).
Hashed rather than concatenated because a model id is a payload-controlled
string that could contain the separator. The input is the model and the five
token buckets, JSON-encoded so that `null` model, `"null"` model and a missing
field cannot collide. The website's aggregation never reads `_id`, so the extra
key costs it nothing (ADR-0004).
*/
function documentId(record: BackloggedUsage): string {
	const content = JSON.stringify([
		record.model ?? null,
		record.prompt_tokens,
		record.completion_tokens,
		record.total_tokens,
		record.prompt_cache_hit_tokens,
		record.prompt_cache_miss_tokens,
	]);
	const digest = createHash('sha256').update(content).digest('hex');

	return `${record.recordedAt.toISOString()}#${digest}`;
}

/*
One record, as the driver's `replaceOne` operation writes it: the content-keyed
`_id`, and the wire document — exactly the ten fields the website reads, absent
values written as `null` so every document carries all ten.

`recorded_at` is a real BSON `Date`, not the epoch milliseconds the Local Store
holds: the website's aggregation groups on it as a date.
*/
function writeOf(record: BackloggedUsage): UsageWrite {
	const id = documentId(record);

	/* eslint-disable @typescript-eslint/naming-convention -- the wire's own field names, which the website reads. */
	return {
		replaceOne: {
			filter: {_id: id},
			upsert: true,
			replacement: {
				_id: id,
				harness: record.harness,
				cwd: record.cwd ?? null,
				model: record.model ?? null,
				cost_yuan: record.costYuan ?? null,
				prompt_tokens: record.prompt_tokens,
				completion_tokens: record.completion_tokens,
				total_tokens: record.total_tokens,
				prompt_cache_hit_tokens: record.prompt_cache_hit_tokens,
				prompt_cache_miss_tokens: record.prompt_cache_miss_tokens,
				recorded_at: record.recordedAt,
			},
		},
	};
	/* eslint-enable @typescript-eslint/naming-convention */
}

/*
The Usage Backlog, as this seam reaches for it: the records no Push has
acknowledged, oldest `recorded_at` first, and the acknowledgement that takes one
out.

The Local Store satisfies this and is the only implementation; the slice is
declared here rather than reusing `PushBacklog` for the reason that type is
declared in `push.ts` — a module names what it uses, and the era backlog hands
out eras.
*/
export type UsagePushBacklog = {
	usageBacklog(): readonly BackloggedUsage[];
	markUsagePushed(id: number, at: Date): void;
};

export type UsagePusherOptions = {
	/*
	An injected database means someone else owns the connection, so this seam
	both writes through it and leaves it open. The one-shot lifetime is about a
	client this seam opened itself.
	*/
	readonly database?: UsageDatabase;
	/*
	Called once per drain that found something to carry. Silent when the backlog
	is empty — a drain with nothing to carry did not attempt anything, the shape
	the era Pusher's report has.
	*/
	readonly onAttempt?: (attempt: PushAttempt) => void;
	/*
	Builds the client, for the one caller that needs a stand-in. It defaults to
	the real one, built by `push.ts` so that the driver stays imported there.
	*/
	readonly createClient?: () => MongoClient;
};

/*
Carries the Usage Backlog to the `ai_usage` collection.

One-shot: the constructor opens the connection, `drain()` makes one pass, and
`close()` closes what this seam opened. There is no single-flight and no reopen,
because nothing here is fired from a path that must not wait and no run holds
one of these open across intervals — the command that built it awaits the drain
and closes it before the process ends.

`drain()` never throws. Every way one can fail — a backlog that will not be
read, a batch the server refuses, a store that will not acknowledge — is
reported through `onAttempt`, because the command that called it owns the exit
code and the ADR-0016 contract, not this seam. Construction is the exception: a
seam built with no `MONGO_URI` throws a `ConfigError` from `createMongoClient`,
which is how the usage path decides whether to build one at all.
*/
export class UsagePusher {
	readonly #backlog: UsagePushBacklog;
	readonly #onAttempt: ((attempt: PushAttempt) => void) | undefined;
	readonly #client: MongoClient | undefined;
	readonly #collection: UsageCollection;

	#closed = false;

	constructor(
		config: Config,
		backlog: UsagePushBacklog,
		{
			database,
			onAttempt,
			createClient = () => createMongoClient(config),
		}: UsagePusherOptions = {},
	) {
		this.#backlog = backlog;
		this.#onAttempt = onAttempt;

		const client = database === undefined ? createClient() : undefined;
		const resolved = database ?? databaseOf(client!, config.dbName);

		this.#client = client;
		this.#collection = resolved.collection(config.aiUsageCollectionName);
	}

	/*
	One pass over the Usage Backlog, oldest record first, in `bulkWrite` batches
	of `BATCH_SIZE`, stopping at the first failed batch so the tail stays a tail.

	A batch's records are acknowledged only after the server has taken it, so a
	lost acknowledgement leaves them in the backlog — where the next drain writes
	the same content `_id`s again as upserts rather than duplicates (ADR-0013).
	*/
	async drain(): Promise<void> {
		let records: readonly BackloggedUsage[];
		try {
			records = this.#backlog.usageBacklog();
		} catch (error) {
			/*
			A backlog that cannot be read is still a drain that failed, and worth
			saying rather than swallowing into silence.
			*/
			this.#onAttempt?.({at: new Date(), ok: false, pushed: 0, error});
			return;
		}

		if (records.length === 0) {
			return;
		}

		let pushed = 0;
		for (let start = 0; start < records.length; start += BATCH_SIZE) {
			const batch = records.slice(start, start + BATCH_SIZE);

			try {
				// eslint-disable-next-line no-await-in-loop -- ordered batches, one at a time; see the class comment.
				await this.#collection.bulkWrite(
					batch.map(record => writeOf(record)),
					{
						ordered: true,
					},
				);
			} catch (error) {
				this.#onAttempt?.({at: new Date(), ok: false, pushed, error});
				return;
			}

			const at = new Date();
			for (const record of batch) {
				try {
					this.#backlog.markUsagePushed(record.id, at);
				} catch (error) {
					/*
					The batch reached MongoDB but the store would not
					acknowledge it, so those records stay in the backlog and the
					next drain writes them again under their own content keys —
					an upsert, not a second copy.
					*/
					this.#onAttempt?.({at: new Date(), ok: false, pushed, error});
					return;
				}

				pushed += 1;
			}
		}

		this.#onAttempt?.({at: new Date(), ok: true, pushed});
	}

	/*
	Closes a client this seam opened, and nothing else. Closing twice is
	survivable, because the caller closes on the way out of an invocation that
	may have failed anywhere.
	*/
	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}

		this.#closed = true;
		await this.#client?.close();
	}
}
