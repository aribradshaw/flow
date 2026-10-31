# Release process

Flow's in-app DevLog records changes on `main`. Public release milestones use Semantic Versioning tags, starting with `v1.0.0` when the public release is ready. Record user-facing changes in `CHANGELOG.md` under Unreleased as work lands, then move them to a dated version heading when tagging.

Before a public tag:

1. Run `npm ci`, `npm run check`, `npm test`, and `npm run docs:check`.
2. Inspect tracked files and reachable Git history for credentials, private project names, personal data, and local paths. Keep the repository private until this review is complete.
3. Confirm the self-host instructions from a clean clone and restore a sample backup.
4. Verify the production deployment and compare the deployed commit with the intended tag.
5. Update `CHANGELOG.md`, create an annotated `vMAJOR.MINOR.PATCH` tag on the verified commit, and publish the release notes.

For the first public release, review author metadata and old GitHub workflow-linked commit objects before changing repository visibility. GitHub makes existing Actions logs public with the repository. After the visibility change, enable **Settings → Security and quality → Advanced Security → Private vulnerability reporting**, then verify that **Security → Report a vulnerability** is available as promised in `SECURITY.md`. Enable secret scanning and push protection where available. Create the tag and publish release notes only after the public commit and deployment are verified.

The repository's `package.json` remains private. The CLI is available from a checkout with `node tools/flow.mjs`. Publishing it to npm needs a separate packaging and security review; do not advertise `npx flygon-flow` as available until that publication succeeds.
