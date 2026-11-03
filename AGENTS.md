# Flow repository

The canonical source repository for Flow by Flygon LC is `https://github.com/aribradshaw/flow`.
Make product changes here, and use `origin/main` for updates. The production Railway service tracks this repository's `main` branch.

Flow is an open source tool for anyone to use. Keep private project names, personal data, local filesystem paths, and deployment secrets out of tracked files and commit history. Before proposing public release, review the repository contents and reachable history for sensitive material.

Every push to `main` is versioned automatically: the DevLog workflow records it in `public/devlog.json` and commits that back, so pull (`git pull --rebase`) before pushing and never hand-edit the registry. Use `DevLog-Note:`, `DevLog-Compat:` and `DevLog-Action:` commit trailers when the subject is not the right release note.

Run `npm run check` and `npm test` for code changes. Keep the README aimed at users of Flow, including mind maps, timelines, and DevOps boards.
