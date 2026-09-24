import test, {type ExecutionContext} from 'ava';
import {render} from 'ink-testing-library';
import App from './app.js';
import {
	type HistoryData,
	type HistorySource,
	type LoadResult,
} from './history.js';
import {type Range} from './ranges.js';
import {type RunLogEntry, type RunLogSource} from './run-log.js';
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
	};

	read(): LiveTelemetry {
		return this.reading;
	}
}

/*
The Run Log's entries, with a Press Total that is neither view's — so a frame
assertion cannot be satisfied by the numbers above the block. The summary is the
seam's own spelling of a successful Flush (`flushEntry`), pinned here so the
block is drawn from something the CLI would actually produce.
*/
class StubRunLogSource implements RunLogSource {
	entries: RunLogEntry[] = [written()];

	read(): readonly RunLogEntry[] {
		return [...this.entries];
	}
}

const RUN_LOG_PRESS_TOTAL = '1,234';

function written(at = new Date('2026-09-22T10:00:00.000Z')): RunLogEntry {
	return {
		at,
		class: 'Flush',
		summary: `Clicks 10 · Mouse Distance 250.5 m · Press Total ${RUN_LOG_PRESS_TOTAL}`,
		detail: `Clicks 10 · Mouse Distance 250.5 m · Press Total ${RUN_LOG_PRESS_TOTAL}`,
	};
}

/*
A Flush that did not land, whose two texts differ — which is the case the
diagnostics view exists for: the block draws the first and only this view has
the room for the second.
*/
const RETRY_DETAIL =
	'The counters are still in Telemetry State; the next Flush Interval writes them again.';

function failed(at = new Date('2026-09-22T10:05:00.000Z')): RunLogEntry {
	return {
		at,
		class: 'Flush',
		failed: true,
		summary: 'failed — will retry',
		detail: RETRY_DETAIL,
	};
}

function dashboard(
	history: HistorySource,
	runLog: RunLogSource = new StubRunLogSource(),
	telemetry: TelemetrySource = new StubTelemetrySource(),
) {
	return (
		<App
			history={history}
			telemetry={telemetry}
			runLog={runLog}
			timeZone="Europe/London"
		/>
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

/*
Unmounted rather than left to the end of the run, in every case here: the Run
Log block is under the history and live views and polls on both, and the
diagnostics view polls over the same entries, so any root left mounted when a
test finishes leaves a timer behind that ava waits on. It is not only the tests
that switch views.
*/
function mount(
	t: ExecutionContext,
	...props: Parameters<typeof dashboard>
): ReturnType<typeof render> {
	const instance = render(dashboard(...props));
	t.teardown(() => {
		instance.unmount();
	});

	return instance;
}

test.serial('the landing view is the history for today', async t => {
	const source = new StubHistorySource();
	const {lastFrame} = mount(t, source);
	await settle();

	// The default landing view, and the one that works before anything has
	// been collected: it reads history, not the collector.
	t.deepEqual(source.requests, ['today']);
	t.regex(lastFrame() ?? '', /Press Total\s+1,111/v);
});

test.serial('w switches the view to this week', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame} = mount(t, source);
	await settle();

	stdin.write('w');
	await settle();

	t.deepEqual(source.requests, ['today', 'week']);
	t.regex(lastFrame() ?? '', /Press Total\s+2,222/v);
});

test.serial('t switches back to today', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame} = mount(t, source);
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
	const {stdin, lastFrame} = mount(t, source);
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
	const {stdin, lastFrame} = mount(t, source);
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
The point of putting the block here rather than inside a view: the dashboard
lands on the history view, which knows nothing about this run, so a session
whose every Flush failed would otherwise open on a frame with nothing to say
about it.
*/
test.serial('the Run Log is drawn under the history view', async t => {
	const source = new StubHistorySource();
	const {lastFrame} = mount(t, source);
	await settle();

	const frame = lastFrame() ?? '';
	t.regex(frame, /Run Log/v);
	t.regex(
		frame,
		new RegExp(String.raw`Press Total\s+${RUN_LOG_PRESS_TOTAL}`, 'v'),
		'with the counts the Flush wrote',
	);
	t.regex(frame, /Clicks 10 · Mouse Distance 250\.5 m/v);
	// The history's own numbers are still above it: the block is under the
	// view, not instead of it.
	t.regex(frame, /Press Total\s+1,111/v);
});

test.serial('the Run Log is drawn under the live view too', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame} = mount(t, source);
	await settle();

	stdin.write('l');
	await settle();

	const frame = lastFrame() ?? '';
	t.regex(frame, /since the CLI started/v);
	t.regex(frame, /Run Log/v);
	t.regex(
		frame,
		new RegExp(String.raw`Press Total\s+${RUN_LOG_PRESS_TOTAL}`, 'v'),
	);
});

