# 3D office

The 3D office is a small virtual office for one environment, where you can see your team and the coding agents they have running right now. Open it from the AgentFlow toolbar with **3D** (between **Workflow** and **+**). It fills the window; **Esc** or the close button takes you back to AgentFlow.

- **Rooms.** Every member of the environment has a room with their name on it: the environment's owner, and everyone with an active share into it (see [Sharing](#sharing)). The common area in the middle holds the environment's AgentFlow agents, people and teams, laid out loosely like the org chart. Click one to see it, or to open it in AgentFlow.
- **Live agents.** The coding agents running on a member's machines sit at desks in their room, as a little mascot for Claude, Codex, Gemini or anything else. A running agent types and bobs, one waiting on its person hops and glows with a **!**, and an idle one is dim. Its subagents are tiny copies circling it. Click an agent (or its name tag) for its title, model, machine, repo and project, what it is doing and its subagents.
- **Allow and Deny.** When your own agent waits on a permission prompt that its reporter can answer, its panel shows the prompt with **Allow** and **Deny**. Your answer goes to the reporter on that machine (usually within a second), and the panel shows how it went. Only the agent's owner ever gets these buttons.
- **People.** Everyone who has the office open is an avatar with a name tag (and their account photo when they have one). Walk with **WASD** or the arrow keys, or click (tap, on a tablet) where you want to go. The mouse wheel or **+** and **−** zoom.
- **Chat and emotes.** Type in the box at the bottom left (or press **T**). A message shows as a speech bubble over you for anyone standing nearby, and in everyone's chat log. Wave, thumbs up, clap and heart are the buttons beside it, or keys **1** to **4**. Click someone's avatar to wave, follow them (until you move yourself) or start a message to them.
- **Several offices.** If shares from other people's environments are placed in yours, the office's title becomes a menu: pick a shared environment to enter its office as a member.
- **Local mode.** Without sign-in, the office opens with just you and your AgentFlow agents, and your own reported agents.

## Who sees what

Agents belong to a person, not to an environment: they show in the office of every environment that person is a member of. For each viewer, Flow decides on the server what leaves it:

| Viewer | Sees |
|---|---|
| The agent's owner | Everything, plus Allow / Deny |
| Someone who can see the Flow project the agent's repo belongs to | Everything except the buttons: title, model, machine, repo, project, activity, subagents and the prompt |
| Anyone else | Only the mascot, the vendor and running / waiting / idle, labelled **Private project** |

The environment's owner (and anyone else who can read the whole environment) sees all its projects. A share's recipient sees the projects in their share's scope; a whole-environment share means all of them. An agent whose repo is in none of the environment's projects is private to everyone but its owner, including the environment's owner. Nothing about a private agent (its title, activity, repo, model, prompt, machine or id) is sent to that viewer's browser. A share's recipient also sees only the AgentFlow agents linked to the projects they can see.

## Repos on projects

To say which agents belong to a project, give the project its code repositories. In the Timeline's **Projects** panel, each project has a **Repos** field: a comma-separated list of names (`lantern`), owner and name (`acme/lantern`) or git remotes (`https://github.com/acme/lantern.git`, `git@github.com:acme/lantern.git`). Through the API or MCP, send `repos` to `projects.create` or `projects.update` (`[]` clears them).

