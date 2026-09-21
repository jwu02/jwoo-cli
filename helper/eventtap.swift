/*
The native capture helper.

Node cannot observe global input on macOS for this use case: the one maintained
library deadlocks in a plain Node main thread, and the Fn/Globe key is
unreachable from Node entirely because nothing reads kCGEventFlagMaskSecondaryFn
(ADR-0002). So this owns a listen-only CGEventTap and prints one JSON event per
line to stdout.

It emits RAW events and nothing else — keycode, modifier flags, timestamp, and
mouse position and button. No counting, no keycode-to-character mapping, no
aggregation. Every rule that turns this stream into Key Counts — uppercasing
printables, the UK shifted and Option symbol tables, de-duplicating auto-repeat,
treating a modifier change as a release-then-press — lives in TypeScript, where
it can be tested against synthetic events on any machine (ADR-0003). This file
does not know what a Key Label is.

Two things measurement settled that the code below depends on (ADR-0006):

  - Fn is keycode 63 on a `flagsChanged` event, and pressing it alone produces
    no keyDown or keyUp at all. On release the SecondaryFn bit is CLEAR while
    the keycode is still 63, so press and release are told apart by the flag,
    never by the keycode's presence.
  - F1-F12 set SecondaryFn too. Their raw flags are byte-identical to a bare Fn
    press. So nothing downstream may infer Fn from the flag bit; event type plus
    keycode is the only discriminator. That is why `flagsRaw` is passed through
    uninterpreted rather than decoded here.

Build: ./build.sh
Run:   ./bin/eventtap
*/

import Cocoa
import Darwin
import IOKit.hid

// MARK: - Constants

/*
kIOHIDRequestTypeListenEvent. These C enums import into Swift as raw-value
structs rather than as Swift enums, so there is no `.listenEvent` to name and
the raw values are spelled out.
*/
let listenEvent = IOHIDRequestType(rawValue: 1)

// kIOHIDAccessType{Granted,Denied,Unknown}. IOHIDCheckAccess is the check to
// trust: AXIsProcessTrusted and CGPreflightPostEventAccess both keep returning
// true after the grant is revoked (ADR-0006).
let accessGranted = IOHIDAccessType(rawValue: 0)
let accessDenied = IOHIDAccessType(rawValue: 1)

/*
The events this helper forwards.

Key down/up and Fn's flagsChanged, plus pointer travel and button presses.
Scroll wheel is deliberately absent: nothing in Telemetry State tracks
scrolling, so emitting it would be a field with no consumer.

Dragged mouse events are folded into `mouseMoved` by the callback, because
pointer travel is pointer travel — the collector accumulates distance and does
not care which button was held.
*/
let eventMask: CGEventMask =
	(1 << CGEventType.keyDown.rawValue)
	| (1 << CGEventType.keyUp.rawValue)
	| (1 << CGEventType.flagsChanged.rawValue)
	| (1 << CGEventType.mouseMoved.rawValue)
	| (1 << CGEventType.leftMouseDragged.rawValue)
	| (1 << CGEventType.rightMouseDragged.rawValue)
	| (1 << CGEventType.leftMouseDown.rawValue)
	| (1 << CGEventType.rightMouseDown.rawValue)
	| (1 << CGEventType.otherMouseDown.rawValue)

// MARK: - The wire format

enum MouseButton: String {
	case left
	case right
	case other

	/*
	CGMouseButton is 0 for left and 1 for right. Anything else folds to
	`other` and the collector ignores it, which matches `_on_click` in the
	Python original: it counts left and right and drops everything else.
	*/
	init(buttonNumber: Int64) {
		switch buttonNumber {
		case 0: self = .left
		case 1: self = .right
		default: self = .other
		}
	}
}

/*
A raw event, decoupled from CGEvent so that `--self-check` can drive the
serialiser without a tap, a run loop, or a permission grant.

`timestampNs` is the raw CGEvent timestamp, carried through rather than
reinterpreted.
*/
enum RawEvent {
	case keyDown(timestampNs: UInt64, keycode: Int64, flagsRaw: UInt64)
	case keyUp(timestampNs: UInt64, keycode: Int64, flagsRaw: UInt64)
	case flagsChanged(timestampNs: UInt64, keycode: Int64, flagsRaw: UInt64)
	case mouseMoved(timestampNs: UInt64, x: Int64, y: Int64)
	case mouseDown(
		timestampNs: UInt64, x: Int64, y: Int64, button: MouseButton)
	case mouseUp(timestampNs: UInt64, x: Int64, y: Int64, button: MouseButton)

