/*
The Run Log, whole.

The block under the other views is the log at a fixed size: one line an entry,
in a column beside its second and its class, which is what lets it sit under any
view for the length of a run. This is the same entries with nothing cut and no
column to fit into — each drawn as its second, its class, its summary, and the
full text the block has no room for. Both texts are composed where the entry is
made (`run-log.ts`), so what is drawn here is what the entry holds rather than
this view's idea of it, and the two can never disagree.

It reads the same source the block does, and never draws at the same time as it:
one frame holding the same six entries twice, once cut and once whole, would be
one record drawn as two.

Presentational only, as `run-log-view.tsx` is: entries and a zone in, a frame
out, with the polling in `use-run-log.ts`. Every test of this module is a
synchronous render of a fixed list.

The vocabulary is CONTEXT.md's. An entry's `summary` is the line the block draws;
its `detail` is the full text, and it is drawn only when it says something the
summary has not already said — a successful Flush composes both from the same
counts, and the same sentence twice would read as two entries.
*/

import {Box, Text} from 'ink';
import {CLOCK_WIDTH, clockTime} from './format.js';
import {type RunLogEntry} from './run-log.js';

export function DiagnosticsView({
	entries,
	timeZone,
}: {
	entries: readonly RunLogEntry[];
	timeZone: string;
}) {
	return (
		<Box flexDirection="column">
			<Text bold>Diagnostics</Text>
			{/*
			An empty log is the same state here as it is under the block: the run
			has nothing to report yet, which is a thing to say rather than a pane
			that failed to draw.
			*/}
			{entries.length === 0 ? (
				<Text dimColor>Nothing yet.</Text>
			) : (
				entries.map((entry, index) => (
					/*
					The index is part of the key for the reason the block gives:
					two entries can share a second, and the list is rebuilt on
					every poll rather than mutated.
					*/
					<Entry
						key={`${entry.at.toISOString()}#${index}`}
						entry={entry}
						timeZone={timeZone}
					/>
				))
			)}
		</Box>
	);
}

/*
One colour for the whole of an entry: a Flush that did not land, or a problem
the helper reported, is one statement that something is wrong, and the sentence
explaining it is part of that statement rather than a footnote to it.
*/
function Entry({entry, timeZone}: {entry: RunLogEntry; timeZone: string}) {
	const color = entry.failed === true ? 'red' : undefined;

	return (
		<Box flexDirection="column" marginTop={1}>
			<Box>
				<Box width={CLOCK_WIDTH}>
					<Text dimColor>{clockTime(entry.at, timeZone)}</Text>
				</Box>
				<Text dimColor>{entry.class}</Text>
			</Box>
			<Text color={color}>{entry.summary}</Text>
			{entry.detail !== entry.summary && (
				<Text color={color}>{entry.detail}</Text>
			)}
		</Box>
	);
}
