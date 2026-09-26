/*
The live counters, polled.

`TelemetrySource.read()` is synchronous — Telemetry State is a field access away
— so there is nothing to await and nothing to cancel. The hook is a timer that
re-renders and a reading taken on the way past; `live-view.tsx` is handed the
result and draws it.

The reading is taken *during* render rather than stored in state by the timer.
The two are equivalent for a value that only ever moves forward, and this way
the numbers are the accumulator's current ones rather than the last ones a tick
happened to catch — so a render for any other reason, a key press or a resize,
also refreshes them. `read()` is a pure read of a mutable field, which is what
makes calling it during render legitimate.

`intervalMs` exists because a test cannot wait a second per assertion. It is the
same allowance as `SessionOptions.flushIntervalSeconds`, and the only reason
this hook takes options at all.

When collection moves to a separate process, `read()` becomes a promise and this
module becomes the one that awaits it — and the view does not change, which is
the seam doing its job.
*/

import {useEffect, useState} from 'react';
import {type LiveTelemetry, type TelemetrySource} from '../telemetry.js';

/*
A second: fast enough that a Flush landing mid-interval shows up while the user
is still looking at the screen, slow enough that an idle dashboard is not
redrawing a terminal sixty times a second.
*/
const POLL_INTERVAL_MS = 1000;

export type UseTelemetryOptions = {
	readonly intervalMs?: number;
};

export function useTelemetry(
	source: TelemetrySource,
	{intervalMs = POLL_INTERVAL_MS}: UseTelemetryOptions = {},
): LiveTelemetry {
	// Only ever incremented: the timer's whole job is to force the render that
	// re-reads the source.
	const [, setTick] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setTick(tick => tick + 1);
		}, intervalMs);

		return () => {
			clearInterval(timer);
		};
	}, [intervalMs]);

	return source.read();
}
