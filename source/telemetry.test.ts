import test from 'ava';
import {type PermissionReport, permissionReport} from './permissions.js';
import {type FlushAttempt} from './session.js';
import {TelemetryState} from './state.js';
import {InProcessTelemetrySource, type LiveTelemetry} from './telemetry.js';

/*
The reading is the whole module, and it is synchronous: there is no source to
fake and nothing to await. The state is real, because the arithmetic between it
and what has already been flushed is the part that can be wrong.
*/

type TestSource = {
	readonly source: InProcessTelemetrySource;
	readonly state: TelemetryState;
};

/*
Built through `permissionReport` rather than written out by hand, so a test
cannot pass against a report shape the CLI would never produce.
*/
function granted(): TestSource {
	return build(
		permissionReport({inputMonitoring: 'granted', message: 'granted'}),
	);
}

function build(report: PermissionReport): TestSource {
	const state = new TelemetryState({mouseDpi: 72});

	return {
		state,
		source: new InProcessTelemetrySource({report, state}),
	};
}

/*
A Flush as the Session performs one, including the clear — which is the half the
source depends on and cannot do itself. The Session's own test file is what
holds the two together; here the point is only what the source does with what it
is told.
*/
function flushed(state: TelemetryState, isWritten = true): FlushAttempt {
	const snapshot = state.snapshot();

	if (isWritten) {
		state.clear();
	}

	return {at: new Date('2026-09-22T10:00:00.000Z'), ok: isWritten, snapshot};
}

function collecting(reading: LiveTelemetry) {
	if (reading.status !== 'collecting') {
		throw new Error(`expected a collecting reading, got ${reading.status}`);
	}

	return reading;
}

test('a granted run reads as collecting, with nothing in it yet', t => {
	const {source} = granted();
	const reading = collecting(source.read());

	t.deepEqual(reading.totals, {
		leftClicks: 0,
		rightClicks: 0,
		movementMeters: 0,
		pressTotal: 0,
	});
	// Distinct from a Flush that failed: nothing has been attempted yet, and a
	// line saying "failed" before the first attempt would be a false alarm.
	t.is(reading.lastFlush, undefined);
});

test('the counters in Telemetry State are what the view reads', t => {
	const {source, state} = granted();

	state.addLeftClick();
	state.addRightClick();
	state.addKeyPress('A');
	state.addKeyPress('A');
	state.addMouseMovement(72);

	t.deepEqual(collecting(source.read()).totals, {
		leftClicks: 1,
		rightClicks: 1,
		// Pixels in, metres out: the conversion is Telemetry State's, and this
		// only has to carry the result rather than repeat it.
		movementMeters: 0.0254,
		pressTotal: 2,
	});
});

/*
The rule that makes the totals "since the CLI started" rather than "since the
last Flush Interval". A successful Flush clears Telemetry State, so without the
running total the view would drop back to zero every five minutes.
*/
test('counters survive a Flush, because the run does', t => {
	const {source, state} = granted();
	state.addLeftClick();

	source.recordFlush(flushed(state));
	t.is(collecting(source.read()).totals.leftClicks, 1, 'not cleared from view');

	state.addLeftClick();
	t.is(collecting(source.read()).totals.leftClicks, 2, 'and counted on top');
});

/*
The trap a running total falls into: a failed Flush leaves Telemetry State whole
so the same counters are retried, and adding them here as well would show a
press twice.
*/
test('a failed Flush is not added to the running total', t => {
	const {source, state} = granted();
	state.addLeftClick();

	source.recordFlush(flushed(state, false));

	t.is(collecting(source.read()).totals.leftClicks, 1);
	t.false(collecting(source.read()).lastFlush?.ok);
});

test('the last Flush reports when it happened and whether it worked', t => {
	const {source, state} = granted();
	state.addLeftClick();

	source.recordFlush(flushed(state));

	const {lastFlush} = collecting(source.read());
	t.true(lastFlush?.ok);
	t.deepEqual(lastFlush?.at, new Date('2026-09-22T10:00:00.000Z'));

	state.addLeftClick();
	source.recordFlush(flushed(state, false));

	// The failure replaces it rather than joining it: "the last Flush" is one
	// event, and the view has one line to draw it on.
	t.false(collecting(source.read()).lastFlush?.ok);
});

/*
The distinction the view exists to draw. A missing grant produces no counters at
all, which reads exactly like a machine nobody has touched — so the two are
different states rather than the same state with a flag beside it.
*/
test('a missing grant reads as disabled, with the helper’s own words', t => {
	const {source} = build(
		permissionReport({
			inputMonitoring: 'denied',
			message: 'Input Monitoring is denied for this helper.',
		}),
	);

	t.deepEqual(source.read(), {
		status: 'disabled',
		message: 'Input Monitoring is denied for this helper.',
	});
});

/*
An unknown grant is a third answer rather than a polite denial, and it disables
collection exactly as a denial does. Flattening it would lose the distinction
the preflight went to the trouble of keeping.
*/
test('an unknown grant reads as disabled too', t => {
	const {source} = build(
		permissionReport({
			inputMonitoring: 'unknown',
			message: 'Input Monitoring is unknown.',
		}),
	);

	t.deepEqual(source.read(), {
		status: 'disabled',
		message: 'Input Monitoring is unknown.',
	});
});
