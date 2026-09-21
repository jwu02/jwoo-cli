/*
The landing view: history, read from MongoDB Atlas.

`source` arrives as a prop rather than being built here, and that is
load-bearing rather than stylistic. Constructing one in the component body
gives it a new identity on every render, and the load effect is keyed on it —
so the view would reload forever. The composition root in `cli.tsx` owns it.

The range lives here rather than in the view because switching it is input,
and the view is presentational.
*/

import {Box, Text, useApp, useInput} from 'ink';
import {useState} from 'react';
import {HistoryView} from './history-view.js';
import {type HistorySource} from './history.js';
import {type Range} from './ranges.js';
import {useHistory} from './use-history.js';

export default function App({source}: {source: HistorySource}) {
	const [range, setRange] = useState<Range>('today');
	const {exit} = useApp();
	const state = useHistory(source, range);

	useInput(input => {
		switch (input) {
			case 'q': {
				exit();
				break;
			}

			case 't': {
				setRange('today');
				break;
			}

			case 'w': {
				setRange('week');
				break;
			}

			default:
		}
	});

	return (
		<Box flexDirection="column">
			<HistoryView state={state} range={range} />
			<Box marginTop={1}>
				<Text dimColor>t today · w this week · q quit</Text>
			</Box>
		</Box>
	);
}
