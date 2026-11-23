# 3D office

The 3D office is a small virtual office for one environment, where you can see your team and the coding agents they have running right now. Open it from the AgentFlow toolbar with **3D** (between **Workflow** and **+**). It fills the window; **Esc** or the close button takes you back to AgentFlow.

- **Rooms.** Every member of the environment has a room with their name on it: the environment's owner, and everyone with an active share into it (see [Sharing](#sharing)). A room is dimmed, with when its member was last here, while they don't have the office open. The common area in the middle holds the environment's AgentFlow org, laid out like the org chart: AI agents are small robots, teams round tables, automations little machines, and people are people. Their names show when you are near, hover or select one. Click one to see it, or to open it in AgentFlow. A human agent that is one of the members (matched by its person card's email, else by name) is that member's avatar while they are here, and stands at its place in the org, dimmed and marked offline, while they are not.
- **DevOps whiteboards.** Each room shows up to three of that person's cards in Doing, UAT and Blocked, in board order. The common area shows Requests and Doing cards delegated to AgentFlow agents. Walk up to a whiteboard and click a card to open its DevOps details. An agent with a Doing card shows its number beside its name. The boards use the cards available in your workspace, including cards shared with you in the office you visit.
- **Live agents.** The coding agents running on a member's machines sit at desks in their room, as a little mascot: Claude's crab, a cloud for OpenAI and Codex, a whale for DeepSeek, Grok's black sphere, Gemini's sparkle, or an orb for anything else. They turn slowly and bob; one waiting on its person hops and glows with a **!**, and an idle one is still and dim. Its subagents are tiny copies circling it. Click an agent (or its name tag) for its title, model, machine, repo and project, what it is doing and its subagents.
- **Seats.** The AgentFlow agents are the jobs; a live session working on one of an agent's cards is the one doing it. It sits at that agent's desk in the common area instead of a desk in its owner's room, as the same live mascot, with the agent's name and the card (such as **Builder · #12**) on its tag. An agent with nobody at its desk stands idle and dimmed. Click an agent for who is at its desk now, its queue (the first five cards, as `agents.work` orders them) and the cards it finished (moved to UAT or Done) in the last seven days. Allow and Deny still go only to the session's owner. See [Seats](#seats) for how a session finds its desk.
- **Allow and Deny.** When your own agent waits on a permission prompt that its reporter can answer, its panel shows the prompt with **Allow** and **Deny**. Your answer goes to the reporter on that machine (usually within a second), and the panel shows how it went. Only the agent's owner ever gets these buttons.
- **People.** Everyone who has the office open is an avatar with a name tag (and their account photo when they have one).
- **Chat and emotes.** Type in the box at the bottom left (or press **T**). A message shows as a speech bubble over you for anyone standing nearby, and in everyone's chat log. Wave, thumbs up, clap and heart are the buttons beside it, or keys **1** to **4**. Click someone's avatar to wave, follow them (until you move yourself) or start a message to them.
- **Several offices.** If shares from other people's environments are placed in yours, the office's title becomes a menu: pick a shared environment to enter its office as a member. The shared office opens first, until you pick another.
- **Local mode.** Without sign-in, the office opens with just you and your AgentFlow agents, and your own reported agents.

## Office controls

Open **?** in the office header for the control list and the option to turn off automatic recentering.

| Action | Control |
|---|---|
| Walk | **WASD**, arrow keys, or click/tap a destination |
| Sprint | Hold **Shift** or double-tap and hold a direction |
| Jump | **Space**. Hold for a higher jump. Press again in the air to flip. |
| Orbit | Drag with the middle or right mouse button, **Alt** + left drag, **Q** / **E**, or one-finger drag |
| Zoom | Scroll, use the **+** / **−** buttons, or pinch |
| Pan | Drag with two fingers |
| Recenter | Middle-click or press **F** |
| Top-down overview | Press **O** or select the overview button |
| Gamepad | Left stick to walk, right stick to orbit, **A** to jump, **B** or **X** to sprint |

## Who sees what

Agents belong to a person, not to an environment: they show in the office of every environment that person is a member of. For each viewer, Flow decides on the server what leaves it:

| Viewer | Sees |
|---|---|
| The agent's owner | Everything, plus Allow / Deny |
| Someone who can see the Flow project the agent's repo belongs to | Everything except the buttons: title, model, machine, repo, project, activity, subagents and the prompt |
| Anyone else | Only the mascot, the vendor and running / waiting / idle, labelled **Private project** |

The environment's owner (and anyone else who can read the whole environment) sees all its projects. A share's recipient sees the projects in their share's scope; a whole-environment share means all of them. An agent whose repo is in none of the environment's projects is private to everyone but its owner, including the environment's owner. Nothing about a private agent (its title, activity, repo, model, prompt, machine or id) is sent to that viewer's browser. A share's recipient also sees only the AgentFlow agents linked to the projects they can see.

A session seated at an AgentFlow agent's desk follows the same rules, with one more: someone other than its owner sees it in full only when they can also see that agent or its card. Otherwise it is a private mascot at its owner's room, and nothing about the seat (the agent, the card) is sent. A desk's queue and finished cards list only the cards the viewer can see.

## Seats

A live session is seated at an AgentFlow agent's desk when Flow can tell which agent and card it works on. This is worked out on the server, in each environment, against that environment's own agents and cards: a session belongs to a person and shows in every office they are a member of, and where the agent is not there it keeps its own desk.

1. **The reporter says so**: `agentflow: {agent, card}` on the agent in the report. `agent` is the AgentFlow agent's id or name; `card` is the card's number (`12` or `"#12"`) or id. With only a card, the agent is the one that card is delegated to, when there is exactly one. An agent this environment does not have means no seat.
2. **The agent runner's title**: `[Flow] <Agent>: #<n> <card title>`, as `tools/agent-runner.mjs` names its threads (an agent's name may hold a colon; a name over 80 characters is cut, and still matches). An agent this environment does not have means no seat.
3. **A card number in the title**: the first `#<n>`. When card #n is delegated to exactly one agent, the session sits at that agent's desk; delegated to none or to several, the card is linked (it shows on the tag) but the session keeps its own desk. When both the session and the card's project have repos, they must match.

