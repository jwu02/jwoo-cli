/*
The OpenCode message projection, against fixture `info` JSONs.

The fixtures are hand-written `AssistantMessage` payloads rather than rows from
the real OpenCode database: `~/.config/opencode` is not the gate's to touch, and
the projector's subject is the blob, not the DB the Backfill will read it from.
The fields are OpenCode's own spelling — `modelID`, `path.cwd`,
`tokens.cache.read` — so a camelCased fixture would test a payload nothing
produces.
*/

import test from 'ava';
import {canonicalModelName} from '../store/pricing.js';
import {projectOpencodeMessage} from './usage-opencode.js';

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
