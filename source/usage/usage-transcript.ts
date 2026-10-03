/*
The Claude Code transcript walk: one `.jsonl` transcript in, the candidate
Usage Records its turns represent out.

A pure projection — no store, no command, no network. `usage record-claude-hook`
and `usage backfill-claude` both hand a transcript path here and hand what comes
back to the Ingest face; the harness string is not set here, because the command
that Ingests owns it (CONTEXT.md, Harness).

A turn is everything from one real user message up to the next. "Real" is the
whole of the boundary rule: a `isMeta` message (a skill's "Base directory…"
payload) and a `tool_result` message are Claude Code's own plumbing, not turns,
and counting them as boundaries splinters one turn into fragments whose earlier
usage is silently dropped.

The boundary rules are ported verbatim from the retired `usage-lib.mjs` — isMeta,
tool_result, `message.id` chunk dedup, `<synthetic>` skip — with the zero-token
turn skip the callers used to apply, and one new guard. Each turn flattens
Anthropic's four buckets into the store's five: prompt = input + cacheRead +
cacheCreate, hit = cacheRead, miss = prompt − hit, completion = output; the
store's `total_tokens` is prompt + completion, which the Anthropic shape never
reports.

The `input.usage` shortcut the retired hook took when the proxy filled it in is
not ported. The walk is the superset: it sees every turn, gives each its own real
`recorded_at`, and re-walks safely because Ingest drops duplicates.
*/

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {type UsageRecord} from '../store/local-store.js';

/*
One turn's candidate: a Usage Record with no harness yet. The command that
Ingests pairs it with the harness literal it owns; everything else — the five
buckets, the model, the cwd, the turn's own instant — is the walk's to decide.
*/
export type TranscriptCandidate = Omit<UsageRecord, 'harness'>;

export type TranscriptOptions = {
	readonly cwd?: string;
	readonly clock?: () => Date;
};

/*
The lines this walk reads, as far as it trusts them: a hand-written transcript
schema rather than the wire's, because the file is Claude Code's, not ours, and
every field is optional as far as we can prove. Values are read defensively and
nothing here validates the whole file.
*/
type Entry = {
	readonly type?: string;
	readonly isMeta?: boolean;
	readonly isSidechain?: boolean;
	readonly cwd?: string;
	readonly timestamp?: string;
	readonly message?: Message;
};

type Message = {
	readonly id?: string;
	readonly model?: string;
	readonly content?: unknown;
	readonly timestamp?: string;
	readonly usage?: Usage;
};

type Usage = {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly cache_creation_input_tokens?: number;
	readonly cache_read_input_tokens?: number;
};

/*
Walk one transcript. A missing, unreadable or `undefined` path degrades to zero
candidates rather than throwing: the hook contract (ADR-0016) makes a bad
transcript a quiet no-op, and the backfill wants the same.
*/
export function walkTranscript(
	transcriptPath: string | undefined,
	options: TranscriptOptions = {},
): TranscriptCandidate[] {
	const entries = readEntries(transcriptPath);
	if (entries === undefined) {
		return [];
	}

	/*
	Keep main and agent streams disjoint by construction.

	Main transcripts carry no sidechain lines; agent transcripts are disjoint
	files whose every message is sidechain. So the file's own shape decides: a
	transcript whose message entries are *all* sidechain is an agent transcript,
	and its sidechain lines are its content — dropping them would lose every
	subagent's usage, live and in the backfill alike. Any transcript with a real
	line is a main transcript, and sidechain lines in it are another stream's,
	dropped rather than double-counted.
	*/
	const messages = entries.filter(
		entry => entry.type === 'user' || entry.type === 'assistant',
	);
	const isAgentTranscript =
		messages.length > 0 && messages.every(entry => entry.isSidechain === true);
	const walked = isAgentTranscript
		? entries
		: entries.filter(entry => entry.isSidechain !== true);

	const boundaries: number[] = [];
	for (const [index, entry] of walked.entries()) {
		if (isTurnBoundary(entry)) {
			boundaries.push(index);
		}
	}

	/*
	The project a session ran in: the caller's `cwd` when the hook carried one,
	else the first real user message's that has one — Claude Code stamps it there,
	and a message that omits it should not hide a later one that carries it.
	Absent both, the record carries no cwd, which the schema allows.
	*/
	const transcriptCwd = boundaries
		.map(index => walked[index]?.cwd)
		.find(cwd => cwd !== undefined);
	const cwd = options.cwd ?? transcriptCwd;

	const clock = options.clock ?? (() => new Date());
	const candidates: TranscriptCandidate[] = [];

	for (const [boundaryIndex, start] of boundaries.entries()) {
		const end = boundaries[boundaryIndex + 1] ?? walked.length;
		const totals = accumulateTurn(walked, start, end);

		const prompt = totals.input + totals.cacheRead + totals.cacheCreate;
		const hit = totals.cacheRead;
		const miss = prompt - hit;
		const completion = totals.output;
		const total = prompt + completion;

		// A turn with no token data is not a Usage Record (the no-token guard the
		// retired callers applied). It still had a timestamp; it just had nothing
		// to bill.
		if (total === 0) {
			continue;
		}

		/*
		The record's own instant, not the walk's: the turn's last assistant
		timestamp, else the user message that started it, else the injected clock.
		Pricing and dedup both key on this (ADR-0014), so a delayed hook delivery
		and a backfill land the same record at the same time.
		*/
		const turnStart = walked[start];
		const recordedAt = totals.timestamp ?? entryInstant(turnStart) ?? clock();

		/* eslint-disable @typescript-eslint/naming-convention -- the five buckets keep the wire's column names. */
		candidates.push({
			cwd,
			model: totals.model,
			recordedAt,
			prompt_tokens: prompt,
			completion_tokens: completion,
			total_tokens: total,
			prompt_cache_hit_tokens: hit,
			prompt_cache_miss_tokens: miss,
		});
		/* eslint-enable @typescript-eslint/naming-convention */
	}

	return candidates;
}

