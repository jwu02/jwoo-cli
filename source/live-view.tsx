/*
The live view, drawn.

Presentational only, as `history-view.tsx` is: it takes a reading and a zone and
returns a frame. No effects, nothing to await and no source — every test of this
module is a synchronous render of a fixed reading, which is why the polling
lives in `use-telemetry.ts`.

The vocabulary is CONTEXT.md's. Press Total and Mouse Distance are terms rather
than descriptions, and "Collector Disabled" is the state this view exists to
draw a distinction around: a machine with no grant produces counters that are
zero in exactly the way a machine nobody has touched produces zero counters, and
the two must not read alike.
*/

import {Box, Text} from 'ink';
import {twoDigits} from './format.js';
import {type Totals} from './history.js';
import {localFields} from './local-time.js';
import {Row, TotalsView} from './totals-view.js';
import {type LastFlush, type LiveTelemetry} from './telemetry.js';

export function LiveView({
	telemetry,
	timeZone,
}: {
	telemetry: LiveTelemetry;
	timeZone: string;
}) {
	return (
		<Box flexDirection="column">
			{/*
			"Since the CLI started" rather than "now": these are not the history
			view's numbers for a smaller interval. They include everything this
			run has already Flushed, which is why they do not fall back to zero
			at the Flush Interval.
			*/}
			<Text bold>Live · since the CLI started</Text>

			{telemetry.status === 'disabled' ? (
				<Disabled message={telemetry.message} />
			) : (
				<Collecting
					totals={telemetry.totals}
					lastFlush={telemetry.lastFlush}
					timeZone={timeZone}
				/>
			)}
		</Box>
	);
}

/*
The Collectors the grant disables are not built at all, so there is nothing to
count and nothing to show: a row of zeroes beside this note would be a second,
contradictory answer to the same question.

The note itself is the preflight's own sentence, which names the grant and where
to change it. It is not composed here, because `collect` prints the same one and
two spellings of "grant Input Monitoring" would eventually disagree.
*/
function Disabled({message}: {message: string}) {
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text color="yellow">Collection is disabled.</Text>
			<Text dimColor>{message}</Text>
		</Box>
	);
}

function Collecting({
	totals,
	lastFlush,
	timeZone,
}: {
	totals: Totals;
	lastFlush: LastFlush | undefined;
	timeZone: string;
}) {
	/*
	Nothing has been observed at all, as opposed to nothing having been observed
	lately: the totals are the whole run's, so they only stand at zero if nothing
	has ever arrived.
	*/
	const isIdle =
		totals.leftClicks === 0 &&
		totals.rightClicks === 0 &&
		totals.pressTotal === 0 &&
		totals.movementMeters === 0;

	return (
		<>
			<TotalsView totals={totals} />

			{/* Set apart: the three above are what has been observed, and this is
			    what has been written, which happens on its own schedule. */}
			<Box flexDirection="column" marginTop={1}>
				<Row
					label="Last Flush"
					value={flushLabel(lastFlush, timeZone)}
					color={lastFlush?.ok === false ? 'red' : undefined}
				/>
			</Box>

			{isIdle && (
				<Box marginTop={1}>
					<Text dimColor>No activity yet.</Text>
				</Box>
			)}
		</>
	);
}

/*
Three outcomes rather than two, because they mean different things to whoever is
reading: nothing has been written yet, the last write landed, or the last write
did not and the counters are piling up until it does.
*/
function flushLabel(
	lastFlush: LastFlush | undefined,
	timeZone: string,
): string {
	if (lastFlush === undefined) {
		return 'not yet';
	}

	const {hour, minute, second} = localFields(lastFlush.at, timeZone);
	const clock = [hour, minute, second].map(value => twoDigits(value)).join(':');

	return lastFlush.ok ? clock : `${clock} · failed`;
}
