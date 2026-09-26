/*
Local wall-clock arithmetic, in a named timezone.

The reader buckets Telemetry Documents by the *local* day and hour, so it has
to turn an instant into local wall-clock fields and back again. This module is
that conversion and nothing else: no MongoDB, no ambient system state, and the
timezone is always a parameter.

That last part is the point. The CLI only ever reads the machine's own zone, so
a parameter looks like ceremony — but it is what makes the daylight-saving
tests in `ranges.test.ts` ordinary assertions instead of tests that have to
mutate `process.env.TZ` and run alone.

`jwoo/lib/timezone.ts` solves the same problem for an arbitrary viewer zone, and
the offset calculation is ported from it. The port stops there: the website's
`alignToInterval` resolves an instant in a single pass, which is wrong for a
day-length bin that straddles a transition. See `instantFromLocalFields`.
*/

/*
Milliseconds between a UTC instant and its wall-clock reading in `timeZone`.
Positive when the zone is east of UTC (Asia/Shanghai = +8h = 28 800 000).
*/
export function offsetAt(instant: Date, timeZone: string): number {
	const clock = wallClockIn(instant, timeZone);

	/*
	The wall clock in `timeZone` read as if it were UTC, minus the real instant,
	is the zone's offset. Intl reports whole seconds only, so the milliseconds
	have to be carried over from the input or the offset comes back short by
	that much and leaks into every boundary.
	*/
	return (
		Date.UTC(
			clock.year,
			clock.month - 1,
			clock.day,
			clock.hour,
			clock.minute,
			clock.second,
			instant.getMilliseconds(),
		) - instant.getTime()
	);
}

export type LocalFields = WallClock & {
	readonly millisecond: number;
};

export function localFields(instant: Date, timeZone: string): LocalFields {
	return {
		...wallClockIn(instant, timeZone),
		millisecond: instant.getMilliseconds(),
	};
}

/*
The instant at which the wall clock in `timeZone` next reads exactly these
fields. Fields outside their normal range roll over, so `{day: 32}` is the 1st
of the next month — the stepping in `ranges.ts` relies on that.

Resolved in two passes, and the second pass is load-bearing. The offset has to
be read at the instant being solved for, not at the naive guess: on a day whose
length is not 24 hours the two differ, and a single pass lands an hour either
side of the boundary. One pass is what the website's `alignToInterval` does,
which is correct for its fixed-offset deployment and wrong for a day bin that
straddles a transition.

An ambiguous wall clock (the hour that occurs twice when clocks go back)
resolves to the earlier instant, and a nonexistent one (the hour skipped when
they go forward) resolves to the instant the clock jumps to. Both follow
ECMA-262's `LocalTime`, and both are covered in `ranges.test.ts`.
*/
export function instantFromLocalFields(
	fields: LocalFields,
	timeZone: string,
): Date {
	const naive = Date.UTC(
		fields.year,
		fields.month - 1,
		fields.day,
		fields.hour,
		fields.minute,
		fields.second,
		fields.millisecond,
	);

	const firstPass = naive - offsetAt(new Date(naive), timeZone);
	const secondPass = naive - offsetAt(new Date(firstPass), timeZone);

	return new Date(secondPass);
}

/*
Wall-clock fields, without the milliseconds — the part Intl reports.

`hourCycle: 'h23'` because the default for `en-US` renders midnight as hour 24,
which would put every boundary a day out.
*/
type WallClock = {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
};

function wallClockIn(instant: Date, timeZone: string): WallClock {
	const values: Record<string, number> = {};
	for (const part of formatterFor(timeZone).formatToParts(instant)) {
		if (part.type !== 'literal') {
			values[part.type] = Number(part.value);
		}
	}

	// A formatter built for a fixed zone always produces every part, so the
	// fallbacks are unreachable; they are here because an index signature gives
	// no way to say so.
	return {
		year: values['year'] ?? 0,
		month: values['month'] ?? 1,
		day: values['day'] ?? 1,
		hour: (values['hour'] ?? 0) % 24,
		minute: values['minute'] ?? 0,
		second: values['second'] ?? 0,
	};
}

/*
Day of the week for a local calendar date, 0 = Sunday. Taken from UTC so the
result cannot be perturbed by a local-time transition at midnight.
*/
export function weekdayOf({year, month, day}: LocalFields): number {
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/*
True when `timeZone` names a zone Intl can resolve. Worth asking rather than
assuming: `Intl.DateTimeFormat().resolvedOptions().timeZone` is typed `string`
but returns `undefined` for an invalid `TZ`, and `'Etc/Unknown'` for an empty
one — and `'Etc/Unknown'` is an ICU invention that is not a tzdb name, so it
throws when handed back to Intl.
*/
export function isValidTimeZone(
	timeZone: string | undefined,
): timeZone is string {
	if (timeZone === undefined || timeZone === '') {
		return false;
	}

	try {
		formatterFor(timeZone);
		return true;
	} catch {
		return false;
	}
}

/*
Constructing an `Intl.DateTimeFormat` is not cheap and `bucketBoundaries` asks
for one on every step, so they are kept. The key set is bounded by the user's
own timezone plus whatever the tests name.
*/
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	const existing = formatters.get(timeZone);
	if (existing) {
		return existing;
	}

	const created = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});

	formatters.set(timeZone, created);
	return created;
}
