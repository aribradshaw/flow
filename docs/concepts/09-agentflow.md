# AgentFlow

AgentFlow is an org chart for agentic work. You lay out the agents that do work for a business, say what each one is for and what it takes in and produces, chain them into workflows, and tie them to the projects, DevOps cards and deadlines they own.

Flow stores the design. It does not run agents itself. A runner of your choice (an agent harness, a home server, a cron job) reads an agent's or workflow's **brief** through the API or MCP and does the work, then reports back on the DevOps cards like anyone else.

## Agents

An agent has `name, kind, title, status, live, reportsTo, supervisor, purpose, instructions, runtime, model, inputs[], outputs[], tools[]` and links `projects[], cards[], items[]`.

- `kind`: `agent` (an AI agent), `human` or `team` (a group heading in the org).
- `status`: `draft`, `active`, `paused` or `retired`.
- `reportsTo` is another agent. Together these form the AgentFlow org chart. An agent cannot report to itself or to anyone below it (`reports_loop`). A saved loop is broken when the workspace loads.
- `supervisor` is a person card on one of your mind maps: the human accountable for the agent.
- `inputs`, `outputs` and `tools` are short text lists, such as "A card in Doing" or "Pull request linked on the card".
- `instructions` holds the system prompt or runbook. `runtime` says where it runs (a runner's name) and `model` which model, if any.
- `live` is the switch runners obey. It is off for every new agent, and a runner leaves an agent that is not live alone, whatever its status. Turn it on in the agent's side panel, or with `agents.update` (`live: true`). The org card then shows a **Live** badge, in amber when its runner would skip it (no runner or model picked, or a model its runner did not report).
- Deleting an agent moves its direct reports up to its manager, and its workflow steps become unassigned.

## Runners

A runner is a machine or service that runs agents, such as a home server with agent harnesses installed. It tells Flow what it can run with `runners.report`: its name and the models it offers, each with an id and a label. `runners.list` returns them. In an agent's side panel, **Runs on** suggests the reported runners and **Model** that runner's models, and every org card shows where the agent runs and on which model. Reporting the same models again saves nothing, so a runner can report on every pass.

```sh
flow runners report --input '{"runner":"Home server","models":[{"id":"claudeAgent:claude-sonnet-5-5","label":"Claude · Sonnet 5.5"}]}'
```

`tools/agent-runner.mjs` is a reference runner for [T3 Code](https://t3.codes): it reports the providers and models signed in on its machine, and for each live agent whose `runtime` is its name, starts a T3 thread on the agent's model for the top card in its queue, then moves the card to UAT when the thread finishes. It starts in dry-run mode, so it only prints what it would do until you turn that off. See the comment at the top of the file for its settings.

## Workflows

A workflow has `name, description, status, trigger, schedule, steps[{agent, action, output}]` and the same links. `trigger` is `manual`, `schedule` or `event`. `schedule` says when or on what in plain words, e.g. "Weekdays at 09:00" or "A card enters UAT". Steps run in order, and each one names the agent that handles it.

## Delegation and the work queue

Delegating a DevOps card to an agent puts it in that agent's **work queue**. The person on the card stays accountable; the agent does the work. Delegate in the card's **Delegated to** picker, from the agent's side panel (Cards), or with `cards.update` (`agents: ["Researcher"]`; `[]` clears it). Cards show their agents as square badges, and the board's **Agents** filter shows one agent's cards. A card can be delegated to several agents.

`agents.work` returns everything a runner needs in one call: the agent, its brief, and its queue, which holds the open delegated cards. The queue is ordered Doing, Requests / Sprinted, Blocked, UAT, then the backlogs, and by soonest due date and `#number` within each. `columns: ["doing","requests"]` keeps only the cards it can act on now. A runner loop on any machine looks like this:

1. `agents.work` with the agent's name and `columns: ["doing","requests"]`.
2. Take the first card. Move it to Doing with `cards.move` if it is new.
3. Do the work, following the brief and the card's description and checklist.
4. Report back with `cards.update` (tick the checklist, add the pull request under `links`), then `cards.move` to `uat` for a human to approve.

A runner only works agents with `live` on: `agents.list` with `live: true` gives it that list.

```sh
curl -H "Authorization: Bearer $FLOW_TOKEN" "$FLOW_URL/api/v1/envs/$FLOW_ENV/agents/Researcher/work?columns=doing,requests"
flow agents work --input '{"agent":"Researcher","columns":["doing","requests"]}'   # or the agents_work MCP tool
```

The runner only calls out to Flow and never needs to be reachable itself, so it works from a home server behind a router.

## Briefs

`agents.get` and `workflows.get` return a `brief`: Markdown with everything a runner needs. That covers purpose, reporting line, inputs, outputs, tools, runtime, workflow steps, linked projects, cards (open ones from linked projects too) and deadlines, and the instructions. In the app, **Copy brief** in the side panel puts the same text on the clipboard.

## In the app

The AgentFlow tab has two views: **Org chart** (`1`) and **Workflows** (`2`). The org chart is a canvas like the MindMap: drag empty space to pan, scroll to zoom, drag a card to move it (Shift: with its reports), and drag the dot under a card onto another agent to make that agent report to it, or onto empty space to add a new report. Double-click empty space to add an agent. **Tidy up** returns to the automatic tree. In the tree, a manager's reports that have no reports of their own are stacked in indented columns (up to six per column) once there are three or more, so a large team stays compact and no reporting lines cross. Positions are saved as the agent's optional `x` and `y`. An agent without them, such as one added through the API, is placed under its manager, below the last of its teammates. `N` adds an agent under the selected one, `W` adds a workflow, `/` searches, `F` fits the org, arrow keys nudge the selected agent. Right-click (or the menu key) opens a menu on an agent, a reporting line, a workflow card or empty canvas: change kind, status or manager, add the agent to a workflow, open its work queue on the DevOps board, duplicate a workflow, and so on. **Start from a template** creates a small example org and workflow to edit. A DevOps card's detail shows the agents linked to it, and you can assign agents from there.
