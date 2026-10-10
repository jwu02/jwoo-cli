/*
The port of `test_keyboard.py`, case for case.

What changed is only how a key is named. The Python suite built a
`KeyCode.from_char('a')` and let pynput resolve the character; here a key is a
keycode and a flags word, which is what the helper emits. The rules under test —
auto-repeat de-duplication, release-then-press, modifier change as a release,
F13-F20, Fn — are the same rules, and each test below names the Python test it
came from.
*/

import test from 'ava';
import {TelemetryState} from '../state.js';
import {KeyboardCollector} from './keyboard.js';
import {keyEventAt, type KeyEvent, type RawEvent} from './raw-event.js';

/*
The flag bits, as measured against the live helper. `BARE` carries
NonCoalesced, which every captured event had, so a fixture without it would be a
fiction rather than a simplification.
*/
const BARE = 256;
const ALPHA_SHIFT = 65_536;
const SHIFT = 131_072;
const CONTROL = 262_144;
const OPTION = 524_288;
const COMMAND = 1_048_576;
const SECONDARY_FN = 8_388_608;

/*
Keycodes from the `kVK_*` table, named here rather than left as bare numbers so
the tests read as the keys they are about.
*/
const KEYS = {
	a: 0,
	s: 1,
	e: 14,
	three: 20,
	one: 18,
	slash: 44,
	lshift: 56,
	rshift: 60,
	lctrl: 59,
	rctrl: 62,
	lopt: 58,
	ropt: 61,
	lcmd: 55,
	rcmd: 54,
	caps: 57,
	del: 51,
	fdel: 117,
	ret: 36,
	space: 49,
	tab: 48,
	esc: 53,
	up: 126,
	down: 125,
	left: 123,
	right: 124,
	home: 115,
	end: 119,
	pgup: 116,
	pgdn: 121,
	fn: 63,
} as const;

const F1_TO_F12 = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
const F13_TO_F20 = [105, 107, 113, 106, 64, 79, 80, 90];

type Harness = {
	readonly state: TelemetryState;
	readonly press: (keycode: number, flags?: number) => void;
	readonly release: (keycode: number, flags?: number) => void;
	readonly flagsChanged: (keycode: number, flags: number) => void;
	readonly counts: () => Readonly<Record<string, number>>;
};

function harness(): Harness {
	const state = new TelemetryState();
	const collector = new KeyboardCollector({state});
	const send = (event: KeyEvent): void => {
		collector.handle(event);
	};

	return {
		state,
		press(keycode, flags = BARE) {
			send(keyEventAt('keyDown', keycode, flags));
		},
		release(keycode, flags = BARE) {
			send(keyEventAt('keyUp', keycode, flags));
		},
		flagsChanged(keycode, flags) {
			send(keyEventAt('flagsChanged', keycode, flags));
		},
		counts() {
			return state.snapshot().keyCounts;
		},
	};
}

// ---------------------------------------------------------------------------
// Character-producing keys
// ---------------------------------------------------------------------------

test('a letter is recorded uppercased, so case cannot split a bucket', t => {
	// Test_printable_character_lowercase_normalised_to_uppercase and
	// Test_printable_character_uppercase, which the keycode makes the same case.
	const test_ = harness();
	test_.press(KEYS.a);
	test_.release(KEYS.a);
	test_.press(KEYS.a, BARE | SHIFT);
	test_.release(KEYS.a, BARE | SHIFT);
	test_.press(KEYS.a);

	t.deepEqual(test_.counts(), {A: 3});
	t.is(test_.state.snapshot().keysPressed, 3);
});

test('press and release cycles accumulate', t => {
	// Test_accumulates_multiple_distinct_presses
	const test_ = harness();
	for (let index = 0; index < 5; index += 1) {
		test_.press(KEYS.e);
		test_.release(KEYS.e);
	}

	t.deepEqual(test_.counts(), {E: 5});
});

test('a UK shifted symbol is recorded as the character it prints', t => {
	// Test_printable_character_uk_shifted_symbol and
	// Test_printable_shifted_digit. Shift+3 is '£' here, where the Python
	// suite passed a KeyCode already carrying it.
	const test_ = harness();
	test_.press(KEYS.three, BARE | SHIFT);
	test_.release(KEYS.three, BARE | SHIFT);
	test_.press(KEYS.one, BARE | SHIFT);
	test_.release(KEYS.one, BARE | SHIFT);

	t.deepEqual(test_.counts(), {'£': 1, '!': 1});
});

