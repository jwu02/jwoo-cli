/*
Where the capture helper is.

Its own module because two others need the answer for different reasons —
`permissions.ts` to ask it about the grant, `event-stream.ts` to run it — and a
copy in each is a copy that can drift. The failure that drift produces is worth
naming: one of the two would be talking to a different process from the other,
and both would look like they were working.

Committed beside the source and resolved from this module rather than from the
working directory, so the CLI can be run from anywhere. `dist/helper.js` sits
one level under the repo root, as `source/helper.ts` does.
*/

import {fileURLToPath} from 'node:url';

export const HELPER_PATH = fileURLToPath(
	new URL('../helper/bin/eventtap', import.meta.url),
);
