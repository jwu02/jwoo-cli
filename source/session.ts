/*
The Collection Session: what runs while the CLI is collecting.

A plain module with `run()`/`stop()` that owns its own timer and its own
listeners and imports nothing from React, so moving collection to a separate
process later is a different entry point rather than a rewrite (ADR-0001). It
is not a component, and nothing here is named after a daemon or a service.

It owns the whole decision of when a Flush happens: on the Flush Interval, and
once more on the way out. The second one is the point — Ctrl-C and `kill` both
arrive as signals, and without a final Flush every counter accumulated since
the last interval is lost.

It owns the Push's timing too, and nothing else about it: a Drain is asked for
after a Flush that landed and once as the run starts, and never waited on from
the Flush path — a hanging Atlas must not delay the next local write, which is
the write that matters (ADR-0012). What a Drain found is the Pusher's to report,
and how much is still waiting for one is the store's: the count below is taken
on the way out, because the store is closed by the time anyone outside the run
could ask it.
*/

import process from 'node:process';
import {type Era} from './store/local-store.js';
import {type Snapshot, type TelemetryState} from './state.js';

/*
A Collector is started and stopped and nothing else, from here. What it does in
between — owning a capture process, holding listeners, contributing to Telemetry
State — is its own business (#7).
*/
export type Collector = {
	start(): void;
	stop(): void;
};

/*
The helper's event stream, as much of it as the Session needs: it starts and
stops, and nothing else is its business.

Narrow on purpose, and declared here rather than alongside the implementation
for the same reason `push.ts` declares its own slice of the driver — the
Session's job is owning a lifetime, and it should not need to know that there is
a child process at the other end of it. A test can hand it a stand-in without
spawning anything.
*/
export type EventStream = {
	start(): void;
	stop(): void;
};

/*
The Local Store, as the Session reaches for it: a Flush, the Push Backlog, and a
close.

Declared here rather than in `local-store.ts` for the reason the `EventStream`
above is: the Session's job is owning a lifetime, and a module names only what it
uses. A fake can stand in without a SQLite file behind it — which is the rule
ADR-0012 leaves in place, a fake for every seam above the store.

The Backlog is here rather than taken from the Pusher because it is a fact about
the store and not about a Drain: a run whose Pusher was never built still has
eras waiting, and a Drain that stopped at the first failure never saw most of
what is behind it. It is the eras rather than a count because that is the query
the store already answers — the one the Drains walk — and a second method
counting the same rows would be a second thing to keep in step with it.

No Promise anywhere on it. `node:sqlite` has no promise in it and the store
answers synchronously (ADR-0012), so saying otherwise here would be a pretence
the Session's whole write path then had to keep up — waiting on a write that
had already finished, and carrying machinery for an in-flight Flush that could
never exist. The async-ness rule is the same one the Pusher below is exempt
from, for the reason it is exempt: a round trip to a server really does take
time.
*/
export type FlushStore = {
	flush(snapshot: Snapshot): Date | undefined;
	backlog(): readonly Era[];
	close(): void;
};

/*
The Push, as the Session reaches for it: a Drain, and a close.

Narrow on purpose, as the `EventStream` is: the Session decides *when* a Drain is
asked for and knows nothing about MongoDB. The `Pusher` in `push.ts` is one
implementation of this and the only real one.
*/
export type Pusher = {
	drain(): Promise<void>;
	close(): Promise<void>;
};

/*
A Drain that failed is reported through its own attempt callback, so this is for
the promise itself failing — which the Session must not let reach a Flush path,
because it fires Drains without awaiting them and a rejection nobody holds ends
the process.
*/
async function settled(attempt: Promise<void>): Promise<void> {
	try {
		await attempt;
	} catch {
		// Reported where the Push seam reports: through its attempt callback.
	}
}

/*
What a shutdown looks like once it has finished, rather than the moment it
arrives: the signal that caused it, whether the counters made it to storage on
the way out, and how much of the Push Backlog is left for the next run.
`finalFlush` false means Telemetry State was still holding Activity when the
store was closed, so a caller can say so instead of claiming the run ended
cleanly.
*/
export type Shutdown = {
	readonly reason: 'signal' | 'stop';
	readonly signal: NodeJS.Signals | undefined;
	readonly finalFlush: boolean;
	/*
	How long the Push Backlog was when the store closed: a count rather than the
	eras, because what a caller does with it is say how much is waiting. Counted
	here because the store is the only thing that knows and it is about to be
	closed — and reported to the caller rather than acted on, because a Push that
	has not happened costs the website an era and never costs the CLI one.
	*/
	readonly backlogLength: number;
};

/*
The bare signal, as the OS delivers it — before anything has been flushed. A
separate type from `Shutdown` so the two cannot be confused: one is an event,
the other is the outcome of ending.
*/
export type ShutdownReason = {
	readonly signal: NodeJS.Signals;
};

