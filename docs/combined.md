# Combined view (how it works)

Users see this in [the concept page](concepts/12-combined.md). This page is for people changing Flow.

## Model

- The open environment is the **home**. `GET /api/workspace?env=<home>&combine=<a>,<b>` (the browser adds `combine` from the per-user pref `combinedEnvs`, `public/combined.js`) returns the home workspace with the records of each combined environment projected into it, the same way shares are (`docs/sharing.md`):
  - ids `cx.<env id>.<their id>` for DevOps cards and labels, timeline items and projects, and for every reference between them (a card's project, item, labels and assignees; an item's projects and release; a project's entity). Share members (`@email`) keep their ids. A share placed in the combined environment comes as `cx.<env>.sh.<share>.<id>`.
  - `db.combined: [{env, name, rev, people, shares, shareMembers}]`: the environment's person cards (for assignees; name and photo, never email), the shares placed there (permission, owner, members) and the recipients of its own shares. They are never mind map cards: the mind map shows the home only.
  - Only environments the signed-in user **owns** are combined (`combinable` in `server.mjs`); anything else in `combine` is ignored, as is the home itself and anything for the owner token. At most 8 (`MAX_COMBINED`).
- `shared` (the polling signature) gets `cx:<env>:<rev>[:<its shares' signature>]` for each one, so `?since=<rev>&shared=<sig>` is `unchanged` only while none of them moved.

## Saving

- `stripLinked` (every store path: `PUT /api/workspace`, saves, backups, the API store) runs `stripCombined` first: every `cx.*` record, `db.combined` and every reference a home record holds to a `cx.*` id are dropped. A combined record is never stored in the home, whatever a browser sends.
- After the home is saved, `applyCombinedSave` turns the save into edits for each environment that has `cx.*` records in it (`combinedEdits` in `public/combined-core.js`): only the fields shared records allow (`SHARED_FIELDS` in `public/sync-core.js`), and only those this user changed: the browser records its user's edits to `sh.*` and `cx.*` records as they happen (`noteEdits`) and sends them as `sharedEdits`. A copy that is merely out of date, a merge or a tab running older code never counts as an edit. Values are mapped back to that environment's ids. A save that changes 20 or more of its records at once is refused, as for shares (`bulkWrite`). A field whose new value points at another environment (a home label on a combined card) is not sent. Nothing is created, deleted or re-parented. The edits are applied to the environment as served to its owner (shares included), normalized, stored with `baseRev` (retried on a conflict), then `recordOwnerChanges` and `applyRecipientSave` run for it exactly as for a save there, so an edit to a share placed in that environment goes on to the share's owner with its permission checked.
- The save's response carries the new `shared`, so the browser reads the workspace back and shows what each environment kept.

## Browser

- `public/share.js` `linkOf()` treats `cx.*` records as linked (`foreign: true`, `env`, `envName`, `innerShare`), so the locks and same-source rules of shared records apply: no delete, project and timeline item fixed, labels and people from the card's own environment. `sharedBadge` / `sharedChip` show the environment's name (`envBadge` in `public/combined.js`).
- `cleanDevops` lets combined cards keep their own numbers (they may repeat the home's) and leaves them out of the home's `nextNumber`. Deep links to a combined card are `#devops/card/<env>/<number>`.
- New cards, items and projects only inherit filters on the home's own records. AgentFlow pickers leave combined records out. The agent inbox applies patches to the home's own records only (`stripCombined` / `carryCombined`).

Tests: `test/combined.test.mjs` (the pure rules), `test/combined-e2e.test.mjs` (a real server with two users and a share).
