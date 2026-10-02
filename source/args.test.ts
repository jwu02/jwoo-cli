import {execFile} from 'node:child_process';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import {commandFor, parseArguments} from './args.js';

/*
`process.execPath` rather than `node` from PATH: this is the interpreter already
running the suite, which is the one the `engines` floor was checked against.
*/
async function runCli(
	argv: string[],
): Promise<{code: number | undefined; stderr: string}> {
	const entry = fileURLToPath(new URL('cli.tsx', import.meta.url));

	return new Promise(resolve => {
		execFile(
			process.execPath,
			['--import', 'tsx', entry, ...argv],
			(error, _stdout, stderr) => {
				/*
				A non-zero exit arrives as an error, and that is the case here: the
				point is which code the CLI exited with, not that it exited.
				*/
				resolve({
					code: error === null ? 0 : ((error as {code?: number}).code ?? 1),
					stderr,
				});
			},
		);
	});
}

/*
`showHelp` ends the process, so the tests that reach it pass a stand-in that
records the exit code instead. What is being asserted is that the command line
is rejected and with which code — not how meow prints.
*/
function rejecting(): {
	calls: Array<number | undefined>;
	showHelp: (exitCode?: number) => never;
} {
	const calls: Array<number | undefined> = [];

	return {
		calls,
		showHelp(exitCode?: number): never {
			calls.push(exitCode);
			throw new Error('showHelp');
		},
	};
}

test('no subcommand opens the dashboard', t => {
	t.deepEqual(parseArguments([]), {kind: 'dashboard'});
});

test('collect runs the Collector without the dashboard', t => {
	t.deepEqual(parseArguments(['collect']), {kind: 'collect'});
});

test('permissions reports the grants on their own', t => {
	t.deepEqual(parseArguments(['permissions']), {kind: 'permissions'});
});

/*
The third command group: `usage`, and the command it names. The group is not a
command of its own — `usage` alone names nothing — so the command line has to
name one of the group's commands.
*/
test('usage names the command it runs', t => {
	t.deepEqual(parseArguments(['usage', 'record-claude-hook']), {
		kind: 'usage',
		command: 'record-claude-hook',
	});
	t.deepEqual(parseArguments(['usage', 'record-opencode']), {
		kind: 'usage',
		command: 'record-opencode',
	});
});

test('the usage group alone is rejected', t => {
	const {calls, showHelp} = rejecting();

	t.throws(() => commandFor({input: ['usage']}, showHelp), {
		message: 'showHelp',
	});
	t.deepEqual(calls, [2]);
});

test('an unknown usage command is rejected rather than ignored', t => {
	const {calls, showHelp} = rejecting();

	t.throws(() => commandFor({input: ['usage', 'record-nothing']}, showHelp), {
		message: 'showHelp',
	});
	t.deepEqual(calls, [2]);
});

test('a usage command with a stray argument is rejected', t => {
	const {calls, showHelp} = rejecting();

	t.throws(
		() =>
			commandFor({input: ['usage', 'record-claude-hook', 'extra']}, showHelp),
		{message: 'showHelp'},
	);
	t.deepEqual(calls, [2]);
});

/*
A bare `dashboard` is not a second spelling of the default. Accepting both would
let them drift apart, and the help text names only one of them.
*/
test('the dashboard is not also a subcommand', t => {
	const {calls, showHelp} = rejecting();

	t.throws(() => commandFor({input: ['dashboard']}, showHelp), {
		message: 'showHelp',
	});
	t.deepEqual(calls, [2]);
});

test('an unknown subcommand is rejected rather than ignored', t => {
	const {calls, showHelp} = rejecting();

	t.throws(() => commandFor({input: ['collect-now']}, showHelp), {
		message: 'showHelp',
	});
	t.deepEqual(calls, [2]);
});

test('a subcommand and a stray argument are rejected', t => {
	const {calls, showHelp} = rejecting();

	t.throws(() => commandFor({input: ['collect', 'extra']}, showHelp), {
		message: 'showHelp',
	});
	t.deepEqual(calls, [2]);
});

/*
Refusing an unknown flag is meow's doing, and meow does it by exiting — which a
test in this process cannot observe, because the exit would take ava with it.
So this one runs the real entry point in a child process, which is also the only
test here that says the CLI starts at all.
*/
test('an unknown flag is refused with a usage exit code', async t => {
	const result = await runCli(['collect', '--dry-run']);

	t.is(result.code, 2);
	t.regex(result.stderr, /dry-run|Unknown flag|--help/v);
});

/*
And on the group whose commands take no flags either. The hook command reads a
payload on stdin, so a flag it does not know is a typo rather than something to
forward — and it has to be refused before the command runs, which is what the
child process shows: the entry point never reads stdin, so the test cannot hang.
*/
test('an unknown flag on a usage command is refused too', async t => {
	const result = await runCli(['usage', 'record-claude-hook', '--dry-run']);

	t.is(result.code, 2);
	t.regex(result.stderr, /dry-run|Unknown flag|--help/v);
});
