# AgentFlow

AgentFlow is an org chart for agentic work. You lay out the agents that do work for a business, say what each one is for and what it takes in and produces, chain them into workflows, and tie them to the projects, DevOps cards and deadlines they own.

Flow stores the design. It does not run agents itself. A runner of your choice (an agent harness, a home server, a cron job) reads an agent's or workflow's **brief** through the API or MCP and does the work, then reports back on the DevOps cards like anyone else.

## Agents

An agent has `name, kind, title, status, reportsTo, supervisor, purpose, instructions, runtime, model, inputs[], outputs[], tools[]` and links `projects[], cards[], items[]`.

- `kind`: `agent` (an AI agent), `human` or `team` (a group heading in the org).
- `status`: `draft`, `active`, `paused` or `retired`.
- `reportsTo` is another agent. Together these form the AgentFlow org chart. An agent cannot report to itself or to anyone below it (`reports_loop`). A saved loop is broken when the workspace loads.
- `supervisor` is a person card on one of your mind maps: the human accountable for the agent.
- `inputs`, `outputs` and `tools` are short text lists, such as "A card in Doing" or "Pull request linked on the card".
- `instructions` holds the system prompt or runbook. `runtime` says where it runs and `model` which model, if any.
- Deleting an agent moves its direct reports up to its manager, and its workflow steps become unassigned.

## Workflows

A workflow has `name, description, status, trigger, schedule, steps[{agent, action, output}]` and the same links. `trigger` is `manual`, `schedule` or `event`. `schedule` says when or on what in plain words, e.g. "Weekdays at 09:00" or "A card enters UAT". Steps run in order, and each one names the agent that handles it.

## Briefs

`agents.get` and `workflows.get` return a `brief`: Markdown with everything a runner needs. That covers purpose, reporting line, inputs, outputs, tools, runtime, workflow steps, linked projects, cards (open ones from linked projects too) and deadlines, and the instructions. In the app, **Copy brief** in the side panel puts the same text on the clipboard.

## In the app

The AgentFlow tab has two views: **Org chart** (`1`) and **Workflows** (`2`). The org chart is a canvas like the MindMap: drag empty space to pan, scroll to zoom, drag a card to move it (Shift: with its reports), and drag the dot under a card onto another agent to make that agent report to it, or onto empty space to add a new report. Double-click empty space to add an agent. **Tidy up** returns to the automatic tree. Positions are saved as the agent's optional `x` and `y`. An agent without them, such as one added through the API, is placed under its manager. `N` adds an agent under the selected one, `W` adds a workflow, `/` searches, `F` fits the org, arrow keys nudge the selected agent. **Start from a template** creates a small example org and workflow to edit. A DevOps card's detail shows the agents linked to it, and you can assign agents from there.
