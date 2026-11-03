# Release process

Flow uses [Bradshaw Versioning](https://github.com/aribradshaw/devlog/blob/main/docs/bradshaw-versioning.md) numbers, one per production deploy. When a production deploy starts, the server records a DevLog release in Postgres (`flygon_flow_devlog_releases`, via `@aribradshaw/devlog` deploy-time releases) listing every commit the deploy brought. Nothing is committed back to git: there is no DevLog workflow, no bot commit and no hand edit. `public/devlog.json` is frozen history up to `0.11.25`. Release notes come from the commit subjects, or from `DevLog-Note:` trailers when present. Mark a change that needs action with `DevLog-Compat: action-required` (or `breaking`) and a `DevLog-Action:` trailer. Public release milestones are tagged `vYEAR.MONTH.UPDATE` with the version of the deployed release that contains the tagged commit; the first public release is `v0.11.19`. Record user-facing changes in `CHANGELOG.md` under Unreleased as work lands, then move them to a dated version heading when tagging.

Before a public tag:

1. Run `npm ci`, `npm run check`, `npm test`, and `npm run docs:check`.
2. Inspect tracked files and reachable Git history for credentials, private project names, personal data, and local paths. Keep the repository private until this review is complete.
3. Confirm the self-host instructions from a clean clone and restore a sample backup.
4. Verify the production deployment and compare the deployed commit with the intended tag.
5. Confirm the production deploy recorded its release (the deploy log shows `DevLog: recorded <version> …`, and Settings › DevLog or `GET /api/devlog` lists it), then update `CHANGELOG.md`, create an annotated `vYEAR.MONTH.UPDATE` tag with that release's version on the deployed commit, and publish the release notes.

For the first public release, review author metadata and old GitHub workflow-linked commit objects before changing repository visibility. GitHub makes existing Actions logs public with the repository. After the visibility change, enable **Settings → Security and quality → Advanced Security → Private vulnerability reporting**, then verify that **Security → Report a vulnerability** is available as promised in `SECURITY.md`. Enable secret scanning and push protection where available. Create the tag and publish release notes only after the public commit and deployment are verified.

The repository's `package.json` remains private. The CLI is available from a checkout with `node tools/flow.mjs`. Publishing it to npm needs a separate packaging and security review; do not advertise `npx flygon-flow` as available until that publication succeeds.
