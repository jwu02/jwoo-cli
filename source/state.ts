/*
Telemetry State: the in-memory accumulator for everything observed since the
last successful Flush.

A Collector calls the increment helpers; it never reaches past them into the
accumulator itself, so a future move to a separate capture process only has to
replace this module and not its callers.
*/

export type Snapshot = {
	readonly leftClicks: number;
	readonly rightClicks: number;
	readonly movementMeters: number;
	readonly keysPressed: number;
	readonly keyCounts: Readonly<Record<string, number>>;
	/*
	App time is carried but never written: no Flush includes it, because there
	is no frontmost-application Collector to produce it yet. It survives here
	only so `hasActivity()`'s rule — app time alone never triggers a Flush —
	is a real rule rather than a vacuous one.
	*/
	readonly apps: Readonly<Record<string, number>>;
};

export type TelemetryStateOptions = {
	/*
	Used to turn accumulated pixel movement into Mouse Distance.
	*/
	readonly mouseDpi?: number;
};

const DEFAULT_MOUSE_DPI = 72;
const METRES_PER_INCH = 0.0254;

export class TelemetryState {
	readonly #mouseDpi: number;

	#leftClicks = 0;
	#rightClicks = 0;
	#pixelsMoved = 0;
	readonly #keyCounts = new Map<string, number>();
	readonly #apps = new Map<string, number>();

	constructor({mouseDpi = DEFAULT_MOUSE_DPI}: TelemetryStateOptions = {}) {
		this.#mouseDpi = mouseDpi;
	}

	addLeftClick(): void {
		this.#leftClicks += 1;
	}

	addRightClick(): void {
		this.#rightClicks += 1;
	}

	/*
	Collectors report raw pointer travel in pixels; DPI is applied here.
	*/
	addMouseMovement(pixels: number): void {
		this.#pixelsMoved += pixels;
	}

	addKeyPress(label: string): void {
		this.#keyCounts.set(label, (this.#keyCounts.get(label) ?? 0) + 1);
	}

	/*
	Deliberately unwritten by `MongoTelemetryStore`: see `Snapshot.apps`.
	*/
	addAppTime(appName: string, seconds: number): void {
		this.#apps.set(appName, (this.#apps.get(appName) ?? 0) + seconds);
	}

	snapshot(): Snapshot {
		return {
			leftClicks: this.#leftClicks,
			rightClicks: this.#rightClicks,
			movementMeters: round(
				(this.#pixelsMoved / this.#mouseDpi) * METRES_PER_INCH,
				4,
			),
			keysPressed: this.#keyCounts
				.values()
				.reduce((total, count) => total + count, 0),
			keyCounts: sortByLabel(this.#keyCounts),
			apps: Object.fromEntries(this.#apps),
		};
	}

	/*
	App time alone is not Activity: it never triggers a Flush.
	*/
	hasActivity(): boolean {
		return (
			this.#leftClicks > 0 ||
			this.#rightClicks > 0 ||
			this.#pixelsMoved > 0 ||
			this.#keyCounts.size > 0
		);
	}

	/*
	Deliberately separate from `snapshot()`. Telemetry State is cleared only
	after a successful Flush, and that split is what makes retrying possible.
	*/
	clear(): void {
		this.#leftClicks = 0;
		this.#rightClicks = 0;
		this.#pixelsMoved = 0;
		this.#keyCounts.clear();
		this.#apps.clear();
	}
}

/*
Sort Key Counts by label so insertion order cannot leak the sequence of
presses. The reader only sums this document, but the ordering is a promise
the Python suite tested and this one keeps.
*/
function sortByLabel(counts: Map<string, number>): Record<string, number> {
	return Object.fromEntries(
		counts
			.entries()
			.toArray()
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

function round(value: number, places: number): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}
