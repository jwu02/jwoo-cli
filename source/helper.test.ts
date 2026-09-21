/*
One assertion, and it earns its file: the path is relative to the *compiled*
module, so a wrong number of `../` is invisible until something tries to run the
helper — which on a machine without the grant is a path nobody exercises. Two
callers depend on the answer and neither can check the other's copy.
*/

import test from 'ava';
import {HELPER_PATH} from './helper.js';

test('the helper path is the committed binary beside the source', t => {
	t.true(HELPER_PATH.endsWith('helper/bin/eventtap'));
});