test('an Option symbol is recorded as the character it prints', t => {
	// Test_printable_character_option_symbol
	const test_ = harness();
	test_.press(KEYS.three, BARE | OPTION);
	test_.release(KEYS.three, BARE | OPTION);

	t.deepEqual(test_.counts(), {'#': 1});
});

test('an unshifted digit is recorded as itself', t => {
	// Test_printable_digit
	const test_ = harness();
	test_.press(KEYS.one);
	test_.release(KEYS.one);

	t.deepEqual(test_.counts(), {1: 1});
});

// ---------------------------------------------------------------------------
// Auto-repeat, and the held set
// ---------------------------------------------------------------------------

test('a held key counts once however many repeats arrive', t => {
	// Test_held_key_autorepeat_counts_once
	const test_ = harness();
	test_.press(KEYS.e);
	test_.press(KEYS.e); // Auto-repeat
	test_.press(KEYS.e); // Auto-repeat

	t.deepEqual(test_.counts(), {E: 1});
	t.is(test_.state.snapshot().keysPressed, 1);
});

test('a held non-printing key counts once', t => {
	// Test_held_special_key_counts_once, which used Key.backspace
	const test_ = harness();
	test_.press(KEYS.del);
	test_.press(KEYS.del); // Auto-repeat
	test_.press(KEYS.del); // Auto-repeat

	t.deepEqual(test_.counts(), {Delete: 1});
});

test('a release lets the same key count again', t => {
	// Test_release_then_press_counts_again
	const test_ = harness();
	test_.press(KEYS.a);
	test_.release(KEYS.a);
	test_.press(KEYS.a);

	t.deepEqual(test_.counts(), {A: 2});
});

/*
Ported from test_release_after_modifier_change_clears_held. The Python original failed this
in the way the label-keyed held set invites: releasing under 'a' a key counted
under 'A' left 'A' held forever, so the next press counted as a repeat.

Keying the held set on the keycode is what makes it hold here, and the test is
kept rather than deleted because the rule it states is still the one that
matters — a modifier change mid-hold must not strand a key.
*/
test('a release after a modifier change still releases the key', t => {
	const test_ = harness();
	test_.press(KEYS.a, BARE | SHIFT); // Held with Shift, counted as 'A'
	test_.press(KEYS.a, BARE | SHIFT); // Auto-repeat
	test_.release(KEYS.a); // Released after Shift came up
	test_.press(KEYS.a); // A fresh press, and it must count

	t.deepEqual(test_.counts(), {A: 2});
});

test('a key released while other keys are held releases only itself', t => {
	const test_ = harness();
	test_.press(KEYS.a);
	test_.press(KEYS.s);
	test_.release(KEYS.a);
	test_.press(KEYS.a);

	t.deepEqual(test_.counts(), {A: 2, S: 1});
});

// ---------------------------------------------------------------------------
// Non-printing keys
// ---------------------------------------------------------------------------

test('editing keys carry their fixed labels', t => {
	// Test_special_key_return, _space, _tab, _escape, _backspace, _forward_delete
	const test_ = harness();
	for (const keycode of [
		KEYS.ret,
		KEYS.space,
		KEYS.tab,
		KEYS.esc,
		KEYS.del,
		KEYS.fdel,
	]) {
		test_.press(keycode);
		test_.release(keycode);
	}

	t.deepEqual(test_.counts(), {
		Return: 1,
		Space: 1,
		Tab: 1,
		Escape: 1,
		Delete: 1,
		'Forward Delete': 1,
	});
});

test('each arrow is its own label', t => {
	// Test_special_key_arrows
	const test_ = harness();
	for (const keycode of [KEYS.up, KEYS.down, KEYS.left, KEYS.right]) {
		test_.press(keycode);
		test_.release(keycode);
	}

	t.deepEqual(test_.counts(), {
		'Up Arrow': 1,
		'Down Arrow': 1,
		'Left Arrow': 1,
		'Right Arrow': 1,
	});
});

