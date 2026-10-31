# API keys (card #45)

Settings › API keys lets each user create keys for **one of their environments** (or all of them) so
scripts, the CLI and AI agents (MCP) can use Flygon Flow without a browser session.

| Piece | File |
| --- | --- |
| Store, authentication, scopes, rate limit, audit | `lib/apikeys.mjs` |
| `GET/POST /api/keys`, `DELETE /api/keys/:id` | `lib/apikeys-routes.mjs` |
| Settings tab (`renderApiKeysTab(container)`) | `public/apikeys.js`, `public/apikeys.css` |
| Tests (files + embedded Postgres) | `test/apikeys.test.mjs` |

## Model

- **Format:** `flow_live_<40 base62>` on the public deploy, `flow_test_<40 base62>` everywhere else
  (local mode, verify, tests). About 238 bits of randomness.
- **At rest:** only the SHA-256 hex of the full key and a display prefix (`flow_live_` + 8 characters).
  The full key is returned once, by `POST /api/keys`, and never again. No route returns the hash.
- **Record:** `{id:'key_<uuid>', owner, name, env:'<env id>'|'*', scopes, mode, prefix, createdAt,
  expiresAt|null, lastUsedAt, lastUsedIp, revokedAt}`. Revoking marks the record; nothing is deleted.
- **Scopes:** `read`, `write`, `admin`. `admin` implies `write`, and `write` implies `read` (stored
  normalised, e.g. `['read','write']`). The UI offers three levels: Read · Read & write · Admin.
- **Expiry:** 30 days, 90 days (default), 1 year, or never (`expiresInDays`: 1 to 365, or `null`).
- **Storage:** Postgres when the pool exists, otherwise `BACKUP_DIR/_apikeys.json` and
  `_apikeys-audit.json`. The tables are additive and idempotent: `flygon_flow_api_keys` (indexed on
  `prefix` and `lower(owner_email)`) and `flygon_flow_api_key_audit`. The store runs `SCHEMA` itself
  once per pool (`migrate`). It is also safe to add it to the list in `cloud()`.
- **Fail closed:** if `db()` throws (Postgres configured but down), the store throws too. It never
  falls back to the JSON files, so a key cannot be created in, or accepted from, the wrong store.
  `requireApiKey` answers 503 in that case.
- **Authentication** (`authenticateApiKey(req, store)`): reads `Authorization: Bearer flow_…`, looks
  up candidates by prefix, compares SHA-256 digests with `timingSafeEqual`, refuses revoked or expired
  keys, takes a rate-limit token, then records the use (`last_used_at`/`ip`, at most once a minute
  per key). It returns one of:
  - `null`: no key, an unknown or wrong one, expired, or revoked.
  - `{limited:true, retryAfter, keyId}`: valid but over the limit. This has **no `user`**.
  - `{user:{email}, envs:['<id>'|'*'], scopes, keyId, name, mode, remaining}`.
- **`requireApiKey(req, res, store, {scope, env})`:** use this in handlers. It authenticates and checks
  the scope and environment, and it writes the 401 / 403 / 429 (`Retry-After`) / 503 response itself.
  It returns the auth object, or `null` once it has responded. `allows(auth, scope, env)` is the
  bare check.
- **Rate limit:** an in-memory token bucket per key, allowing bursts of 60 and refilling at 2 a second.
  `configureRateLimit({capacity, refill, now})` changes those values. `useRateLimiter(fn)` replaces
  the limiter (`fn(keyId) -> {ok, retryAfter, remaining}`), for example with a shared one if Flow
  ever runs several instances. `useRateLimiter(null)` restores the default.
- **Audit:** `create`, `revoke`, `use` (throttled like last-used), `denied-revoked`, `denied-expired`
  and `limited`, each with `{keyId, op, at, ip}`. Entries older than `AUDIT_DAYS` (90) are pruned,
  checked at most hourly. The file backend also keeps at most 20,000 entries. `store.auditLog(keyId?)`
  returns the newest 200.
