/*
The dashboard's record of the run that is happening now.

A seam of its own, shaped like the live view's. The Local Store's read face answers what
has already been written, `telemetry.ts` reads what has been counted, and this
reads what the run has *done*: each Flush attempt with the counts it wrote, or
that it failed; the problems the helper and the stream reading it reported; and
collection that started with no grant. All three are separate sources rather
than modes of one, because they are answers to different questions — and none
of them is a read the caller has to wait on.

The read is synchronous here for the same reason it is in `telemetry.ts`: the
buffer is a field access away and there is nothing to await. That is a fact about
where the buffer lives rather than a promise about where it will, which is why
the view is handed a `RunLogSource` and not the class — a source that became
something to wait on changes here and in `use-run-log.ts`, and the view that asks
for entries never finds out.

Entries are appended by the composition root, which is also the only place that
knows a Flush happened, or that the helper died, or that the grant was missing.
What a *view* gets is the `RunLogSource` face of this, which can read and
nothing else.

The constructors below are the other half of that: what each kind of thing is
spelled as once it is an entry. They live beside the buffer rather than at the
call site because the two texts are one decision — the line the block draws and
the text the diagnostics view draws — and a caller left to compose them would
eventually compose a second version.

There is no file behind any of it. The Run Log holds the current run and is gone
when the CLI exits (CONTEXT.md, Deliberately absent).
*/

import {COUNT_FORMAT, METRES_FORMAT} from './format.js';
import {problemMessage, type StreamProblem} from './capture/helper.js';
import {messageOf, type ReadWarning} from './store/local-store.js';
import {
	type DisabledCollector,
	type DisabledReport,
} from './capture/permissions.js';
import {type FlushAttempt} from './session.js';

/*
The kinds of thing a run can report: a Flush attempt, a problem the helper or
the stream reading it reported, a warning from the history read, a warning the
write seam raised while setting itself up, and collection that started
disabled. The block draws the class of an entry beside its text, which is what
tells a `Helper` line from a `Collection` one at a glance.

`Storage` is the write seam's own, and it is here rather than folded into
`Flush` because it is not one: the store raises it as it is built, before any
Flush has happened, and a line about a TTL index filed under a Flush would read
as something the write below it did.
*/
export type RunLogClass =
	'Flush' | 'Helper' | 'History' | 'Storage' | 'Collection';

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

/*
A problem the helper, or the stream reading it, reported.

The message is `helper.ts`'s own sentence for the problem — the one the stderr
reporter writes — because there is one spelling of "the capture helper exited"
and the terminal and the block both use it. It is the entry's full text, and its
summary is the same sentence drawn as a single line.

Failed, and so drawn red: an unreadable line, a helper that has gone, and the
helper's own error line are all statements that collection is not working.
*/
export function helperEntry(problem: StreamProblem, at: Date): RunLogEntry {
	const message = problemMessage(problem);

	return {
		at,
		class: 'Helper',
		failed: true,
		summary: oneLine(message),
		detail: message,
	};
}

/*
A read the history seam reported on.

Both texts are the seam's own sentence for the warning, for the reason
`helperEntry` borrows `problemMessage`: there is one spelling of what the driver
said — `messageOf`, which is also what the read answers a caller with — and a
view, a terminal and a log that each composed their own would be three
descriptions of one event.

It draws red, and there is no arm that does not: a read either answers or fails,
so a warning is a failure by definition. The whole of it is what the history view
points here for rather than drawing in place of the dashboard (#23, #30).
*/
export function historyEntry(warning: ReadWarning, at: Date): RunLogEntry {
	const detail = messageOf(warning.error);

	return {at, class: 'History', failed: true, summary: oneLine(detail), detail};
}

/*
A warning the write seam raised, as the log records it.

The store reports through a logger rather than as a return value — the one
thing on that side that is not a Flush is a TTL index it could not create — so
this is the entry the dashboard answers that logger with. A failed Flush never
arrives this way: `flush` returns `undefined` for one, and the attempt the
Session reports is what the log draws it from.

The extra arguments a logger call carried are kept in `detail`, where the
diagnostics view shows them: a driver's error is worth more than the one line
the message makes of it, and dropping it here would leave the driver's own
sentence nowhere at all.
*/
export function storageEntry(
	message: string,
	extra: readonly unknown[],
	at: Date,
): RunLogEntry {
	return {
		at,
		class: 'Storage',
		failed: true,
		summary: oneLine(message),
		detail: [message, ...extra.map(String)].join(' '),
	};
}

/*
The Collectors as they are named in a sentence. The preflight reports them
lowercase — `mouse`, `keyboard` are the names its notes are built from — and
these are those names as the start of a line.
*/
const COLLECTOR_NAMES: Record<DisabledCollector['collector'], string> = {
	mouse: 'Mouse',
	keyboard: 'Keyboard',
};

/*
A run that started with no grant, as the log records it.

One entry rather than one per Collector: the grant is one grant, and a missing
one is one thing that happened. It names the Collectors it took out — which is
what the live view's full report has no room to say — and the detail is the
preflight's own notes, which say where to change the setting.

Not failed, deliberately: CONTEXT.md's avoid-list for Collector Disabled names
"failed" and "errored" as the words for this state. The CLI is running, with
fewer Collectors, and the live view draws it as a note rather than as a fault.
*/
export function collectionEntry(report: DisabledReport, at: Date): RunLogEntry {
	const names = report.disabled
		.map(({collector}) => COLLECTOR_NAMES[collector])
		.join(' and ');

	return {
		at,
		class: 'Collection',
		summary: oneLine(
			`${names} collection is disabled: Input Monitoring is ${report.access}.`,
		),
		detail: report.disabled.map(({note}) => note).join('\n'),
	};
}

/*
A message as one line.

The block draws a summary on a single row under a fixed clock and class, so a
newline that came through the wire would break the frame's shape. Nothing is
dropped: the message is whole in `detail`, which is what the diagnostics view
draws, and the summary is the same words with the breaks taken out.
*/
function oneLine(message: string): string {
	return message.replaceAll(/\s+/gv, ' ').trim();
}
