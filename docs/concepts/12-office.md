# 3D office

The 3D office is a small virtual office for one environment, where you can see your team and the coding agents they have running right now. Open it from the AgentFlow toolbar with **3D** (between **Workflow** and **+**). It fills the window; **Esc** or the close button takes you back to AgentFlow.

To link straight to it, add `#office` to Flow's address (`https://your-flow.example/#office`): Flow opens AgentFlow and then the office, after sign-in and once the workspace has loaded. `#office/<id>` also opens one agent's panel: a live agent's id as its reporter sends it (`homebox:t3:abc`; URL-encode anything unusual), or an AgentFlow agent's id or name. Closing the office takes the address back to `#agentflow`.

- **Rooms.** Every member of the environment has a room with their name plate beside the door (which also says when they are away and whether agents are running): the environment's owner, and everyone with an active share into it (see [Sharing](#sharing)). A room is dimmed, with when its member was last here, while they don't have the office open. The common area in the middle holds the environment's AgentFlow org, laid out like the org chart: AI agents are small robots, teams round tables, automations little machines, and people are people. Their names show when you are near, hover or select one. Click one to see it, or to open it in AgentFlow. A human agent that is one of the members (matched by its person card's email, else by name) is that member's avatar while they are here, and stands at its place in the org, dimmed and marked offline, while they are not.
- **The DevOps board.** The main board, on its own feature wall in the ring of rooms, is your DevOps board itself: the same board as the **DevOps** tab, live, not a copy. Walk up and press **E**, or click it, and the camera turns to face it; it then works exactly as in the tab: open a card (it opens over the office), right-click menus, snooze, drag cards between columns, filters, search, sort, undo and the DevOps shortcuts. While you work on it the office's walking keys pause. **Esc**, **Back to office** or a click beside the board takes you back. Its title is the office's environment, and starts with **This office ▸** when doors connect the office to others. It shows the board of the environment you have open, so in an office you visit from your own environment it says so, and offers to open that environment's board when it is shared with you as a whole (Flow then opens that environment, as the environment menu does, and the office again there).
- **Room whiteboards.** Each room's back wall has a whiteboard with that person's cards in Doing, UAT and Blocked, in board order, each with its count, its first cards and how many more there are. Cards show their number, title, project colour and who is on them (people as round dots, AgentFlow agents as square ones). From far away a board shows only its title and counts. Walk up to a whiteboard and click a card to open its DevOps details, or press E to open the first card in the lane in front of you. Left-drag a card onto a person or room to add a developer, onto another whiteboard column to move it, or onto an AgentFlow agent in your workspace to add it to that agent's queue. Hold **Shift** while dropping onto an agent to replace its current delegates. Use **Undo** in the confirmation to reverse the latest drop. On the DevOps board, the card's right-click menu has **Assign developer** and **Delegate to agent** for the same. An agent with a Doing card shows its number beside its name. The room boards use the cards available in your workspace, including cards shared with you in the office you visit.
- **Meters.** A small screen by each room's door, and one beside the main board, shows agents running and waiting, cards shipped today, points shipped this week, and a 24 hour sparkline. The office screen also shows how many of your own agents are waiting on you. Walk up and press **E** for the details. See [Meters](#meters).
- **Live agents.** The coding agents running on a member's machines sit at desks in their room, as a little mascot: Claude's crab, a cloud for OpenAI and Codex, a whale for DeepSeek, Grok's black sphere, Gemini's sparkle, or an orb for anything else. Its subagents are tiny copies circling it. Click an agent (or its name tag) for its title, model, machine, repo and project, what it is doing and its subagents.
- **Seats.** The AgentFlow agents are the jobs; a live session working on one of an agent's cards is the one doing it. It sits at that agent's desk in the common area instead of a desk in its owner's room, as the same live mascot, with the agent's name and the card (such as **Builder · #12**) on its tag. An agent with nobody at its desk stands idle and dimmed. Click an agent for who is at its desk now, its queue (the first five cards, as `agents.work` orders them) and the cards it finished (moved to UAT or Done) in the last seven days. Allow and Deny still go only to the session's owner. See [Seats](#seats) for how a session finds its desk.
- **What they are doing.** A running agent acts out its kind of work (its [`activityKind`](#activity-kinds)), and its name tag starts with the matching sign: it types at its keyboard while it edits files (✏️), reads a floating book (📖), sweeps a magnifying glass while it searches (🔍), has terminal glyphs on its screen while it runs commands (⌨️), shakes a bubbling test tube that flashes green and red while it tests (🧪), thinks under a thought cloud (💭) or spins a little globe on the web (🌐). An idle agent is dim, and goes about the office calmly (☕): a while at its desk, at the coffee corner, in front of the board or a few steps away, 10 to 40 seconds at each, and now and then two idle ones meet and chat, with a small "…" over them.
- **Everyone walks.** Agents, AgentFlow robots and offline people move like people in a game: they walk along real paths, through doors and around desks, walls and each other (and you), and never jump from place to place. A new session comes in at its owner's room door (one seated at an AgentFlow desk, at the edge of the common area) and walks to its desk and sits down. A session that ends stands up, waves, walks out and fades. A session that gets seated walks from its room to the AgentFlow desk, and back when it is unseated. When a session picks up a new card it walks to the board, takes the card and carries it to its desk; when its card moves to UAT or Done it carries it to the board, puts it up and celebrates. Subagents trail behind their agent while it walks and circle it while it is still. When the office is laid out again (someone joins, the org changes), everyone walks to their new place, or fades over when it is far. Robots with nobody at their desk wander about the common area, and someone who just left the office walks from where they were to their place in the org. What each one does is chosen from its id and what the server says about it (status, kind of work, seat, card), so everyone in the office sees much the same scene.
- **Waiting gets your attention.** When an agent starts waiting on its person (⏳), it glows with a **!** and, if its owner is in the office, walks over to their avatar and hops beside them until it is answered, then walks back to its desk. If its owner is not in the office, it hops at its desk. For the owner, it also plays a short, soft ping; the speaker button in the office's top bar turns the sound off and on. Click the agent or its **!** for its panel, with **Allow** and **Deny** when the prompt can be answered from Flow.
- **Alerts outside the office.** Turn on **Notify me when agents wait** (the bell in the office's top bar). Then, while Flow is open in any tab with the office closed, each time one of your own agents starts waiting your browser shows a notification (the browser asks for permission once), and the **3D** button shows how many of your agents wait. Clicking the notification opens the office on that agent. Only you are alerted about your agents: never anyone else, even people who can see the agent's project. The setting is remembered with your preferences; turn it off with the same button.
- **Transcript.** Your own agent's panel shows the latest lines of its conversation (up to 12: what you asked, what it said, and one line per tool call), scrolled to the newest. Only you ever see it: not the environment's owner, not someone who can see its project. Reporters mask secrets before sending, and Flow masks tokens, keys, `Authorization` headers and `.env`-looking lines again on the way in.
- **Send to agent and Stop.** When its reporter can carry them out (T3 Code threads, through `flow office bridge` or another reporter that says so), your own agent's panel has a **Send to agent** box and a **Stop** button. Type a message and press **Enter** to send it (**Shift+Enter** for a new line): it reaches the agent as your next message, after its current turn when it is busy. **Stop** asks you to confirm, then interrupts its running turn. Each one shows as sending, then sent (waiting for the reporter), then how it went. While you type in the box, the movement and shortcut keys go to the box, not the office. Only the agent's owner ever gets these, they are rate-limited, and the reporter checks the agent is still the same before it acts. Claude Code in a terminal cannot be reached from outside, so its panel has neither.
- **Allow and Deny.** When your own agent waits on a permission prompt that its reporter can answer, its panel shows the prompt with **Allow** and **Deny**. Your answer goes to the reporter on that machine (usually within a second), and the panel shows how it went. Only the agent's owner ever gets these buttons. The agent nods (or shakes its head for Deny) the moment you click, and works with a few gold sparks over it until the answer is through; everyone in the office sees it react, never the prompt. The panel says **Approved** or **Denied** at once, **Running…** when the agent's next report has it working again, and the reporter's message in red if it did not go through. If nothing comes back in 20 seconds it says **Still waiting on** its machine.
- **People.** Everyone who has the office open is an avatar with a name tag (and their account photo when they have one). Each person has a look: a face, hair, an outfit and shoes. Until you choose one, yours is picked for you and stays the same every visit. See [Your look](#your-look).
- **Press E.** Walk up to an agent, a person or a board and a prompt says what **E** does there ("E Talk to Chief of Staff", "E Wave at Joe"); on a gamepad it is X / Square, and on a touch screen you tap the prompt. E again, Esc or walking away closes what it opened. The camera turns with **Z** and **C**.
- **Status.** Each person sets Available, Focus, Do not disturb or Away. It shows on their avatar, name tag and door sign. See [Status](#status).
- **Meeting room and voice.** A glass meeting room has its own place in the ring of rooms. Walk in to join its call: the first time, the browser asks to use your microphone. Everyone in the room hears everyone else, and walking out leaves the call. The sign at its door says who is in it ("Live: 3 in Meeting room"), and a green ring under an avatar shows who is speaking. Outside the room, **Talk to people nearby** in the voice bar (bottom right) lets you hear people within about 6 m who also have it on. Their voices get quieter with distance and come from their side. See [Voice](#voice).
- **Screen sharing.** In the meeting room, **Share screen** in the voice bar (or **E** at the table) shows your screen on the room's wall screen for everyone in the call. Click the wall screen, press **E** in front of it, or use the expand button to watch it full screen. One screen is shared at a time: if someone else is sharing, Flow asks before yours replaces theirs.
- **Knocking.** Someone else's room has a door. You walk in when they are available, away, or not here. Focus and Do not disturb keep it shut until they let you in. See [Knocking](#knocking).
- **Chat and emotes.** Type in the box at the bottom left (or press **T**). A message shows as a speech bubble over you for anyone standing nearby, and in everyone's chat log. Wave, thumbs up, clap and heart are the buttons beside it, or keys **1** to **4**. Click someone's avatar to wave, follow them (until you move yourself) or start a message to them.
- **Worlds.** The office can be the classic **Office** or a **Yacht**. See [Worlds](#worlds).
- **Several offices.** If shares from other people's environments are placed in yours, the office's title becomes a menu: pick a shared environment to enter its office as a member. The shared office opens first, until you pick another.
- **One office for a shared environment.** When you open an environment shared with you as a whole (see [Sharing](#sharing)), its 3D office is the owner environment's office: the same rooms, the same chat and the same people, so the owner and everyone it is shared with see each other live. Your own coding agents show in your room there, as in every office you are a member of.
- **Doors.** Each office has a glowing door, in a gap between the rooms, for every other office sharing connects you to and that you can enter, labelled with whose office it is ("Avery's office") and its environment's name: the offices of environments shared with you, the offices of your own environments that you share (where the people you share them with meet you), and, while you visit someone else's office, a door back to your own (**Your office**). Walk through a door, or click it or its label, to go there. You only ever see doors to offices you can enter.
- **No longer shared.** If the share is revoked while you are in its office, the office says it is no longer shared with you, you leave it at once (everyone else sees you go), and it does not reconnect.
- **Local mode.** Without sign-in, the office opens with just you and your AgentFlow agents, and your own reported agents.

## Day replay

Select **Replay** in the office header and pick a day. Drag the timeline to a time or use **Play** at 1×, 10×, 60× or 300×. The activity graph marks new waits in orange and cards that reached UAT or Done in green. The timeline also shows who was present at the selected time. Replay uses the current office layout. You can still move the camera, and alerts for your live agents appear while you watch. Select **Live** to return to the current office.

Flow keeps up to 14 days of office history. It records agent arrival and departure, running, waiting and idle states, activity kinds, desk assignments and card numbers. It also records when people enter or leave, samples their movement at most once every two seconds, and marks card column moves, emotes, Allow or Deny decisions, and that a chat message was sent. Busy offices keep fewer movement samples so the log stays bounded.

The history stores no prompts, transcripts, agent messages or chat text. Only office members can read it. When you open a day, Flow uses your current access to decide which desks and cards you can see. Private agents show as mascots with their status and activity kind, as in the live office. Revoking a share also ends access to the recording through that share.

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
| Edit your look | Press **L**, select the shirt button, click yourself, or press **E** at the mirror in your room or on yourself |
| Gamepad | Left stick to walk, right stick to orbit, **A** to jump, **B** or **X** to sprint |
| Mute / unmute | **M**, or the mic button in the voice bar |
| Push to talk | Hold **V** (turn it on in the voice bar's settings) |
| Meter details | Walk up to a meter and press **E**. **E** opens it only while you are next to it; elsewhere **E** is the usual interact |

## Voice

The meeting room is in the classic office; on the yacht, **Talk to people nearby** works but there is no meeting room yet. The voice bar sits at the bottom right of the office. Its button walks you to the meeting room, and **Talk to people nearby** turns proximity voice on for this visit. While you are in a call it shows where you are and how many people are connected. It also has:

- **The mic button.** It shows whether you are heard: **Mic on** (green), **Muted** (red), **Hold V to talk**, or **Listening only** when the browser was refused the microphone. Click it or press **M**.
- **Deafen.** You hear nobody, and nobody hears you.
- **Share screen.** Shown in the meeting room only.
- **Settings.** Pick a microphone and, where the browser can, a speaker. Turn on push to talk (hold **V**). These choices are kept in this browser.

Keyboard shortcuts never fire while you type in a text field. When you leave a room or turn proximity voice off, the browser gives the microphone back. If the browser blocks sound until you interact with the page (common on phones), the bar shows **Tap to hear**.

**Do not disturb** keeps you out of proximity calls: nobody is connected to you nearby until you change your status. People in Do not disturb are never connected to you either. Walking into the meeting room is your choice, so the room's call ignores it. All calls end when the office closes or the tab has been hidden for more than two minutes, and pick up again when you come back.

**Privacy.** Audio and video go straight between browsers over WebRTC, end-to-end encrypted with DTLS-SRTP. Flow's server only passes the connection set-up messages between two people in the same office. It never records anything, keeps no media, and does not log those messages. When two browsers cannot reach each other directly, a TURN relay you configure carries the encrypted stream (see [docs/self-hosting.md](../self-hosting.md#voice-and-screen-sharing)). Calls are a mesh, which works well for up to about 8 people in one call.

## Meters

Each room has a small screen beside the door, and the common area has one beside the main board. They show, for that member or for the whole office:

- how many agents are running, and how many are waiting, right now
- cards shipped today: moved to UAT or Done since midnight in your timezone (the browser's)
- points shipped this week: the sum of `actual` on those cards, or `points` when a card has no actual. The week starts on Monday
- a sparkline of how many agents were running over the last 24 hours, sampled on the server once a minute and kept in memory

The office meter also shows how many of your own agents are waiting on you. The screens redraw only when the numbers change. Stand next to one and press **E** to open the same figures in a panel.

The meter adds up today’s tokens and estimated cost for the reported agents you can see. Today starts at midnight in each reporter’s local timezone. The [office bridge](https://github.com/aribradshaw/flow/blob/main/docs/office-bridge.md) reads completed T3 provider turns, Claude Code message usage, and Codex CLI token-count events. Sessions without usable data contribute no usage and unknown models contribute tokens only. When no agent sends a figure, the meter shows “—”. Cost is an API-equivalent list price estimate. Subscription plans may include the usage shown here.

Counts use only what you can already see. A card outside your access is not counted. Another member's private agent adds only to the running and waiting numbers, which are already its public status. Its tokens and cost are not sent to you.

## Status

The header has a status control: **Available**, **Focus**, **Do not disturb** or **Away**, and an optional note of up to 60 characters (for example "on a call"). The choice is kept in this browser, and in the server's memory while this Flow process is running, so a reload keeps it and everyone in the office sees it. A coloured ring and an icon sit on the avatar and the name tag, and on the room's door sign. Green is available, amber is focus, red is do not disturb, and grey is away.

Away is also set on its own after 10 minutes with no input while the tab is hidden, and clears when you come back (the tab is visible again, or you press a key or click). An Away you picked yourself stays until you change it.

While someone is in **Do not disturb**, waiting-agent pings and notifications are held and only the badge shows, until they leave it. That includes the browser notification from **Notify me when agents wait**: the badge on the **3D** button still counts them, and the notifications show when they leave Do not disturb. Activity code checks `status.isQuiet(userId)` from `public/office-status.js` before it pings. `userId` is the office member key. When that is true, call `status.notePing(userId, ping)` instead of announcing; it returns `{held: true, count}`. `status.takeHeld(userId)` returns what was held once they leave. The same check on the server is `officeHub.isQuiet(userId)`, and there `userId` may be the member key or the person's email. Pings the office already knows about (an agent that starts waiting) go through this hook on their own.

## Knocking

Each room has a door at its entrance (a themed office can place that door by answering `doorAnchor(room)` with a world position; otherwise it sits in the doorway). The door stops you until it is open. It is taller than a jump, so the way in is the door. On a raised deck the door still stands on that deck. These are room doors. The glowing doors between offices are separate: those are [Doors](#3d-office) to another environment.

Your own room is always open. So is a room whose owner is not in the office, and a room whose owner is **Available** or **Away**: you walk in, and if they are here they hear a soft chime and see "Joe came in".

**Focus** stops you at the door with a Knock prompt (**E**, or the button). Knocking tells only them, with a knock sound and **Let in** / **Not now**. Let in opens that door for 2 minutes. Not now tells you "Joe is focusing". **Do not disturb** is the same door, with no sound for them and only a badge ("2 knocks", or "1 knock") until they leave Do not disturb, when the knocks show. Not now then says they do not want to be disturbed.

A knock is one per 10 seconds between the same two people. Letting someone in, turning them away, and the "came in" notice go only to those two, and only in that office.

## Worlds

An environment's office is drawn as one of two worlds. Everyone who enters sees the same one.

- **Office** (the default). Rooms in a ring on one floor, with the common area in the middle.
- **Yacht.** A superyacht under way at sea. The AgentFlow org stands in the sunken seating of the main-deck lounge, with the main board on the wall ahead of it. Stairs lead up to the upper deck, where each member has a cabin with their name at the door and their board on its back wall. The environment's owner has the bridge at the front. Above the cabins is the sundeck with a pool and a bar, forward of the bridge is the helipad, and at the stern steps go down to the swim platform, where doors to other offices stand. Rails keep you on board unless you jump them. Jump a rail or walk off the swim platform's open end and you fall in with a splash, then come back on the nearest deck.

To change the world, open the office of your own environment and pick **Office** or **Yacht** in the menu beside the environment's name. The choice is saved with the environment (in its AgentFlow data, as `office.world`), so it syncs like any other edit and applies to everyone, within about 15 seconds for people already inside. When you visit a shared environment's office you see the world its owner picked, and the menu is hidden.

The yacht's deck sways a little. **Sea motion** in the controls panel (**?**) turns that off; it starts off when your system asks for reduced motion. The setting is kept in this browser.

The yacht's decks are terraced and never stacked, so each spot has exactly one floor height and everyone agrees where a person stands.

## Your look

Press **L**, use the shirt button in the header, click your own avatar, or walk up to the mirror by the door of your room and press **E**. Standing still for a moment with nothing else in reach offers **E** on yourself too. The editor fills the screen, with you on a turntable: drag to turn, scroll or pinch to zoom in to your face. Walking pauses while it is open.

Each tab is one part of you, with every choice shown as a small picture of you wearing it:

| Tab | Choices |
| --- | --- |
| Body | Skin tone (twelve tones, or any colour), build and height |
| Face | Eyes and eye colour, eyebrows, nose, mouth, facial hair, glasses, freckles and blush |
| Hair | Twelve styles, from buzz cut to braids, and a colour |
| Hat | Cap, beanie, bucket hat, captain's hat or headphones, and a colour |
| Top | T-shirt, hoodie, button-up, blazer, sweater or tank top, with a colour and an optional pattern in an accent colour |
| Bottoms | Jeans, chinos, shorts, skirt or joggers, and a colour |
| Shoes | Sneakers, boots, loafers or sandals, and a colour |

**Randomize** tries a new look, **Undo** steps back (also Ctrl or Cmd+Z), and **Reset to default** returns to the look picked for you. The buttons under the preview play a walk, a run and the four emotes. Nothing changes for anyone else until you press **Save**; then everyone in the office sees it at once.

Your look belongs to you, not to one office: it follows you into every office you are in, and it is saved on the server (in Postgres, or under `BACKUP_DIR`), so it survives a restart. Only you can change it. The server accepts only the listed choices and plain colours, and keeps colours from being pure black or pure white so a face stays readable.

People blink, look around, shift their weight and fidget while they stand, swing their arms when they walk or run, and move their mouth while their speech bubble shows. Each emote has its own face: a wink with the thumbs up, closed smiling eyes with a clap, a blush with the heart.

## Who sees what

Agents belong to a person, not to an environment: they show in the office of every environment that person is a member of. For each viewer, Flow decides on the server what leaves it:

| Viewer | Sees |
|---|---|
| The agent's owner | Everything, plus Allow / Deny, its transcript, and Send to agent and Stop |
| Someone who can see the Flow project the agent's repo belongs to | Everything except the buttons and the transcript: title, model, machine, repo, project, activity, subagents and the prompt |
| Anyone else | Only the mascot, the vendor and running / waiting / idle, labelled **Private project** |

The environment's owner (and anyone else who can read the whole environment) sees all its projects. A share's recipient sees the projects in their share's scope; a whole-environment share means all of them. An agent whose repo is in none of the environment's projects is private to everyone but its owner, including the environment's owner. Nothing about a private agent (its title, activity, repo, model, prompt, machine, model use or id) is sent to that viewer's browser. A share's recipient also sees only the AgentFlow agents linked to the projects they can see.

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

- `PUT /api/v1/office/agents` (`office.agents.report`) with `{source, at, agents:[…]}`. Each agent: `id` (stable within the source), `title`, `vendor` (`claude`, `codex`, `gemini`, `deepseek`, `grok` or `other`; with `other` the mascot is picked from the model when it names one), `model`, `status` (`running`, `waiting` or `idle`), `activity`, `activityKind` (optional, see [Activity kinds](#activity-kinds)), `host`, `hostLabel`, `repo` (`{name, remote}` or `null`), `children` (subagents: `id`, `title`, `vendor`, `model`, `status`, `activityKind`), `pending` (`null`, or `{requestId, kind: approval | question, summary, can: ["allow","deny"]}`) `agentflow` (optional, `{agent: "<AgentFlow agent id or name>", card: <card number or id>}`: the AgentFlow agent and card it works on, which seat it at that agent's desk; see [Seats](#seats)) `can` (optional, `["message","stop"]`: what the owner may do from the office besides Allow / Deny; list only what this reporter can carry out, `[]` or none for agents that can only be steered where they run) and `transcript` (optional, `[{role: user | assistant | tool, text, at}]`, oldest first: the last 12 are kept, each `text` up to 400 characters, other roles dropped; shown only to the owner, and masked again on the server) and `usage` (optional, `{tokens, costUsd}` for the reporter’s local day. Each field is independently optional and must be finite and nonnegative. Someone who cannot see the agent does not receive it), `role` (optional, `"conductor"` for the person's [Chief of Staff](#chief-of-staff); a conductor is private to everyone but its owner, whatever its repo: they see only that it is one, and its status) and `reply` (optional, a conductor's latest reply, `{text, at, cards}`: `text` up to 600 characters, `cards` up to 12 card numbers; owner only, like the transcript, and masked again on the server). Each source replaces only its own agents; up to 200 agents and 20 children each are kept, long strings are cut, and credentials in a remote are dropped. The answer is `{actions:[…]}`: the actions for this source not yet delivered (see the next item).
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
| `idle` | Nothing | Goes for coffee, looks at the board, chats with another idle agent |

It is optional and backward compatible. When it is missing or not one of these, Flow works it out from `activity`: first a tool name at the start (`Edit lib/auth.mjs` is `edit`, `Read`, `Grep` and `Glob`, `Bash` and `WebFetch` likewise, and `Bash: npm test` is `test`), then words in it (`Running tests` is `test`, `Reading the docs` is `read`, `Searching for callers` is `search`). Anything else is `think`. An agent whose `status` is `idle` is always `idle`. A subagent's kind is worked out from its `activity` or else its `title`.

Send `activityKind` when your reporter knows the tool an agent is using: it is more accurate than the guess from text. It is shown to everyone who can see the agent, including people who see it only as **Private project**: the kind of work says nothing about the work itself.

## Decorating your room

Inside your own room a **Decorate** button opens a catalogue of props: three plants, a rug, a lamp, a bookshelf, a sofa, an armchair, a coffee table, a poster, a trophy, an aquarium, an arcade cabinet, a bean bag, a standing desk, a whiteboard, a neon sign and a trinket. The ghost snaps to a 0.25 m grid, and wall pieces (posters, the whiteboard, the neon sign) snap onto a wall. R rotates a floor piece, Delete removes the selected one, and Esc leaves the mode. A room holds at most 40 props. They cannot sit outside the room or block the door, a desk, the board or a path, and solid props become obstacles for you and for agents walking through the room. Rugs and wall pieces do not.

A theme sets the floor and wall from a fixed palette (paint, wood, plaster or tile), or one of four presets: Minimal, Cozy, Neon and Nautical. The neon sign takes a short line of text, up to 20 characters, with control characters and markup stripped.

`POST /api/office/{env}/decorate` with `{theme, props}` saves that room for its owner only. The server checks the same rules as the page and does not trust a room size sent by the client. Everyone in the office hears a `decor` event, and the next snapshot includes `decor` for each member. It is stored with the office's other durable state (Postgres, or the file fallback).

## Sharing

An office's members are its environment's owner and the recipient of every active share of that environment (any scope; a whole-environment share also shows all its projects and AgentFlow agents). Opening an environment shared with you as a whole (docs/sharing.md, `share-<shareId>`) opens the owner environment's office: `/api/office/share-<shareId>/…` resolves to it for the share's recipient and is 404 for anyone else, like any office you are not a member of. What each viewer sees there follows [Who sees what](#who-sees-what), per viewer, unchanged.

The snapshot carries `portals: [{env, label, sub, own}]`, the doors for this viewer (computed on the server from their shares). When a share is made or revoked, open offices get a `portals` event with their doors as they are now, so a door appears or goes at once. Access is checked again on every heartbeat, and at once when a share is revoked (from the app, the API or MCP): a stream that lost access gets a `gone` event and is closed, and its person leaves the office for everyone else.

## How it runs

The office is live over Server-Sent Events: `GET /api/office/{env}/events` sends a snapshot (rooms, AgentFlow agents, live agents as this viewer may see them, who is here, each member's presence, and the last 50 chat lines, and the viewer's own live reporter sources), then moves, presence, chat, emotes, agent updates and answer results as they happen, with a heartbeat every 15 seconds. Moves (including an optional short status line saved with last-seen), chat (up to 280 characters), emotes, room decor, answers and steering are small POSTs to `/api/office/{env}/presence`, `say`, `emote`, `decorate`, `answer` and `steer` (`{kind: "message", source, agentId, text}` or `{kind: "stop", source, agentId}`; `answer` takes the same body, and a body without `kind` is Allow / Deny). Presence is `POST /api/office/{env}/status` with `available`, `focus`, `dnd` or `away` and a note of up to 60 characters. A knock, letting someone in, and walking into an open room are `POST /api/office/{env}/knock`, `admit` and `enter`. All of these are rate-limited per person. There is no API key operation for sending messages or stops: they come only from the signed-in owner in the office. Only the app's own page can call them, signed in. The events stream also takes an API key with the `read` scope for that environment (`Authorization: Bearer flow_…`), so a dashboard can watch the office. A stream that stops hearing heartbeats reconnects by itself; the header says "Reconnecting…" only after eight seconds without a stream.

Voice (`lib/office-rtc.mjs`, `public/office-voice.js`) is signalled through the office stream. Each open connection gets an opaque peer id (`rtc {type: "welcome", peer, peers}`). The browser posts `POST /api/office/{env}/rtc {from, to, type, data}`, where `type` is `state` (its voice state: `room`, `near`, `dnd`, `muted`, `share`; sent to the whole office) or `offer`, `answer`, `ice` or `bye` (sent to the one peer `to`). The server checks that `from` is one of the caller's own open connections and that `to` is in the same office. An `offer` also needs both people in the same room's call, or both with proximity voice on outside rooms and neither in Do not disturb. Payloads are capped at 24 KB and rate-limited per connection. They are passed on as `rtc` events and never stored or logged. `GET /api/office/{env}/rtc` returns `{iceServers, ttl, turn}` for `RTCPeerConnection`.

Alerts outside the office use one more stream, `GET /api/office/alerts`, which the app keeps open only while **Notify me when agents wait** is on. It belongs to the signed-in person and has no environment: it sends `mine` (`{waiting:[…]}`, their own agents that are waiting now) when it opens and whenever that changes, and `waiting` (one agent) each time one of their agents starts waiting or waits on a new prompt. An agent's first report from a source (a reporter starting, or the server restarting) does not count as starting to wait. Only the app's own page can open it, signed in; API keys cannot.

During a reconnect, the office keeps the last scene and chat. The next snapshot updates that scene, and each browser sends its last position and status again. A source event ID identifies the previous connection; the server sends a fresh, access-checked snapshot on each connection. Reports keep their original timestamps, and a report still expires 90 seconds after the server last received it. The latest 50 chat lines per office, member status and last-seen times, each person's look, and recent actions are saved in Postgres or under `BACKUP_DIR`. Live avatar positions remain in memory. Office actions are claimed before they are returned, so a restart cannot return an already claimed action a second time. If the connection dies between the claim and the response, the reporter can miss that action.

The 24 hour sparkline of how many agents are running (one sample a minute, per member) stays in memory, and is kept across a restart only when a persistence module exports sparkline load and save.

The office is drawn with [Three.js](https://threejs.org) (MIT), vendored in `public/vendor/three` and loaded only when the office opens.
