# Release process

Flow uses [Bradshaw Versioning](https://github.com/aribradshaw/devlog/blob/main/docs/bradshaw-versioning.md): every commit that reaches `main` gets the next `YEAR.MONTH.UPDATE` number in the in-app DevLog (`public/devlog.json`). Public release milestones are tagged `vYEAR.MONTH.UPDATE` with the DevLog version of the tagged commit; the first public release is `v0.11.19`. Record user-facing changes in `CHANGELOG.md` under Unreleased as work lands, then move them to a dated version heading when tagging.

Before a public tag:

1. Run `npm ci`, `npm run check`, `npm test`, and `npm run docs:check`.
2. Inspect tracked files and reachable Git history for credentials, private project names, personal data, and local paths. Keep the repository private until this review is complete.
3. Confirm the self-host instructions from a clean clone and restore a sample backup.
4. Verify the production deployment and compare the deployed commit with the intended tag.
5. Record any unrecorded commits with `node tools/devlog.mjs status` and `record`, then update `CHANGELOG.md`, create an annotated `vYEAR.MONTH.UPDATE` tag matching the commit's DevLog version, and publish the release notes.

For the first public release, review author metadata and old GitHub workflow-linked commit objects before changing repository visibility. GitHub makes existing Actions logs public with the repository. After the visibility change, enable **Settings → Security and quality → Advanced Security → Private vulnerability reporting**, then verify that **Security → Report a vulnerability** is available as promised in `SECURITY.md`. Enable secret scanning and push protection where available. Create the tag and publish release notes only after the public commit and deployment are verified.

The repository's `package.json` remains private. The CLI is available from a checkout with `node tools/flow.mjs`. Publishing it to npm needs a separate packaging and security review; do not advertise `npx flygon-flow` as available until that publication succeeds.
