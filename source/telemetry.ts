/*
The live view's seam: the counters for the run that is happening now.

The Local Store's read face answers what has already been written. This answers
what has not been, out of the accumulator in this process — and it is a separate
source rather than a mode of that one, because they are answers to different
questions. Today's totals and this run's totals share no numbers at all for the
first five minutes and every number after it.

The read is synchronous, which is honest rather than convenient: Telemetry State
is a field access away and there is nothing to wait for. Moving collection to a
separate process makes this a socket and the read a promise, and that change
lands here and in `use-telemetry.ts` — the pair the seam exists to confine it to
— rather than in the view, which asks a `TelemetrySource` and does not know what
is behind it.

The grant belongs to the reading rather than to the view. "Nothing has arrived
yet" and "nothing is being collected" are identical in the counters and are not
the same thing at all, so a view given only the numbers cannot tell them apart —
and telling them apart is the whole of what a live view owes a user who has just
granted a permission and wants to know whether it took.

`Totals` is borrowed from `local-store.ts` rather than declared again here. The two
seams ask different questions and answer with the same four numbers, and the
view draws them with the same code — a second declaration would be a second
spelling of Clicks, Mouse Distance and Press Total.
*/

import {type Totals} from './local-store.js';
import {type PermissionReport} from './permissions.js';
import {type FlushAttempt} from './session.js';
import {type Snapshot, type TelemetryState} from './state.js';

/*
Two states rather than totals plus an `enabled` flag: a machine with no grant
produces counters that are zero in exactly the way a machine nobody has touched
does, and the user who has just granted the permission is the one who cannot
tell them apart. So the reading says which of the two it is rather than leaving
a view to infer it from an `enabled` bit beside the same zeroes.
*/
export type LiveTelemetry =
	| {
			readonly status: 'collecting';
			readonly totals: Totals;
	  }
	| {readonly status: 'disabled'; readonly message: string};

export type TelemetrySource = {
	read(): LiveTelemetry;
};

export type InProcessTelemetrySourceOptions = {
	readonly report: PermissionReport;
	readonly state: TelemetryState;
};

const ZERO: Totals = {
	leftClicks: 0,
	rightClicks: 0,
	movementMeters: 0,
	pressTotal: 0,
};

/*
The four numbers the view draws, taken out of a Snapshot. Key Counts stay behind
deliberately: this is a running tally for the run in progress, not a Key
Ranking, and a ranking of five minutes of typing is not a ranking worth reading.
*/
function totalsOf(snapshot: Snapshot): Totals {
	return {
		leftClicks: snapshot.leftClicks,
		rightClicks: snapshot.rightClicks,
		movementMeters: snapshot.movementMeters,
		pressTotal: snapshot.keysPressed,
	};
}

function plus(a: Totals, b: Totals): Totals {
	return {
		leftClicks: a.leftClicks + b.leftClicks,
		rightClicks: a.rightClicks + b.rightClicks,
		movementMeters: a.movementMeters + b.movementMeters,
		pressTotal: a.pressTotal + b.pressTotal,
	};
}

export class InProcessTelemetrySource implements TelemetrySource {
	readonly #report: PermissionReport;
	readonly #state: TelemetryState;
	/*
	What earlier Flushes have already written during this run. Telemetry State
	holds only what they have not: a successful Flush clears it, so a view
	reading the accumulator alone would watch every counter fall back to zero at
	the Flush Interval and call that live.
	*/
	#flushed: Totals = ZERO;

	constructor({report, state}: InProcessTelemetrySourceOptions) {
		this.#report = report;
		this.#state = state;
	}

	/*
	Told rather than asked. Only the Session knows whether a Flush reached
	storage, and the distinction decides whether these counters may be added to
	the running total: a failed Flush leaves Telemetry State whole, so adding
	them here as well would count the same presses twice.

	The attempt's `at` is not read: *when* a Flush happened is the Run Log's to
	report, and this seam is only asked what the counters now stand at.
	*/
	recordFlush({ok, snapshot}: FlushAttempt): void {
		if (ok) {
			this.#flushed = plus(this.#flushed, totalsOf(snapshot));
		}
	}

	read(): LiveTelemetry {
		if (this.#report.status !== 'granted') {
			/*
			The helper's own sentence, which names the grant and where to change
			it. Composed there rather than here because `collect` prints the same
			one, and two spellings of "grant Input Monitoring" would eventually
			disagree about where the setting lives.
			*/
			return {status: 'disabled', message: this.#report.message};
		}

		/*
		State plus what has been flushed: the count since the CLI started, which
		is what the view promises, rather than the count since the last Flush
		Interval, which is what the accumulator holds.
		*/
		return {
			status: 'collecting',
			totals: plus(this.#flushed, totalsOf(this.#state.snapshot())),
		};
	}
}
