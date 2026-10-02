/*
Argument parsing.

Three command groups, and no others: the dashboard is what no subcommand opens,
`collect` runs the same collection headlessly, and `permissions` reports the
macOS grants. That shape is what ADR-0001 asks for — the Collector must be
runnable without a rendered Ink tree, so it cannot be something that only exists
inside one.

`usage` is the third group: it holds the commands that Ingest AI usage (spec
#53), and a group rather than four more top-level commands because they share a
shape — each reads a Harness's own artifact and Ingests through the same store
face — and because `usage` alone names nothing. Only `record-claude-hook` is
wired so far; the record and Backfill siblings land beside it.

Parsing is a pure function of argv, so what a given command line means is
testable without a process. `cli.tsx` is what passes in the real `process.argv`
and lets meow exit on a bad one; nothing here does.
*/

import process from 'node:process';
import meow, {type Options, type Result} from 'meow';

/*
The commands of the `usage` group. The two live record commands are wired; the
two Backfills land with their own tickets, and the group is the argv surface
they slot into, so it is named once here.
*/
export type UsageCommand = 'record-claude-hook' | 'record-opencode';

export type Command =
	| {readonly kind: 'dashboard'}
	| {readonly kind: 'collect'}
	| {readonly kind: 'permissions'}
	| {readonly kind: 'usage'; readonly command: UsageCommand};

/*
No leading description: meow prints `package.json`'s, and stating it here too
prints it twice.
*/
export const HELP_TEXT = `
	Usage
	  $ jwoo-cli                           the dashboard: history, live and diagnostics views
	  $ jwoo-cli collect                   collect input and Flush it, without the dashboard
	  $ jwoo-cli permissions               report the macOS grants collection needs
	  $ jwoo-cli usage record-claude-hook  Ingest a Claude Code hook's turns, from stdin
	  $ jwoo-cli usage record-opencode     Ingest one OpenCode message, from stdin

	Options
	  --help     Show this help
	  --version  Show the version

	Collection runs in this process and stops when it exits. Ctrl-C Flushes what
	has accumulated before quitting.
`;

const MEOW_OPTIONS: Options<Record<never, never>> = {
	importMeta: import.meta,
	/*
	A typo'd flag is a mistake worth reporting rather than something to pass
	through: there are no flags to forward, and a silently ignored one looks the
	same as one that was honoured.
	*/
	allowUnknownFlags: false,
};

/*
One argument or none. A bare `jwoo-cli dashboard` is rejected rather than
treated as the default, so the two spellings cannot drift apart.
*/
export function commandFor(
	{input}: Pick<Result<Record<never, never>>, 'input'>,
	showHelp: (exitCode?: number) => never,
): Command {
	const [subcommand, ...rest] = input;

	/*
	The group takes the rest of the line rather than being flattened into the
	switch below, because its argument is a command of its own and the top-level
	rule — everything after the subcommand is a stray argument — does not hold
	for it.
	*/
	if (subcommand === 'usage') {
		return usageCommandFor(rest, showHelp);
	}

	if (rest.length > 0) {
		showHelp(2);
	}

	switch (subcommand) {
		case undefined: {
			return {kind: 'dashboard'};
		}

		case 'collect': {
			return {kind: 'collect'};
		}

		case 'permissions': {
			return {kind: 'permissions'};
		}

		default: {
			return showHelp(2);
		}
	}
}

/*
The command the `usage` group names, and nothing after it. `usage` alone is
rejected rather than defaulted to any one of its commands, for the reason a bare
`dashboard` is: a spelling that means something only by convention is the one
that drifts.
*/
function usageCommandFor(
	args: readonly string[],
	showHelp: (exitCode?: number) => never,
): Command {
	const [command, ...rest] = args;

	if (rest.length > 0) {
		showHelp(2);
	}

	switch (command) {
		case 'record-claude-hook':
		case 'record-opencode': {
			return {kind: 'usage', command};
		}

		case undefined:
		default: {
			return showHelp(2);
		}
	}
}

export function parseArguments(
	argv: readonly string[] = process.argv.slice(2),
): Command {
	const cli = meow(HELP_TEXT, {...MEOW_OPTIONS, argv: [...argv]});

	return commandFor(cli, cli.showHelp);
}
