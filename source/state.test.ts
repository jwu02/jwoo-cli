import test from 'ava';
import {TelemetryState} from './state.js';

test('click counters', t => {
	const state = new TelemetryState();

	state.addLeftClick();
	state.addLeftClick();
	state.addRightClick();
	const snapshot = state.snapshot();
	state.clear();

	t.is(snapshot.leftClicks, 2);
	t.is(snapshot.rightClicks, 1);

	const next = state.snapshot();
	state.clear();

	t.is(next.leftClicks, 0);
});

test('key and app accumulation', t => {
	const state = new TelemetryState();
	state.addKeyPress('A');
	state.addKeyPress('A');
	state.addKeyPress('Return');
	state.addAppTime('Visual Studio Code', 1);
	state.addAppTime('Visual Studio Code', 2.5);
	const snapshot = state.snapshot();

	t.is(snapshot.keyCounts['A'], 2);
	t.is(snapshot.keyCounts['Return'], 1);
	t.is(snapshot.keysPressed, 3);
	t.is(snapshot.apps['Visual Studio Code'], 3.5);
});

test('snapshot does not clear', t => {
	const state = new TelemetryState();
	state.addLeftClick();

	t.is(state.snapshot().leftClicks, 1);
	t.is(state.snapshot().leftClicks, 1);

	state.clear();
	t.is(state.snapshot().leftClicks, 0);
});

test('clear empties state', t => {
	const state = new TelemetryState();
	state.addKeyPress('A');
	state.addAppTime('Google Chrome', 2);
	state.clear();

	const snapshot = state.snapshot();
	t.deepEqual(snapshot.keyCounts, {});
	t.is(snapshot.keysPressed, 0);
	t.deepEqual(snapshot.apps, {});
});

test('mouse movement converts to metres using the configured DPI', t => {
	const state = new TelemetryState({mouseDpi: 72});

	// 72 pixels at 72 DPI is one inch, which is 0.0254m.
	state.addMouseMovement(72);

	t.is(state.snapshot().movementMeters, 0.0254);
});

test('movement is rounded to 4dp', t => {
	const state = new TelemetryState({mouseDpi: 1000});

	state.addMouseMovement(1);
	state.addMouseMovement(2);

	t.is(state.snapshot().movementMeters, 0.0001);
});

test('key counts are sorted by label so insertion order does not leak', t => {
	const state = new TelemetryState();

	// Add keys in a deliberately non-alphabetical order.
	state.addKeyPress('Z');
	state.addKeyPress('A');
	state.addKeyPress('M');

	t.deepEqual(Object.keys(state.snapshot().keyCounts), ['A', 'M', 'Z']);
});

test('hasActivity reports keyboard or mouse activity only', t => {
	const state = new TelemetryState();
	t.false(state.hasActivity());

	state.addLeftClick();
	t.true(state.hasActivity());
	state.clear();

	state.addRightClick();
	t.true(state.hasActivity());
	state.clear();

	state.addMouseMovement(1);
	t.true(state.hasActivity());
	state.clear();

	state.addKeyPress('A');
	t.true(state.hasActivity());
	state.clear();

	// App time alone is not activity: an app-only interval never flushes.
	state.addAppTime('Visual Studio Code', 1);
	t.false(state.hasActivity());
});
