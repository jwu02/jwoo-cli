/*
The Run Log, drawn.

Presentational only, as `live-view.tsx` and `history-view.tsx` are: it takes the
entries and a zone and returns a frame. No effects, nothing to await and no
source — every test of this module is a synchronous render of a fixed list,
which is why the polling lives in `use-run-log.ts`.

The block is always on screen, under whichever view is above it. It is where a
problem is visible from the landing view, which is the history view and knows
nothing about the run: a Flush can fail on every interval of a session with
nothing on that view to say so.

The vocabulary is CONTEXT.md's. The counts in an entry are the counts the totals
block above draws, spelled by the same formatters, so one number reads one way
in a frame. An entry's `summary` is the single line shown here; the full text is
the diagnostics view's (#22), and this module never draws it.
*/

import {Box, Text} from 'ink';
import {CLOCK_WIDTH, clockTime} from './format.js';
import {type RunLogEntry} from './run-log.js';

// "Collection", the longest of the classes, and a gap after it.
const CLASS_WIDTH = 11;

export function RunLogView({
	entries,
	timeZone,
}: {
	entries: readonly RunLogEntry[];
	timeZone: string;
}) {
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold>Run Log</Text>
			{/*
			An empty log is a state rather than a bug: the run has nothing to
			report yet, and a block with a heading and no lines under it would
			read as a block that failed to draw.
			*/}
			{entries.length === 0 ? (
				<Text dimColor>Nothing yet.</Text>
			) : (
				entries.map((entry, index) => (
					/*
					The index is part of the key because two entries can share a
					second — a Flush and the problem that followed it — and the list
					is rebuilt on every poll rather than mutated.
					*/
					<Line
						key={`${entry.at.toISOString()}#${index}`}
						entry={entry}
						timeZone={timeZone}
					/>
				))
			)}
		</Box>
	);
}

function Line({entry, timeZone}: {entry: RunLogEntry; timeZone: string}) {
	return (
		<Box>
			<Box width={CLOCK_WIDTH}>
				<Text dimColor>{clockTime(entry.at, timeZone)}</Text>
			</Box>
			<Box width={CLASS_WIDTH}>
				<Text dimColor>{entry.class}</Text>
			</Box>
			<Text color={entry.failed === true ? 'red' : undefined}>
				{entry.summary}
			</Text>
		</Box>
	);
}
