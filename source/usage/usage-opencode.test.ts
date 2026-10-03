/*
The OpenCode projection and its database read, against fixture `info` JSONs and
a fixture SQLite database.

The payload fixtures are hand-written `AssistantMessage` blobs, and the database
fixture is built here with `node:sqlite` — neither is the real thing:
`~/.config/opencode` and `~/.local/share/opencode` are not the gate's to touch.
The fields are OpenCode's own spelling — `modelID`, `path.cwd`,
`tokens.cache.read` — so a camelCased fixture would test a payload nothing
produces.
*/

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test, {type ExecutionContext} from 'ava';
import {canonicalModelName} from '../store/pricing.js';
import {
	projectOpencodeMessage,
	readOpencodeDatabase,
} from './usage-opencode.js';

/* eslint-disable @typescript-eslint/naming-convention -- OpenCode's own field names, the same exception the fixture's Anthropic rows make. */
function message(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: 'msg_1',
		sessionID: 'ses_1',
		role: 'assistant',
		time: {created: 1_755_500_000_000, completed: 1_755_500_001_000},
		parentID: 'msg_0',
		modelID: 'kimi-k2.7-code',
		providerID: 'moonshot',
		mode: 'build',
		path: {cwd: '/projects/site', root: '/projects/site'},
		cost: 0.42,
		tokens: {
			input: 100,
			output: 50,
			reasoning: 10,
			cache: {read: 20, write: 5},
			total: 999,
		},
		...overrides,
	});
}
/* eslint-enable @typescript-eslint/naming-convention */

test('flattens the message buckets, with reasoning billed as miss-input', t => {
	const flat = projectOpencodeMessage(message());

	t.is(
		flat?.prompt_tokens,
		135,
		'input + cache.write + cache.read + reasoning',
	);
	t.is(flat?.prompt_cache_hit_tokens, 20, 'cache.read');
	t.is(flat?.prompt_cache_miss_tokens, 115, 'prompt − hit');
	t.is(flat?.completion_tokens, 50, 'output; reasoning is not completion');
	t.is(flat?.total_tokens, 999, "OpenCode's own total wins when it is there");
	t.is(flat?.model, 'kimi-k2.7-code');
	t.is(flat?.cwd, '/projects/site');
	t.is(
		flat?.recordedAt.getTime(),
		1_755_500_000_000,
		'time.created, not completed',
	);
});

test('total falls back to prompt + completion when the message carries none', t => {
	const flat = projectOpencodeMessage(
		message({
			tokens: {
				input: 100,
				output: 50,
				reasoning: 10,
				cache: {read: 20, write: 5},
			},
		}),
	);

	t.is(flat?.total_tokens, 185, 'the four buckets, as the store sums them');
});

/*
The no-token-data guard, not a total-guard: a message OpenCode aborted before
any provider call has nothing to bill, and ingesting it would be a zero-cost
row. Whether the buckets are absent or explicitly zero makes no difference.
*/
test('a message whose buckets are all absent or zero is skipped', t => {
	t.is(projectOpencodeMessage(message({tokens: {}})), undefined);
	t.is(
		projectOpencodeMessage(
			message({tokens: {input: 0, output: 0, reasoning: 0}}),
		),
		undefined,
	);
	t.is(
		projectOpencodeMessage(message({tokens: undefined})),
		undefined,
		'no tokens at all',
	);
});

/*
Real usage is not dropped for not being a clean turn (spec #53): an errored
message and a summarized one both carry tokens OpenCode already billed.
*/
test('an errored or summarized message with tokens still projects', t => {
	const errored = projectOpencodeMessage(
		message({error: {name: 'UnknownError', data: {message: 'boom'}}}),
	);
	const summarized = projectOpencodeMessage(message({summary: true}));

	t.is(errored?.completion_tokens, 50);
	t.is(summarized?.completion_tokens, 50);
});

