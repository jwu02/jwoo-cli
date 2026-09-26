import test from 'ava';
import {bucketBoundaries, bucketUnit} from './ranges.js';

/*
The ranges are calendar-aligned in local time, and the boundaries this module
produces are the *only* definition of a bucket — the Local Store groups its rows
by them and nothing else. There is no second implementation for them to disagree
with, which is why these tests are the ones that matter.

Every case names its timezone rather than relying on the machine's, so the DST
cases below are ordinary assertions that pass anywhere.
*/

const iso = (date: Date) => date.toISOString();

test('today buckets every local hour from local midnight', t => {
	const boundaries = bucketBoundaries(
		'today',
		new Date('2026-09-21T12:00:00.000Z'),
		'UTC',
	);

	t.is(iso(boundaries[0]!), '2026-09-21T00:00:00.000Z');
	// The last boundary starts the bucket *after* the one containing `now`, so
	// it is the exclusive upper bound and is strictly greater than `now`.
	t.is(iso(boundaries.at(-1)!), '2026-09-21T13:00:00.000Z');
	t.is(boundaries.length, 14);
});

test('bucketUnit pairs hours with today and days with the week', t => {
	t.is(bucketUnit('today'), 'hour');
	t.is(bucketUnit('week'), 'day');
});

test('today tracks a zone offset rather than UTC', t => {
	// 12:00Z is 20:00 in Shanghai, so the local day began at 16:00Z the day before.
	const boundaries = bucketBoundaries(
		'today',
		new Date('2026-09-21T12:00:00.000Z'),
		'Asia/Shanghai',
	);

	t.is(iso(boundaries[0]!), '2026-09-20T16:00:00.000Z');
	t.is(iso(boundaries.at(-1)!), '2026-09-21T13:00:00.000Z');
	t.is(boundaries.length, 22);
});

/*
Daylight saving is why the boundaries are stepped through the local wall clock
rather than by adding a fixed hour.

On 2026-10-25 London reads 01:00 twice — once at 00:00Z (BST) and again at
01:00Z (GMT), confirmed against the zone database. A generator that emitted one
key per `hour = 0…23` would never produce the second one, and every document
written during it would vanish from the chart while still counting in the
totals. Here the repeated hour is absorbed into a single two-hour bucket, so
the series still sums to the totals — the one property that must not break.
*/
test('a fall-back day spends one more real hour than it has buckets', t => {
	// Local 13:00 on the day the clocks go back — 13:00Z, the zone being on GMT
	// by then.
	const boundaries = bucketBoundaries(
		'today',
		new Date('2026-10-25T13:00:00.000Z'),
		'Europe/London',
	);

	t.is(iso(boundaries[0]!), '2026-10-24T23:00:00.000Z');
	t.is(iso(boundaries.at(-1)!), '2026-10-25T14:00:00.000Z');

	const elapsedHours =
		(boundaries.at(-1)!.getTime() - boundaries[0]!.getTime()) / 3_600_000;
	const buckets = boundaries.length - 1;

	/*
	Fifteen hours have elapsed but there are fourteen buckets, because 01:00
	was read twice and both readings share a bucket. A generator that emitted
	one key per `hour = 0…23` would produce fourteen buckets for a day that
	only had twenty-four hours in it — and the hour it omitted would be the
	one the extra reading landed in.
	*/
	t.is(elapsedHours, 15);
	t.is(buckets, 14);
	t.is(elapsedHours - buckets, 1);

	for (const boundary of boundaries) {
		t.is(localMinute(boundary, 'Europe/London'), 0);
	}

	// 00:30Z is 01:30 BST and 01:30Z is 01:30 GMT: the same wall clock, an hour
	// apart. Neither may fall outside every bucket.
	for (const reading of [
		'2026-10-25T00:30:00.000Z',
		'2026-10-25T01:30:00.000Z',
	]) {
		t.is(
			bucketsContaining(boundaries, reading).length,
			1,
			`${reading} falls in exactly one bucket`,
		);
	}
});

test('a day with no transition spends one real hour per bucket', t => {
	const boundaries = bucketBoundaries(
		'today',
		new Date('2026-09-21T13:00:00.000Z'),
		'Europe/London',
	);

	const elapsedHours =
		(boundaries.at(-1)!.getTime() - boundaries[0]!.getTime()) / 3_600_000;

	t.is(elapsedHours, boundaries.length - 1);
});

/*
The other half: on 2026-03-29 London goes straight from 01:00 GMT to 02:00 BST,
so an hour of the wall clock never happens. No bucket may be labelled with it,
and no boundary may be produced twice.
*/
test('today skips the hour that does not happen when the clocks go forward', t => {
	const boundaries = bucketBoundaries(
		'today',
		new Date('2026-03-29T12:00:00.000Z'),
		'Europe/London',
	);

	t.is(iso(boundaries[0]!), '2026-03-29T00:00:00.000Z');
	t.is(iso(boundaries[1]!), '2026-03-29T01:00:00.000Z');
	t.is(iso(boundaries[2]!), '2026-03-29T02:00:00.000Z');
	t.is(boundaries.length, 14);

	const localHours = boundaries.map(boundary =>
		localHour(boundary, 'Europe/London'),
	);
	t.false(
		localHours.includes(1),
		'no bucket starts at the hour that was skipped',
	);
});

