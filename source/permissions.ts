/*
The permission preflight.

A missing macOS grant degrades collection rather than stopping the CLI, so this
answers one question — which Collectors can actually run — and never throws for
a missing grant. `IOHIDCheckAccess` is the only check to trust here, and the
helper is the only thing that can make it: the grant follows an ancestor process
rather than this script's path (ADR-0006), so asking from Node would be asking
about the wrong process.

The asking itself — running the helper and waiting for its answer — is the
helper module's one-shot runner. What is left here is policy: what the answer
means, and what is worth saying when no answer comes.
*/

import {
	DEFAULT_RUN_TIMEOUT_MS,
	HELPER_PATH,
	REBUILD_HINT,
	runHelperOnce,
} from './helper.js';

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
		timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
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
			({stdout} = await runHelperOnce(['--preflight'], {
				helperPath: this.#helperPath,
				timeoutMs: this.#timeoutMs,
			}));
		} catch (error: unknown) {
			/*
			The runner has already composed the sentence — path, cause, rebuild
			hint — so this wraps the failure as a `PreflightError` and changes
			nothing about what it says.
			*/
			throw new PreflightError(
				error instanceof Error ? error.message : String(error),
			);
		}

		const report = parsePreflightLine(stdout);
		if (report === undefined) {
			throw new PreflightError(
				`${this.#helperPath} --preflight printed no permission report. ${REBUILD_HINT}`,
			);
		}

		return permissionReport(report);
	}
}
