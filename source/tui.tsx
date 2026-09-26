/*
The dashboard, mounted.

Split out from `main.tsx` so that the only module which statically imports ink
and react is one that a headless `collect` never loads (ADR-0001). Nothing here
decides anything: it mounts the App, waits for it to be exited, and returns. The
sources' lifetime is the caller's — `main.tsx` stops the session in a `finally`,
which is what closes the store the frame was reading.
*/

import {render} from 'ink';
import App from './app.js';
import {type DashboardView} from './main.js';

export async function renderApp({
	history,
	telemetry,
	runLog,
	startedAt,
	timeZone,
	ended,
}: DashboardView): Promise<void> {
	const instance = render(
		<App
			history={history}
			telemetry={telemetry}
			runLog={runLog}
			startedAt={startedAt}
			timeZone={timeZone}
		/>,
		/*
		The dashboard takes the whole terminal rather than drawing a frame into
		the scrollback: what it drew is gone when it exits, and the shell's own
		output is where it was. A frame as tall as the window is a screenful by
		definition, and this is what makes it a screenful rather than the last
		thing written over everything before it.

		It is inert where there is no terminal to take — Ink enters the alternate
		screen only when stdout is a TTY and the run is interactive — so a piped
		or redirected run draws the frames it always did.
		*/
		{alternateScreen: true},
	);

	/*
	Quitting is not the only way out. A signal ends the run without the view
	asking, and the frame left behind would go on showing counters as though
	they were still moving. `unmount()` is idempotent, so this is safe on the
	ordinary path too, where the run is ended after the view already has.
	*/
	void ended.then(() => {
		instance.unmount();
	});

	/*
	Ctrl-C takes the default path as well as `q`, so the dashboard ends on any
	exit rather than only on the key.
	*/
	await instance.waitUntilExit();
}
