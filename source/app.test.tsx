import test from 'ava';
import {render} from 'ink-testing-library';
import App from './app.js';
import {
	type HistoryData,
	type HistorySource,
	type LoadResult,
} from './history.js';
import {type Range} from './ranges.js';
import {type LiveTelemetry, type TelemetrySource} from './telemetry.js';

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

/*
The live numbers are as distinctive as the history's, so a frame can only be
satisfied by the view that was asked for. Nothing here reads the source: what is
under test is which view is drawn, and the live view's own arithmetic belongs to
`live-view.test.tsx`.
*/
const LIVE_PRESS_TOTAL = 999;

class StubTelemetrySource implements TelemetrySource {
	reading: LiveTelemetry = {
		status: 'collecting',
		totals: {
			leftClicks: 3,
			rightClicks: 1,
			movementMeters: 12.5,
			pressTotal: LIVE_PRESS_TOTAL,
		},
		lastFlush: undefined,
	};

	read(): LiveTelemetry {
		return this.reading;
	}
}

function dashboard(
	history: HistorySource,
	telemetry: TelemetrySource = new StubTelemetrySource(),
) {
	return (
		<App history={history} telemetry={telemetry} timeZone="Europe/London" />
	);
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
	const {lastFrame} = render(dashboard(source));
	await settle();

	// The default landing view, and the one that works before anything has
	// been collected: it reads history, not the collector.
	t.deepEqual(source.requests, ['today']);
	t.regex(lastFrame() ?? '', /Press Total\s+1,111/v);
});

test.serial('w switches the view to this week', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame} = render(dashboard(source));
	await settle();

	stdin.write('w');
	await settle();

	t.deepEqual(source.requests, ['today', 'week']);
	t.regex(lastFrame() ?? '', /Press Total\s+2,222/v);
});

test.serial('t switches back to today', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame} = render(dashboard(source));
	await settle();

	stdin.write('w');
	await settle();
	stdin.write('t');
	await settle();

	t.deepEqual(source.requests, ['today', 'week', 'today']);
	t.regex(lastFrame() ?? '', /Press Total\s+1,111/v);
});

test.serial('l switches to the live view', async t => {
	const source = new StubHistorySource();
	/*
	Unmounted rather than left to the end of the run: the live view polls, and a
	component still mounted when the test finishes leaves a timer behind that
	ava waits on.
	*/
	const {stdin, lastFrame, unmount} = render(dashboard(source));
	t.teardown(() => {
		unmount();
	});
	await settle();

	stdin.write('l');
	await settle();

	const frame = lastFrame() ?? '';
	t.regex(frame, /since the CLI started/v);
	t.regex(
		frame,
		new RegExp(String.raw`Press Total\s+${LIVE_PRESS_TOTAL}`, 'v'),
	);

	// The history's numbers are gone rather than drawn under a second heading.
	t.false(frame.includes('1,111'));
	// Nothing was re-read: the range did not change, only the view.
	t.deepEqual(source.requests, ['today']);
});

/*
There is no key that toggles back to "whatever was showing". A range key is the
way back, which is what makes the heading above the numbers unambiguous.
*/
test.serial('a range key is the way back from the live view', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame, unmount} = render(dashboard(source));
	t.teardown(() => {
		unmount();
	});
	await settle();

	stdin.write('l');
	await settle();
	stdin.write('t');
	await settle();

	const frame = lastFrame() ?? '';
	t.regex(frame, /Press Total\s+1,111/v);
	t.false(frame.includes('since the CLI started'));
});

/*
`q` is not asserted here. It delegates straight to Ink's `exit()`, and
`ink-testing-library` exposes no way to observe that a root has exited —
`Instance` has `unmount`, `frames` and `lastFrame`, and none of them changes
when Ink tears itself down. A test would have to reach into Ink's internals,
which would assert the framework rather than this code.
*/
