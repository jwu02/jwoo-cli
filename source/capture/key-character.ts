/*
Which Key Label a helper event produces.

`key-labels.ts` answers "what is this keycode called". This answers the harder
question ADR-0003 leaves to TypeScript: what does this keycode *print*, given the
modifier flags it arrived with. The helper emits no character — it cannot, since
it never reads the keyboard layout — so the layout it has to match lives here.

The tables are for a UK Mac keyboard, because the author's is one and because
CONTEXT.md fixes Key Labels as "always those of a UK Mac keyboard, regardless of
the host machine". Every physical key maps to *every* label it can produce: the
website's `key-layout.ts` does the same thing from its side, drawing an M3 Air
with a US layout, and a single physical key carries several labels so that a
press lights up whichever model is drawn. That is why the shifted and Option
characters below are not folded back onto their base character — Shift+3 records
'£' so the data is already there if the model ever gains a UK legend.

Nothing here reads a file or an environment: a label is a function of a keycode
and a flags word, which is what lets the whole keyboard rule set be tested
against synthetic events on any machine (ADR-0003).
*/

import {LABEL_FOR_KEYCODE} from './key-labels.js';
import {type KeyEvent} from './raw-event.js';

/*
The macOS modifier bits, as measured against the live helper rather than read
off a header. Each was captured on its own, so the mapping from keycode to bit
is an observation and not an inference:

  Left Shift  kc=56 flags=0x020100    Right Shift kc=60 flags=0x020100
  Left Option kc=58 flags=0x080100    Right Option kc=61 flags=0x080100
  Left Cmd    kc=55 flags=0x100100    Right Cmd   kc=54 flags=0x100100
  Left Ctrl   kc=59 flags=0x040100
  Caps Lock   kc=57 flags=0x010100 down,  0x000100 up

Both Shift keys share one bit and both Options share another — macOS reports the
side in the keycode, not in the flags — so the bit is only ever used to tell a
press from a release, never to tell which side was pressed.
*/
/* eslint-disable no-bitwise -- these ARE the bit flags. */
const ALPHA_SHIFT = 65_536;
const SHIFT = 131_072;
const CONTROL = 262_144;
const OPTION = 524_288;
const COMMAND = 1_048_576;
const SECONDARY_FN = 8_388_608;

/*
The bits the character table reads.

Not read, and listed here so that their absence is legible:

- `NonCoalesced` (256). Every event the live tap delivered carried it,
  including the ones with nothing else set, so it says nothing about a key.
- `AlphaShift`, `Control` and `Command`. A chord of any of them with a printing
  key still prints that key's character, so `Cmd+E` records 'E' rather than a
  label of its own. `AlphaShift` is read, but by `keyboard.ts`, through the
  modifier table — not as a character modifier.
*/
const SHIFT_MASK = SHIFT;
const OPTION_MASK = OPTION;

/*
The keycodes that are modifiers, against the bit macOS flips while each is held.

This is what lets a `flagsChanged` event be read at all. Modifiers are never
delivered as keyDown — the live capture recorded eight modifier presses and all
eight were `flagsChanged` — so press against release has to come from the flag,
exactly as ADR-0006 established for Fn.

Fn is the entry to be careful with. Its bit is also set by F1-F12, which is why
a keycode has to be present for the bit to mean anything; a bare F1 keyDown
carries `0x800100` and resolves here to nothing, so it is never mistaken for a
modifier transition.
*/
const MODIFIER_BITS: ReadonlyMap<number, number> = new Map([
	[54, COMMAND], // Right Cmd
	[55, COMMAND], // Left Cmd
	[56, SHIFT], // Left Shift
	[57, ALPHA_SHIFT], // Caps Lock
	[58, OPTION], // Left Option
	[59, CONTROL], // Left Ctrl
	[60, SHIFT], // Right Shift
	[61, OPTION], // Right Option
	[62, CONTROL], // Right Ctrl
	[63, SECONDARY_FN], // Fn
]);

