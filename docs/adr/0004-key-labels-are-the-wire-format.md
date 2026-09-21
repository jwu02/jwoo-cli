# Key Labels are the wire format between this CLI and the website

Key Count Documents use Key Labels as dynamic top-level field names — `{"createdAt": Date,
"Return": 12, "Left Cmd": 3}` — and `jwoo/lib/telemetry/key-layout.ts` maps those labels onto
Physical Keys. That map discards any label it does not recognise, **without error**.

A normalised shape (`{createdAt, keys: [{label, count}]}`) would be better, and the reader sums
every top-level field except `_id` and `createdAt`, so a stray metadata field on a Key Count
Document silently registers as a key with a large count. We deferred the reshape anyway: changing
the language and the storage schema in one move makes it impossible to tell which change broke
the heatmap.

The practical consequence is that the label vocabulary is a contract, not an implementation
detail. `activity-telemetry-client/telemetry/keymap.py` is dead code on the Python side but its
tables are the authoritative list the website's comment cites, and it must be ported exactly.

## Consequences

- Renaming or adding a label requires a matching change in `jwoo/lib/telemetry/key-layout.ts`, or
  it vanishes from the heatmap with no error anywhere.
- Keep the label tables tested and treat them as a wire format, not as lookup helpers.
- Key Counts must stay flat numeric scalars; nesting a value breaks the reader's `$sum`.
- `createdAt` must remain a real BSON Date.