- **Client IP:** the first `X-Forwarded-For` entry, otherwise the socket address. It is used for the
  audit and "last used" display only, never for access decisions, since behind Railway's proxy the
  header can be set by the client.
- **Limits:** at most 50 active keys per user. Names are 1 to 80 characters.

## Decisions made without asking (safest option)

- **Key management needs the browser session.** `/api/keys` uses `userFor` plus `trusted`, so a key
  (even an `admin` one) cannot create or revoke keys. Requests with `user.token` (FLOW_SYNC_TOKEN)
  are refused too.
- **A key is an upper bound, not a grant.** A key's `env`/`*` limits what it may touch. Handlers must
  still apply `canRead`/`canWrite` (or the workspace owner check) with `{email: auth.user.email}`, so
  a key stops working for an environment its owner no longer owns, or that was archived.
- **`*` means "all environments the owner can access at request time"**, not a fixed list.
- **Snippets use placeholders only**: `https://<your-flow-host>`, `flow_live_<your-key>` and
  `<environment-id>`. The real key never appears in them, so screenshots of the tab are safe. The new
  key's box clears its input before it animates away.
- **Assumed paths:** `/api/v1/...` for the REST API, `/mcp` (streamable HTTP) for MCP, and `flow ...`
  for the CLI command. They live in one array, `SNIPPETS` in `public/apikeys.js`. Adjust them there
  if the /api/v1, MCP or CLI work picks different names.

## Integrated (2026-10-29)
Mounted in `server.mjs`: `/api/v1` (REST + `/api/v1/openapi.json`), `/api/keys` (Settings › API keys) and `/mcp`. Both `/api/v1` and `/mcp` take `Authorization: Bearer flow_…` keys or the owner token (`FLOW_SYNC_TOKEN`); the browser session also works for `/api/v1` from the app's own origin. A key only reaches the environment it was made for (`*` = all the owner's) and only its scopes; writes need `write`. The API works on each environment's own stored data, so linked copies of shares (docs/sharing.md) never appear through it. End-to-end checks: `test/sharing-e2e.test.mjs` (API keys, /api/v1 and /mcp on the real server).

## INTEGRATION (for the main agent)

### 1. server.mjs: create the store and mount the routes (after `const workspaces=…` and `trusted`)

```js
const {apiKeyStore,requireApiKey,allows,SCHEMA:APIKEY_SCHEMA}=await import('./lib/apikeys.mjs');
const {apiKeyRoutes}=await import('./lib/apikeys-routes.mjs');
// 'live' keys only on the public deploy; local mode and verify make flow_test_ keys.
const apiKeys=apiKeyStore({dir:fileURLToPath(backupRoot),db:()=>cloud(),mode:auth.mode==='opid'&&!VERIFY?'live':'test'});
// Environments a user may give a key to: the ones they own (the owner also always has Default workspace).
const keyEnvs=async u=>[...new Set([...(await workspaces.owned(u.email)).map(w=>w.envId),...(sameEmail(u.email,auth.OWNER_EMAIL)?[DEFAULT_ENV.id]:[])])];
const keysApi=apiKeyRoutes({userFor:auth.userFor,store:apiKeys,readJson,trusted,envsFor:keyEnvs});
```

- Pass `db:()=>cloud()` **without** `.catch(()=>null)`, so a database error fails closed (see above).
  `cloud()` already returns `null` when `DATABASE_URL` is unset or under verify.
- Optionally add `...APIKEY_SCHEMA` to the `for(const q of [...WORKSPACE_SCHEMA,...])` list in
  `cloud()`. The store migrates on its own either way.
- Add `await keysApi(req,res)` to the handler chain in `http.createServer`, for example after
  `invitesApi`.
- `trusted` is server.mjs's own function. Pass it so the app origin (`OPID_APP_ORIGIN`) works. Without
  it the router falls back to a loopback-only check.

### 2. /api/v1: call requireApiKey in each handler

