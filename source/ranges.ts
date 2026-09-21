/*
The ranges the history view offers, and the buckets it draws them in.

These are *calendar-aligned in local time*: Today runs from local midnight,
This week from local Monday midnight. The website's are rolling (24h / 30d /
1y) and this is a deliberate divergence — a heading that says "Today" should
mean today.

`bucketBoundaries` returns N+1 ascending instants, and display bucket `i` is
`[b[i], b[i+1])`. That list is handed to MongoDB's `$bucket` unchanged, so it
is the *only* definition of a bucket: there is no second implementation on the
server that it could disagree with. The last boundary is the start of the
bucket after the one containing `now`, which makes it a strict upper bound.
*/

import {
	instantFromLocalFields,
	type LocalFields,
	localFields,
	weekdayOf,
} from './local-time.js';

export type Range = 'today' | 'week';

export type BucketUnit = 'hour' | 'day';

export function bucketUnit(range: Range): BucketUnit {
	return range === 'today' ? 'hour' : 'day';
}

/*
A runaway guard rather than a real limit: Today needs at most 26 buckets even
on a 25-hour day, and This week at most 8. If stepping ever fails to advance,
this turns a hung TUI into a thrown error.
*/
const MAX_BUCKETS = 400;

export function bucketBoundaries(
	range: Range,
	now: Date,
	timeZone: string,
): Date[] {
	const unit = bucketUnit(range);

	let current = rangeStart(range, now, timeZone);
	const boundaries = [current];

	while (current.getTime() <= now.getTime()) {
		current = nextBoundary(current, unit, timeZone);
		boundaries.push(current);

		if (boundaries.length > MAX_BUCKETS) {
			throw new Error(
				`Stepping ${unit} boundaries from ${boundaries[0]!.toISOString()} never passed ${now.toISOString()} in ${timeZone}`,
			);
		}
	}

	return boundaries;
}

/*
Local midnight, or local Monday midnight. Built from wall-clock fields rather
than by subtracting from `now`, because "the start of the local day" is not a
fixed number of milliseconds back.
*/
function rangeStart(range: Range, now: Date, timeZone: string): Date {
	const fields = localFields(now, timeZone);
	const midnight: LocalFields = {
		...fields,
		hour: 0,
		minute: 0,
		second: 0,
		millisecond: 0,
	};

	if (range === 'today') {
		return instantFromLocalFields(midnight, timeZone);
	}

	// `getUTCDay` is 0 = Sunday; a week starts on Monday.
	const weekday = weekdayOf(fields);
	const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;

	// A negative day rolls back through the month and year, which is what makes
	// the first days of a month land in the right week.
	return instantFromLocalFields(
		{...midnight, day: midnight.day - daysSinceMonday},
		timeZone,
	);
}

/*
The first boundary strictly after `from`, found by advancing the local wall
clock rather than by adding a fixed number of milliseconds.

That distinction is the whole reason this is not a `+ 3600000`. On the day the
clocks go back the local hour is repeated, and on the day they go forward it is
skipped; adding a fixed hour to an instant would walk straight past both. Two
steps is always enough — the second covers the case where one step lands back
on `from` because the wall clock it asked for is ambiguous.
*/
function nextBoundary(from: Date, unit: BucketUnit, timeZone: string): Date {
	const fields = localFields(from, timeZone);

	for (const step of [1, 2]) {
		const candidate = instantFromLocalFields(
			advance(fields, unit, step),
			timeZone,
		);

		if (candidate.getTime() > from.getTime()) {
			return candidate;
		}
	}

	throw new Error(
		`No ${unit} boundary found after ${from.toISOString()} in ${timeZone}`,
	);
}

function advance(
	fields: LocalFields,
	unit: BucketUnit,
	step: number,
): LocalFields {
	return unit === 'hour'
		? {...fields, hour: fields.hour + step}
		: {...fields, day: fields.day + step};
}
