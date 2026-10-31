# Flygon Flow REST API v1

One registry of operations (`lib/registry.mjs`) drives the REST API, its OpenAPI document, the MCP
tools, the CLI and these docs (cards #43, #44). Each operation is plain data:

```js
{id:'cards.list', method:'GET', path:'/api/v1/envs/{env}/cards', scope:'read', tags:['cards'],
 summary, description, input:<JSON Schema>, output:<JSON Schema>, examples:[{title, input, output}]}
```

- `getOperation(id)` returns one; `invoke(id, input, ctx)` runs it. `ctx = {user:{id,email}, store, envCheck(envId, user, 'read'|'write')}`. Errors are thrown as `{status, code, message}`.
- `input` is **one flat object**: path parameters, query parameters and body fields together. MCP and the CLI pass that object to `invoke()`; REST splits it (path → URL, GET/DELETE → query string, POST/PATCH → JSON body).
- `invoke()` validates the input against its schema (`lib/json-schema.mjs`, a small checker for the subset the registry uses) and fills top-level defaults such as `limit`.
- `test/api-v1.test.mjs` fails if any operation lacks a description, an example, or an input/output schema, if an example does not fit its schemas, or if an operation is never exercised over HTTP.

## Using it

```
GET  /api/v1/envs                                   Authorization: Bearer flow_…
GET  /api/v1/envs/{env}/cards?column=doing&limit=20
POST /api/v1/envs/{env}/cards   {"title":"Build sign-up form","project":"Lantern","labels":["High"]}
POST /api/v1/envs/{env}/cards/12/move   {"column":"done","approve":true}
GET  /api/v1/openapi.json                           (public, OpenAPI 3.1)
```

| Area | Operations |
|---|---|
| envs | `envs.list`, `envs.get` |
| charts | `charts.list` (`{chart}` may be `active` everywhere) |
| nodes | `nodes.list`, `nodes.get`, `nodes.create`, `nodes.update`, `nodes.move` |
| edges | `edges.list`, `edges.create`, `edges.delete` |
| projects | `projects.list`, `projects.create`, `projects.update` |
| timeline | `items.list`, `items.get`, `items.create`, `items.update` |
| cards | `cards.list`, `cards.get`, `cards.create`, `cards.update`, `cards.move` |
| labels | `labels.list`, `labels.create` |
| search | `search` |

The full list with schemas and examples is `GET /api/v1/openapi.json` (or `openapi()` from `lib/api-v1.mjs`).

- **Auth.** `Authorization: Bearer flow_…` is resolved by the `authenticate(req)` hook (the API-keys module) to `{user, scopes}`. Scopes rank `read` < `write` < `admin`; an operation needs its `scope` or higher (403 `insufficient_scope`). A request **without** an Authorization header may use the browser session through `userFor(req)` (read + write). A wrong key never falls back to the session.
- **Visibility.** Environments you cannot see are 404, as in the rest of the app. Public ones are readable; only the owner writes.
- **Responses.** JSON only. Lists return `{items, nextCursor, rev}`; pass `limit` (1-200, default 50) and `cursor` (the previous `nextCursor`). Single objects come back as `{rev, card}` / `{rev, node}` …; creates answer 201. `rev` is the workspace revision after the call.
- **Errors.** `{error, code}` (plus `details` for invalid input). Codes include `unauthorized`, `invalid_token`, `insufficient_scope`, `not_found`, `*_not_found`, `invalid_input`, `invalid_json`, `unsupported_media_type` (POST/PATCH must be `application/json`), `too_large` (1 MB), `method_not_allowed`, `rate_limited` (429 with `Retry-After`), `conflict`, `unknown_project|label|person|item|release|entity`, and the gate codes below. A 500 never shows internals.
- **References** accept an id or a name (case-insensitive): projects, labels, people (assignees, `developer`), the entity a project sits under, timeline items and releases (by title). Cards are addressed by number (`12`, `#12`) or id. Unknown references are 400, not silently dropped.
- **Board gates** (`public/devops-core.js` `gateFor`): `cards.move` into Done needs `confirm: true`, or `approve: true` from UAT (the Approve button); out of Done needs `confirm: true`; into Doing without a developer needs `developer` (assigned as developer) or `confirm: true` to leave it unassigned. Otherwise 409 with code `confirm_done`, `confirm_reopen` or `pick_developer` and a `gate` field. `cards.update` cannot change the column. Creating a card straight into any column is allowed (as `+` on a column is in the app).

## How writes work

Every write reads the workspace from the store, changes a copy, cleans it with the client's cleaners (`public/devops-core.js` `cleanDevops`; `lib/cleaners.mjs` for `validChart`, `cleanProject`, `cleanItem`), checks every chart is still valid, and calls `store.put()` with the revision it started from. If another save landed in between, the change is re-applied to the newer copy (up to 5 tries, then 409 `conflict`). The previous revision goes to the workspace history like any save. Name and visibility are passed through unchanged. The open app picks up API changes through its normal 20-second sync.

`lib/cleaners.mjs` is a verbatim copy of the pure functions in `public/store.js` (which cannot be imported in Node: it touches the DOM and localStorage on load). The test evaluates the originals from `store.js` and fails if the copies drift.

There are no deletes except `edges.delete`; nodes, cards, items and projects are never removed by the API.

## Decisions taken without asking (safest option)

- `lib/registry.mjs` is built here to the shared contract; handlers live in a private map so `operations` stays plain, JSON-serialisable data for the MCP, CLI and docs workers.
- `envs.list` lists environments the caller **owns** (`store.owned`), matching `/api/environments`; public environments are reachable by id.
- The rate-limit hook is optional; `memoryRateLimit({perMinute})` is a per-user in-memory bucket (writes cost 2). It is per process.
- `/api/v1/openapi.json` is public (no data in it) and sends `Access-Control-Allow-Origin: *`; nothing else sends CORS headers, so the session path cannot be used cross-site (and POST/PATCH require `application/json`, which forces a preflight).
- In local relay mode (`FLOW_SYNC_URL`), the API acts on the local workspace copy; it does not relay.

## Integrated (2026-10-29)
Mounted in `server.mjs`: `/api/v1` (REST + `/api/v1/openapi.json`), `/api/keys` (Settings › API keys) and `/mcp`. Both `/api/v1` and `/mcp` take `Authorization: Bearer flow_…` keys or the owner token (`FLOW_SYNC_TOKEN`); the browser session also works for `/api/v1` from the app's own origin. A key only reaches the environment it was made for (`*` = all the owner's) and only its scopes; writes need `write`. The API works on each environment's own stored data, so linked copies of shares (docs/sharing.md) never appear through it. End-to-end checks: `test/sharing-e2e.test.mjs` (API keys, /api/v1 and /mcp on the real server).

