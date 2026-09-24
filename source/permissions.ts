/*
The permission preflight.

A missing macOS grant degrades collection rather than stopping the CLI, so this
answers one question — which Collectors can actually run — and never throws for
a missing grant. `IOHIDCheckAccess` is the only check to trust here, and the
helper is the only thing that can make it: the grant follows an ancestor process
rather than this script's path (ADR-0006), so asking from Node would be asking
about the wrong process.

The asking itself — running the helper, waiting for its answer, and reading its
stdout for the report — is the helper module's: the one-shot runner and
`preflightFrom`, which parses every line through the one shared line parser.
What is left here is policy: what the answer means, and what is worth saying
when no answer comes. Nothing in this module parses a line or decodes JSON.
*/

import {
	DEFAULT_RUN_TIMEOUT_MS,
	HELPER_PATH,
	REBUILD_HINT,
	preflightFrom,
	runHelperOnce,
} from './helper.js';
import {type PreflightEvent} from './raw-event.js';

export class PreflightError extends Error {
	override readonly name = 'PreflightError';
}

export type DisabledCollector = {
	readonly collector: 'mouse' | 'keyboard';
	readonly note: string;
};

/*
The answer with a missing grant in it, named so that what draws this state asks
for it: the Run Log's collection entry takes a `DisabledReport` and so cannot be
handed a report that says the grant was fine. `telemetry.ts` keeps narrowing the
union for the live view, which draws the message and not the list.
*/
export type DisabledReport = {
	readonly status: 'disabled';
	readonly access: 'denied' | 'unknown';
	readonly disabled: readonly DisabledCollector[];
	readonly message: string;
};

export type PermissionReport = DisabledReport | {readonly status: 'granted'};

export type PermissionSource = {
	preflight(): Promise<PermissionReport>;
};

/*
Which Collectors a missing grant takes out. Both of them, because there is one
grant: a listen-only tap needs Input Monitoring and nothing else, and both
Collectors read that same tap (ADR-0006). The notes name the grant and where to
change it, because "disabled" on its own leaves the user with no next step.

Takes the wire type — the preflight event as the format module parsed it — so
the vocabulary of the answer is validated where every other line's fields are,
and this module only decides what the answer means.
*/
export function permissionReport(preflight: PreflightEvent): PermissionReport {
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

		const report = preflightFrom(stdout);
		if (report === undefined) {
			throw new PreflightError(
				`${this.#helperPath} --preflight printed no permission report. ${REBUILD_HINT}`,
			);
		}

		return permissionReport(report);
	}
}
