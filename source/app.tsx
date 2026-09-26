/*
The dashboard: the two views of the collection, the Run Log under them, and the
keys that switch between them.

History is the landing view because it is the one that works before anything has
been collected — reading it needs the Local Store and nothing else. The live view
is the second: what this run has seen so far, which is empty by definition for
the first few seconds. Diagnostics is the third, and the only one reached on
purpose rather than by naming what it shows: it is the Run Log's own entries
drawn whole, for the entry whose one line turned out not to be enough.

The Run Log is under the history and live views rather than inside one, because
what it holds is a problem to be seen from wherever the dashboard happens to be
open: the landing view is the history view, and it knows nothing about this run.
It is not under diagnostics, which is that same block drawn whole — the block
beneath it would put one record on screen twice.

All the sources arrive as props rather than being built here, and that is
load-bearing rather than stylistic: they are the composition root's to open and
to close, and a view that built one would own a lifetime it cannot release. The
composition root in `main.tsx` owns them.

The range lives here rather than in the view because switching it is input, and
the views are presentational.
*/

import {Box, Text, useApp, useInput} from 'ink';
import {useMemo, useState} from 'react';
import {DiagnosticsView} from './diagnostics-view.js';
import {HistoryView} from './history-view.js';
import {type HistorySource} from './local-store.js';
import {LiveView} from './live-view.js';
import {type Range} from './ranges.js';
import {type RunLogSource} from './run-log.js';
import {RunLogView} from './run-log-view.js';
import {type TelemetrySource} from './telemetry.js';
import {useRunLog} from './use-run-log.js';
import {useTelemetry} from './use-telemetry.js';
import {useWindowHeight} from './use-window.js';

/*
Which view is drawn, as one value rather than a flag per view. The keys are
absolute — every view key says which view it wants — so exactly one of them is
showing at a time and there is no pair of flags to keep in step.
*/
type View = 'history' | 'live' | 'diagnostics';

export type AppProps = {
	readonly history: HistorySource;
	readonly telemetry: TelemetrySource;
	readonly runLog: RunLogSource;
	/*
	When the run began. The live view is what draws it, because its totals are
	counted from that instant and nothing else in the frame says when the run it
	is showing started.
	*/
	readonly startedAt: Date;
	readonly timeZone: string;
};

export default function App({
	history,
	telemetry,
	runLog,
	startedAt,
	timeZone,
}: AppProps) {
	const [range, setRange] = useState<Range>('today');
	const [view, setView] = useState<View>('history');
	const {exit} = useApp();
	const height = useWindowHeight();

	/*
	The read, keyed to the question rather than to the frame that draws it.

	Not a loading state and not a cache of one: there is nothing to wait for, so
	what is held is the answer itself, and the only thing that changes it is the
	range. The alternative — asking on every render — would ask again on a
	resize, and a store that cannot answer answers the same way every time, so a
	failed read would land in the Run Log once per frame instead of once per
	failure (ADR-0010, #30). This is the same keying the effect it replaced had,
	without the effect.
	*/
	const result = useMemo(
		() => history.load(range, new Date()),
		[history, range],
	);

	useInput(input => {
		switch (input) {
			case 'q': {
				exit();
				break;
			}

			case 'l': {
				setView('live');
				break;
			}

			/*
			A range key is also the way back from the live view: there is no key
			that means "the other one", because a key that toggles would leave the
			range behind it ambiguous.
			*/
			case 't': {
				setRange('today');
				setView('history');
				break;
			}

			case 'w': {
				setRange('week');
				setView('history');
				break;
			}

			case 'd': {
				setView('diagnostics');
				break;
			}

			default:
		}
	});

	return (
		/*
		The frame is the window: as tall as the terminal reports, so the keys sit
		on its last line rather than wherever the content happened to end. It is
		a floor rather than a size, and that is what keeps a short terminal from
		breaking the frame — `height` would compress the views to fit and draw
		their lines over each other, where a floor is met by growing instead. The
		spacer is what holds the keys down: it takes whatever the views and the
		Run Log leave, and nothing at all when they need more room than the window
		has. A stream that reports no height leaves no floor, so the frame is the
		height of its content and the spacer has nothing to take.
		*/
		<Box flexDirection="column" minHeight={height}>
			{view === 'history' && <HistoryView result={result} range={range} />}
			{view === 'live' && (
				<Live source={telemetry} startedAt={startedAt} timeZone={timeZone} />
			)}
			{view === 'diagnostics' && (
				<Diagnostics source={runLog} timeZone={timeZone} />
			)}
			{view !== 'diagnostics' && <RunLog source={runLog} timeZone={timeZone} />}
			<Box flexGrow={1} />
			<Box marginTop={1}>
				<Text dimColor>
					t today · w this week · l live · d diagnostics · q quit
				</Text>
			</Box>
		</Box>
	);
}

/*
The polling is mounted with the view rather than held in `App`, so the history
view — which has nothing live in it — does not redraw once a second for no
reason. A component's effects begin when they mount and a hook cannot be called
conditionally, so every way of drawing a polling view is its own component.

The Run Log is one, and for the same reason: it polls whatever is above it, and
holding that timer here would redraw the history view once a second. Nothing in
the frame appends an entry — the composition root does, on a Flush — so the poll
is the only way the block ever moves.

Diagnostics is the same lines over a third reading, and it is a separate
component from the block rather than a prop on it: only one of the two is ever
mounted, so the entry list is polled once under whichever view is up.

The live view is handed the zone for one clock and no more: the instant the run
began, which is what its totals are counted from. Everything else in it is
counted rather than timed, and the Run Log under it is where the run's other
times are.
*/
function Live({
	source,
	startedAt,
	timeZone,
}: {
	source: TelemetrySource;
	startedAt: Date;
	timeZone: string;
}) {
	return (
		<LiveView
			telemetry={useTelemetry(source)}
			startedAt={startedAt}
			timeZone={timeZone}
		/>
	);
}

function RunLog({source, timeZone}: {source: RunLogSource; timeZone: string}) {
	return <RunLogView entries={useRunLog(source)} timeZone={timeZone} />;
}

function Diagnostics({
	source,
	timeZone,
}: {
	source: RunLogSource;
	timeZone: string;
}) {
	return <DiagnosticsView entries={useRunLog(source)} timeZone={timeZone} />;
}
