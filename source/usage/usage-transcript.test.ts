/*
The Claude transcript walk, against real `.jsonl` files.

The fixtures are self-built trees under the OS's temp directory — never
`~/.claude`, which the gate may not touch — so this is the local-store
exception's sibling: a parser whose whole job is to read a file is tested
against files, and a fake of `readFileSync` would be a fake of the thing under
test. The retired `usage-lib.test.mjs` is the fixture basis; the sidechain,
isMeta, zero-token and fallback cases are new.
*/

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {findTranscripts, walkTranscript} from './usage-transcript.js';

/*
A directory one test owns and gives back, under the OS's temp directory so
nothing a fixture writes can be committed by accident.
*/
function temporaryDirectory(t: ExecutionContext): string {
	const directory = mkdtempSync(join(tmpdir(), 'jwoo-cli-usage-test-'));
	t.teardown(() => {
		rmSync(directory, {recursive: true, force: true});
	});
	return directory;
}

/*
A transcript file one test owns. `lines` are objects — each serialized to one
JSONL row — so a malformed-line fixture passes a raw string.
*/
function transcript(
	t: ExecutionContext,
	lines: Array<Record<string, unknown> | string>,
): string {
	const file = join(temporaryDirectory(t), 'session.jsonl');
	writeFileSync(
		file,
		lines
			.map(line => (typeof line === 'string' ? line : JSON.stringify(line)))
			.join('\n'),
	);
	return file;
}

// One Anthropic usage object, the four buckets the transcript writes.
const tokens = (
	input: number,
	output: number,
	cacheRead = 0,
	cacheCreate = 0,
) => ({
	input_tokens: input,
	output_tokens: output,
	cache_read_input_tokens: cacheRead,
	cache_creation_input_tokens: cacheCreate,
});

const user = (overrides: Record<string, unknown> = {}) => ({
	type: 'user',
	message: {role: 'user', content: 'hello'},
	timestamp: '2026-08-18T07:00:00.000Z',
	...overrides,
});

const assistant = ({
	usage = tokens(100, 50, 20),
	id = 'chatcmpl-REQ1',
	model = 'kimi-k2.7-code',
	content,
	...overrides
}: {
	usage?: Record<string, number>;
	id?: string;
	model?: string;
	content?: Array<Record<string, unknown>>;
	timestamp?: string;
} = {}) => ({
	type: 'assistant',
	message:
		content === undefined
			? {id, role: 'assistant', model, usage}
			: {id, role: 'assistant', model, usage, content},
	timestamp: '2026-08-18T07:00:01.000Z',
	...overrides,
});

test('a turn flattens Anthropic buckets into the store five', t => {
	const file = transcript(t, [
		user(),
		assistant({usage: tokens(100, 50, 20, 30)}),
	]);

	t.deepEqual(walkTranscript(file), [
		{
			cwd: undefined,
			model: 'kimi-k2.7-code',
			recordedAt: new Date('2026-08-18T07:00:01.000Z'),
			prompt_tokens: 150, // Input 100 + cacheRead 20 + cacheCreate 30.
			completion_tokens: 50,
			total_tokens: 200,
			prompt_cache_hit_tokens: 20,
			prompt_cache_miss_tokens: 130, // Prompt − hit.
		},
	]);
});

test('every turn in the transcript is walked, not just the last', t => {
	const file = transcript(t, [
		user(),
		assistant(),
		user({timestamp: '2026-08-18T07:01:00.000Z'}),
		assistant({id: 'chatcmpl-REQ2', usage: tokens(300, 100)}),
	]);

	const candidates = walkTranscript(file);
	t.is(candidates.length, 2);
	t.is(candidates[0]?.completion_tokens, 50);
	t.is(candidates[1]?.completion_tokens, 100);
});

test('a meta user message is not a turn boundary', t => {
	const file = transcript(t, [
		user({
			isMeta: true,
			cwd: '/meta',
			message: {role: 'user', content: 'Base directory for this skill: …'},
			timestamp: '2026-08-18T06:59:00.000Z',
		}),
		user(),
		assistant(),
	]);

	// One turn: the meta message neither starts a turn nor splits the real one.
	t.is(walkTranscript(file).length, 1);
});

test('a tool_result user message is not a turn boundary', t => {
	const file = transcript(t, [
		user(),
		assistant(),
		user({
			message: {
				role: 'user',
				content: [{type: 'tool_result', tool_use_id: 't1', content: 'ok'}],
			},
			timestamp: '2026-08-18T07:00:02.000Z',
		}),
		assistant({id: 'chatcmpl-REQ2', usage: tokens(300, 100)}),
	]);

	const candidates = walkTranscript(file);
	t.is(candidates.length, 1);
	t.is(candidates[0]?.total_tokens, 570); // Both requests in the one turn.
});

test('chunks of one request (same message.id) are counted once', t => {
	const file = transcript(t, [
		user(),
		assistant(),
		assistant({
			usage: tokens(100, 50, 20),
			content: [{type: 'tool_use', name: 'x', input: {}}],
			timestamp: '2026-08-18T07:00:02.000Z',
		}),
	]);

	const candidates = walkTranscript(file);
	t.is(candidates[0]?.prompt_tokens, 120); // Not 240.
	t.is(candidates[0]?.completion_tokens, 50);
});

