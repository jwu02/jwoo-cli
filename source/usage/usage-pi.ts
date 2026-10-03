/*
The Pi half: one assistant message projected into the candidate Usage Record it
represents, and the recursive walk over pi's session logs that finds those
messages in the first place.

The projection is pure, like the transcript walk and the OpenCode projection
beside it: no store, no command, no network. `usage backfill-pi` hands every
message of a session to it, and `usage record-pi` will hand the extension's
payload to the same function — the Harness string is not set here because the
command that Ingests owns it (CONTEXT.md, Harness).

One Usage Record per assistant message, with no turn-summing and no chunk dedup:
a pi assistant message *is* one API request with its own usage, and pi has none
of Anthropic's transcript plumbing to fold.

Pi flattens like the other two Harnesses — cache reads are hits, everything that
is not output is miss — with two wrinkles of its own:

- `cacheWrite1h` is a bucket pi keeps apart from `cacheWrite`, and its own
  `totalTokens` omits it. So the record's total is recomputed as
  `prompt + completion` rather than trusted, or a long-lived cache write would
  be silently unbilled.
- `reasoning` is not read: pi bills thinking inside `output`, unlike OpenCode's
  separate reasoning counter.

`message.timestamp` — the instant the message was created, not the entry's write
time — is the record's own `recorded_at`. `usage.cost` is never read (ADR-0014):
the Pricing table is the only cost source, and a provider-supplied cost could
contradict the record's own tokens.
*/

import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {type UsageRecord} from '../store/local-store.js';

/*
One message's candidate: a Usage Record with no harness yet. The command that
Ingests pairs it with the Harness literal it owns; everything else — the five
buckets, the model, the message's own instant — is this module's to decide.
*/
export type PiCandidate = Omit<UsageRecord, 'harness'>;

