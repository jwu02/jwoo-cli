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
import {labelForEvent} from './key-character.js';
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
Labels this table can produce that the website has no Physical Key for. Each is
counted here and discarded there, deliberately rather than by oversight:

- `F13`-`F20`: the M3 Air 13" keyboard the website models has F1-F12 and no
  more, which is also why #7 ignores them.
- `Keypad *` and friends: the M3 Air has no numeric keypad. They arrive only
  from an external one, and the website draws no key for them.
- `Mute`, `Volume Down`, `Volume Up`: media keys, likewise undrawn.

`Keypad Enter` is the near miss worth knowing about. The website does know a
`Numpad Enter`, on the Return physical key, and this table produces that too
(keycode 52) - but the keypad's own Return key is keycode 76, which the Python
table calls `Keypad Enter` and which resolves to nothing. A keypad Return press
is therefore invisible to the heatmap in both clients.

If this list ever fails because the website *gained* support for one of these,
delete that label here. If it fails because the website lost one, that is the
wire format breaking: fix the website.
*/
const DELIBERATE_SILENT_DROPS: readonly string[] = [
	'F13',
	'F14',
	'F15',
	'F16',
	'F17',
	'F18',
	'F19',
	'F20',
	'Keypad *',
	'Keypad +',
	'Keypad -',
	'Keypad .',
	'Keypad /',
	'Keypad 0',
	'Keypad 1',
	'Keypad 2',
	'Keypad 3',
	'Keypad 4',
	'Keypad 5',
	'Keypad 6',
	'Keypad 7',
	'Keypad 8',
	'Keypad 9',
	'Keypad =',
	'Keypad Clear',
	'Keypad Enter',
	'Mute',
	'Volume Down',
	'Volume Up',
];

/*
`DELIBERATE_SILENT_DROPS` is the only set allowed to be unresolved, so this
assertion has no expected list of its own — empty is the only passing value.

**This test is expected to fail until `jwoo`'s `key-layout.ts` is updated**, and
that is the point rather than a broken build. What it currently reports is the
UK character set the Collector gained with this change but the website has no
Physical Key for: `£` from Shift+3, `€` from Option+2, and the rest of the
Option layer.

Those are labels the website is now *choosing* to drop — `key-layout.ts` says of
`€` and `£` that they are "deliberately NOT tracked as heatmap labels" — and
that comment and this test disagree. Only its author can settle which is right,
so the disagreement is left visible rather than resolved by whichever repo was
edited last.

The way out is a website change: give the labels a Physical Key. It is never to
add them to `DELIBERATE_SILENT_DROPS` (that means the drop is intended, and
nothing records the decision to revisit it) and never to delete them from the
character table (that throws away the data the website would need).
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

/*
The flag bits a chord can carry, as `keyboard.test.ts` declares them. The sweep
below is over the *input* space, so it has to spell the inputs out rather than
borrow the tables it is checking.

NonCoalesced is in every chord because every captured event carried it.
SecondaryFn is swept alone as well as with Shift and Option, because Fn is what
turns the arrows and Delete into their overlay labels.
*/
const BARE = 256;
const SHIFT = 131_072;
const OPTION = 524_288;
const SECONDARY_FN = 8_388_608;

const CHORDS = [
	BARE,
	BARE | SHIFT,
	BARE | OPTION,
	BARE | SHIFT | OPTION,
	BARE | SECONDARY_FN,
	BARE | SECONDARY_FN | SHIFT,
];

/*
Every Key Label the Collector can produce, as a function of the wire format
rather than of the tables behind it.

Sweeping keycode and chord through `labelForEvent` is what makes the test below
a statement about the Collector. Enumerating the tables instead would only check
that the tables agree with the website, and would stay green for a label
reachable through a chord no table entry happens to name — which is exactly the
kind of entry a hand-written character table gets wrong.

The keycode range covers every `kVK_*` macOS defines, which stops at 126, and
`255` is beyond it: an unmapped keycode must produce nothing rather than throw.
*/
function everyLabel(): string[] {
	const labels = new Set<string>();

	for (const keycode of [...Array.from({length: 128}).keys(), 255]) {
		for (const flagsRaw of CHORDS) {
			const label = labelForEvent({keycode, flagsRaw});
			if (label !== undefined) {
				labels.add(label);
			}
		}
	}

	return [...labels].toSorted();
}

/*
The other half of the wire format. `jwoo/lib/telemetry/key-layout.ts` maps Key
Labels onto Physical Keys and drops what it does not recognise, silently, so
"every label we emit resolves there" is a property worth an assertion rather
than a reading of both files.

The website's own module is imported rather than its label list copied. A copy
can only catch us adding a label; it stays green when the *website* renames
one, which is the drift ADR-0004 is about. This is the one test that needs the
sibling `jwoo` checkout, and it fails with a module-not-found when it is
absent rather than skipping: a pin that quietly stops checking is worse than
no pin.

Split into the labels the website is *meant* to drop and those it is not,
because one flat list cannot tell the two apart. A single `deepEqual` against
`DELIBERATE_SILENT_DROPS` fails with two arrays of similar-looking strings and
leaves the reader to diff them by eye; this way a new label that the website
has not been taught fails on its own name.
*/
test('every label the collector can produce resolves in the website', async t => {
	const keyLayoutPath = new URL(
		'../../jwoo/lib/telemetry/key-layout.ts',
		import.meta.url,
	).href;
	const keyLayout = (await import(keyLayoutPath)) as {
		PHYSICAL_KEYS: Array<{id: string; labels: string[]}>;
	};

	t.true(
		Array.isArray(keyLayout.PHYSICAL_KEYS),
		'key-layout.ts no longer exports PHYSICAL_KEYS',
	);

	const recognised = new Set(
		keyLayout.PHYSICAL_KEYS.flatMap(physicalKey => physicalKey.labels),
	);
	const unresolved = everyLabel().filter(label => !recognised.has(label));

	const drops = new Set(DELIBERATE_SILENT_DROPS);

	t.deepEqual(
		unresolved.filter(label => drops.has(label)),
		DELIBERATE_SILENT_DROPS,
		'the deliberate drops must stay exactly these, and none may go unrecognised by accident',
	);

	t.deepEqual(
		unresolved.filter(label => !drops.has(label)),
		[],
		'the labels above are the ones the website must gain a Physical Key for',
	);
});
