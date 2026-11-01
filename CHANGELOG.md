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
- AgentFlow agents have a Live switch (off until you turn it on) that runners obey; org cards show where each agent runs and on which model. Runners report their models to the workspace (`runners.list`, `runners.report`), and `tools/agent-runner.mjs` is a reference runner for T3 Code.
- Right-click menus on the MindMap and AgentFlow canvases (keyboard: menu key or Shift+F10).
- AgentFlow's tidy tree stacks larger teams in compact indented columns, so big orgs stay narrow and reporting lines never cross; agents added through the API join their teammates' column.
- The Chart tab is now called MindMap. The API keeps the `charts` name.
