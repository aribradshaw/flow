## What and why

<!-- What changes, and the problem it solves. Link the card or issue (e.g. #48). -->

## How it was checked

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `node tools/docs.mjs --check` (run `node tools/docs.mjs` if you changed the registry, `docs/concepts/` or `public/devlog.json`)
- [ ] `node verify.mjs` for UI or server changes (headless Edge/Chrome; it never touches real data)

## Data and compatibility

- [ ] Saved data still loads: no renamed storage keys or tables, and schema changes are additive
- [ ] No real people, customer data, secrets or `.env` values in code, fixtures, screenshots or docs
- [ ] README or `docs/concepts/` updated if behaviour changed
