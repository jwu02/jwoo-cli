/*
The Shim: OpenCode's side of `usage record-opencode`.

OpenCode has no config-level shell hook, only plugins (research: OpenCode's live
turn-completion hook), so this file is the wiring Claude Code gets from
`settings.json`. It observes `message.updated`, keeps the one event that is a
finished turn, and hands the `info` blob to the CLI on stdin together with the
message's Tool Calls and Skills.

It owns three things, and the guard is one of them. `message.updated` fires on
every message-row write — once per step-finish, once more when the turn closes —
so the end-of-turn signal is `time.completed`, which only the closing write sets.
The guard has to live here: the command is handed one blob and has no way to know
whether more are coming.

The other two are the count and the names, which are not in the `info` blob at
all. OpenCode keeps each tool call in a `part` row and talks about it on the bus
as `message.part.updated`, so this Shim remembers those events per message and,
at completion, sends the count of tool parts and the name of each `skill` part —
the same shape `usage backfill-opencode` derives by joining the `part` table.
Keyed by message id, so a completion only reports its own message's parts, and
cleared when the message completes or the session goes idle.

Plain JS, and no `@opencode-ai/plugin` import: the installed type package lags
the binary (1.14.24 beside 1.18.32), so the package would describe a payload
this file must not trust anyway. The spawn line is the same shape Claude Code's
hook wiring uses — pinned node, absolute build, the checkout's `.env` — and it
is deliberately not awaited: OpenCode's event bus is not made to wait on a
telemetry write.

The whole handler is wrapped in a catch-all (ADR-0016): the plugin runs inside
OpenCode's own process, so an exception escaping here is an exception escaping
into the agent — the Shim is at least as quiet as the command it spawns.
*/

import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';

/*
The tool parts seen so far, by message id: `sessionID` so a session's leftovers
can be dropped when it goes idle, and the Skill's name per part id (or
`undefined` when the part is a tool that is not a `skill`). Keyed by part id so
a part updated several times — running, then completed — is still one Tool Call.
*/
const pendingToolParts = new Map();

/*
The pinned runtime and this checkout's build. The node version tracks `.nvmrc`,
because the ambient node is older than `node:sqlite` needs and hooks run
non-interactively. Paths rather than a PATH lookup: OpenCode's own environment
is not the shell's.
*/
const CHECKOUT = join(
	homedir(),
	'Developer/PersonalProjects/personal-website/jwoo-cli',
);
const NODE = join(homedir(), '.nvm/versions/node/v22.23.2/bin/node');
const CLI = join(CHECKOUT, 'dist/cli.js');

/*
`MONGO_URI` is the app's own, read from the checkout's `.env` rather than
inherited: OpenCode's environment is not Claude Code's, and the URI is what the
end-of-invocation Push needs. `if-exists`, so a clone without the gitignored
`.env` still Ingests to the Local Store instead of failing the spawn.
*/
const ENV_FILE = `--env-file-if-exists=${join(CHECKOUT, '.env')}`;

export const Jwoo = async () => ({
	event: async ({event}) => {
		try {
			if (event?.type === 'message.part.updated') {
				rememberToolPart(event.properties?.part);
				return;
			}

			if (event?.type === 'message.part.removed') {
				forgetToolPart(event.properties?.messageID, event.properties?.partID);
				return;
			}

			if (event?.type === 'session.idle' || event?.type === 'session.error') {
				forgetSession(event.properties?.sessionID);
				return;
			}

			if (event?.type !== 'message.updated') {
				return;
			}

			const info = event.properties?.info;
			if (info?.role !== 'assistant' || info.time?.completed === undefined) {
				return;
			}

			const {toolCalls, skills} = takeToolSummary(info.id);

			const child = spawn(
				NODE,
				[
					'--disable-warning=ExperimentalWarning',
					ENV_FILE,
					CLI,
					'usage',
					'record-opencode',
				],
				{stdio: ['pipe', 'ignore', 'inherit']},
			);

			/*
			A spawn that never started — a missing `dist/cli.js` after a pull, a
			bad node path — reports through an `error` event rather than a throw,
			and an unhandled one would come down on OpenCode. Swallowed here for
			the same reason the catch below exists; the CLI's own diagnostics
			still reach stderr through the inherited pipe.

			The child's stdin gets the same treatment: a failed spawn destroys the
			pipe, and `end()` on it reports asynchronously through an `error` event
			the outer `try` cannot see.
			*/
			child.on('error', () => {});
			child.stdin.on('error', () => {});

			child.stdin.end(JSON.stringify({info, toolCalls, skills}));
		} catch {
			// ADR-0016: no exception escapes into OpenCode.
		}
	},
});

/*
Remember one `message.part.updated` tool part. A `skill` part is a tool like any
other — it counts — and its `state.input.name` is the Skill Invocation's name.
Any other part, or a part missing its ids, is not one this Shim can place.
*/
function rememberToolPart(part) {
	if (
		part?.type !== 'tool' ||
		typeof part.messageID !== 'string' ||
		typeof part.id !== 'string'
	) {
		return;
	}

	const message = pendingToolParts.get(part.messageID) ?? {
		sessionID: part.sessionID,
		parts: new Map(),
	};

	const skillName = part.tool === 'skill' ? part.state?.input?.name : undefined;
	message.parts.set(part.id, typeof skillName === 'string' ? skillName : undefined);
	pendingToolParts.set(part.messageID, message);
}

function forgetToolPart(messageID, partID) {
	if (typeof messageID !== 'string' || typeof partID !== 'string') {
		return;
	}

	pendingToolParts.get(messageID)?.parts.delete(partID);
}

function forgetSession(sessionID) {
	if (typeof sessionID !== 'string') {
		return;
	}

	for (const [messageID, message] of pendingToolParts) {
		if (message.sessionID === sessionID) {
			pendingToolParts.delete(messageID);
		}
	}
}

/*
The message's Tool Call count and Skill names, and the record drops with it.
`0` and `[]` mean none: the Shim saw the message complete and had no tool parts
for it. Ordered as the parts arrived, so repeats stay in invocation order.

shortcut: only the parts seen before `time.completed` are counted, which is
right as long as OpenCode closes the turn after its parts are written; upgrade
if a live run shows a tool part arriving after the completion event.
*/
function takeToolSummary(messageID) {
	const message = pendingToolParts.get(messageID);
	pendingToolParts.delete(messageID);

	if (message === undefined) {
		return {toolCalls: 0, skills: []};
	}

	const skills = [...message.parts.values()].filter(name => name !== undefined);
	return {toolCalls: message.parts.size, skills};
}
