# A listen-only CGEventTap works headless, from a bare binary

ADR-0002 committed to a native helper on the strength of reasoning about `uiohook-napi`'s
deadlock and the unreachable Fn bit. This records the measurement that followed, from a
~200-line Swift probe (`spike/captap.swift`, since deleted; the captures are quoted below).

Everything below was observed on macOS 26.6.2 (build 25G83), arm64, with the probe run as a plain
executable spawned from a terminal — not an app bundle, and with no `.app` anywhere in the path:

```text
executable=/Users/jwu02/.../jwoo-cli/spike/captap
isBundled=false  bundleIdentifier=""
```

## Q1 — can a plain executable hold a listen-only tap? Yes.

`CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, …)`
returned a live tap, and events arrived from a process launched the normal way, from a shell.
Apple's warning that background-only helpers can fail to create a tap even _with_ Accessibility
granted — the risk ADR-0002 flagged, and the reason this spike exists — did not materialise for a
listen-only tap in the session event tap. **The helper does not need to ship inside an app
bundle.** ADR-0002's packaging decision stands.

## Q2 — is Fn/Globe observable? Yes, as `flagsChanged` on keycode 63.

Four clean press/release pairs were captured. Pressing Fn alone produces _no_ `keyDown` or `keyUp`
at all — only `flagsChanged`:

```text
flagsChanged kc=63 flagsRaw=0x800100 bits=SecondaryFn,NonCoalesced secFn=true
flagsChanged kc=63 flagsRaw=0x000100 bits=NonCoalesced              secFn=false
```

Note the second line: on **release**, `SecondaryFn` is clear while the keycode is still 63. A
consumer that only reads `keycode == 63` cannot tell press from release; it must read the flag.
And `kCGEventFlagMaskSecondaryFn` is `0x00800000`, which is also the bit macOS reports here.

## Q3 — is that distinguishable from the F1–F12 flag? Yes, but not by flags alone.

Pressing F1, F2, F3 with Fn _not_ held produced:

```text
keyDown kc=122 flagsRaw=0x800100 bits=SecondaryFn,NonCoalesced secFn=true   (F1)
keyDown kc=120 flagsRaw=0x800100 bits=SecondaryFn,NonCoalesced secFn=true   (F2)
keyDown kc=99  flagsRaw=0x800100 bits=SecondaryFn,NonCoalesced secFn=true   (F3)
```

**The raw flags are identical to a bare Fn press — `0x800100`, same bits set.** This is the trap
the issue anticipated: macOS sets `kCGEventFlagMaskSecondaryFn` for F-keys whether or not Fn is
physically down, so nothing that inspects flags alone can tell "user pressed Fn" from "user pressed
F1". The two cases differ only in event type and keycode:

|            | event type     | keycode |
| ---------- | -------------- | ------- |
| Fn pressed | `flagsChanged` | 63      |
| F1 pressed | `keyDown`      | 122     |

So the rule for the helper is: **Fn is keycode 63 on a `flagsChanged` event.** Never a `keyDown`,
and never identified by the flag bit.

## Q4 — does the tap survive, or get disabled by timeout? Yes, it survives.

Two captures, neither recording any `kCGEventTapDisabledByTimeout` or `ByUserInput`:

- 70 seconds under continuous human mouse movement (757 events) and scrolling (572 events).
- ~200 seconds under a synthetic keypress every 2 seconds, which logged 154 events. Those
  arrived spread across the whole run rather than bunched at the start, so the tap was still
  delivering at the end, not merely still running.

The first soak attempt here proved nothing, and is worth recording as a method error: it ran with
no input at all, so an idle tap and a silently disabled one produced identical logs — a heartbeat
alone only proves the process is alive. A soak has to keep events _flowing_ and confirm they
arrive late in the run.

## Q5 — which TCC permission is demanded?

Input Monitoring alone. `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)` returned `granted`, and
`AXIsProcessTrusted()` / `CGPreflightListenEventAccess()` / `CGPreflightPostEventAccess()` all
returned `true`; Accessibility was never granted for the probe. This confirms the listen-only tap
needs the lighter ask, as ADR-0002 claimed.

**But one thing this spike could not establish.** The grant was _already_ present before the probe
ran, and it followed the binary to a path TCC had never seen — a copy of the same executable at
`/tmp/freshpath/captap` reported `granted` and created a tap without any prompt. If the grant
attached to the helper path, as ADR-0002 asserts, a brand-new path should have prompted.

That means the grant is most likely attributed to an ancestor process (the terminal, or a parent
app) and inherited, rather than resolved per-helper-path. If so, ADR-0002's stated reason for
preferring a committed prebuilt binary over a `node` shim — "nvm and fnm change the resolved
`node` path on every version bump, silently invalidating the grant" — does not hold, because the
grant is not attached to a path in the first place.

Two caveats before anyone acts on that: the TCC database could not be read to confirm the
attribution (`sqlite3` returns "authorization denied" without Full Disk Access), and the reverse
test — revoking Input Monitoring for the granted app and re-running the probe — was not performed,
because it needs an interactive change in System Settings. **Until that test is run, the
attribution is an inference, not a finding.** The packaging decision does not depend on it, but
the permission-preflight design in #8 does: if the grant is inherited from the parent process,
a preflight check must ask which process actually holds it.

## Consequences

- The helper is a bare binary. No app bundle, no `NSWorkspace` launch. This was the one outcome
  that would have forced a redesign, and it did not happen.
- Fn is read as keycode 63 on `flagsChanged`, with press/release taken from the
  `SecondaryFn` flag — not from the keycode's presence.
- No consumer may infer Fn from `kCGEventFlagMaskSecondaryFn` alone. F1–F12 set the same bit.
- The permission preflight in #8 should be written against `IOHIDCheckAccess`, not
  `AXIsProcessTrusted` or `CGPreflightPostEventAccess`, which the spike recorded as agreeing with
  it only because the grant was present.
- The grant's attribution is unresolved. Resolve it with a revoke-and-retry before relying on
  helper-path stability anywhere.