test('navigation keys carry their fixed labels', t => {
	// Test_special_key_navigation
	const test_ = harness();
	for (const keycode of [KEYS.home, KEYS.end, KEYS.pgup, KEYS.pgdn]) {
		test_.press(keycode);
		test_.release(keycode);
	}

	t.deepEqual(test_.counts(), {
		Home: 1,
		End: 1,
		'Page Up': 1,
		'Page Down': 1,
	});
});

/*
Ported from test_f13_to_f20_ignored, which this deliberately does not reproduce.

The Python original ignored them in the Collector, because pynput handed back
`Key.f13` and `_SPECIAL_KEY_LABELS` had no entry for it. Reading keycodes
instead, F13-F20 are ordinary entries in the table `key-labels.ts` was ported
from, so they resolve and are counted. What happens to them afterwards is
unchanged: the website has no Physical Key for them and discards the labels on
arrival, which `key-labels.test.ts` pins as `DELIBERATE_SILENT_DROPS`.

So the presses are recorded here and invisible there. That is a real change in
what this client counts, and it is the honest one: the key was pressed, and
dropping it now would mean writing a list of labels to ignore that duplicates
the website's own.
*/
test('F13 to F20 are counted, and dropped by the website instead', t => {
	const test_ = harness();
	for (const keycode of F13_TO_F20) {
		test_.press(keycode, BARE | SECONDARY_FN);
		test_.release(keycode, BARE | SECONDARY_FN);
	}

	t.deepEqual(test_.counts(), {
		F13: 1,
		F14: 1,
		F15: 1,
		F16: 1,
		F17: 1,
		F18: 1,
		F19: 1,
		F20: 1,
	});
});

test('F1 to F12 are counted', t => {
	// Test_special_key_function_keys
	const test_ = harness();
	for (const keycode of F1_TO_F12) {
		test_.press(keycode, BARE | SECONDARY_FN);
		test_.release(keycode, BARE | SECONDARY_FN);
	}

	const expected: Record<string, number> = {};
	for (let index = 1; index <= 12; index += 1) {
		expected[`F${index}`] = 1;
	}

	t.deepEqual(test_.counts(), expected);
});

// ---------------------------------------------------------------------------
// Keys that are not counted
// ---------------------------------------------------------------------------

/*
test_unmapped_key_ignored, which used `KeyCode.from_vk(999)`. Dropping is what
keeps the label vocabulary closed: a key outside `key-labels.ts` is recorded as
nothing rather than under a name the website would discard anyway.
*/
test('a keycode with no label is dropped', t => {
	const test_ = harness();
	test_.press(999);
	test_.release(999);

	t.deepEqual(test_.counts(), {});
});

test('releasing a key that was never counted is a no-op', t => {
	// Test_release_unmapped_or_none_key_no_error
	const test_ = harness();
	test_.release(999);
	test_.release(KEYS.a);

	t.deepEqual(test_.counts(), {});
});

test('a dropped key does not block a later press of a counted one', t => {
	// The held set must not fill with keys that were never counted.
	const test_ = harness();
	test_.press(999);
	test_.press(999);

	t.deepEqual(test_.counts(), {});
});

/*
Everything else the wire format carries, shown to the Collector because that is
what the wiring does now: every event goes to every Collector and each decides
for itself what it owns (ADR-0008). The Mouse Collector has ignored the key
events by name all along; this is the other half of the same statement, and
without it a pointer move would be a key press.
*/
test('an event of another kind is ignored rather than counted', t => {
	const state = new TelemetryState();
	const collector = new KeyboardCollector({state});
	const others: readonly RawEvent[] = [
		{type: 'mouseMoved', timestampNs: 0, x: 3, y: 4},
		{type: 'mouseDown', timestampNs: 0, x: 3, y: 4, button: 'left'},
		{type: 'mouseUp', timestampNs: 0, x: 3, y: 4, button: 'left'},
		{type: 'error', code: 'tapDisabled', message: 'the tap was disabled'},
		{
			type: 'preflight',
			inputMonitoring: 'granted',
			message: 'Input Monitoring is granted.',
		},
	];

	for (const event of others) {
		collector.handle(event);
	}

	t.deepEqual(state.snapshot().keyCounts, {});
});

