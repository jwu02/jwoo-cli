/*
The Pricing and alias tables are pinned here as literals — key-labels style,
but for a different reason than a wire format. A record's cost is computed
once, at Ingest, from this table (ADR-0014), so a typo'd rate is not a bug a
later edit fixes: it is frozen into every record Ingested under it. The
deepEqual below is what makes a rate edit two deliberate edits.

**Do not correct a rate here to make a failing test pass.** A failing
deepEqual means the table changed; decide the change is right, then carry it
here in the same breath.
*/

// The token buckets are named as the store's columns and the wire's fields
// spell them — snake_case is the contract, not a style slip.
/* eslint-disable @typescript-eslint/naming-convention -- these ARE the column names. */

import test from 'ava';
import {
	MODEL_ALIASES,
	PRICING,
	canonicalModelName,
	computeCostYuan,
} from './pricing.js';

const PINNED_PRICING = {
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
	'deepseek-v4-flash-vision-exp': {
		peak: {miss: 3, hit: 0.1, out: 9},
		offpeak: {miss: 1.5, hit: 0.05, out: 4.5},
	},
	'glm-5.3': {miss: 8, hit: 2, out: 28},
	'glm-5.3-flash': {miss: 0.4, hit: 0.115, out: 1.4},
};

const PINNED_ALIASES = {
	'deepseek/deepseek-v4-flash-vision-exp': 'deepseek-v4-flash-vision-exp',
	'deepseek-v4-pro-202606': 'deepseek-v4-pro',
	'deepseek-v4-pro-0813': 'deepseek-v4-pro',
	'deepseek-v4-flash-0731': 'deepseek-v4-flash',
	'deepseek/deepseek-flash': 'deepseek-v4.1-flash',
};

test('the Pricing table is pinned: a rate edit is two deliberate edits', t => {
	t.deepEqual(PRICING, PINNED_PRICING);
});

test('the alias table is pinned: an alias edit is two deliberate edits', t => {
	t.deepEqual(MODEL_ALIASES, PINNED_ALIASES);
});

/*
Instants are UTC, the Beijing hour in the comment; January, so no daylight
saving sits between them. `oneMillionMiss` makes the cost read straight off
the miss rate: fresh 1M × miss ÷ 1M.
*/
const PEAK = new Date('2026-01-15T01:30:00Z'); // 09:30 Beijing
const OFFPEAK = new Date('2026-01-15T04:30:00Z'); // 12:30 Beijing
const oneMillionMiss = {prompt_tokens: 1_000_000};

test('a model name prices by exact match on its normalized form', t => {
	t.is(computeCostYuan('deepseek-v4-pro', oneMillionMiss, PEAK), 9);
	t.is(computeCostYuan('DeepSeek-V4-Pro[chat]', oneMillionMiss, PEAK), 9);
});

test('exact match has no substring forgiveness', t => {
	// A relay prefix no alias strips, and a dated snapshot no alias covers:
	// under the retired substring match both priced; exact match leaves them
	// unpriced until an alias or an entry covers them (ADR-0015).
	t.is(
		computeCostYuan('deepseek/deepseek-v4-pro', oneMillionMiss, PEAK),
		undefined,
	);
	t.is(
		computeCostYuan('deepseek-v4-pro-0901', oneMillionMiss, PEAK),
		undefined,
	);
});

test('the alias chain: canonicalize, then price the canonical name', t => {
	t.is(canonicalModelName('deepseek-v4-pro-0813'), 'deepseek-v4-pro');
	t.is(
		computeCostYuan(
			canonicalModelName('deepseek-v4-pro-0813'),
			oneMillionMiss,
			PEAK,
		),
		9,
	);
	t.is(canonicalModelName('deepseek/deepseek-flash'), 'deepseek-v4.1-flash');
	t.is(canonicalModelName('  DeepSeek-V4-Pro-0813 '), 'deepseek-v4-pro');
	t.is(canonicalModelName('some-unmapped-model'), 'some-unmapped-model');
	t.is(canonicalModelName(undefined), undefined);
});

