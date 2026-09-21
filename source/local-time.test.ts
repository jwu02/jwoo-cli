import test from 'ava';
import {isValidTimeZone} from './local-time.js';

/*
`isValidTimeZone` exists because the obvious way to name the machine's zone is
not safe to pass on. `Intl.DateTimeFormat().resolvedOptions().timeZone` is
typed `string`, but returns `undefined` when `TZ` names a zone it cannot
resolve, and `'Etc/Unknown'` when `TZ` is empty. `'Etc/Unknown'` is an ICU
invention rather than a tzdb name, so handing it back to Intl throws.

Anything that resolves the machine's zone has to ask rather than assume, and
this is the thing it asks.
*/

test('accepts zones Intl can resolve', t => {
	t.true(isValidTimeZone('UTC'));
	t.true(isValidTimeZone('Europe/London'));
	t.true(isValidTimeZone('Asia/Shanghai'));
});

test('rejects the placeholder ICU returns for an empty TZ', t => {
	t.false(isValidTimeZone('Etc/Unknown'));
});

test('rejects an unresolvable zone name', t => {
	t.false(isValidTimeZone('Bogus/Zone'));
});

test('rejects nothing at all', t => {
	// `resolvedOptions().timeZone` is typed `string` but returns undefined here.
	t.false(isValidTimeZone(undefined));
	t.false(isValidTimeZone(''));
});