test('a <synthetic> assistant message neither counts nor hijacks the model', t => {
	const file = transcript(t, [
		user(),
		assistant(),
		assistant({
			id: 'chatcmpl-SYNTH',
			model: '<synthetic>',
			usage: tokens(0, 0),
			timestamp: '2026-08-18T07:00:02.000Z',
		}),
	]);

	const candidates = walkTranscript(file);
	t.is(candidates.length, 1);
	t.is(candidates[0]?.model, 'kimi-k2.7-code');
});

test('a zero-token turn produces no candidate', t => {
	const file = transcript(t, [
		user(),
		assistant({id: 'chatcmpl-ZERO', usage: tokens(0, 0)}),
	]);

	t.deepEqual(walkTranscript(file), []);
});

test('sidechain lines are dropped from a main transcript', t => {
	const file = transcript(t, [
		user(),
		assistant(),
		{
			...user({
				message: {role: 'user', content: 'subagent prompt'},
				timestamp: '2026-08-18T07:00:05.000Z',
			}),
			isSidechain: true,
		},
		{
			...assistant({
				id: 'chatcmpl-SIDE',
				model: 'some-subagent-model',
				usage: tokens(999, 999),
				timestamp: '2026-08-18T07:00:06.000Z',
			}),
			isSidechain: true,
		},
	]);

	const candidates = walkTranscript(file);
	t.is(candidates.length, 1);
	// The main turn's own tokens, not the subagent's.
	t.is(candidates[0]?.prompt_tokens, 120);
});

test('an agent transcript, wholly sidechain, is walked as its own stream', t => {
	const file = transcript(t, [
		{
			...user({
				cwd: '/agent/project',
				message: {role: 'user', content: 'You are implementing Task 2'},
			}),
			isSidechain: true,
		},
		{
			...assistant({
				id: 'chatcmpl-AGENT',
				model: 'some-subagent-model',
				usage: tokens(500, 200, 100),
				timestamp: '2026-08-18T07:00:01.000Z',
			}),
			isSidechain: true,
		},
	]);

	const candidates = walkTranscript(file);
	t.is(candidates.length, 1);
	t.is(candidates[0]?.cwd, '/agent/project');
	t.is(candidates[0]?.total_tokens, 800);
});

test('recorded_at falls back last assistant → the turn’s user message → the clock', t => {
	const file = transcript(t, [
		// No timestamp on the assistant: the user message's is used.
		user({timestamp: '2026-08-18T07:00:00.000Z'}),
		assistant({timestamp: undefined}),
		// A second turn with no timestamp at all: the injected clock is used.
		user({timestamp: undefined}),
		assistant({
			id: 'chatcmpl-REQ2',
			usage: tokens(300, 100),
			timestamp: undefined,
		}),
	]);

	const clockAt = new Date('2026-09-01T00:00:00.000Z');
	const candidates = walkTranscript(file, {clock: () => clockAt});
	t.is(
		candidates[0]?.recordedAt.getTime(),
		Date.parse('2026-08-18T07:00:00.000Z'),
	);
	t.is(candidates[1]?.recordedAt.getTime(), clockAt.getTime());
});

test('cwd: the caller’s wins, else the first real user message’s that has one', t => {
	const file = transcript(t, [
		user({
			isMeta: true,
			cwd: '/meta',
			message: {role: 'user', content: 'meta'},
			timestamp: '2026-08-18T06:59:00.000Z',
		}),
		// The first real user message carries no cwd; a later one does.
		user(),
		user({cwd: '/the/project', timestamp: '2026-08-18T07:01:00.000Z'}),
		assistant(),
	]);

	t.is(walkTranscript(file)[0]?.cwd, '/the/project');
	t.is(walkTranscript(file, {cwd: '/supplied'})[0]?.cwd, '/supplied');
});

test('a missing or unreadable transcript degrades to zero candidates', t => {
	const directory = temporaryDirectory(t);

	t.deepEqual(walkTranscript(join(directory, 'nope.jsonl')), []);
	t.deepEqual(walkTranscript(undefined), []);
});

test('malformed and non-object lines are skipped, not thrown', t => {
	const file = transcript(t, [user(), '{not json', '', 'null', assistant()]);

	t.is(walkTranscript(file).length, 1);
});

/*
The projects-directory walk: every `.jsonl` under the root, `subagents/`
included, and nothing else. Sorted, so a Backfill's summary and its Ingest order
do not depend on the order the filesystem hands files back.
*/
test('findTranscripts walks every nested .jsonl, subagents included', t => {
	const root = temporaryDirectory(t);
	mkdirSync(join(root, 'project-a', 'subagents'), {recursive: true});
	mkdirSync(join(root, 'project-b'), {recursive: true});

	const wanted = [
		join(root, 'project-a', 'session.jsonl'),
		join(root, 'project-a', 'subagents', 'agent-1.jsonl'),
		join(root, 'project-b', 'session.jsonl'),
	].toSorted();
	for (const file of wanted) {
		writeFileSync(file, '');
	}

	// Not transcripts, so not returned.
	writeFileSync(join(root, 'project-a', 'notes.txt'), '');
	writeFileSync(join(root, 'README.md'), '');

	t.deepEqual(findTranscripts(root), wanted);
});
