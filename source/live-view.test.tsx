import test from 'ava';
import {render} from 'ink-testing-library';
import {type Totals} from './history.js';
import {LiveView} from './live-view.js';
import {type LastFlush, type LiveTelemetry} from './telemetry.js';

/*
The view is presentational: it takes a reading and draws it. There is no source
to fake and nothing to await, so every test here is a synchronous render of a
fixed reading — which is the point of keeping the polling out of this module.

The zone is a parameter rather than the machine's, so a flush time asserts the
same digits everywhere.
*/

const TIME_ZONE = 'Europe/London';

function frameOf(telemetry: LiveTelemetry): string {
	const {lastFrame} = render(
		<LiveView telemetry={telemetry} timeZone={TIME_ZONE} />,
	);

	return lastFrame() ?? '';
}

function collecting(
	totals: Partial<Totals> = {},
	lastFlush?: LastFlush,
): LiveTelemetry {
	return {
		status: 'collecting',
		totals: {
			leftClicks: 0,
			rightClicks: 0,
			movementMeters: 0,
			pressTotal: 0,
			...totals,
		},
		lastFlush,
	};
}

test('the totals are drawn in the glossary’s words', t => {
	const frame = frameOf(
		collecting({
			leftClicks: 7,
			rightClicks: 3,
			movementMeters: 250.5,
			pressTotal: 41,
		}),
	);

	// Clicks rather than left and right separately; Press Total and Mouse
	// Distance are CONTEXT.md terms, not descriptions.
	t.regex(frame, /Clicks\s+10/v);
	t.regex(frame, /Mouse Distance\s+250\.5 m/v);
	t.regex(frame, /Press Total\s+41/v);
});

/*
The totals are the whole run's, not the last interval's, and the heading is the
only place that says so. Without it the numbers would read as the history view's
with a shorter range.
*/
test('the heading says what the numbers are counted from', t => {
	t.regex(frameOf(collecting()), /since the CLI started/v);
});

test('a run that has seen nothing says so', t => {
	const frame = frameOf(collecting());

	// Not the same as a count of zero: nothing has arrived at all.
	t.regex(frame, /No activity yet/v);
});

test('the note goes once something has been counted', t => {
	t.false(frameOf(collecting({leftClicks: 1})).includes('No activity yet'));
	// Movement alone is Activity, even with no clicks and no keys.
	t.false(
		frameOf(collecting({movementMeters: 0.1})).includes('No activity yet'),
	);
	t.false(frameOf(collecting({pressTotal: 1})).includes('No activity yet'));
});

/*
Three answers to one question, and they must not look alike: nothing written
yet, the last write landed, and the last write did not.
*/
test('a Flush that has not happened yet says so', t => {
	t.regex(frameOf(collecting({leftClicks: 1})), /Last Flush\s+not yet/v);
});

test('a Flush that landed is drawn as the time it happened', t => {
	// 10:00 UTC is 11:00 in London in September, so the zone is applied rather
	// than the machine's being taken.
	const frame = frameOf(
		collecting(
			{leftClicks: 1},
			{at: new Date('2026-09-22T10:00:00.000Z'), ok: true},
		),
	);

	t.regex(frame, /Last Flush\s+11:00:00/v);
	t.false(frame.includes('failed'));
});

test('a Flush that failed is drawn as one', t => {
	const frame = frameOf(
		collecting(
			{leftClicks: 1},
			{at: new Date('2026-09-22T10:00:00.000Z'), ok: false},
		),
	);

	// The counters are piling up until it succeeds, so this is not a quiet
	// detail to leave the user to infer from a stale time.
	t.regex(frame, /Last Flush\s+11:00:00 · failed/v);
});

/*
The distinction this view exists to draw. A missing grant produces no input at
all, which in counters alone is indistinguishable from a machine nobody has
touched — and the user who has just granted the permission is exactly the person
who cannot tell them apart.
*/
test('a missing grant is drawn as disabled, not as an idle run', t => {
	const frame = frameOf({
		status: 'disabled',
		message: 'Input Monitoring is denied for this helper.',
	});

	t.regex(frame, /Collection is disabled/v);
	t.regex(frame, /Input Monitoring is denied/v);

	// Zeroes beside the note would be a second, contradictory answer.
	t.false(frame.includes('No activity yet'));
	t.false(frame.includes('Press Total'));
	t.false(frame.includes('Last Flush'));
});
