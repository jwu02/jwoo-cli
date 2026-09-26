/*
The Run Log, polled.

`RunLogSource.read()` is synchronous — the entries are a field access away — so
there is nothing to await and nothing to cancel. The hook is a timer that
re-renders and a reading taken on the way past; `run-log-view.tsx` is handed the
result and draws it.

The reading is taken *during* render rather than stored in state by the timer,
for the reason `use-telemetry.ts` gives: the entries drawn are the source's
current ones rather than the last ones a tick happened to catch, so a render for
any other reason — a key press, a resize — refreshes them too.

Entries are appended by the composition root while the dashboard is up, which is
what makes a poll the only way to see them: nothing in the frame causes one.

A deliberate mirror of `use-telemetry.ts` rather than a poll both share. The two
sources are separate seams and will stop looking alike the moment either read
becomes something to wait on, and this is the module that change lands in — a
shared poll would have to be unpicked first.

`intervalMs` exists because a test cannot wait a second per assertion. It is the
same allowance `SessionOptions.flushIntervalSeconds` and `use-telemetry.ts`'s own
option are, and the only reason this hook takes options at all.
*/

import {useEffect, useState} from 'react';
import {type RunLogEntry, type RunLogSource} from '../run-log.js';

/*
A second: fast enough that a Flush landing mid-interval shows up while the user
is still looking at the screen, slow enough that an idle dashboard is not
redrawing a terminal sixty times a second.
*/
const POLL_INTERVAL_MS = 1000;

export type UseRunLogOptions = {
	readonly intervalMs?: number;
};

export function useRunLog(
	source: RunLogSource,
	{intervalMs = POLL_INTERVAL_MS}: UseRunLogOptions = {},
): readonly RunLogEntry[] {
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
