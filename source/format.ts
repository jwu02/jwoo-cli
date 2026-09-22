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
