/*
Everything that talks to the capture helper: where its binary is, its event
stream, its one-shot runs, the fire-and-forget grant request, and where its
problems are reported.

One module rather than a path in one place and a stream in another, because
they are one question — `permissions.ts` asks this binary about the grant and
the Collectors run it, and a path copied between modules is a copy that can
drift. The failure that drift produces is worth naming: two callers would be
talking to different processes, and both would look like they were working.

The stream is the one part of collection that touches the OS, and it is
deliberately thin. Everything subtle — which key a keycode is, what a flag
means, whether a press is a repeat — lives in the Collectors and
`key-character.ts`, where it can be tested against synthetic events on any
machine without a tap, a permission, or a real key press (ADR-0003). What is
left here is a pipe.

The Collectors share one stream rather than each spawning their own. There is
one tap and one grant behind it (ADR-0006), so two processes would mean two
taps racing on the same events for no gain. Spawned lazily by `start()` and
never before, because a helper process outlives the thing that spawned it if it
is not stopped: the Session calls `stop()` on every path, and a stream that was
never started has nothing to leak.

The binary is committed beside the source and resolved from this module rather
than from the working directory, so the CLI can be run from anywhere.
`dist/helper.js` sits one level under the repo root, as `source/helper.ts`
does.
*/

import {execFile, spawn, type ChildProcessByStdio} from 'node:child_process';
import {type Readable} from 'node:stream';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {type HelperError, type RawEvent, parseEventLine} from './raw-event.js';
import {type EventStream as StartStop} from './session.js';

export const HELPER_PATH = fileURLToPath(
	new URL('../helper/bin/eventtap', import.meta.url),
);

/*
The rebuild step, written once. The one broken-install message that does not
fit the sentence below — a run that answered but printed no report — pairs it
with its own lead-in.
*/
export const REBUILD_HINT = 'Rebuild it with ./helper/build.sh.';

/*
The one sentence for a helper that cannot be run — a missing binary, a crash,
a hang — composed here rather than at each call site, so the same failure reads
the same sentence whichever adapter hit it: the stream reports it as a problem,
the one-shot runner rejects with it, and `permissions.ts` passes it through as
a `PreflightError` without recomposing.

`cause` is why the run failed, never what the helper answered: `--preflight`
exits 0 whatever the grant is, so anything that reaches this sentence is a
broken install and not a permission answer. It is flattened to one line —
Node's failure messages end in newlines and carry stderr, and this is one
sentence.
*/
export function brokenInstallMessage(path: string, cause: string): string {
	const reason = cause.replaceAll(/\s+/gv, ' ').trim();

	return `Could not run ${path}: ${reason}. ${REBUILD_HINT}`;
}

/*
A helper line that could not be used. Reported rather than thrown: one bad line
in a stream that runs for hours must not end collection, and a diagnostic that
happens to start with a brace is ordinary rather than exceptional.
*/
export type StreamProblem =
	| {readonly kind: 'error-line'; readonly error: HelperError}
	| {readonly kind: 'unreadable-line'; readonly line: string}
	/*
	A non-zero `code`, or a `signal`, but never both: Node gives one or the
	other, and a helper we killed ourselves reports the signal.

	Absent rather than `null`, which is what Node hands back. Both mean "not
	this one" here, and the distinction Node draws — `null` code with a signal
	against a numeric code with no signal — survives the conversion intact.
	*/
	| {
			readonly kind: 'exited';
			readonly code: number | undefined;
			readonly signal: NodeJS.Signals | undefined;
	  };

export type EventStreamOptions = {
	readonly helperPath?: string;
	/*
	Arguments for the helper. Empty in every real use — a streaming run takes no
	flags — and named here so a test can drive the reader against a process of
	its own choosing rather than against a stand-in for the whole module.
	*/
	readonly helperArgs?: readonly string[];
	/*
	Attached after construction by `wireUp`, because the Collectors that consume
	events need the stream to construct their counterparts and the stream needs
	them to deliver to. One direction has to be a setter; this is the one that
	costs nothing, since no event can arrive before `start()`.
	*/
	readonly onEvent?: (event: RawEvent) => void;
	/*
	Where a problem goes. The Session's logger is not threaded down here because
	a Collector is started and stopped and nothing else (#7) — a Collector that
	could ask for a logger would be a wider interface than the one thing it does.
	*/
	readonly onProblem?: (problem: StreamProblem) => void;
};

