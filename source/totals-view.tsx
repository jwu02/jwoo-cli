/*
The Totals block, drawn: Clicks, Mouse Distance, Press Total.

Both views open with these three lines — the history view's for a Range, the
live view's for the run in progress — and they are the same three lines. Only
the heading above them says which is which, so a difference between the two
would not be a difference of meaning; it would be a bug.

The vocabulary is CONTEXT.md's. Press Total and Mouse Distance are terms rather
than descriptions, and neither is abbreviated to fit the label column.
*/

import {Box, Text} from 'ink';
import {COUNT_FORMAT, METRES_FORMAT} from './format.js';
import {type Totals} from './history.js';

// Wide enough for "Mouse Distance", the longest label, with a gap after it.
const LABEL_WIDTH = 16;

export function TotalsView({totals}: {totals: Totals}) {
	return (
		<Box flexDirection="column" marginTop={1}>
			<Row
				label="Clicks"
				value={COUNT_FORMAT.format(totals.leftClicks + totals.rightClicks)}
			/>
			<Row
				label="Mouse Distance"
				value={`${METRES_FORMAT.format(totals.movementMeters)} m`}
			/>
			<Row label="Press Total" value={COUNT_FORMAT.format(totals.pressTotal)} />
		</Box>
	);
}

function Row({label, value}: {label: string; value: string}) {
	return (
		<Box>
			<Box width={LABEL_WIDTH}>
				<Text>{label}</Text>
			</Box>
			<Text bold>{value}</Text>
		</Box>
	);
}