test('a week starts on Monday and runs to the day after today', t => {
	// 2026-09-23 is a Wednesday, so the week began on Monday the 21st.
	const boundaries = bucketBoundaries(
		'week',
		new Date('2026-09-23T12:00:00.000Z'),
		'UTC',
	);

	t.is(iso(boundaries[0]!), '2026-09-21T00:00:00.000Z');
	t.is(iso(boundaries.at(-1)!), '2026-09-24T00:00:00.000Z');
	t.is(boundaries.length, 4);
});

test('a week that starts today is a single bucket', t => {
	const boundaries = bucketBoundaries(
		'week',
		new Date('2026-09-21T12:00:00.000Z'),
		'UTC',
	);

	t.is(iso(boundaries[0]!), '2026-09-21T00:00:00.000Z');
	t.is(boundaries.length, 2);
});

test('Sunday reaches back six days to its Monday', t => {
	const boundaries = bucketBoundaries(
		'week',
		new Date('2026-09-27T12:00:00.000Z'),
		'UTC',
	);

	t.is(iso(boundaries[0]!), '2026-09-21T00:00:00.000Z');
	t.is(boundaries.length, 8);
});

test('a week starting in the previous month reaches across the boundary', t => {
	// 2026-09-01 is a Tuesday; its Monday is in August.
	const boundaries = bucketBoundaries(
		'week',
		new Date('2026-09-01T12:00:00.000Z'),
		'UTC',
	);

	t.is(iso(boundaries[0]!), '2026-08-31T00:00:00.000Z');
	t.is(boundaries.length, 3);
});

/*
A week containing a transition has one day of 25 hours. Stepping by a fixed 24
would put the last boundary an hour early and mislabel every day after it; the
day must still start at local midnight.
*/
test('a week spanning a transition keeps every boundary at local midnight', t => {
	const boundaries = bucketBoundaries(
		'week',
		new Date('2026-10-25T12:00:00.000Z'),
		'Europe/London',
	);

	t.is(iso(boundaries[0]!), '2026-10-18T23:00:00.000Z');
	// 25 hours after the previous boundary, not 24.
	t.is(iso(boundaries.at(-1)!), '2026-10-26T00:00:00.000Z');
	t.is(boundaries.length, 8);

	for (const boundary of boundaries) {
		t.is(localHour(boundary, 'Europe/London'), 0);
		t.is(localMinute(boundary, 'Europe/London'), 0);
	}
});

test('boundaries always ascend and always bracket now', t => {
	for (let day = 0; day < 365; day += 1) {
		// `Date.UTC` rolls day overflow into the month, so this walks the year.
		const now = new Date(Date.UTC(2026, 0, 1 + day, 12));

		for (const range of ['today', 'week'] as const) {
			const boundaries = bucketBoundaries(range, now, 'Europe/London');

			t.true(
				boundaries.length >= 2,
				`${range} on ${now.toISOString()} has at least one bucket`,
			);

			for (let index = 0; index < boundaries.length - 1; index += 1) {
				t.true(
					boundaries[index]!.getTime() < boundaries[index + 1]!.getTime(),
					`${range} on ${now.toISOString()} ascends at ${index}`,
				);
			}

			// `now` sits inside the last bucket, which is what makes the last
			// boundary a valid exclusive upper bound for the `$match`.
			t.true(boundaries[0]!.getTime() <= now.getTime());
			t.true(boundaries.at(-1)!.getTime() > now.getTime());
		}
	}
});

function bucketsContaining(boundaries: Date[], instant: string): Date[] {
	const at = new Date(instant).getTime();
	return boundaries.filter((boundary, index) => {
		const upper = boundaries[index + 1]?.getTime();
		return at >= boundary.getTime() && (upper === undefined || at < upper);
	});
}

/*
Formatting helpers. These read the boundary back through Intl, which is
deliberately *not* how the boundary was produced — the assertions above are on
literal instants, and these exist only to state a property in wall-clock terms.
*/
function localParts(instant: Date, timeZone: string): Record<string, number> {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		hour: '2-digit',
		minute: '2-digit',
	}).formatToParts(instant);

	const values: Record<string, number> = {};
	for (const part of parts) {
		if (part.type !== 'literal') {
			values[part.type] = Number(part.value);
		}
	}

	return values;
}

const localHour = (instant: Date, timeZone: string) =>
	localParts(instant, timeZone)['hour']! % 24;

const localMinute = (instant: Date, timeZone: string) =>
	localParts(instant, timeZone)['minute']!;
