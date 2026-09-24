/*
How numbers become text, for both views.

Two views draw the same quantities — Clicks, Mouse Distance, Press Total — and
the same clock fields, so the spellings live here rather than in each. Two
copies of "metres to one decimal place" would eventually disagree, and a
dashboard showing a distance rounded one way and a total rounded another is a
bug nobody would think to look for.

The locale is pinned rather than taken from the machine, so the tests assert the
same digits everywhere.
*/

import {localFields} from './local-time.js';

export const COUNT_FORMAT = new Intl.NumberFormat('en-GB');

export const METRES_FORMAT = new Intl.NumberFormat('en-GB', {
	maximumFractionDigits: 1,
});

/*
An hour, minute or second as it is drawn. Not `padStart` at each call site: a
clock reading of `9:5:3` is the kind of thing that only shows up in a screenshot.
*/
export function twoDigits(value: number): string {
	return String(value).padStart(2, '0');
}

/*
An instant as a local clock reading, to the second.

One spelling, because the live view's flush line and a Run Log entry are
answering the same question about the same event — *when* — and a frame that said
`11:00:00` in one place and `11:00` in the other would look like two different
times. The zone is a parameter for the reason `local-time.ts` gives: the tests
assert the same digits everywhere.
*/
export function clockTime(at: Date, timeZone: string): string {
	const {hour, minute, second} = localFields(at, timeZone);

	return [hour, minute, second].map(value => twoDigits(value)).join(':');
}

/*
The column a clock reading is drawn in: "11:00:00", and a gap after it. Beside
`clockTime` rather than in a view because two views draw one, and the class
beside it — which is what the width is for, rather than the reading itself —
has to start at the same offset in both. A time that pushed the same class
further along in the block than in diagnostics would read as a wider clock.
*/
export const CLOCK_WIDTH = 10;
