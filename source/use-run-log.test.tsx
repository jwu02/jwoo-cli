import test from 'ava';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
import {type RunLogEntry, type RunLogSource} from './run-log.js';
import {useRunLog} from './use-run-log.js';

/*
The polling hook, tested through a component because that is the only way a hook
runs.

The source is mutable rather than deferred — there is no promise to hold open,
so a test appends an entry and watches the frame catch up. That is also why
these tests unmount: a component left mounted leaves an interval running, and
ava times the run out waiting for the worker to exit rather than reporting
anything about this hook.

These run serially for the same reason as `use-telemetry.test.tsx`: every
`render` mounts a real Ink root onto a shared scheduler, and overlapping roots
made the frame assertions flaky.
*/

const TICK_MS = 5;

class MutableRunLogSource implements RunLogSource {
	entries: RunLogEntry[] = [];
	reads = 0;

	read(): readonly RunLogEntry[] {
		this.reads += 1;
		// A copy, as the real one hands back: the hook is not supposed to be
		// reading the buffer itself.
		return [...this.entries];
	}
}

function entry(at: number, summary: string): RunLogEntry {
	return {
		at: new Date(`2026-09-22T10:00:0${at}.000Z`),
		class: 'Flush',
		summary,
		detail: summary,
	};
}

function Probe({
	source,
	intervalMs,
}: {
	source: RunLogSource;
	intervalMs?: number;
}) {
	const entries = useRunLog(source, {intervalMs});
	const summaries = entries.map(one => one.summary).join('|');

	/*
	Deliberately not the view's rendering: what is under test is that entries
	reach the frame at all, and a one-line description cannot be satisfied by a
	stray heading.
	*/
	return <Text>{summaries === '' ? 'empty' : summaries}</Text>;
}

async function delay(ms: number): Promise<void> {
	await new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

/*
Waits for the frame rather than sleeping a fixed number of ticks and hoping: the
timer's latency is the machine's business, not this test's.
*/
async function until(
	isSatisfied: () => boolean,
	{timeoutMs = 2000, what}: {timeoutMs?: number; what: string},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (!isSatisfied()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}

		// eslint-disable-next-line no-await-in-loop -- polling, one check at a time.
		await delay(5);
	}
}

test.serial('the first frame is what the log holds, not a blank', t => {
	const source = new MutableRunLogSource();
	source.entries = [entry(1, 'flushed')];
	// Long enough that nothing here can be a tick: the first frame has to come
	// from the read on the way past, or the block opens empty and fills in a
	// second later.
	const {lastFrame, unmount} = render(
		<Probe source={source} intervalMs={60_000} />,
	);
	t.teardown(() => {
		unmount();
	});

	t.is(lastFrame(), 'flushed');
	t.true(source.reads >= 1, 'the source was read');
});

test.serial(
	'an entry appended while the block is up reaches the frame',
	async t => {
		const source = new MutableRunLogSource();
		const {lastFrame, unmount} = render(
			<Probe source={source} intervalMs={TICK_MS} />,
		);
		t.teardown(() => {
			unmount();
		});

		t.is(lastFrame(), 'empty');

		source.entries = [entry(1, 'flushed'), entry(2, 'failed — will retry')];
		await until(() => lastFrame() === 'flushed|failed — will retry', {
			what: 'the appended entry to be drawn',
		});

		t.is(lastFrame(), 'flushed|failed — will retry');
	},
);

test.serial('unmounting stops the polling', async t => {
	const source = new MutableRunLogSource();
	const {unmount} = render(<Probe source={source} intervalMs={TICK_MS} />);
	await delay(TICK_MS * 2);

	unmount();
	const {reads} = source;
	await delay(TICK_MS * 4);

	t.is(source.reads, reads, 'no reads after the component went away');
});
