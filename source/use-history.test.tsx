import test from 'ava';
import {Text, useInput} from 'ink';
import {render} from 'ink-testing-library';
import {useState} from 'react';
import {type HistorySource} from './history.js';
import {type HistoryData, type LoadResult} from './local-store.js';
import {type Range} from './ranges.js';
import {type LoadState, useHistory} from './use-history.js';

/*
The load state machine, tested through a component because that is the only way
a hook runs.

`load` is deferred by hand rather than resolved immediately, because the
interesting case is two loads in flight at once — pressing a range key twice
quickly — where the response that arrives last is not the one that was asked
for last. Nothing else about this hook is subtle.

These run serially. Every `render` here mounts a real Ink root onto a shared
React scheduler, and letting them overlap made the frame assertions flaky —
one test's render would land a turn later than another's. The hook itself has
no cross-test state; the harness does.
*/

function dataFor(range: Range): HistoryData {
	return {
		range,
		timeZone: 'UTC',
		totals: {leftClicks: 0, rightClicks: 0, movementMeters: 0, pressTotal: 0},
		keyRanking: [],
		timeSeries: [],
	};
}

class DeferredHistorySource implements HistorySource {
	readonly requests: Range[] = [];
	readonly pending: Array<{resolve: (result: LoadResult) => void}> = [];

	async load(range: Range): Promise<LoadResult> {
		this.requests.push(range);
		return new Promise<LoadResult>(resolve => {
			this.pending.push({resolve});
		});
	}

	async close(): Promise<void> {
		// Nothing to release: the fake holds no connection.
	}

	settleWith(index: number, result: LoadResult): void {
		this.pending[index]!.resolve(result);
	}

	ready(index: number, range: Range): void {
		this.settleWith(index, {ok: true, data: dataFor(range)});
	}
}

function Probe({source}: {source: HistorySource}) {
	const [range, setRange] = useState<Range>('today');
	const state = useHistory(source, range);

	useInput(input => {
		switch (input) {
			case 't': {
				setRange('today');
				break;
			}

			case 'w': {
				setRange('week');
				break;
			}

			default:
		}
	});

	return <Text>{describe(state)}</Text>;
}

function describe(state: LoadState): string {
	switch (state.status) {
		case 'loading': {
			return 'loading';
		}

		case 'error': {
			return `error: ${state.message}`;
		}

		case 'ready': {
			return `ready: ${state.data.range}`;
		}
	}
}

/*
Two turns, not one. Resolving the pending load lands the `.then` on a
microtask, and the `setState` it calls schedules the render for a later turn
again — so a single tick shows the frame from before either happened.
*/
async function settle(): Promise<void> {
	for (let turn = 0; turn < 2; turn += 1) {
		// eslint-disable-next-line no-await-in-loop -- the turns must be sequential; that is the point.
		await new Promise(resolve => {
			setImmediate(resolve);
		});
	}
}

test.serial('the first render asks for the range it was given', async t => {
	const source = new DeferredHistorySource();
	const {lastFrame} = render(<Probe source={source} />);
	await settle();

	// Nothing is drawn from a guess: the view has no data until one arrives.
	t.is(lastFrame(), 'loading');
	t.deepEqual(source.requests, ['today']);

	source.ready(0, 'today');
	await settle();

	t.is(lastFrame(), 'ready: today');
});

test.serial('switching range asks for the new one', async t => {
	const source = new DeferredHistorySource();
	const {stdin} = render(<Probe source={source} />);
	await settle();

	source.ready(0, 'today');
	await settle();

	stdin.write('w');
	await settle();

	t.deepEqual(source.requests, ['today', 'week']);
});

/*
The reason this hook holds a `cancelled` flag. Pressing `w` then `t` quickly
leaves two loads in flight, and the network decides which resolves first — so
without the flag the frame ends up showing whichever response happened to land
last rather than the range that was asked for last.
*/
test.serial(
	'a response to a range that was left behind is ignored',
	async t => {
		const source = new DeferredHistorySource();
		const {stdin, lastFrame} = render(<Probe source={source} />);
		await settle();

		// Ask for the week before the first load has come back.
		stdin.write('w');
		await settle();
		t.deepEqual(source.requests, ['today', 'week']);

		// The answer that was wanted arrives first…
		source.ready(1, 'week');
		await settle();
		t.is(lastFrame(), 'ready: week');

		// …and the stale one arrives afterwards, out of order.
		source.ready(0, 'today');
		await settle();

		t.is(lastFrame(), 'ready: week');
	},
);

test.serial('a failed load is drawn, not thrown', async t => {
	const source = new DeferredHistorySource();
	const {lastFrame} = render(<Probe source={source} />);
	await settle();

	source.settleWith(0, {ok: false, message: 'connection reset'});
	await settle();

	t.is(lastFrame(), 'error: connection reset');
});

test.serial(
	'switching range clears the previous range rather than showing it',
	async t => {
		const source = new DeferredHistorySource();
		const {stdin, lastFrame} = render(<Probe source={source} />);
		await settle();

		source.ready(0, 'today');
		await settle();
		t.is(lastFrame(), 'ready: today');

		stdin.write('w');
		await settle();

		// The old range's numbers under the new range's heading would be a lie.
		t.is(lastFrame(), 'loading');
	},
);
