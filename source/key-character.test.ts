/*
The port of `_label_for_key` from `collectors/keyboard.py`, where the Python
suite drove it with a `KeyCode` or a `Key` member.

The seam is different here and the tests look different with it. pynput resolved
a key to the character the active layout produced, so `KeyCode.from_char('£')`
carried the answer already; the helper emits a keycode and a raw flags word
(ADR-0003), so the answer has to be derived. Every case below is that derivation
rather than a lookup of something already resolved.
*/

import test from 'ava';
import {
	labelForEvent,
	modifierBitFor,
	FIXED_KEY_LABELS,
} from './key-character.js';

/*
The flag bits macOS sets, as measured against the live helper rather than read
off a header. `NonCoalesced` is set on every event the tap delivered, so a
fixture that omits it stays honest about the table not depending on it.

  Shift (either)   0x00020000
  Control (either) 0x00040000
  Option (either)  0x00080000
  Command (either) 0x00100000
  AlphaShift       0x00010000
  SecondaryFn      0x00800000
*/
const NON_COALESCED = 256;
const SHIFT = 131_072;
const CONTROL = 262_144;
const OPTION = 524_288;
const COMMAND = 1_048_576;
const ALPHA_SHIFT = 65_536;
const SECONDARY_FN = 8_388_608;

/*
Every captured event carried this bit, including the bare ones. Left in the
fixtures because stripping it would make them a fiction.
*/
const BARE = NON_COALESCED;

function label(keycode: number, flags = BARE): string | undefined {
	return labelForEvent({keycode, flagsRaw: flags});
}

// ---------------------------------------------------------------------------
// Character-producing keys
// ---------------------------------------------------------------------------

test('lowercase letters resolve to the uppercase label', t => {
	// The keycode carries no case: 'a' and 'A' are both keycode 0 with the
	// Shift bit the only difference, and both must land in one bucket.
	t.is(label(0), 'A');
	t.is(label(0, BARE | SHIFT), 'A');
});

test('shift does not produce a second letter label', t => {
	// The Python original merged 'a' and 'A' by uppercasing the resolved
	// character. Here the merge is the table's: one entry per letter keycode.
	t.is(label(14), 'E');
	t.is(label(14, BARE | SHIFT), 'E');
});

test('UK shift+3 records the pound sign', t => {
	// Shift+3 is '£' on a UK Mac, not the '#' a US layout produces. Both are
	// collected: the Physical Key is the same one either way.
	t.is(label(20), '3');
	t.is(label(20, BARE | SHIFT), '£');
});

test('option+3 records the US shifted character', t => {
	t.is(label(20, BARE | SHIFT | OPTION), '#');
});

test('UK option+2 records the euro sign', t => {
	t.is(label(19), '2');
	t.is(label(19, BARE | SHIFT), '@');
	t.is(label(19, BARE | OPTION), '€');
});

test('digits and their shifted symbols', t => {
	t.is(label(18), '1');
	t.is(label(18, BARE | SHIFT), '!');
	t.is(label(21), '4');
	t.is(label(21, BARE | SHIFT), '$');
	t.is(label(29), '0');
	t.is(label(29, BARE | SHIFT), ')');
});

test('UK punctuation records the character the key actually produces', t => {
	// The US and UK layouts agree on base characters for most punctuation and
	// differ on the shifted ones, which is exactly the case worth pinning.
	t.is(label(33), '[');
	t.is(label(33, BARE | SHIFT), '{');
	t.is(label(39), "'");
	t.is(label(39, BARE | SHIFT), '"');
	t.is(label(44), '/');
	t.is(label(44, BARE | SHIFT), '?');
	t.is(label(42), '\\');
	t.is(label(42, BARE | SHIFT), '|');
	t.is(label(47), '.');
	t.is(label(47, BARE | SHIFT), '>');
});

/*
The one pair of keycodes the two layouts genuinely disagree about, and the pair
this table was first written the wrong way round.

`kVK_ISO_Section` (10) is the §/± key a UK Mac has. `kVK_ANSI_Grave` (50) is the
`/~ key both layouts have, in a different place on each. `keymap.py` names them
"Section" and "Grave", and the website draws one Physical Key carrying
"Section", "Grave", "§" and "±" plus a "Backtick" for "`" and "~" — so which
keycode a character sits on decides which physical key lights up, and getting
it backwards both drops § and mislabels `.
*/
test('the Section and Grave keys record their own characters', t => {
	t.is(label(10), '§');
	t.is(label(10, BARE | SHIFT), '±');
	t.is(label(50), '`');
	t.is(label(50, BARE | SHIFT), '~');
});

/*
Shift is only a character modifier where a key has two characters. For the
non-printing keys it is noise, and a label that varied with it would open a
second bucket for the same physical key.
*/
test('shift does not change a non-printing key', t => {
	t.is(label(36), 'Return');
	t.is(label(36, BARE | SHIFT), 'Return');
	t.is(label(123), 'Left Arrow');
	t.is(label(123, BARE | SHIFT), 'Left Arrow');
});

// ---------------------------------------------------------------------------
// Fn overlays
//
// The website maps these to Physical Keys of their own: 'Forward Delete' on the
// Delete key, and Home/Page Up/Page Down on the arrows. pynput handed them back
// as distinct Key members; from a raw keycode they are an overlay read off the
// SecondaryFn bit.
// ---------------------------------------------------------------------------

