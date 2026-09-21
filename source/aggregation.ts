/*
The aggregation the history view reads through, as pipeline documents.

Ported from `jwoo/lib/telemetry/aggregation.ts`, with two deliberate
differences. Both are recorded in `docs/adr/0007`:

- Every pipeline is range-scoped. The website's totals and key counts carry no
  time filter at all, so its heatmap is all-time while its chart follows the
  selected range; here the three agree on one `since`.
- Key counts filter on `$isNumber`. See `keyCountsPipeline`.

The builders are pure and return plain documents, so what they produce can be
asserted directly — there is no database in the test suite, and the pipeline is
the output.
*/

/*
The label `$bucket` gives documents that fall outside its boundaries. It should
be unreachable: `$match` applies the same bounds. It is set rather than omitted
so that a document which slips through is identifiable in the result instead of
raising a server-side error or landing in an unnamed bucket.
*/
export const OUT_OF_RANGE = 'out-of-range';

export function totalsPipeline(since: Date): Array<Record<string, unknown>> {
	return [
		{$match: {createdAt: {$gte: since}}},
		{
			$group: {
				_id: null,
				leftClicks: {$sum: '$leftClicks'},
				rightClicks: {$sum: '$rightClicks'},
				movementMeters: {$sum: '$movementMeters'},
				pressTotal: {$sum: '$keysPressed'},
			},
		},
	];
}

/*
A Key Count Document stores Key Labels as dynamic top-level fields, so reading
them means turning the document into an array and unfolding it.

`$isNumber` is the guard ADR-0004 asks for. That ADR records that summing every
field except `_id` and `createdAt` means a stray metadata field silently
registers as a key with a large count. The website survives this because
`key-layout.ts` discards labels it has no Physical Key for; a ranked list has
no such net and would render the field as though it were a key.
*/
export function keyCountsPipeline(since: Date): Array<Record<string, unknown>> {
	return [
		{$match: {createdAt: {$gte: since}}},
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
	];
}

/*
Buckets by the boundaries the caller computed, rather than asking the server to
truncate by a timezone.

`$dateTrunc` would need the zone name to cross the wire and a second, matching
implementation of the boundaries on this side — and the two only have to
disagree once, on the day the clocks change, for the chart to stop summing to
the totals. Handing over `boundaries` makes the list the single definition of a
bucket, so a bug here mis-shapes a bar instead of losing data.

The upper bound is exclusive. Without it a document written between the
caller's `now` and the query running would fall into a bucket the caller never
generated, and be dropped.
*/
export function timeSeriesPipeline(
	boundaries: Date[],
): Array<Record<string, unknown>> {
	return [
		{
			$match: {
				createdAt: {$gte: boundaries[0], $lt: boundaries.at(-1)},
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
	];
}
