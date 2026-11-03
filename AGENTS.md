# Flow repository

The canonical source repository for Flow by Flygon LC is `https://github.com/aribradshaw/flow`.
Make product changes here, and use `origin/main` for updates. The production Railway service tracks this repository's `main` branch.

Flow is an open source tool for anyone to use. Keep private project names, personal data, local filesystem paths, and deployment secrets out of tracked files and commit history. Before proposing public release, review the repository contents and reachable history for sensitive material.

Versions come from production deploys: each deploy of `main` records one DevLog release in Postgres at server start, listing the commits it brought (`lib/devlog-releases.mjs`). Nothing is committed back: no bot commits, and no hand edits to `public/devlog.json`, which is frozen history. Release tags use the version of the deployed release that contains the tagged commit. Use `DevLog-Note:`, `DevLog-Compat:` and `DevLog-Action:` commit trailers when the subject is not the right release note.

Run `npm run check` and `npm test` for code changes. Keep the README aimed at users of Flow, including mind maps, timelines, and DevOps boards.
