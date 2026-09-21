/*
The permission preflight.

A missing macOS grant degrades collection rather than stopping the CLI, so this
answers one question — which Collectors can actually run — and never throws for
a missing grant. `IOHIDCheckAccess` is the only check to trust here, and the
helper is the only thing that can make it: the grant follows an ancestor process
rather than this script's path (ADR-0006), so asking from Node would be asking
about the wrong process.
*/

import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/*
Committed beside the source, and resolved from this module rather than from the
working directory, so the CLI can be run from anywhere. `dist/permissions.js`
sits one level under the repo root, as `source/permissions.ts` does.
*/
export const HELPER_PATH = fileURLToPath(
	new URL('../helper/bin/eventtap', import.meta.url),
);

const DEFAULT_TIMEOUT_MS = 5000;

/*
Wrapped by hand rather than with `promisify`, whose inferred return type drops
the `stdout` the callback supplies — reading it would then be an `any`, and this
is exactly the value that decides whether collection runs.
*/
async function runHelper(
	file: string,
	args: string[],
	options: {timeout: number},
): Promise<{stdout: string; stderr: string}> {
	return new Promise((resolve, reject) => {
		execFile(file, args, options, (error, stdout, stderr) => {
			if (error) {
				reject(asError(error));
				return;
			}

			resolve({stdout, stderr});
		});
	});
}

/*
An `Error` whatever the driver handed back. `execFile` rejects with an
`ExecFileException`, which carries the useful part — its `code` — alongside a
`message`; anything else would stringify to `[object Object]` on the way to the
user.
*/
function asError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	const message =
		typeof error === 'object' && error !== null && 'message' in error
			? String(error.message)
			: 'the helper could not be run';

	return new Error(message);
}

export class PreflightError extends Error {
	override readonly name = 'PreflightError';
}

/*
The helper's report, as it crosses the wire. `inputMonitoring` is kept as the
helper's own string rather than a boolean: `unknown` is a third state, not a
polite synonym for `denied`, and flattening it here would lose that.
*/
export type HelperPreflight = {
	readonly inputMonitoring: 'granted' | 'denied' | 'unknown';
	readonly message: string;
};

export type DisabledCollector = {
	readonly collector: 'mouse' | 'keyboard';
	readonly note: string;
};

export type PermissionReport =
	| {readonly status: 'granted'}
	| {
			readonly status: 'disabled';
			readonly access: 'denied' | 'unknown';
			readonly disabled: readonly DisabledCollector[];
			readonly message: string;
	  };

export type PermissionSource = {
	preflight(): Promise<PermissionReport>;
};

const ACCESS_VALUES = new Set(['granted', 'denied', 'unknown']);

/*
Reads the last preflight line rather than the first, so a diagnostic that
happens to start with a brace cannot be mistaken for the report. Anything that
is not one of the three access values is rejected outright rather than coerced:
a mistyped value would otherwise look exactly like a missing grant.
*/
export function parsePreflightLine(
	stdout: string,
): HelperPreflight | undefined {
	let report: HelperPreflight | undefined;

	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (typeof parsed !== 'object' || parsed === null) {
			continue;
		}

		const {type, inputMonitoring, message} = parsed as Record<string, unknown>;
		if (
			type === 'preflight' &&
			typeof inputMonitoring === 'string' &&
			ACCESS_VALUES.has(inputMonitoring)
		) {
			report = {
				inputMonitoring: inputMonitoring as HelperPreflight['inputMonitoring'],
				message: typeof message === 'string' ? message : '',
			};
		}
	}

	return report;
}

/*
Which Collectors a missing grant takes out. Both of them, because there is one
grant: a listen-only tap needs Input Monitoring and nothing else, and both
Collectors read that same tap (ADR-0006). The notes name the grant and where to
change it, because "disabled" on its own leaves the user with no next step.
*/
export function permissionReport(preflight: HelperPreflight): PermissionReport {
	if (preflight.inputMonitoring === 'granted') {
		return {status: 'granted'};
	}

	const {inputMonitoring} = preflight;

	return {
		status: 'disabled',
		access: inputMonitoring,
		disabled: [
			{
				collector: 'mouse',
				note: `Mouse collection is disabled: Input Monitoring is ${inputMonitoring}. Grant it in System Settings > Privacy & Security > Input Monitoring.`,
			},
			{
				collector: 'keyboard',
				note: `Keyboard collection is disabled: Input Monitoring is ${inputMonitoring}. Grant it in System Settings > Privacy & Security > Input Monitoring.`,
			},
		],
		message: preflight.message,
	};
}

export type HelperPermissionSourceOptions = {
	readonly helperPath?: string;
	readonly timeoutMs?: number;
};

export class HelperPermissionSource implements PermissionSource {
	readonly #helperPath: string;
	readonly #timeoutMs: number;

	constructor({
		helperPath = HELPER_PATH,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	}: HelperPermissionSourceOptions = {}) {
		this.#helperPath = helperPath;
		this.#timeoutMs = timeoutMs;
	}

	/*
	Throws only when the helper cannot be *asked* — a missing binary, a crash, a
	hang. A grant that is simply absent comes back as a report, because that is
	the ordinary case and it has an answer.
	*/
	async preflight(): Promise<PermissionReport> {
		let stdout: string;
		try {
			({stdout} = await runHelper(this.#helperPath, ['--preflight'], {
				timeout: this.#timeoutMs,
			}));
		} catch (error: unknown) {
			throw new PreflightError(
				`Could not check permissions with ${this.#helperPath}: ${error instanceof Error ? error.message : String(error)}. Rebuild it with ./helper/build.sh.`,
			);
		}

		const report = parsePreflightLine(stdout);
		if (report === undefined) {
			throw new PreflightError(
				`${this.#helperPath} --preflight printed no permission report. Rebuild it with ./helper/build.sh.`,
			);
		}

		return permissionReport(report);
	}
}