/*
Project one pi assistant message, or `undefined` when it carries no tokens at
all.

The message is the `message` field of a session's `message` entry — the same
shape the extension hands `usage record-pi` — and `cwd` is the session's own,
from the header (Backfill) or the extension context (live). One per session,
with no fallback chain.

A message whose five token buckets are all absent or zero is a skip rather than
a failure: a control message with nothing to bill. That guard is the only gate
on a usage-bearing message — no `stopReason` special-casing, so a message pi
reports real consumed tokens on Ingets whatever stopped it (spec #63).

A message that carries tokens but no instant to place them at throws: there is
no wall-clock fallback, because pricing keys on the record's own instant
(ADR-0014) and "now" would be a silently wrong charge.
*/
export function projectPiMessage(
	message: unknown,
	cwd: string | undefined,
): PiCandidate | undefined {
	if (!isRecord(message)) {
		throw new Error('the pi message was not a JSON object');
	}

	const usage = objectAt(message, 'usage');
	const input = numberAt(usage, 'input');
	const output = numberAt(usage, 'output');
	const cacheRead = numberAt(usage, 'cacheRead');
	const cacheWrite = numberAt(usage, 'cacheWrite');
	const cacheWrite1h = numberAt(usage, 'cacheWrite1h');

	/*
	All five buckets absent or zero is the whole of the skip rule. Pi's own
	`totalTokens` is not consulted: it omits `cacheWrite1h`, so a message whose
	only usage is a long-lived cache write is usage-bearing and must Ingest.
	*/
	if (
		(input ?? 0) === 0 &&
		(output ?? 0) === 0 &&
		(cacheRead ?? 0) === 0 &&
		(cacheWrite ?? 0) === 0 &&
		(cacheWrite1h ?? 0) === 0
	) {
		return undefined;
	}

	const prompt =
		(input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (cacheWrite1h ?? 0);
	const hit = cacheRead ?? 0;
	const miss = prompt - hit;
	const completion = output ?? 0;

	const timestamp = numberAt(message, 'timestamp');
	if (timestamp === undefined) {
		throw new Error('the pi message had no timestamp');
	}

	/* eslint-disable @typescript-eslint/naming-convention -- the five buckets keep the wire's column names. */
	return {
		cwd,
		model: stringAt(message, 'model'),
		recordedAt: new Date(timestamp),
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		prompt_cache_hit_tokens: hit,
		prompt_cache_miss_tokens: miss,
	};
	/* eslint-enable @typescript-eslint/naming-convention */
}

/*
What one walk of a sessions root yields: how many session files it read, and the
candidates their assistant messages produced — the same two numbers
`readOpencodeDatabase` hands the Backfill, so the summary reads the same either
way.
*/
export type PiScan = {
	readonly scanned: number;
	readonly candidates: readonly PiCandidate[];
};

export type PiScanOptions = {
	/*
	Only messages at or after this instant, compared on each candidate's own
	`recorded_at`. A file whose mtime is older than the bound cannot hold one and
	is skipped before it is read.
	*/
	readonly since?: Date;
};

/*
One sessions root in, every message of every session under it out.

A `*.jsonl` file is a pi session iff its **first line is a v3 session header**.
The rule is structural rather than directory-shaped, which is what makes nested
per-run session files — each a full v3 session with its own header and its own
usage — come in for free, while pi-subagents' worker transcripts, a different
format family that opens with no session header, are excluded by construction
rather than by a path pattern. A file that cannot be read is a skip inside; a
root the operator asked for but that cannot be read throws, because that is the
Backfill's own failure rather than a file's.

`usage` (any `kind`) and `compaction` entries are excluded by construction, in
silence: the walk reads only `message` entries whose role is `assistant`, so no
other entry kind is ever projected. Zero exist on this machine; billed cache-warm
usage arriving would be a data change and a ticket, not a per-run stderr nag.
*/
export function readPiSessions(
	root: string,
	options: PiScanOptions = {},
): PiScan {
	const candidates: PiCandidate[] = [];
	let scanned = 0;

	for (const file of findSessionFiles(root)) {
		if (isOlderThan(file, options.since)) {
			continue;
		}

		const session = readSession(file);
		if (session === undefined) {
			continue;
		}

		scanned += 1;

		for (const entry of session.entries) {
			const candidate = candidateFrom(entry, session.cwd, options.since);
			if (candidate !== undefined) {
				candidates.push(candidate);
			}
		}
	}

	return {scanned, candidates};
}

/*
One entry as a candidate, or `undefined` when it is not an assistant message
this walk can place. A message the projection throws on is not a candidate, the
same rule the OpenCode row reader applies: the file is pi's, and one bad message
must not cost the rest. (The projection still throws, so the live command reports
its own bad payload.)
*/
function candidateFrom(
	entry: Record<string, unknown>,
	cwd: string | undefined,
	since: Date | undefined,
): PiCandidate | undefined {
	const {message} = entry;
	if (
		entry['type'] !== 'message' ||
		!isRecord(message) ||
		message['role'] !== 'assistant'
	) {
		return undefined;
	}

	let candidate: PiCandidate | undefined;
	try {
		candidate = projectPiMessage(message, cwd);
	} catch {
		return undefined;
	}

	if (
		candidate === undefined ||
		(since !== undefined && candidate.recordedAt.getTime() < since.getTime())
	) {
		return undefined;
	}

	return candidate;
}

/*
A parsed session: the `cwd` its header carries, and the entries after it.
*/
type PiSession = {
	readonly cwd: string | undefined;
	readonly entries: ReadonlyArray<Record<string, unknown>>;
};

/*
Read one file as a session, or `undefined` when it cannot be read or does not
open with a v3 session header. The header is the first line and nothing else: a
file that starts with a blank line, or with anything but `{"type":"session",
"version":3,…}`, is not a pi session, whatever it holds further down.
*/
function readSession(file: string): PiSession | undefined {
	const lines = readLines(file);
	if (lines === undefined) {
		return undefined;
	}

	const header = parseLine(lines[0]);
	if (header?.['type'] !== 'session' || header['version'] !== 3) {
		return undefined;
	}

	const entries: Array<Record<string, unknown>> = [];
	for (const line of lines.slice(1)) {
		const entry = parseLine(line);
		if (entry !== undefined) {
			entries.push(entry);
		}
	}

	return {cwd: stringAt(header, 'cwd'), entries};
}

/*
Every `*.jsonl` file under a root, in a stable order.

Sorted, so a Backfill's summary and the order it Ingests in do not depend on the
order the filesystem happens to hand files back. A directory that cannot be read
throws: a scan the operator asked for but could not make is the Backfill's own
failure, and the command is what turns it into exit 1.
*/
function findSessionFiles(root: string): string[] {
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
The file's lines, or `undefined` when it cannot be read. An unreadable file is a
skip inside the scan, not a throw.

The lines are split but not trimmed: the header rule is about the first line, and
a leading blank line means the file does not open with a header.
*/
function readLines(file: string): string[] | undefined {
	try {
		return readFileSync(file, 'utf8').split('\n');
	} catch {
		return undefined;
	}
}

/*
Parse one line, or `undefined` when it is blank, malformed, or a JSON value that
is not an object (a bare `null` is valid JSON). One bad line must not cost the
rest of the session.
*/
function parseLine(
	line: string | undefined,
): Record<string, unknown> | undefined {
	if (line === undefined || line.trim() === '') {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(line);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/*
Whether a session is too old to hold a message at or after `since`. A file's
mtime is at least its last message's time, so a file older than the bound cannot
hold a record at or after it and is skipped before it is read. A stat that fails
is not a skip: the read that follows degrades an unreadable file to nothing on
its own.
*/
function isOlderThan(file: string, since: Date | undefined): boolean {
	if (since === undefined) {
		return false;
	}

	try {
		return statSync(file).mtime.getTime() < since.getTime();
	} catch {
		return false;
	}
}

/*
An object, and not an array: `typeof []` is `'object'`, and an array is a value
this module's contract says throws rather than one that reads as a message with
no fields.
*/
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(
	source: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = source[key];
	return isRecord(value) ? value : undefined;
}

/*
A field read defensively, because the payload is pi's rather than ours: a value
that is missing, or is not the type the field means, is absent rather than an
error.
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
