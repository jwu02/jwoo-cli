/*
Environment configuration.

The Python original printed to stderr and called `sys.exit(1)` from inside the
loader, so its tests had to monkeypatch `sys.exit` to assert a bad value was
rejected. This throws instead: the entry point decides what a bad environment
means, and the loader stays a pure function of its input.
*/

import process from 'node:process';

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
};

const ONE_YEAR_IN_SECONDS = 31_536_000;
const THIRTY_DAYS_IN_SECONDS = 2_592_000;

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
	};
}
