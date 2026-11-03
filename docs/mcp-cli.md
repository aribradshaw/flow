# MCP server and `flow` CLI

Agents and scripts reach Flygon Flow in three ways. All three use the same operations registry
(`lib/registry.mjs`) and the same API keys (`Authorization: Bearer flow_…`), and each call runs as the
key's owner, with the same environment rules as the app (private environments answer 404).

| Way | Where | For |
| --- | --- | --- |
| REST | `https://flow.example.com/api/v1/…`, OpenAPI at `/api/v1/openapi.json` | anything that speaks HTTP |
| MCP over Streamable HTTP | `https://flow.example.com/mcp` | Claude Code, Claude Desktop, Codex, Cursor, T3 |
| `flow` CLI, and `flow mcp` (stdio MCP) | your machine | shells, scripts, clients that only do stdio |

## Tools

There is one MCP tool per registry operation. The tool name is the operation id with dots turned into
underscores (`cards.list` becomes `cards_list`). The description is the operation's summary, then its
description, then its examples. `inputSchema` is the operation's `input`, and `outputSchema` is its
`output` when that is an object. Read-only operations (GET) are annotated `readOnlyHint`, and DELETEs
are annotated `destructiveHint`.

An operation that fails (`{status, code, message}`, e.g. `404 not_found`) comes back as a normal tool
result with `isError: true`, so the model can read the error and fix its call. Protocol mistakes
(unknown tool, bad JSON-RPC) are JSON-RPC errors.

Resources:
- `flow://docs/mcp-cli`: this guide.
- `flow://openapi.json`: the OpenAPI document.

## Get an API key

Create a key wherever the API-key work puts it in the app (that work is separate from this branch). Keys start
with `flow_`. Anyone who has your key can act as you, so treat it like a password. Revoke a key in the
same place.

## Claude Code

```sh
claude mcp add --transport http flow https://flow.example.com/mcp --header "Authorization: Bearer <key>"
```

Add `--scope user` to make it available in every project. Run `/mcp` inside Claude Code to check that
`flow` is connected.

Without network MCP, use the local stdio server, which proxies to REST with the key from `flow login`:

```sh
claude mcp add flow -- npx -y github:aribradshaw/flow mcp
```

## Claude Desktop

Claude Desktop starts local (stdio) servers from `claude_desktop_config.json` (Settings › Developer ›
Edit Config):

```json
{
  "mcpServers": {
    "flow": {"command": "npx", "args": ["-y", "github:aribradshaw/flow", "mcp"]}
  }
}
```

Run `flow login` once first (see the CLI section below), or pass the settings in the server's `env`:
`"env": {"FLOW_URL": "https://flow.example.com", "FLOW_API_KEY": "<key>", "FLOW_ENV": "default-workspace"}`.
To use the remote server directly, add it under Settings › Connectors as a custom connector with the
URL `https://flow.example.com/mcp`. That only works where the connector form lets you set an
Authorization header, because this server takes API keys, not OAuth.

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.flow]
url = "https://flow.example.com/mcp"
bearer_token_env_var = "FLOW_API_KEY"   # export FLOW_API_KEY=flow_…
```

Or use stdio: `command = "npx"`, `args = ["-y", "github:aribradshaw/flow", "mcp"]`.

## Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "flow": {"url": "https://flow.example.com/mcp", "headers": {"Authorization": "Bearer ${env:FLOW_API_KEY}"}}
  }
}
```

## T3 Code

T3 runs Claude Code and Codex, so the setup for those (above) applies inside T3 threads too. On a
machine where the agents run (for example a remote dev box), use the same `claude mcp add …` or
`~/.codex/config.toml` entry. Keep the key in that machine's environment (`FLOW_API_KEY`) rather than in
a project file.

## The `flow` CLI

```sh
npx github:aribradshaw/flow login --url https://flow.example.com --key <key>
# or, inside a checkout:  npm link   (then just `flow …`)   or   node tools/flow.mjs …
flow login --url https://flow.example.com --key-stdin < keyfile   # keeps the key out of shell history
flow env use default-workspace          # the default --env
flow cards list --project Lantern
flow cards list --env default-workspace --project Lantern --json
flow cards move 42 --column doing
flow cards --help                  # the commands in a group;  flow cards move --help: its flags
flow refresh                       # refetch the API description
```

- **Commands are generated** from the server's OpenAPI document. Operation `a.b.c` becomes
  `flow a b c`. Flags are the input fields, in kebab-case (`--due-date` for `dueDate`). Values are
  converted to the schema's type: integers, numbers, booleans (`--urgent`, `--no-urgent`,
  `--urgent false`), arrays (`--labels A,B` or repeated flags) and objects (JSON).
- Positional arguments fill the path parameters, then the required fields, in order. `env` always
  comes from `--env` or `flow env use`. `--input '<json>'` or `--input @file.json` supplies the whole
  input.
- **Output** is a table by default (lists as columns, objects as `key value` rows). `--json` prints
  the raw answer. Errors go to stderr (`Error: 404 not_found: …`) and exit with code 1.
- **Config** is `~/.config/flygon-flow/config.json` (`$XDG_CONFIG_HOME` is honoured), written with
  mode 0600 in a 0700 folder: `{url, key, env}`. `FLOW_URL`, `FLOW_API_KEY` and `FLOW_ENV` override it.
  The OpenAPI cache sits beside it (`openapi-cache.json`, refreshed after an hour (`FLOW_SPEC_TTL`
  seconds), or by `flow refresh`). When the server can't be reached, the cached copy is used. The key
  is never printed. `flow logout` removes it.
- **Existing tools**: `flow inbox …` runs `tools/inbox.mjs` and `flow workspace …` runs `tools/env.mjs`,
  with the arguments passed through unchanged. Built-in
  commands (`login`, `logout`, `env`, `refresh`, `mcp`, `help`, `inbox`, `workspace`) take
  precedence over generated ones.
