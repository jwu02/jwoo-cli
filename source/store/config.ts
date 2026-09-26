/*
Environment configuration.

The Python original printed to stderr and called `sys.exit(1)` from inside the
loader, so its tests had to monkeypatch `sys.exit` to assert a bad value was
rejected. This throws instead: the entry point decides what a bad environment
means, and the loader stays a pure function of its input.
*/

import {homedir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {isValidTimeZone} from './local-time.js';

export class ConfigError extends Error {
	override readonly name = 'ConfigError';
}

export type Config = {
	readonly mongoUri: string;
	readonly dbName: string;
	readonly collectionName: string;
	readonly heatmapCollectionName: string;
	readonly flushIntervalSeconds: number;
	readonly mouseDpi: number;
	readonly collectionTtlSeconds: number;
	readonly heatmapTtlSeconds: number;
	/*
	The zone the history view buckets its days and hours in. Resolved rather
	than read straight from `TZ`, because the two ways that can go wrong are
	silent: `resolvedOptions().timeZone` is typed `string` but is `undefined`
	when `TZ` names something Intl cannot resolve, and `Etc/Unknown` when `TZ`
	is empty.
	*/
	readonly timeZone: string;
	/*
	Where the Local Store's SQLite file lives. The one path in this config, and
	the only one the CLI writes to besides the terminal — see `LocalStore`.
	*/
	readonly localStorePath: string;
};

const ONE_YEAR_IN_SECONDS = 31_536_000;
const THIRTY_DAYS_IN_SECONDS = 2_592_000;

/*
The store is macOS-only by ADR-0005, so the Application Support convention is
spelled out rather than discovered. It is under the home directory rather than
the current one because a Local Store is a machine's record, not a project's.
*/
const LOCAL_STORE_RELATIVE_PATH =
	'Library/Application Support/activity-telemetry/telemetry.db';

export type Environment = Record<string, string | undefined>;

function positiveInteger(
	raw: string | undefined,
	fallback: number,
	name: string,
): number {
	if (raw === undefined) {
		return fallback;
	}

	// Mirrors Python's `int()`, so whitespace is tolerated and anything with a
	// decimal point is not.
	const value = Number(raw.trim());
	if (raw.trim() === '' || !Number.isSafeInteger(value)) {
		throw new ConfigError(`${name} must be a positive integer, got '${raw}'`);
	}

	if (value <= 0) {
		throw new ConfigError(`${name} must be a positive integer, got ${value}`);
	}

	return value;
}

export function loadConfig(env: Environment = process.env): Config {
	const mongoUri = env['MONGO_URI'];
	if (mongoUri === undefined || mongoUri === '') {
		throw new ConfigError('Missing MONGO_URI in environment');
	}

	return {
		mongoUri,
		dbName: env['ACTIVITY_DB_NAME'] ?? 'activity-telemetry',
		collectionName: 'telemetry',
		heatmapCollectionName: 'keyboard_heatmap',
		flushIntervalSeconds: positiveInteger(
			env['FLUSH_INTERVAL_SECONDS'],
			300,
			'FLUSH_INTERVAL_SECONDS',
		),
		mouseDpi: positiveInteger(env['MOUSE_DPI'], 72, 'MOUSE_DPI'),
		collectionTtlSeconds: ONE_YEAR_IN_SECONDS,
		heatmapTtlSeconds: THIRTY_DAYS_IN_SECONDS,
		timeZone: resolveTimeZone(env),
		localStorePath: resolveLocalStorePath(env),
	};
}

/*
An empty value is treated as unset rather than taken literally. The default is
absolute by construction, and `LOCAL_STORE_PATH=` in a shell profile is far more
likely to be a mistake than an intent to scatter `telemetry.db` into whatever
directory the CLI happened to be started from.

`homedir()` rather than `env['HOME']`, for the same reason `resolveTimeZone`
falls back to `Intl`: the environment is the input to this function, not the
authority on where the machine's home directory is, and a loader that believed a
declared `HOME` would put the store somewhere the OS does not agree exists.
*/
function resolveLocalStorePath(env: Environment): string {
	const declared = env['LOCAL_STORE_PATH'];

	return declared === undefined || declared === ''
		? join(homedir(), LOCAL_STORE_RELATIVE_PATH)
		: declared;
}

/*
`TZ` first, then whatever the machine reports, then UTC. Each candidate is
checked before it is taken, so a bad value degrades to the next one instead of
reaching a formatter that would throw on it.
*/
function resolveTimeZone(env: Environment): string {
	const declared = env['TZ'];
	if (isValidTimeZone(declared)) {
		return declared;
	}

	const system = new Intl.DateTimeFormat().resolvedOptions().timeZone;
	return isValidTimeZone(system) ? system : 'UTC';
}
