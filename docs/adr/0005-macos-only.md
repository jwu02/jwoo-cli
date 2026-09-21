# macOS only; Windows support is dropped

The Python original carried a real Windows path — `ctypes` `GetForegroundWindow`, process-name
tables, Win32-mocked tests. None of it is ported. Input capture is macOS-specific (see ADR-0002),
and Key Labels are always those of a UK Mac keyboard:
`activity-telemetry-client/docs/superpowers/specs/2026-08-11-cross-platform-windows-support-design.md`
already conceded that a Windows run would produce a heatmap labelled for a keyboard it was not
running on.

Keeping Windows would mean a second implementation of the riskiest module, untestable on the
machine we develop on, producing data the reader is already documented to discard.

## Consequences

Adding Windows back is a substantial piece of work, not a flag — it needs its own capture path
and its own label vocabulary, and the website would need to render a second layout.