`flow office bridge` sends `agentflow` for T3 threads with the runner's title.

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

Open **AgentFlow › 3D › Connect your agents**. Choose the operating system on the machine that runs your agents, then create a bridge key. Copy the terminal commands or paste the setup prompt into a local coding agent such as Claude Code, Codex or Cursor. The dialog confirms the first report from a new source, even if no agents are running yet.

You can also give your coding agent this prompt and supply the server URL and a key when it asks.

```text
Connect my local coding agents to the Flow 3D office. Detect the operating system on this machine.

Ask me for my Flow server URL and have me create a dedicated API key in Settings › Connect. Choose the current environment and Read & write. Ask me to provide the key privately.

1. On this machine, install the Flow CLI with `npm install -g github:aribradshaw/flow` (requires Node.js 24 or newer and Git).
2. Use a dedicated XDG_CONFIG_HOME for the office bridge so my normal Flow CLI login is preserved. Sign in to the Flow server I provide using `flow login --url <server> --key-stdin` and pass the key privately on stdin. Keep the key in the CLI config only. Never write it into a repo, command arguments, a service definition, logs or shell history. Don't print it again.
3. In the same configuration, run `flow office bridge --once --dry-run`. Show me what the bridge would send and wait for my approval before sending a report.
4. Set up `flow office bridge` as a background service that starts at login (launchd LaunchAgent on macOS, Task Scheduler on Windows, systemd user service on Linux). Use the same XDG_CONFIG_HOME, clear FLOW_URL and FLOW_API_KEY overrides, and ensure the service can find Node.js, Git and the Flow CLI. Start it now.
5. Verify that the reporter appears in the 3D office by checking `flow office agents list --json` with the same configuration and telling me which source and how many agents are connected.
```

To set it up manually:

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

- `PUT /api/v1/office/agents` (`office.agents.report`) with `{source, at, agents:[…]}`. Each agent: `id` (stable within the source), `title`, `vendor` (`claude`, `codex`, `gemini`, `deepseek`, `grok` or `other`; with `other` the mascot is picked from the model when it names one), `model`, `status` (`running`, `waiting` or `idle`), `activity`, `host`, `hostLabel`, `repo` (`{name, remote}` or `null`), `children` (subagents, the same fields), `pending` (`null`, or `{requestId, kind: approval | question, summary, can: ["allow","deny"]}`) and `agentflow` (optional, `{agent: "<AgentFlow agent id or name>", card: <card number or id>}`: the AgentFlow agent and card it works on, which seat it at that agent's desk; see [Seats](#seats)). Each source replaces only its own agents; up to 200 agents and 20 children each are kept, long strings are cut, and credentials in a remote are dropped. The answer is `{actions:[…]}`: Allow / Deny answers for this source not yet delivered.
- `GET /api/v1/office/actions?source=…&wait=25` (`office.actions.wait`): a long-poll that answers as soon as an answer is queued, or with an empty list after `wait` seconds (up to 30). Each answer is `{id, agentId, requestId, decision, at}` and is delivered once.
- `POST /api/v1/office/actions/{id}` (`office.actions.result`) with `{ok, message}`: how carrying it out went. The person who answered sees the message right away.
- `GET /api/v1/office/agents` (`office.agents.list`): your agents as Flow holds them.

A source that has not reported for 90 seconds is gone, and its agents leave the office. An answer is accepted only from the agent's owner, and only while that agent is waiting on that same `requestId`; carry it out only after checking the request is still open on your side. The same operations are MCP tools (`office_agents_report`, …) and CLI commands (`flow office agents report`).

## How it runs

The office is live over Server-Sent Events: `GET /api/office/{env}/events` sends a snapshot (rooms, AgentFlow agents, live agents as this viewer may see them, who is here and the last 50 chat lines, and the viewer's own live reporter sources), then moves, chat, emotes, agent updates and answer results as they happen, with a heartbeat every 15 seconds. Moves, chat (up to 280 characters), emotes and answers are small POSTs to `/api/office/{env}/presence`, `say`, `emote` and `answer`, rate-limited per person. Only the app's own page can call them, signed in. The events stream also takes an API key with the `read` scope for that environment (`Authorization: Bearer flow_…`), so a dashboard can watch the office. A stream that stops hearing heartbeats reconnects by itself; the header says "Reconnecting…" only after a few seconds without it.

Everything about the office is kept in memory on the server: reported agents, presence and chat (which is not saved). Flow runs as a single server instance, so this works as is; a restart empties the office and reporters fill it again within seconds. Running several Flow instances behind a load balancer would need shared state for it. The office is drawn with [Three.js](https://threejs.org) (MIT), vendored in `public/vendor/three` and loaded only when the office opens.
