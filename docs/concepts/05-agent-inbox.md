# Agent inbox

Agents can add or update projects, labels, timeline items and cards by dropping a JSON **patch** into the inbox. The open app picks the patch up within about 20 seconds and merges it as **one undoable step**.

```json
{"source": "Claude", "env": "acme-hq", "ops": [
  {"op": "upsertProject", "name": "Launch", "color": "#7cb980"},
  {"op": "upsertCard", "title": "Write release notes", "project": "Launch", "column": "requests", "labels": ["High"]},
  {"op": "patchCard", "number": 12, "column": "uat"}
]}
```

- Ops: `upsertProject`, `upsertLabel`, `upsertItem`, `upsertCard`, `patchCard`.
- References use names: a project by name, an assignee by the name of a person card, an item or release by title, and a label by id or name.
- **Safety:** ops only add or update and never delete. Lists only grow. A field a human changed after the patch was written is kept, and the merge notes it. Applying the same patch again changes nothing.
- CLI: `node tools/inbox.mjs add|check|list|requeue`.

The token API is the direct way to make changes. The inbox suits agents that cannot hold a token, or changes a human should be able to undo in one click.
