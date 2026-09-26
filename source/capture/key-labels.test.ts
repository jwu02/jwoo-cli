/*
The Key Label table is a wire format, not a lookup helper (ADR-0004).

Key Counts are written with Key Labels as top-level field names, and the
website's `jwoo/lib/telemetry/key-layout.ts` maps them onto Physical Keys,
**discarding any label it does not recognise, without error**. A renamed or
newly invented label therefore does not fail anything: it simply stops
appearing in the heatmap, and nothing anywhere says so.

So the label set is asserted here as a literal list rather than derived from
the table. The two files have to agree by hand, and this test is what makes
the disagreement loud.
*/

import test from 'ava';
import {LABEL_FOR_KEYCODE, labelForKeycode} from './key-labels.js';

/*
The whole table, keycode and label, sorted by keycode. Transcribed from
`activity-telemetry-client/telemetry/keymap.py`, whose `LABEL_FOR_KEYCODE_MACOS`
the website's comment names as the authoritative list. That file is dead code
on the Python side — imported only by its own tests — so this list is the only
thing carrying it forward.

Both halves are pinned, because a list of labels alone would stay green with a
label on the wrong keycode. That is the quieter of the two failures: the label
is still one the website knows, so it does not vanish from the heatmap, it
lights up the wrong key.

**Do not rename, re-case, or repoint an entry here to make a failing test
pass.** Every string in this array is a field name in documents already in
MongoDB and a key into the website's map. Changing one requires a matching
change in `key-layout.ts` in the same breath.
*/
const PINNED_KEYMAPPING: ReadonlyArray<readonly [number, string]> = [
	[0, 'A'],
	[1, 'S'],
	[2, 'D'],
	[3, 'F'],
	[4, 'H'],
	[5, 'G'],
	[6, 'Z'],
	[7, 'X'],
	[8, 'C'],
	[9, 'V'],
	[10, 'Section'],
	[11, 'B'],
	[12, 'Q'],
	[13, 'W'],
	[14, 'E'],
	[15, 'R'],
	[16, 'Y'],
	[17, 'T'],
	[18, '1'],
	[19, '2'],
	[20, '3'],
	[21, '4'],
	[22, '6'],
	[23, '5'],
	[24, 'Equal'],
	[25, '9'],
	[26, '7'],
	[27, 'Minus'],
	[28, '8'],
	[29, '0'],
	[30, 'Right Bracket'],
	[31, 'O'],
	[32, 'U'],
	[33, 'Left Bracket'],
	[34, 'I'],
	[35, 'P'],
	[36, 'Return'],
	[37, 'L'],
	[38, 'J'],
	[39, 'Quote'],
	[40, 'K'],
	[41, 'Semicolon'],
	[42, 'Backslash'],
	[43, 'Comma'],
	[44, 'Slash'],
	[45, 'N'],
	[46, 'M'],
	[47, 'Period'],
	[48, 'Tab'],
	[49, 'Space'],
	[50, 'Grave'],
	[51, 'Delete'],
	[52, 'Numpad Enter'],
	[53, 'Escape'],
	[54, 'Right Cmd'],
	[55, 'Left Cmd'],
	[56, 'Left Shift'],
	[57, 'Caps Lock'],
	[58, 'Left Option'],
	[59, 'Left Ctrl'],
	[60, 'Right Shift'],
	[61, 'Right Option'],
	[62, 'Right Ctrl'],
	[63, 'Fn'],
	[64, 'F17'],
	[65, 'Keypad .'],
	[67, 'Keypad *'],
	[69, 'Keypad +'],
	[71, 'Keypad Clear'],
	[72, 'Volume Up'],
	[73, 'Volume Down'],
	[74, 'Mute'],
	[75, 'Keypad /'],
	[76, 'Keypad Enter'],
	[78, 'Keypad -'],
	[79, 'F18'],
	[80, 'F19'],
	[81, 'Keypad ='],
	[82, 'Keypad 0'],
	[83, 'Keypad 1'],
	[84, 'Keypad 2'],
	[85, 'Keypad 3'],
	[86, 'Keypad 4'],
	[87, 'Keypad 5'],
	[88, 'Keypad 6'],
	[89, 'Keypad 7'],
	[90, 'F20'],
	[91, 'Keypad 8'],
	[92, 'Keypad 9'],
	[96, 'F5'],
	[97, 'F6'],
	[98, 'F7'],
	[99, 'F3'],
	[100, 'F8'],
	[101, 'F9'],
	[103, 'F11'],
	[105, 'F13'],
	[106, 'F16'],
	[107, 'F14'],
	[109, 'F10'],
	[111, 'F12'],
	[113, 'F15'],
	[114, 'Help'],
	[115, 'Home'],
	[116, 'Page Up'],
	[117, 'Forward Delete'],
	[118, 'F4'],
	[119, 'End'],
	[120, 'F2'],
	[121, 'Page Down'],
	[122, 'F1'],
	[123, 'Left Arrow'],
	[124, 'Right Arrow'],
	[125, 'Down Arrow'],
	[126, 'Up Arrow'],
];

