/*
Argument parsing.

Three command groups, and no others: the dashboard is what no subcommand opens,
`collect` runs the same collection headlessly, and `permissions` reports the
macOS grants. That shape is what ADR-0001 asks for — the Collector must be
runnable without a rendered Ink tree, so it cannot be something that only exists
inside one.

`usage` is the third group: it holds the commands that Ingest AI usage (spec
#53), and a group rather than three more top-level commands because they share a
shape — each reads a Harness's own artifact and Ingests through the same store
face — and because `usage` alone names nothing. The two record commands take
their payload on stdin and nothing else; the two Backfills are the operator's,
and each carries a positional artifact and the flags a scan takes.

Parsing is a pure function of argv, so what a given command line means is
testable without a process. `cli.tsx` is what passes in the real `process.argv`
and lets meow exit on a bad one; nothing here does.
*/

import process from 'node:process';
import meow, {type Options, type Result} from 'meow';

export type Command =
	| {readonly kind: 'dashboard'}
	| {readonly kind: 'collect'}
	| {readonly kind: 'permissions'}
	| {readonly kind: 'usage'; readonly command: 'record-claude-hook'}
	| {readonly kind: 'usage'; readonly command: 'record-opencode'}
	| {
			readonly kind: 'usage';
			readonly command: 'backfill-claude';
			/*
			The projects directory to scan; absent means Claude Code's own, which
			the entry point resolves rather than this module.
			*/
			readonly root: string | undefined;
			/*
			Classify every candidate against the real store without writing — the
			preview the retired script offered (spec #53).
			*/
			readonly dryRun: boolean;
			/*
			Only turns at or after this instant, resolved from `--since`; absent
			means no bound.
			*/
			readonly since: Date | undefined;
	  }
	| {
			readonly kind: 'usage';
			readonly command: 'backfill-opencode';
			/*
			The database to read; absent means OpenCode's own, which the entry
			point resolves rather than this module.
			*/
			readonly database: string | undefined;
			/*
			The same two flags `backfill-claude` carries, for the same reasons.
			*/
			readonly dryRun: boolean;
			readonly since: Date | undefined;
	  };

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
	  $ jwoo-cli usage backfill-claude [root]
	                                       Ingest Claude Code transcripts from a projects dir
	  $ jwoo-cli usage backfill-opencode [db]
	                                       Ingest OpenCode messages from its own database

	Options
	  --help     Show this help
	  --version  Show the version

	Backfill options
	  --dry-run  classify every candidate without writing
	  --since    only turns at or after this ISO instant

	Collection runs in this process and stops when it exits. Ctrl-C Flushes what
	has accumulated before quitting.
`;

const MEOW_OPTIONS: Options<{
	dryRun: {type: 'boolean'};
	since: {type: 'string'};
}> = {
	importMeta: import.meta,
	/*
	A flag this module does not declare is a typo worth reporting rather than
	something to pass through: a silently ignored one looks the same as one that
	was honoured.
	*/
	allowUnknownFlags: false,
	/*
	The two Backfill flags, declared so meow knows them rather than refusing them
	outright. Which commands may carry them is this module's decision, not
	meow's — `commandFor` refuses a flag on any command that does not take one.
	*/
	flags: {
		dryRun: {type: 'boolean'},
		since: {type: 'string'},
	},
};

/*
One argument or none. A bare `jwoo-cli dashboard` is rejected rather than
treated as the default, so the two spellings cannot drift apart.
*/
export function commandFor(
	{input, flags}: Pick<Result<Record<never, never>>, 'input' | 'flags'>,
	showHelp: (exitCode?: number) => never,
	/*
	The line as it was typed, which `flags` cannot always stand in for: meow
	hands back `false` both for an absent boolean flag and for one written
	`--dry-run=false`, so only the raw text says whether one was carried.
	*/
	argv: readonly string[] = [],
): Command {
	const [subcommand, ...rest] = input;

	/*
	The group takes the rest of the line rather than being flattened into the
	switch below, because its argument is a command of its own and the top-level
	rule — everything after the subcommand is a stray argument — does not hold
	for it.
	*/
	if (subcommand === 'usage') {
		return usageCommandFor(rest, flags, argv, showHelp);
	}

	/*
	No top-level command takes a flag, so meow knowing the Backfill's two is not
	the same as them being accepted everywhere: `collect --dry-run` is the same
	mistake it always was.
	*/
	if (rest.length > 0 || hasBackfillFlags(flags, argv)) {
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
The command the `usage` group names. `usage` alone is rejected rather than
defaulted to any one of its commands, for the reason a bare `dashboard` is: a
spelling that means something only by convention is the one that drifts.

The two record commands take no flags — their payload arrives on stdin — so a
flag on one is a typo, refused here rather than passed through.
*/
function usageCommandFor(
	args: readonly string[],
	flags: Record<string, unknown>,
	argv: readonly string[],
	showHelp: (exitCode?: number) => never,
): Command {
	const [command, ...rest] = args;

	switch (command) {
		case 'record-claude-hook':
		case 'record-opencode': {
			if (rest.length > 0 || hasBackfillFlags(flags, argv)) {
				showHelp(2);
			}

			return {kind: 'usage', command};
		}

		case 'backfill-claude': {
			const [root, ...extra] = rest;
			if (extra.length > 0) {
				showHelp(2);
			}

			return {
				kind: 'usage',
				command,
				root,
				dryRun: flags['dryRun'] === true,
				since: sinceFrom(flags['since'], showHelp),
			};
		}

		case 'backfill-opencode': {
			const [database, ...extra] = rest;
			if (extra.length > 0) {
				showHelp(2);
			}

			return {
				kind: 'usage',
				command,
				database,
				dryRun: flags['dryRun'] === true,
				since: sinceFrom(flags['since'], showHelp),
			};
		}

		case undefined:
		default: {
			return showHelp(2);
		}
	}
}

/*
Whether a line carried any of the Backfill's flags. Both halves are needed and
neither is redundant: the parsed flags carry `--since`'s value, which the text
does not have to hand, while the text is the only thing that knows about a flag
written `--dry-run=false` — meow parses that to `false`, the same value it gives
an absent one. What the operator typed is the question either way.
*/
function hasBackfillFlags(
	flags: Record<string, unknown>,
	argv: readonly string[],
): boolean {
	return (
		flags['dryRun'] === true ||
		flags['since'] !== undefined ||
		argv.some(argument => BACKFILL_FLAG.test(argument))
	);
}

/*
A bare `--dry-run`, a negated `--no-dry-run`, or either flag with a value:
`\b` keeps `--since` from matching a word that merely starts with it.
*/
const BACKFILL_FLAG = /^--(?:no-)?(?:dry-run|since)\b/v;

/*
`--since`, as an instant. An unparseable one is a bad command line rather than a
filter that silently matches nothing, so it is refused with the same code a typo
is.
*/
function sinceFrom(
	value: unknown,
	showHelp: (exitCode?: number) => never,
): Date | undefined {
	if (value === undefined) {
		return undefined;
	}

	// A string flag's value arrives as a string; anything else is a shape this
	// command never declared, so it is refused like a bad instant.
	if (typeof value !== 'string') {
		showHelp(2);
	}

	const since = new Date(value);
	if (Number.isNaN(since.getTime())) {
		showHelp(2);
	}

	return since;
}

export function parseArguments(
	argv: readonly string[] = process.argv.slice(2),
): Command {
	const cli = meow(HELP_TEXT, {...MEOW_OPTIONS, argv: [...argv]});

	return commandFor(cli, cli.showHelp, argv);
}
