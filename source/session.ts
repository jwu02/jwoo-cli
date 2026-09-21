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
*/

import process from 'node:process';
import {type TelemetryStore} from './storage.js';
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
What a shutdown looks like once it has finished, rather than the moment it
arrives: the signal that caused it, and whether the counters made it to storage
on the way out. `finalFlush` false means Telemetry State was still holding
Activity when the store was closed, so a caller can say so instead of claiming
the run ended cleanly.
*/
export type Shutdown = {
	readonly reason: 'signal' | 'stop';
	readonly signal: NodeJS.Signals | undefined;
	readonly finalFlush: boolean;
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
survives long enough to Flush and exits when the event loop empties. Installing
a second listener after the first is ignored, which is deliberate: a second
Ctrl-C while a Flush is in flight must not cut it short.
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
	readonly store: TelemetryStore;
	readonly state: TelemetryState;
	/*
	Only the Collectors that are meant to run. One that cannot run because its
	grant is missing is a Collector that was never built — see `permissions.ts` —
	not one this Session has to know to skip.
	*/
	readonly collectors: readonly Collector[];
	readonly flushIntervalSeconds: number;
	readonly shutdown: ShutdownSignal;
	readonly logger?: Pick<Console, 'warn'>;
};

/*
A long Flush Interval still has to hold the process open between Flushes, and a
pending timer that is not `unref`'d is not enough on its own. The signal
listeners do that job, which is why there is no keep-alive here.
*/
export class CollectionSession {
	readonly #store: TelemetryStore;
	readonly #state: TelemetryState;
	readonly #collectors: readonly Collector[];
	readonly #intervalMs: number;
	readonly #shutdown: ShutdownSignal;
	readonly #logger: Pick<Console, 'warn'>;

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
	The Flush in flight, if any. Telemetry State is cleared only after a
	successful write, so a Flush that is still waiting on the database has *not*
	cleared it — and a final Flush started alongside it would snapshot the same
	counters and insert them a second time. The final Flush therefore waits for
	this one, and then finds either cleared state or the retry it owes.
	*/
	#inFlight: Promise<unknown> | undefined;
	#finalFlush = false;

	constructor(options: SessionOptions) {
		this.#store = options.store;
		this.#state = options.state;
		this.#collectors = options.collectors;
		this.#intervalMs = options.flushIntervalSeconds * 1000;
		this.#shutdown = options.shutdown;
		this.#logger = options.logger ?? console;
	}

	async #runUntilShutdown(): Promise<Shutdown> {
		const reason = await new Promise<ShutdownReason>(resolve => {
			this.#unsubscribe = this.#shutdown.onShutdown(resolve);
			this.#scheduleFlush();
		});

		// Released after the run rather than from inside the handler that fired,
		// so a second signal cannot cut the Flush below short.
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;

		const {finalFlush} = await this.stop();
		return {reason: 'signal', signal: reason.signal, finalFlush};
	}

	#scheduleFlush(): void {
		this.#timer = setTimeout(() => {
			this.#inFlight = this.#flushAndReschedule();
		}, this.#intervalMs);
	}

	/*
	Rescheduled after the Flush rather than on a `setInterval`, so a slow Flush
	— a database that has gone away, say — cannot overlap with the next one.
	*/
	async #flushAndReschedule(): Promise<void> {
		if (this.#ended) {
			return;
		}

		await this.#flush();

		if (!this.#ended) {
			this.#scheduleFlush();
		}
	}

	/*
	Activity decides whether a Flush is attempted at all. A failed Flush is a
	warning and Telemetry State is left whole, so the same Snapshot is retried on
	the next interval — the rule from `storage.ts`, applied here.
	*/
	async #flush(): Promise<boolean> {
		if (!this.#state.hasActivity()) {
			// Nothing to write is not a failure. The final Flush reports on
			// counters left behind, and there are none.
			return true;
		}

		const snapshot: Snapshot = this.#state.snapshot();
		const result = await this.#store.flush(snapshot);

		if (result === undefined) {
			this.#logger.warn('Flush failed; counters will retry on the next Flush');
			return false;
		}

		this.#state.clear();
		return true;
	}

	/*
	Runs until a signal arrives, then shuts down. The returned promise resolves
	only once the final Flush and the close have finished, so `await`ing it is a
	complete shutdown and not merely the start of one.

	The signal listeners are installed before the promise can resolve, so a
	caller that waits cannot miss one. They are also removed *after* the run has
	ended rather than inside their own handler, so the whole of `stop()` — the
	Flush included — happens with the default disposition still replaced. A
	second signal arriving mid-Flush is therefore ignored rather than cutting the
	Flush short, which is the one thing this must not do.
	*/
	async run(): Promise<Shutdown> {
		try {
			for (const collector of this.#collectors) {
				collector.start();
				this.#started += 1;
			}
		} catch (error: unknown) {
			// Stops the Collectors that did start, closes the store, and lets the
			// broken install reach the caller.
			await this.stop();
			throw error;
		}

		return this.#runUntilShutdown();
	}

	/*
	Idempotent, because a signal and a failed Collector can both bring the run
	down, and a second Flush of the same interval would write it twice. Returns
	the first run's outcome on a second call.
	*/
	async stop(): Promise<Shutdown> {
		if (this.#ended) {
			return {
				reason: 'stop',
				signal: undefined,
				finalFlush: this.#finalFlush,
			};
		}

		this.#ended = true;
		clearTimeout(this.#timer);

		// Only the Collectors that actually started, so a Collector that threw on
		// the way up is not stopped as though it were running.
		for (const collector of this.#collectors.slice(0, this.#started)) {
			collector.stop();
		}

		/*
		Whatever the interval was already writing has to land first, or the Flush
		below snapshots the same uncleared Telemetry State and writes it twice.

		Swallowed rather than awaited bare: a rejected Flush is already warned
		about, and letting it out here would replace the error that actually
		brought the run down — a Collector that could not start — with its own.
		*/
		await this.#inFlight?.catch(() => undefined);

		this.#finalFlush = await this.#flush();

		/*
		Called at most once, because a Flush that threw leaves the store unclosed
		and closing it is still the right thing to do on a second call.
		*/
		if (!this.#closed) {
			this.#closed = true;
			await this.#store.close();
		}

		return {reason: 'stop', signal: undefined, finalFlush: this.#finalFlush};
	}
}
