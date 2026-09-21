/*
The dashboard, mounted.

Split out from `main.tsx` so that the only module which statically imports ink
and react is one that a headless `collect` never loads (ADR-0001). Nothing here
decides anything: it mounts the App, waits for it to be exited, and returns. The
store's lifetime is the caller's — `main.tsx` closes it in a `finally`.
*/

import {render} from 'ink';
import App from './app.js';
import {type HistorySource} from './history.js';

export async function renderApp(source: HistorySource): Promise<void> {
	const instance = render(<App source={source} />);

	/*
	Quitting is not the only way out — Ctrl-C takes the default path — so the
	dashboard ends on any exit, not just `q`.
	*/
	await instance.waitUntilExit();
}