/*
The model id is projected verbatim: canonicalization is the Ingest face's job
(pricing.ts), and this pins the chain — an un-aliased relay id would store and
price under a name nothing matches (ADR-0015).
*/
test('the model id is left for the Ingest face to canonicalize', t => {
	/* eslint-disable @typescript-eslint/naming-convention -- OpenCode's own field name. */
	const flat = projectOpencodeMessage(
		message({modelID: 'deepseek/deepseek-flash'}),
	);
	/* eslint-enable @typescript-eslint/naming-convention */

	t.is(
		flat?.model,
		'deepseek/deepseek-flash',
		'projected as OpenCode wrote it',
	);
	t.is(
		canonicalModelName(flat?.model),
		'deepseek-v4.1-flash',
		'and the alias table maps it on the way into the store',
	);
});

/*
A payload that is not a JSON object throws rather than reading as a message with
no fields — including an array, whose `typeof` is `'object'` but which is not one
of these messages. A message that carries tokens but no `time.created` throws
too: there is no wall-clock fallback here, because pricing keys on the record's
own instant (ADR-0014) and "now" would be a silently wrong charge.
*/
test('a payload that is not a JSON object throws', t => {
	t.throws(() => projectOpencodeMessage('not json'));
	t.throws(() => projectOpencodeMessage('"a string"'));
	t.throws(() => projectOpencodeMessage('null'));
	t.throws(() => projectOpencodeMessage('[]'));
});

test('a message that carries tokens but no time.created throws', t => {
	t.throws(() =>
		projectOpencodeMessage(message({time: {completed: 1_755_500_001_000}})),
	);
});

/*
The two fields a database row carries and a live payload does not. The Backfill
passes them so its rows resolve where the Shim's payloads always carry their
own; the live command passes neither, which is what leaves the throw above
intact.
*/
test('a caller may supply the instant and cwd the payload omitted', t => {
	const flat = projectOpencodeMessage(
		message({time: {completed: 1_755_500_001_000}, path: undefined}),
		{
			fallbackRecordedAt: new Date(1_700_000_000_000),
			fallbackCwd: '/session/dir',
		},
	);

	t.is(flat?.recordedAt.getTime(), 1_700_000_000_000, 'the row time_created');
	t.is(flat?.cwd, '/session/dir', "the session's directory");
});

/*
The payload's own values still win: the fallbacks are only for what is absent.
*/
test('the payload wins over a caller-supplied fallback', t => {
	const flat = projectOpencodeMessage(message(), {
		fallbackRecordedAt: new Date(1),
		fallbackCwd: '/session/dir',
	});

	t.is(flat?.recordedAt.getTime(), 1_755_500_000_000, 'time.created');
	t.is(flat?.cwd, '/projects/site', 'path.cwd');
});

/*
The database read, against a fixture DB built with `node:sqlite`.
---------------------------------------------------------------

The schema is the two columns this module reads plus the join between them —
OpenCode's real `message` and `session` tables carry far more, none of which the
Backfill touches. Rows are written through `node:sqlite` exactly as OpenCode
would, so the reader is exercised against a real database rather than a fake of
one.
*/

type FixtureMessage = {
	readonly id: string;
	readonly sessionId: string;
	readonly directory: string;
	readonly timeCreated: number;
	readonly data: string;
};

/*
One row, defaulted so a test names only what it varies.
*/
function row(
	id: string,
	data: string,
	options: {
		readonly sessionId?: string;
		readonly directory?: string;
		readonly timeCreated?: number;
	} = {},
): FixtureMessage {
	return {
		id,
		sessionId: options.sessionId ?? 'ses_1',
		directory: options.directory ?? '/home/me/session-dir',
		timeCreated: options.timeCreated ?? 1_755_500_000_000,
		data,
	};
}

