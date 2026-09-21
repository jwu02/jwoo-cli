/*
The Keyboard Collector: raw key events in, Key Counts out.

A plain module with `start()`/`stop()` that imports nothing from React, so the
later move to a separate process is a different entry point rather than a rewrite
(ADR-0001). It owns no listener: events arrive through `handle()`, which is the
seam the Python suite had when it called `_on_press` and `_on_release` directly —
the rules below are exercised against synthetic events on any machine, with no
OS involved (ADR-0003).

The Python original's `_FnGlobeWatcher` is gone, and its absence is the point.
It existed because pynput never reported Fn, so a second Quartz thread had to
watch the flags for it. The helper reports Fn on the same stream as everything
else, so Fn is now an ordinary `flagsChanged` event and one algorithm covers it
along with every other modifier.
*/

import {labelForEvent, modifierBitFor} from './key-character.js';
import {type KeyEvent} from './raw-event.js';
import {type TelemetryState} from './state.js';

export type KeyboardCollectorOptions = {
	readonly state: TelemetryState;
};

export class KeyboardCollector {
	readonly #state: TelemetryState;
	/*
	Keycodes currently held, with the label each was counted under.

	Keyed by keycode rather than by label, which is where this departs from the
	Python original. That version held labels, so a key whose character changed
	mid-hold — Shift released while 'A' is down, say — was released under a
	label it was never counted under, and stayed in the set forever. The keycode
	is the identity that cannot move under a held key; the label is only what it
	happened to print.

	The set is also the auto-repeat rule. macOS repeats the keyDown while a key
	is held, so a keycode already in here is a repeat and is not counted again.
	*/
	readonly #held = new Map<number, string>();

	constructor({state}: KeyboardCollectorOptions) {
		this.#state = state;
	}

	/*
	Auto-repeat arrives as a repeat of the same keyDown, so a keycode already
	held is the repeat and is dropped. The label is resolved first so that a key
	with no label — one the vocabulary does not name — is never entered into the
	held set, and so never blocks a later press of a key that does have one.
	*/
	#press(event: KeyEvent): void {
		if (this.#held.has(event.keycode)) {
			return;
		}

		const label = labelForEvent(event);
		if (label === undefined) {
			return;
		}

		this.#held.set(event.keycode, label);
		this.#state.addKeyPress(label);
	}

	/*
	A modifier's press and release are both `flagsChanged`, told apart by the
	flag bit rather than by anything about the event's presence: Fn's release
	arrives on keycode 63 exactly as its press did (ADR-0006). Modifiers are
	never delivered as keyDown — the live capture recorded eight of them and
	every one was a `flagsChanged` — so this is the only path that counts them.

	The bit is only consulted for a keycode that is known to be a modifier, which
	is what keeps F1-F12 out of it. They set SecondaryFn too, but they arrive as
	keyDown on their own keycodes and are counted by `#press` above.
	*/
	#flagsChanged(event: KeyEvent): void {
		const bit = modifierBitFor(event.keycode);
		if (bit === undefined) {
			return;
		}

		/*
		A modifier is counted on the transition into "held", which makes Caps
		Lock work without a special case: it reports AlphaShift set on the press
		and clear on the release, so it is a toggle that reads like any other
		modifier. Fn is the same shape, and arrives with the bit set on press and
		clear on release.

		A clear bit is the release, and it is the only thing the flag word says
		without ambiguity. This is what a keyUp does for every other key, and
		without it a modifier would count once and then never again: the held set
		still held its keycode, so every later press looked like a repeat.
		*/
		// eslint-disable-next-line no-bitwise -- the flag word is a bit set; this is the read.
		if ((event.flagsRaw & bit) === 0) {
			this.#held.delete(event.keycode);
			return;
		}

		if (this.#held.has(event.keycode)) {
			/*
			The bit is set and this key was already down. Two different events
			look exactly like this, because the flags are identical for both:

			- macOS delivering the same transition again, which must not count a
			  second time;
			- this key being *released* while its twin is still down. Both Shift
			  keys report `SHIFT`, so letting go of Right Shift with Left Shift
			  held leaves the bit set, and reading the bit as "still down"
			  strands Right Shift so that its next press is dropped as a repeat.

			The twin tells them apart. If nothing else is down on this bit then
			the bit cannot have just been set by this key, so this is a repeat;
			if the twin is down, it is the release.
			*/
			if (this.#twinHeld(event.keycode, bit)) {
				this.#held.delete(event.keycode);
			}

			return;
		}

		const label = labelForEvent(event);
		if (label === undefined) {
			return;
		}

		this.#held.set(event.keycode, label);
		this.#state.addKeyPress(label);
	}

	/*
	Whether the other key on this flag bit is currently down.

	Only the four paired modifiers have one — both Shifts, both Ctrls, both
	Options, both Cmds — and for those the bit cannot say which side moved, so
	this is the only thing that can. Fn and Caps Lock have no twin, so this is
	always false for them, which is the right answer rather than a gap.
	*/
	#twinHeld(keycode: number, bit: number): boolean {
		for (const held of this.#held.keys()) {
			if (held !== keycode && modifierBitFor(held) === bit) {
				return true;
			}
		}

		return false;
	}

	start(): void {
		/*
		Nothing to open. The stream that feeds `handle()` belongs to the
		EventStream both Collectors share, and the permission preflight has
		already run by the time either is started.
		*/
	}

	stop(): void {
		/*
		Held keys are deliberately not cleared. A key held across a stop and
		start is still held — the OS never sent its keyUp — so clearing would
		count one press twice on the way back.
		*/
	}

	handle(event: KeyEvent): void {
		switch (event.type) {
			case 'keyDown': {
				this.#press(event);
				break;
			}

			case 'keyUp': {
				this.#held.delete(event.keycode);
				break;
			}

			case 'flagsChanged': {
				this.#flagsChanged(event);
			}
		}
	}
}
