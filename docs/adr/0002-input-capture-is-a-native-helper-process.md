# Input capture is a native helper process, not a Node input library

There is no workable Node equivalent of `pynput` for a headless CLI. `uiohook-napi` — the only
maintained option — has an open, unpatched deadlock on macOS in plain Node: its darwin key path
dispatches synchronously onto the GCD main queue, which a Node main thread never drains. The
symptom is that it works for exactly one keystroke and then goes permanently silent, and it
affects precisely the daemon/CLI case. It also installs an _active_ event tap, requiring full
Accessibility rather than Input Monitoring.

Separately, the Fn/Globe key is unreachable from Node at all: `kCGEventFlagMaskSecondaryFn` is
never read by the underlying library, and its public event struct has all 16 mask bits allocated,
so exposing it would be an ABI fork rather than a patch.

So a small Swift/ObjC helper owns a listen-only `CGEventTap` and streams JSON over stdio. Because
the helper is required regardless, it handles all input capture rather than just Fn. The prebuilt
binary and its source are committed; requiring Xcode command line tools on install would make the
repo impossible to clone and run.

## Consequences

- The TCC grant attaches to a stable helper path instead of the `node` binary. This matters: nvm
  and fnm change the resolved `node` path on every version bump, silently invalidating the grant.
- A listen-only tap needs only Input Monitoring, a much lighter ask than Accessibility.
- Observing Fn is possible; synthesising it is not. macOS discards userland-posted Fn events.
- The helper needs a one-time interactive permission grant. A background job cannot answer a TCC
  prompt, so first run must be at the keyboard.
