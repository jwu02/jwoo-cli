import test from 'ava';
import {render} from 'ink-testing-library';
import {type RunLogEntry} from './run-log.js';
import {RunLogView} from './run-log-view.js';

/*
The block is presentational: it takes a list of entries and a zone and returns a
frame. There is no source to fake and nothing to await, so every test here is a
synchronous render of a fixed list — which is the point of keeping the polling
in `use-run-log.ts`.

The zone is a parameter rather than the machine's, so a timestamp asserts the
same digits everywhere. 10:00 UTC is 11:00 in London in September.
*/

const TIME_ZONE = 'Europe/London';
const AT = new Date('2026-09-22T10:00:00.000Z');

function written(overrides: Partial<RunLogEntry> = {}): RunLogEntry {
	return {
		at: AT,
		class: 'Flush',
		summary: 'Clicks 10 · Mouse Distance 250.5 m · Press Total 1,234',
		detail: 'Clicks 10 · Mouse Distance 250.5 m · Press Total 1,234',
		...overrides,
	};
}

function failed(at: Date = AT): RunLogEntry {
	return {
		at,
		class: 'Flush',
		failed: true,
		summary: 'failed — will retry',
		detail: 'The counters are still in Telemetry State.',
	};
}

/*
A problem the helper or the stream reported: one sentence, drawn red, and its
own class in the column beside the clock. The class is what tells it apart from
a Flush at a glance, which is why it is asserted here rather than taken as
decoration.
*/
function problem(summary: string): RunLogEntry {
	return {at: AT, class: 'Helper', failed: true, summary, detail: summary};
}

function frameOf(entries: readonly RunLogEntry[]): string {
	const {lastFrame} = render(
		<RunLogView entries={entries} timeZone={TIME_ZONE} />,
	);

	return lastFrame() ?? '';
}

test('a run that has done nothing draws the block as a state, not as a gap', t => {
	const frame = frameOf([]);

	t.regex(frame, /Run Log/v);
	t.regex(frame, /Nothing yet\./v);
});

test('an entry is drawn as its second, its class and its line', t => {
	const frame = frameOf([written()]);

	t.regex(frame, /11:00:00/v, 'the second it happened, in the viewer’s zone');
	t.regex(frame, /Flush/v);
	t.regex(frame, /Clicks 10 · Mouse Distance 250\.5 m · Press Total 1,234/v);
	t.false(frame.includes('Nothing yet.'));
});

/*
The counts are the ones the totals block draws, spelled the same way — so a
number that appears twice in one frame reads the same twice.
*/
test('the counts are spelled as the totals above the block spell them', t => {
	const frame = frameOf([
		written({summary: 'Clicks 1,234 · Mouse Distance 0 m'}),
	]);

	t.regex(frame, /Clicks 1,234/v);
	t.regex(frame, /Mouse Distance 0 m/v);
});

test('entries are drawn in the order they happened, newest last', t => {
	const frame = frameOf([
		written({at: new Date('2026-09-22T10:00:01.000Z'), summary: 'the first'}),
		written({at: new Date('2026-09-22T10:00:02.000Z'), summary: 'the second'}),
	]);

	t.true(
		frame.indexOf('the first') < frame.indexOf('the second'),
		'oldest above, so the newest entry is the one nearest the footer',
	);
});

/*
The line a failed Flush draws. That it is *red* is Ink's, and no test here
asserts a colour: `ink-testing-library` renders without a terminal, so a frame
carries no escape codes to look for. What is asserted is the entry that the
colour is attached to.
*/
test('a Flush that failed is drawn as one that will come back', t => {
	const frame = frameOf([failed()]);

	t.regex(frame, /11:00:00\s+Flush\s+failed — will retry/v);
});

/*
The helper's own words, under the class that says they are the helper's. The
sentence is long on purpose: a block that cut it would be drawing something
other than what the diagnostics view would show.
*/
test('a helper problem is drawn as itself, beside the block’s other entries', t => {
	const frame = frameOf([
		written(),
		problem(
			'the capture helper exited (code 1); input is no longer being collected.',
		),
	]);

	t.regex(
		frame,
		/11:00:00\s+Helper\s+the capture helper exited \(code 1\); input is no longer being collected\./v,
	);
});

/*
A run that started with no grant. Its class is the one thing on the landing view
that says the numbers above it are missing for a reason — and it is drawn as a
state rather than as a fault, so it is not the failed-Flush line.
*/
test('collection that started disabled is drawn as its own class', t => {
	const frame = frameOf([
		{
			at: AT,
			class: 'Collection',
			summary:
				'Mouse and Keyboard collection is disabled: Input Monitoring is denied.',
			detail: 'Mouse collection is disabled: Input Monitoring is denied.',
		},
	]);

	t.regex(
		frame,
		/11:00:00\s+Collection\s+Mouse and Keyboard collection is disabled: Input Monitoring is denied\./v,
	);
});

/*
Both views draw the block, and the frame it draws is the same one either way —
there is nothing in it that knows which view is above it.
*/
test('the block draws under whatever else is on screen', t => {
	const frame = frameOf([
		written(),
		failed(new Date('2026-09-22T10:05:00.000Z')),
	]);

	t.regex(frame, /11:00:00/v);
	t.regex(frame, /11:05:00/v);
	t.regex(frame, /failed — will retry/v);
});
