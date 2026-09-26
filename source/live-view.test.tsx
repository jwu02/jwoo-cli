import test from 'ava';
import {render} from 'ink-testing-library';
import {type Totals} from './local-store.js';
import {LiveView} from './live-view.js';
import {type LiveTelemetry} from './telemetry.js';

/*
The view is presentational: it takes a reading, the run's start and a zone, and
draws them. There is no source to fake and nothing to await, so every test here
is a synchronous render of fixed values — which is the point of keeping the
polling out of this module.

What the run has written is not tested here, and not drawn here either: a Flush
is the Run Log's to report, and `run-log-view.test.tsx` is where its line —
including the red one a failure draws — is asserted.
*/

const STARTED_AT = new Date('2026-09-22T09:03:22.000Z');

/*
East of UTC, so a heading drawn from the instant rather than from the zone's own
reading of it cannot pass: 09:03:22Z is 10:03:22 in London in September.
*/
const TIME_ZONE = 'Europe/London';

function frameOf(telemetry: LiveTelemetry): string {
	const {lastFrame} = render(
		<LiveView
			telemetry={telemetry}
			startedAt={STARTED_AT}
			timeZone={TIME_ZONE}
		/>,
	);

	return lastFrame() ?? '';
}

function collecting(totals: Partial<Totals> = {}): LiveTelemetry {
	return {
		status: 'collecting',
		totals: {
			leftClicks: 0,
			rightClicks: 0,
			movementMeters: 0,
			pressTotal: 0,
			...totals,
		},
	};
}

function disabled(): LiveTelemetry {
	return {
		status: 'disabled',
		message: 'Input Monitoring is denied for this helper.',
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
with a shorter range; without the instant beside it, how far back they reach is
left to be worked out from the wall clock, and a total read at nine in the
morning is drawn exactly as one read at three in the afternoon.

The zone is the run's rather than the instant's own UTC reading, and 10:03:22 is
that zone's reading of the instant above — so a heading drawn from the instant
directly, or from the machine's own zone, fails here.
*/
test('the heading says what the numbers are counted from, and when', t => {
	t.regex(frameOf(collecting()), /since the CLI started at 10:03:22/v);
});

/*
A disabled run has no totals to date, and its heading is still the run's: the
note replaces the numbers, not the sentence that says what the view is showing.
*/
test('a disabled run is headed with its start as well', t => {
	t.regex(frameOf(disabled()), /since the CLI started at 10:03:22/v);
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
The row this view used to draw is gone, and all three outcomes it had stay gone
with it: the label, "not yet" before anything had been written, and the "failed"
that said the counters were piling up. The Run Log beneath is the flush record,
so a line here would report one Flush twice on one screen.

An absence is the whole of what there is to assert — the three totals above are
what the view draws, and the tests above are what hold them — so this is what
fails if the row comes back.
*/
test('the view draws no flush line of its own', t => {
	const frame = frameOf(collecting({leftClicks: 1}));

	t.false(frame.includes('Flush'));
	t.false(frame.includes('not yet'));
	t.false(frame.includes('failed'));
});

/*
The distinction this view exists to draw. A missing grant produces no input at
all, which in counters alone is indistinguishable from a machine nobody has
touched — and the user who has just granted the permission is exactly the person
who cannot tell them apart.
*/
test('a missing grant is drawn as disabled, not as an idle run', t => {
	const frame = frameOf(disabled());

	t.regex(frame, /Collection is disabled/v);
	t.regex(frame, /Input Monitoring is denied/v);

	// Zeroes beside the note would be a second, contradictory answer.
	t.false(frame.includes('No activity yet'));
	t.false(frame.includes('Press Total'));
});
