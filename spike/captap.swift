// Throwaway probe for issue #3: prove a listen-only CGEventTap works headless.
//
// Answers, in order:
//   Q5  which TCC permission tap creation actually demands
//   Q1  whether a plain shell-spawned executable can hold a tap at all
//   Q2  whether Fn/Globe (keycode 63) is observable via kCGEventFlagMaskSecondaryFn
//   Q3  whether that flag is distinguishable from the 0x800000 macOS sets for F1-F12
//   Q4  whether the tap survives, or gets disabled by timeout
//
// Build: swiftc -O spike/captap.swift -o spike/captap
// Run:   ./spike/captap [seconds]     (default 60)
//
// stdout is machine-readable JSON, one event per line. stderr is human status.

import Cocoa
import IOKit.hid

// MARK: - Constants

let fnKeyCode: Int64 = 63

// kIOHIDRequestTypeListenEvent. These C enums import as raw-value structs in
// Swift 6 rather than as Swift enums, so they are spelled as raw values.
let listenEvent = IOHIDRequestType(rawValue: 1)

// Q3: the only flag bit with a name we can rely on here is
// kCGEventFlagMaskSecondaryFn. Everything else is emitted as the raw mask, so
// the Fn-vs-F1-F12 comparison is made against real bits rather than against
// our guesses about which bit is which.
let secondaryFnMask: UInt64 = 0x0080_0000  // kCGEventFlagMaskSecondaryFn

/// Names of the flag bits worth calling out by name in the log. Values are
/// taken from the SDK's IOLLEvent.h (NX_*MASK), not from memory: a wrong name
/// here would hide the very difference Q3 is looking for.
let flagBitNames: [(UInt64, String)] = [
	(0x0001_0000, "AlphaShift"),
	(0x0002_0000, "Shift"),
	(0x0004_0000, "Control"),
	(0x0008_0000, "Alternate"),
	(0x0010_0000, "Command"),
	(0x0020_0000, "NumericPad"),
	(0x0040_0000, "Help"),
	(0x0080_0000, "SecondaryFn"),
	(0x0000_0100, "NonCoalesced"),
]

// MARK: - Output helpers

/// Machine-readable line on stdout. Everything else goes to stderr so the
/// captured events can be piped straight into a diff.
func emit(_ object: [String: Any]) {
	let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
	FileHandle.standardOutput.write(data)
	FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func note(_ message: String) {
	FileHandle.standardError.write("[captap] \(message)\n".data(using: .utf8)!)
}

// MARK: - Process identity (Q1: the TCC grant attaches to a path, not a build)

let executablePath = Bundle.main.executablePath ?? CommandLine.arguments[0]
let resolvedPath = (try? FileManager.default.destinationOfSymbolicLink(atPath: executablePath)) ?? executablePath

note("pid=\(getpid())")
note("argv0=\(CommandLine.arguments[0])")
note("executable=\(resolvedPath)")
note("bundle=\(Bundle.main.bundlePath)")
note("isBundled=\(Bundle.main.bundleIdentifier != nil)")
note("os=\(ProcessInfo.processInfo.operatingSystemVersionString)")

emit([
	"kind": "process",
	"pid": getpid(),
	"executable": resolvedPath,
	"argv0": CommandLine.arguments[0],
	"bundled": Bundle.main.bundleIdentifier != nil,
	"bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
	"osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
])

// MARK: - Q5: which permission is demanded
//
// IOHIDCheckAccess is the check to trust. AXIsProcessTrusted and
// CGPreflightPostEventAccess both keep returning true after the grant is revoked.

let hidAccess = IOHIDCheckAccess(listenEvent)
// kIOHIDAccessTypeGranted = 0, Denied = 1, Unknown = 2.
let hidAccessNames = ["granted", "denied", "unknown"]
let hidAccessIndex = Int(hidAccess.rawValue)
let hidAccessName = hidAccessNames.indices.contains(hidAccessIndex)
	? hidAccessNames[hidAccessIndex]
	: "unexpected(\(hidAccessIndex))"
note("IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) = \(hidAccessName)")

// The other two, recorded deliberately so the spike can demonstrate that they
// disagree with IOHIDCheckAccess once the permission is revoked.
let axTrusted = AXIsProcessTrusted()
let listenPreflight = CGPreflightListenEventAccess()
let postPreflight = CGPreflightPostEventAccess()
note("AXIsProcessTrusted=\(axTrusted) CGPreflightListenEventAccess=\(listenPreflight) CGPreflightPostEventAccess=\(postPreflight)")

emit([
	"kind": "permissions",
	"inputMonitoring": hidAccessName,
	"inputMonitoringRaw": hidAccess.rawValue,
	"axIsProcessTrusted": axTrusted,
	"cgPreflightListenEventAccess": listenPreflight,
	"cgPreflightPostEventAccess": postPreflight,
])

// MARK: - Q1: can a plain executable hold a listen-only tap?

var eventTap: CFMachPort?
var runLoopSource: CFRunLoopSource?

/// Callback for `CGEvent.tapCreate`. The tap is listen-only, so this must return
/// the event unchanged; the return value is ignored for listen-only taps.
func tapCallback(
	proxy: CGEventTapProxy,
	type: CGEventType,
	event: CGEvent,
	refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
	// Q4: macOS disables a tap that takes too long, or on certain user input.
	// Re-enabling and logging loudly is what distinguishes "still alive" from
	// "silently stopped delivering".
	if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
		note("!! tap disabled: \(type == .tapDisabledByTimeout ? "byTimeout" : "byUserInput") — re-enabling")
		emit([
			"kind": "tapDisabled",
			"reason": type == .tapDisabledByTimeout ? "timeout" : "userInput",
		])
		if let tap = eventTap {
			CGEvent.tapEnable(tap: tap, enable: true)
		}
		return nil
	}

	guard type == .keyDown || type == .keyUp || type == .flagsChanged
		|| type == .mouseMoved || type == .leftMouseDragged || type == .rightMouseDragged
		|| type == .scrollWheel || type == .leftMouseDown || type == .rightMouseDown
		|| type == .otherMouseDown else {
		return Unmanaged.passUnretained(event)
	}

	let flags = event.flags.rawValue

	// Mouse events matter here for the same reason the keyboard ones do: the
	// helper emits raw events, and a tap that only ever sees keys would be a
	// bad foundation for the mouse Collector.
	switch type {
	case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
		let dx = event.getIntegerValueField(.mouseEventDeltaX)
		let dy = event.getIntegerValueField(.mouseEventDeltaY)
		emit([
			"kind": "event",
			"type": "\(type)",
			"deltaX": dx,
			"deltaY": dy,
		])

	case .scrollWheel:
		emit([
			"kind": "event",
			"type": "scrollWheel",
			"deltaX": event.getIntegerValueField(.scrollWheelEventDeltaAxis2),
			"deltaY": event.getIntegerValueField(.scrollWheelEventDeltaAxis1),
		])

	case .leftMouseDown, .rightMouseDown, .otherMouseDown:
		emit([
			"kind": "event",
			"type": "mouseDown",
			"button": event.getIntegerValueField(.mouseEventButtonNumber),
		])

	default:
		let keycode = event.getIntegerValueField(.keyboardEventKeycode)
		let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0

		emit([
			"kind": "event",
			"type": type == .keyDown ? "keyDown" : (type == .keyUp ? "keyUp" : "flagsChanged"),
			"keycode": keycode,
			// Raw flags plus the set bits, so Fn can be diffed against F1-F12
			// rather than assumed. Q3 lives entirely in these numbers.
			"flagsRaw": String(format: "0x%llx", flags),
			"flagBits": flagBitNames.filter { flags & $0.0 != 0 }.map(\.1),
			"secondaryFn": (flags & secondaryFnMask) != 0,
			"autorepeat": isRepeat,
			"isFnKeycode": keycode == fnKeyCode,
		])
	}

	return Unmanaged.passUnretained(event)
}