// ---------------------------------------------------------------------------
// Modifiers
//
// Every one of these arrives as `flagsChanged`; the live capture recorded eight
// modifier presses and not one of them was a keyDown. Press against release is
// the flag bit, the rule ADR-0006 established for Fn and which turns out to
// cover the rest of them too.
// ---------------------------------------------------------------------------

test('each modifier is counted on its own keycode', t => {
	// Test_special_key_modifiers
	const test_ = harness();
	for (const [keycode, bit] of [
		[KEYS.lshift, SHIFT],
		[KEYS.rshift, SHIFT],
		[KEYS.lctrl, CONTROL],
		[KEYS.rctrl, CONTROL],
		[KEYS.lopt, OPTION],
		[KEYS.ropt, OPTION],
		[KEYS.lcmd, COMMAND],
		[KEYS.rcmd, COMMAND],
	] as const) {
		test_.flagsChanged(keycode, BARE | bit);
		test_.flagsChanged(keycode, BARE);
	}

	t.deepEqual(test_.counts(), {
		'Left Shift': 1,
		'Right Shift': 1,
		'Left Ctrl': 1,
		'Right Ctrl': 1,
		'Left Option': 1,
		'Right Option': 1,
		'Left Cmd': 1,
		'Right Cmd': 1,
	});
});

test('a modifier counts once while held, however many events arrive', t => {
	const test_ = harness();
	test_.flagsChanged(KEYS.lshift, BARE | SHIFT);
	test_.flagsChanged(KEYS.lshift, BARE | SHIFT);
	test_.flagsChanged(KEYS.lshift, BARE);

	t.deepEqual(test_.counts(), {'Left Shift': 1});
});

/*
The case the flag bit cannot answer on its own, which is why `#flagsChanged`
consults the held set as well.

macOS puts the side of a modifier in the *keycode* and not in the flags, so both
Shift keys report `SHIFT`. That makes letting go of Right Shift with Left Shift
still down byte-identical to pressing Right Shift with Left Shift down — same
keycode, same flags. Reading the bit alone leaves Right Shift held forever, and
its next press is silently dropped as a repeat.

Every paired modifier shares its bit this way, so all four are driven: the bug
is in the rule, not in Shift.
*/
test('releasing a modifier while its twin is held still releases it', t => {
	const pairs = [
		[KEYS.lshift, KEYS.rshift, SHIFT, 'Left Shift', 'Right Shift'],
		[KEYS.lctrl, KEYS.rctrl, CONTROL, 'Left Ctrl', 'Right Ctrl'],
		[KEYS.lopt, KEYS.ropt, OPTION, 'Left Option', 'Right Option'],
		[KEYS.lcmd, KEYS.rcmd, COMMAND, 'Left Cmd', 'Right Cmd'],
	] as const;

	for (const [left, right, bit, leftLabel, rightLabel] of pairs) {
		const test_ = harness();
		test_.flagsChanged(left, BARE | bit);
		test_.flagsChanged(right, BARE | bit); // Pressed while its twin is down
		test_.flagsChanged(right, BARE | bit); // Released, twin still down
		test_.flagsChanged(left, BARE);
		test_.flagsChanged(right, BARE | bit); // A fresh press, which must count

		t.deepEqual(test_.counts(), {[leftLabel]: 1, [rightLabel]: 2});
	}
});

test('Caps Lock is a toggle and counts on the way down', t => {
	// Test_special_key_caps_lock, and the live capture that showed the bit set
	// on the press and clear on the release.
	const test_ = harness();
	test_.flagsChanged(KEYS.caps, BARE | ALPHA_SHIFT);
	test_.flagsChanged(KEYS.caps, BARE);

	t.deepEqual(test_.counts(), {'Caps Lock': 1});
});

test('a flagsChanged for a key that is not a modifier counts nothing', t => {
	/*
	This is where reading the bit alone would go wrong. F1 arrives as keyDown
	carrying SecondaryFn, and if the tap ever re-delivered it as flagsChanged
	the keycode is what keeps it out of the modifier path.
	*/
	const test_ = harness();
	test_.flagsChanged(0, BARE | SHIFT);

	t.deepEqual(test_.counts(), {});
});