/*
Build a fixture database under the OS's temp directory — never OpenCode's own —
and hand back its path. `INSERT OR IGNORE` so several rows can share a session.
*/
function database(
	t: ExecutionContext,
	rows: readonly FixtureMessage[],
): string {
	const directory = mkdtempSync(join(tmpdir(), 'jwoo-cli-opencode-test-'));
	t.teardown(() => {
		rmSync(directory, {recursive: true, force: true});
	});

	const path = join(directory, 'opencode.db');
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE session (
			id TEXT PRIMARY KEY,
			directory TEXT NOT NULL
		);
		CREATE TABLE message (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES session(id),
			time_created INTEGER NOT NULL,
			data TEXT NOT NULL
		);
	`);

	const insertSession = db.prepare(
		'INSERT OR IGNORE INTO session (id, directory) VALUES (?, ?)',
	);
	const insertMessage = db.prepare(
		'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
	);

	for (const fixture of rows) {
		insertSession.run(fixture.sessionId, fixture.directory);
		insertMessage.run(
			fixture.id,
			fixture.sessionId,
			fixture.timeCreated,
			fixture.data,
		);
	}

	db.close();
	return path;
}

/*
One record per assistant message: a user row is not a message this Backfill
reads, and an assistant row with nothing to bill is scanned but yields nothing.
*/
test('reads one candidate per assistant message', t => {
	const path = database(t, [
		row('msg_1', message()),
		row(
			'msg_2',
			message({id: 'msg_2', tokens: {input: 1, cache: {read: 0, write: 0}}}),
		),
		row('msg_3', message({id: 'msg_3', role: 'user'})),
		row('msg_4', message({id: 'msg_4', tokens: {}})),
	]);

	const scan = readOpencodeDatabase(path);

	t.is(scan.scanned, 3, 'the assistant rows, including the one with no tokens');
	t.is(scan.candidates.length, 2);
	t.true(
		scan.candidates.every(candidate => candidate.model === 'kimi-k2.7-code'),
	);
});

/*
The row's own `time_created` and its session's `directory` stand in when the
blob omits `time.created` and `path.cwd` — the retired script's mapping, and the
one thing the DB reader adds to the projection.
*/
test('a row without time.created or path.cwd falls back to its columns', t => {
	const path = database(t, [
		row(
			'msg_1',
			message({time: {completed: 1_755_500_001_000}, path: undefined}),
			{timeCreated: 1_600_000_000_000, directory: '/the/session/dir'},
		),
	]);

	const scan = readOpencodeDatabase(path);

	t.is(scan.candidates.length, 1);
	t.is(scan.candidates[0]?.recordedAt.getTime(), 1_600_000_000_000);
	t.is(scan.candidates[0]?.cwd, '/the/session/dir');
});

/*
A model the DB row does not name still yields a candidate: absent pricing is not
an absent record (ADR-0015), and the Ingest face is what leaves it Unpriced.
*/
test('a row with no model still yields a candidate', t => {
	/* eslint-disable @typescript-eslint/naming-convention -- OpenCode's own field name. */
	const path = database(t, [row('msg_1', message({modelID: undefined}))]);
	/* eslint-enable @typescript-eslint/naming-convention */

	const scan = readOpencodeDatabase(path);

	t.is(scan.candidates.length, 1);
	t.is(scan.candidates[0]?.model, undefined);
});

/*
`--since` bounds each candidate by its own resolved `recorded_at`, not by the
row's `time_created`: a message whose blob carries a later instant survives a
bound its row would fail.
*/
test('--since filters on the resolved recorded_at', t => {
	const path = database(t, [
		row('msg_1', message({time: {created: 1_700_000_000_000}})),
		row(
			'msg_2',
			message({id: 'msg_2'}), // 1_755_500_000_000
			{timeCreated: 1_700_000_000_000},
		),
	]);

	const scan = readOpencodeDatabase(path, {
		since: new Date(1_750_000_000_000),
	});

	t.is(scan.scanned, 2, 'both rows were read');
	t.is(scan.candidates.length, 1);
	t.is(scan.candidates[0]?.recordedAt.getTime(), 1_755_500_000_000);
});

/*
A database that cannot be opened throws — the scan the operator asked for but
could not make is the Backfill's own failure, not a silent zero.
*/
test('a database that cannot be opened throws', t => {
	t.throws(() => readOpencodeDatabase('/no/such/opencode.db'));
});