- `flow mcp` is a stdio MCP server (newline-delimited JSON-RPC on stdin/stdout, logs on stderr). It
  offers the same tools, built from the cached OpenAPI document, and forwards each call to REST. With a
  default environment set, `env` becomes optional in its tools.

`npx flygon-flow` resolves only once the package is on npm. `package.json` is `"private": true` today,
so use `npx github:aribradshaw/flow …` or a checkout until it is published.

## REST convention (shared by the CLI, `flow mcp` and the fixture tests)

Each operation is at its `method` + `path`. `{name}` placeholders take the input field of the same
name. The remaining fields go in the query string for GET and DELETE (arrays as repeated keys) and in
a JSON body for POST, PATCH and PUT. Errors are JSON `{error: {code, message}}` with the HTTP status;
`{error: "message"}` is accepted too. The OpenAPI document may carry the registry entry in
`x-flow-operation` (`lib/api-spec.mjs` `openapiFor` does). Without it, the CLI rebuilds inputs from
`parameters` and `requestBody`, and turns underscores in `operationId` into dots.

## Design notes

- **No dependencies.** The MCP server is about 130 lines (`lib/mcp.mjs`). It handles `initialize`
  (negotiating 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05), `ping`, `tools/list`, `tools/call`,
  `resources/list`, `resources/read` and `resources/templates/list`. Batches are accepted. The official
  `@modelcontextprotocol/sdk` would add a dependency tree (zod, express-style transports, session
  management) to a server that otherwise has two dependencies, and it would not save meaningful code
  here, so it is not used.
- **Stateless Streamable HTTP.** POST gets a JSON reply (never SSE), notifications get 202, and GET or
  DELETE get 405. There is no `Mcp-Session-Id`, because nothing is kept between requests. That suits
  several Railway instances and restarts during a deploy. Every request is authenticated.
- **Security.** The key is checked before anything else, including `initialize`. Requests without a
  key, with a wrong key, or where `authenticate` throws get 401 with `WWW-Authenticate: Bearer`. A
  request with an `Origin` header is refused (403) unless that origin is in `origins` or on the same
  host, which protects against DNS rebinding. Desktop MCP clients send no Origin. Bodies are capped at
  1 MB. An unsupported `MCP-Protocol-Version` gets 400. Authorization uses API keys, not MCP's OAuth
  flow: clients pass the key as a header.
- **Choices made where the contract was silent** (safest option): the server calls
  `authenticate(token, req)` with the bearer token already extracted, and it returns a user or null. It
  calls tools as `invoke(id, input, ctx)`, where `ctx` is the result of the optional
  `ctx(user, req)` hook (default `{user}`), so server.mjs supplies `store` and `envCheck`. The CLI has no
  default server URL, so nothing points anywhere until `flow login`.

## Integrated (2026-10-29)
Mounted in `server.mjs`: `/api/v1` (REST + `/api/v1/openapi.json`), `/api/keys` (Settings › API keys) and `/mcp`. Both `/api/v1` and `/mcp` take `Authorization: Bearer flow_…` keys or the owner token (`FLOW_SYNC_TOKEN`); the browser session also works for `/api/v1` from the app's own origin. A key only reaches the environment it was made for (`*` = all the owner's) and only its scopes; writes need `write`. The API works on each environment's own stored data, so linked copies of shares (docs/sharing.md) never appear through it. End-to-end checks: `test/sharing-e2e.test.mjs` (API keys, /api/v1 and /mcp on the real server).

## INTEGRATION (for the main agent)

1. **Mount `/mcp` in server.mjs**, next to the other handlers, before the static-file fallback. It
   authenticates with API keys itself, so do not put `trusted(req)` in front of it.

   ```js
   const {mcpHandler}=await import('./lib/mcp.mjs');
   const registryMod=await import('./lib/registry.mjs');
   async function mcpRoute(req,res){
     if(new URL(req.url,'http://x').pathname!=='/mcp')return false;
     return mcpHandler(req,res,{
       operations:registryMod.operations,
       invoke:registryMod.invoke,
       authenticate:token=>apiKeys.userFor(token),          // the API-key store: {id,email} | null
       ctx:user=>({user,store:workspaces,envCheck:(envId,u,mode)=>/* canRead/canWrite on envs.get(envId) */0}),
       origins:auth.appOrigin?[auth.appOrigin]:[],
     });
   }
   // in createServer: …||await mcpRoute(req,res)||…
   ```

   Pass `openapi: () => doc` if the registry worker already builds the OpenAPI document, so `/mcp` and
   `/api/v1/openapi.json` serve the same one. Otherwise `lib/api-spec.mjs` `openapiFor(operations, {url})`
   can serve `/api/v1/openapi.json`; the CLI reads its `x-flow-operation` extension.
2. **REST shape**: check that the `/api/v1` router follows the REST convention above (path
   placeholders, then query for GET/DELETE and JSON body for POST/PATCH; errors
   `{error:{code,message}}`). If it differs, change `requestFor` in `lib/api-spec.mjs`, the only place
   that encodes the convention.
3. **package.json** already has `"bin": {"flow": "tools/flow.mjs"}` and `"test:mcp"` on this branch.
   Optionally add `node --check lib/mcp.mjs && node --check lib/api-spec.mjs && node --check tools/flow.mjs`
   to `check`. To make `npx flygon-flow` work, publish the package (drop `"private"`, add `"files"`) or
   keep the `github:` form.
4. **Tests**: `npm run test:mcp` (fixture registry and loopback server only). verify.mjs needs no change.
5. Optionally add a short "MCP and CLI" section to README.md that links to this file.