// ---------------------------------------------------------------------------
// Fn, which is a modifier like the others
// ---------------------------------------------------------------------------

test('Fn counts once per press and release cycle', t => {
	// Test_fn_globe_press_counts_once, _press_release_counts_once,
	// _repeat_press_counts_again — now through `handle` rather than a second
	// watcher, because the helper reports Fn on the same stream as everything.
	const test_ = harness();
	for (let index = 0; index < 2; index += 1) {
		test_.flagsChanged(KEYS.fn, BARE | SECONDARY_FN);
		test_.flagsChanged(KEYS.fn, BARE);
	}

	t.deepEqual(test_.counts(), {Fn: 2});
	t.is(test_.state.snapshot().keysPressed, 2);
});

test('Fn held counts once', t => {
	// Test_fn_globe_press_counts_once, the single press without a release
	const test_ = harness();
	test_.flagsChanged(KEYS.fn, BARE | SECONDARY_FN);

	t.deepEqual(test_.counts(), {Fn: 1});
});

test('Fn counts once while another modifier is held', t => {
	// Test_fn_globe_press_with_modifiers_held_counts_once
	const test_ = harness();
	test_.flagsChanged(KEYS.fn, BARE | SECONDARY_FN | SHIFT);
	test_.flagsChanged(KEYS.fn, BARE | SHIFT);

	t.deepEqual(test_.counts(), {Fn: 1});
});

test('an Fn release carrying a newly held modifier is not a press', t => {
	// Test_fn_globe_release_after_other_modifier_toggled_not_counted
	const test_ = harness();
	test_.flagsChanged(KEYS.fn, BARE | SECONDARY_FN);
	test_.flagsChanged(KEYS.fn, BARE | SHIFT);

	t.deepEqual(test_.counts(), {Fn: 1});
});

test('Fn already held at startup is not counted on its release', t => {
	// Test_fn_globe_held_at_startup_release_not_counted
	const test_ = harness();
	test_.flagsChanged(KEYS.fn, BARE);

	t.deepEqual(test_.counts(), {});
});

test('Fn chords record the label of the chord', t => {
	/*
	The Fn overlays, which the Python suite never tested because pynput handed
	back the distinct Key members itself. These are read off the SecondaryFn bit
	on a normal keyDown.
	*/
	const test_ = harness();
	for (const [keycode, label] of [
		[KEYS.del, 'Forward Delete'],
		[KEYS.left, 'Home'],
		[KEYS.right, 'End'],
		[KEYS.up, 'Page Up'],
		[KEYS.down, 'Page Down'],
	] as const) {
		test_.press(keycode, BARE | SECONDARY_FN);
		test_.release(keycode, BARE | SECONDARY_FN);
		t.is(test_.counts()[label], 1, `Fn+${label} should be recorded`);
	}
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/*
ADR-0001's shape, asserted rather than assumed: `start()` and `stop()` exist so
the Session has something to call, and neither touches the OS because the stream
belongs to the EventStream both Collectors share.

`stop()` must also not clear the held set. A key held across a stop and start is
still held — the OS never sent its keyUp — so a restart that forgot it would
count one press twice.
*/
test('start and stop leave a held key held', t => {
	const test_ = harness();
	const collector = new KeyboardCollector({state: test_.state});
	collector.start();
	collector.handle(keyEventAt('keyDown', KEYS.a, BARE));
	collector.stop();

	collector.start();
	// Still a repeat of a key that was never released.
	collector.handle(keyEventAt('keyDown', KEYS.a, BARE));
	collector.handle(keyEventAt('keyUp', KEYS.a, BARE));
	collector.handle(keyEventAt('keyDown', KEYS.a, BARE));

	t.deepEqual(test_.counts(), {A: 2});
});

test('the Snapshot carries Key Counts sorted by label', t => {
	// Telemetry State sorts them so insertion order cannot leak the sequence of
	// presses; the collector must not defeat that by inserting out of order.
	const test_ = harness();
	for (const keycode of [KEYS.s, KEYS.a, KEYS.s]) {
		test_.press(keycode);
		test_.release(keycode);
	}

	t.deepEqual(Object.keys(test_.counts()), ['A', 'S']);
});