export function modifierBitFor(keycode: number): number | undefined {
	return MODIFIER_BITS.get(keycode);
}

type Characters = {
	readonly plain: string;
	readonly shifted?: string;
	readonly option?: string;
};

/*
The UK Mac character table: what each printing key produces.

Letters carry one entry and no shifted twin, because case is not a Key Label
distinction — CONTEXT.md's example is `A`, and the Python original uppercased the
resolved character so that 'a' and 'A' merged into one bucket. Fixing that here
rather than at the point of counting is what keeps a held Shift from splitting a
letter in two.

The shifted characters are where the US and UK layouts disagree, and they are the
reason this table exists at all rather than a keycode being uppercased: Shift+3
prints '£' and Shift+/ prints '?', and only one of those matches the model on the
website. Both are recorded.

Option characters are the UK Option layer. They are listed because a press that
produces a character should record that character; a model that grows the legend
then has the data already. The four settled by the issue and its discussion —
'€', '#', '£', '±' — are the ones to trust; the rest are the standard UK Option
layer and have not been checked against a live layout one key at a time.
*/
const CHARACTERS: ReadonlyMap<number, Characters> = new Map([
	// Number row
	[18, {plain: '1', shifted: '!', option: '¡'}],
	[19, {plain: '2', shifted: '@', option: '€'}],
	[20, {plain: '3', shifted: '£', option: '#'}],
	[21, {plain: '4', shifted: '$', option: '¢'}],
	[22, {plain: '6', shifted: '^', option: '§'}],
	[23, {plain: '5', shifted: '%', option: '∞'}],
	[25, {plain: '9', shifted: '(', option: 'ª'}],
	[26, {plain: '7', shifted: '&', option: '¶'}],
	[28, {plain: '8', shifted: '*', option: '•'}],
	[29, {plain: '0', shifted: ')', option: 'º'}],
	/*
	The two keys the US and UK layouts disagree about, and the reason a keycode
	alone is not enough to name a key.

	`kVK_ISO_Section` (10) is the §/± key a UK Mac has and a US one does not.
	`kVK_ANSI_Grave` (50) is the `/~ key both have. `keymap.py` names them
	"Section" and "Grave", and the website draws one Physical Key carrying all
	four labels — "Section", "Grave", "§", "±" — plus a "Backtick" for "`" and
	"~", so a press of either key lights the key the model draws.
	*/
	[10, {plain: '§', shifted: '±'}],
	[50, {plain: '`', shifted: '~'}],
	// Letters. One entry each: see the note above about case.
	[0, {plain: 'A'}],
	[1, {plain: 'S'}],
	[2, {plain: 'D'}],
	[3, {plain: 'F'}],
	[4, {plain: 'H'}],
	[5, {plain: 'G'}],
	[6, {plain: 'Z'}],
	[7, {plain: 'X'}],
	[8, {plain: 'C'}],
	[9, {plain: 'V'}],
	[11, {plain: 'B'}],
	[12, {plain: 'Q'}],
	[13, {plain: 'W'}],
	[14, {plain: 'E'}],
	[15, {plain: 'R'}],
	[16, {plain: 'Y'}],
	[17, {plain: 'T'}],
	[31, {plain: 'O'}],
	[32, {plain: 'U'}],
	[34, {plain: 'I'}],
	[35, {plain: 'P'}],
	[37, {plain: 'L'}],
	[38, {plain: 'J'}],
	[40, {plain: 'K'}],
	[45, {plain: 'N'}],
	[46, {plain: 'M'}],
	// Punctuation
	[24, {plain: '=', shifted: '+'}],
	[27, {plain: '-', shifted: '_'}],
	[30, {plain: ']', shifted: '}'}],
	[33, {plain: '[', shifted: '{'}],
	[39, {plain: "'", shifted: '"'}],
	[41, {plain: ';', shifted: ':'}],
	[42, {plain: '\\', shifted: '|'}],
	[43, {plain: ',', shifted: '<'}],
	[44, {plain: '/', shifted: '?'}],
	[47, {plain: '.', shifted: '>'}],
]);

