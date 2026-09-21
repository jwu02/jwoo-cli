import test from 'ava';
import {render} from 'ink-testing-library';
import {type HistoryData, type TimeSeriesPoint} from './history.js';
import {HistoryView} from './history-view.js';
import {type Range} from './ranges.js';
import {type LoadState} from './use-history.js';

/*
The view is presentational: it takes a `LoadState` and draws it. There is no
source to fake and nothing to await, so every test here is a synchronous render
of a fixed state — which is the point of keeping the loading and the fetching
out of this module.
*/

function point(bucket: string, keyPresses = 1): TimeSeriesPoint {
	return {
		bucket,
		leftClicks: 0,
		rightClicks: 0,
		movementMeters: 0,
		keyPresses,
	};
}

function history(overrides: Partial<HistoryData> = {}): HistoryData {
	return {
		range: 'today',
		timeZone: 'Europe/London',
		totals: {
			leftClicks: 7,
			rightClicks: 3,
			movementMeters: 250.5,
			pressTotal: 41,
		},
		keyRanking: [
			{label: 'A', count: 5},
			{label: 'Return', count: 2},
		],
		timeSeries: [
			point('2026-09-21T10:00:00.000Z', 1),
			point('2026-09-21T11:00:00.000Z', 10),
			point('2026-09-21T12:00:00.000Z', 5),
		],
		...overrides,
	};
}

function frameOf(state: LoadState, range: Range = 'today'): string {
	const {lastFrame} = render(<HistoryView state={state} range={range} />);

	return lastFrame() ?? '';
}

test('the totals are drawn in the glossary’s words', t => {
	const frame = frameOf({status: 'ready', data: history()});

	// Clicks rather than "left clicks" and "right clicks" separately; Press
	// Total and Mouse Distance are CONTEXT.md terms, not descriptions.
	t.regex(frame, /Clicks\s+10/v);
	t.regex(frame, /Press Total\s+41/v);
	t.regex(frame, /Mouse Distance\s+250\.5 m/v);
});

test('the header names the range and the zone it was read in', t => {
	t.regex(
		frameOf({status: 'ready', data: history()}),
		/Today · Europe\/London/v,
	);
	t.regex(frameOf({status: 'ready', data: history()}, 'week'), /This week/v);
});

test('key counts are ranked, and carry the count', t => {
	const frame = frameOf({status: 'ready', data: history()});

	// Order matters: the ranking is the point of the list.
	t.true(
		frame.indexOf('A') < frame.indexOf('Return'),
		'the most-pressed key is listed first',
	);
	t.regex(frame, /A\s+█+\s+5/v);
	t.regex(frame, /Return\s+█+\s+2/v);
});

test('only the highest-ranked Key Labels are listed', t => {
	const keyRanking = Array.from({length: 25}, (_, index) => ({
		label: `Key${index}`,
		count: 25 - index,
	}));

	const frame = frameOf({status: 'ready', data: history({keyRanking})});

	t.regex(frame, /Key0\b/v);
	t.regex(frame, /Key11\b/v);
	t.false(frame.includes('Key12'), 'the twelfth key is past the limit');

	// A cut list that does not say it was cut reads as the whole ranking.
	t.regex(frame, /13 more Key Labels/v);
});

/*
The list is a ranking, and a ranking that fits the terminal is the point — but
a bar chart of times with no times on it does not answer "when".
*/
test('the sparklines say which hours their glyphs stand for', t => {
	const timeSeries = Array.from({length: 15}, (_, index) =>
		point(`2026-09-21T${String(9 + index).padStart(2, '0')}:00:00.000Z`, 1),
	);

	const frame = frameOf({
		status: 'ready',
		data: history({timeZone: 'UTC', timeSeries}),
	});

	// The first label starts under the first glyph and the last ends under the
	// last one, so the pair spans the run: 15 columns, two 5-character labels.
	t.regex(frame, /09:00 {5}23:00/v);
});

test('a week’s sparkline is labelled in days, not hours', t => {
	const timeSeries = [
		point('2026-09-21T00:00:00.000Z', 1),
		point('2026-09-22T00:00:00.000Z', 2),
	];

	const frame = frameOf({
		status: 'ready',
		data: history({range: 'week', timeZone: 'UTC', timeSeries}),
	});

	t.regex(frame, /Mon 21/v);
});

test('a range with nothing in it says so', t => {
	const frame = frameOf({
		status: 'ready',
		data: history({
			totals: {leftClicks: 0, rightClicks: 0, movementMeters: 0, pressTotal: 0},
			keyRanking: [],
			timeSeries: [point('2026-09-21T10:00:00.000Z', 0)],
		}),
	});

	// The first-run case: the CLI has been opened before anything is collected.
	t.regex(frame, /Nothing recorded/v);
});

test('a failure is drawn as its message', t => {
	const frame = frameOf({status: 'error', message: 'connection reset'});

	t.regex(frame, /connection reset/v);
});

test('loading says so rather than drawing an empty dashboard', t => {
	const frame = frameOf({status: 'loading'});

	t.regex(frame, /Reading/v);
	// Zeroes would read as "you did nothing", which is a different claim.
	t.false(frame.includes('Press Total'));
});

/*
`String.repeat` throws on a negative count, so a zero maximum is a crash
waiting to happen in a bar renderer that divides by it — and an all-zero range
is the first-run case, not an exotic one.
*/
test('an all-zero range draws without dividing by its maximum', t => {
	const frame = frameOf({
		status: 'ready',
		data: history({
			keyRanking: [{label: 'A', count: 0}],
			timeSeries: [point('2026-09-21T10:00:00.000Z', 0)],
		}),
	});

	t.regex(frame, /Today/v);
});

test('the sparkline is drawn for each metric over the same buckets', t => {
	const frame = frameOf({status: 'ready', data: history()});

	t.regex(frame, /Keys\s+[▁▂▃▄▅▆▇█]{3}/v);
	t.regex(frame, /Clicks\s+[▁▂▃▄▅▆▇█]{3}/v);
	t.regex(frame, /Mouse Distance\s+[▁▂▃▄▅▆▇█]{3}/v);
});