/*
Declared as implementing the Session's narrow `EventStream`, so the two cannot
drift: the Session asks only that this starts and stops, and this file is where
the rest of it lives.
*/
export class EventStream implements StartStop {
	readonly #helperPath: string;
	readonly #helperArgs: readonly string[];
	#onEvent: ((event: RawEvent) => void) | undefined;
	readonly #onProblem: (problem: StreamProblem) => void;

	/*
	Stdin closed rather than piped: the helper takes no input, and a writable
	stdin a child never reads is a handle to leak.

	The `null` is the stdio descriptor, not a value — `spawn`'s own type spells
	a closed stdin that way, and the rule against `null` is about a type that
	could have been `undefined` instead. This one could not.
	*/
	// eslint-disable-next-line @typescript-eslint/no-restricted-types
	#child: ChildProcessByStdio<null, Readable, Readable> | undefined;
	/*
	Whether `stop()` has run. Once it has, the child's exit is this process's
	own doing and reporting it as a failure would be wrong — so the handlers
	below check this rather than whether the handle is still set, because
	`stop()` clears the handle *before* killing to make `start()` re-entrant.
	*/
	#stopping = false;
	/*
	A partial line held between reads. stdout arrives in arbitrary chunks, so a
	line can be split across two of them; without this, an event would be
	dropped roughly whenever the pipe happened to flush mid-line.
	*/
	#pending = '';

	constructor({
		helperPath = HELPER_PATH,
		helperArgs = [],
		onEvent,
		onProblem = defaultProblemReporter,
	}: EventStreamOptions) {
		this.#helperPath = helperPath;
		this.#helperArgs = helperArgs;
		this.#onEvent = onEvent;
		this.#onProblem = onProblem;
	}

	/*
	Buffers, splits on newline, and keeps the remainder for the next chunk.
	*/
	#read(chunk: string): void {
		this.#pending = readLines(
			this.#pending,
			chunk,
			this.#onEvent,
			this.#onProblem,
		);
	}

	/*
	The helper's process id while it is running. Exposed for the one thing a
	caller cannot infer from the outside: whether `stop()` actually reached the
	process, which is the difference between a closed tap and one still
	collecting behind an exited CLI.
	*/
	get pid(): number | undefined {
		return this.#child?.pid;
	}

	/*
	The consumer. Setting it twice replaces the first, which is what `wireUp`
	would do if it were called twice — and a second wiring is a bug rather than
	a configuration, so replacing is better than fanning out to both.
	*/
	onEvent(handler: (event: RawEvent) => void): void {
		this.#onEvent = handler;
	}

	start(): void {
		if (this.#child !== undefined) {
			return;
		}

		const child = spawn(this.#helperPath, [...this.#helperArgs], {
			/*
			An array rather than a shell string. The path is resolved from this
			module's own location, and going through a shell would make a path
			with a space in it — a checkout under a directory like `My Projects`
			— a command split into two words.
			*/
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		this.#child = child;
		this.#pending = '';
		// Cleared here rather than in `stop()`, so a stream that is started
		// again after being stopped still reports its helper's death.
		this.#stopping = false;

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			this.#read(chunk);
		});

		/*
		The helper writes its diagnostics to stderr and never to stdout, which
		is what lets stdout be read as nothing but events. Passed through rather
		than swallowed, because the tap's own notes — a re-enable, a missing
		grant — have nowhere else to appear.
		*/
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			process.stderr.write(chunk);
		});

		child.on('error', error => {
			/*
			A helper killed on the way out is ignored rather than announced as a
			failure to start, which is what it would otherwise look like.
			*/
			if (this.#stopping) {
				return;
			}

			this.#onProblem({
				kind: 'error-line',
				error: {
					type: 'error',
					code: 'helperUnavailable',
					message: brokenInstallMessage(this.#helperPath, error.message),
				},
			});
		});

		/*
		A helper that dies takes collection with it and says nothing on its own,
		so its exit is reported. Collection does not stop for it: the Session's
		decision to keep running belongs to the Session, and a Collector here
		cannot end a run.
		*/
		child.on('exit', (code, signal) => {
			if (this.#stopping) {
				return;
			}

			this.#child = undefined;
			this.#onProblem({
				kind: 'exited',
				code: code ?? undefined,
				signal: signal ?? undefined,
			});
		});
	}

	stop(): void {
		const child = this.#child;
		if (child === undefined) {
			return;
		}

		this.#stopping = true;
		this.#child = undefined;
		child.kill();
	}
}