/*
Every transcript file under a projects directory, in a stable order.

The whole tree, `subagents/` included: a subagent's turns are usage like any
other, and they sit in their own `.jsonl` files beside their session's. The walk
is recursive because Claude Code lays sessions out by project, and each project
directory holds its own transcripts and its own `subagents/`.

Sorted, so a Backfill's summary and the order it Ingests in do not depend on the
order the filesystem happens to hand files back. A directory that cannot be read
throws: a scan the operator asked for but could not make is the Backfill's own
failure, and the command is what turns it into exit 1.
*/
export function findTranscripts(root: string): string[] {
	const found: string[] = [];

	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, {withFileTypes: true})) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.isFile() && path.endsWith('.jsonl')) {
				found.push(path);
			}
		}
	};

	walk(root);
	return found.toSorted();
}

/*
Sum one turn's assistant entries into raw Anthropic buckets, the last model seen
and the last timestamp seen.

One API request emits several chunk messages (thinking/text/tool_use) that share
a `message.id` *and* a usage object, so each request counts once; messages with
no id can't be grouped and count as-is. A `<synthetic>` message (harness
plumbing, no usage) is skipped outright, so it can neither count nor hijack the
turn's model.
*/
function accumulateTurn(
	walked: Entry[],
	start: number,
	end: number,
): {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheCreate: number;
	readonly model?: string;
	readonly timestamp?: Date;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheCreate = 0;
	let model: string | undefined;
	let timestamp: Date | undefined;
	const seenRequests = new Set<string>();

	for (let index = start + 1; index < end; index++) {
		const request = countableRequest(walked[index], seenRequests);
		if (request === undefined) {
			continue;
		}

		input += request.usage?.input_tokens ?? 0;
		output += request.usage?.output_tokens ?? 0;
		cacheRead += request.usage?.cache_read_input_tokens ?? 0;
		cacheCreate += request.usage?.cache_creation_input_tokens ?? 0;

		if (request.model !== undefined) {
			model = request.model;
		}

		if (request.timestamp !== undefined) {
			timestamp = request.timestamp;
		}
	}

	return {input, output, cacheRead, cacheCreate, model, timestamp};
}

/*
The one assistant entry in a turn's range that counts — or `undefined` when it
does not.

A `<synthetic>` message is harness plumbing with no usage, so it is skipped
before anything else: it can neither count nor hijack the turn's model. A
request id already seen means this is another chunk of an API request whose
usage was counted once already.
*/
function countableRequest(
	entry: Entry | undefined,
	seenRequests: Set<string>,
):
	| {readonly model?: string; readonly usage?: Usage; readonly timestamp?: Date}
	| undefined {
	if (entry?.type !== 'assistant') {
		return undefined;
	}

	const {message} = entry;
	if (message?.model?.startsWith('<')) {
		return undefined;
	}

	const requestId = message?.id;
	if (requestId !== undefined) {
		if (seenRequests.has(requestId)) {
			return undefined;
		}

		seenRequests.add(requestId);
	}

	return {
		model: message?.model,
		usage: message?.usage,
		timestamp: entryInstant(entry),
	};
}

/*
A line's own instant: Claude Code stamps the entry, and occasionally only the
message inside it. Both spellings are read here so the two places that want a
timestamp — the turn's last assistant and the user message that started it —
cannot drift apart.
*/
function entryInstant(entry: Entry | undefined): Date | undefined {
	const timestamp = entry?.timestamp ?? entry?.message?.timestamp;
	return timestamp === undefined ? undefined : new Date(timestamp);
}

/*
A real user message: not Claude Code's own meta plumbing, and not a tool result
being fed back. Everything else that is a `user` line starts a turn.
*/
function isTurnBoundary(entry: Entry): boolean {
	if (entry.type !== 'user' || entry.isMeta === true) {
		return false;
	}

	const content = entry.message?.content;
	return !(
		Array.isArray(content) &&
		content.some(
			part =>
				typeof part === 'object' &&
				part !== null &&
				(part as {type?: unknown}).type === 'tool_result',
		)
	);
}

/*
Parse the file into entries, or `undefined` when it cannot be read. Malformed
lines are skipped rather than failing the walk: a transcript being appended to
while a hook reads it can end mid-line, and one bad row must not cost the whole
file.
*/
function readEntries(transcriptPath: string | undefined): Entry[] | undefined {
	if (transcriptPath === undefined) {
		return undefined;
	}

	let contents: string;
	try {
		contents = readFileSync(transcriptPath, 'utf8');
	} catch {
		return undefined;
	}

	const entries: Entry[] = [];
	for (const line of contents.split('\n')) {
		if (line.trim() === '') {
			continue;
		}

		try {
			const parsed: unknown = JSON.parse(line);
			// A malformed line, or a JSON value that is not an object (a bare
			// `null` is valid JSON), is not a turn; skip it.
			if (typeof parsed === 'object' && parsed !== null) {
				entries.push(parsed);
			}
		} catch {
			// A malformed line is not a turn; skip it.
		}
	}

	return entries;
}
