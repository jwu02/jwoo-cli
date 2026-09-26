#!/usr/bin/env node
/*
The entry point.

Argument parsing, the subcommands, the permission preflight and the Collectors
all live behind it; what is left here is deciding what a command line means and
what a failure prints. A `ConfigError` or a `PreflightError` is reported rather
than thrown: its message is the useful part, and a stack trace is not.

The Collectors in particular are the composition root's rather than this
module's (ADR-0008). Which Collector owns which event is a decision about
collection, and a module that runs the CLI on import is a module no test can
reach.

Nothing here imports ink or react, and that is load-bearing rather than tidy: a
module on the `collect` path that started importing either would drag the whole
TUI into a headless run (ADR-0001). `main.js` reaches `tui.js` through a dynamic
import for the same reason.

  Usage
    $ jwoo-cli            the dashboard: history, read from Atlas
    $ jwoo-cli collect    collect input and Flush it, without the dashboard
    $ jwoo-cli permissions  report the macOS grants collection needs
*/

import process from 'node:process';
import {parseArguments} from './args.js';
import {run} from './main.js';
import {HelperPermissionSource} from './capture/permissions.js';

try {
	await run(parseArguments(), {permissions: new HelperPermissionSource()});
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
