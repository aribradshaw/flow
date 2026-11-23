# Connect local coding agents to Flow’s 3D office

Run the bridge on each computer where you use T3 Code, Claude Code, or Codex CLI. It reports your local agents to the office under the account that owns the Flow API key. The bridge reports about every three seconds. If a computer stops reporting, its agents disappear after 90 seconds.

Flow only shows other members an agent’s details when its repository matches a project they can access. Set the project’s `repos` field to the repository’s origin URL or slug. Otherwise the agent appears as **Private project** with its status. Reports to Flow include the host name, thread titles, recent activity, and prompt summaries. Preview a snapshot before connecting if those fields may contain sensitive information. The bridge resolves Git remotes locally and strips URL credentials, query strings, and fragments.

## Install and run

1. Install Node.js 24 or later and Git. Node.js 22 builds with `node:sqlite` enabled also work. For remote approvals, install the `t3` command and keep the local T3 Code server running.
2. Install the Flow CLI from the project repository.

   ```sh
   npm install -g github:aribradshaw/flow
   ```

3. In Flow, open **Settings → Connect → New key**, choose **Read & write**, and click **Create key**. Copy the key when it appears. Save it to the CLI configuration by replacing the example server URL with your Flow URL and piping the key into `flow login`.

   Linux or macOS (Bash):

   ```bash
   read -rs -p 'Flow API key: ' flow_key
   printf '\n'
   printf '%s' "$flow_key" | flow login --url https://flow.example.com --key-stdin
   unset flow_key
   ```

   Windows (PowerShell):

   ```powershell
   $flowKey = Read-Host 'Flow API key' -AsSecureString
   [System.Net.NetworkCredential]::new('', $flowKey).Password |
     flow login --url https://flow.example.com --key-stdin
   Remove-Variable flowKey
   ```

4. Preview the payload locally, then start the bridge. Open **3D office** from **AgentFlow** in Flow.

   ```sh
   flow office bridge --once --dry-run
   flow office bridge
   ```

The bridge uses the same sign-in as the rest of the CLI. `FLOW_URL` and `FLOW_API_KEY` override saved settings. Run services as the same user who ran `flow login` so they can find the configuration and local state.

| Option | Use |
| --- | --- |
| `--once` | Print and send one snapshot, process any actions returned by the report, and exit. |
| `--dry-run` | Print snapshots without connecting to Flow. Combine with `--once` to print one. |
| `--source <name>` | Override `bridge:<hostname>`. Use a distinct name per reporter if two computers share a host name. |
| `--interval <s>` | Set the reporting interval to 1–60 seconds. The default is 3. |
| `--t3-db <path>` | Override the T3 database path. The bridge looks for `server-runtime.json` next to the database to answer approvals. |
| `--conductor` / `--no-conductor` | Keep (or not) a Chief of Staff thread in T3 for the office. On by default when T3 Code is set up on this computer. See below. |
| `--conductor-project <path>` | The T3 project the Chief of Staff thread runs in. Default: the one it used last, else the project of your newest T3 thread. |
| `--conductor-env <env>` | The Flow environment whose **Chief of Staff** agent gives the thread its instructions. Default: the first of your environments that has one. |
| `--help` | Show usage. |

T3’s default database is `~/.t3/userdata/statev2.sqlite` on Linux and macOS and `%USERPROFILE%\.t3\userdata\statev2.sqlite` on Windows. When `T3CODE_HOME` is set, the bridge looks under its `userdata` directory. Claude Code sessions come from the `projects` directory under `~/.claude` or `CLAUDE_CONFIG_DIR` and show up when their transcript was modified in the last five minutes. The bridge filters out Claude sessions that it can link to a live T3 thread.

Each agent also carries the last 12 lines of its conversation: your messages, the agent's replies, and one line per command, file edit or tool call. The bridge masks secret-looking text (tokens, keys, passwords, `Authorization` headers, credentials in URLs and `.env`-style lines) and cuts each line to 400 characters before sending. Flow shows the transcript only to you, in your agent's panel.

From your own T3 agent's panel in the office you can also send it a message (it runs as your next turn, after the current one when it is busy; the bridge passes the text to `t3 thread send` on standard input) and stop its running turn (T3's interrupt, only for the turn that was running). The bridge checks the thread is still running on this computer first, and logs each one with the agent and how it went, never the message text. Threads delegated by another T3 thread, and Claude Code sessions, cannot be steered from Flow.

While an agent works, the bridge also streams what it is doing: its latest reasoning, tool call ("Run: npm test", "Read lib/auth.mjs") or partial reply, and its last 8 steps. It watches T3's database for any write and, about 150 ms after the last one, sends what changed (`POST /api/v1/office/live`, at most a few times a second); Claude Code sessions get theirs from the transcript tail with each report. With each report it also sends your T3 thread index as T3's sidebar groups it (Working, Waiting, Woke, Done, Snoozed, Settled; up to 150 threads, sent when it changes and once a minute). When you open a thread in the office, the bridge reads a page of its conversation from T3's database and sends it back (60 items at most, masked; Flow passes it to your browser and does not store it). A message from the office can go to any top-level thread in the index, idle ones too: `t3 thread send` starts a new turn there. All of it is masked like the transcript and shown to you only.