	var document: [String: Any] {
		switch self {
		case let .keyDown(timestampNs, keycode, flagsRaw):
			return [
				"type": "keyDown", "timestampNs": timestampNs,
				"keycode": keycode, "flagsRaw": flagsRaw,
			]
		case let .keyUp(timestampNs, keycode, flagsRaw):
			return [
				"type": "keyUp", "timestampNs": timestampNs,
				"keycode": keycode, "flagsRaw": flagsRaw,
			]
		case let .flagsChanged(timestampNs, keycode, flagsRaw):
			return [
				"type": "flagsChanged", "timestampNs": timestampNs,
				"keycode": keycode, "flagsRaw": flagsRaw,
			]
		case let .mouseMoved(timestampNs, x, y):
			return [
				"type": "mouseMoved", "timestampNs": timestampNs, "x": x, "y": y,
			]
		case let .mouseDown(timestampNs, x, y, button):
			return [
				"type": "mouseDown", "timestampNs": timestampNs, "x": x,
				"y": y, "button": button.rawValue,
			]
		case let .mouseUp(timestampNs, x, y, button):
			return [
				"type": "mouseUp", "timestampNs": timestampNs, "x": x,
				"y": y, "button": button.rawValue,
			]
		}
	}
}

// MARK: - Output

/*
stdout carries the event stream and nothing else, so a consumer can pipe it
straight into a parser. Diagnostics — including tap re-enables and permission
failures — go to stderr.

Written with a raw write rather than `print`, because `print` goes through
stdio, which is block-buffered once stdout is a pipe rather than a terminal —
the reader that spawned us would see nothing for minutes at a time. The newline
goes in the same write as the payload, so a reader can never see a torn line
split across two syscalls.
*/
func emit(_ document: [String: Any]) {
	guard
		let data = try? JSONSerialization.data(
			withJSONObject: document, options: [])
	else {
		return
	}

	var line = data
	line.append(0x0A)

	line.withUnsafeBytes { raw in
		let base = raw.baseAddress!.assumingMemoryBound(to: UInt8.self)
		let count = raw.count
		var offset = 0

		while offset < count {
			let written = write(1, base + offset, count - offset)

			if written > 0 {
				offset += written
				continue
			}

			if written < 0 && errno == EINTR {
				continue
			}

			// EPIPE or EBADF means the CLI that spawned us has gone. There is
			// nobody left to report to, and nothing worth staying alive for.
			exit(0)
		}
	}
}

func emit(_ event: RawEvent) {
	emit(event.document)
}

/*
One shape for every failure, so the consumer has a single error path and never
has to decide whether silence meant "no input" or "no permission".
*/
func emitError(code: String, message: String) {
	emit(["type": "error", "code": code, "message": message])
}

// MARK: - Permissions

/*
IOHIDAccessType, and the name for it. `unknown` is a real third state rather
than a stand-in for denied: TCC answers it before it has a record either way.
*/
func accessName(_ access: IOHIDAccessType) -> String {
	switch access {
	case accessGranted: return "granted"
	case accessDenied: return "denied"
	default: return "unknown"
	}
}

/*
The grant, as the CLI's preflight needs it.

`IOHIDCheckAccess` rather than `AXIsProcessTrusted` or
`CGPreflightPostEventAccess`, which the spike in ADR-0006 recorded as agreeing
with it only because the grant happened to be present. It is queried silently:
nothing here prompts, because the caller may be installing or starting without
anyone at the keyboard.
*/
func preflight() {
	let access = IOHIDCheckAccess(listenEvent)
	let name = accessName(access)

	/*
	A denied or unknown grant is the CLI's normal case to report on, not this
	process's failure: the exit code is 0 whatever the answer. Only an
	unrecognised answer would be worth a non-zero code, and there is none —
	`accessName` has a case for every value.
	*/
	emit([
		"type": "preflight",
		"inputMonitoring": name,
		"message": access == accessGranted
			? "Input Monitoring is granted."
			: "Input Monitoring is \(name) for this helper. Grant it in System Settings > Privacy & Security > Input Monitoring.",
	])
}

func note(_ message: String) {
	FileHandle.standardError.write(Data("[eventtap] \(message)\n".utf8))
}

// MARK: - Reading a CGEvent

