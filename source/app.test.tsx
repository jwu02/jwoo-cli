import test from 'ava';
import {render} from 'ink-testing-library';
import App from './app.js';
import {
	type HistoryData,
	type HistorySource,
	type LoadResult,
} from './history.js';
import {type Range} from './ranges.js';

/*
Serial for the same reason as `use-history.test.tsx`: each case mounts a real
Ink root onto a shared scheduler, and overlapping roots made the frame
assertions flaky.
*/

/*
The two ranges are told apart by their numbers rather than by their headings,
so an assertion cannot be satisfied by the hint line that names both keys.
*/
const PRESS_TOTAL = {today: 1111, week: 2222};

function dataFor(range: Range): HistoryData {
	return {
		range,
		timeZone: 'Europe/London',
		totals: {
			leftClicks: 1,
			rightClicks: 0,
			movementMeters: 1,
			pressTotal: PRESS_TOTAL[range],
		},
		keyRanking: [{label: 'A', count: 1}],
		timeSeries: [
			{
				bucket: '2026-09-21T10:00:00.000Z',
				leftClicks: 1,
				rightClicks: 0,
				movementMeters: 1,
				keyPresses: 1,
			},
		],
	};
}

class StubHistorySource implements HistorySource {
	readonly requests: Range[] = [];

	async load(range: Range): Promise<LoadResult> {
		this.requests.push(range);
		return {ok: true, data: dataFor(range)};
	}

	async close(): Promise<void> {
		// Nothing to release: the fake holds no connection.
	}
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 2; turn += 1) {
		// eslint-disable-next-line no-await-in-loop -- the turns must be sequential; that is the point.
		await new Promise(resolve => {
			setImmediate(resolve);
		});
	}
}

test.serial('the landing view is the history for today', async t => {
	const source = new StubHistorySource();
	const {lastFrame} = render(<App source={source} />);
	await settle();

	// The default landing view, and the one that works before anything has
	// been collected: it reads history, not the collector.
	t.deepEqual(source.requests, ['today']);
	t.regex(lastFrame() ?? '', /Press Total\s+1,111/v);
});

test.serial('w switches the view to this week', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame} = render(<App source={source} />);
	await settle();

	stdin.write('w');
	await settle();

	t.deepEqual(source.requests, ['today', 'week']);
	t.regex(lastFrame() ?? '', /Press Total\s+2,222/v);
});

test.serial('t switches back to today', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame} = render(<App source={source} />);
	await settle();

	stdin.write('w');
	await settle();
	stdin.write('t');
	await settle();

	t.deepEqual(source.requests, ['today', 'week', 'today']);
	t.regex(lastFrame() ?? '', /Press Total\s+1,111/v);
});

/*
`q` is not asserted here. It delegates straight to Ink's `exit()`, and
`ink-testing-library` exposes no way to observe that a root has exited —
`Instance` has `unmount`, `frames` and `lastFrame`, and none of them changes
when Ink tears itself down. A test would have to reach into Ink's internals,
which would assert the framework rather than this code.
*/
