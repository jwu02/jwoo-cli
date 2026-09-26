import test from 'ava';
import {
	type DisabledCollector,
	type DisabledReport,
} from './capture/permissions.js';
import {
	collectionEntry,
	flushEntry,
	helperEntry,
	historyEntry,
	InProcessRunLogSource,
	type RunLogEntry,
	storageEntry,
} from './run-log.js';
import {type FlushAttempt} from './session.js';
import {type Snapshot} from './state.js';

/*
The buffer is the whole module, and the read is synchronous: there is no source
to fake and nothing to await. What an entry *says* is pinned here too, because
the text is the part a user reads and the part two views draw.
*/

/*
Appended at a distinct second each, so an assertion about order can name the
entries by their clock rather than by an index that happens to be right.
*/
function entry(second: number): RunLogEntry {
	const at = `2026-09-22T10:00:${String(second).padStart(2, '0')}.000Z`;

	return {at: new Date(at), class: 'Flush', summary: at, detail: at};
}

/*
The instant the entries below are stamped with, so `at` is asserted rather than
assumed.
*/
const AT = new Date('2026-09-22T10:00:00.000Z');

function attempt(
	counts: Partial<Snapshot> = {},
	{ok = true, at = '2026-09-22T10:00:00.000Z'} = {},
): FlushAttempt {
	return {
		at: new Date(at),
		ok,
		snapshot: {
			leftClicks: 0,
			rightClicks: 0,
			movementMeters: 0,
			keysPressed: 0,
			keyCounts: {},
			apps: {},
			...counts,
		},
	};
}

test('a run that has done nothing yet has nothing to read', t => {
	t.deepEqual(new InProcessRunLogSource().read(), []);
});

test('entries come back in the order they happened, newest last', t => {
	const log = new InProcessRunLogSource();

	log.append(entry(1));
	log.append(entry(2));
	log.append(entry(3));

	t.deepEqual(
		log.read().map(one => one.summary),
		[
			'2026-09-22T10:00:01.000Z',
			'2026-09-22T10:00:02.000Z',
			'2026-09-22T10:00:03.000Z',
		],
	);
});

/*
The block is a fixed part of the layout, so the log is a fixed size: a seventh
entry pushes the first out rather than making the frame taller.
*/
test('the buffer holds the last six, dropping the oldest', t => {
	const log = new InProcessRunLogSource();

	for (const second of [1, 2, 3, 4, 5, 6, 7]) {
		log.append(entry(second));
	}

	const summaries = log.read().map(one => one.summary);
	t.is(summaries.length, 6);
	t.false(summaries.includes('2026-09-22T10:00:01.000Z'), 'the oldest is gone');
	t.is(summaries.at(-1), '2026-09-22T10:00:07.000Z');
});

/*
Nothing outside the source can write into the buffer. A view that could push
onto what it read would be a second author of the log, and the composition root
is supposed to be the only one.
*/
test('a read is a copy, so a caller cannot write into the buffer', t => {
	const log = new InProcessRunLogSource();
	log.append(entry(1));

	const read = log.read();
	// The cast is the point of the test: a caller that insists on writing into
	// what it read finds the buffer where it left it.
	(read as RunLogEntry[]).push(entry(2));

	t.deepEqual(
		log.read().map(one => one.summary),
		['2026-09-22T10:00:01.000Z'],
	);
});

/*
A successful Flush, as the block draws it: the three counts the totals above it
draw, in the same spellings, so the same number reads alike twice in one frame.
*/
test('a Flush that landed is an entry carrying the counts it wrote', t => {
	const written = flushEntry(
		attempt({
			leftClicks: 7,
			rightClicks: 3,
			movementMeters: 250.5,
			keysPressed: 1234,
		}),
	);

	t.deepEqual(written.at, new Date('2026-09-22T10:00:00.000Z'));
	t.is(written.class, 'Flush');
	t.is(written.failed, undefined);
	t.is(
		written.summary,
		'Clicks 10 · Mouse Distance 250.5 m · Press Total 1,234',
	);
});

/*
The counters are not lost — Telemetry State is cleared only on a successful
Flush (ADR-0009) — so the line says the write is coming back rather than that
data went missing.
*/
test('a Flush that failed is an entry that says it will retry', t => {
	const failed = flushEntry(attempt({keysPressed: 3}, {ok: false}));

	t.is(failed.class, 'Flush');
	t.true(failed.failed === true, 'which is what draws it red');
	t.is(failed.summary, 'failed — will retry');
	t.is(
		failed.detail,
		'The counters are still in Telemetry State; the next Flush Interval writes them again.',
	);
});

/*
A helper problem, as the block draws it. The message is `helper.ts`'s own
sentence — the one the stderr reporter writes with a `[eventtap]` prefix on it —
because a terminal and a Run Log line that said different things about the same
event would be two descriptions of it.
*/
test('a helper problem is an entry carrying the helper’s own sentence', t => {
	const failure = helperEntry({kind: 'exited', code: 1, signal: undefined}, AT);

	t.deepEqual(failure.at, AT);
	t.is(failure.class, 'Helper');
	t.true(failure.failed === true, 'which is what draws it red');
	t.is(
		failure.summary,
		'the capture helper exited (code 1); input is no longer being collected.',
	);
	t.is(failure.detail, failure.summary);
});

