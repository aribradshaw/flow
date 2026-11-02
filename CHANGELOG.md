# Changelog

User-facing release notes will be recorded here when release tags are published. Flow's in-app DevLog records individual changes between releases.

## Unreleased

- Initial public release of Flow's chart, timeline, and DevOps workspace.
- Account-free local mode and optional hosted OneProfileID sign-in with private workspaces and invites.
- README screenshots and short walkthroughs for timeline and DevOps views.
- Workspace workflow presets and editable status and board column names.
- Instance display name, accent, and logo configuration for self-hosters.
- Self-hosting guide and example environment file.
- AgentFlow tab: an org chart of AI agents, people and teams with purposes, inputs, outputs, tools and instructions, plus workflows of agent steps. Agents and workflows link to projects, DevOps cards and timeline deadlines, and runners get Markdown briefs through new `agents.*` and `workflows.*` API and MCP operations.
- AgentFlow's org chart is a pan-and-zoom canvas: drag agents, drag between agents to set who reports to whom, Tidy up to re-arrange as a tree.
- Delegate DevOps cards to AgentFlow agents: agent badges on cards, an Agents board filter, `agents` on card API calls, and `agents.work` for runners (brief plus the queue of open delegated cards).
- Scheduled jobs in AgentFlow: runners report the timers, crons and scheduled tasks they find; a Scheduled tray on the org canvas lists them, and any job can be promoted into the org as an AI agent or a new Automation kind. Agents can carry a schedule.
- Split view: open two tabs side by side from the notch on a tab, with a draggable divider.
- AgentFlow redesign: org cards with avatars, status stripes and a zoomed-out view; reporting lines that merge into one trunk per manager; a sectioned side panel with pills, chips and searchable pickers.
- AgentFlow agents take an ordered list of models (primary, then fallbacks) or an Auto pool; runners report each model's provider and whether it is included in a subscription or metered, and the T3 runner falls back to the next model on failures and rate limits.
- People on the MindMap can have a photo and an email; photos show on cards, DevOps assignees, pickers and AgentFlow, and your account photo shows for a person with your email. Share guests see photos but never emails.
- AgentFlow agents have a Live switch (off until you turn it on) that runners obey; org cards show where each agent runs and on which model. Runners report their models to the workspace (`runners.list`, `runners.report`), and `tools/agent-runner.mjs` is a reference runner for T3 Code.
- Right-click menus on the MindMap and AgentFlow canvases (keyboard: menu key or Shift+F10).
- AgentFlow's tidy tree stacks larger teams in compact indented columns, so big orgs stay narrow and reporting lines never cross; agents added through the API join their teammates' column.
- The Chart tab is now called MindMap. The API keeps the `charts` name.
