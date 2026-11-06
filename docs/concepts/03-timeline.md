# Timeline

The timeline holds dated **items** that are tagged with **projects**.

- Item kinds: `feature`, `milestone`, `release`, `deadline`, `project`, `phase`, `event`.
- Status: `planned`, `active`, `risk`, `blocked`, `done`, `cancelled`. Priority (`high`, `medium`, `low`) is optional.
- `start` is `YYYY-MM-DD`, or empty for an unscheduled backlog item that appears only on the Board and List views. `end` is optional and never earlier than `start`.
- A feature can target a **release** by title. The release then lists the items that target it and how many of them are done.
- **Projects** are coloured tags `{id, name, color, entity}`. A project can sit under a chart entity or area through `entity`.
- Done and cancelled items turn grey and fade in every view, and the toolbar can hide them.
- Views: Timeline (Gantt), Calendar, List and Board (a kanban by status). Filtered items can be exported as `.ics`.
