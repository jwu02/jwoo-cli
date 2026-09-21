#!/usr/bin/env node
/*
The entry point.

Argument parsing, the subcommands and the permission preflight live behind it;
what is left here is deciding what a command line means and what a failure
prints. A `ConfigError` or a `PreflightError` is reported rather than thrown:
its message is the useful part, and a stack trace is not.

  Usage
    $ jwoo-cli            the dashboard: history, read from Atlas
    $ jwoo-cli collect    collect input and Flush it, without the dashboard
    $ jwoo-cli permissions  report the macOS grants collection needs
*/

import process from 'node:process';
import {parseArguments} from './args.js';
import {type CollectorFactory, run} from './main.js';
import {HelperPermissionSource} from './permissions.js';

/*
Nothing builds Collectors yet: there is no way to read the helper's event stream
and nothing calls `TelemetryState`'s increment helpers outside the tests (#7).
The factory is the seam that issue fills in, and until it does, `collect` starts,
reports the grant, and waits for a signal with nothing to Flush.
*/
const collectorsFrom: CollectorFactory = _report => [];

try {
	await run(parseArguments(), {
		permissions: new HelperPermissionSource(),
		collectors: collectorsFrom,
	});
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