/*
One chunk of stdout, read into events.

Buffers the remainder rather than parsing chunk by chunk, because stdout arrives
in arbitrary pieces and a line can be split across two of them — dropping the
tail would lose an event roughly whenever the pipe happened to flush mid-line.

The final line is only read if it was newline-terminated, which the helper
guarantees: it appends the newline in the same write as the payload, so a reader
never sees a torn line across two syscalls. A trailing fragment is therefore a
sign the helper died mid-write, and is dropped rather than guessed at.

A free function, taking the buffer it is continuing, so that the read path is
testable without a process at all.
*/
function readLines(
	pending: string,
	chunk: string,
	onEvent: ((event: RawEvent) => void) | undefined,
	onProblem: (problem: StreamProblem) => void,
): string {
	const lines = (pending + chunk).split('\n');
	const remainder = lines.pop() ?? '';

	for (const line of lines) {
		if (line.trim() === '') {
			continue;
		}

		const event = parseEventLine(line);
		if (event === undefined) {
			onProblem({kind: 'unreadable-line', line});
			continue;
		}

		onEvent?.(event);
	}

	return remainder;
}

/*
How long a one-shot run may take to answer, before the run is a hang and a
hang is a broken install.
*/
export const DEFAULT_RUN_TIMEOUT_MS = 5000;

export type RunHelperOnceOptions = {
	readonly helperPath?: string;
	readonly timeoutMs?: number;
};

/*
The one-shot run: arguments in, both pipes out.

The counterpart to the stream for the modes that answer and exit rather than
capture — `--preflight` today. `permissions.ts` asks its question through this
rather than wrapping a child process of its own, so asking the helper a
one-shot question goes through one code path and the timeout's default has one
home.

Wrapped by hand rather than with `promisify`, whose inferred return type drops
the `stdout` the callback supplies — reading it would then be an `any`, and
this is exactly the value the caller decides on.

Rejects on any failure to run — spawn failure, non-zero exit, timeout — with
the broken-install sentence already composed. That is load-bearing: the
helper's `--preflight` exits 0 whatever the grant is, so a rejection here is
always a broken install, never a denied grant.
*/
export async function runHelperOnce(
	args: readonly string[],
	{
		helperPath = HELPER_PATH,
		timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
	}: RunHelperOnceOptions = {},
): Promise<{stdout: string; stderr: string}> {
	return new Promise((resolve, reject) => {
		execFile(
			helperPath,
			args,
			{timeout: timeoutMs},
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(brokenInstallMessage(helperPath, error.message)));
					return;
				}

				resolve({stdout, stderr});
			},
		);
	});
}

/*
Asks macOS for the Input Monitoring grant, and returns without waiting.

The only path that prompts. A background job cannot answer a TCC dialog, so a
first run has to be at the keyboard (ADR-0002) — and a caller that has just been
told the grant is missing is exactly that situation.

The helper is spawned and left to it. It reports the grant on stdout, which is
dropped here because `permissions.ts` has already reported it and a second
answer arriving after the caller has moved on would be noise; its own
diagnostics go to stderr, which is inherited so the prompt's explanation is
still visible.

`--request` reports and exits rather than falling through to a tap — see
`helper/eventtap.swift` — and that is what makes leaving it unattended safe. A
mode that streamed would leave a capture process holding a listen-only tap with
nobody reading its stdout, which is exactly the leak the Session's `stop()`
exists to prevent, on the one path that never reaches it.

Not an `EventStream`, because there is nothing to stream and nothing to stop: a
writer on this end would be a pipe nobody reads, and holding it open would keep
a process alive for no reason.
*/
export function requestInputMonitoring(helperPath = HELPER_PATH): void {
	const child = spawn(helperPath, ['--request'], {
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	child.on('error', () => {
		// Nothing to add. `permissions.ts` has already reported the missing
		// grant, and a request that could not be made is that same fact.
	});
}

/*
Where a problem goes when nothing else was supplied. A warning on stderr is the
floor rather than the ideal: the alternative is a stream that fails silently,
which is the one thing the helper's error lines exist to prevent — a consumer
must be able to tell "no input" from "no permission".
*/
export function defaultProblemReporter(problem: StreamProblem): void {
	switch (problem.kind) {
		case 'error-line': {
			process.stderr.write(`[eventtap] ${problem.error.message}\n`);
			return;
		}

		case 'unreadable-line': {
			process.stderr.write(
				`[eventtap] unreadable line on stdout: ${problem.line}\n`,
			);
			return;
		}

		case 'exited': {
			const how =
				problem.signal === undefined
					? `code ${String(problem.code)}`
					: `signal ${problem.signal}`;
			process.stderr.write(
				`[eventtap] the capture helper exited (${how}); input is no longer being collected.\n`,
			);
		}
	}
}
