import test from 'ava';
import {
	OUT_OF_RANGE,
	keyCountsPipeline,
	timeSeriesPipeline,
	totalsPipeline,
} from './aggregation.js';

/*
These builders *are* the module's interface — the pipeline document is the
output, so asserting its exact shape is asserting behaviour, not structure.
There is no database in the suite to assert against instead, and the website's
own suite tests its equivalent the same way.
*/

const SINCE = new Date('2026-09-20T16:00:00.000Z');

test('totals sums the flat telemetry fields since the range start', t => {
	t.deepEqual(totalsPipeline(SINCE), [
		{$match: {createdAt: {$gte: SINCE}}},
		{
			$group: {
				_id: null,
				leftClicks: {$sum: '$leftClicks'},
				rightClicks: {$sum: '$rightClicks'},
				movementMeters: {$sum: '$movementMeters'},
				// Named for CONTEXT.md's Press Total, not the document's field.
				pressTotal: {$sum: '$keysPressed'},
			},
		},
	]);
});

/*
The `$isNumber` term is the difference from the website's pipeline, and it
matters more here. ADR-0004 records that the reader sums every top-level field
except `_id` and `createdAt`, so a stray metadata field already registers as a
key with a large count — and the website then discards it, having no layout
entry for it. A ranked list has no such safety net: it would put the field on
screen as if it were a Key Label. Only numbers may be counted.
*/
test('key counts unfold the label fields, excluding the metadata', t => {
	t.deepEqual(keyCountsPipeline(SINCE), [
		{$match: {createdAt: {$gte: SINCE}}},
		{
			$project: {
				pairs: {
					$filter: {
						input: {$objectToArray: '$$ROOT'},
						as: 'field',
						cond: {
							$and: [
								{$not: {$in: ['$$field.k', ['_id', 'createdAt']]}},
								{$isNumber: '$$field.v'},
							],
						},
					},
				},
			},
		},
		{$unwind: '$pairs'},
		{$group: {_id: '$pairs.k', count: {$sum: '$pairs.v'}}},
	]);
});

test('the time series buckets into the boundaries it is handed', t => {
	const boundaries = [
		new Date('2026-09-20T16:00:00.000Z'),
		new Date('2026-09-20T17:00:00.000Z'),
		new Date('2026-09-20T18:00:00.000Z'),
	];

	t.deepEqual(timeSeriesPipeline(boundaries), [
		{
			$match: {
				createdAt: {
					$gte: boundaries[0],
					// Exclusive, so the bucket after the current one cannot be
					// half-filled by a document written mid-query.
					$lt: boundaries.at(-1),
				},
			},
		},
		{
			$bucket: {
				groupBy: '$createdAt',
				boundaries,
				default: OUT_OF_RANGE,
				output: {
					leftClicks: {$sum: '$leftClicks'},
					rightClicks: {$sum: '$rightClicks'},
					movementMeters: {$sum: '$movementMeters'},
					keyPresses: {$sum: '$keysPressed'},
				},
			},
		},
		{$sort: {_id: 1}},
	]);
});

test('a single-bucket range still produces a well-formed pipeline', t => {
	// Exactly local midnight: one bucket, so two boundaries. `$bucket` needs at
	// least two and this is the smallest real input it will ever get.
	const boundaries = [
		new Date('2026-09-21T00:00:00.000Z'),
		new Date('2026-09-21T01:00:00.000Z'),
	];

	const [, bucket] = timeSeriesPipeline(boundaries) as [
		unknown,
		Record<string, Record<string, unknown>>,
	];

	t.deepEqual(bucket['$bucket']!['boundaries'], boundaries);
	t.is((bucket['$bucket']!['boundaries'] as unknown[]).length, 2);
});

test('the boundaries are handed to Mongo as the same dates, not copies', t => {
	const boundaries = [
		new Date('2026-09-21T00:00:00.000Z'),
		new Date('2026-09-21T01:00:00.000Z'),
	];

	const [match, bucket] = timeSeriesPipeline(boundaries) as [
		Record<string, Record<string, Record<string, Date>>>,
		Record<string, Record<string, Date[]>>,
	];

	// Identity, not equality: the bucket list is the single definition of what
	// a bucket is, so it must be the very array the caller generated.
	t.is(bucket['$bucket']!['boundaries'], boundaries);
	t.is(match['$match']!['createdAt']!['$gte'], boundaries[0]);
	t.is(match['$match']!['createdAt']!['$lt'], boundaries[1]);
});
