import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {type PreflightEvent} from './raw-event.js';
import {
	HelperPermissionSource,
	type PermissionReport,
	PreflightError,
	permissionReport,
} from './permissions.js';

/*
The helper's answer as the wire carries it — built as an object of the format
module's type rather than written out by hand, so a change to the format shows
up here as a type error. These tests are about policy, not parsing: the reading
of stdout lives with the transport tests.
*/
function helperPreflight(
	access: PreflightEvent['inputMonitoring'],
): PreflightEvent {
	return {
		type: 'preflight',
		inputMonitoring: access,
		message: `Input Monitoring is ${access} for this helper.`,
	};
}

type DisabledReport = Extract<PermissionReport, {status: 'disabled'}>;

function disabledReport(access: 'denied' | 'unknown'): DisabledReport {
	const report = permissionReport(helperPreflight(access));
	if (report.status !== 'disabled') {
		throw new Error(`${access} produced a granted report`);
	}

	return report;
}

test('a granted grant enables both Collectors', t => {
	const report = permissionReport(helperPreflight('granted'));

	t.is(report.status, 'granted');
});

/*
The two Collectors are told apart by their own notes. Asserting on a count, or
on a boolean, would still pass if the two were swapped or merged into one.
*/
test('a denied grant disables both Collectors rather than failing the check', t => {
	const {status, disabled} = disabledReport('denied');

	t.is(status, 'disabled');
	t.deepEqual(disabled.map(entry => entry.collector).toSorted(), [
		'keyboard',
		'mouse',
	]);
	t.regex(
		disabled.find(entry => entry.collector === 'keyboard')?.note ?? '',
		/keyboard/iv,
	);
	t.regex(
		disabled.find(entry => entry.collector === 'mouse')?.note ?? '',
		/mouse/iv,
	);
});

/*
`unknown` is a real third state, not a synonym for denied: TCC answers it before
it has a record either way. It still disables input, because no events arrive.
*/
test('an unknown grant disables both Collectors', t => {
	const {access, disabled} = disabledReport('unknown');

	t.is(access, 'unknown');
	t.deepEqual(disabled.map(entry => entry.collector).toSorted(), [
		'keyboard',
		'mouse',
	]);
});

test('the helper message is carried through for the user to act on', t => {
	t.regex(disabledReport('denied').message, /Input Monitoring/v);
});

/*
Every note has to name the grant and where to change it. A note that only said
"disabled" would leave the user with no next step.
*/
test('each disability note names the grant and where to grant it', t => {
	for (const {collector, note} of disabledReport('denied').disabled) {
		t.regex(note, /Input Monitoring/v, collector);
		t.regex(note, /System Settings/v, collector);
	}
});

test('a helper that cannot be run is an error, not a missing permission', async t => {
	const source = new HelperPermissionSource({
		helperPath: '/nonexistent/eventtap',
	});

	const error = await t.throwsAsync(source.preflight(), {
		instanceOf: PreflightError,
	});

	/*
	"Run", not "check permissions": the runner is the one asking, and a timeout
	or a crash is a failure to run. The hint is the shared one — the same
	sentence the stream reports for the same failure.
	*/
	t.regex(error.message, /Could not run \/nonexistent\/eventtap/v);
	t.regex(error.message, /helper\/build\.sh/v);
});

/*
`--preflight` exits 0 whatever the grant is, so an exit code can never carry
the answer: a helper that fails is a helper that cannot be asked. The failure
would go silent exactly here — a run that resolved on a non-zero exit would
come back as "printed no permission report", and one that coerced the exit
into the report would come back as a missing grant.
*/
test('a non-zero helper exit is a broken install, never a denied grant', async t => {
	const source = new HelperPermissionSource({helperPath: '/usr/bin/false'});
	const error = await t.throwsAsync(source.preflight(), {
		instanceOf: PreflightError,
	});

	t.regex(error.message, /Could not run \/usr\/bin\/false/v);
	t.regex(error.message, /helper\/build\.sh/v);
});

test('a helper that answers but prints no report says so, with the shared hint', async t => {
	const source = new HelperPermissionSource({helperPath: '/usr/bin/true'});
	const error = await t.throwsAsync(source.preflight(), {
		instanceOf: PreflightError,
	});

	t.regex(error.message, /printed no permission report/v);
	t.regex(error.message, /helper\/build\.sh/v);
});

test('a preflight line with no message is no report at all', async t => {
	/*
	The spec's one approved behavior delta, seen from the policy seam: a helper
	that answered with a messageless preflight line used to produce a granted
	report with an empty message. Drop-rather-than-default now holds across the
	whole wire format, so stdout that carries only such lines carries no answer
	at all.
	*/
	const directory = await mkdtemp(join(tmpdir(), 'preflight-'));
	t.teardown(async () => {
		await rm(directory, {recursive: true, force: true});
	});
	const messageless = join(directory, 'eventtap');
	await writeFile(
		messageless,
		'#!/bin/sh\necho \'{"type":"preflight","inputMonitoring":"granted"}\'\n',
		{mode: 0o755},
	);

	const source = new HelperPermissionSource({helperPath: messageless});
	const error = await t.throwsAsync(source.preflight(), {
		instanceOf: PreflightError,
	});

	t.regex(error.message, /printed no permission report/v);
});

test('a helper that never answers is cut off by the timeout', async t => {
	/*
	A hang is the third way the helper cannot be asked, and the only one the
	timeout answers. The fixture has to ignore its arguments — the source always
	passes `--preflight` — so a script of its own rather than a system tool,
	every one of which would reject the flag and exit at once.
	*/
	const directory = await mkdtemp(join(tmpdir(), 'preflight-'));
	t.teardown(async () => {
		await rm(directory, {recursive: true, force: true});
	});
	const hanging = join(directory, 'eventtap');
	await writeFile(hanging, '#!/bin/sh\nsleep 5\n', {mode: 0o755});

	const source = new HelperPermissionSource({
		helperPath: hanging,
		timeoutMs: 100,
	});
	const error = await t.throwsAsync(source.preflight(), {
		instanceOf: PreflightError,
	});

	t.regex(error.message, /Could not run/v);
	t.regex(error.message, /helper\/build\.sh/v);

	/*
	Node's own failure message ends in a newline; the composer flattens it, so
	the shared sentence stays one sentence.
	*/
	t.false(error.message.includes('\n'), 'the sentence stays one line');
});
