/*
The Pi projection and its session walk, against fixture messages and self-built
temp trees.

The message fixtures are hand-written pi `AssistantMessage` objects — the shape
`message-types.md` documents and a session file's `message` entry holds — and the
trees are built here: `~/.pi/agent/sessions` is not the gate's to touch. The field
names are pi's own (`cacheRead`, `cacheWrite1h`, `totalTokens`), so a camelCased
guess would test a payload nothing produces.
*/

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {canonicalModelName} from '../store/pricing.js';
import {projectPiMessage, readPiSessions} from './usage-pi.js';

/*
One assistant message, defaulted so a test names only what it varies. `cost` is
present and wrong-looking on purpose: the projection must never read it.
*/
function message(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		role: 'assistant',
		content: [],
		api: 'anthropic-messages',
		provider: 'acme',
		model: 'glm-5.3-flash',
		usage: {
			input: 100,
			output: 50,
			cacheRead: 20,
			cacheWrite: 5,
			cacheWrite1h: 3,
			totalTokens: 999,
			cost: {input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 0.42},
		},
		stopReason: 'stop',
		timestamp: 1_755_500_000_000,
		...overrides,
	};
}

/*
The flatten rule, with `cacheWrite1h` folded into the prompt and pi's own
`totalTokens` ignored: 100 + 20 + 5 + 3 = 128 prompt, 20 hit, 108 miss, 50
completion, and a total of 178 rather than pi's 999.
*/
test('flattens the five buckets and recomputes the total', t => {
	const flat = projectPiMessage(message(), '/projects/site');

	t.is(
		flat?.prompt_tokens,
		128,
		'input + cacheRead + cacheWrite + cacheWrite1h',
	);
	t.is(flat?.prompt_cache_hit_tokens, 20, 'cacheRead');
	t.is(flat?.prompt_cache_miss_tokens, 108, 'prompt − hit');
	t.is(flat?.completion_tokens, 50, 'output');
	t.is(flat?.total_tokens, 178, 'prompt + completion, never totalTokens');
	t.is(flat?.model, 'glm-5.3-flash');
	t.is(flat?.cwd, '/projects/site');
	t.is(flat?.recordedAt.getTime(), 1_755_500_000_000, 'the message timestamp');
});

/*
The 1h cache write is the whole reason the total is recomputed: pi's
`totalTokens` omits it, so a message whose only usage is a long-lived cache write
must still Ingest and still bill.
*/
test('a message whose only usage is a 1h cache write projects', t => {
	const flat = projectPiMessage(
		message({usage: {cacheWrite1h: 7, totalTokens: 0}}),
		undefined,
	);

	t.is(flat?.prompt_tokens, 7);
	t.is(flat?.total_tokens, 7);
});

/*
The no-token guard, and the only gate: absent or all-zero buckets project
nothing, whatever the stop reason. A message pi aborted before a provider call
has nothing to bill, and ingesting it would be a zero-cost row.
*/
test('a message whose buckets are all absent or zero is skipped', t => {
	t.is(projectPiMessage(message({usage: {}}), undefined), undefined);
	t.is(
		projectPiMessage(
			message({
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cacheWrite1h: 0,
				},
			}),
			undefined,
		),
		undefined,
	);
	t.is(projectPiMessage(message({usage: undefined}), undefined), undefined);
});

/*
Real usage is not dropped for not being a clean turn (spec #63): an errored or
aborted message that still carries tokens Ingets like any other — there is no
`stopReason` special-casing.
*/
test('a message with tokens still projects whatever stopped it', t => {
	const errored = projectPiMessage(
		message({stopReason: 'error', errorMessage: 'boom'}),
		undefined,
	);
	const aborted = projectPiMessage(message({stopReason: 'aborted'}), undefined);

	t.is(errored?.completion_tokens, 50);
	t.is(aborted?.completion_tokens, 50);
});