/*
Nothing appended is a state rather than a gap, and the block says so on both
views — it is the same block either way.
*/
test.serial(
	'an empty Run Log says so rather than drawing a bare heading',
	async t => {
		const source = new StubHistorySource();
		const runLog = new StubRunLogSource();
		runLog.entries = [];
		const {lastFrame} = mount(t, source, runLog);
		await settle();

		t.regex(lastFrame() ?? '', /Run Log\s+Nothing yet\./v);
	},
);

/*
A problem is visible from wherever the dashboard happens to be open, which is
the whole reason the block is not inside a view.
*/
test.serial(
	'a failed Flush is drawn under the history view, where the run starts',
	async t => {
		const source = new StubHistorySource();
		const runLog = new StubRunLogSource();
		runLog.entries = [failed()];
		const {lastFrame} = mount(t, source, runLog);
		await settle();

		t.regex(lastFrame() ?? '', /11:05:00\s+Flush\s+failed — will retry/v);
	},
);

/*
The diagnostics view is the same entries the block draws, with the full text —
so the frame it replaces the block with is one record drawn once, not that
record drawn twice. What is asserted below is what the block could not show.
*/
test.serial('d opens the diagnostics view from the landing view', async t => {
	const source = new StubHistorySource();
	const runLog = new StubRunLogSource();
	runLog.entries = [written(), failed()];
	const {stdin, lastFrame} = mount(t, source, runLog);
	await settle();

	// The block's own line, which is all it has room for.
	t.regex(lastFrame() ?? '', /failed — will retry/v);

	stdin.write('d');
	await settle();

	const frame = lastFrame() ?? '';
	t.regex(frame, /Diagnostics/v);
	t.regex(frame, /11:05:00\s+Flush/v);
	t.true(frame.includes(RETRY_DETAIL), 'the full text the block cuts');
	t.regex(
		frame,
		new RegExp(String.raw`Press Total\s+${RUN_LOG_PRESS_TOTAL}`, 'v'),
	);
});

/*
`d` is absolute, like the range keys: it opens the same view from wherever the
dashboard happens to be, and the numbers of the view it replaced are gone
rather than left above it.
*/
test.serial('d opens the diagnostics view from the live view', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame} = mount(t, source);
	await settle();

	stdin.write('l');
	await settle();
	stdin.write('d');
	await settle();

	const frame = lastFrame() ?? '';
	t.regex(frame, /Diagnostics/v);
	t.regex(
		frame,
		new RegExp(String.raw`Press Total\s+${RUN_LOG_PRESS_TOTAL}`, 'v'),
		'with the entries the block was drawing',
	);
	t.false(frame.includes('since the CLI started'));
	// Nothing was re-read: the range did not change, only the view.
	t.deepEqual(source.requests, ['today']);
});

/*
One record, drawn once: the same entry is not left truncated under the pane
that just showed it in full.
*/
test.serial('the block is not drawn under the diagnostics view', async t => {
	const source = new StubHistorySource();
	const runLog = new StubRunLogSource();
	runLog.entries = [failed()];
	const {stdin, lastFrame} = mount(t, source, runLog);
	await settle();

	stdin.write('d');
	await settle();

	const frame = lastFrame() ?? '';
	t.is(frame.split('failed — will retry').length - 1, 1);
	t.is(frame.split(RETRY_DETAIL).length - 1, 1);
});

test.serial('a range key is the way out of the diagnostics view', async t => {
	const source = new StubHistorySource();
	const {stdin, lastFrame} = mount(t, source);
	await settle();

	stdin.write('d');
	await settle();

	// Asserted, so the exit below is a way out of somewhere rather than a key
	// that happened to do nothing.
	t.regex(lastFrame() ?? '', /Diagnostics/v);

	stdin.write('w');
	await settle();

	const frame = lastFrame() ?? '';
	t.regex(frame, /Press Total\s+2,222/v);
	t.false(frame.includes('Diagnostics'));
	t.deepEqual(source.requests, ['today', 'week']);
});

test.serial(
	'the live key is the way out of the diagnostics view too',
	async t => {
		const source = new StubHistorySource();
		const {stdin, lastFrame} = mount(t, source);
		await settle();

		stdin.write('d');
		await settle();

		// Asserted, so the exit below is a way out of somewhere.
		t.regex(lastFrame() ?? '', /Diagnostics/v);

		stdin.write('l');
		await settle();

		const frame = lastFrame() ?? '';
		t.regex(frame, /since the CLI started/v);
		t.false(frame.includes('Diagnostics'));
	},
);

/*
The footer is the only place the keys are named, so a view nothing points at is
a view nobody finds.
*/
test.serial('the footer names the diagnostics key', async t => {
	const source = new StubHistorySource();
	const {lastFrame} = mount(t, source);
	await settle();

	t.regex(lastFrame() ?? '', /d diagnostics/v);
});

/*
`q` is not asserted here. It delegates straight to Ink's `exit()`, and
`ink-testing-library` exposes no way to observe that a root has exited —
`Instance` has `unmount`, `frames` and `lastFrame`, and none of them changes
when Ink tears itself down. A test would have to reach into Ink's internals,
which would assert the framework rather than this code.
*/
