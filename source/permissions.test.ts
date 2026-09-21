import test from 'ava';
import {
	type HelperPreflight,
	HelperPermissionSource,
	type PermissionReport,
	PreflightError,
	parsePreflightLine,
	permissionReport,
} from './permissions.js';

/*
The helper's own line, as `./helper/bin/eventtap --preflight` prints it. Built
from the wire format rather than from anything the code under test exports, so a
change to the format is visible here.
*/
function helperLine(access: string): string {
	return `${JSON.stringify({
		type: 'preflight',
		inputMonitoring: access,
		message: `Input Monitoring is ${access} for this helper.`,
	})}\n`;
}

function helperPreflight(access: string): HelperPreflight {
	const report = parsePreflightLine(helperLine(access));
	if (report === undefined) {
		throw new Error(`the helper's own ${access} line did not parse`);
	}

	return report;
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

test('a line that is not the helper preflight report does not parse', t => {
	t.is(
		parsePreflightLine('{"type":"error","code":"inputMonitoringDenied"}\n'),
		undefined,
	);
	t.is(parsePreflightLine(''), undefined);
	t.is(parsePreflightLine('not json'), undefined);
	t.is(
		parsePreflightLine('{"type":"preflight","inputMonitoring":"maybe"}\n'),
		undefined,
	);
});

/*
`stdout` carries the report and stderr carries diagnostics; the parser is handed
stdout, so anything else on it must be skipped rather than believed.
*/
test('the report is found among other lines on stdout', t => {
	t.is(
		parsePreflightLine(`noise\n${helperLine('denied')}`)?.inputMonitoring,
		'denied',
	);
});

test('a helper that cannot be run is an error, not a missing permission', async t => {
	const source = new HelperPermissionSource({
		helperPath: '/nonexistent/eventtap',
	});

	await t.throwsAsync(source.preflight(), {instanceOf: PreflightError});
});
