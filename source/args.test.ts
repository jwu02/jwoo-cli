import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import {commandFor, parseArguments} from './args.js';

/*
`process.execPath` rather than `node` from PATH: this is the interpreter already
running the suite, which is the one the `engines` floor was checked against.

The child's environment is this process's minus `MONGO_URI`, whatever `env` adds
on top: a `MONGO_URI` in the shell that runs the suite would otherwise send a
child at a real cluster, and the gate reaches no network. `delete` rather than an
`undefined` value, which a child process would see as the string `"undefined"`.
*/
async function runCli(
	argv: string[],
	env: Readonly<Record<string, string>> = {},
): Promise<{code: number | undefined; output: string}> {
	const entry = fileURLToPath(new URL('cli.tsx', import.meta.url));
	const environment = {...process.env, ...env};
	delete environment['MONGO_URI'];

	return new Promise(resolve => {
		execFile(
			process.execPath,
			['--import', 'tsx', entry, ...argv],
			{env: environment},
			(error, stdout, stderr) => {
				/*
				A non-zero exit arrives as an error, and that is the case here: the
				point is which code the CLI exited with, not that it exited.

				Both streams, because a refusal can be said on either: meow writes
				an unknown flag's own message to stderr, while the help it prints
				on a rejected command's behalf goes to stdout. What these tests
				assert is that the refusal was said at all.
				*/
				resolve({
					code: error === null ? 0 : ((error as {code?: number}).code ?? 1),
					output: `${stdout}${stderr}`,
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

	t.throws(() => commandFor({flags: {}, input: ['usage']}, showHelp), {
		message: 'showHelp',
	});
	t.deepEqual(calls, [2]);
});

test('an unknown usage command is rejected rather than ignored', t => {
	const {calls, showHelp} = rejecting();

	t.throws(
		() => commandFor({flags: {}, input: ['usage', 'record-nothing']}, showHelp),
		{
			message: 'showHelp',
		},
	);
	t.deepEqual(calls, [2]);
});

test('a usage command with a stray argument is rejected', t => {
	const {calls, showHelp} = rejecting();

	t.throws(
		() =>
			commandFor(
				{flags: {}, input: ['usage', 'record-claude-hook', 'extra']},
				showHelp,
			),
		{message: 'showHelp'},
	);
	t.deepEqual(calls, [2]);
});

/*
`backfill-claude` is the operator's command, so it is the one that carries
flags: an optional root, `--dry-run` and `--since`. The root is positional, and
its absence means Claude Code's own projects directory rather than an error.
*/
test('backfill-claude carries its root and flags', t => {
	t.deepEqual(parseArguments(['usage', 'backfill-claude']), {
		kind: 'usage',
		command: 'backfill-claude',
		root: undefined,
		dryRun: false,
		since: undefined,
	});

	t.deepEqual(
		parseArguments([
			'usage',
			'backfill-claude',
			'/tmp/projects',
			'--dry-run',
			'--since',
			'2026-08-01T00:00:00Z',
		]),
		{
			kind: 'usage',
			command: 'backfill-claude',
			root: '/tmp/projects',
			dryRun: true,
			since: new Date('2026-08-01T00:00:00Z'),
		},
	);
});

test('a second root on backfill-claude is rejected', t => {
	const {calls, showHelp} = rejecting();

	t.throws(
		() =>
			commandFor(
				{flags: {}, input: ['usage', 'backfill-claude', 'a', 'b']},
				showHelp,
			),
		{message: 'showHelp'},
	);
	t.deepEqual(calls, [2]);
});

/*
The record commands take no flags — their payload is stdin — so meow's knowing
the Backfill's two does not make `--dry-run` legal on them. It is refused here,
and the child-process test below is the same refusal through meow's own exit.
*/
test('a Backfill flag on a record command is rejected', t => {
	const {calls, showHelp} = rejecting();

	t.throws(
		() =>
			commandFor(
				{flags: {dryRun: true}, input: ['usage', 'record-claude-hook']},
				showHelp,
			),
		{message: 'showHelp'},
	);
	t.deepEqual(calls, [2]);
});

test('a Backfill flag on a top-level command is rejected', t => {
	const {calls, showHelp} = rejecting();

	t.throws(
		() => commandFor({flags: {dryRun: true}, input: ['collect']}, showHelp),
		{message: 'showHelp'},
	);
	t.deepEqual(calls, [2]);
});

/*
`--since` is a filter, so a value that is not an instant is a bad command line
rather than a bound that quietly matches nothing.
*/
test('an unparseable --since is rejected', t => {
	const {calls, showHelp} = rejecting();

	t.throws(
		() =>
			commandFor(
				{flags: {since: 'yesterday'}, input: ['usage', 'backfill-claude']},
				showHelp,
			),
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

	t.throws(() => commandFor({flags: {}, input: ['dashboard']}, showHelp), {
		message: 'showHelp',
	});
	t.deepEqual(calls, [2]);
});

test('an unknown subcommand is rejected rather than ignored', t => {
	const {calls, showHelp} = rejecting();

	t.throws(() => commandFor({flags: {}, input: ['collect-now']}, showHelp), {
		message: 'showHelp',
	});
	t.deepEqual(calls, [2]);
});

test('a subcommand and a stray argument are rejected', t => {
	const {calls, showHelp} = rejecting();

	t.throws(
		() => commandFor({flags: {}, input: ['collect', 'extra']}, showHelp),
		{
			message: 'showHelp',
		},
	);
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
	t.regex(result.output, /dry-run|Unknown flag|--help/v);
});

/*
And on the group whose commands take no flags either. The hook command reads a
payload on stdin, so a flag it does not know is a typo rather than something to
forward — and it has to be refused before the command runs, which is what the
child process shows: the entry point never reads stdin, so the test cannot hang.
*/
/*
A boolean written with a value is still a flag. meow parses `--dry-run=false`
to the same `false` it gives an absent one, so a line that carried it has to be
refused as the same mistake `--dry-run` is — otherwise a flag nobody honoured
looks exactly like one that was.
*/
test('a valued boolean flag is refused like the bare one', async t => {
	const result = await runCli(['collect', '--dry-run=false']);

	t.is(result.code, 2);
	t.regex(result.output, /dry-run|--help/v);
});

test('an unknown flag on a usage command is refused too', async t => {
	const result = await runCli(['usage', 'record-claude-hook', '--dry-run']);

	t.is(result.code, 2);
	t.regex(result.output, /dry-run|Unknown flag|--help/v);
});

/*
The Backfill is the operator's command, and the exit code it earns is the one
piece of it a test in this process cannot see: `cli.tsx` sets it, and a run of
its own is what reads it back. A root that cannot be scanned is the Backfill's
own failure — the one path that exits 1 — and the store path is a temp
directory's, so the child opens a store of its own rather than the real one.
*/
test('a Backfill whose root cannot be scanned exits 1', async t => {
	const directory = mkdtempSync(join(tmpdir(), 'jwoo-cli-args-test-'));
	t.teardown(() => {
		rmSync(directory, {recursive: true, force: true});
	});

	const result = await runCli(
		['usage', 'backfill-claude', join(directory, 'no-such-projects')],
		// eslint-disable-next-line @typescript-eslint/naming-convention -- an environment variable's name is SCREAMING_SNAKE_CASE by definition.
		{LOCAL_STORE_PATH: join(directory, 'telemetry.db')},
	);

	t.is(result.code, 1);
	t.true(result.output.includes('Could not scan'));
	// A failed scan has no summary to print: it returns before one is due.
	t.false(result.output.includes('scanned'));
});
