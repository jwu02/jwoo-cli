#!/usr/bin/env node
import process from 'node:process';
import {render} from 'ink';
import App from './app.js';
import {loadConfig} from './config.js';
import {MongoHistorySource} from './history.js';

/*
The composition root.

Argument parsing, the subcommand structure and the permission preflight arrive
with #8; collection is not wired up yet either (#7), so this reads history and
writes nothing. What it does own is the client: one is built here and closed
here, because a `MongoClient` left open keeps the process alive after the TUI
has gone.

  Usage
    $ jwoo-cli
*/
async function main(): Promise<void> {
	const source = new MongoHistorySource(loadConfig());

	try {
		const instance = render(<App source={source} />);
		// Quitting is not the only way out — Ctrl-C takes the default path —
		// so the client is released on any exit, not just `q`.
		await instance.waitUntilExit();
	} finally {
		await source.close();
	}
}

/*
Reported rather than thrown. A missing `MONGO_URI` is a configuration mistake,
and a stack trace is not the useful part of that message.
*/
try {
	await main();
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
