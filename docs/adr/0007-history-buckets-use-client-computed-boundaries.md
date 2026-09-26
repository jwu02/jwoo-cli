# The history view hands MongoDB explicit bucket boundaries

> **Status note (2026-09-25).** ADR-0012 retires the MongoDB read this ADR was written for: the
> history view now reads the Local Store and groups in JavaScript. What survives is the
> principle this ADR records — the boundary list is the bucket identity, computed by
> `bucketBoundaries` in one place — and `ranges.ts` is unchanged.

The website buckets its time series with `$dateTrunc` given a `timezone` name, and generates the
matching bucket keys client-side in `jwoo/lib/timezone.ts` (`generateBuckets` → `alignToInterval`
→ `addInterval`). That works, and we did not copy it. The reader in `source/aggregation.ts` uses
`$bucket` with a boundary list the client computes instead.

The reason is that the website's approach makes bucket identity an _agreement_ between two
implementations — one in MongoDB's C++ (with ICU), one in JavaScript (with `Intl`) — and this
CLI cannot hold up its half of that agreement. Two things break it.

## A local day is not always 24 hours

`generateBuckets` walks from the range start to `now`, stepping one unit at a time **in wall-clock
space**: it reads the local fields, adds an hour, and re-resolves to an instant. On the day the
clocks go back, the local hour is repeated, so a walk that emits `00:00, 01:00, 02:00 … 23:00` for
a 25-hour day emits 24 keys and silently covers 25 hours of instants. `$dateTrunc` on the server
has no such trouble — it happily produces 25 distinct hour keys, one of them for the hour the
client never generated. Documents bucketed under that 25th key match no key in the client's list,
so they are **dropped from the chart while still counting in the totals**, on the one day of the
year a user is most likely to look at an hourly chart and wonder why the morning has a hole in it.

`alignToInterval`'s comment anticipates part of this — "only a timezone whose DST transition lands
on midnight could shift a bucket by an hour, which this app's fixed-offset deployment never hits."
The conclusion is right for the website and for a reason narrower than the comment gives: what
saves it is not that the transitions avoid midnight, it is that the deployment's zone has no
transitions at all. That premise does not transfer. This CLI reads on the author's laptop, in
`Europe/London`, where the transition lands at 01:00 local and the day is 25 hours long either way.
A fixed-offset deployment is not a property of the _algorithm_.

## The timezone name is not reliably a name

`Intl.DateTimeFormat().resolvedOptions().timeZone` is typed `string`, but it is not one:

```text
TZ=""           -> "Etc/Unknown"     (an ICU invention; Intl itself rejects it)
TZ="Bogus/Zone" -> undefined         (typed `string`; not a string)
```

Either value reaching `$dateTrunc`'s `timezone` is a hard query failure. "Etc/Unknown" in
particular is the worst shape of wrong: it looks like a tzdb identifier, it is not in tzdb, and
nothing in the type system objects.

## The decision

Hand `$bucket` the boundaries, computed by `bucketBoundaries(range, now, timeZone)`:

```text
$match  {createdAt: {$gte: boundaries[0], $lt: boundaries.at(-1)}}
$bucket {groupBy: "$createdAt", boundaries, default: "out-of-range", output: {…$sum}}
$sort   {_id: 1}
```

Display bucket `i` is `[b[i], b[i+1])`, so **the boundary list is the bucket identity**. There is
one owner, nothing to keep in agreement, and no timezone name crosses the wire — which retires
the whole "is this string a zone" failure class rather than validating against it.

Boundaries are stepped in wall-clock space too, but that is now the _only_ implementation, so it
cannot disagree with itself. `nextBoundary` advances the local fields by one unit and re-resolves
to an instant with a two-pass offset lookup (`instantFromLocalFields`); it tries a step of one
unit and then two, because on a fall-back day `01:00` is ambiguous and the first reading can land
back on `from`. On `Europe/London`'s fall-back day this yields a 24-bucket list for a 25-hour day
with one bucket two hours wide — a bar that is one column wider than its neighbours, rather than
an hour of data that vanishes. On spring-forward the nonexistent local hour is skipped and the
list is one short. Both are asserted in `source/store/ranges.test.ts`.

## Consequences

- A client bug in the stepping degrades to a **wrongly-shaped bar, not lost data**, because the
  series still sums to the totals. `source/history.test.ts` asserts that sum against the totals
  query rather than against a fixture.
- A boundary is defined in one place. `source/store/ranges.ts` owns both where a range starts and
  how it steps, and nothing on the server encodes a bucket boundary, so moving one needs no deploy.
  Adding a third Range is **not** local, though — the view labels it and `app.tsx` binds a key
  to it, and neither reads that off `ranges.ts`.
- Anything landing outside `boundaries[0..last]` is returned under the sentinel `_id`
  `'out-of-range'` and dropped with a warning rather than rendered as a bucket named after it.
  `$bucket`'s `default` is per-query, so this catches a `$match`/boundary mismatch rather than a
  clock skew that could not happen — the `$match` and the boundaries come from the same list.
- The reader is range-scoped where the website is not: totals and Key Counts get the same
  `createdAt` `$match` as the series. The website's all-time totals cannot answer "Today".
- The website keeps its approach. Rewriting it is not proposed here; this records why the CLI
  diverges, so a future reader does not "fix" the divergence by porting `generateBuckets`.
