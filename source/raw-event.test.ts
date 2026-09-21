/*
The helper's wire format, read from both sides.

The fixtures are the lines `./helper/bin/eventtap --self-check` actually prints,
transcribed rather than constructed, so a change to the helper's serialiser shows
up here as a failing parse rather than as a collector that quietly collects
nothing. `--self-check` exists for exactly this: it is the only way to check the
format with no permission, no tap, and no live input (ADR-0003).
*/

import test from 'ava';
import {keyEventAt, parseEventLine, type RawEvent} from './raw-event.js';

/*
`--self-check` output, verbatim. The key ordering differs between lines because
`JSONSerialization` does not sort keys, which is worth keeping: the parser must
not depend on field order.
*/
const SELF_CHECK_LINES: readonly string[] = [
	'{"flagsRaw":256,"type":"keyDown","timestampNs":1234567890,"keycode":0}',
	'{"flagsRaw":256,"type":"keyUp","timestampNs":1234567890,"keycode":0}',
	'{"flagsRaw":8388864,"type":"flagsChanged","timestampNs":1234567890,"keycode":63}',
	'{"y":200,"type":"mouseMoved","timestampNs":1234567890,"x":100}',
	'{"y":200,"button":"left","type":"mouseDown","timestampNs":1234567890,"x":100}',
	'{"y":200,"button":"left","type":"mouseUp","timestampNs":1234567890,"x":100}',
	'{"message":"sample error line","code":"inputMonitoringDenied","type":"error"}',
];

function parse(line: string): RawEvent {
	const event = parseEventLine(line);
	if (event === undefined) {
		throw new Error(`the helper's own line did not parse: ${line}`);
	}

	return event;
}

test('every line the helper prints parses', t => {
	const types = SELF_CHECK_LINES.map(line => parse(line).type);

	t.deepEqual(types, [
		'keyDown',
		'keyUp',
		'flagsChanged',
		'mouseMoved',
		'mouseDown',
		'mouseUp',
		'error',
	]);
});

test('a key event carries its keycode and raw flags', t => {
	const event = parse(
		'{"flagsRaw":256,"type":"keyDown","timestampNs":1234567890,"keycode":0}',
	);

	t.deepEqual(event, {
		type: 'keyDown',
		timestampNs: 1_234_567_890,
		keycode: 0,
		flagsRaw: 256,
	});
});

test('flags are passed through uninterpreted', t => {
	// ADR-0006's trap, seen from the wire: this is Fn's press, and reading it
	// as "Fn is held" is not something this layer may do. F1 arrives with the
	// same number.
	const fn = parse(
		'{"type":"flagsChanged","timestampNs":1,"keycode":63,"flagsRaw":8388864}',
	);
	const f1 = parse(
		'{"type":"keyDown","timestampNs":1,"keycode":122,"flagsRaw":8388864}',
	);

	t.is(
		(fn as {flagsRaw: number}).flagsRaw,
		(f1 as {flagsRaw: number}).flagsRaw,
	);
	t.is(fn.type, 'flagsChanged');
	t.is(f1.type, 'keyDown');
});

test('a mouse button event carries its position and button', t => {
	const event = parse(
		'{"y":200,"button":"left","type":"mouseDown","timestampNs":1,"x":100}',
	);

	t.deepEqual(event, {
		type: 'mouseDown',
		timestampNs: 1,
		x: 100,
		y: 200,
		button: 'left',
	});
});

test('an error line is a real event, not a failure to parse', t => {
	// The helper reports failures in-band so that "no input" and "no
	// permission" cannot be told apart by silence.
	const event = parse(
		'{"message":"sample error line","code":"inputMonitoringDenied","type":"error"}',
	);

	t.deepEqual(event, {
		type: 'error',
		code: 'inputMonitoringDenied',
		message: 'sample error line',
	});
});

test('a preflight line parses even though the stream never carries one', t => {
	// `--preflight` exits before a tap exists, so this cannot appear on the
	// event stream. It parses anyway because `permissions.ts` and the stream
	// share one description of what a line is, and the alternative is two that
	// can disagree.
	const event = parse(
		'{"message":"Input Monitoring is granted.","type":"preflight","inputMonitoring":"granted"}',
	);

	t.is(event.type, 'preflight');
});

// ---------------------------------------------------------------------------
// Anything that is not an event
//
// None of these may throw. A stream that runs for hours will see a partial
// read, a stray diagnostic, or a field a future helper has not added yet, and
// none of those is a reason to stop collecting.
// ---------------------------------------------------------------------------

test('a blank line is not an event', t => {
	t.is(parseEventLine(''), undefined);
	t.is(parseEventLine(' '.repeat(3)), undefined);
	t.is(parseEventLine('\n'), undefined);
});

test('a diagnostic that is not JSON is not an event', t => {
	t.is(parseEventLine('[eventtap] listening'), undefined);
	t.is(parseEventLine('{'), undefined);
	t.is(parseEventLine('not json at all'), undefined);
});

test('a JSON value that is not an event is not one', t => {
	t.is(parseEventLine('null'), undefined);
	t.is(parseEventLine('42'), undefined);
	t.is(parseEventLine('"keyDown"'), undefined);
	t.is(parseEventLine('[]'), undefined);
	t.is(parseEventLine('{}'), undefined);
	t.is(parseEventLine('{"type":"somethingNew"}'), undefined);
});

test('an event missing a field it needs is dropped', t => {
	// Dropped rather than defaulted. A keycode of 0 by default would be the
	// letter A, so a malformed line would silently count a keypress.
	t.is(
		parseEventLine('{"type":"keyDown","timestampNs":1,"keycode":0}'),
		undefined,
	);
	t.is(
		parseEventLine('{"type":"keyDown","timestampNs":1,"flagsRaw":256}'),
		undefined,
	);
	t.is(
		parseEventLine('{"type":"mouseMoved","timestampNs":1,"x":0}'),
		undefined,
	);
	t.is(
		parseEventLine(
			'{"type":"mouseDown","timestampNs":1,"x":0,"y":0,"button":"middle"}',
		),
		undefined,
	);
});

test('a non-integer where a coordinate belongs is dropped', t => {
	t.is(
		parseEventLine(
			'{"type":"keyDown","timestampNs":1,"keycode":"0","flagsRaw":1}',
		),
		undefined,
	);
	t.is(
		parseEventLine(
			'{"type":"keyDown","timestampNs":1,"keycode":0.5,"flagsRaw":1}',
		),
		undefined,
	);
	t.is(
		parseEventLine('{"type":"mouseMoved","timestampNs":1,"x":null,"y":0}'),
		undefined,
	);
});

test('surrounding whitespace is tolerated', t => {
	const event = parse(
		'  {"type":"keyUp","timestampNs":1,"keycode":0,"flagsRaw":0}  ',
	);

	t.is(event.type, 'keyUp');
});

// ---------------------------------------------------------------------------
// The fixture helper
// ---------------------------------------------------------------------------

test('keyEventAt builds an event the Collector can read', t => {
	// The default timestamp is a placeholder and is asserted as one: nothing
	// counts time from it, and a test that depended on a clock would be worse
	// than one that does not.
	t.deepEqual(keyEventAt('keyDown', 0, 256), {
		type: 'keyDown',
		timestampNs: 0,
		keycode: 0,
		flagsRaw: 256,
	});
});
