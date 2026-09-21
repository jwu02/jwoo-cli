# Spike: does a listen-only CGEventTap work headless?

Throwaway probe for [#3](https://github.com/jwu02/jwoo-cli/issues/3). It answers the five
questions in that issue, then gets deleted — the verdict lands in `docs/adr/`.

## Build and run

```console
$ swiftc -O spike/captap.swift -o spike/captap
$ ./spike/captap 70
```

Takes a duration in seconds (default 60). stdout is one JSON object per line — events, markers,
heartbeats. stderr is human-readable status. They are separate so the event stream can be piped
or diffed without the chatter.

The probe walks a fixed script on a timer, printing each prompt to stderr and a matching
`{"kind":"marker"}` line to stdout, so every captured event is attributable to a specific
instruction rather than being an unattributable stream of keycodes.

## What it records

- **Process identity and permission state** up front: `pid`, resolved executable path, whether it
  is bundled, and the answers from `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)`,
  `AXIsProcessTrusted()`, `CGPreflightListenEventAccess()` and `CGPreflightPostEventAccess()`.
  The last three are recorded precisely so they can be shown to disagree with `IOHIDCheckAccess`.
- **Raw event data**: for `keyDown` / `keyUp` / `flagsChanged`, the keycode, the raw `flags` as
  hex, the names of the set flag bits, and `isFnKeycode` (keycode 63). For mouse events, deltas,
  button number, and scroll axes.
- **A heartbeat every 10s** and a `tapDisabled` line if macOS disables the tap. Together these
  separate "nothing is happening" from "the tap silently died".

## Caveats

- Permission checks are only meaningful before the grant exists. On a machine where Input
  Monitoring is already granted for this path, `Q5` cannot be answered from a run — the grant has
  to be revoked in System Settings first.
- macOS discards userland-posted Fn events, so `Q2`/`Q3` (Fn/Globe) require real keypresses. The
  `osascript`-synthesised keystrokes used to smoke-test the tap will not exercise Fn.
- The flag-bit names are transcribed from the SDK's `IOLLEvent.h` (`NX_*MASK`). An earlier
  revision of this file had them wrong, which silently mislabelled every modifier; if you extend
  the table, check it against the header rather than writing it from memory.
