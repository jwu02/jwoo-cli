#!/usr/bin/env node
/*
The entry point.

Argument parsing, the subcommands, the permission preflight and the Collectors
all live behind it; what is left here is deciding what a command line means,
which entry point that command runs, and what a failure prints. A `ConfigError`
or a `PreflightError` is reported rather than thrown: its message is the useful
part, and a stack trace is not.

How a run ended becomes an exit code here and nowhere else, on both paths and
for the same reason: the code is process-wide, and a shell reads it rather than
the log. A run that threw is one; a run that finished with its counters still in
Telemetry State is another, and that one arrives as the Shutdown the collecting
entry points resolve with rather than as a value somebody further in set behind
their back. A command line that does not parse is neither: `parseArguments`
exits on that one itself, before there is a run to report on.

The dispatch is a pairing of command with entry point and nothing else, and it
is here rather than in the composition root because a pairing stated twice can
drift: the entry points take the command they are, from their names, and none of
them is told which one it is.

The Collectors in particular are the composition root's rather than this
module's (ADR-0008). Which Collector owns which event is a decision about
collection, and a module that runs the CLI on import is a module no test can
reach.

Nothing here imports ink or react, and that is load-bearing rather than tidy: a
module on the `collect` path that started importing either would drag the whole
TUI into a headless run (ADR-0001). `main.js` reaches `tui.js` through a dynamic
import for the same reason.

  Usage
    $ jwoo-cli            the dashboard: history, live and diagnostics views
    $ jwoo-cli collect    collect input and Flush it, without the dashboard
    $ jwoo-cli permissions  report the macOS grants collection needs
    $ jwoo-cli usage record-claude-hook  Ingest a Claude Code hook's turns, from stdin
    $ jwoo-cli usage record-opencode  Ingest one OpenCode message, from stdin
    $ jwoo-cli usage backfill-claude [root]  Ingest Claude Code transcripts from a projects dir
    $ jwoo-cli usage backfill-opencode [db]  Ingest OpenCode messages from its own database
    $ jwoo-cli usage backfill-pi [root]  Ingest Pi sessions from a sessions dir

Nothing here sets an exit code for a record command, and that is ADR-0016 rather
than an omission: the record commands exit 0 on every path of their own, so they
resolve with nothing and the process's default code stands. Their failures are
stderr lines, which is the whole point — a non-zero code would surface inside
the agent session the command observes. The Backfills are the operator's
commands and not a hook's, so their own failure is an exit 1 here — and only
their own, since a Usage Backlog that survives a run is not an error.
*/

import process from 'node:process';
import {parseArguments} from './args.js';
import {
	runBackfillClaude,
	runBackfillOpencode,
	runBackfillPi,
	runCollect,
	runDashboard,
	runPermissions,
	runRecordClaudeHook,
	runRecordOpencode,
} from './main.js';
import {HelperPermissionSource} from './capture/permissions.js';
import {type Shutdown} from './session.js';

try {
	/*
	One object, built once and handed to whichever entry point the command
	picked: which permissions source is the real one is this module's decision,
	and it is the same one whatever the run turns out to be.
	*/
	const permissions = new HelperPermissionSource();
	const command = parseArguments();

	/*
	The dispatch, which is a pairing of command with the entry point that runs
	it and no more. `permissions` was asked, so it is the one that announces a
	grant; the two that collect stay quiet about one.
	*/
	switch (command.kind) {
		case 'dashboard': {
			exitCodeFor(await runDashboard({permissions}));
			break;
		}

		case 'collect': {
			exitCodeFor(await runCollect({permissions}));
			break;
		}

		case 'permissions': {
			await runPermissions({permissions}, {announceGranted: true});
			break;
		}

		case 'usage': {
			switch (command.command) {
				/*
				No exit code is read off either record command: the hook contract
				makes every path of its own a clean exit, and each reports through
				stderr instead.
				*/
				case 'record-claude-hook': {
					await runRecordClaudeHook();
					break;
				}

				case 'record-opencode': {
					await runRecordOpencode();
					break;
				}

				/*
				The Backfill is the operator's, so its failure is an exit code: a
				scan or store it could not make comes back with `failed` set, and
				this is the only place that can say so to a shell. A surviving
				Usage Backlog is not that — it comes back clean, with the
				remainder in the summary.
				*/
				case 'backfill-claude': {
					const {failed} = await runBackfillClaude({
						root: command.root,
						dryRun: command.dryRun,
						since: command.since,
					});

					if (failed) {
						process.exitCode = 1;
					}

					break;
				}

				case 'backfill-opencode': {
					const {failed} = await runBackfillOpencode({
						database: command.database,
						dryRun: command.dryRun,
						since: command.since,
					});

					if (failed) {
						process.exitCode = 1;
					}

					break;
				}

				case 'backfill-pi': {
					const {failed} = await runBackfillPi({
						root: command.root,
						dryRun: command.dryRun,
						since: command.since,
					});

					if (failed) {
						process.exitCode = 1;
					}

					break;
				}
			}

			break;
		}
	}
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}

/*
What the run's own report cannot say: a shell reads an exit code, not the log.

A final Flush that failed means the counters were still in Telemetry State when
the store closed, so the run did not end cleanly and this is how it says so. A
Push Backlog that survived the run is not this — the eras are in the Local Store
and what the CLI owes the website is not an exit code (ADR-0012) — which is why
that sentence is the one report that reads and decides nothing.
*/
function exitCodeFor({finalFlush}: Shutdown): void {
	if (!finalFlush) {
		process.exitCode = 1;
	}
}
