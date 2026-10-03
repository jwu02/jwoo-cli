/*
The OpenCode half: one raw `info` JSON — an `AssistantMessage` as OpenCode's
`message.updated` event carries it — projected into the candidate Usage Record
it represents, and the database read that finds those blobs in the first place.

The projection is pure, like the transcript walk beside it: no store, no
command, no network. `usage record-opencode` hands the Shim's payload here and
hands what comes back to the Ingest face, and `usage backfill-opencode` reads
OpenCode's SQLite database and hands every assistant message here the same way.
The Harness string is not set here because the command that Ingests owns it
(CONTEXT.md, Harness).

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

import {DatabaseSync} from 'node:sqlite';
import {type UsageRecord} from '../store/local-store.js';

/*
One message's candidate: a Usage Record with no harness yet. The command that
Ingests pairs it with the Harness literal it owns; everything else — the five
buckets, the model id, the cwd, the message's own instant — is this module's to
decide.
*/
export type OpencodeCandidate = Omit<UsageRecord, 'harness'>;

/*
What a caller can supply that the payload itself cannot: the two fields a
database row carries and a live `info` blob does not.

The Shim delivers a message as OpenCode broadcast it, so `time.created` and
`path.cwd` are the only places those two values exist and a payload without them
is one the live command cannot place. A database row has its own `time_created`
column and a session `directory` beside it, and the Backfill passes both here so
its rows resolve the way the retired script resolved them. The live command
passes neither, so its contract is unchanged.
*/
export type OpencodeContext = {
	readonly fallbackRecordedAt?: Date;
	readonly fallbackCwd?: string;
};

/*
Project one raw `info` payload, or `undefined` when the message carries no
tokens at all.

A payload that is not a JSON object, or one that carries tokens but no instant
to place it at — `time.created`, or the caller's `fallbackRecordedAt` — throws;
the command reports it on stderr. A message whose token buckets are all absent
or zero is a skip rather than a failure: the no-token-data guard the walk
applies, not a total-guard, so an errored or summarized message that still
carries tokens Ingests like any other (spec #53).
*/
export function projectOpencodeMessage(
	raw: string,
	context: OpencodeContext = {},
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
	The row's `time_created` is the Backfill's fallback and never a clock: a
	payload that carries tokens but no start, with nothing beside it to place it,
	is one this projection cannot place in history, and a record priced at "now"
	would be a silently wrong charge rather than a reported skip.
	*/
	const created = numberAt(objectAt(parsed, 'time'), 'created');
	const recordedAt =
		created === undefined ? context.fallbackRecordedAt : new Date(created);
	if (recordedAt === undefined) {
		throw new Error('the OpenCode message had no time.created');
	}

	/* eslint-disable @typescript-eslint/naming-convention -- the five buckets keep the wire's column names. */
	return {
		cwd: stringAt(objectAt(parsed, 'path'), 'cwd') ?? context.fallbackCwd,
		model: stringAt(parsed, 'modelID'),
		recordedAt,
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

/*
What one read of an OpenCode database yields: how many assistant message rows it
considered, and the candidates they produced — the same two numbers
`walkTranscript`'s caller gets from a transcript tree, so the Backfill's summary
reads the same either way.
*/
export type OpencodeScan = {
	readonly scanned: number;
	readonly candidates: readonly OpencodeCandidate[];
};

export type OpencodeDatabaseOptions = {
	/*
	Only messages at or after this instant, compared on each candidate's own
	resolved `recorded_at` rather than on the row's `time_created` — the two can
	disagree, and the record's own instant is the one a Backfill bounds by.
	*/
	readonly since?: Date;
};

/*
One OpenCode database in, the candidates its assistant messages represent out.

The companion of `walkTranscript` over OpenCode's own SQLite file rather than a
tree of transcripts. Opened read-only and never written: the DB is OpenCode's,
and a Backfill only reads. A database that cannot be opened throws — a scan the
operator asked for but could not make is the Backfill's own failure — while a
row this module cannot read is skipped, because the file is OpenCode's and one
bad row must not cost the rest.

The row's `data` blob is the same `AssistantMessage` the Shim delivers, so the
projection above is the whole of the reading and this function is the query and
the two fallbacks the row carries that a live payload does not: the row's own
`time_created` for `time.created`, and its session's `directory` for `path.cwd`
(the retired script's mapping, kept).
*/
export function readOpencodeDatabase(
	databasePath: string,
	options: OpencodeDatabaseOptions = {},
): OpencodeScan {
	const db = new DatabaseSync(databasePath, {readOnly: true});

	try {
		const candidates: OpencodeCandidate[] = [];
		let scanned = 0;

		for (const row of db.prepare(OPENCODE_MESSAGES_QUERY).all()) {
			const data = row['message_data'];
			if (typeof data !== 'string' || !isAssistant(data)) {
				continue;
			}

			scanned += 1;

			let candidate: OpencodeCandidate | undefined;
			try {
				candidate = projectOpencodeMessage(data, {
					fallbackRecordedAt: instantAt(row['time_created']),
					fallbackCwd: textAt(row['session_directory']),
				});
			} catch {
				// A row the projection cannot place is not a candidate.
				continue;
			}

			if (
				candidate === undefined ||
				(options.since !== undefined &&
					candidate.recordedAt.getTime() < options.since.getTime())
			) {
				continue;
			}

			candidates.push(candidate);
		}

		return {scanned, candidates};
	} finally {
		db.close();
	}
}

/*
The one query. It reads a row's own instant and blob, and the session it belongs
to for the cwd fallback. Ordered by `time_created`, with the row id breaking
ties, so the candidates arrive in a stable order — which is what makes a scan's
summary and the order it Ingests in independent of the order the database
happens to hand rows back.
*/
const OPENCODE_MESSAGES_QUERY = `
	SELECT m.time_created AS time_created,
	       m.data AS message_data,
	       s.directory AS session_directory
	FROM message m
	JOIN session s ON s.id = m.session_id
	ORDER BY m.time_created ASC, m.id ASC
`;

/*
Whether a raw `data` blob is an assistant message. The role lives in the JSON,
not in a column, so it is the blob that has to be read — and a blob that will not
parse is not an assistant message.
*/
function isAssistant(raw: string): boolean {
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) && parsed['role'] === 'assistant';
	} catch {
		return false;
	}
}

/*
A row's column read as the type it means. `node:sqlite` hands back whatever the
column holds, and a column that is not the shape this module wants is absent
rather than an error — the same defensiveness the payload reads take.
*/
function instantAt(value: unknown): Date | undefined {
	return typeof value === 'number' ? new Date(value) : undefined;
}

function textAt(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
