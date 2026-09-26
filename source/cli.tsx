#!/usr/bin/env node
/*
The entry point.

Argument parsing, the subcommands, the permission preflight and the Collectors
all live behind it; what is left here is deciding what a command line means,
which entry point that command runs, and what a failure prints. A `ConfigError`
or a `PreflightError` is reported rather than thrown: its message is the useful
part, and a stack trace is not.

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
*/

import process from 'node:process';
import {parseArguments} from './args.js';
import {runCollect, runDashboard, runPermissions} from './main.js';
import {HelperPermissionSource} from './capture/permissions.js';

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
			await runDashboard({permissions});
			break;
		}

		case 'collect': {
			await runCollect({permissions});
			break;
		}

		case 'permissions': {
			await runPermissions({permissions}, {announceGranted: true});
			break;
		}
	}
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