```js
// e.g. GET /api/v1/workspace?env=<id>
const envId=u.searchParams.get('env');
const a=await requireApiKey(req,res,apiKeys,{scope:req.method==='GET'?'read':'write',env:envId});
if(!a)return true;                       // 401 / 403 / 429 / 503 already sent
const user={id:'key:'+a.keyId,email:a.user.email,apiKey:a.keyId};
// The key's environment is only an upper bound: still enforce ownership as for a browser user.
const w=await workspaces.get(envId);
if(!w||w.archivedAt||!sameEmail(w.owner,user.email)){json(res,404,{error:'Not found'});return true}
```

- `/api/v1` is Bearer-only. Do not read cookies there and do not require `trusted()`, because CLI and
  MCP clients have no Origin. Do not add CORS headers; browsers are not the intended clients.
- Map operations to scopes: GET → `read`; PUT/PATCH/POST of data → `write`; destructive or
  settings-level operations (archive, visibility, history restore) → `admin`.
- Keep `/api/workspace`'s `tokenUser` (FLOW_SYNC_TOKEN) as it is. A `flow_…` Bearer there is still
  refused as "Invalid token", which is fine: keys are for `/api/v1`.

### 3. MCP

- **HTTP MCP at `/mcp`:** on every request run
  `const a=await requireApiKey(req,res,apiKeys,{scope:'read'})`, then check
  `allows(a,'write',envId)` (and `'admin'` where relevant) per tool call before mutating. Tool
  listings can include only tools the key's scopes allow.
- **A stdio MCP or the CLI** talks to `/api/v1` with `Authorization: Bearer $FLOW_API_KEY`, so it
  gets the same checks for free.
- Claude Code: `claude mcp add --transport http flygon-flow "https://<host>/mcp" --header "Authorization: Bearer <key>"`.
  Codex (`~/.codex/config.toml`): `[mcp_servers.flygon-flow]` with `url = "https://<host>/mcp"` and
  `bearer_token_env_var = "FLOW_API_KEY"`.

### 4. public/account.js: add the tab

```js
import {renderApiKeysTab} from './apikeys.js';
const TABS=[['account','Account'],['environment','Environment'],['apikeys','API keys'],['shortcuts','Shortcuts'],['devlog','DevLog']];
// in drawTab(), next to the devlog branch:
if(tab==='devlog'){panel.innerHTML='<div class="hp-log"></div>';await mountDevlog(panel.firstChild)}
else if(tab==='apikeys')await renderApiKeysTab(panel);
else panel.innerHTML=...
```

- The module links `/apikeys.css` itself and binds its listeners to its own content, so redrawing the
  tab is safe. It deliberately uses **no `role=tab`** elements: account.js's dialog click and keydown
  handlers treat any `[role=tab]` as a Settings tab. The snippet switcher and the scope picker are
  `role=radiogroup`.
- It reads `GET /api/environments` to name environments in the picker and the list.
- It uses `ask()` from `modal.js` for the revoke confirm, and `enter`, `popIn` and `busy` from
  `motion.js`. Rows, the new-key box and errors grow in and collapse out (height and opacity); all of
  that is off under `prefers-reduced-motion`.

### 5. package.json, README, verify

- `package.json` was left untouched to avoid merge conflicts with the other workers. Suggested
  additions: `"test":"node --test \"test/**/*.test.mjs\""`, plus
  `&& node --check lib/apikeys.mjs && node --check lib/apikeys-routes.mjs && node --check public/apikeys.js`
  appended to `check`.
- README: under "Settings, shortcuts and preferences", add *API keys* to the list of tabs and link
  this file.
- verify.mjs (yours) could add a browser check: open Settings › API keys, create a key, check that the
  reveal box shows `flow_test_…`, revoke it, and check that the row fades.

## Tests

`node --test test/apikeys.test.mjs`. This covers create, authenticate, scopes, expiry, revoke and
ownership, throttled last-used, the rate limit and its hook, the 401/403/429/503 answers, hashes-only
at rest (files and Postgres), audit retention, and the HTTP routes (validation, 415, same-origin, DNS
rebinding, a key cannot manage keys, hashes never returned). The same suite then runs on a throwaway
`embedded-postgres` instance on a random port 55400–55899, after running the migrations twice.