/*
Keys that print nothing and are named instead.

Derived rather than transcribed, and that is the point. This is exactly
`LABEL_FOR_KEYCODE` — the pinned port of `keymap.py`, which ADR-0004 makes the
wire format — minus every keycode the character table below answers for. An
earlier draft listed all seventy entries by hand, which meant two tables
disagreeing was not merely possible but undetectable: nothing compared them, and
`labelForKeycode` had quietly stopped being what the Collector emits.

The Fn labels for the arrows and Delete are absent on purpose: they arrive on
the same keycode as their unmodified twin and are an overlay rather than an
entry, so they live in `FN_OVERLAYS` below.
*/
export const FIXED_KEY_LABELS: ReadonlyMap<number, string> = new Map(
	[...LABEL_FOR_KEYCODE].filter(([keycode]) => !CHARACTERS.has(keycode)),
);

/*
Fn chords whose label is not their key's label.

The website gives each of these a Physical Key of its own — 'Forward Delete' sits
on the Delete key, and Home, Page Up and Page Down on the arrows — which is what
pynput reported for them and what the Python `_SPECIAL_KEY_LABELS` table listed.
From a raw keycode they are the same key with the SecondaryFn bit set.

F1-F12 are absent, and that is ADR-0006's trap rather than an omission. They set
SecondaryFn whether or not Fn is down, so an entry here would have to be keyed on
the keycode as well as the bit — which is exactly what this table is, and why a
bare F1 falls through it to its own fixed label rather than being overlaid.
*/
const FN_OVERLAYS: ReadonlyMap<number, string> = new Map([
	[51, 'Forward Delete'],
	[123, 'Home'],
	[125, 'Page Down'],
	[126, 'Page Up'],
]);

export type LabelEvent = Pick<KeyEvent, 'keycode' | 'flagsRaw'>;

/*
The Key Label a key event produces, or `undefined` for a key that maps to no
label.

`undefined` is the drop rule rather than an error: `key-labels.ts` records what
the label vocabulary is, and a key outside it is recorded as nothing at all. The
Python original dropped `KeyCode.from_vk(999)` the same way.
*/
export function labelForEvent(event: LabelEvent): string | undefined {
	const {keycode, flagsRaw} = event;

	/*
	Two tables and no fallback between them, because no keycode is in both: a
	key either prints a character or is named, and a keycode in neither is
	dropped. An earlier draft had the character path fall back to the fixed one,
	which read as a safety net and was in fact unreachable — `characterFor`
	always returns the plain character at worst.
	*/
	const characters = CHARACTERS.get(keycode);

	return characters === undefined
		? fixedLabelFor(keycode, flagsRaw)
		: characterFor(characters, flagsRaw);
}

/*
Option before Shift, because a chord carrying both is read as its Option
character — and an Option character that this table does not know falls through
to the shifted one rather than to nothing, so a chord is never dropped for
carrying a modifier the table ignores.
*/
function characterFor(characters: Characters, flags: number): string {
	// Neither mask set means the plain character, and a chord of unrelated
	// modifiers such as Cmd+E lands here rather than opening a bucket of its
	// own.
	let produced = characters.plain;

	if ((flags & SHIFT_MASK) !== 0) {
		produced = characters.shifted ?? produced;
	}

	if ((flags & OPTION_MASK) !== 0) {
		produced = characters.option ?? produced;
	}

	return produced;
}

function fixedLabelFor(keycode: number, flags: number): string | undefined {
	const overlaid =
		(flags & SECONDARY_FN) === 0 ? undefined : FN_OVERLAYS.get(keycode);

	return overlaid ?? FIXED_KEY_LABELS.get(keycode);
}

/* eslint-enable no-bitwise */
