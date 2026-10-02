/*
The Shim: OpenCode's side of `usage record-opencode`.

OpenCode has no config-level shell hook, only plugins (research: OpenCode's live
turn-completion hook), so this file is the wiring Claude Code gets from
`settings.json`. It observes `message.updated`, keeps the one event that is a
finished turn, and hands the `info` blob to the CLI on stdin.

It owns exactly two things, and the guard is one of them. `message.updated`
fires on every message-row write — once per step-finish, once more when the turn
closes — so the end-of-turn signal is `time.completed`, which only the closing
write sets. The guard has to live here: the command is handed one blob and has
no way to know whether more are coming.

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
			if (event?.type !== 'message.updated') {
				return;
			}

			const info = event.properties?.info;
			if (info?.role !== 'assistant' || info.time?.completed === undefined) {
				return;
			}

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
			*/
			child.on('error', () => {});

			child.stdin.end(JSON.stringify(info));
		} catch {
			// ADR-0016: no exception escapes into OpenCode.
		}
	},
});
