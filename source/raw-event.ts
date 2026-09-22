/*
The helper's wire format, as TypeScript sees it.

`helper/eventtap.swift` prints one JSON object per line on stdout and nothing
else (ADR-0003). This is the reader for that, and the only place the shape of a
line is written down on this side — so the collectors and the stream that feeds
them both take their types from here rather than each believing its own version.

The helper emits raw events and decodes nothing: no keycode-to-character mapping,
no auto-repeat de-duplication, no aggregation. Everything below is therefore a
statement about what macOS reported, and every rule built on it lives in
`key-character.ts` and the Collectors.

`parseEventLine` returns `undefined` rather than throwing. A stream that stops on
one bad line is worse than one that skips it: the helper shares stdout with
nothing, but a diagnostic line, a torn read, or a future event type must not be
able to bring down collection.
*/

/*
A flattened visitor for unknown JSON. `typeof x === 'object'` does not narrow
away `null`, and every field below needs the same three checks, so they are
written once.
*/
function record(value: unknown): Record<string, unknown> | undefined {
	const isRecord =
		typeof value === 'object' && value !== null && !Array.isArray(value);

	return isRecord ? (value as Record<string, unknown>) : undefined;
}

/*
One integer field, or `undefined` if it is missing or is not one.

Each field is read through this rather than off the record, which is what makes
destructuring in the builders below safe: the destructured value has been
checked by the time it is bound, instead of being trusted for its name.
*/
function integer(
	event: Record<string, unknown>,
	name: string,
): number | undefined {
	const value = event[name];

	return typeof value === 'number' && Number.isSafeInteger(value)
		? value
		: undefined;
}

type BaseEvent = {
	readonly timestampNs: number;
};

export type KeyEvent = BaseEvent & {
	readonly type: 'keyDown' | 'keyUp' | 'flagsChanged';
	readonly keycode: number;
	/*
	The CGEvent flags word, passed through uninterpreted. F1-F12 set
	SecondaryFn, so this is not a reliable statement that Fn is held — ADR-0006,
	and the reason `key-character.ts` reads it only alongside a keycode.
	*/
	readonly flagsRaw: number;
};

export type MouseMovedEvent = BaseEvent & {
	readonly type: 'mouseMoved';
	readonly x: number;
	readonly y: number;
};

/*
`other` is every button that is neither left nor right. The helper folds it
rather than dropping it, and the Mouse Collector ignores it: the Python original
counted left and right and dropped the rest.
*/
export type MouseButton = 'left' | 'right' | 'other';

export type MouseButtonEvent = BaseEvent & {
	readonly type: 'mouseDown' | 'mouseUp';
	readonly x: number;
	readonly y: number;
	readonly button: MouseButton;
};

/*
A failure, in the one shape the helper uses for all of them, so a consumer never
has to tell "no input" from "no permission" by silence.

Silence is the failure mode worth naming: a helper that exits without printing
one of these leaves a stream that looks exactly like an idle machine.
*/
export type HelperError = {
	readonly type: 'error';
	readonly code: string;
	readonly message: string;
};

/*
The line `--preflight` prints. It shares the parser's shape only because it is
JSON on the same wire; `permissions.ts` owns what the answer means.

`inputMonitoring` is narrowed to the helper's own three-value vocabulary and
validated here like any other field: the set of values is what the helper can
say, not what a grant means. `unknown` is a third state rather than a polite
synonym for `denied`, and the type — not a comment beside a string — is what
keeps it one.
*/
export type PreflightEvent = {
	readonly type: 'preflight';
	readonly inputMonitoring: 'granted' | 'denied' | 'unknown';
	readonly message: string;
};

export type RawEvent =
	KeyEvent | MouseMovedEvent | MouseButtonEvent | HelperError | PreflightEvent;

const BUTTONS = new Set<string>(['left', 'right', 'other']);

/*
The helper's own vocabulary for the grant. Written here rather than in
`permissions.ts` because it describes what the helper says, not what a grant
means — and this is the one place a line's fields are validated.
*/
const PREFLIGHT_ACCESS = new Set<string>(['granted', 'denied', 'unknown']);

