/*
The history seam.

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
*/

import {MongoClient} from 'mongodb';
import {
	keyCountsPipeline,
	timeSeriesPipeline,
	totalsPipeline,
} from './aggregation.js';
import {type Config} from './config.js';
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

export type Totals = {
	readonly leftClicks: number;
	readonly rightClicks: number;
	readonly movementMeters: number;
	readonly pressTotal: number;
};

/*
One Key Label and how often it was pressed. Ordered by count rather than by
label, which is what makes it a ranking rather than Key Counts — see the
CONTEXT.md entry.
*/
export type RankedKey = {
	readonly label: string;
	readonly count: number;
};

export type KeyRanking = readonly RankedKey[];

export type TimeSeriesPoint = {
	readonly bucket: string;
	readonly leftClicks: number;
	readonly rightClicks: number;
	readonly movementMeters: number;
	readonly keyPresses: number;
};

export type HistoryData = {
	readonly range: Range;
	/*
	The zone the buckets were aligned to. Carried so the view cannot label
	instants in a different zone than the one they were computed in.
	*/
	readonly timeZone: string;
	readonly totals: Totals;
	readonly keyRanking: KeyRanking;
	readonly timeSeries: readonly TimeSeriesPoint[];
};

/*
Typed failure as a value, as in `storage.ts` — but a union rather than
`undefined`, and for a different reason. `flush`'s `undefined` encodes "retry
me" and needs no detail; a read has three outcomes and the failure needs a
message the view can draw. It must not reject: a rejection raised inside an
effect is an unhandled rejection, which ends the process by default, so the TUI
would exit rather than show the error.
*/
export type LoadResult =
	{ok: true; data: HistoryData} | {ok: false; message: string};

export type HistorySource = {
	load(range: Range, now: Date): Promise<LoadResult>;
	close(): Promise<void>;
};

export type MongoHistorySourceOptions = {
	readonly logger?: Pick<Console, 'warn'>;
};

export class MongoHistorySource implements HistorySource {
	readonly #logger: Pick<Console, 'warn'>;
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
		{logger = console}: MongoHistorySourceOptions = {},
		// Test seam for the real-client path. Otherwise unused.
		clientOverride?: MongoClient,
	) {
		this.#logger = logger;
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
			this.#logger.warn(
				`Ignored ${unexpected.length} time series bucket(s) outside the range boundaries`,
				unexpected,
			);
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
			this.#logger.warn('Failed to read telemetry history', error);
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

/*
The driver's errors are worth showing — "connect ECONNREFUSED" tells the user
more than "something went wrong" — so the message is passed through as-is
rather than replaced with a generic one.
*/
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