Repos are compared without `.git`, the protocol and the host: owner and name when both sides have them (so someone's fork with the same name is not the project), otherwise the bare name.

```sh
flow projects update Lantern --repos acme/lantern,acme/lantern-site
```

## Report your agents: flow office bridge

`flow office bridge` runs on your own machine and keeps your agents in the office. Every 3 seconds it reads the agents running there and sends them as source `bridge:<hostname>`, and it waits for Allow / Deny answers and carries them out.

- **T3 Code.** It reads T3's state database (`~/.t3/userdata/statev2.sqlite`, read-only) for threads with a running turn: title, model, the project folder's git remote, latest activity, subagents and open approval requests. Allow and Deny go through T3's own API (a short-lived token from `t3 auth session issue`), after checking that the request is still open. Questions are answered in T3.
- **Claude Code** in a terminal. Running sessions (`~/.claude/sessions/` and their transcripts under `~/.claude/projects/`) are reported with their status and latest activity. Their prompts cannot be answered from outside, so they show without buttons. Sessions T3 runs are reported once, as T3 agents.

To join the office:

- Install the CLI (Node 22.13 or newer): `npm install -g github:aribradshaw/flow` gives you `flow`. From a checkout of Flow, `npm link` does the same, or run `node tools/flow.mjs …`.
- Create an API key in Flow under **Settings › Connect**: **New key**, any environment (or all), **Read & write**.
- Sign the CLI in: `flow login --url https://your-flow.example --key flow_…` (or `--key-stdin`).
- Try it: `flow office bridge --once --dry-run` prints what would be sent. `flow office bridge --once` sends one report and prints the answer.
- Run it: `flow office bridge` (`flow office bridge --help` lists its options).

To keep it running in the background:

- **Linux** (systemd user service). Save as `~/.config/systemd/user/flow-office-bridge.service`, then `systemctl --user daemon-reload && systemctl --user enable --now flow-office-bridge` (and `loginctl enable-linger $USER` to keep it running when you are logged out):

```ini
[Unit]
Description=Flow office bridge
After=network-online.target

[Service]
ExecStart=/usr/bin/env flow office bridge
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

- **macOS** (launchd). Save as `~/Library/LaunchAgents/com.example.flow-office-bridge.plist` with `ProgramArguments` set to the full path of `flow` (see `which flow`), `office`, `bridge`, and `RunAtLoad` and `KeepAlive` true, then `launchctl load ~/Library/LaunchAgents/com.example.flow-office-bridge.plist`.
- **Windows.** Run it in the background with `start /b flow office bridge` from a terminal, or at every sign-in with a scheduled task: `schtasks /Create /SC ONLOGON /TN "Flow office bridge" /TR "cmd /c flow office bridge"`.

The bridge stores nothing itself: the server and key come from `flow login` (or `FLOW_URL` and `FLOW_API_KEY`).

## The reporter API

Anything can report agents the same way, such as a home-server dashboard. Authenticate with an API key with the `write` scope; agents belong to the key's owner.

- `PUT /api/v1/office/agents` (`office.agents.report`) with `{source, at, agents:[…]}`. Each agent: `id` (stable within the source), `title`, `vendor` (`claude`, `codex`, `gemini` or `other`), `model`, `status` (`running`, `waiting` or `idle`), `activity`, `host`, `hostLabel`, `repo` (`{name, remote}` or `null`), `children` (subagents, the same fields) and `pending` (`null`, or `{requestId, kind: approval | question, summary, can: ["allow","deny"]}`). Each source replaces only its own agents; up to 200 agents and 20 children each are kept, long strings are cut, and credentials in a remote are dropped. The answer is `{actions:[…]}`: Allow / Deny answers for this source not yet delivered.
- `GET /api/v1/office/actions?source=…&wait=25` (`office.actions.wait`): a long-poll that answers as soon as an answer is queued, or with an empty list after `wait` seconds (up to 30). Each answer is `{id, agentId, requestId, decision, at}` and is delivered once.
- `POST /api/v1/office/actions/{id}` (`office.actions.result`) with `{ok, message}`: how carrying it out went. The person who answered sees the message right away.
- `GET /api/v1/office/agents` (`office.agents.list`): your agents as Flow holds them.

A source that has not reported for 90 seconds is gone, and its agents leave the office. An answer is accepted only from the agent's owner, and only while that agent is waiting on that same `requestId`; carry it out only after checking the request is still open on your side. The same operations are MCP tools (`office_agents_report`, …) and CLI commands (`flow office agents report`).

## How it runs

The office is live over Server-Sent Events: `GET /api/office/{env}/events` sends a snapshot (rooms, AgentFlow agents, live agents as this viewer may see them, who is here and the last 50 chat lines), then moves, chat, emotes, agent updates and answer results as they happen, with a heartbeat every 15 seconds. Moves, chat (up to 280 characters), emotes and answers are small POSTs to `/api/office/{env}/presence`, `say`, `emote` and `answer`, rate-limited per person. Only the app's own page can call them, signed in.

Everything about the office is kept in memory on the server: reported agents, presence and chat (which is not saved). Flow runs as a single server instance, so this works as is; a restart empties the office and reporters fill it again within seconds. Running several Flow instances behind a load balancer would need shared state for it. The office is drawn with [Three.js](https://threejs.org) (MIT), vendored in `public/vendor/three` and loaded only when the office opens.
