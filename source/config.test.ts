/* eslint-disable @typescript-eslint/naming-convention -- environment variable names are SCREAMING_SNAKE_CASE by definition. */
import {isAbsolute} from 'node:path';
import test from 'ava';
import {ConfigError, loadConfig} from './config.js';
import {isValidTimeZone} from './local-time.js';

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
	// Asserted as a property, not an identity: the fallback is whatever zone
	// this machine is in, and the suite has to pass on any of them.
	t.true(isValidTimeZone(config.timeZone));
});

/*
The history view buckets by the local day, so it needs a zone name and not just
an offset. `TZ` is where one is usually declared, but it is not trustworthy:
an empty value leaves `Intl` reporting `Etc/Unknown`, which is an ICU invention
rather than a zone the rest of the world accepts.
*/
test('loadConfig prefers TZ when it names a real zone', t => {
	t.is(loadConfig(env({TZ: 'Europe/London'})).timeZone, 'Europe/London');
});

for (const [name, value] of [
	['a zone Intl cannot resolve', 'Bogus/Zone'],
	['an empty value', ''],
] as Array<[string, string]>) {
	test(`loadConfig falls back to the machine's zone given ${name}`, t => {
		const config = loadConfig(env({TZ: value}));

		t.true(isValidTimeZone(config.timeZone));
	});
}

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

/*
Asserted as a property rather than as a string, for the reason the timezone
fallback is: the home directory is the machine's, not this suite's, and the
test has to pass on any of them. What matters is that it is absolute — a
relative path would put the Local Store somewhere different depending on where
the CLI was started from.
*/
test('loadConfig puts the Local Store under Application Support by default', t => {
	const {localStorePath} = loadConfig(env());

	t.true(isAbsolute(localStorePath));
	t.true(
		localStorePath.endsWith(
			'Library/Application Support/activity-telemetry/telemetry.db',
		),
	);
});

test('loadConfig lets LOCAL_STORE_PATH move the Local Store', t => {
	t.is(
		loadConfig(env({LOCAL_STORE_PATH: '/tmp/elsewhere/telemetry.db'}))
			.localStorePath,
		'/tmp/elsewhere/telemetry.db',
	);
});

/*
An empty value is treated as unset rather than taken literally. `LOCAL_STORE_PATH=`
in a shell profile is far more likely to be a mistake than an instruction to
scatter `telemetry.db` into whatever directory the CLI was started from.
*/
test('loadConfig treats an empty LOCAL_STORE_PATH as unset', t => {
	const fallback = loadConfig(env()).localStorePath;

	t.is(loadConfig(env({LOCAL_STORE_PATH: ''})).localStorePath, fallback);
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