let mask =
	(1 << CGEventType.keyDown.rawValue) |
	(1 << CGEventType.keyUp.rawValue) |
	(1 << CGEventType.flagsChanged.rawValue) |
	(1 << CGEventType.mouseMoved.rawValue) |
	(1 << CGEventType.leftMouseDragged.rawValue) |
	(1 << CGEventType.rightMouseDragged.rawValue) |
	(1 << CGEventType.scrollWheel.rawValue) |
	(1 << CGEventType.leftMouseDown.rawValue) |
	(1 << CGEventType.rightMouseDown.rawValue) |
	(1 << CGEventType.otherMouseDown.rawValue)

eventTap = CGEvent.tapCreate(
	tap: .cgSessionEventTap,
	place: .headInsertEventTap,
	options: .listenOnly,  // read-only: never .defaultTap, which needs Accessibility
	eventsOfInterest: CGEventMask(mask),
	callback: tapCallback,
	userInfo: nil
)

guard let tap = eventTap else {
	// The absence of an error here is the signal: tapCreate gives no reason, so
	// the permission state printed above is the only diagnosis available.
	note("FAILED to create tap — CGEvent.tapCreate returned nil")
	emit([
		"kind": "verdict",
		"tapCreated": false,
		"inputMonitoring": hidAccessName,
		"axIsProcessTrusted": axTrusted,
	])
	exit(2)
}

note("tap created OK (listen-only, kCGSessionEventTap)")
emit([
	"kind": "verdict",
	"tapCreated": true,
	"inputMonitoring": hidAccessName,
	"axIsProcessTrusted": axTrusted,
])

runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

// MARK: - Q4: heartbeat, to tell "quiet" apart from "dead"

let duration = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 60) : 60
var heartbeats = 0
let heartbeat = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
	heartbeats += 1
	note("heartbeat \(heartbeats) — alive, \(Int(duration))s budget")
	emit(["kind": "heartbeat", "n": heartbeats, "elapsed": heartbeats * 10])
}

note("listening for \(Int(duration))s — press keys now")

// A guided sequence, so the capture is attributable: each prompt names the keys
// to press, and a marker lands in the JSON at the moment the prompt is shown.
// Without this, the log is an unattributable stream of keycodes.
let script: [(Double, String)] = [
	(2, "press Fn (Globe) alone, 3 times"),
	(10, "press F1, F2, F3"),
	(20, "hold Fn and press F1"),
	(30, "press A, then Return"),
	(40, "move the mouse in circles"),
	(50, "scroll the wheel up and down"),
]

for (offset, instruction) in script where offset < duration {
	DispatchQueue.main.asyncAfter(deadline: .now() + offset) {
		note(">>> \(instruction)")
		emit(["kind": "marker", "at": offset, "instruction": instruction])
	}
}

DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
	heartbeat.invalidate()
	emit(["kind": "summary", "heartbeats": heartbeats, "seconds": Int(duration)])
	note("done")
	exit(0)
}

CFRunLoopRun()