test('deepseek-v4-flash-vision-exp carries its own entry at flash rates', t => {
	// The substring match priced this name implicitly; exact match needs the
	// entry written out, identity kept and price explicit (ADR-0015).
	t.is(
		canonicalModelName('deepseek/deepseek-v4-flash-vision-exp'),
		'deepseek-v4-flash-vision-exp',
	);
	t.is(
		computeCostYuan('deepseek-v4-flash-vision-exp', oneMillionMiss, PEAK),
		3,
	);
	t.is(
		computeCostYuan('deepseek-v4-flash-vision-exp', oneMillionMiss, OFFPEAK),
		1.5,
	);
});

test('the peak/off-peak split turns on Beijing time at the instant given', t => {
	// The deepseek-v4-flash rates: peak miss 3, off-peak 1.5. Boundaries are
	// at the peak's start and exclusive at its end, and the wall clock of the
	// record — never of the call — decides.
	t.is(
		computeCostYuan(
			'deepseek-v4-flash',
			oneMillionMiss,
			new Date('2026-01-15T00:59:00Z'),
		),
		1.5,
	); // 08:59
	t.is(
		computeCostYuan(
			'deepseek-v4-flash',
			oneMillionMiss,
			new Date('2026-01-15T01:00:00Z'),
		),
		3,
	); // 09:00
	t.is(
		computeCostYuan(
			'deepseek-v4-flash',
			oneMillionMiss,
			new Date('2026-01-15T03:59:00Z'),
		),
		3,
	); // 11:59
	t.is(
		computeCostYuan(
			'deepseek-v4-flash',
			oneMillionMiss,
			new Date('2026-01-15T04:00:00Z'),
		),
		1.5,
	); // 12:00
	t.is(
		computeCostYuan(
			'deepseek-v4-flash',
			oneMillionMiss,
			new Date('2026-01-15T05:59:00Z'),
		),
		1.5,
	); // 13:59
	t.is(
		computeCostYuan(
			'deepseek-v4-flash',
			oneMillionMiss,
			new Date('2026-01-15T06:00:00Z'),
		),
		3,
	); // 14:00
	t.is(
		computeCostYuan(
			'deepseek-v4-flash',
			oneMillionMiss,
			new Date('2026-01-15T09:59:00Z'),
		),
		3,
	); // 17:59
	t.is(
		computeCostYuan(
			'deepseek-v4-flash',
			oneMillionMiss,
			new Date('2026-01-15T10:00:00Z'),
		),
		1.5,
	); // 18:00
});

test('cost = fresh-and-miss × miss + hit × hit-rate + output × out', t => {
	// The kimi-k3 rates: miss 20, hit 2, out 100. Fresh = prompt − hit − miss
	// = 100k, and fresh is billed at the miss rate like the miss itself.
	t.is(
		computeCostYuan(
			'kimi-k3',
			{
				prompt_tokens: 1_000_000,
				completion_tokens: 50_000,
				prompt_cache_hit_tokens: 800_000,
				prompt_cache_miss_tokens: 100_000,
			},
			PEAK,
		),
		10.6,
	);
});

test('cost rounds to 6 decimal places', t => {
	// 1_000_001 hit tokens at glm-5.3-flash's 0.115 hit rate is 0.115000115
	// before the rounding; the stored number carries six decimals, no more.
	t.is(
		computeCostYuan(
			'glm-5.3-flash',
			{
				prompt_tokens: 1_000_001,
				prompt_cache_hit_tokens: 1_000_001,
			},
			PEAK,
		),
		0.115,
	);
});

test('unpriced is undefined, not zero and not an error', t => {
	t.is(computeCostYuan('glm-5.3', undefined, PEAK), undefined);
	t.is(computeCostYuan('glm-5.3', {completion_tokens: 5}, PEAK), undefined);
	t.is(computeCostYuan('', oneMillionMiss, PEAK), undefined);
	t.is(computeCostYuan(undefined, oneMillionMiss, PEAK), undefined);
	t.is(computeCostYuan('glm-4.7', oneMillionMiss, PEAK), undefined);
});