test('the Key Label table is a pinned wire format', t => {
	t.deepEqual(
		LABEL_FOR_KEYCODE.entries()
			.toArray()
			.toSorted(([left], [right]) => left - right),
		PINNED_KEYMAPPING,
	);
});

/*
`undefined` is the drop rule, not an error: a key that maps to no label is
recorded as nothing at all, which is what keeps the label vocabulary closed.
The three labels below are a mapped function key, a mapped editing key, and a
keypad key the website discards - the collector still counts it here, because
dropping it is the website's decision and not ours (CONTEXT.md).
*/
test('a keycode resolves to its label, or to nothing', t => {
	t.is(labelForKeycode(63), 'Fn');
	t.is(labelForKeycode(36), 'Return');
	t.is(labelForKeycode(76), 'Keypad Enter');
	t.is(labelForKeycode(255), undefined);
});

/*
Some labels this table can produce have no Physical Key on the website, and are
counted here while being discarded there:

- `F13`-`F20`: the M3 Air 13" the website models has F1-F12 and no more, which
  is also why #7 ignores them.
- `Keypad *` and the rest of the numeric keypad: the M3 Air has none, so they
  arrive only from an external one and the website draws no key for them.
- `Mute`, `Volume Down`, `Volume Up`: media keys, likewise undrawn.

`Keypad Enter` is the near miss. The website does know a `Numpad Enter`, on the
Return physical key, and this table produces that too (keycode 52) — but the
keypad's own Return is keycode 76, which the Python table calls `Keypad Enter`
and which the website resolves to nothing. A keypad Return press is therefore
invisible to the heatmap in both clients.

Nothing asserts any of this: the check was against the website's own
`key-layout.ts`, and it is gone rather than kept as a test that reads outside
this repo. So the risk ADR-0004 describes is now unguarded here — a label added
to the table above and not taught to the website still vanishes in silence,
with the pinned list as the only thing a rename has to be made against.
*/

/*
The labels `_SPECIAL_KEY_LABELS` in the Python `collectors/keyboard.py` could
produce, each with the keycode that produces it. That table is not carried over
as a second table here: pynput handed back a `Key` enum member for these keys
where a raw event stream reports a keycode, so the two are merged into the one
above.

Pinned as pairs rather than as a set of labels, because "every special label
survives somewhere" would hold just as well with one of them on the wrong key.
What this claims is that the merge was lossless, not merely complete.
*/
const SPECIAL_KEY_LABELS: ReadonlyArray<readonly [number, string]> = [
	[57, 'Caps Lock'],
	[51, 'Delete'],
	[125, 'Down Arrow'],
	[119, 'End'],
	[53, 'Escape'],
	[122, 'F1'],
	[109, 'F10'],
	[103, 'F11'],
	[111, 'F12'],
	[120, 'F2'],
	[99, 'F3'],
	[118, 'F4'],
	[96, 'F5'],
	[97, 'F6'],
	[98, 'F7'],
	[100, 'F8'],
	[101, 'F9'],
	[117, 'Forward Delete'],
	[115, 'Home'],
	[123, 'Left Arrow'],
	[55, 'Left Cmd'],
	[59, 'Left Ctrl'],
	[58, 'Left Option'],
	[56, 'Left Shift'],
	[74, 'Mute'],
	[121, 'Page Down'],
	[116, 'Page Up'],
	[36, 'Return'],
	[124, 'Right Arrow'],
	[54, 'Right Cmd'],
	[62, 'Right Ctrl'],
	[61, 'Right Option'],
	[60, 'Right Shift'],
	[49, 'Space'],
	[48, 'Tab'],
	[126, 'Up Arrow'],
	[73, 'Volume Down'],
	[72, 'Volume Up'],
];

test("keyboard.py's special-key labels survive at the keycode that produces them", t => {
	for (const [keycode, label] of SPECIAL_KEY_LABELS) {
		t.is(labelForKeycode(keycode), label);
	}
});

/*
Windows support is dropped (ADR-0005), and this is what that looks like from
the table's side. Windows virtual keycodes overlap the macOS ones, so a table
carrying both would answer 0x41 with the letter A rather than with the keypad
key that occupies 65 on a Mac, and 0xa0 would not resolve at all.
*/
test('no Windows table is carried', t => {
	t.is(labelForKeycode(0x41), 'Keypad .');
	t.is(labelForKeycode(0xa0), undefined);
});