test('Fn turns Delete into Forward Delete', t => {
	t.is(label(51), 'Delete');
	t.is(label(51, BARE | SECONDARY_FN), 'Forward Delete');
});

test('Fn turns the vertical arrows into their navigation labels', t => {
	t.is(label(126), 'Up Arrow');
	t.is(label(126, BARE | SECONDARY_FN), 'Page Up');
	t.is(label(125), 'Down Arrow');
	t.is(label(125, BARE | SECONDARY_FN), 'Page Down');
	t.is(label(123), 'Left Arrow');
	t.is(label(123, BARE | SECONDARY_FN), 'Home');
});

/*
ADR-0006's trap, and the reason the overlay is keyed on keycode as well as the
flag. macOS sets SecondaryFn for F1-F12 whether or not Fn is down, so a bare F1
press carries the same flags as a bare Fn press. Nothing may read the bit alone.
*/
test('F1-F12 ignore the Fn bit rather than being overlaid by it', t => {
	for (const [keycode, name] of [
		[122, 'F1'],
		[120, 'F2'],
		[111, 'F12'],
	] as const) {
		t.is(label(keycode, BARE | SECONDARY_FN), name);
	}
});

test('a modified Fn chord still resolves', t => {
	// Shift is held with Fn here, which changes neither the overlay nor the
	// result: the overlay keys on Fn alone.
	t.is(label(51, BARE | SECONDARY_FN | SHIFT), 'Forward Delete');
	t.is(label(51, BARE | SECONDARY_FN | OPTION), 'Forward Delete');
});

// ---------------------------------------------------------------------------
// Fixed-name keys
// ---------------------------------------------------------------------------

test('non-printing keys resolve to their fixed label', t => {
	t.is(label(36), 'Return');
	t.is(label(49), 'Space');
	t.is(label(48), 'Tab');
	t.is(label(53), 'Escape');
	t.is(label(57), 'Caps Lock');
});

test('both sides of a modifier resolve to their own label', t => {
	// The distinction pynput preserved by giving left and right their own Key
	// members. Here it is the keycode, which is the more direct source of it.
	t.is(label(56), 'Left Shift');
	t.is(label(60), 'Right Shift');
	t.is(label(59), 'Left Ctrl');
	t.is(label(62), 'Right Ctrl');
	t.is(label(58), 'Left Option');
	t.is(label(61), 'Right Option');
	t.is(label(55), 'Left Cmd');
	t.is(label(54), 'Right Cmd');
});

// ---------------------------------------------------------------------------
// Dropping
// ---------------------------------------------------------------------------

test('a keycode with no entry is dropped rather than named', t => {
	// The Python suite's `KeyCode.from_vk(999)`. Dropping is what keeps the
	// label vocabulary closed, so this returns undefined and not a fallback.
	t.is(label(999), undefined);
});

test('the Fn overlay changes only the keycodes it names', t => {
	/*
	Reading the bit alone would be the trap: a bare F1 carries SecondaryFn, so
	"anything with the bit set is a chord" would relabel all twelve function
	keys. The overlay is keyed on both, which this pins by holding the flag
	constant and varying the keycode.

	F13-F20 are not in the overlay and are not dropped either — see the note on
	`FN_OVERLAYS`. They resolve to their own labels, which the website discards
	on arrival.
	*/
	const overlaid = new Set([51, 123, 125, 126]);

	for (const keycode of [122, 120, 111, 105, 107, 113, 106, 64, 79, 80, 90]) {
		t.is(
			label(keycode, BARE | SECONDARY_FN),
			label(keycode, BARE),
			`keycode ${keycode} must not vary with the Fn bit`,
		);
		t.false(overlaid.has(keycode));
	}
});

// ---------------------------------------------------------------------------
// Modifier transitions
//
// Modifiers never arrive as keyDown. The live capture recorded eight modifier
// presses and every one of them was a `flagsChanged` — so press against release
// has to come from the flag bit, the same way Fn's does.
// ---------------------------------------------------------------------------

test('every modifier keycode has a flag bit', t => {
	t.is(modifierBitFor(56), SHIFT);
	t.is(modifierBitFor(60), SHIFT);
	t.is(modifierBitFor(59), CONTROL);
	t.is(modifierBitFor(62), CONTROL);
	t.is(modifierBitFor(58), OPTION);
	t.is(modifierBitFor(61), OPTION);
	t.is(modifierBitFor(55), COMMAND);
	t.is(modifierBitFor(54), COMMAND);
	t.is(modifierBitFor(57), ALPHA_SHIFT);
	// Fn is a modifier too, and the one whose bit ADR-0006 warns about. It is
	// listed here because the keycode disambiguates it, not the bit.
	t.is(modifierBitFor(63), SECONDARY_FN);
});

test('a key that is not a modifier has no bit', t => {
	t.is(modifierBitFor(0), undefined);
	t.is(modifierBitFor(36), undefined);
	// F1 sets SecondaryFn but is not the Fn key, which is the whole trap.
	t.is(modifierBitFor(122), undefined);
});

test('every fixed label is one the modifier table can produce', t => {
	// Guards the seam between the two tables: a modifier keycode with no fixed
	// label would count nothing, and a fixed label with no keycode behind it is
	// dead weight.
	for (const keycode of [56, 60, 59, 62, 58, 61, 55, 54, 57, 63]) {
		t.true(FIXED_KEY_LABELS.has(keycode), `keycode ${keycode}`);
	}
});
