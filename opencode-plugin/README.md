# The OpenCode Shim

`jwoo.js` is the OpenCode-side plugin that gives OpenCode the live capture
Claude Code gets from its `settings.json` hook wiring. It observes
`message.updated`, keeps the writes where `info.time.completed` is set, and
spawns `jwoo-cli usage record-opencode` with a document on stdin: the message's
`info` together with the Tool Call count and Skill names it accumulated from the
`message.part.updated` events for that message. It owns the guard, that
accumulation and the spawn, nothing else.

OpenCode auto-discovers plugins in `~/.config/opencode/plugins/`, so installing
it is a symlink — the file stays in this repo and is picked up on OpenCode's
next start:

```sh
mkdir -p ~/.config/opencode/plugins
ln -s "$PWD/opencode-plugin/jwoo.js" ~/.config/opencode/plugins/jwoo.js
```

No `opencode.json` edit is needed; a symlinked file in the plugin directory
loads on its own. A file in the project's `.opencode/plugins/` works the same
way, but this one is meant to serve every project. The `.js` extension is
load-bearing: the discovery glob is `{plugin,plugins}/*.{ts,js}`, so a `.mjs` in
there is never loaded. The file is ESM either way; a plugin file in the config
directory is imported as a module, not resolved through `package.json`.

## Before it does anything

- **Build the CLI.** The Shim spawns `dist/cli.js`, which is gitignored — run
  `npm run build` after a pull, or the spawn fails silently (a plugin may not
  throw into OpenCode; ADR-0016).
- **The node path is pinned in `jwoo.js`.** It tracks `.nvmrc`; if that moves,
  the Shim's `NODE` constant moves with it. The ambient node is too old for
  `node:sqlite`.
- **The checkout path is pinned too.** `jwoo.js` assumes this repo lives at
  `~/Developer/PersonalProjects/personal-website/jwoo-cli`, the same assumption
  the CLI's own hook wiring line makes. Edit both constants if it moves.

Records land in the Local Store either way; `MONGO_URI` is only needed for the
end-of-invocation Push, and the Shim reads it from this checkout's `.env`
(`--env-file-if-exists`), never from OpenCode's environment.