/*
A payload that is not a JSON object throws, and a usage-bearing message with no
instant to place it at throws — there is no wall-clock fallback here, because
pricing keys on the record's own instant (ADR-0014) and "now" would be a
silently wrong charge.
*/
test('a message that is not an object throws', t => {
	t.throws(() => projectPiMessage('not json', undefined));
	t.throws(() => projectPiMessage(undefined, undefined));
	t.throws(() => projectPiMessage([], undefined));
});

test('a usage-bearing message with no timestamp throws', t => {
	t.throws(() => projectPiMessage(message({timestamp: undefined}), undefined));
	t.throws(() =>
		projectPiMessage(message({timestamp: 'yesterday'}), undefined),
	);
});

test('a tokenless message with no timestamp is a skip, not a throw', t => {
	t.is(
		projectPiMessage(message({usage: {}, timestamp: undefined}), undefined),
		undefined,
	);
});

/*
The model is projected verbatim: canonicalization is the Ingest face's job
(pricing.ts), and this pins the chain — pi's `provider/model` string would store
and price under a name nothing matches otherwise (ADR-0015).
*/
test('the model is left for the Ingest face to canonicalize', t => {
	const flat = projectPiMessage(
		message({model: 'deepseek/deepseek-flash'}),
		undefined,
	);

	t.is(flat?.model, 'deepseek/deepseek-flash', 'projected as pi wrote it');
	t.is(
		canonicalModelName(flat?.model),
		'deepseek-v4.1-flash',
		'and the alias table maps it on the way into the store',
	);
});

/*
The session walk, against self-built temp trees.
------------------------------------------------

A file is a pi session iff its first line is a v3 session header. Everything
else — pi-subagents' worker transcripts, a stale v1/v2 file, a JSONL that is not
a session at all — is excluded structurally, whatever directory holds it.
*/

function header(cwd = '/projects/site'): Record<string, unknown> {
	return {
		type: 'session',
		version: 3,
		id: 'sess-1',
		timestamp: '2026-08-18T07:00:00.000Z',
		cwd,
	};
}

function messageEntry(
	id: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: 'message',
		id,
		parentId: null,
		timestamp: '2026-08-18T07:00:01.000Z',
		message: message(overrides),
	};
}

/*
One sessions root, under the OS's temp directory so nothing a test writes can be
committed by accident — and never `~/.pi`. Keys are paths relative to the root,
so `run-0/` nests the way a per-run session file does on disk.
*/
function sessionsTree(
	t: ExecutionContext,
	files: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>,
): string {
	const root = mkdtempSync(join(tmpdir(), 'jwoo-cli-pi-test-'));
	t.teardown(() => {
		rmSync(root, {recursive: true, force: true});
	});

	for (const [relative, lines] of Object.entries(files)) {
		const file = join(root, relative);
		mkdirSync(dirname(file), {recursive: true});
		writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
	}

	return root;
}

/*
The demoable path: one session file in, its assistant messages out, each with the
`cwd` the header carries.
*/
test('reads one candidate per assistant message, with the header cwd', t => {
	const root = sessionsTree(t, {
		'project-a/2026-08-18_session.jsonl': [
			header('/projects/site'),
			messageEntry('m1'),
			messageEntry('m2', {usage: {input: 1, output: 1}}),
		],
	});

	const scan = readPiSessions(root);

	t.is(scan.scanned, 1);
	t.is(scan.candidates.length, 2);
	t.true(
		scan.candidates.every(candidate => candidate.cwd === '/projects/site'),
	);
});

