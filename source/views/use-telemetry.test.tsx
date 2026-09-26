import test from 'ava';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
import {type LiveTelemetry, type TelemetrySource} from '../telemetry.js';
import {useTelemetry} from './use-telemetry.js';

/*
The polling hook, tested through a component because that is the only way a hook
runs.

The source is mutable rather than deferred, so a test moves the counters and
watches the frame catch up. That is also why these tests unmount: a component
left mounted leaves an interval running, and ava times the run out waiting for
the worker to exit rather than reporting anything about this hook.

These run serially because every `render` mounts a real Ink root onto a shared
scheduler, and overlapping roots made the frame assertions flaky.
*/

const TICK_MS = 5;

class MutableTelemetrySource implements TelemetrySource {
	reading: LiveTelemetry = reading(0);
	reads = 0;

	read(): LiveTelemetry {
		this.reads += 1;
		return this.reading;
	}
}

function reading(pressTotal: number): LiveTelemetry {
	return {
		status: 'collecting',
		totals: {leftClicks: 0, rightClicks: 0, movementMeters: 0, pressTotal},
	};
}

function Probe({
	source,
	intervalMs,
}: {
	source: TelemetrySource;
	intervalMs?: number;
}) {
	const telemetry = useTelemetry(source, {intervalMs});

	return <Text>{describe(telemetry)}</Text>;
}

/*
Deliberately not the view's rendering: what is under test is that a reading
reaches the frame at all, and a one-line description cannot be satisfied by a
stray heading or a stale number.
*/
function describe(telemetry: LiveTelemetry): string {
	return telemetry.status === 'disabled'
		? `disabled: ${telemetry.message}`
		: `presses: ${telemetry.totals.pressTotal}`;
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

test.serial('the first frame is a reading, not a blank', t => {
	const source = new MutableTelemetrySource();
	// Long enough that nothing here can be a tick: the first frame has to come
	// from the read on the way past, or the dashboard opens empty and fills in
	// a second later.
	const {lastFrame, unmount} = render(
		<Probe source={source} intervalMs={60_000} />,
	);
	t.teardown(() => {
		unmount();
	});

	t.is(lastFrame(), 'presses: 0');
	t.true(source.reads >= 1, 'the source was read');
});

test.serial('a counter that moves reaches the frame', async t => {
	const source = new MutableTelemetrySource();
	const {lastFrame, unmount} = render(
		<Probe source={source} intervalMs={TICK_MS} />,
	);
	t.teardown(() => {
		unmount();
	});

	source.reading = reading(4);
	await until(() => lastFrame() === 'presses: 4', {
		what: 'the changed counters to be drawn',
	});

	t.is(lastFrame(), 'presses: 4');
});

/*
A grant withdrawn — or a machine that never had one — is not a run with nothing
in it, and the hook passes that distinction through rather than flattening it
into zeroes.
*/
test.serial('a disabled grant is drawn as one', t => {
	const source = new MutableTelemetrySource();
	source.reading = {status: 'disabled', message: 'Input Monitoring is denied.'};
	const {lastFrame, unmount} = render(
		<Probe source={source} intervalMs={TICK_MS} />,
	);
	t.teardown(() => {
		unmount();
	});

	t.is(lastFrame(), 'disabled: Input Monitoring is denied.');
});

test.serial('unmounting stops the polling', async t => {
	const source = new MutableTelemetrySource();
	const {unmount} = render(<Probe source={source} intervalMs={TICK_MS} />);
	await delay(TICK_MS * 2);

	unmount();
	const {reads} = source;
	await delay(TICK_MS * 4);

	t.is(source.reads, reads, 'no reads after the component went away');
});
