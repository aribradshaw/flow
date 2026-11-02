# AgentFlow

AgentFlow is an org chart for agentic work. You lay out the agents that do work for a business, say what each one is for and what it takes in and produces, chain them into workflows, and tie them to the projects, DevOps cards and deadlines they own.

Flow stores the design. It does not run agents itself. A runner of your choice (an agent harness, a home server, a cron job) reads an agent's or workflow's **brief** through the API or MCP and does the work, then reports back on the DevOps cards like anyone else.

## Agents

An agent has `name, kind, title, status, live, reportsTo, supervisor, purpose, instructions, runtime, models[], model, auto, schedule, inputs[], outputs[], tools[]`, an optional `job`, and links `projects[], cards[], items[]`.

- `kind`: `agent` (an AI agent), `human`, `team` (a group heading in the org) or `automation` (a scripted job without AI, such as a backup timer, that runs on its own schedule outside Flow; see [Automations](#automations)).
- `schedule` says when it runs, in plain words or cron, such as "Weekdays 09:00" or `30 22 * * *` (`""` for none). For an AI agent, its runner starts it then.
- `job` is `{runner, id}`: the runner job it was promoted from (see [Scheduled jobs](#scheduled-jobs)). It is absent when there is none; send `null` or `""` to `agents.update` to clear it.
- `status`: `draft`, `active`, `paused` or `retired`.
- `reportsTo` is another agent. Together these form the AgentFlow org chart. An agent cannot report to itself or to anyone below it (`reports_loop`). A saved loop is broken when the workspace loads.
- `supervisor` is a person card on one of your mind maps: the human accountable for the agent. A `human` agent shows a person's photo: its supervisor's, else that of the only person card with the agent's name, else your account photo when the agent has your account name and no person card does.
- `inputs`, `outputs` and `tools` are short text lists, such as "A card in Doing" or "Pull request linked on the card".
- `instructions` holds the system prompt or runbook. `runtime` says where it runs (a runner's name).
- `models` lists the models it may run on, up to 10 ids from its runner, in order: the **primary** first, then **fallbacks** the runner tries when one fails (a rate or usage limit, a provider that is down). `model` is always the first of them, kept for older runners; sending `model` alone to `agents.update` sets `models` to just it, and when both are sent `models` wins.
- `auto` turns `models` into a pool: the runner picks one per card instead of always starting on the first. The org card shows **Auto (N models)**, or the primary model and **+N** for its fallbacks.
- `live` is the switch runners obey. It is off for every new agent, and a runner leaves an agent that is not live alone, whatever its status. Turn it on in the agent's side panel, or with `agents.update` (`live: true`). The org card then shows a **Live** badge, in amber when its runner would skip it (no runner or model picked, or a model its runner did not report).
- Deleting an agent moves its direct reports up to its manager, and its workflow steps become unassigned.

## Runners

A runner is a machine or service that runs agents, such as a home server with agent harnesses installed. It tells Flow what it can run with `runners.report`: its name and the models it offers, each with an id, a label and optionally a `provider` to group it under (such as "Claude" or "OpenCode") and `billing`: `included` (covered by a subscription, or free) or `metered` (paid per use). `runners.list` returns them. In an agent's side panel, **Runs on** suggests the reported runners and **Models** that runner's models, and every org card shows where the agent runs and on which model. Reporting the same models again saves nothing, so a runner can report on every pass.

```sh
flow runners report --input '{"runner":"Home server","models":[{"id":"claudeAgent:claude-sonnet-5-5","label":"Claude · Sonnet 5.5","provider":"Claude","billing":"included"}]}'
```

`tools/agent-runner.mjs` is a reference runner for [T3 Code](https://t3.codes): it reports the providers and models signed in on its machine, and for each live agent whose `runtime` is its name, starts a T3 thread on the agent's model for the top card in its queue, then moves the card to UAT when the thread finishes. If a model will not start, or its thread fails or hits a limit, it starts the card again on the next model and keeps every attempt; when all have failed it leaves the card and logs it. For an `auto` agent it prefers `included` models over `metered` ones, keeping the pool's order, and can ask a small "router" model to choose among the included ones from the card and the agent's purpose. It marks Claude, Codex, Cursor, Grok and Antigravity models `included`, OpenCode's own free models (`opencode/…`) `included` and other OpenCode models `metered`, and its settings can override that. It starts in dry-run mode, so it only prints what it would do until you turn that off. See the comment at the top of the file for its settings.

## Scheduled jobs

A runner can also tell Flow which scheduled jobs it found: systemd timers, crontab lines, scheduled T3, Claude or Aside tasks, Codex automations, Vercel or Railway crons, GitHub Actions schedules, Windows scheduled tasks. It sends them as `jobs` in the same `runners.report` call, up to 500 per runner:

| Field | |
|---|---|
| `id` | Required, up to 200 characters, stable per runner, e.g. `systemd:backup.timer` or `vercel:my-app:/api/cron/sync`. |
| `name` | Up to 120 characters (defaults to the id). |
| `source` | Where it is scheduled, up to 40 characters: `systemd`, `cron`, `t3`, `vercel`, `railway`, `aside`, `windows`, `claude`, `codex`, `github` or `other` (the default). Other text is kept as it is. |
| `group` | A display group, up to 120 characters, e.g. "Home server" or "Vercel · my-app". |
| `schedule` | When, in words, up to 200 characters: "Daily 22:30", "Every 5 min". |
| `cron` | The cron expression, when there is one (up to 120). |
| `timezone` | The zone its times are in, up to 64 characters: an IANA name such as `America/Phoenix`, `UTC`, or `local` (the runner's own zone; see below). |
| `triggers` | Every rule it fires on, up to 10: `{kind, expr, text}`. `kind` is `cron`, `calendar` (a calendar rule such as a systemd `OnCalendar` line or a daily or weekly Windows trigger), `interval`, `logon`, `boot`, `once`, `rrule` (RFC 5545), `manual` or `other`; `expr` is the raw expression as the scheduler holds it (up to 200), such as `*/5 * * * *`, `Mon *-*-* 09:00:00` or `OnUnitActiveSec=5min`; `text` is it in words (up to 200). |
| `origin` | Where the schedule was read: `repo` (a config file in a repo), `platform` (the hosting platform's API) or `machine` (the machine's own scheduler). |
| `file` | The repo-relative path of the config it came from (up to 200), such as `services/worker/railway.json`. |
| `drift` | How the platform's live schedule differs from the repo file, when it does (up to 200). |
| `note` | Conditions the job's script applies itself, such as "Exits early when nothing changed" (up to 500). |
| `command` | A short summary of what it runs (up to 300). |
| `ai` | `true` when the job starts an AI agent. |
| `enabled` | `false` when it is switched off on the runner (default `true`). |
| `lastRun`, `nextRun` | ISO times. |
| `lastStatus` | `ok`, `failed`, `running` or `unknown` (the default). |

The report can also say the runner machine's `timezone` (an IANA name), which jobs with `timezone: "local"` are in; left out, the stored one stays. `jobs` replaces the stored list. Leave it out to keep the stored jobs, or send `[]` to clear them. `models` is optional too: leave it out to keep the stored models, as a runner does when it reports the jobs of another machine it reaches over SSH. To keep writes down, a report is not saved when the only changes are `lastRun` and `nextRun`, unless the jobs were last saved six hours ago or more. A changed `lastStatus`, a job added or removed, or any other field (a new trigger, drift or note) always saves. The runner's `jobsReported` is when its jobs were last saved, and the response's `changed` says whether this report was.

```sh
flow runners report --input '{"runner":"Home server","models":[],"timezone":"America/Phoenix","jobs":[{"id":"systemd:backup.timer","name":"Nightly backup","source":"systemd","group":"Home server","schedule":"Daily 22:30","timezone":"America/Phoenix","triggers":[{"kind":"calendar","expr":"*-*-* 22:30:00","text":"Daily 22:30"}],"origin":"machine","command":"restic backup /srv","lastStatus":"ok","lastRun":"2026-11-02T05:30:00Z","nextRun":"2026-11-03T05:30:00Z"}]}'
```

In the app, **Scheduled** in the org chart's toolbar opens a tray on the left of the canvas. It lists every runner's jobs by runner and group, each with its source icon, name, schedule and a dot for the last run (green OK, red failed, grey unknown). Hover the dot for the last and next run. A row names the time zone (such as `UTC`) only when it is not yours and the schedule has a time of day, and shows an amber dot when the schedule has drifted from its repo file. Click a row, or its **i**, for the job's details: the schedule in words, every trigger with its raw expression, the time zone (always named; a `local` job shows its runner's zone), where it was read (**Repo file** with the file's path, **Platform** or **Machine**), drift in amber, the note, the command, the last run and its status, the next run (when, in your time and the job's zone), whether it starts an AI agent and whether it is enabled. **Promote to org** is there too. Escape or a click elsewhere closes it. A group with more than eight jobs starts collapsed to a chip such as "59 jobs" that opens it. Search filters the tray too. Whether the tray is open, and which groups you opened or closed, is remembered on this device.

The reference runner (`tools/agent-runner.mjs`) reports the jobs it finds with every `report` and `tick`: systemd user and system timers (stock distribution timers such as apt-daily, fstrim and logrotate are skipped), the user's crontab, T3 scheduled tasks (read only from T3's database; needs Node 22.5+ for `node:sqlite`), and cron configs in your repos: `vercel.json` crons, `cronSchedule` in `railway.json`/`railway.toml`, and `on.schedule` in GitHub Actions workflows. Repos default to your T3 projects' folders. Commands are summarised on one line with anything that looks like a secret hidden. Every job comes with its full schedule: its `timezone` (this machine's zone, from `timedatectl` or Node; the zone an `OnCalendar` line names; a crontab's `CRON_TZ`; UTC for repo crons), its `triggers` (each `OnCalendar` line as a calendar trigger, `OnUnitActiveSec` as an interval and `OnBootSec` as boot; each crontab line; T3's schedule as T3 holds it), its `origin`, and for repo crons the `file`. Run `node tools/agent-runner.mjs jobs` (or `jobs --json`, with every field) to see the list without contacting Flow; the table has **TZ** and **ORIGIN** columns, and `!` after the origin marks drift. Tune it with `"jobs"` in `runner.json`: `sources`, `repos`, `exclude`, `include` (keeps a job even when `skipDistro` or `exclude` would drop it), `skipDistro` and `notes`; `"jobs": false` stops reporting jobs and leaves the stored list as it is.

**Notes.** For a Railway cron, the runner reads the README in the service's folder (else its start command's script, and for a Vercel cron its route's source) and takes the first sentence that says it runs every N minutes, exits, or applies a condition ("only when", "unless", "unchanged", "skips", "does not run"), plus the first condition after it when both fit in 200 characters. It never uses a sentence that mentions a token, secret, password or credential, and hides anything that looks like one. `"notes": {"<job id or name>": "text"}` in `"jobs"` (globs or substrings, first match) wins; `""` removes a note.

**Platform schedules.** A repo file says what should run; the platform says what does. With a token, the runner reads the live cron schedules and matches them to the repo's cron configs:

- `railwayToken` (or `RAILWAY_API_TOKEN`): every service's cron schedule and next run from Railway's GraphQL API, matched to `railway.json` configs by service name (`railwayWorkspace` picks a workspace's projects).
- `vercelToken` (or `VERCEL_TOKEN`): each project's crons from Vercel's API, matched to `vercel.json` by the folder's `.vercel/project.json` link, else by project name (`vercelTeam`, a team id or slug, for team projects).

A matched job is reported as the platform runs it (origin `platform`, with its `file` kept) and its next run from the platform, and `drift` says how the file differs, such as "Railway runs `*/10 * * * *` (Every 10 min); services/worker/railway.json has `*/5 * * * *` (Every 5 min)", or that the platform has no cron for it. A live cron that no repo file has is reported too. Without a token nothing is asked; `"platform": false` in `"jobs"` turns it off. Put tokens only in your own `runner.json` (or the environment), never in a repo.

### Remote machines

The reference runner can also read the scheduled jobs of other machines over SSH, such as a Windows laptop, and report each one as a runner of its own, named after it. It sends that runner's `jobs` only, so the remote shows in the Scheduled tray (and its jobs can be promoted) without any models. List them as `"remotes"` in `runner.json`:

```json
"remotes": [{"name": "Laptop", "ssh": ["ssh", "-i", "~/.ssh/laptop_key", "-o", "BatchMode=yes", "me@laptop"],
             "python": "C:\\Python\\python.exe", "timezone": "America/Phoenix"}]
```

- `ssh` is the ssh command as a list, ending with the host. Use a key and `BatchMode=yes` so it never asks for a password. The remote's login shell may be `cmd.exe`: the runner sends its scripts on stdin, PowerShell through `powershell -EncodedCommand`, and Python when `python` (the path to `python.exe` on the remote) is set. Both scripts only read.
- `timezone` is the remote's time zone (an IANA name). Its cron lines and schedules are read in that zone, and its jobs and runner report it. It defaults to the runner's own.
- `sources` picks what to read (all by default):
  - `windows`: Task Scheduler tasks outside `\Microsoft\`, with their triggers in words ("Daily 18:00", "Every 15 min", "At logon", "On demand") and each trigger's raw settings (its type, start, days and repetition, such as `TimeTrigger, start 2026-10-15T08:51:32-07:00, repeat PT15M`), last and next run, and status from the last result. Vendor updater tasks (Adobe, Edge, Google, Zoom, McAfee, HP, OneDrive and so on) are skipped unless `skipVendor` is `false` or `include` names them.
  - `aside`: Aside routines, active and paused (`keepDone` adds completed ones). Each shows its schedule from its RRULE (one-shots as "Once Nov 1 18:00"; the raw rule and its TZID are its trigger and zone), its model and prompt, and its last run. A routine waiting for approval shows as running, with "Waiting for approval". One whose next run has already passed is marked "(stale)". Needs `python`: Aside's database is copied to a temporary folder, read and removed.
  - `claude-desktop`: Claude desktop scheduled tasks, with what each one does taken from its `SKILL.md`.
  - `codex`: Codex automations, from their RRULE or cron line and status. One-shots whose runs are used up are skipped (`keepDone` keeps them, marked "(done)"). With `python`, the last run of each cron automation comes from Codex's database.
  - `vercel`, `railway`, `github`: cron configs in the repos listed in `repos` (paths on the remote).
- `include`, `exclude` and `notes` work as in `"jobs"`. `timeout` is in seconds for the whole remote (40 by default), and `enabled: false` turns a remote off.

`tick` reads the remotes after its own pass, at most every 15 minutes, and keeps the time in its state file. `report` reads them every time. A remote that cannot be reached is logged and tried again next time, after one retry if the connection fails, and it never holds up the local pass. Run `node tools/agent-runner.mjs jobs --remote Laptop` to see a remote's jobs without contacting Flow, or `jobs --all` for this machine and every remote.

### Promoting a job

To put a job in the org, do one of these:

- Drag the job onto an agent's card. It becomes that agent's report.
- Drag it onto empty canvas to place it at the top level, right there.
- Click **Promote** on the row (top level).
- Right-click it and choose **Promote to org**, or **Promote under** the selected agent.

The new agent is selected and its side panel opens. Undo removes it again. A job without AI becomes an **automation**, and an `ai` job becomes an AI agent whose `runtime` is the runner (pick its models, then switch it to Live). Either way the agent is named after the job, its role comes from the source (such as "Vercel cron" or "systemd timer"), its `schedule` is the job's (or its cron line), its purpose is the command, and its status is Active, or Paused when the job is disabled. It is never live, and `job` links it back. A job is promoted once: its row then shows **Promoted** (click it to select the agent), and promoting it again selects the agent it already became.

## Automations

An automation (`kind: "automation"`) is a scripted job in the org with no AI in it. It runs on its own schedule, outside Flow, so it has no runner, no models and no Live switch: `live` is always false, and a runner never works it. Its card is shorter and grey, with a gear, and shows its schedule (and its job's last status) where an AI agent's card shows its runner and model. Its side panel has a **Schedule** section with the schedule, and, when it came from a runner job, the same details as the Scheduled tray shows for it under **Promoted from**: triggers with their raw expressions, time zone, origin and file, drift, note, command, last and next run (read-only, as the runner reports them). An AI agent's `schedule` is under **Runs on**, and its card shows a small clock when it has one.

The brief lists `Schedule: …` and `Promoted from: <runner> · <job name>` under Runtime.

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

The AgentFlow tab has two views: **Org chart** (`1`) and **Workflows** (`2`). **Scheduled** opens the tray of runner jobs (see [Scheduled jobs](#scheduled-jobs)). The org chart is a canvas like the MindMap: drag empty space to pan, scroll to zoom, drag a card to move it (Shift: with its reports), and drag the dot under a card onto another agent to make that agent report to it, or onto empty space to add a new report. Each AI agent's card shows small icons for the makers of its models in the bottom-right corner (the primary first, then up to two fallbacks and "+N"), or one auto symbol with a count when it is on Auto, and its supervisor's face sits on the corner of its avatar. Double-click empty space to add an agent. **Tidy up** returns to the automatic tree. In the tree, a manager's reports that have no reports of their own are stacked in indented columns (up to six per column) once there are three or more, so a large team stays compact and no reporting lines cross. Positions are saved as the agent's optional `x` and `y`. An agent without them, such as one added through the API, is placed under its manager, below the last of its teammates. `N` adds an agent under the selected one, `W` adds a workflow, `/` searches, `F` fits the org, arrow keys nudge the selected agent. Right-click (or the menu key) opens a menu on an agent, a reporting line, a workflow card or empty canvas: change kind, status or manager, add the agent to a workflow, open its work queue on the DevOps board, duplicate a workflow, and so on. **Start from a template** creates a small example org and workflow to edit. A DevOps card's detail shows the agents linked to it, and you can assign agents from there.
