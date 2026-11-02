# Sync

The server is the source of truth. Each environment's workspace is stored with a **revision** number, and the browser keeps an offline cache.

- `GET /api/workspace?env=<id>` returns `{rev, data}`. `PUT` with `{baseRev, data}` saves the workspace when `baseRev` is still current.
- If the workspace has moved on, the save gets `409` along with the newer copy. The client then merges per entity and field and retries. When both sides changed the same field, the local change wins. A deletion only applies to an entity the other side has not touched.
- A save that would drop most of a large workspace is refused with `422`, unless it is a deliberate load or replace.
- AgentFlow runners belong to the server: only `runners.report` changes them. A `PUT` keeps the runners as they last reported (their models and scheduled jobs), even when the saved copy is missing them or holds an older report, such as a tab still running an older version of Flow. The answer then includes `runnersKept: true`, and the client reads the workspace again.
- Every write first keeps the previous revision in the history. Postgres keeps it in `flygon_flow_workspace_history`; without Postgres it goes to `BACKUP_DIR/workspaces/history/`.
- Open tabs pick up remote changes every 20 seconds, and offline edits upload when the connection comes back.

API writes go through the same revision check, so an agent's change and a human's edit never silently overwrite each other.
