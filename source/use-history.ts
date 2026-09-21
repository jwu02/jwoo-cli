/*
Loading history, as a state machine.

Three states rather than a value and a flag, because the view has to tell
"nothing yet" from "nothing there" from "could not ask" — and the three look
completely different on screen.

The `isCancelled` flag in the effect is the reason this is a module rather than
three lines in the component. Switching range leaves the previous load in
flight, and the network decides which comes back first; without the flag an
older response can land last and be drawn under the newer range's heading.

Loading is *derived* rather than set. An effect that calls `setState` on every
run costs an extra render pass before anything can be drawn, and React's own
lint rules flag it. Remembering which range an answer belongs to and comparing
is both cheaper and more honest: an answer for another range is not an answer
to this one.
*/

import {useEffect, useState} from 'react';
import {type HistoryData, type HistorySource} from './history.js';
import {type Range} from './ranges.js';

export type LoadState =
	| {status: 'loading'}
	| {status: 'ready'; data: HistoryData}
	| {status: 'error'; message: string};

type Settled = {
	readonly range: Range;
	readonly state: LoadState;
};

export function useHistory(source: HistorySource, range: Range): LoadState {
	const [settled, setSettled] = useState<Settled | undefined>(undefined);

	useEffect(() => {
		let isCancelled = false;

		/*
		No `catch`, deliberately. `load` resolves with a failure rather than
		rejecting, so there is nothing to catch — and adding one would hide the
		contract being broken. `source` must be referentially stable: building
		one inside a component body re-runs this effect on every render.
		*/
		void source.load(range, new Date()).then(result => {
			if (isCancelled) {
				return;
			}

			setSettled({
				range,
				state: result.ok
					? {status: 'ready', data: result.data}
					: {status: 'error', message: result.message},
			});
		});

		return () => {
			isCancelled = true;
		};
	}, [source, range]);

	// An answer that arrived for a range since left behind reads as loading,
	// rather than being drawn under the current range's heading.
	return settled?.range === range ? settled.state : {status: 'loading'};
}