/*
One line of the helper's stdout, or `undefined` for anything that is not a
recognised event. Blank lines and stray diagnostics are ordinary rather than
exceptional; the helper writes its own diagnostics to stderr, but nothing
enforces that downstream.
*/
export function parseEventLine(line: string): RawEvent | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}

	const event = record(parsed);
	if (event === undefined) {
		return undefined;
	}

	switch (event['type']) {
		case 'keyDown':
		case 'keyUp':
		case 'flagsChanged': {
			return keyEvent(event, event['type']);
		}

		case 'mouseMoved': {
			return mouseMoved(event);
		}

		case 'mouseDown':
		case 'mouseUp': {
			return mouseButtonEvent(event, event['type']);
		}

		case 'error': {
			return helperError(event);
		}

		case 'preflight': {
			return preflight(event);
		}

		default: {
			return undefined;
		}
	}
}

function keyEvent(
	event: Record<string, unknown>,
	type: KeyEvent['type'],
): KeyEvent | undefined {
	const timestampNs = integer(event, 'timestampNs');
	const keycode = integer(event, 'keycode');
	const flagsRaw = integer(event, 'flagsRaw');

	return timestampNs === undefined ||
		keycode === undefined ||
		flagsRaw === undefined
		? undefined
		: {type, timestampNs, keycode, flagsRaw};
}

function mouseMoved(
	event: Record<string, unknown>,
): MouseMovedEvent | undefined {
	const timestampNs = integer(event, 'timestampNs');
	const x = integer(event, 'x');
	const y = integer(event, 'y');

	return timestampNs === undefined || x === undefined || y === undefined
		? undefined
		: {type: 'mouseMoved', timestampNs, x, y};
}

function mouseButtonEvent(
	event: Record<string, unknown>,
	type: MouseButtonEvent['type'],
): MouseButtonEvent | undefined {
	const timestampNs = integer(event, 'timestampNs');
	const x = integer(event, 'x');
	const y = integer(event, 'y');
	const {button} = event;

	/*
	A button the helper does not send is dropped rather than folded into
	`other`: `other` is the helper's own name for a real button, and letting an
	unknown string borrow it would make the two indistinguishable.
	*/
	if (
		timestampNs === undefined ||
		x === undefined ||
		y === undefined ||
		typeof button !== 'string' ||
		!BUTTONS.has(button)
	) {
		return undefined;
	}

	return {type, timestampNs, x, y, button: button as MouseButton};
}

function helperError(event: Record<string, unknown>): HelperError | undefined {
	const {code} = event;
	const {message} = event;

	return typeof code === 'string' && typeof message === 'string'
		? {type: 'error', code, message}
		: undefined;
}

function preflight(event: Record<string, unknown>): PreflightEvent | undefined {
	const {inputMonitoring} = event;
	const {message} = event;

	/*
	Both fields must be present — a missing `message` is dropped rather than
	defaulted to empty, the same rule every other field on this wire follows —
	and the access value must be one of the helper's three.
	*/
	return typeof inputMonitoring === 'string' &&
		typeof message === 'string' &&
		PREFLIGHT_ACCESS.has(inputMonitoring)
		? {
				type: 'preflight',
				inputMonitoring: inputMonitoring as PreflightEvent['inputMonitoring'],
				message,
			}
		: undefined;
}

/*
A key event from its parts, for the tests that drive the Collectors with
synthetic events (ADR-0003).

It lives here rather than in a fixture file because it belongs to this wire
format and has to move when the format does — which is the failure a copy in a
test would hide. Nothing in the Collector path calls it.

The timestamp is a placeholder: nothing counts time from it yet, and when
something does it will need a real clock rather than a default hidden here.
*/
export function keyEventAt(
	type: KeyEvent['type'],
	keycode: number,
	flagsRaw: number,
): KeyEvent {
	return {type, timestampNs: 0, keycode, flagsRaw};
}