/*
The v3-header gate, from both sides. A worker transcript — v1, `recordType`
rather than `type`, no session header — is not a session, and neither is a JSONL
that opens with a bare message; a nested per-run `session.jsonl` is a full v3
session and comes in for free.
*/
test('admits only files that open with a v3 session header', t => {
	const root = sessionsTree(t, {
		'subagent-artifacts/worker_transcript.jsonl': [
			{
				version: 1,
				recordType: 'message',
				source: 'async',
				runId: 'run-1',
				agent: 'worker',
				ts: 1_755_500_000_000,
				message: message(),
			},
		],
		'project-a/not-a-session.jsonl': [messageEntry('m1')],
		'project-a/session.jsonl': [header('/projects/a'), messageEntry('m2')],
		'project-a/run-1/run-0/session.jsonl': [
			header('/projects/a'),
			messageEntry('m3'),
		],
	});

	const scan = readPiSessions(root);

	t.is(scan.scanned, 2, 'the two v3 sessions, and neither worker file');
	t.is(scan.candidates.length, 2);
});

/*
`usage` (`kind`) and `compaction` entries are excluded by construction, in
silence: the walk reads only assistant `message` entries, so neither the
cache-warm usage entry nor the compaction's summary usage becomes a record.
*/
test('usage and compaction entries are not candidates', t => {
	const root = sessionsTree(t, {
		'session.jsonl': [
			header(),
			messageEntry('m1'),
			{
				type: 'usage',
				id: 'u1',
				kind: 'cache_warm',
				provider: 'anthropic',
				model: 'claude-sonnet-4-5',
				usage: {input: 0, output: 0, cacheRead: 500, cacheWrite: 0},
			},
			{
				type: 'compaction',
				id: 'c1',
				summary: '…',
				firstKeptEntryId: 'c1',
				tokensBefore: 500,
				usage: {input: 10, output: 5},
			},
		],
	});

	const scan = readPiSessions(root);

	t.is(scan.scanned, 1);
	t.is(scan.candidates.length, 1, 'only the assistant message');
});

/*
A file that cannot be read is a skip inside, not a throw: the walk goes on and
the session that is readable is still scanned.
*/
test('an unreadable file is skipped inside the scan', t => {
	const root = sessionsTree(t, {
		'project-a/session.jsonl': [header(), messageEntry('m1')],
		'project-b/locked.jsonl': [header(), messageEntry('m2')],
	});

	chmodSync(join(root, 'project-b/locked.jsonl'), 0o000);

	const scan = readPiSessions(root);

	t.is(scan.scanned, 1);
	t.is(scan.candidates.length, 1);
});

/*
A root the operator asked for but that cannot be read is the Backfill's own
failure: the walk throws rather than reporting an empty scan.
*/
test('a root that cannot be read throws', t => {
	t.throws(() => readPiSessions(join(tmpdir(), 'jwoo-cli-no-such-pi-root')));
});

/*
The pre-skip: a file whose mtime is older than the bound cannot hold a message
at or after it, so it is not read or counted; a file touched recently enough to
read still yields only its messages at or after the bound.
*/
test('--since pre-skips by mtime and filters each record', t => {
	const root = sessionsTree(t, {
		'project-a/old.jsonl': [header(), messageEntry('m1')],
		'project-a/new.jsonl': [
			header(),
			messageEntry('m2', {timestamp: 1_755_500_000_000}),
			messageEntry('m3', {timestamp: 1_700_000_000_000}),
		],
	});

	const old = new Date(1_700_000_000_000);
	utimesSync(join(root, 'project-a/old.jsonl'), old, old);

	const scan = readPiSessions(root, {since: new Date(1_750_000_000_000)});

	t.is(scan.scanned, 1, 'the pre-skipped file was not read');
	t.is(scan.candidates.length, 1);
	t.is(scan.candidates[0]?.recordedAt.getTime(), 1_755_500_000_000);
});

/*
A session file with no assistant messages is still scanned; it just yields
nothing. The summary's `scanned` counts sessions the walk read, not records.
*/
test('a session with no assistant messages is scanned and yields nothing', t => {
	const root = sessionsTree(t, {
		'session.jsonl': [
			header(),
			{type: 'message', id: 'u1', message: {role: 'user', content: 'hi'}},
		],
	});

	const scan = readPiSessions(root);

	t.is(scan.scanned, 1);
	t.deepEqual(scan.candidates, []);
});