/*
The block draws a summary on one row, under a fixed clock and class, so a
message that arrived with a line break in it would reshape the frame. Nothing is
lost by folding it: the whole message is what the diagnostics view draws.

A helper's own message is the one part of a problem this side does not compose,
so it is the one that can arrive with anything in it.
*/
test('a message with a line break in it still draws as one line', t => {
	const failure = helperEntry(
		{
			kind: 'error-line',
			error: {type: 'error', code: 'tapDisabled', message: 'no tap\nretrying'},
		},
		AT,
	);

	t.is(failure.summary, 'no tap retrying');
	t.is(failure.detail, 'no tap\nretrying');
});

/*
A read that failed, and the reason the history view can go back to drawing a
pointer: the driver's own sentence is here, in the log, rather than across the
middle of the frame. Its spelling is the seam's — the entry composes nothing
about a read and borrows the words the seam would have warned with.
*/
test('a failed read is an entry carrying the driver’s own message', t => {
	const failure = historyEntry({error: new Error('connect ECONNREFUSED')}, AT);

	t.deepEqual(failure.at, AT);
	t.is(failure.class, 'History');
	t.true(failure.failed === true, 'which is what draws it red');
	t.is(failure.summary, 'connect ECONNREFUSED');
	t.is(failure.detail, failure.summary);
});

/*
The write seam's warning, which is the store's own side of a run and the one
thing it reports that is not a Flush.

The message is the store's, because the store composes it; what this module
decides is that it is the entry's line, that a warning is drawn as a fault, and
that the arguments a logger call carried are kept rather than dropped — a
driver's error is worth more than the one line the message makes of it, and the
diagnostics view is the only place left to read it.
*/
test('a write seam warning is an entry keeping the driver’s own words', t => {
	const warning = storageEntry(
		'Failed to create TTL index on telemetry',
		[new Error('not authorized')],
		AT,
	);

	t.deepEqual(warning.at, AT);
	t.is(warning.class, 'Storage');
	t.true(warning.failed === true, 'which is what draws it red');
	t.is(warning.summary, 'Failed to create TTL index on telemetry');
	t.is(
		warning.detail,
		'Failed to create TTL index on telemetry Error: not authorized',
	);
});

/*
A warning called with the message alone, which is what a logger is free to do:
the full text is then the same sentence the line shows, and nothing is invented
to pad it.
*/
test('a warning with nothing after the message is its own full text', t => {
	const warning = storageEntry('Failed to create TTL index', [], AT);

	t.is(warning.detail, warning.summary);
});

function denied(
	disabled: DisabledReport['disabled'],
	access: DisabledReport['access'] = 'denied',
): DisabledReport {
	return {
		status: 'disabled',
		access,
		disabled,
		message: `Input Monitoring is ${access} for this helper.`,
	};
}

const MOUSE: DisabledCollector = {
	collector: 'mouse',
	note: 'Mouse collection is disabled: Input Monitoring is denied. Grant it in System Settings > Privacy & Security > Input Monitoring.',
};

const NOTES: DisabledReport['disabled'] = [
	MOUSE,
	{
		collector: 'keyboard',
		note: 'Keyboard collection is disabled: Input Monitoring is denied. Grant it in System Settings > Privacy & Security > Input Monitoring.',
	},
];

/*
A run that started with no grant, as the landing view draws it: the block is the
only thing on screen that knows, the history view above it being about the
database rather than about this run.
*/
test('a missing grant is one entry naming the Collectors it took out', t => {
	const disabled = collectionEntry(denied(NOTES), AT);

	t.deepEqual(disabled.at, AT);
	t.is(disabled.class, 'Collection');
	t.is(
		disabled.summary,
		'Mouse and Keyboard collection is disabled: Input Monitoring is denied.',
	);
	t.is(
		disabled.detail,
		NOTES.map(({note}) => note).join('\n'),
		'which is where the grant is named and where to change it',
	);
});

/*
Not a failure, and so not drawn red: CONTEXT.md's avoid-list for Collector
Disabled names "failed" and "errored" as the words this state is not. The CLI is
running with fewer Collectors, which is what "degrades rather than stops" means.
*/
test('collection that started disabled is not drawn as a failure', t => {
	t.is(collectionEntry(denied(NOTES), AT).failed, undefined);
});

/*
One grant, so a report naming one Collector is a report this shape can carry —
the factory is typed against it even though the helper cannot currently produce
it. The sentence has to read as one either way.
*/
test('the entry names only the Collectors the report disabled', t => {
	t.is(
		collectionEntry(denied([MOUSE]), AT).summary,
		'Mouse collection is disabled: Input Monitoring is denied.',
	);
	t.is(
		collectionEntry(denied(NOTES, 'unknown'), AT).summary,
		'Mouse and Keyboard collection is disabled: Input Monitoring is unknown.',
		'and an unknown grant reads as the helper reported it',
	);
});
