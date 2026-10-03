# The Pi Shim

`jwoo.ts` is the pi-side extension that gives pi the live capture Claude Code
gets from its `settings.json` hook wiring and OpenCode gets from its plugin
directory. It observes `message_end`, keeps the events whose message is an
assistant message carrying usage, and spawns `jwoo-cli usage record-pi` with the
message and the context's `cwd` on stdin. It owns the guard and the spawn,
nothing else.

Pi discovers personal extensions in `~/.pi/agent/extensions/`, so installing it
is a symlink — the file stays in this repo and is picked up on pi's next start:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-extension/jwoo.ts" ~/.pi/agent/extensions/jwoo.ts
```

No settings edit is needed. Pi loads an extension file directly through `jiti`,
so the TypeScript is loaded as-is — there is no build step for the Shim itself.
Personal extensions load in every run mode: interactive, `-p` print, `--mode
json`, `--mode rpc`, and SDK sessions. Two escapes are accepted gaps in the same
class as a missing `dist/` after a pull, which ADR-0016 accepts: pi's
`-ne`/`--no-extensions` opt-out, and an SDK host that supplies its own resource
loader instead of pi's default discovery.

## Before it does anything

- **Build the CLI.** The Shim spawns `dist/cli.js`, which is gitignored — run
  `npm run build` after a pull, or the spawn fails silently (an extension may not
  throw into pi; ADR-0016).
- **The node path is pinned in `jwoo.ts`.** It tracks `.nvmrc`; if that moves,
  the Shim's `NODE` constant moves with it. The ambient node is too old for
  `node:sqlite`.
- **The checkout path is pinned too.** `jwoo.ts` assumes this repo lives at
  `~/Developer/PersonalProjects/personal-website/jwoo-cli`, the same assumption
  the CLI's own hook wiring line makes. Edit both constants if it moves.

Records land in the Local Store either way; `MONGO_URI` is only needed for the
end-of-invocation Push, and the Shim reads it from this checkout's `.env`
(`--env-file-if-exists`), never from pi's environment.
