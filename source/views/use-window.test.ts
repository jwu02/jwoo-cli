import test from 'ava';
import {windowHeightOf} from './use-window.js';

test('a stream that reports its height is the window', t => {
	t.is(windowHeightOf({rows: 40}), 40);
	t.is(windowHeightOf({rows: 1}), 1);
});

/*
No height at all and a height of nothing are the same answer here, and that is
the point of the function: a pipe reports no `rows` and a stream with no
terminal behind it reports 0, and a frame sized to either would be a frame drawn
in no lines.
*/
test('a stream that reports no height offers none to size to', t => {
	t.is(windowHeightOf({}), undefined);
	t.is(windowHeightOf({rows: 0}), undefined);
});