/*
A Flush attempt, as an observer outside the Session sees it: when it was tried,
whether it wrote anything, and the counters it was holding.

`snapshot` is what was handed to storage, and it is the reason this exists. A
successful Flush clears Telemetry State, so a caller that wants the run's totals
— rather than just the current interval's — has to be told what was written as
it was written.
*/
export type FlushAttempt = {
	readonly at: Date;
	readonly ok: boolean;
	readonly snapshot: Snapshot;
};

/*
Shutdown arrives from a source rather than from `process.on` directly, so a test
can fire one without signalling the test runner — a real SIGTERM raised inside
the suite would take ava down on the way to its own assertion.
*/
export type ShutdownSignal = {
	onShutdown(listener: (shutdown: ShutdownReason) => void): () => void;
};

const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/*
The default source, and the only place a process signal is read.

A listener on either signal replaces Node's default disposition, so the process
survives long enough to Flush and exits when the event loop empties. While it is
installed, a second Ctrl-C is ignored: it lands on the same listener, whose run
has already been released, so the first signal is the one that ends the run.
*/
export const processSignal: ShutdownSignal = {
	onShutdown(listener) {
		const handlers = SIGNALS.map(signal => {
			const handler = (): void => {
				listener({signal});
			};

			process.on(signal, handler);
			return {signal, handler};
		});

		return () => {
			for (const {signal, handler} of handlers) {
				process.off(signal, handler);
			}
		};
	},
};

export type SessionOptions = {
	readonly store: FlushStore;
	readonly state: TelemetryState;
	/*
	Only the Collectors that are meant to run. One that cannot run because its
	grant is missing is a Collector that was never built — see `permissions.ts` —
	not one this Session has to know to skip.
	*/
	readonly collectors: readonly Collector[];
	/*
	Started alongside the Collectors and stopped alongside them, because the
	events have to be flowing before anything is listening and the capture
	process must not outlive the run.
	*/
	readonly stream?: EventStream;
	readonly flushIntervalSeconds: number;
	readonly shutdown: ShutdownSignal;
	/*
	Where the Flushed eras go from here. Absent is a run that never Pushes, which
	is what a test that is not about the Push wants — the composition root always
	supplies one (ADR-0012).
	*/
	readonly pusher?: Pusher;
	/*
	Called after every Flush attempt, successful or not.

	Not called when there was no Activity: no write was attempted, so there is
	nothing that happened and nothing for a view to draw. A Run Log line that
	moved on every idle interval would claim a write that never took place.
	*/
	readonly onFlush?: (attempt: FlushAttempt) => void;
};

/*
A long Flush Interval still has to hold the process open between Flushes, and a
pending timer that is not `unref`'d is not enough on its own. The signal
listeners do that job, which is why there is no keep-alive here.
*/
export class CollectionSession {
	readonly #store: FlushStore;
	readonly #state: TelemetryState;
	readonly #collectors: readonly Collector[];
	readonly #stream: EventStream | undefined;
	readonly #intervalMs: number;
	readonly #shutdown: ShutdownSignal;
	readonly #pusher: Pusher | undefined;
	readonly #onFlush: ((attempt: FlushAttempt) => void) | undefined;

	#timer: NodeJS.Timeout | undefined;
	/*
	Set by a signal and by `stop()`, because they are the same event arrived at
	two ways: whichever happens first wins, and the interval it may have
	interrupted does nothing further.
	*/
	#ended = false;
	#started = 0;
	#closed = false;
	#unsubscribe: (() => void) | undefined;
	/*
	Ends the wait in `#runUntilShutdown` when `stop()` is what ended the run.

	A signal is not the only way out. A dashboard quits on `q`, and the terminal
	is in raw mode, so no SIGINT is ever generated for that — the only thing that
	finds out is the caller that asked for the stop. Without this, `run()` would
	be left waiting for a signal that is never coming.
	*/
	#endRun: (() => void) | undefined;
	/*
	The Drain in flight, if any.

	Held because the last Drain on the way out has to be a fresh pass over the
	backlog, and a pass that merely joined a Drain already running would never
	look at the era the final Flush had just written. `stop()` waits this one out
	first, and then asks for another.
	*/
	#drainInFlight: Promise<void> | undefined;
	#finalFlush = false;
	/*
	What the last run of `stop()` counted, held for the same reason `#finalFlush`
	is: a second call has to answer with the first run's outcome rather than
	close a store that is already closed to find out.
	*/
	#backlogLength = 0;

	constructor(options: SessionOptions) {
		this.#store = options.store;
		this.#state = options.state;
		this.#collectors = options.collectors;
		this.#stream = options.stream;
		this.#intervalMs = options.flushIntervalSeconds * 1000;
		this.#shutdown = options.shutdown;
		this.#pusher = options.pusher;
		this.#onFlush = options.onFlush;
	}

