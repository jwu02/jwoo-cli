/*
The Mouse Collector: click counts and pointer travel.

A plain module with `start()`/`stop()` that imports nothing from React
(ADR-0001), fed through `handle()` the same way the Keyboard Collector is.

Distance is accumulated in *pixels* and DPI is deliberately not applied here:
`TelemetryState.addMouseMovement` owns that conversion, so there is one place
that turns pointer travel into Mouse Distance rather than two that could
disagree (CONTEXT.md).
*/

import {type TelemetryState} from '../state.js';
import {type MouseButton, type RawEvent} from './raw-event.js';

/*
No DPI here, and its absence is deliberate rather than an omission: the
Collector contributes pixels and Telemetry State owns the conversion, so the two
cannot disagree about what a pixel is worth.
*/
export type MouseCollectorOptions = {
	readonly state: TelemetryState;
};

/*
The buttons that are counted. `other` is every button that is neither — a
middle click, a side button — and it is dropped rather than bucketed, which is
what the Python original's `_on_click` did.
*/
const COUNTED: ReadonlySet<MouseButton> = new Set<MouseButton>([
	'left',
	'right',
]);

export class MouseCollector {
	readonly #state: TelemetryState;
	/*
	The previous position, or `undefined` until the first move. Distance needs
	two points, so the first move after a start establishes a baseline and
	contributes nothing — moving the pointer from an unknown place to a known
	one is not travel that was observed.
	*/
	#last: {x: number; y: number} | undefined;

	constructor({state}: MouseCollectorOptions) {
		this.#state = state;
	}

	#click(button: MouseButton): void {
		if (!COUNTED.has(button)) {
			return;
		}

		if (button === 'left') {
			this.#state.addLeftClick();
			return;
		}

		this.#state.addRightClick();
	}

	/*
	Euclidean distance rather than a component-wise sum, so a diagonal movement
	measures what it travelled instead of the longer path through its corners.
	*/
	#move(x: number, y: number): void {
		const previous = this.#last;
		this.#last = {x, y};

		if (previous === undefined) {
			return;
		}

		this.#state.addMouseMovement(Math.hypot(x - previous.x, y - previous.y));
	}

	start(): void {
		// The stream belongs to the EventStream both Collectors share.
	}

	stop(): void {
		/*
		The last position is kept rather than cleared, for the same reason the
		Keyboard Collector keeps its held keys: a stop and start is not a
		movement, so the next event must not measure a jump back to itself.
		*/
	}

	handle(event: RawEvent): void {
		switch (event.type) {
			case 'mouseMoved': {
				this.#move(event.x, event.y);
				break;
			}

			case 'mouseDown': {
				this.#click(event.button);
				break;
			}

			/*
			Everything else the helper can send, listed rather than folded into
			a `default`: the list is the statement that no key event moves the
			pointer and that a button release is not a click, and adding an event
			type to the wire format should have to be considered here.
			*/
			case 'keyDown':
			case 'keyUp':
			case 'flagsChanged':
			case 'mouseUp':
			case 'error':
			case 'preflight': {
				break;
			}
		}
	}
}
