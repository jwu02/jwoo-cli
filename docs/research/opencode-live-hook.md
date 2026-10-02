# OpenCode live hook: can a shell command run when a turn completes?

> Shipped as the **Shim**: `opencode-plugin/jwoo.mjs` in this repo, symlinked into
> `~/.config/opencode/plugins/`. The plugin registers the `event` hook, filters on
> `message.updated` for an assistant message whose `info.time.completed` is set, and spawns
> `usage record-opencode` with the `info` blob on stdin.
>
> One reading below was corrected after this note was written, against this machine's own
> OpenCode database (spec #51, 1,962 assistant messages): `tokens.total` **does** exist, and
> is referenced in the sections that carry the correction.

**Verdict:** Feasible, but only through an in-process JS/TS plugin — there is no config-level
shell-command hook. A plugin file registers the `event` hook, filters on `message.updated` for
an assistant message whose `info.time.completed` is set, reads tokens from
`event.properties.info.tokens.*`, and spawns the shell command itself.

Target of study: the locally installed **OpenCode 1.18.32** (Homebrew,
`/opt/homebrew/Cellar/opencode/1.18.32/bin/opencode`; `opencode --version` prints `1.18.32`).

## Event & payload

### No `hooks` config key exists

OpenCode does not have a Claude-Code-style `hooks` config object mapping lifecycle events to
shell command strings. The `opencode.json` schema is a fixed key set, and `hooks` is not in it.
The binary embeds the schema as a literal:

```text
var At=new Set(["logLevel","server","command","reference","snapshot","plugin","autoshutdown",
"disabled_providers","enabled_providers","small_model","mode","agent","provider","permission","tool", ...])
```

(`/opt/homebrew/Cellar/opencode/1.18.32/bin/opencode`, string search for `logLevel","server","command`).

The `command` key there is the custom-slash-command table (markdown prompt files), not a hook.
The only extension mechanism is a JS/TS **plugin**, defined by the `Hooks` interface:

- Local type definition: `/Users/jwu02/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`
  lines 36–51 (`PluginInput`, `Plugin`) and 170–313 (`interface Hooks`).
- Upstream source at the matching tag:
  https://github.com/sst/opencode/blob/v1.18.32/packages/plugin/src/index.ts (line 222 `export interface Hooks`, line 224 `event?`).

The `Hooks` interface exposes exactly one generic event hook:

```ts
event?: (input: { event: Event }) => Promise<void>
```

Everything else is a named lifecycle hook (`chat.message`, `chat.params`, `chat.headers`,
`tool.execute.before`, `tool.execute.after`, `tool.definition`, `command.execute.before`,
`shell.env`, `permission.ask`, plus `experimental.*`). There is **no** `message.completed` /
`turn.completed` / `session.turn.complete` hook — completion has to be derived from a bus event.
The `PluginInput` the plugin function receives does include a Bun shell handle, `$: BunShell`, so
the plugin can spawn a subprocess itself.

### The winning event: `message.updated`

`message.updated` is published every time a message row is written, including the two writes that
mark an assistant turn finished. Both go through `Session.updateMessage`, which publishes the
event:

```ts
const updateMessage = <T extends SessionV1.Info>(msg: T): Effect.Effect<T> =>
	Effect.gen(function* () {
		yield* events.publish(SessionV1.Event.MessageUpdated, {
			sessionID: msg.sessionID,
			info: msg,
		});
		return msg;
	}).pipe(Effect.withSpan('Session.updateMessage'));
```

https://github.com/sst/opencode/blob/v1.18.32/packages/opencode/src/session/session.ts — `updateMessage`, around line 629–633.

The step-finish path sets the accumulated cost and the step's tokens on the assistant message and
then writes it (processor.ts, lines 457–470):

```ts
ctx.assistantMessage.finish = value.reason
ctx.assistantMessage.cost += usage.cost
ctx.assistantMessage.tokens = usage.tokens
...
yield* session.updateMessage(ctx.assistantMessage)
```

https://github.com/sst/opencode/blob/v1.18.32/packages/opencode/src/session/processor.ts (lines 457–470).

The turn-close path sets `time.completed` and writes again (processor.ts, lines 609–610):

```ts
ctx.assistantMessage.time.completed = Date.now();
yield * session.updateMessage(ctx.assistantMessage);
```

So a plugin detects end-of-turn by watching for `type === "message.updated"` where
`info.role === "assistant"` **and** `info.time.completed !== undefined`. Note that a single turn
with tool calls emits several `message.updated` events (one per step); only the last one carries
`time.completed`, which is what makes it the reliable per-turn signal.

### Exact payload fields

The event type (v1.18.32 SDK) is:

```ts
export type EventMessageUpdated = {
	type: 'message.updated';
	properties: {
		info: Message;
	};
};
```

https://github.com/sst/opencode/blob/v1.18.32/packages/sdk/js/src/gen/types.gen.ts (line 145);
same shape in the local 1.14.24 package at
`/Users/jwu02/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` line 129.

`info` is `UserMessage | AssistantMessage`. For an assistant message
(https://github.com/sst/opencode/blob/v1.18.32/packages/sdk/js/src/gen/types.gen.ts line 112):

```ts
export type AssistantMessage = {
	id: string;
	sessionID: string;
	role: 'assistant';
	time: {
		created: number;
		completed?: number;
	};
	error?:
		| ProviderAuthError
		| UnknownError
		| MessageOutputLengthError
		| MessageAbortedError
		| ApiError;
	parentID: string;
	modelID: string;
	providerID: string;
	mode: string;
	path: {
		cwd: string;
		root: string;
	};
	summary?: boolean;
	cost: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cache: {
			read: number;
			write: number;
		};
	};
	finish?: string;
};
```

Field-by-field, the access paths a plugin uses (all under `event.properties`):

| What                   | Path                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Event kind             | `event.type === "message.updated"`                                                                                            |
| Message                | `event.properties.info`                                                                                                       |
| Role guard             | `event.properties.info.role === "assistant"`                                                                                  |
| Completion marker      | `event.properties.info.time.completed` (set = turn over)                                                                      |
| Input tokens           | `event.properties.info.tokens.input`                                                                                          |
| Output tokens          | `event.properties.info.tokens.output`                                                                                         |
| Reasoning tokens       | `event.properties.info.tokens.reasoning`                                                                                      |
| Cache read tokens      | `event.properties.info.tokens.cache.read`                                                                                     |
| Cache write tokens     | `event.properties.info.tokens.cache.write`                                                                                    |
| Total tokens           | `event.properties.info.tokens.total` (see the correction below)                                                               |
| Cost                   | `event.properties.info.cost` (number, accumulated across the turn) — never read; the CLI prices from its own table (ADR-0014) |
| Model id               | `event.properties.info.modelID`                                                                                               |
| Provider id            | `event.properties.info.providerID`                                                                                            |
| Project cwd            | `event.properties.info.path.cwd`                                                                                              |
| Project root           | `event.properties.info.path.root`                                                                                             |
| Session id             | `event.properties.info.sessionID`                                                                                             |
| Message id             | `event.properties.info.id`                                                                                                    |
| Parent user-message id | `event.properties.info.parentID`                                                                                              |
| Start timestamp        | `event.properties.info.time.created` (ms epoch)                                                                               |
| Finish timestamp       | `event.properties.info.time.completed` (ms epoch)                                                                             |
| Finish reason          | `event.properties.info.finish`                                                                                                |

**Correction (verified against this machine's OpenCode database, #51 D4):** the installed
`AssistantMessage` type omits it, but the row carries a `tokens.total`, present on all but the
48 all-zero aborted generations across 1,962 assistant messages and equal to the sum of the
counters in every row that has it. The CLI takes it when it is there and falls back to
prompt + completion when it is not. `input + output + reasoning` are the counters that bill, and
`cache.read` / `cache.write` are the two cache counters. `cost` is a single accumulated number for
the assistant message, and the CLI never reads it — the Pricing table is the only cost source
(ADR-0014).

### cwd / directory — yes, it is in the payload

The event carries the project directory directly, so the plugin does **not** need
`process.cwd()`. Both directories are on the assistant message:

- `event.properties.info.path.cwd` — the session's working directory.
- `event.properties.info.path.root` — the project/worktree root.

Separately, the plugin's own factory args carry `directory` and `worktree`
(`PluginInput`, plugin `index.d.ts` lines 36–45; docs "Basic structure" lists `project`, `client`,
`$`, `directory`, `worktree`). Those are per-process values resolved at plugin load; the event's
`info.path.cwd` is per-message and is the more precise source if a plugin ever serves more than
one directory.

### Other events considered

| Event                  | Fires when                                                   | Carries tokens?                                                                                                                | Verdict                                                                                                        |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `message.updated`      | every message write; last one of a turn has `time.completed` | yes, full `tokens` + `cost`                                                                                                    | **winning event**                                                                                              |
| `message.part.updated` | every part write, incl. `step-finish` parts                  | the `step-finish` part carries `tokens` + `cost` (`StepFinishPart`, types.gen.ts ~line 282) but no `cwd`/model; fires per step | workable alternative, noisier                                                                                  |
| `session.idle`         | session goes idle after a turn                               | **no** — payload is `{ sessionID }` only                                                                                       | usable as a turn-end trigger, but you must then fetch the last assistant message via the SDK client for tokens |
| `session.updated`      | session metadata changes                                     | no                                                                                                                             | not a completion signal                                                                                        |
| `session.status`       | `idle` / `busy` / `retry` transitions                        | no                                                                                                                             | not a completion signal                                                                                        |
| `command.executed`     | a custom slash command runs                                  | no; `{ name, sessionID, arguments, messageID }`                                                                                | unrelated                                                                                                      |

`EventSessionIdle` (types.gen.ts line 475):

```ts
export type EventSessionIdle = {
	type: 'session.idle';
	properties: {sessionID: string};
};
```

The docs' own notification example uses `session.idle` as the completion trigger
(https://opencode.ai/docs/plugins/ "Send notifications"):

```js
export const NotificationPlugin = async ({
	project,
	client,
	$,
	directory,
	worktree,
}) => {
	return {
		event: async ({event}) => {
			// Send notification on session completion
			if (event.type === 'session.idle') {
				await $`osascript -e 'display notification "Session completed!"'`;
			}
		},
	};
};
```

That example is fine for a notification (no data needed beyond "it's done"). For a token-usage
hook it is the wrong choice — `session.idle` carries no usage, so you would need a second SDK
round-trip. `message.updated` carries the usage inline.

## Configuration

Two ways to register a plugin, both documented at https://opencode.ai/docs/plugins/ and enforced
by the binary:

1. **Auto-discovered files.** Any `*.ts` or `*.js` file in
   - `.opencode/plugins/` (project-level), or
   - `~/.config/opencode/plugins/` (global)

   is loaded automatically at startup. The 1.18.32 binary's embedded tip text says
   "Add `.ts` files to `.opencode/plugins/` for event hooks"; the docs give the same two
   directories. (The binary also contains the string `\.opencode/plugin/\` or \`.opencode/plugins/\``,
single- and plural-form — the docs only promise the plural form, so use the plural directory.)
On this machine there is currently **no** `~/.config/opencode/plugins/` directory; it must be
   created.

2. **Config array.** `plugin` in `opencode.json`, accepting npm specs, pinned specs, local paths,
   and `[name, options]` tuples:

   ```json
   {
   	"plugin": [
   		"opencode-wakatime",
   		"@my-org/custom-plugin",
   		"./local-plugin.ts"
   	]
   }
   ```

   Local paths are relative to the declaring config file. The embedded config doc in the binary
   lists the accepted entry forms: `"opencode-gemini-auth"`, `"opencode-foo@1.2.3"`,
   `"./local-plugin.ts"`, `"file:///abs/path/plugin.js"`, `["opencode-bar", { "key": "val" }]`.
   This machine's `~/.config/opencode/opencode.json` already uses the array form with
   `"plugin": ["@dietrichgebert/ponytail"]`.

Load order (docs, "Load order"): global config → project config → global plugin dir → project
plugin dir. Duplicate npm packages with the same name+version load once; a local file and an npm
package with the same name both load.

### Minimum working plugin

File: `~/.config/opencode/plugins/telemetry.ts` (global, no `opencode.json` edit needed):

```ts
import type {Plugin} from '@opencode-ai/plugin';

export const Telemetry: Plugin = async ({$}) => ({
	event: async ({event}) => {
		if (event.type !== 'message.updated') return;
		const info = event.properties.info;
		if (info.role !== 'assistant' || info.time.completed === undefined) return;

		await $`my-collector \
      --session ${info.sessionID} \
      --message ${info.id} \
      --cwd ${info.path.cwd} \
      --input ${info.tokens.input} \
      --output ${info.tokens.output} \
      --reasoning ${info.tokens.reasoning} \
      --cache-read ${info.tokens.cache.read} \
      --cache-write ${info.tokens.cache.write} \
      --cost ${info.cost} \
      --model ${info.modelID} \
      --provider ${info.providerID} \
      --completed ${info.time.completed}`;
	},
});
```

The `$` is Bun's shell from `PluginInput`; `node:child_process` is equally available since the
plugin runs in the OpenCode process. Note the plugin module is loaded by the running server, so the
`@opencode-ai/plugin` import resolves against `~/.config/opencode/node_modules` (present here,
version 1.14.24). A plugin that only needs plain JS can drop the type import entirely.

TypeScript plugins do not need a build step: OpenCode loads the `.ts` directly. `package.json` in
the config directory supplies any extra npm deps (docs, "Dependencies").

```jsonc
// opencode.json alternative to a file in plugins/
{"plugin": ["./plugins/telemetry.ts"]}
```

## Version verification (1.18.32)

- Binary version: `opencode --version` → `1.18.32`; Homebrew path
  `/opt/homebrew/Cellar/opencode/1.18.32/bin/opencode` exists. The bundled file is a single
  Mach-O arm64 executable containing the whole JS bundle.
- The release tag exists upstream: `v1.18.32` is in the `sst/opencode` releases list
  (checked via the GitHub releases API).
- **Every claim above was re-checked against the `v1.18.32` tag on GitHub**, not only against the
  locally installed npm packages.
- The binary embeds its own config/plugins documentation and the config schema key set; those were
  read out of the binary and agree with the docs and the tagged source.
- The runtime schema and the type declaration disagree on one point: `Session.updateMessage`
  publishes `message.updated` with `{ sessionID, info }` (session.ts, ~line 631), and the binary's
  event schema reads `schema:{sessionID:B_,info:CX}` — but the published `EventMessageUpdated`
  type declares only `properties.info`. So at runtime `event.properties.sessionID` exists, yet it
  is not in the TypeScript type. Use `event.properties.info.sessionID` for both correctness and
  type-checking.

**Discrepancy to be aware of — the npm packages are older than the binary.** The installed
`@opencode-ai/plugin` and `@opencode-ai/sdk` are both **1.14.24**
(`~/.config/opencode/node_modules/@opencode-ai/plugin/package.json`), while the binary is
1.18.32. For the shapes this hook depends on the two agree: `AssistantMessage` (SDK types
lines 98–127 local vs 112–140 at v1.18.32), `EventMessageUpdated` (129 local vs 145 tagged),
`EventSessionIdle` (413 local vs 475 tagged), and the `Hooks` interface's `event` hook (local
`index.d.ts` line 170 vs tagged `index.ts` line 224). Treat the installed 1.14.24 `.d.ts` files
as authoritative for the payload _shapes_, and the tagged source for the _behaviour_ (when the
event fires). If the npm package is later upgraded to 1.18.x, nothing in this note should change.

## Evidence table / sources

| Claim                                                                      | Source                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `hooks` config key; config schema key set                               | `/opt/homebrew/Cellar/opencode/1.18.32/bin/opencode` — literal `new Set(["logLevel","server","command",...,"plugin",...])`                                          |
| Only plugins, no shell hook                                                | https://opencode.ai/docs/plugins/ ; https://opencode.ai/docs/config/ ("Plugins extend OpenCode with custom tools, hooks, and integrations")                         |
| Plugin dirs `.opencode/plugins/`, `~/.config/opencode/plugins/`            | https://opencode.ai/docs/plugins/ ("From local files"); binary tip text `Add {highlight}.ts{/highlight} files to {highlight}.opencode/plugins/`                     |
| `plugin` array config forms                                                | https://opencode.ai/docs/plugins/ ("From npm"); embedded config doc in the 1.18.32 binary                                                                           |
| `Plugin` signature `(PluginInput) => Promise<Hooks>`                       | `/Users/jwu02/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` line 51                                                                            |
| `PluginInput` = `{ client, project, directory, worktree, $, ... }`         | same file, lines 36–46                                                                                                                                              |
| `event?: (input: { event: Event }) => Promise<void>`                       | same file, line 171; https://github.com/sst/opencode/blob/v1.18.32/packages/plugin/src/index.ts line 224                                                            |
| `message.updated` event fires on message write                             | https://github.com/sst/opencode/blob/v1.18.32/packages/opencode/src/session/session.ts — `updateMessage` (~line 629–633) publishes `SessionV1.Event.MessageUpdated` |
| Cost/tokens set at step finish                                             | https://github.com/sst/opencode/blob/v1.18.32/packages/opencode/src/session/processor.ts lines 457–470                                                              |
| `time.completed` set at turn close                                         | same file, lines 609–610                                                                                                                                            |
| `AssistantMessage` field list incl. `path.cwd`                             | https://github.com/sst/opencode/blob/v1.18.32/packages/sdk/js/src/gen/types.gen.ts line 112                                                                         |
| `EventMessageUpdated` / `EventSessionIdle` / `EventCommandExecuted` shapes | same file, lines 145 / 475 / 523                                                                                                                                    |
| Installed SDK types 1.14.24                                                | `/Users/jwu02/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` lines 98, 129, 413                                                            |
| Notification example using `session.idle`                                  | https://opencode.ai/docs/plugins/ ("Send notifications")                                                                                                            |
| Event name list (Message/Session/Command events)                           | https://opencode.ai/docs/plugins/ ("Events")                                                                                                                        |
| `v1.18.32` tag exists                                                      | `https://api.github.com/repos/sst/opencode/releases` (`tag_name` list)                                                                                              |

## Open questions

- **`message.updated` fan-out under a multi-step turn.** The processor writes the assistant
  message once per step-finish and once at turn close. Only the turn-close write sets
  `time.completed`. Not verified with a live run whether some intermediate write also sets
  `completed` under retries or compaction; a plugin that guards on `time.completed` and de-dupes
  on `info.id` is safe either way.
- **Cost units.** `info.cost` is a plain number; the docs do not state the currency. Almost
  certainly USD, but not confirmed from a primary source in this pass.
- **`tokens.total`.** Closed by #51 D4: the field is not in the type, but it is on the row and
  equals the sum of the counters. Whether `reasoning` is a subset of `output` (i.e. already
  counted) is not documented in the sources read; the CLI-SDK billing convention varies by
  provider. The projection bills `reasoning` as cache-miss input and treats it as disjoint from
  `output`, which the DB verification confirmed.
- **Single vs plural plugin directory.** The docs promise `.opencode/plugins/` (plural) and
  `~/.config/opencode/plugins/` (plural); the binary contains both `plugin/` and `plugins/`
  strings. Only the plural forms are documented and were used here; the singular form is
  unverified.
- **No live runtime test was performed.** All findings are from the 1.18.32 binary, the
  `v1.18.32` tagged source, the official docs, and the installed 1.14.24 type declarations. A
  plugin was not actually loaded and an event was not actually observed firing.
- **`session.idle` to tokens** would require an SDK call (`client.session.messages` or similar)
  to recover the last assistant message; that path was not explored because `message.updated`
  already carries the payload.
