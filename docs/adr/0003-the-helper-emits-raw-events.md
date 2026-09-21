# The native helper emits raw events; all counting stays in TypeScript

The helper sends keycode, modifier flags, and timestamp — nothing aggregated. Every rule that
turns that stream into Key Counts lives in TypeScript: uppercasing printables, the UK shifted and
Option symbol tables, de-duplicating key auto-repeat so holding a key counts once, and treating a
modifier change as a release-then-press.

The alternative was to aggregate in Swift and send periodic summaries, which is cheaper on IPC
and would make the helper self-contained. It was rejected because it moves those rules — the
subtlest behaviour in the system, and the part most likely to regress — into a language with no
test harness in this repo, and eliminates the Python suite's best property: that the keyboard
rules are tested against synthetic events on any machine, with no OS listeners and no real input.

The volume is a non-issue at single-user scale.

## Consequences

If the event stream between helper and CLI becomes a performance problem, fix the transport, not
the division of labour.