func rawEvent(from event: CGEvent, type: CGEventType) -> RawEvent? {
	let timestampNs = event.timestamp
	let flagsRaw = event.flags.rawValue
	let keycode = event.getIntegerValueField(.keyboardEventKeycode)
	let location = event.location

	switch type {
	case .keyDown:
		return .keyDown(
			timestampNs: timestampNs, keycode: keycode, flagsRaw: flagsRaw)
	case .keyUp:
		return .keyUp(
			timestampNs: timestampNs, keycode: keycode, flagsRaw: flagsRaw)
	case .flagsChanged:
		return .flagsChanged(
			timestampNs: timestampNs, keycode: keycode, flagsRaw: flagsRaw)
	case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
		return .mouseMoved(
			timestampNs: timestampNs,
			x: Int64(location.x),
			y: Int64(location.y))
	case .leftMouseDown, .rightMouseDown, .otherMouseDown:
		return .mouseDown(
			timestampNs: timestampNs,
			x: Int64(location.x),
			y: Int64(location.y),
			button: MouseButton(
				buttonNumber: event.getIntegerValueField(
					.mouseEventButtonNumber)))
	case .leftMouseUp, .rightMouseUp, .otherMouseUp:
		return .mouseUp(
			timestampNs: timestampNs,
			x: Int64(location.x),
			y: Int64(location.y),
			button: MouseButton(
				buttonNumber: event.getIntegerValueField(
					.mouseEventButtonNumber)))
	default:
		return nil
	}
}

// MARK: - The tap

/*
Held at file scope because the callback needs it to re-enable the tap. macOS
disables a tap that takes too long or on certain user input, and a silently
disabled tap looks exactly like an idle machine.
*/
var eventTap: CFMachPort?
var mainRunLoop: CFRunLoop?

func tapCallback(
	proxy: CGEventTapProxy,
	type: CGEventType,
	event: CGEvent,
	refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
	/*
	An explicit pool because this is a C callback reached through a run loop
	source, not a dispatch block, so it does not get libdispatch's per-block
	pool and the run loop does not drain one per iteration. Serialising an
	event allocates; without this, a long run grows without bound.
	*/
	autoreleasepool {
		if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
			note(
				"tap disabled (\(type == .tapDisabledByTimeout ? "timeout" : "userInput")) — re-enabling"
			)
			if let tap = eventTap {
				CGEvent.tapEnable(tap: tap, enable: true)
			}
		} else if let raw = rawEvent(from: event, type: type) {
			emit(raw)
		}
	}

	// Listen-only: the event is being observed, not consumed, and the return
	// value is ignored either way.
	return Unmanaged.passUnretained(event)
}

// MARK: - Modes

/*
Print one of each event type and exit, without creating a tap.

This exists because there is no Swift test harness in this repo and no Xcode
command line tools on a fresh clone, so the wire format would otherwise have no
way to be checked without a live tap and a granted permission. It is the same
seam the Python suite used: drive the callbacks directly, with no OS involved.
*/
func selfCheck() {
	/*
	The mask is a hand-built bit set, and Swift's `<<` masks its shift amount
	the way C's does not — so an event type whose raw value exceeded the width
	would silently set the wrong bit rather than fail. Pinning the expected
	value catches that, and catches a type accidentally added or dropped.

	0x0E001CFE is keyDown(10), keyUp(11), flagsChanged(12), mouseMoved(5),
	leftMouseDragged(6), rightMouseDragged(7), leftMouseDown(1),
	rightMouseDown(3) and otherMouseDown(25).
	*/
	assert(eventMask == 0x0E00_1CFE, "event mask drifted: \(eventMask)")

	/*
	Sample values. A real CGEvent's timestamp is nanoseconds since boot; these
	are placeholders, because the point of this mode is the shape of the line,
	not the clock.
	*/
	let stamp: UInt64 = 1_234_567_890

	emit(RawEvent.keyDown(timestampNs: stamp, keycode: 0, flagsRaw: 0x100))
	emit(RawEvent.keyUp(timestampNs: stamp, keycode: 0, flagsRaw: 0x100))
	// Fn alone, as measured: flagsChanged on keycode 63, SecondaryFn set.
	emit(
		RawEvent.flagsChanged(
			timestampNs: stamp, keycode: 63, flagsRaw: 0x0080_0100))
	emit(RawEvent.mouseMoved(timestampNs: stamp, x: 100, y: 200))
	emit(
		RawEvent.mouseDown(
			timestampNs: stamp, x: 100, y: 200, button: .left))
	emit(RawEvent.mouseUp(timestampNs: stamp, x: 100, y: 200, button: .left))
	emitError(code: "inputMonitoringDenied", message: "sample error line")
}

