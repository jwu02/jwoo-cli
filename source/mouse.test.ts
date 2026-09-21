/*
The port of `test_mouse.py`.

`test_pixels_to_meters_at_72_dpi` has no equivalent here on purpose: that
conversion is `TelemetryState`'s, and `state.test.ts` covers it. What this file
tests is what the Collector contributes — pixels of travel and a count per
button — and the two tests that assert metres do so through the Snapshot, which
is the boundary the value actually crosses.
*/

import test from 'ava';
import {MouseCollector} from './mouse.js';
import {type MouseButton} from './raw-event.js';
import {TelemetryState} from './state.js';

type Harness = {
	readonly state: TelemetryState;
	readonly move: (x: number, y: number) => void;
	readonly down: (button: MouseButton, x?: number, y?: number) => void;
	readonly up: (button: MouseButton, x?: number, y?: number) => void;
};

function harness(): Harness {
	const state = new TelemetryState();
	const collector = new MouseCollector({state});
	const event = (
		type: 'mouseDown' | 'mouseUp',
		button: MouseButton,
		x: number,
		y: number,
	): void => {
		collector.handle({type, timestampNs: 0, x, y, button});
	};

	return {
		state,
		move(x, y) {
			collector.handle({type: 'mouseMoved', timestampNs: 0, x, y});
		},
		down(button, x = 0, y = 0) {
			event('mouseDown', button, x, y);
		},
		up(button, x = 0, y = 0) {
			event('mouseUp', button, x, y);
		},
	};
}

test('clicks are counted per button', t => {
	// Test_click_callbacks_update_state
	const test_ = harness();
	test_.down('left');
	test_.down('left');
	test_.down('right');

	const snapshot = test_.state.snapshot();
	t.is(snapshot.leftClicks, 2);
	t.is(snapshot.rightClicks, 1);
});

/*
A button release is not a click, and neither is a button the vocabulary has no
count for. The Python original's `_on_click` returned early on a release and
counted only left and right; `other` is what the helper folds everything else
into rather than dropping it.
*/
test('releases and uncounted buttons contribute nothing', t => {
	const test_ = harness();
	test_.up('left');
	test_.up('right');
	test_.down('other');
	test_.up('other');

	const snapshot = test_.state.snapshot();
	t.is(snapshot.leftClicks, 0);
	t.is(snapshot.rightClicks, 0);
	t.false(test_.state.hasActivity());
});

test('pointer travel accumulates as distance between moves', t => {
	// Test_move_callback_tracks_distance
	const test_ = harness();
	test_.move(0, 0);
	test_.move(72, 0);

	// 72 pixels at 72 DPI is one inch, so 0.0254 m.
	t.is(test_.state.snapshot().movementMeters, 0.0254);
});

/*
The first move establishes a baseline and contributes nothing: distance needs
two points, and moving the pointer from an unknown place to a known one is not
travel that was observed.
*/
test('the first move of a run measures nothing', t => {
	const test_ = harness();
	test_.move(500, 500);

	t.is(test_.state.snapshot().movementMeters, 0);
	t.false(test_.state.hasActivity());
});

/*
Euclidean rather than a sum of components, so a diagonal measures what it
travelled instead of the longer path through its corners. A 3-4-5 triangle is
the cheapest way to tell the two apart: the hypotenuse is 5, the sum is 7.
*/
test('a diagonal move measures its hypotenuse', t => {
	const test_ = harness();
	test_.move(0, 0);
	test_.move(3, 4);

	// 5 px / 72 dpi * 0.0254 = 0.0017638..., rounded to 4 places by the Snapshot.
	t.is(test_.state.snapshot().movementMeters, 0.0018);
});

test('travel is summed across moves, not replaced', t => {
	const test_ = harness();
	test_.move(0, 0);
	test_.move(72, 0);
	test_.move(72, 72);

	t.is(test_.state.snapshot().movementMeters, 0.0508);
});

/*
Drags arrive folded into `mouseMoved` by the helper, because pointer travel is
pointer travel whatever is held. This is that rule seen from the Collector's
side: a drag between two clicks is not lost, and the clicks still count.
*/
test('movement and clicks accumulate independently', t => {
	const test_ = harness();
	test_.down('left', 0, 0);
	test_.move(0, 0);
	test_.move(72, 0);
	test_.up('left', 72, 0);
	test_.down('left', 72, 0);

	const snapshot = test_.state.snapshot();
	t.is(snapshot.leftClicks, 2);
	t.is(snapshot.movementMeters, 0.0254);
});

test('a stop and start does not measure a jump back to the last position', t => {
	const state = new TelemetryState();
	const collector = new MouseCollector({state});
	collector.start();
	collector.handle({type: 'mouseMoved', timestampNs: 0, x: 0, y: 0});
	collector.stop();
	collector.start();
	collector.handle({type: 'mouseMoved', timestampNs: 0, x: 72, y: 0});

	t.is(state.snapshot().movementMeters, 0.0254);
});
