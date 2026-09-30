/*
Pricing for Usage Records: CNY per 1M tokens, applied once at Ingest. A
record's cost is computed from its own `recorded_at` and never recomputed —
editing a rate changes no record already stored (ADR-0014). A model name
matches a Pricing entry exactly, after the alias table has canonicalized it.
A name nothing covers prices `undefined` — the store's NULL, the wire's
`cost_yuan: null` that marks an Unpriced record (ADR-0015).

Ported from the retired `ai-usage/usage-lib.mjs`, with one deliberate change:
the substring match it used is gone. Exact match makes the table explicit —
every rate a model can be charged is written in it — and moves the variant
problem into the alias table, where a missing alias is an edit away and the
nulls it leaves are queryable (ADR-0015).

The Ingest face is this module's only consumer: it canonicalizes the model
for the record it stores and prices the same canonical name, so no caller can
hand the store a cost that contradicts the record's own tokens.
*/

// ── Pricing (CNY per 1M tokens) ───────────────────────────────────────────
// DeepSeek V4 uses peak/off-peak pricing by Beijing time:
//   peak hours   = 09:00–12:00 and 14:00–18:00
//   off-peak     = everything else (half of peak)
// EDIT these rates when prices change. `pricing.test.ts` pins the table, so
// an edit is two deliberate edits — and it reaches only records Ingested
// after it (ADR-0014). Match is exact on the normalized model name.

export type Rate = {
	readonly miss: number;
	readonly hit?: number;
	readonly out: number;
};

export type Pricing = Rate | {readonly peak: Rate; readonly offpeak: Rate};

export const PRICING: Record<string, Pricing> = {
	'kimi-k3': {miss: 20, hit: 2, out: 100},
	'kimi-k2.7-code': {miss: 6.5, hit: 1.3, out: 27},
	'kimi-k2.6': {miss: 6.5, hit: 1.1, out: 27},
	'kimi-k2.5': {miss: 4, hit: 0.7, out: 21},
	'deepseek-v4.1-flash': {
		peak: {miss: 2, hit: 0.04, out: 8},
		offpeak: {miss: 1, hit: 0.02, out: 4},
	},
	'deepseek-v4-pro': {
		peak: {miss: 9, hit: 0.3, out: 27},
		offpeak: {miss: 4.5, hit: 0.15, out: 13.5},
	},
	'deepseek-v4-flash': {
		peak: {miss: 3, hit: 0.1, out: 9},
		offpeak: {miss: 1.5, hit: 0.05, out: 4.5},
	},
	// The substring match priced this one implicitly at deepseek-v4-flash
	// rates; exact match needs the entry written out (ADR-0015) — same rates,
	// so the record keeps its identity and its price is explicit.
	'deepseek-v4-flash-vision-exp': {
		peak: {miss: 3, hit: 0.1, out: 9},
		offpeak: {miss: 1.5, hit: 0.05, out: 4.5},
	},
	// Zhipu BigModel (open.bigmodel.cn/pricing). Flat pricing, no peak/off-peak.
	// The glm-5.3-flash rate carries a limited-time 50% discount (list: 0.8/2.8).
	'glm-5.3': {miss: 8, hit: 2, out: 28},
	'glm-5.3-flash': {miss: 0.4, hit: 0.115, out: 1.4},
};

// ── Model aliases ─────────────────────────────────────────────────────────
// Token relay stations (中转站) report models under their own ids; map them to
// the canonical names the Pricing table prices, so records group under one
// name — the fingerprint and `_id` carry the model (ADR-0013) — and price at
// all. Exact match on the lowercased incoming id; unknown names pass through
// unchanged, and stay unpriced until an alias or an entry covers them
// (ADR-0015).

export const MODEL_ALIASES: Record<string, string> = {
	'deepseek/deepseek-v4-flash-vision-exp': 'deepseek-v4-flash-vision-exp',
	'deepseek-v4-pro-202606': 'deepseek-v4-pro',
	'deepseek-v4-pro-0813': 'deepseek-v4-pro',
	'deepseek-v4-flash-0731': 'deepseek-v4-flash',
	'deepseek/deepseek-flash': 'deepseek-v4.1-flash',
};

export function canonicalModelName(
	model: string | undefined,
): string | undefined {
	return model === undefined
		? undefined
		: (MODEL_ALIASES[model.trim().toLowerCase()] ?? model);
}

/*
The name form pricing matches on: bracketed qualifiers stripped, trimmed,
lowercased. The alias table runs before this and matches on trim + lowercase
only, exactly as the retired scripts did.
*/
const normalizeModel = (model: string | undefined): string =>
	(model ?? '')
		.replaceAll(/\[[^\[\]]*\]/gv, '')
		.trim()
		.toLowerCase();

/*
DeepSeek's peak windows, by the wall clock of Beijing time. Beijing keeps no
daylight saving, so a fixed +8 is the whole rule. This is the provider's zone,
not the viewer's — local-time.ts and the Ranges it serves are a different
zone for a different question, and Intl would buy nothing.
*/
const isBeijingPeakHour = (at: Date): boolean => {
	const beijingHour = (at.getUTCHours() + 8) % 24;
	return (
		(beijingHour >= 9 && beijingHour < 12) ||
		(beijingHour >= 14 && beijingHour < 18)
	);
};

function resolvePrice(model: string | undefined, at: Date): Rate | undefined {
	const normalized = normalizeModel(model);
	if (normalized === '') {
		return undefined;
	}

	const entry = PRICING[normalized];
	if (entry === undefined) {
		return undefined;
	}

	if ('peak' in entry) {
		return isBeijingPeakHour(at) ? entry.peak : entry.offpeak;
	}

	return entry;
}

/*
The token buckets pricing reads, named as the store's columns are. A full
record carries more (`total_tokens`, and the wire more still); pricing names
only what it uses.
*/
export type PriceableTokens = {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
	readonly prompt_cache_hit_tokens?: number;
	readonly prompt_cache_miss_tokens?: number;
};

/*
The stored cost (cost_yuan) is fresh-and-miss × miss + cache-hit × hit +
output × out, per 1M tokens, rounded to 6dp. `at` is the record's own
`recorded_at` and is never defaulted — a defaulted clock is how a backfill
gets priced as if it happened now (ADR-0014). The caller canonicalizes the
model first: a raw relay id prices undefined, and
`computeCostYuan(canonicalModelName(model), …)` is the sequence the Ingest
face runs.
*/
export function computeCostYuan(
	model: string | undefined,
	flat: PriceableTokens | undefined,
	at: Date,
): number | undefined {
	if (flat?.prompt_tokens === undefined) {
		return undefined;
	}

	const rate = resolvePrice(model, at);
	if (rate === undefined) {
		return undefined;
	}

	const hit = flat.prompt_cache_hit_tokens ?? 0;
	const miss = flat.prompt_cache_miss_tokens ?? 0;
	const fresh = flat.prompt_tokens - hit - miss;
	const missCost = (fresh + miss) * rate.miss;
	const hitCost = hit * (rate.hit ?? rate.miss);
	const outCost = (flat.completion_tokens ?? 0) * rate.out;
	const cost = (missCost + hitCost + outCost) / 1e6;

	return Math.round(cost * 1e6) / 1e6;
}
