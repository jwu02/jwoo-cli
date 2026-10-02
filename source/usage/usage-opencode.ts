/*
The OpenCode projection: one raw `info` JSON — an `AssistantMessage` as
OpenCode's `message.updated` event carries it — in, the candidate Usage Record
it represents out.

A pure projection, like the transcript walk beside it: no store, no command, no
network. `usage record-opencode` hands the Shim's payload here and hands what
comes back to the Ingest face, and the Harness string is not set here because
the command that Ingests owns it (CONTEXT.md, Harness).

OpenCode flattens differently from Anthropic, and `reasoning` is the whole of
the difference: it is billed as cache-miss input, so it joins the prompt rather
than the completion. The store's five buckets come out as prompt = input +
cache.write + cache.read + reasoning, hit = cache.read, miss = prompt − hit,
completion = output; `total_tokens` is OpenCode's own `tokens.total` when the
message carries one, and prompt + completion when it does not.

An OpenCode message is one Usage Record rather than a turn: the Harness reports
one request per message, the Shim fires once per completed message, and there is
no chunk dedup to do — the guard that makes `time.completed` the end-of-turn
signal lives in the Shim, because the event fires on every message-row write.

`info.cost` is never read (ADR-0014): the Pricing table is the only cost source
for both Harnesses, and a caller-supplied cost could contradict the record's own
tokens.
*/

import {type UsageRecord} from '../store/local-store.js';

/*
One message's candidate: a Usage Record with no harness yet. The command that
Ingests pairs it with the Harness literal it owns; everything else — the five
buckets, the model id, the cwd, the message's own instant — is this module's to
decide.
*/
export type OpencodeCandidate = Omit<UsageRecord, 'harness'>;

/*
Project one raw `info` payload, or `undefined` when the message carries no
tokens at all.

A payload that is not a JSON object, or one that carries tokens but no
`time.created`, throws — the command reports it on stderr. A message whose token
buckets are all absent or zero is a skip rather than a failure: the
no-token-data guard the walk applies, not a total-guard, so an errored or
summarized message that still carries tokens Ingests like any other (spec #53).
*/
export function projectOpencodeMessage(
	raw: string,
): OpencodeCandidate | undefined {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new Error('the OpenCode message was not a JSON object');
	}

	const tokens = objectAt(parsed, 'tokens');
	const cache = objectAt(tokens, 'cache');

	const input = numberAt(tokens, 'input');
	const output = numberAt(tokens, 'output');
	const reasoning = numberAt(tokens, 'reasoning');
	const cacheRead = numberAt(cache, 'read');
	const cacheWrite = numberAt(cache, 'write');

	/*
	All buckets absent or zero is the whole of the skip rule. The four raw
	counters are what is checked rather than the derived prompt: a message with
	nothing to bill is one OpenCode aborted before any provider call, and
	`total` on such a row, when it is there at all, is zero too.
	*/
	if (
		(input ?? 0) === 0 &&
		(output ?? 0) === 0 &&
		(reasoning ?? 0) === 0 &&
		(cacheRead ?? 0) === 0 &&
		(cacheWrite ?? 0) === 0
	) {
		return undefined;
	}

	const prompt =
		(input ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0) + (reasoning ?? 0);
	const hit = cacheRead ?? 0;
	const miss = prompt - hit;
	const completion = output ?? 0;
	const declaredTotal = numberAt(tokens, 'total');
	const summed = prompt + completion;
	const total = declaredTotal ?? summed;

	/*
	The message's own instant, `time.created` — the turn's start, not the
	`time.completed` the Shim fires at. Pricing keys on it (ADR-0014), so a
	message that reached Ingest late still prices at the instant it was created.
	No fallback to a clock: a payload that carries tokens but no start is one this
	projection cannot place in history, and a record priced at "now" would be a
	silently wrong charge rather than a reported skip.
	*/
	const created = numberAt(objectAt(parsed, 'time'), 'created');
	if (created === undefined) {
		throw new Error('the OpenCode message had no time.created');
	}

	/* eslint-disable @typescript-eslint/naming-convention -- the five buckets keep the wire's column names. */
	return {
		cwd: stringAt(objectAt(parsed, 'path'), 'cwd'),
		model: stringAt(parsed, 'modelID'),
		recordedAt: new Date(created),
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: total,
		prompt_cache_hit_tokens: hit,
		prompt_cache_miss_tokens: miss,
	};
	/* eslint-enable @typescript-eslint/naming-convention */
}

/*
An object, and not an array: `typeof []` is `'object'`, and an array is a
payload this module's contract says throws rather than one that reads as a
message with no fields.
*/
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(
	source: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> | undefined {
	const value = source?.[key];
	return isRecord(value) ? value : undefined;
}

/*
A field read defensively, because the payload is OpenCode's rather than ours:
a value that is missing, or is not the type the field means, is absent rather
than an error.
*/
function numberAt(
	source: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = source?.[key];
	return typeof value === 'number' ? value : undefined;
}

function stringAt(
	source: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = source?.[key];
	return typeof value === 'string' ? value : undefined;
}
