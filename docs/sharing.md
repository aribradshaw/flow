# Flow sharing (cards #59–#63)

Sharing lets the owner of an environment show part of it to another Flow user, who sees those records **placed** in one or more of their own environments. Every shared record has exactly one home (the owner's workspace). The recipient sees a linked copy with their own layout, and their edits (when allowed) are written back to the home record with per-field history.

Code:
- `lib/sharing-core.mjs`: the rules. Pure, with no storage or I/O, and unit-tested.
- `lib/shares.mjs`: storage for shares, re-share requests, placements and field history. It uses Postgres when `DATABASE_URL` is set, otherwise JSON files in `BACKUP_DIR`.
- `test/sharing.test.mjs`: run with `node --test test/sharing.test.mjs`. It covers the core, the JSON-file store and an embedded Postgres store with the migrations run twice.

## Model

```
share   = {id, ownerEnv, ownerEmail, recipientEmail, permission, scope, name, createdAt, createdBy, revokedAt, via}
scope   = {kind:'environment'}
        | {kind:'person',  nodeId}          everything connected below a person (any node works)
        | {kind:'label',   label}           a DevOps label id, or a node tag (optional node.tags[])
        | {kind:'project', projectId}
        | {kind:'nodes',   nodeIds:[...]}   hand-picked, no walk
          + optional chartId: only that chart's nodes and edges
permission = 'view' | 'comment' | 'edit'
request = {id, shareId, ownerEmail, requestedBy, toEmail, permission, note, status:'pending'|'approved'|'denied', decidedAt, decidedBy, newShareId}
placement = {shareId, envId, recordId (owner id), chartId, x, y, w, h}
history = {shareId, envId (owner env), kind, recordId (owner id), field, old, new, by, at}
```

### Scope (`resolveScope(db, share)`)
The scope is always computed **live** from the owner's current data, so a new child under Campfire Studio shows up for Bo, and a node that is detached from the chain disappears.

- **Person**: walk **down** from the node over `ownership` and `group` edges (`from` = owner/parent). Nothing above or beside the chain is included. Cycles are safe.
- **Co-owner stubs**: every scoped node brings each direct owner or grouper (an incoming edge from outside the scope) as a read-only stub: `{nodeId, name, nodeType, ownsNodeId, type, percent, edgeId}`. A stub never brings anything else, and in particular none of its other children. In Owner's case, Bo's scope is Bo → Marsh → Campfire Studio (→ Campfire Studio Ads). It has stubs for Kestrel Group (group, on Marsh) and Quill (50%, on Campfire Studio), and it never includes Kestrel Services, Cleo or anything else Cleo owns.
- **Projects follow nodes**: a scoped node brings the projects with `project.entity === node.id` (matched by id only, never by name, because name matching could leak), plus every timeline item tagged with one of those projects and every DevOps card in them.
- **Project** scope: the project, its items and its cards. No nodes.
- **Label** scope: the cards with that label and the timeline items they link. Nodes whose optional `tags[]` contains the label come with their projects, as above.
- **Environment** scope: everything, with no stubs.

### What the recipient sees (`projectForRecipient(ownerDb, share, placements)`)
The result is `{share, chart, nodes, edges, projects, timeline, cards, labels}`, or `null` once the share is revoked.
- Every record gets the id **`sh.<shareId>.<owner id>`**, so ids never collide with the recipient's own (all seeded charts use ids like `flygon` and `bo`). Detection always uses this prefix, because the browser's `clean*` functions strip unknown fields. Records also carry `linked:{share, id, home, permission, stub?, readOnly?}`, which survives on nodes and edges.
- Nodes copy only `name, type, notes, x, y, w, h`. Stubs copy only `name, type`. Edges come through when both ends are scoped, and stub edges come through when they connect a stub to a scoped node.
- References are rewritten or dropped: an item's out-of-scope project tags are removed. So are `release` titles that are not shared, card assignees outside the scope (e.g. Cleo on a Campfire Studio card), and `project`/`item` references outside the scope. Labels used by shared cards come along as read-only labels.
- A node without a placement sits in the share's own chart (`sh.<shareId>.chart`, named "Shared · <owner env name>") at the owner's x/y. A placement can move it into any of the recipient's charts.
- `applyProjection(recipientDb, projection)` merges the projection in (pure; re-applying is idempotent). Records that left the scope are removed, together with the recipient's private edges to them. Private edges to records that are still shared survive refreshes.

### Edits (`applyRecipientEdit(ownerDb, share, edit, user)`)
`edit = {kind:'node'|'edge'|'project'|'item'|'card', id, fields:{...}}` or `{kind, id, comment:'text'}`. The id may be the owner id or the linked id.
- Each permission allows: **view** nothing, **comment** comments only, **edit** whitelisted field changes plus comments.
- Errors are `revoked`, `forbidden` (not the recipient), `permission`, `stub` (stubs and stub edges are immutable, even for comments), `out-of-scope` (including the owner's private nodes), `not-found` and `invalid` (with the `field`).
- Whitelisted fields:
  - node: `name`, `notes`
  - edge: `percent`
  - project: `name`, `color`
  - item: `title`, `kind`, `status`, `priority`, `start`, `end`, `owner`, `link`, `notes`, `release`
  - card: `title`, `description`, `column`, `points`, `due`, `labels` (owner label ids), `checklist`, `links`

  Layout (x, y, w, h, chart) is never an edit: it is a per-environment placement, and any permission may change it.
- The result is `{ok, ownerDbPatch:[{kind,id,field,value}], history:[...]}`. Unchanged fields are skipped. `applyOwnerPatch(ownerDb, patch)` applies the patch and bumps a card's `updated`/`moved`. A comment is a history entry with `field:'comment'`, `old:null`, `new:text`.
- `extractRecipientChanges(projection, submittedDb)` turns a workspace the recipient saved into `{placements, edits}`. Deleting a linked record in the recipient's copy does nothing (it comes back), and edits to stubs are ignored.

### Revoke (`revokeEffects(recipientDb, share)`)
This returns `{db, removed}`. Every `sh.<shareId>.*` record leaves the recipient's workspace, along with the recipient's private edges to those records. References from their own items and cards to shared projects, items, labels or assignees are cleared. The share's chart is removed when it is empty. The store keeps the share row (with `revokedAt`) and its history, and deletes its placements. `linkedShareIds(db)` lists the share ids present in a workspace, so stale ones can be cleaned up.

### Re-sharing
Recipients cannot share: `createShare(env, user, ...)` only works for the environment's owner. Instead, `requestReshare(share, user, {toEmail, permission, note})` creates a pending request. The permission defaults to the recipient's own and cannot exceed it. `decideRequest(request, share, owner, approve, {permission})` lets the owner deny, or approve at an equal or lower permission. Approval returns a new share with the same scope and `via = request.id`.

### Private data never crosses
Projections are built only from the owner's data within the scope. The recipient's own nodes, edges and records never reach the owner: only whitelisted field edits on in-scope, non-stub records go back. The owner's private records (e.g. the "Private memo" note in the tests) are never projected and cannot be edited.

## Storage (`lib/shares.mjs`)
`shareStore({dir, db})`, where `db` is `async () => pg Pool | null` as for the other stores. Postgres tables (additive, `create … if not exists`; run with `migrate(pool)` or by appending `SCHEMA` to the server's migration list):
- `flygon_flow_shares`
- `flygon_flow_share_requests`
- `flygon_flow_share_placements`: primary key (share_id, env_id, record_id). A row with `record_id = '*'` means "attached to this env".
- `flygon_flow_share_history`

The file fallback uses `BACKUP_DIR/_shares.json`, `_share_requests.json`, `_share_placements.json` and `_share_history.json` (history keeps the newest 20,000 entries).

| Method | Use |
|---|---|
| `create(share)`, `get(id)`, `list({ownerEnv, ownerEmail, recipientEmail, includeRevoked})`, `setPermission(id, p)`, `revoke(id)` | shares |
| `addRequest(r)`, `getRequest(id)`, `requests({ownerEmail, requestedBy, shareId, status})`, `decide(r)` | re-share requests (`decide` only changes a pending one) |
| `attach(shareId, envId)`, `detach(shareId, envId)`, `attachedTo(envId)`, `envsFor(shareId)` | which recipient environments a share is placed in |
| `place(shareId, envId, [placement])`, `placements(shareId, envId)`, `dropPlacements(shareId, envId?)` | per-env layout |
| `record(entries)`, `history({envId, kind, recordId, shareId, limit})` | field history and comments, newest first |

## Decisions made where the brief was open
- **"Tag/label"** means a DevOps label id. Node tags are supported through an optional `node.tags[]` that nothing writes yet. Timeline "project tags" are covered by the project scope.
- **Person scope** accepts any node as the start, not only person nodes.
- **Project ↔ node** matching is by `project.entity` id only. `devops-core.entityProjects` also matches by name, but a name match could leak an unrelated project.
- **Re-share** permissions are capped at the requester's own.
- **Comments** are stored as history entries (`field:'comment'`); records gain no new field.
- **Edges**: only `percent` is editable on in-scope edges. Recipients cannot add or remove nodes or edges in the owner's data.
- **Placement**: a linked edge is drawn only when both of its ends are placed in the same chart (charts cannot hold cross-chart edges).
- **Card numbers**: a linked card may be renumbered by the recipient's `cleanDevops` when its number collides. That only affects the recipient's display, because `number` is not an editable field.
- **Two shares** from the same owner that both cover a node produce two linked copies (one per share id).

## Integrated (2026-10-29)
- **Server** (`server.mjs`): every route below is live under `/api/shares*` and `/api/share-requests*`, plus `POST /api/shares/preview {env, scope}` (the owner's live preview before sharing). Sharing the same scope with the same person again updates the permission instead of duplicating it. Scopes naming linked ids (`sh.…`) are refused: recipients ask the owner instead.
- **Linked copies are never stored** in the recipient's workspace. `PUT /api/workspace` strips every `sh.*` record (and `db.shares`) before saving; `GET` re-projects them from the owner's current data, for the environment's owner only. Saves and disk backups are stripped the same way. A revoked or detached share leaves nothing behind (dangling private edges are dropped when served; a share chart that holds the recipient's own cards stays as "Formerly shared").
- **Polling**: `GET /api/workspace` returns `shared` (share ids, permissions and the owners' revisions). The browser sends it back with `?since=<rev>&shared=<sig>`; `unchanged` is only answered when both match, so the owner's edits reach the recipient within a poll.
- **Write-back** happens after the recipient's own save succeeds (a 409 changes nothing in the owner's workspace); owner-side conflicts are retried.
- **Browser**: `public/share.js` (Share dialog with a live preview, linked-record helpers, History + comments, Settings › Sharing pane). `app.js` shows linked cards with a link badge (stubs dashed, with a ban badge), disables fields the permission does not allow, hides Kind/Delete/Duplicate on linked cards and refuses deleting them. Settings › Sharing lists shares by you (permission, revoke), pending requests (approve with a capped permission, deny) and shares with you (add to / remove from this environment, ask the owner to share it on). Settings › Environment has "Share this environment…".
- **CLI**: `node tools/env.mjs share --env <id> --person "<name>" --permission view|comment|edit --email <email> --to <url> [--dry-run]` (also `--node`, `--project`, `--label`, `--whole`), `shares --env <id>`, `unshare <share id>`. It prints the exact preview before sharing.
- **Tests**: `test/sharing-e2e.test.mjs` runs a real server with two synthetic users and the CLI (`npm test`).
- **Not yet**: Timeline and DevOps panels do not show a shared badge or lock fields on linked items/cards; the server still enforces the permission (refused edits come back on the next sync).

## INTEGRATION (for the main agent, as written by the worker)

### server.mjs
1. Imports and store:
   ```js
   const {shareStore,SCHEMA:SHARE_SCHEMA}=await import('./lib/shares.mjs');
   const core=await import('./lib/sharing-core.mjs');
   const shares=shareStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
   ```
   Add `...SHARE_SCHEMA` to the migration loop in `cloud()`: `for(const q of [...WORKSPACE_SCHEMA,...SESSION_SCHEMA,...INVITE_SCHEMA,...SHARE_SCHEMA])`.
2. Routes. Each one gets the same guards as `invitesApi`: `trusted(req)` and `requireUser`. Answer 404 for anything the user may not see. Owner checks compare `share.ownerEmail` (or the env owner) with `user.email` using `sameEmail`.
   - `GET  /api/shares?env=<ownerEnv>` (owner): `shares.list({ownerEnv})` plus `shares.requests({ownerEmail:user.email,status:'pending'})`.
   - `GET  /api/shares/incoming`: `shares.list({recipientEmail:user.email})`, each with `envsFor(id)` and the owner env's name.
   - `POST /api/shares {env, recipientEmail, scope, permission, name}`: `core.createShare(envs.get(env), user, body)`. A non-owner (including any recipient) gets 403. Then `shares.create(share)`.
   - `PATCH /api/shares/<id> {permission}` (owner): `shares.setPermission`.
   - `DELETE /api/shares/<id>` (owner): `shares.revoke(id)`. The recipient's copies are cleaned on their next GET (step 3).
   - `GET /api/shares/<id>/preview` (owner): `core.resolveScope(ownerWorkspace.data, share)`. This shows what the recipient will see before or after sharing, including stubs.
   - `POST /api/shares/<id>/attach {env}` and `DELETE /api/shares/<id>/attach?env=` (recipient, who must own `env`): `shares.attach` / `shares.detach`.
   - `POST /api/shares/<id>/requests {toEmail, permission, note}` (recipient): `core.requestReshare`, then `shares.addRequest`.
   - `POST /api/share-requests/<id> {approve, permission}` (owner): `core.decideRequest(await shares.getRequest(id), await shares.get(r.shareId), user, approve, b)`. On approval, call `shares.create(out.share)` first and then `shares.decide(out.request)`.
   - `POST /api/shares/<id>/comments {kind, id, comment}` (recipient): `core.applyRecipientEdit`, then `shares.record(history)`.
   - `GET /api/shares/history?env=&kind=&id=`: owner of `env`, or a recipient whose share covers that record (check with `resolveScope`). Returns `shares.history(...)`.
3. **GET /api/workspace** for env E, after the `canRead` check and before responding:
   ```js
   let data=w?.data;const attached=new Set(await shares.attachedTo(envId));
   for(const sid of core.linkedShareIds(data||{}))if(!attached.has(sid))data=core.revokeEffects(data,{id:sid}).db;
   for(const sid of attached){const s=await shares.get(sid);if(!s||s.revokedAt||!sameEmail(s.recipientEmail,user.email))continue;
     const home=await workspaces.get(s.ownerEnv);if(!home)continue;
     data=core.applyProjection(data,core.projectForRecipient(home.data,s,await shares.placements(sid,envId)))}
   ```
   The `since=<rev>` shortcut must not answer `unchanged` when shares are attached, because owner edits do not change the recipient's rev. Either skip the shortcut when `attached.size`, or send `sharedRev` (for example, the owners' revs joined) and have `sync.js` treat a changed `sharedRev` as new data.
4. **PUT /api/workspace** for env E, before `workspaces.put`: for each attached, active share of this user:
   ```js
   const p=core.projectForRecipient(home.data,s,await shares.placements(sid,envId));
   const {placements,edits}=core.extractRecipientChanges(p,body.data);
   await shares.place(sid,envId,placements);
   let patch=[],hist=[];for(const e of edits){const r=core.applyRecipientEdit(home.data,s,e,user);if(r.ok){patch.push(...r.ownerDbPatch);hist.push(...r.history)}}
   if(patch.length){const out=await workspaces.put(s.ownerEnv,{baseRev:home.rev,data:core.applyOwnerPatch(home.data,patch),by:user.email,owner:home.owner,visibility:home.visibility,name:home.name});
     if(out.ok)await shares.record(hist);/* on conflict: re-read home and retry once */}
   ```
   Refused edits (`view` share, stubs, out of scope) are dropped silently and come back on the next GET. Store the recipient's `body.data` as it is (the linked copies are a cache), because the next GET re-projects them. The 422 shrink check can count `sh.*` records; exclude them from `size()` if a revoke trips it.
5. Read-only flag: a recipient's GET for their own env stays writable. Per-record read-only state comes from `node.linked.readOnly`/`stub` and `linked.permission`.

### public/store.js (owned by the main agent)
`cleanProject`, `cleanItem` and `cleanDevops` drop unknown fields. To show "shared" badges on projects, items and cards, either keep a `linked` field in them, or derive it from the `sh.<shareId>.` id prefix (as the server already does). The nodes and edges `linked` field survives as it is.

### public/app.js
- Render nodes with `linked`: a small "shared" chip with the owner's email in the tooltip. Stubs (`linked.stub`) get a dashed outline and a lock, and the inspector shows them read-only, with a note that they are a co-owner stub.
- Inspector for a linked node:
  - `permission==='view'`: fields disabled.
  - `'comment'`: fields disabled, plus a comment box that posts to `/api/shares/<id>/comments`.
  - `'edit'`: only `name`/`notes` are editable. Delete and Kind are hidden.
  - All of them: a History list from `/api/shares/history`.
- Drag and resize of linked nodes works as usual (it is placement). Connecting a private node to a linked node is allowed. Starting a connection from or to a stub should be allowed only as a private edge (it is the recipient's own).
- On a node the user owns: "Share…" in the inspector header opens the share dialog with the scope preset to `{kind:'person', nodeId}` for people, or `{kind:'nodes', nodeIds:[id]}` otherwise. The dialog shows a live preview from `/api/shares/<id>/preview` (or runs `resolveScope` locally, since the core is pure ESM and can be imported in the browser from `/lib/…` if served, or copied), listing the shared nodes and the stubs.

### public/account.js
- Add a Settings tab `['sharing','Sharing']` to `TABS`, drawn by a new `sharingPane()`:
  - **Shared by me** (for the current env): recipient, scope summary, a permission `<select>` (PATCH) and Revoke (DELETE, with a confirm dialog).
  - **Pending requests**: Approve (with a permission select capped at the request's) and Deny.
  - **Shared with me**: owner, scope and permission; checkboxes for which of my environments it is placed in (attach/detach); "Ask to share with someone…" (a request; there is no direct share button).
- Settings › Environment: "Share this environment…" opens the same dialog with `{kind:'environment'}`. Project chips and DevOps labels can offer "Share…" with `{kind:'project'}` / `{kind:'label'}`.

### verify.mjs (main agent)
Run `node --test test/sharing.test.mjs` alongside it. For the routes, add end-to-end checks with two synthetic users: Owner shares Bo's chain with an invitee. The invitee sees Marsh and Campfire Studio with stubs for Kestrel Group and Quill, never Kestrel Services. Then test edit permission, a refused stub edit, and that a revoke empties the invitee's copy.