	/*
	Asks for a Drain and holds the promise, never awaiting it: the Flush path and
	the start of a run both want the backlog moving and neither can afford to
	wait on MongoDB to find out that it did.

	A Pusher is single-flight, so a call that lands while one is already running
	joins it rather than starting a second pass over the same eras.
	*/
	async #startDrain(): Promise<void> {
		const pusher = this.#pusher;
		if (pusher === undefined) {
			return;
		}

		const attempt = settled(pusher.drain());
		this.#drainInFlight = attempt;
		return attempt;
	}

	/*
	`undefined` is a run that `stop()` ended rather than a signal, which is why
	the promise is not typed as a `ShutdownReason`: there is no signal to name,
	and inventing one would be a lie a caller could not tell from the truth.
	*/
	async #runUntilShutdown(): Promise<Shutdown> {
		const reason = await new Promise<ShutdownReason | undefined>(resolve => {
			this.#unsubscribe = this.#shutdown.onShutdown(resolve);
			this.#endRun = () => {
				resolve(undefined);
			};

			this.#scheduleFlush();
		});

		// Released after the run rather than from inside the handler that fired,
		// so a second signal cannot cut the Flush below short.
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#endRun = undefined;

		const {finalFlush, backlogLength} = await this.stop();

		return reason === undefined
			? {reason: 'stop', signal: undefined, finalFlush, backlogLength}
			: {reason: 'signal', signal: reason.signal, finalFlush, backlogLength};
	}

	#scheduleFlush(): void {
		this.#timer = setTimeout(() => {
			this.#flushAndReschedule();
		}, this.#intervalMs);
	}

	/*
	Rescheduled after the Flush rather than on a `setInterval`, so the next
	interval is counted from the end of the last write rather than from its
	start. Two Flushes cannot overlap whatever this does: the write is
	synchronous.

	Both `#ended` checks earn their place. The first drops a callback that was
	already queued when `stop()` cleared the timer; the second drops the
	reschedule when the run ended while the Flush was being taken, which only the
	Flush's own observer can bring about — the call above cannot be interrupted,
	so nothing else can happen in between.
	*/
	#flushAndReschedule(): void {
		if (this.#ended) {
			return;
		}

		this.#flush();

		if (!this.#ended) {
			this.#scheduleFlush();
		}
	}

	/*
	Activity decides whether a Flush is attempted at all. A failed Flush leaves
	Telemetry State whole, so the same Snapshot is retried on the next interval —
	the rule the Local Store's write face states, applied here.

	A failure is warned about by nobody here: the attempt below is the one thing
	that says it happened, and whoever wants it said reaches for that. A warning
	written here as well would be a second report of one failure, in a place
	that cannot know whether there is a frame on screen to draw it in
	(ADR-0010).

	It answers with a plain boolean rather than a promise, as the store does: a
	Flush that has returned has landed or it has failed, and there is no third
	state for a caller to wait in.
	*/
	#flush(): boolean {
		if (!this.#state.hasActivity()) {
			// Nothing to write is not a failure. The final Flush reports on
			// counters left behind, and there are none.
			return true;
		}

		const snapshot: Snapshot = this.#state.snapshot();
		const result = this.#store.flush(snapshot);
		const isWritten = result !== undefined;

		if (isWritten) {
			this.#state.clear();
		}

		/*
		Reported last, and after the clear rather than before it, so an observer
		that adds this Snapshot to a running total is never in a position to
		count it twice: on success Telemetry State no longer holds it, and on
		failure the observer is told not to add it at all.
		*/
		this.#onFlush?.({at: new Date(), ok: isWritten, snapshot});

		/*
		Only after a Flush that landed: a failed one left its era unwritten, so
		there is nothing new for a Drain to carry, and the backlog it would walk is
		the one the last Drain already walked.

		Not awaited, and that is the whole of ADR-0012's Flush rule: the write that
		matters has already happened, and an Atlas that has gone away must not delay
		the next one.
		*/
		if (isWritten) {
			void this.#startDrain();
		}

		return isWritten;
	}

	/*
	Runs until a signal arrives or `stop()` is called, then shuts down. The
	returned promise resolves only once the final Flush, the last Drain attempt
	and the closes have finished, so `await`ing it is a complete shutdown and not
	merely the start of one — whichever of the two ended it.

	The signal listeners are installed before the promise can resolve, so a
	caller that waits cannot miss one. They are also removed *after* the run has
	ended rather than inside their own handler, so the whole of `stop()` — the
	Flush included — happens with the default disposition still replaced. A
	second signal arriving mid-Flush is therefore ignored rather than cutting the
	Flush short, which is the one thing this must not do.
	*/
	async run(): Promise<Shutdown> {
		try {
			/*
			The stream first, so the helper is already producing by the time a
			Collector is listening. Starting it the other way round would drop
			whatever arrived in between, and losing input is the one thing a
			Collector must not do quietly.
			*/
			this.#stream?.start();

			for (const collector of this.#collectors) {
				collector.start();
				this.#started += 1;
			}

			/*
			The startup backlog, fired once and not waited on. A machine that was
			offline for the last few intervals has eras sitting in the Local Store
			and no reason to wait an interval to try them again — and a Drain that
			has to fail does so under a run that is already collecting rather than
			in front of a frame that is not up yet.
			*/
			void this.#startDrain();
		} catch (error: unknown) {
			// Stops the Collectors that did start, closes the store, and lets the
			// broken install reach the caller.
			await this.stop();
			throw error;
		}

		return this.#runUntilShutdown();
	}

	/*
	Ends the run: a signal, a failed Collector and a caller that wants it over
	all arrive here, and it is also what releases the promise `run()` handed
	back.

	Idempotent, because more than one of those can happen at once, and a second
	Flush of the same interval would write it twice. Returns the first run's
	outcome on a second call, which is why the signal is missing from it: after
	a SIGTERM, only `run()` can say which signal it was.

	The order on the way out is the whole of it: the Drain in flight, the final
	Flush, one last Drain attempt — awaited, because it is the last — then the
	store and then the Mongo client. The store closes after the Drain because the
	Drain reads it, and the client after the store because that is the order they
	were opened in (ADR-0012).

	There is no in-flight Flush to wait for on the way in, and that is not an
	omission: a Flush is a synchronous write, so an interval's has already landed
	— or already failed — by the time anything can ask the run to end, and an
	interval that was mid-write could not have been interrupted in the first
	place. The final Flush below therefore cannot double-count what an interval
	wrote, which is the bug the wait used to be here for.
	*/
	async stop(): Promise<Shutdown> {
		if (this.#ended) {
			return {
				reason: 'stop',
				signal: undefined,
				finalFlush: this.#finalFlush,
				backlogLength: this.#backlogLength,
			};
		}

		this.#ended = true;
		clearTimeout(this.#timer);

		/*
		The stream is closed before the Collectors, in the reverse of the order it
		was opened in. Nothing is then still being produced while the final Flush
		takes its Snapshot, so the last interval's counts are whole rather than
		taken mid-arrival.

		Not conditional on any Collector having started: the stream is started
		before them for exactly that reason, so a Collector that threw on the way
		up still leaves a helper running if this is skipped.
		*/
		this.#stream?.stop();

		// Only the Collectors that actually started, so a Collector that threw on
		// the way up is not stopped as though it were running.
		for (const collector of this.#collectors.slice(0, this.#started)) {
			collector.stop();
		}

		/*
		The Drain in flight is waited out before the final Flush, so that the Drain
		the final Flush asks for is a fresh pass rather than a join. A pass that
		merely joined the one already running would have read the backlog before the
		era below existed, and that era would sit unpushed until the next run.

		Waited, but not depended on: it is already swallowed, and the Flush below
		is the write this whole shutdown exists for.
		*/
		if (this.#drainInFlight !== undefined) {
			await this.#drainInFlight;
		}

		this.#finalFlush = this.#flush();

		/*
		One last Drain, awaited, before the store closes — the store closes after
		the Drain because the Drain reads it. Asked for rather than handed the one
		the final Flush may have started: a Flush that failed started none, and a
		backlog left over from earlier intervals still deserves the attempt.
		*/
		await this.#startDrain();

		/*
		Counted here, after the last Drain has had its say and while the store is
		still open to answer: a Drain acknowledges the eras it carried, so counting
		before it would report ground that has just been made up. This is the one
		reading of the store the Session takes that is not a Flush, and it is taken
		rather than left to the caller because the close below is the last moment it
		can be — `backlog()` on a closed store is a driver error, not an answer.
		*/
		this.#backlogLength = this.#store.backlog().length;

		/*
		Called at most once, because a Flush that threw leaves the store unclosed
		and closing it is still the right thing to do on a second call.
		*/
		if (!this.#closed) {
			this.#closed = true;
			this.#store.close();
		}

		/*
		The Mongo client goes last, after the store, because the Drain that just
		finished was reading the one and writing through the other.
		*/
		const pusher = this.#pusher;
		if (pusher !== undefined) {
			await pusher.close();
		}

		/*
		Last, so that whoever is awaiting `run()` is released with the same
		complete shutdown `stop()` hands back — the final Flush written and the
		store closed — rather than partway through one.
		*/
		this.#endRun?.();

		return {
			reason: 'stop',
			signal: undefined,
			finalFlush: this.#finalFlush,
			backlogLength: this.#backlogLength,
		};
	}
}
