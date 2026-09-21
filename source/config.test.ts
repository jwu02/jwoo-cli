/* eslint-disable @typescript-eslint/naming-convention -- environment variable names are SCREAMING_SNAKE_CASE by definition. */
import test from 'ava';
import {ConfigError, loadConfig} from './config.js';

/*
The loader takes its environment as an argument rather than reading
`process.env` from inside, so each test passes exactly the variables it cares
about and the suite needs no save-and-restore dance.
*/
function env(overrides: Record<string, string> = {}) {
	return {MONGO_URI: 'mongodb://localhost/test', ...overrides};
}

test('loadConfig reads env and applies defaults', t => {
	const config = loadConfig(env());

	t.is(config.mongoUri, 'mongodb://localhost/test');
	t.is(config.dbName, 'activity-telemetry');
	t.is(config.collectionName, 'telemetry');
	t.is(config.heatmapCollectionName, 'keyboard_heatmap');
	t.is(config.flushIntervalSeconds, 300);
	t.is(config.mouseDpi, 72);
	t.is(config.collectionTtlSeconds, 31_536_000);
	t.is(config.heatmapTtlSeconds, 2_592_000);
});

test('loadConfig reads the DB name and custom integers', t => {
	const config = loadConfig(
		env({
			ACTIVITY_DB_NAME: 'test-db',
			FLUSH_INTERVAL_SECONDS: '120',
			MOUSE_DPI: '1600',
		}),
	);

	t.is(config.dbName, 'test-db');
	t.is(config.flushIntervalSeconds, 120);
	t.is(config.mouseDpi, 1600);
});

test('loadConfig throws a ConfigError when MONGO_URI is missing', t => {
	const error = t.throws(() => loadConfig({}), {instanceOf: ConfigError});

	t.regex(error.message, /MONGO_URI/v);
});

test('loadConfig throws a ConfigError when MONGO_URI is empty', t => {
	t.throws(() => loadConfig({MONGO_URI: ''}), {instanceOf: ConfigError});
});

/*
Named cases rather than raw values, because '' and '   ' would otherwise
render as the same test title.
*/
const nonIntegers: Array<[string, string]> = [
	['letters', 'abc'],
	['a decimal', '1.5'],
	['an empty string', ''],
	['whitespace only', ' '.repeat(3)],
];

for (const [name, value] of nonIntegers) {
	test(`loadConfig rejects FLUSH_INTERVAL_SECONDS given ${name}`, t => {
		const error = t.throws(
			() => loadConfig(env({FLUSH_INTERVAL_SECONDS: value})),
			{instanceOf: ConfigError},
		);

		t.regex(error.message, /FLUSH_INTERVAL_SECONDS/v);
	});
}

for (const value of ['0', '-1']) {
	test(`loadConfig rejects non-positive MOUSE_DPI: ${value}`, t => {
		const error = t.throws(() => loadConfig(env({MOUSE_DPI: value})), {
			instanceOf: ConfigError,
		});

		t.regex(error.message, /MOUSE_DPI/v);
	});
}
