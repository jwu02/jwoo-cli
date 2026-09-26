/*
Argument parsing.

Three commands, and no others: `collect` runs collection headlessly,
`permissions` reports the macOS grants, and no subcommand at all opens the TUI.
That shape is what ADR-0001 asks for — the Collector must be runnable without a
rendered Ink tree, so it cannot be something that only exists inside one.

Parsing is a pure function of argv, so what a given command line means is
testable without a process. `cli.tsx` is what passes in the real `process.argv`
and lets meow exit on a bad one; nothing here does.
*/

import process from 'node:process';
import meow, {type Options, type Result} from 'meow';

export type Command =
	| {readonly kind: 'dashboard'}
	| {readonly kind: 'collect'}
	| {readonly kind: 'permissions'};

/*
No leading description: meow prints `package.json`'s, and stating it here too
prints it twice.
*/
export const HELP_TEXT = `
	Usage
	  $ jwoo-cli              the dashboard: history, live and diagnostics views
	  $ jwoo-cli collect      collect input and Flush it, without the dashboard
	  $ jwoo-cli permissions  report the macOS grants collection needs

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

export function parseArguments(
	argv: readonly string[] = process.argv.slice(2),
): Command {
	const cli = meow(HELP_TEXT, {...MEOW_OPTIONS, argv: [...argv]});

	return commandFor(cli, cli.showHelp);
}
