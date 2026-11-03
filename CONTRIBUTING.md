# Contributing to Flow

Thanks for helping. Flow is a small vanilla-JS and Node app: there is no framework, no bundler and no build step. Contributions should keep it that way.

## Getting started

```sh
npm ci
npm start            # http://127.0.0.1:4317 in local single-user mode, no sign-in needed
```

Node 22 or newer. Without OneProfileID settings the server only listens on loopback. For setup and environment variables, see `README.md` › Sign-in and environments.

## Checks

Run these before you open a pull request. CI runs the first three.

```sh
npm run check                 # syntax of every module
npm test                      # unit tests (node --test)
node tools/docs.mjs --check   # generated docs match their sources
node verify.mjs               # end-to-end in headless Edge/Chrome on its own port and temp profile
```

`verify.mjs` and the unit tests never contact production or a real database. Tests that need Postgres use the `embedded-postgres` dev dependency on a loopback port.

## Code style

- Match the surrounding code: compact ES modules, short comments that explain why, and no new runtime dependencies without discussing them first.
- Pure logic (validation, merging, board rules) lives in `*-core.js` files with no DOM, so Node can test it. UI modules use those files.
- Saved data must keep loading. Treat existing storage keys and table names as compatibility contracts, and make schema changes additive and idempotent.
- Comments say what the code does, in plain words.

## Docs

The docs in `public/docs/`, `public/llms*.txt`, `skills/flygon-flow/SKILL.md` and `docs/generated/` are **generated**. Edit their sources instead:
- the operation registry (`lib/registry.mjs`): summaries, descriptions, schemas, examples
- `docs/concepts/*.md`: hand-written concepts
- `public/devlog.json`: releases, recorded automatically after each push to `main` by the DevLog workflow (`tools/devlog-auto.mjs`); pull before you push, and do not edit it by hand

Then run `node tools/docs.mjs` and commit the result.

## Data and privacy

Never commit real people, customer data, `.env` files, tokens or API keys. That covers fixtures, screenshots and examples too. Use the fictional names in `public/demo-seed.js` and `example.com` / `example.test` addresses.

## Pull requests

- Keep each PR to one change, with a clear title and a sentence on why.
- Add or update tests for behaviour changes.
- By contributing you agree that your work is licensed under the MIT License (see `LICENSE`) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
