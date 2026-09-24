import test from 'ava';
import {
	flushEntry,
	InProcessRunLogSource,
	type RunLogEntry,
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
