/*
The dashboard's record of the run that is happening now.

A fourth seam, and shaped like the third. `history.ts` reads what has already
been written, `telemetry.ts` reads what has been counted, and this reads what
the run has *done*: each Flush attempt with the counts it wrote, or that it
failed. All three are separate sources rather than modes of one, because they
are answers to different questions — and none of them is a database read the
caller has to wait on.

The read is synchronous here for the same reason it is in `telemetry.ts`: the
buffer is a field access away and there is nothing to await. That is a fact about
where the buffer lives rather than a promise about where it will, which is why
the view is handed a `RunLogSource` and not the class — a source that became
something to wait on changes here and in `use-run-log.ts`, and the view that asks
for entries never finds out.

Entries are appended by the composition root, which is also the only place that
knows a Flush happened at all — a Flush attempt is the one entry kind there is so
far. What a *view* gets is the `RunLogSource` face of this, which can read and
nothing else.

There is no file behind any of it. The Run Log holds the current run and is gone
when the CLI exits (CONTEXT.md, Deliberately absent).
*/

import {COUNT_FORMAT, METRES_FORMAT} from './format.js';
import {type FlushAttempt} from './session.js';

/*
The four kinds of thing a run can report. Only Flush entries exist so far; the
rest are the classes the shape was decided with, and the block draws the class
of an entry beside its text.
*/
export type RunLogClass = 'Flush' | 'Helper' | 'History' | 'Collection';

/*
Two texts rather than one, because a block that stays a fixed size has to cut
long lines and a log that cannot be read in full is a log that loses the one
line that mattered. `summary` is the single line the block shows, `detail` is
the whole of what happened, and both are composed where the entry is, so no view
has to decide what to truncate.
*/
export type RunLogEntry = {
	readonly at: Date;
	readonly class: RunLogClass;
	/*
	Draws the entry red. Absent rather than false on an entry that is fine, so
	an entry that went well cannot be told from one that never had a state.
	*/
	readonly failed?: true;
	readonly summary: string;
	readonly detail: string;
};

export type RunLogSource = {
	read(): readonly RunLogEntry[];
};

/*
Six entries: a few Flush Intervals' worth, small enough that the block stays a
fixed small part of the frame however long the run has been going.
*/
const CAP = 6;

export class InProcessRunLogSource implements RunLogSource {
	readonly #entries: RunLogEntry[] = [];

	append(entry: RunLogEntry): void {
		this.#entries.push(entry);

		if (this.#entries.length > CAP) {
			this.#entries.splice(0, this.#entries.length - CAP);
		}
	}

	/*
	A copy, so the buffer has exactly one author. A view handed the array itself
	could push onto the log it was reading, and the composition root would no
	longer be the only thing that knows what a run did.
	*/
	read(): readonly RunLogEntry[] {
		return [...this.#entries];
	}
}

/*
A Flush attempt as the log records it.

The counts are handed to the same formatters the totals above the block are
drawn with, so one number in a frame is spelled one way — `1,234` in the totals
and `1,234` in the line that says it was written. The three names around them are
CONTEXT.md's terms and are spelled here rather than borrowed from `totals-view`,
which this module cannot reach: `collect` appends entries too, and a seam that
imported a view would put ink on the headless path (ADR-0001).

A failure carries no counts, deliberately: nothing was written, and a line of
numbers beside "failed" would read as what landed. What it says instead is that
the same counters are coming back, because Telemetry State is cleared only after
a successful Flush (ADR-0009).
*/
export function flushEntry({at, ok, snapshot}: FlushAttempt): RunLogEntry {
	const counts = `Clicks ${COUNT_FORMAT.format(
		snapshot.leftClicks + snapshot.rightClicks,
	)} · Mouse Distance ${METRES_FORMAT.format(snapshot.movementMeters)} m · Press Total ${COUNT_FORMAT.format(
		snapshot.keysPressed,
	)}`;

	return ok
		? {at, class: 'Flush', summary: counts, detail: counts}
		: {
				at,
				class: 'Flush',
				failed: true,
				summary: 'failed — will retry',
				detail:
					'The counters are still in Telemetry State; the next Flush Interval writes them again.',
			};
}
