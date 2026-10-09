/*
The Pi Shim: pi's side of `usage record-pi`.

Pi has no config-level shell hook, only extensions (spec #63: pi's extension surface), so this
file is the wiring Claude Code gets from `settings.json` and
OpenCode gets from its plugin directory. It observes `message_end` and owns two
message kinds: a finished assistant message is handed to the CLI — with the
context's `cwd` and the turn's Skill list — and a user message is scanned for the
`<skill name=…>` tags pi injects into it, keyed by session so a subagent's user
message cannot leak into the parent's.

It owns exactly two things, and the guard is one of them. `message_end` fires
for user, assistant and tool-result messages, so the guard is `role ===
"assistant"` with a usage object present. That is pi's closest analogue of
OpenCode's `message.updated` + `time.completed`; the zero-token skip is the
command's, because the command is the one that knows what a billable bucket is.
The user-message branch is the second: it records the turn's Skill list, which
the assistant message it precedes cannot carry itself.

TypeScript rather than plain JS, because pi loads extensions through jiti and
does not need a build step. The type import is type-only and erased at load, so
the file never reaches for pi's own package at runtime. The spawn line is the
same shape Claude Code's hook wiring and the OpenCode Shim use — pinned node,
absolute build, the checkout's `.env` — and it is deliberately not awaited: pi
awaits its handlers inside the agent loop, so an awaited spawn would delay the
turn it is observing. The handler returns nothing, so it can never ask a
boundary event for a continuation.

The whole handler is wrapped in a catch-all (ADR-0016): the extension runs inside
pi's own process, so an exception escaping here is an exception escaping into the
agent — the Shim is at least as quiet as the command it spawns.
*/

import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

/*
The turn's Skill list, per session id. Pi injects a loaded Skill into the user
message as a `<skill name="…" location="…">` tag, so the tag is where the
turn's Skill Invocations are; the assistant message that follows carries none.
Keyed by session because a subagent runs its own session and its user message
must not become the parent's Skill list.
*/
const pendingSkills = new Map<string, string[]>();

const SKILL_TAG = /<skill name="([^"]+)"/g;

/*
The pinned runtime and this checkout's build. The node version tracks `.nvmrc`,
because the ambient node is older than `node:sqlite` needs and an extension runs
non-interactively. Paths rather than a PATH lookup: pi's own environment is not
the shell's.
*/
const CHECKOUT = join(
	homedir(),
	'Developer/PersonalProjects/personal-website/jwoo-cli',
);
const NODE = join(homedir(), '.nvm/versions/node/v22.23.2/bin/node');
const CLI = join(CHECKOUT, 'dist/cli.js');

/*
`MONGO_URI` is the app's own, read from the checkout's `.env` rather than
inherited: pi's environment is not Claude Code's, and the URI is what the
end-of-invocation Push needs. `if-exists`, so a clone without the gitignored
`.env` still Ingests to the Local Store instead of failing the spawn.
*/
const ENV_FILE = `--env-file-if-exists=${join(CHECKOUT, '.env')}`;

export default function (pi: ExtensionAPI) {
	/*
	Registration only. No process, socket, watcher or timer is started here,
	because some invocations load extensions without starting a session —
	the one-shot spawn belongs inside the handler below.
	*/
	pi.on('message_end', (event, ctx) => {
		try {
			const message = event.message;

			/*
			A user message opens a turn: scan it for Skill tags and hold the list
			under this session until the next user message replaces it. Setting
			even an empty list is the point — a tagless turn must not inherit the
			previous one's Skills.
			*/
			if (message?.role === 'user') {
				pendingSkills.set(
					ctx.sessionManager.getSessionId(),
					skillNamesIn(message.content),
				);
				return;
			}

			if (message?.role !== 'assistant' || message.usage == null) {
				return;
			}

			const skills = pendingSkills.get(ctx.sessionManager.getSessionId());

			const child = spawn(
				NODE,
				[
					'--disable-warning=ExperimentalWarning',
					ENV_FILE,
					CLI,
					'usage',
					'record-pi',
				],
				{stdio: ['pipe', 'ignore', 'inherit']},
			);

			/*
			A spawn that never started — a missing `dist/cli.js` after a pull, a
			bad node path — reports through an `error` event rather than a throw,
			and an unhandled one would come down on pi. Swallowed here for the
			same reason the catch below exists; the CLI's own diagnostics still
			reach stderr through the inherited pipe.

			The child's stdin gets the same treatment: a failed spawn destroys the
			pipe, and `end()` on it reports asynchronously through an `error` event
			the outer `try` cannot see.
			*/
			child.on('error', () => {});
			child.stdin.on('error', () => {});

			child.stdin.end(
				JSON.stringify({
					message,
					cwd: ctx.cwd,
					...(skills === undefined ? {} : {skills}),
				}),
			);
		} catch {
			// ADR-0016: no exception escapes into pi.
		}
	});
}

/*
A user message's Skill tags, in order with repeats kept. Content is a string or
an array of text and image blocks, so the tags are in the text parts; anything
that is not a string or text block contributes none.
*/
function skillNamesIn(content: unknown): string[] {
	const names: string[] = [];

	for (const text of textsIn(content)) {
		for (const match of text.matchAll(SKILL_TAG)) {
			if (match[1] !== undefined) {
				names.push(match[1]);
			}
		}
	}

	return names;
}

function textsIn(content: unknown): string[] {
	if (typeof content === 'string') {
		return [content];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const texts: string[] = [];
	for (const block of content) {
		if (typeof block !== 'object' || block === null) {
			continue;
		}

		const {type, text} = block as {type?: unknown; text?: unknown};
		if (type === 'text' && typeof text === 'string') {
			texts.push(text);
		}
	}

	return texts;
}
