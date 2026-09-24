/*
How tall the window is.

Ink sizes its root to the terminal's width and leaves the height to the
content, so a frame is exactly as tall as what it holds: a dashboard with two
lines in it is two lines in the middle of a screen, and nothing in the layout
can ask how much room there is to fill. The height is only here, on the stream.

It is read from the stream's own `rows` rather than through Ink's
`useWindowSize`, whose fallback for a stream that reports nothing is
`terminal-size` — an answer that comes from the environment (and can involve
spawning `tput`) rather than from what is being drawn into. A frame should not
change shape because of what a build machine has installed.

Absent and 0 are the same answer, deliberately: a pipe reports no `rows` at all
and a stream with no terminal behind it reports 0, and a frame sized to either
would be a frame drawn in no lines. Nothing to size to means the frame stays
the height of its content, which is what it was before there was a window to
fill.

The `resize` event is the same one Ink listens for. The read is a subscription
rather than a poll because the terminal says when it has changed, and this hook
is the only reader of it.
*/

import {useStdout} from 'ink';
import {useEffect, useState} from 'react';

export function windowHeightOf(stdout: {
	readonly rows?: number;
}): number | undefined {
	return stdout.rows === undefined || stdout.rows <= 0
		? undefined
		: stdout.rows;
}

export function useWindowHeight(): number | undefined {
	const {stdout} = useStdout();
	const [height, setHeight] = useState(() => windowHeightOf(stdout));

	useEffect(() => {
		const onResize = () => {
			setHeight(windowHeightOf(stdout));
		};

		stdout.on('resize', onResize);

		return () => {
			stdout.off('resize', onResize);
		};
	}, [stdout]);

	return height;
}
