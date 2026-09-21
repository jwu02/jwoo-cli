/*
Which Key Label each macOS keycode produces.

A Key Label is the identity recorded for a key: the uppercase printable
character it produces, or a fixed name for a key that produces none
(`Return`, `Left Cmd`, `Fn`). Labels are always those of a UK Mac keyboard
regardless of the host machine, and a key that maps to no label is dropped
silently (CONTEXT.md).

A port of `activity-telemetry-client/telemetry/keymap.py`, table for table and
grouping for grouping so the two can still be diffed by eye. The Python file is
dead code on its side — imported only by its own tests — but its tables are
what `jwoo/lib/telemetry/key-layout.ts` cites as the authoritative list, so
they are a wire format to reproduce exactly rather than a lookup helper to
improve (ADR-0004).

Two differences from the original, both deliberate:

- The platform dispatch is gone. `label_for_keycode` chose between a macOS and
  a Windows table at call time; there is no Windows table here, because Windows
  support is dropped (ADR-0005).
- `_SPECIAL_KEY_LABELS` from `collectors/keyboard.py` is not carried over as a
  second table. It existed because pynput hands back a `Key` enum member for
  non-printable keys rather than a keycode; every label in it already appears
  below against that key's keycode, which `key-labels.test.ts` asserts rather
  than takes on trust.

The keycodes are the `kVK_*` values a `CGEvent` reports, so the capture helper
passes them straight through (ADR-0003).

Not every label here reaches the heatmap. The website draws the M3 Air 13" UK
keyboard and has no Physical Key for F13-F20, for the numeric keypad, or for
the media keys, so those labels are dropped on arrival there - deliberately,
not by oversight. `key-labels.test.ts` holds the exact list and is where to
look before adding anything.
*/

export const LABEL_FOR_KEYCODE: ReadonlyMap<number, string> = new Map([
	// Letters
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
	[11, 'B'],
	[12, 'Q'],
	[13, 'W'],
	[14, 'E'],
	[15, 'R'],
	[16, 'Y'],
	[17, 'T'],
	// Numbers
	[18, '1'],
	[19, '2'],
	[20, '3'],
	[21, '4'],
	[22, '6'],
	[23, '5'],
	[25, '9'],
	[26, '7'],
	[28, '8'],
	[29, '0'],
	// Punctuation / symbols
	[10, 'Section'],
	[24, 'Equal'],
	[27, 'Minus'],
	[30, 'Right Bracket'],
	[31, 'O'],
	[32, 'U'],
	[33, 'Left Bracket'],
	[34, 'I'],
	[35, 'P'],
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
	[50, 'Grave'],
	// Modifiers / editing
	[36, 'Return'],
	[48, 'Tab'],
	[49, 'Space'],
	[51, 'Delete'],
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
	/*
	Fn produces no keyDown at all. It arrives as a flagsChanged event on
	keycode 63, and press against release is read from the SecondaryFn flag
	rather than from the keycode's presence. The same flag is set for F1-F12,
	so a consumer reading flags alone cannot tell an Fn press from an F-key
	press - only the event type can (ADR-0006).
	*/
	[63, 'Fn'],
	// Function keys
	[64, 'F17'],
	[79, 'F18'],
	[80, 'F19'],
	[90, 'F20'],
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
	[118, 'F4'],
	[120, 'F2'],
	[122, 'F1'],
	// Navigation
	[114, 'Help'],
	[115, 'Home'],
	[116, 'Page Up'],
	[117, 'Forward Delete'],
	[119, 'End'],
	[121, 'Page Down'],
	[123, 'Left Arrow'],
	[124, 'Right Arrow'],
	[125, 'Down Arrow'],
	[126, 'Up Arrow'],
	// Keypad
	[65, 'Keypad .'],
	[67, 'Keypad *'],
	[69, 'Keypad +'],
	[71, 'Keypad Clear'],
	[75, 'Keypad /'],
	[76, 'Keypad Enter'],
	[78, 'Keypad -'],
	[81, 'Keypad ='],
	[82, 'Keypad 0'],
	[83, 'Keypad 1'],
	[84, 'Keypad 2'],
	[85, 'Keypad 3'],
	[86, 'Keypad 4'],
	[87, 'Keypad 5'],
	[88, 'Keypad 6'],
	[89, 'Keypad 7'],
	[91, 'Keypad 8'],
	[92, 'Keypad 9'],
	// Media
	[72, 'Volume Up'],
	[73, 'Volume Down'],
	[74, 'Mute'],
	// Misc
	[52, 'Numpad Enter'],
]);

/*
A keycode with no label returns `undefined` rather than a fallback, because an
unmapped key is dropped rather than recorded under a name the website would
discard anyway.
*/
export function labelForKeycode(keycode: number): string | undefined {
	return LABEL_FOR_KEYCODE.get(keycode);
}
