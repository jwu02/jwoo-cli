/*
The dashboard: two views of the same collection, and the keys that switch
between them.

History is the landing view because it is the one that works before anything has
been collected — reading it needs the database and nothing else. The live view
is the second view: what this run has seen so far, which is empty by definition
for the first few seconds.

Both sources arrive as props rather than being built here, and that is
load-bearing rather than stylistic. Constructing one in the component body gives
it a new identity on every render, and the load effect is keyed on it — so the
view would reload forever. The composition root in `main.tsx` owns them.

The range lives here rather than in the view because switching it is input, and
the views are presentational.
*/

import {Box, Text, useApp, useInput} from 'ink';
import {useState} from 'react';
import {HistoryView} from './history-view.js';
import {type HistorySource} from './history.js';
import {LiveView} from './live-view.js';
import {type Range} from './ranges.js';
import {type TelemetrySource} from './telemetry.js';
import {useHistory} from './use-history.js';
import {useTelemetry} from './use-telemetry.js';

export type AppProps = {
	readonly history: HistorySource;
	readonly telemetry: TelemetrySource;
	readonly timeZone: string;
};

export default function App({history, telemetry, timeZone}: AppProps) {
	const [range, setRange] = useState<Range>('today');
	const [isLive, setIsLive] = useState(false);
	const {exit} = useApp();
	const state = useHistory(history, range);

	useInput(input => {
		switch (input) {
			case 'q': {
				exit();
				break;
			}

			case 'l': {
				setIsLive(true);
				break;
			}

			/*
			A range key is also the way back from the live view: there is no key
			that means "the other one", because a key that toggles would leave the
			range behind it ambiguous.
			*/
			case 't': {
				setRange('today');
				setIsLive(false);
				break;
			}

			case 'w': {
				setRange('week');
				setIsLive(false);
				break;
			}

			default:
		}
	});

	return (
		<Box flexDirection="column">
			{isLive ? (
				<Live source={telemetry} timeZone={timeZone} />
			) : (
				<HistoryView state={state} range={range} />
			)}
			<Box marginTop={1}>
				<Text dimColor>t today · w this week · l live · q quit</Text>
			</Box>
		</Box>
	);
}

/*
The polling is mounted with the view rather than held in `App`, so the history
view — which has nothing live in it — does not redraw once a second for no
reason. A component's effects begin when it mounts and a hook cannot be called
conditionally, so the two ways of drawing the live view are two components.
*/
function Live({source, timeZone}: {source: TelemetrySource; timeZone: string}) {
	return <LiveView telemetry={useTelemetry(source)} timeZone={timeZone} />;
}