The reporting user can answer supported T3 approvals in Flow. Open T3 Code or Claude Code to answer T3 questions, Claude Code prompts, and T3 requests that lack a reviewable approval summary. A delegated T3 thread with a pending prompt appears separately so Flow can show its prompt.

## Chief of Staff (`--conductor`)

With T3 Code set up here, the bridge keeps one long-lived T3 thread titled **[Flow] Chief of Staff · conductor**: your [Chief of Staff](concepts/12-office.md#chief-of-staff) in the office. On start it reuses the thread it made before (its id is kept in `office-conductor.json` in the CLI's configuration folder), or one with that title in the project, and otherwise starts one with `t3 thread start`. A deleted or archived thread is replaced on the next report (at most once a minute). A new thread starts on the model last picked in the office (`--provider` and `--model`); until then it uses the T3 project's default model.

The office panel's **Model** picker lists the models your runners have reported (the same list as AgentFlow). Choosing one tells T3 to use it for the next turn (`thread.model-selection.set`) and does not start a turn. The id is `provider:model`, for example `cursor_personal:default` (Cursor Auto) or `cursor_personal:grok-4.7`.

Its first message is its brief: the **Chief of Staff** agent's instructions from Flow when the environment has one (else sensible defaults: small, reversible work on its own; anything public, legal, financial, touching production or deleting waits for you in UAT with "Needs …"), how to answer from Flow and route work with the Flow MCP tools (`cards_create` with `agents` to delegate, `agents_list` / `agents_get` to pick the agent, and the warning that `cards_update` replaces a description: read it first and prepend), GBrain search when that server is configured, and the reply contract: end every reply with one line, `[[office]] {"say": "<one short sentence>", "cards": [<numbers>]}`.

The bridge reports it as your conductor (`role: "conductor"`, always able to take a message) with its transcript and its latest reply. Your office messages go straight to the thread over the bridge's warm T3 connection (a new user turn, queued after a running one), so "on it" shows at once and the answer comes when the model replies. The thread uses the MCP servers T3 Code has configured on this computer; without the Flow MCP server it can fall back to the `flow` CLI.

## What the usage meters count

The bridge reads usage locally and sends per-agent totals for the current calendar day in the computer’s timezone. The meters reflect agents in the report at that moment.

- **T3 Code** uses completed provider-turn totals from its state database, dated by the turn’s start. A live turn contributes after T3 records its complete usage. Measured delegated threads shown as children contribute to the parent when both use the same checkout.
- **Claude Code** uses timestamped message usage in the session transcript, counting each message once even when its usage is repeated across several blocks. Input, output, cache writes and cache reads all count toward tokens.
- **Codex CLI** reads changes in cumulative token counts from recent session logs in the `sessions` directory under `~/.codex` or `CODEX_HOME`. The session index also finds recently resumed sessions. T3-managed CLI sessions are accounted for through T3.

The bridge remembers transcript byte offsets and completed T3 turn positions between reports. Cost uses standard API token rates and is an **API-equivalent list price estimate**. A subscription may include the usage. Claude cache writes use their recorded duration when available. Otherwise the estimate uses short cache write rates. Agents with unpriced models contribute tokens only.

## Run at sign-in

Use one bridge process per source. Use the absolute CLI path from `command -v flow` (Linux or macOS) or `(Get-Command flow.cmd).Source` (PowerShell). Include the directory containing Node and any custom Git and T3 installation directories in the service’s `PATH`. Keep credentials in the CLI configuration created above.

### Linux · systemd user service

Create `~/.config/systemd/user/flow-office-bridge.service` with the following contents and replace the example executable path. The bridge looks for T3’s standard launcher in `~/.local/bin` as well as on `PATH`.

```ini
[Unit]
Description=Flow 3D office bridge

[Service]
ExecStart=/usr/local/bin/flow office bridge
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now flow-office-bridge.service
journalctl --user -u flow-office-bridge.service -f
```

### macOS · launchd

Save as `~/Library/LaunchAgents/com.flygon.flow-office-bridge.plist`. Replace the example executable path and adjust `PATH` for your Node, Git, and T3 installations.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.flygon.flow-office-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/flow</string>
    <string>office</string>
    <string>bridge</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.flygon.flow-office-bridge.plist"
launchctl print "gui/$(id -u)/com.flygon.flow-office-bridge"
```

### Windows · Task Scheduler

1. Open **Task Scheduler → Create Task**. Name it `Flow office bridge` and select **Run only when user is logged on** for your account.
2. Add an **At log on** trigger for your user.
3. Add a **Start a program** action. Use `cmd.exe` as the program and the following arguments, replacing the example path with the full path to your `flow.cmd`.

   ```text
   /d /c ""C:\path\to\flow.cmd" office bridge"
   ```

4. On **Settings**, clear **Stop the task if it runs longer than**, select **Do not start a new instance**, and optionally enable restart on failure. Adjust the battery settings if you want reporting while unplugged. Save and select **Run** to start the bridge immediately.