// MARK: - Entry point

func usage() -> Never {
	FileHandle.standardError.write(
		Data(
			"""
			usage: eventtap [--self-check] [--preflight] [--request]

			  (no flags)    stream raw input events as JSON lines on stdout
			  --self-check  print one sample of each event type and exit
			  --preflight   report the Input Monitoring grant and exit
			  --request     ask macOS for Input Monitoring, then stream

			"""
				.utf8))
	exit(2)
}

/*
Ctrl-C has to stop the run loop rather than kill the process. The handler is a
plain C function rather than a DispatchSourceSignal for one reason: it calls
CFRunLoopStop on ANOTHER thread's run loop, which is the documented thread-safe
way to stop one, and is safer than the alternatives. A dispatch source would
have to be scheduled on the run loop that is currently blocked inside
CFRunLoopRun(), and DispatchQueue.main is not drained there — the run loop is
not a dispatch queue.

The default disposition has to be cleared first, or the signal terminates the
process before the handler is reached.
*/
func stopOnSignal(_ number: Int32) {
	signal(number, SIG_IGN)
	signal(number) { _ in
		if let runLoop = mainRunLoop {
			CFRunLoopStop(runLoop)
		}
	}
}

/*
The parent going away closes our stdout. That raises SIGPIPE on the next write,
whose default disposition kills the process before any of the above runs — and
which would look like a tap crash rather than an orderly shutdown. Ignored here;
the failed write itself is what notices and exits (see `emit`).
*/
signal(SIGPIPE, SIG_IGN)

let arguments = Set(CommandLine.arguments.dropFirst())
let knownArguments: Set<String> = ["--self-check", "--preflight", "--request"]
guard arguments.isSubset(of: knownArguments) else {
	usage()
}

/*
Both report-only modes exit here, before a run loop or a tap exists. Neither
can prompt, which is what lets the CLI ask on a startup path with no one at the
keyboard to answer a TCC dialog.
*/
if arguments.contains("--self-check") {
	selfCheck()
	exit(0)
}

if arguments.contains("--preflight") {
	preflight()
	exit(0)
}

mainRunLoop = CFRunLoopGetCurrent()

/*
--request is the only path that prompts. A background job cannot answer a TCC
prompt, so first run has to be at the keyboard (ADR-0002); everything else
queries silently.
*/
if arguments.contains("--request") {
	note("requesting Input Monitoring — macOS should be showing a prompt")
	CGRequestListenEventAccess()
}

let access = IOHIDCheckAccess(listenEvent)
let name = accessName(access)

note("Input Monitoring: \(name)")

guard access == accessGranted else {
	emitError(
		code: "inputMonitoringDenied",
		message:
			"Input Monitoring is \(name) for this helper. Grant it in System Settings > Privacy & Security > Input Monitoring, then run again."
	)
	exit(2)
}

/*
.cgSessionEventTap is the call the spike measured as working from a bare
executable, with no app bundle (ADR-0006). The Python original's Fn watcher
used kCGHIDEventTap instead, so the two records disagree; if Fn stops arriving,
switching the location is the first thing to try.
*/
eventTap = CGEvent.tapCreate(
	tap: .cgSessionEventTap,
	place: .headInsertEventTap,
	// Read-only. The default tap would need Accessibility, a much heavier ask.
	options: .listenOnly,
	eventsOfInterest: eventMask,
	callback: tapCallback,
	userInfo: nil)

guard let tap = eventTap else {
	/*
	tapCreate gives no reason, so the permission state above is the only
	diagnosis there is. It returns nil even when the preflight said granted,
	which is the case worth calling out: the grant is attributed to an
	ancestor process and inherited rather than resolved per helper path, and
	that is not yet confirmed (ADR-0006).
	*/
	emitError(
		code: "tapCreationFailed",
		message:
			"CGEvent.tapCreate returned nil with Input Monitoring \(name). The tap could not be created."
	)
	exit(3)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(mainRunLoop, runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

stopOnSignal(SIGINT)
stopOnSignal(SIGTERM)

note("listening — raw events on stdout, diagnostics on stderr")
CFRunLoopRun()
