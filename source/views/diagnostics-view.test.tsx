import test from 'ava';
import {render} from 'ink-testing-library';
import {type RunLogEntry} from '../run-log.js';
import {DiagnosticsView} from './diagnostics-view.js';

/*
The diagnostics view is presentational, as the block is: it takes the entries and
a zone and returns a frame. There is no source to fake and nothing to await, so
every test here is a synchronous render of a fixed list.

The zone is a parameter rather than the machine's, so a timestamp asserts the
same digits everywhere. 10:00 UTC is 11:00 in London in September.
*/

const TIME_ZONE = 'Europe/London';
const AT = new Date('2026-09-22T10:00:00.000Z');

/*
A successful Flush, whose two texts are the same sentence — the seam composes
both from the counts, and there is no second thing to say about a write that
landed.
*/
function written(overrides: Partial<RunLogEntry> = {}): RunLogEntry {
	return {
		at: AT,
		class: 'Flush',
		summary: 'Clicks 10 · Mouse Distance 250.5 m · Press Total 1,234',
		detail: 'Clicks 10 · Mouse Distance 250.5 m · Press Total 1,234',
		...overrides,
	};
}

/*
The case the view exists for: the block draws `failed — will retry` and nothing
else, and the sentence saying where the counters went is only here.
*/
function failed(): RunLogEntry {
	return {
		at: AT,
		class: 'Flush',
		failed: true,
		summary: 'failed — will retry',
		detail:
			'The counters are still in Telemetry State; the next Flush Interval writes them again.',
	};
}

function frameOf(entries: readonly RunLogEntry[]): string {
	const {lastFrame} = render(
		<DiagnosticsView entries={entries} timeZone={TIME_ZONE} />,
	);

	return lastFrame() ?? '';
}

function occurrences(frame: string, text: string): number {
	return frame.split(text).length - 1;
}

test('a run that has done nothing draws the view as a state, not as a gap', t => {
	const frame = frameOf([]);

	t.regex(frame, /Diagnostics/v);
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
A text that says exactly what the summary above it says is one text, drawn once.
A successful Flush is the case: its detail is composed from the same counts, so
drawing both would put the same line on screen twice and read as two entries.
*/
test('a full text that is the summary is not drawn a second time', t => {
	const frame = frameOf([written()]);

	t.is(occurrences(frame, 'Press Total 1,234'), 1);
});

/*
The point of the view: the block cuts a long line into its own column, and this
draws the whole of it.
*/
test('the full text is drawn whole, not as the block’s one line', t => {
	const frame = frameOf([failed()]);

	t.regex(frame, /failed — will retry/v);
	t.regex(
		frame,
		/The counters are still in Telemetry State; the next Flush Interval writes them again\./v,
	);
});

/*
A detail carrying its own breaks — the preflight's notes, which say where to
change the setting — keeps them: this is the text the entry holds, and there is
no column beside it to squeeze it into.
*/
test('a detail of several lines is drawn as several lines', t => {
	const frame = frameOf([
		{
			at: AT,
			class: 'Collection',
			summary:
				'Mouse and Keyboard collection is disabled: Input Monitoring is denied.',
			detail:
				'Mouse collection is disabled: Input Monitoring is denied.\nGrant Input Monitoring to the terminal in System Settings › Privacy & Security.',
		},
	]);

	t.regex(
		frame,
		/Mouse collection is disabled: Input Monitoring is denied\.\s+Grant Input Monitoring to the terminal/v,
	);
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
