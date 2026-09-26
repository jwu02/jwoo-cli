/*
The history view, drawn.

Presentational only: it takes a `LoadState` and a `Range` and returns a frame.
No effects, no source, nothing to await — every test of this module is a
synchronous render of a fixed state, which is why the loading and the fetching
live in `use-history.ts` instead.

The vocabulary is CONTEXT.md's. Press Total and Mouse Distance are terms, not
descriptions, and the key list is a Key Ranking rather than a Heatmap: it
orders by count where Key Counts order by label, and it draws no keyboard.
*/

import {Box, Text} from 'ink';
import {COUNT_FORMAT, twoDigits} from './format.js';
import {localFields, weekdayOf} from './local-time.js';
import {type HistoryData} from './local-store.js';
import {bucketUnit, type Range} from './ranges.js';
import {TotalsView} from './totals-view.js';
import {type LoadState} from './use-history.js';

/*
How many Key Labels the list shows. A ranking is only useful at a glance, and
the full set of labels a keyboard can produce does not fit a terminal.
*/
const KEY_LIMIT = 12;

const BAR_WIDTH = 20;

// Wider than the longest sparkline label — "Mouse Distance", which is a
// CONTEXT.md term and not abbreviated to "Distance" — so it is followed by a
// gap rather than butting straight up against the glyphs.
const SPARKLINE_LABEL_WIDTH = 15;

const SPARKLINE_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function HistoryView({state, range}: {state: LoadState; range: Range}) {
	return (
		<Box flexDirection="column">
			<Text bold>
				{rangeLabel(range)}
				{state.status === 'ready' ? ` · ${state.data.timeZone}` : ''}
			</Text>

			{state.status === 'loading' && <Text dimColor>Reading…</Text>}
			{/*
			A pointer rather than the driver's sentence, which the read seam routes
			into the Run Log instead. A failed read is one fact about this run, and
			the log is where this run's facts are: drawn here as well it would be
			the same failure said twice, in the one place with no room for the rest
			of the context. The state still carries the message — that is the
			seam's return value and `use-history.ts` is untouched — and the frame
			draws the pointer.
			*/}
			{state.status === 'error' && (
				<Text color="red">Could not read history — see the Run Log (d).</Text>
			)}
			{state.status === 'ready' && <Dashboard data={state.data} />}
		</Box>
	);
}

function Dashboard({data}: {data: HistoryData}) {
	const clicks = data.totals.leftClicks + data.totals.rightClicks;
	const isRangeEmpty =
		clicks === 0 &&
		data.totals.pressTotal === 0 &&
		data.totals.movementMeters === 0 &&
		data.keyRanking.length === 0;
	const maxCount = maxCountOf(data.keyRanking);
	const bucketLabels = data.timeSeries.map(point =>
		bucketLabel(point.bucket, data),
	);

	return (
		<Box flexDirection="column">
			<TotalsView totals={data.totals} />

			<Box marginTop={1} flexDirection="column">
				<Sparkline
					label="Clicks"
					values={data.timeSeries.map(
						point => point.leftClicks + point.rightClicks,
					)}
				/>
				<Sparkline
					label="Mouse Distance"
					values={data.timeSeries.map(point => point.movementMeters)}
				/>
				<Sparkline
					label="Keys"
					values={data.timeSeries.map(point => point.keyPresses)}
				/>
				<Axis labels={bucketLabels} />
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text bold>Keys</Text>
				{isRangeEmpty ? (
					// Distinct from a range that has keys but no clicks: this is
					// the first run, before anything has been collected.
					<Text dimColor>Nothing recorded in this range.</Text>
				) : (
					<>
						{data.keyRanking.slice(0, KEY_LIMIT).map(key => (
							<KeyBar key={key.label} {...key} max={maxCount} />
						))}
						{/* A cut list that stays quiet about the cut reads as the
						    whole ranking, which is a different claim. */}
						{data.keyRanking.length > KEY_LIMIT && (
							<Text dimColor>
								{`…and ${data.keyRanking.length - KEY_LIMIT} more Key Labels`}
							</Text>
						)}
					</>
				)}
			</Box>
		</Box>
	);
}

/*
Linear against the largest count, as the website's heatmap does. Nothing is
shown for a key that was never pressed, so an all-zero range divides by a
maximum of zero — hence the guard rather than a bare division.
*/
function KeyBar({
	label,
	count,
	max,
}: {
	label: string;
	count: number;
	max: number;
}) {
	return (
		<Box>
			<Box width={14}>
				<Text>{label}</Text>
			</Box>
			<Text color="yellow">{'█'.repeat(barWidth(count, max))}</Text>
			<Text> {COUNT_FORMAT.format(count)}</Text>
		</Box>
	);
}

function Sparkline({label, values}: {label: string; values: number[]}) {
	return (
		<Box>
			<Box width={SPARKLINE_LABEL_WIDTH}>
				<Text>{label}</Text>
			</Box>
			<Text>{sparkline(values)}</Text>
		</Box>
	);
}

function sparkline(values: readonly number[]): string {
	const peak = Math.max(...values, 0);
	if (peak <= 0) {
		return SPARKLINE_LEVELS[0]!.repeat(values.length);
	}

	return values
		.map(value => {
			const level = Math.round(
				(Math.max(value, 0) / peak) * (SPARKLINE_LEVELS.length - 1),
			);
			return SPARKLINE_LEVELS[level]!;
		})
		.join('');
}

/*
The time axis under the sparklines. Three rows of glyphs with nothing saying
which hour each one stands for is a shape, not a series.

Only the ends are labelled, and only when both fit: the run is one column per
bucket, so the first label starts under the first glyph and the last ends under
the last one. A run too short for both — a week that is a day old — shows its
start alone rather than overlapping the two.
*/
function Axis({labels}: {labels: readonly string[]}) {
	const text = axisOf(labels);

	return text === '' ? null : (
		<Text dimColor>{' '.repeat(SPARKLINE_LABEL_WIDTH) + text}</Text>
	);
}

function axisOf(labels: readonly string[]): string {
	const first = labels[0];
	const last = labels.at(-1);

	if (first === undefined || last === undefined) {
		return '';
	}

	// The two share the run between them, so they are laid out from either end
	// of it. A negative gap means they would overlap, and the start is the end
	// worth keeping.
	const gap = labels.length - first.length - last.length;

	return gap < 0 ? first : first + ' '.repeat(gap) + last;
}

/*
A bucket is named in the zone it was computed in rather than the viewer's.
Those are the same zone here, and `data.timeZone` is what makes it so — the
boundaries came from it.

The unit comes from the range, so the two read as different things: an hour
bucket is a clock time, a day bucket is a day.
*/
function bucketLabel(bucket: string, data: HistoryData): string {
	const fields = localFields(new Date(bucket), data.timeZone);

	return bucketUnit(data.range) === 'hour'
		? `${twoDigits(fields.hour)}:${twoDigits(fields.minute)}`
		: `${WEEKDAYS[weekdayOf(fields)]!} ${fields.day}`;
}

function rangeLabel(range: Range): string {
	return range === 'today' ? 'Today' : 'This week';
}

function maxCountOf(ranking: ReadonlyArray<{count: number}>): number {
	let max = 0;
	for (const key of ranking) {
		max = Math.max(max, key.count);
	}

	return max;
}

function barWidth(count: number, max: number): number {
	return max <= 0 || count <= 0
		? 0
		: // At least one cell for a key that was pressed at all, so a rare key
			// is visible rather than rounded away to nothing.
			Math.max(1, Math.round((count / max) * BAR_WIDTH));
}