## INTEGRATION (for the main agent; server.mjs is not touched here)

1. In `server.mjs`, after `const workspaces=workspaceStore(...)` (around line 198):

```js
const {apiV1,envCheckFor,memoryRateLimit}=await import('./lib/api-v1.mjs');
const apiLimit=memoryRateLimit({perMinute:120});
// API keys (flow_…): replace with the API-keys module's authenticate(req) -> {user, scopes} | null.
// Until it lands every Bearer key is refused (401) and only the browser session works.
const apiAuthenticate=async req=>null;
```

2. In `http.createServer(async(req,res)=>{`, as the **first** line (before `/api/auth/`; API keys are not tied to the page origin, so it must not sit behind `trusted()`):

```js
  if(req.url.startsWith('/api/v1')&&await apiV1(req,res,{authenticate:apiAuthenticate,userFor:r=>trusted(r)?auth.userFor(r):null,store:workspaces,envCheck:envCheckFor(workspaces),rateLimit:apiLimit}))return;
```

   `userFor` is gated by `trusted()` so the session is only used from the app's own origin. To also accept `FLOW_SYNC_TOKEN` as an owner key, use `authenticate:async r=>(await apiAuthenticate(r))||tokenUser(r)` (a plain user means all scopes).

3. Optional: `envCheckFor(workspaces)` mirrors `canRead`/`canWrite` from the stored workspace (owner, members, public). To use the environments registry instead, pass `envCheck:(id,user,mode)=>{const e=envs.get(id);return e&&e.id===id&&(mode==='write'?canWrite(e,user):canRead(e,user))}` — note `envs.get` falls back to the default environment for bad ids, hence the `e.id===id` check.

4. `npm run check`: add `&& node --check lib/api-v1.mjs && node --check lib/registry.mjs && node --check lib/json-schema.mjs && node --check lib/cleaners.mjs`.

5. Tests: `npm run test:api` (`node --test test/api-v1.test.mjs`). Later, consider moving `validChart`/`cleanProject`/`cleanItem` from `public/store.js` into a DOM-free `public/store-core.js` that both `store.js` and `lib/cleaners.mjs` import, then delete the copies and the parity test.
