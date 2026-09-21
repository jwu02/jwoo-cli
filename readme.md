# jwoo-cli

Personal activity telemetry for a single user. A terminal dashboard observes mouse and keyboard
input on the author's own machine, accumulates counts in memory, and periodically writes them to
MongoDB Atlas, where a personal website renders them as a mouse and keyboard heatmap.

See `CONTEXT.md` for the vocabulary and `docs/adr/` for the decisions behind it.

## Requirements

Node 22 LTS. `.nvmrc` pins the major:

```bash
$ nvm use
```

`engines` requires `>=22.20.0`.

## Install

```bash
$ npm install
```

## CLI

```console
$ npm run build
$ node dist/cli.js
```
