# 3D office

The 3D office is a small virtual office for one environment, where you can see your team and the coding agents they have running right now. Open it from the AgentFlow toolbar with **3D** (between **Workflow** and **+**). It fills the window; **Esc** or the close button takes you back to AgentFlow.

To link straight to it, add `#office` to Flow's address (`https://your-flow.example/#office`): Flow opens AgentFlow and then the office, after sign-in and once the workspace has loaded. `#office/<id>` also opens one agent's panel: a live agent's id as its reporter sends it (`homebox:t3:abc`; URL-encode anything unusual), or an AgentFlow agent's id or name. Closing the office takes the address back to `#agentflow`.

- **Rooms.** Every member of the environment has a room with their name plate beside the door (which also says when they are away and whether agents are running): the environment's owner, and everyone with an active share into it (see [Sharing](#sharing)). A room is dimmed, with when its member was last here, while they don't have the office open. The common area in the middle holds the environment's AgentFlow org, laid out like the org chart: AI agents are small robots, teams round tables, automations little machines, and people are people. Their names show when you are near, hover or select one. Click one to see it, or to open it in AgentFlow. A human agent that is one of the members (matched by its person card's email, else by name) is that member's avatar while they are here, and stands at its place in the org, dimmed and marked offline, while they are not.
- **DevOps whiteboards.** Each room's back wall has a whiteboard with that person's cards in Doing, UAT and Blocked, in board order. The main board, on its own feature wall in the ring of rooms, shows the whole DevOps board of the environment the office is open in: Requests, Doing, Blocked, UAT and recently Done (the last 14 days), each with its count, its first cards and how many more there are. When doors connect the office to others, its title starts with **This office ▸**. Cards show their number, title, project colour and who is on them (people as round dots, AgentFlow agents as square ones). From far away a board shows only its title and counts. Walk up to a whiteboard and click a card to open its DevOps details, or press E to open the first card in the lane in front of you. Left-drag a card onto a person or room to add a developer, onto another whiteboard column to move it, or onto an AgentFlow agent in your workspace to add it to that agent's queue. Hold **Shift** while dropping onto an agent to replace its current delegates. Use **Undo** in the confirmation to reverse the latest drop. An agent with a Doing card shows its number beside its name. The boards use the cards available in your workspace, including cards shared with you in the office you visit.
- **Live agents.** The coding agents running on a member's machines sit at desks in their room, as a little mascot: Claude's crab, a cloud for OpenAI and Codex, a whale for DeepSeek, Grok's black sphere, Gemini's sparkle, or an orb for anything else. Its subagents are tiny copies circling it. Click an agent (or its name tag) for its title, model, machine, repo and project, what it is doing and its subagents.
- **Seats.** The AgentFlow agents are the jobs; a live session working on one of an agent's cards is the one doing it. It sits at that agent's desk in the common area instead of a desk in its owner's room, as the same live mascot, with the agent's name and the card (such as **Builder · #12**) on its tag. An agent with nobody at its desk stands idle and dimmed. Click an agent for who is at its desk now, its queue (the first five cards, as `agents.work` orders them) and the cards it finished (moved to UAT or Done) in the last seven days. Allow and Deny still go only to the session's owner. See [Seats](#seats) for how a session finds its desk.
- **What they are doing.** A running agent acts out its kind of work (its [`activityKind`](#activity-kinds)), and its name tag starts with the matching sign: it types at its keyboard while it edits files (✏️), reads a floating book (📖), sweeps a magnifying glass while it searches (🔍), has terminal glyphs on its screen while it runs commands (⌨️), shakes a bubbling test tube that flashes green and red while it tests (🧪), thinks under a thought cloud (💭) or spins a little globe on the web (🌐). An idle agent is dim, and now and then wanders to its room's coffee corner and back (☕).
- **Waiting gets your attention.** When an agent starts waiting on its person (⏳), it glows with a **!** and, if its owner is in the office, walks over to their avatar and hops beside them until it is answered, then walks back to its desk. If its owner is not in the office, it hops at its desk. For the owner, it also plays a short, soft ping; the speaker button in the office's top bar turns the sound off and on. Click the agent or its **!** for its panel, with **Allow** and **Deny** when the prompt can be answered from Flow.
- **Alerts outside the office.** Turn on **Notify me when agents wait** (the bell in the office's top bar). Then, while Flow is open in any tab with the office closed, each time one of your own agents starts waiting your browser shows a notification (the browser asks for permission once), and the **3D** button shows how many of your agents wait. Clicking the notification opens the office on that agent. Only you are alerted about your agents: never anyone else, even people who can see the agent's project. The setting is remembered with your preferences; turn it off with the same button.
- **Transcript.** Your own agent's panel shows the latest lines of its conversation (up to 12: what you asked, what it said, and one line per tool call), scrolled to the newest. Only you ever see it: not the environment's owner, not someone who can see its project. Reporters mask secrets before sending, and Flow masks tokens, keys, `Authorization` headers and `.env`-looking lines again on the way in.
- **Send to agent and Stop.** When its reporter can carry them out (T3 Code threads, through `flow office bridge` or another reporter that says so), your own agent's panel has a **Send to agent** box and a **Stop** button. Type a message and press **Enter** to send it (**Shift+Enter** for a new line): it reaches the agent as your next message, after its current turn when it is busy. **Stop** asks you to confirm, then interrupts its running turn. Each one shows as sending, then sent (waiting for the reporter), then how it went. While you type in the box, the movement and shortcut keys go to the box, not the office. Only the agent's owner ever gets these, they are rate-limited, and the reporter checks the agent is still the same before it acts. Claude Code in a terminal cannot be reached from outside, so its panel has neither.
- **Allow and Deny.** When your own agent waits on a permission prompt that its reporter can answer, its panel shows the prompt with **Allow** and **Deny**. Your answer goes to the reporter on that machine (usually within a second), and the panel shows how it went. Only the agent's owner ever gets these buttons.
- **People.** Everyone who has the office open is an avatar with a name tag (and their account photo when they have one).
- **Press E.** Walk up to an agent, a person or a board and a prompt says what **E** does there ("E Talk to Chief of Staff", "E Wave at Joe"); on a gamepad it is X / Square, and on a touch screen you tap the prompt. E again, Esc or walking away closes what it opened. The camera turns with **Z** and **C**.
- **Status.** Each person sets Available, Focus, Do not disturb or Away. It shows on their avatar, name tag and door sign. See [Status](#status).
- **Chat and emotes.** Type in the box at the bottom left (or press **T**). A message shows as a speech bubble over you for anyone standing nearby, and in everyone's chat log. Wave, thumbs up, clap and heart are the buttons beside it, or keys **1** to **4**. Click someone's avatar to wave, follow them (until you move yourself) or start a message to them.
- **Several offices.** If shares from other people's environments are placed in yours, the office's title becomes a menu: pick a shared environment to enter its office as a member. The shared office opens first, until you pick another.
- **One office for a shared environment.** When you open an environment shared with you as a whole (see [Sharing](#sharing)), its 3D office is the owner environment's office: the same rooms, the same chat and the same people, so the owner and everyone it is shared with see each other live. Your own coding agents show in your room there, as in every office you are a member of.
- **Doors.** Each office has a glowing door, in a gap between the rooms, for every other office sharing connects you to and that you can enter, labelled with whose office it is ("Avery's office") and its environment's name: the offices of environments shared with you, the offices of your own environments that you share (where the people you share them with meet you), and, while you visit someone else's office, a door back to your own (**Your office**). Walk through a door, or click it or its label, to go there. You only ever see doors to offices you can enter.
- **No longer shared.** If the share is revoked while you are in its office, the office says it is no longer shared with you, you leave it at once (everyone else sees you go), and it does not reconnect.
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

## Status

The header has a status control: **Available**, **Focus**, **Do not disturb** or **Away**, and an optional note of up to 60 characters (for example "on a call"). The choice is kept in this browser, and in the server's memory while this Flow process is running, so a reload keeps it and everyone in the office sees it. A coloured ring and an icon sit on the avatar and the name tag, and on the room's door sign. Green is available, amber is focus, red is do not disturb, and grey is away.

Away is also set on its own after 10 minutes with no input while the tab is hidden, and clears when you come back (the tab is visible again, or you press a key or click). An Away you picked yourself stays until you change it.

While someone is in **Do not disturb**, waiting-agent pings and notifications are held and only the badge shows, until they leave it. That includes the browser notification from **Notify me when agents wait**: the badge on the **3D** button still counts them, and the notifications show when they leave Do not disturb. Activity code checks `status.isQuiet(userId)` from `public/office-status.js` before it pings. `userId` is the office member key. When that is true, call `status.notePing(userId, ping)` instead of announcing; it returns `{held: true, count}`. `status.takeHeld(userId)` returns what was held once they leave. The same check on the server is `officeHub.isQuiet(userId)`, and there `userId` may be the member key or the person's email. Pings the office already knows about (an agent that starts waiting) go through this hook on their own.

## Who sees what

Agents belong to a person, not to an environment: they show in the office of every environment that person is a member of. For each viewer, Flow decides on the server what leaves it:

| Viewer | Sees |
|---|---|
| The agent's owner | Everything, plus Allow / Deny, its transcript, and Send to agent and Stop |
| Someone who can see the Flow project the agent's repo belongs to | Everything except the buttons and the transcript: title, model, machine, repo, project, activity, subagents and the prompt |
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

- **T3 Code.** It reads T3's state database (`~/.t3/userdata/statev2.sqlite`, read-only) for threads with a running turn: title, model, the project folder's git remote, latest activity, subagents, open approval requests and the last 12 lines of the conversation (user and assistant messages, one line per command, file edit or tool). Allow and Deny go through T3's own API (a short-lived token from `t3 auth session issue`), after checking that the request is still open. Top-level threads take **Send to agent** (`t3 thread send`, with the text on standard input) and **Stop** (T3's `run.interrupt`, for the same turn that was running), after checking the thread is still running there; threads delegated by another thread are steered by that thread. The bridge logs each message and stop with the agent and how it went, never the text. Questions are answered in T3.
- **Claude Code** in a terminal. Running sessions (`~/.claude/sessions/` and their transcripts under `~/.claude/projects/`) are reported with their status, latest activity and the last 12 lines of the conversation. Their prompts cannot be answered from outside, and they cannot take messages or be stopped from the office, so they show without buttons (`can: []`). Sessions T3 runs are reported once, as T3 agents.

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

- `PUT /api/v1/office/agents` (`office.agents.report`) with `{source, at, agents:[…]}`. Each agent: `id` (stable within the source), `title`, `vendor` (`claude`, `codex`, `gemini`, `deepseek`, `grok` or `other`; with `other` the mascot is picked from the model when it names one), `model`, `status` (`running`, `waiting` or `idle`), `activity`, `activityKind` (optional, see [Activity kinds](#activity-kinds)), `host`, `hostLabel`, `repo` (`{name, remote}` or `null`), `children` (subagents: `id`, `title`, `vendor`, `model`, `status`, `activityKind`), `pending` (`null`, or `{requestId, kind: approval | question, summary, can: ["allow","deny"]}`) `agentflow` (optional, `{agent: "<AgentFlow agent id or name>", card: <card number or id>}`: the AgentFlow agent and card it works on, which seat it at that agent's desk; see [Seats](#seats)) `can` (optional, `["message","stop"]`: what the owner may do from the office besides Allow / Deny; list only what this reporter can carry out, `[]` or none for agents that can only be steered where they run) and `transcript` (optional, `[{role: user | assistant | tool, text, at}]`, oldest first: the last 12 are kept, each `text` up to 400 characters, other roles dropped; shown only to the owner, and masked again on the server). Each source replaces only its own agents; up to 200 agents and 20 children each are kept, long strings are cut, and credentials in a remote are dropped. The answer is `{actions:[…]}`: the actions for this source not yet delivered (see the next item).
- `GET /api/v1/office/actions?source=…&wait=25` (`office.actions.wait`): a long-poll that answers as soon as an answer is queued, or with an empty list after `wait` seconds (up to 30). Each action is delivered once and has a `kind`: `answer` is Allow / Deny, `{id, agentId, kind: "answer", requestId, decision, at}` (treat a missing `kind` as `answer`: servers before this change sent none); `message` is `{id, agentId, kind: "message", text, at}`, up to 2000 characters to send to the agent as a new user turn; `stop` is `{id, agentId, kind: "stop", at}`, to interrupt its running turn. Messages and stops come only from the agent's owner, only for agents whose `can` lists them, and at most 3 messages in a row per agent (then one every 10 seconds), 2 stops (then one every 30 seconds) and 10 of either per person (then one every 6 seconds). Before carrying one out, check it is still the same agent on your side.
- `POST /api/v1/office/actions/{id}` (`office.actions.result`) with `{ok, message}`: how carrying it out went. The agent's owner sees the message right away, in the panel and as a notice. Keep it short and never echo a message's text; log messages and stops on your side without their text.
- `GET /api/v1/office/agents` (`office.agents.list`): your agents as Flow holds them.

A source that has not reported for 90 seconds is gone, and its agents leave the office. An answer is accepted only from the agent's owner, and only while that agent is waiting on that same `requestId`; carry it out only after checking the request is still open on your side. The same operations are MCP tools (`office_agents_report`, …) and CLI commands (`flow office agents report`).

### Activity kinds

`activityKind` says what kind of work an agent is doing, for its animation. It is one of:

| `activityKind` | Use it for | In the office |
|---|---|---|
| `edit` | Changing files (Edit, Write, MultiEdit, `apply_patch`) | Types at its keyboard |
| `read` | Reading files or docs (Read, View) | Reads a floating book |
| `search` | Searching the code (Grep, Glob, `rg`, find) | Sweeps a magnifying glass |
| `run` | Shell commands (Bash, shell) that are not tests | Terminal glyphs on its screen |
| `test` | Running tests (`npm test`, `pytest`, `cargo test`, …) | A bubbling test tube, flashing green and red |
| `think` | Thinking, planning, writing its answer | A thought cloud |
| `web` | WebFetch, WebSearch, a browser | A spinning globe |
| `idle` | Nothing | Wanders to the coffee corner |

It is optional and backward compatible. When it is missing or not one of these, Flow works it out from `activity`: first a tool name at the start (`Edit lib/auth.mjs` is `edit`, `Read`, `Grep` and `Glob`, `Bash` and `WebFetch` likewise, and `Bash: npm test` is `test`), then words in it (`Running tests` is `test`, `Reading the docs` is `read`, `Searching for callers` is `search`). Anything else is `think`. An agent whose `status` is `idle` is always `idle`. A subagent's kind is worked out from its `activity` or else its `title`.

Send `activityKind` when your reporter knows the tool an agent is using: it is more accurate than the guess from text. It is shown to everyone who can see the agent, including people who see it only as **Private project**: the kind of work says nothing about the work itself.

## Sharing

An office's members are its environment's owner and the recipient of every active share of that environment (any scope; a whole-environment share also shows all its projects and AgentFlow agents). Opening an environment shared with you as a whole (docs/sharing.md, `share-<shareId>`) opens the owner environment's office: `/api/office/share-<shareId>/…` resolves to it for the share's recipient and is 404 for anyone else, like any office you are not a member of. What each viewer sees there follows [Who sees what](#who-sees-what), per viewer, unchanged.

The snapshot carries `portals: [{env, label, sub, own}]`, the doors for this viewer (computed on the server from their shares). When a share is made or revoked, open offices get a `portals` event with their doors as they are now, so a door appears or goes at once. Access is checked again on every heartbeat, and at once when a share is revoked (from the app, the API or MCP): a stream that lost access gets a `gone` event and is closed, and its person leaves the office for everyone else.

## How it runs

The office is live over Server-Sent Events: `GET /api/office/{env}/events` sends a snapshot (rooms, AgentFlow agents, live agents as this viewer may see them, who is here, each member's presence, and the last 50 chat lines, and the viewer's own live reporter sources), then moves, presence, chat, emotes, agent updates and answer results as they happen, with a heartbeat every 15 seconds. Moves (including an optional short status line saved with last-seen), chat (up to 280 characters), emotes, answers and steering are small POSTs to `/api/office/{env}/presence`, `say`, `emote`, `answer` and `steer` (`{kind: "message", source, agentId, text}` or `{kind: "stop", source, agentId}`; `answer` takes the same body, and a body without `kind` is Allow / Deny). Presence is `POST /api/office/{env}/status` with `available`, `focus`, `dnd` or `away` and a note of up to 60 characters. All of these are rate-limited per person. There is no API key operation for sending messages or stops: they come only from the signed-in owner in the office. Only the app's own page can call them, signed in. The events stream also takes an API key with the `read` scope for that environment (`Authorization: Bearer flow_…`), so a dashboard can watch the office. A stream that stops hearing heartbeats reconnects by itself; the header says "Reconnecting…" only after eight seconds without a stream.

Alerts outside the office use one more stream, `GET /api/office/alerts`, which the app keeps open only while **Notify me when agents wait** is on. It belongs to the signed-in person and has no environment: it sends `mine` (`{waiting:[…]}`, their own agents that are waiting now) when it opens and whenever that changes, and `waiting` (one agent) each time one of their agents starts waiting or waits on a new prompt. An agent's first report from a source (a reporter starting, or the server restarting) does not count as starting to wait. Only the app's own page can open it, signed in; API keys cannot.

During a reconnect, the office keeps the last scene and chat. The next snapshot updates that scene, and each browser sends its last position and status again. A source event ID identifies the previous connection; the server sends a fresh, access-checked snapshot on each connection. Reports keep their original timestamps, and a report still expires 90 seconds after the server last received it. The latest 50 chat lines per office, member status and last-seen times, and recent actions are saved in Postgres or under `BACKUP_DIR`. Live avatar positions remain in memory. Office actions are claimed before they are returned, so a restart cannot return an already claimed action a second time. If the connection dies between the claim and the response, the reporter can miss that action.

The office is drawn with [Three.js](https://threejs.org) (MIT), vendored in `public/vendor/three` and loaded only when the office opens.
