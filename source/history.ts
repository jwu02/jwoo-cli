/*
The history seam, read from MongoDB.

The mirror of `storage.ts` on the read side. Everything that knows about
MongoDB lives behind `HistorySource`, so the view can be rendered from a fake
and no test needs a running database. The narrowed driver types follow the same
rule as the store's: each module declares only the slice it actually calls, and
here that is `aggregate`.

`aggregate` is deliberately *not* async, even though the store's methods are.
The driver's returns an `AggregationCursor` synchronously and the `await`
belongs on `toArray()`; declaring it async would let a reader that forgot the
`toArray()` pass every fake-backed test while fetching nothing at all.

Reads happen against the live Atlas database rather than the website's
`/api/telemetry`, so the view works on first run and does not depend on the
website's deploy state.

ADR-0012 deletes this module. The Local Store is the source of truth from now
on, and the vocabulary below — what a read answers with, and how it reports
itself — has already moved to `local-store.ts`, which is where it is going. What
is left here is the Mongo implementation and nothing else.
*/

import {MongoClient} from 'mongodb';
import {
	keyCountsPipeline,
	timeSeriesPipeline,
	totalsPipeline,
} from './aggregation.js';
import {type Config} from './config.js';
import {
	defaultReadWarningReporter,
	type KeyRanking,
	type LoadResult,
	messageOf,
	type ReadWarningReporter,
	type TimeSeriesPoint,
	type Totals,
} from './local-store.js';
import {bucketBoundaries, type Range} from './ranges.js';

/*
The slice of a driver `Collection` this reader calls.
*/
export type AggregationCursor = {
	toArray(): Promise<unknown[]>;
};

export type Collection = {
	readonly name: string;
	aggregate(
		pipeline: ReadonlyArray<Record<string, unknown>>,
	): AggregationCursor;
};

/*
The slice of a driver `Db` this reader calls.
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

export type HistorySource = {
	load(range: Range, now: Date): Promise<LoadResult>;
	close(): Promise<void>;
};

export type MongoHistorySourceOptions = {
	/*
	Where this reader's warnings go. The dashboard hands over a reporter that
	appends Run Log entries, so a read that failed is one line in the log rather
	than a driver sentence drawn across the frame.
	*/
	readonly onWarning?: ReadWarningReporter;
};

export class MongoHistorySource implements HistorySource {
	readonly #onWarning: ReadWarningReporter;
	readonly #timeZone: string;
	readonly #telemetryCollection: Collection;
	readonly #heatmapCollection: Collection;

	/*
	Present only when this reader owns the connection. An injected database is
	someone else's to close.
	*/
	readonly #client: MongoClient | undefined;

	constructor(
		config: Config,
		database?: Database,
		{onWarning = defaultReadWarningReporter}: MongoHistorySourceOptions = {},
		// Test seam for the real-client path. Otherwise unused.
		clientOverride?: MongoClient,
	) {
		this.#onWarning = onWarning;
		this.#timeZone = config.timeZone;

		/*
		An injected database means someone else owns the connection, so this
		reader must not open — or later close — one of its own.
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
	}

	/*
	One point per bucket, in order, with the buckets that collected nothing
	read as zero. `$bucket` only returns the buckets that held documents, so
	without this a quiet hour would leave a gap in the chart rather than a
	short bar.
	*/
	#seriesOf(rows: unknown[], boundaries: Date[]): readonly TimeSeriesPoint[] {
		const byBucket = new Map<string, Record<string, number>>();
		const unexpected: unknown[] = [];

		for (const row of rows as Array<Record<string, unknown>>) {
			const id = row['_id'];

			// The `default` bucket, or a date the caller never named. Counting
			// either would invent a bucket; dropping it silently would hide a
			// boundary bug, so it is dropped loudly.
			if (!(id instanceof Date)) {
				unexpected.push(id);
				continue;
			}

			byBucket.set(id.toISOString(), row as Record<string, number>);
		}

		if (unexpected.length > 0) {
			this.#onWarning({kind: 'ignored-buckets', buckets: unexpected});
		}

		return boundaries.slice(0, -1).map(start => {
			const row = byBucket.get(start.toISOString());

			return {
				bucket: start.toISOString(),
				leftClicks: row?.['leftClicks'] ?? 0,
				rightClicks: row?.['rightClicks'] ?? 0,
				movementMeters: row?.['movementMeters'] ?? 0,
				keyPresses: row?.['keyPresses'] ?? 0,
			};
		});
	}

	async load(range: Range, now: Date): Promise<LoadResult> {
		try {
			/*
			Inside the `try`, not before it. Boundary stepping throws for a zone
			Intl cannot resolve, and a rejection escaping here would end the
			process rather than draw an error — the exact failure this return
			type exists to prevent.
			*/
			const boundaries = bucketBoundaries(range, now, this.#timeZone);
			const since = boundaries[0]!;
			// Concurrent: the three questions are independent, and one round trip
			// of latency is already more than the view wants to wait for.
			const [totalsRows, keyRows, seriesRows] = await Promise.all([
				this.#telemetryCollection.aggregate(totalsPipeline(since)).toArray(),
				this.#heatmapCollection.aggregate(keyCountsPipeline(since)).toArray(),
				this.#telemetryCollection
					.aggregate(timeSeriesPipeline(boundaries))
					.toArray(),
			]);

			return {
				ok: true,
				data: {
					range,
					timeZone: this.#timeZone,
					totals: totalsOf(totalsRows),
					keyRanking: rankingOf(keyRows),
					timeSeries: this.#seriesOf(seriesRows, boundaries),
				},
			};
		} catch (error) {
			this.#onWarning({kind: 'failed-read', error});
			return {ok: false, message: messageOf(error)};
		}
	}

	async close(): Promise<void> {
		await this.#client?.close();
	}
}

/*
An empty range aggregates to no rows rather than a row of zeroes, so every
field needs a default. `pressTotal` is named for CONTEXT.md's Press Total; the
document field it sums is `keysPressed`.
*/
function totalsOf(rows: unknown[]): Totals {
	const [first] = rows as Array<Record<string, number>>;

	return {
		leftClicks: first?.['leftClicks'] ?? 0,
		rightClicks: first?.['rightClicks'] ?? 0,
		movementMeters: first?.['movementMeters'] ?? 0,
		pressTotal: first?.['pressTotal'] ?? 0,
	};
}

/*
Ranked here rather than in the pipeline: `$group` output order is unspecified,
so a list ordered by the server would reshuffle between loads. Ties break on
the label so the order is total.

Ties are the reason this is an array and not a `Record`. JavaScript orders the
integer-like keys of an object numerically, so building one and reading it back
would put `'2'` before `'10'` regardless of what the counts said.
*/
function rankingOf(rows: unknown[]): KeyRanking {
	return (rows as Array<{_id: unknown; count: unknown}>)
		.filter(
			row =>
				typeof row._id === 'string' &&
				typeof row.count === 'number' &&
				row.count > 0,
		)
		.map(row => ({label: row._id as string, count: row.count as number}))
		.toSorted((a, b) =>
			a.count === b.count ? compare(a.label, b.label) : b.count - a.count,
		);
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
