# Connect local coding agents to Flow’s 3D office

Run the bridge on each computer where you use T3 Code or Claude Code. It reports your local agents to the office under the account that owns the Flow API key. The bridge reports about every three seconds. If a computer stops reporting, its agents disappear after 90 seconds.

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
| `--help` | Show usage. |

T3’s default database is `~/.t3/userdata/statev2.sqlite` on Linux and macOS and `%USERPROFILE%\.t3\userdata\statev2.sqlite` on Windows. When `T3CODE_HOME` is set, the bridge looks under its `userdata` directory. Claude Code sessions come from the `projects` directory under `~/.claude` or `CLAUDE_CONFIG_DIR` and show up when their transcript was modified in the last five minutes. The bridge filters out Claude sessions that it can link to a live T3 thread.

Each agent also carries the last 12 lines of its conversation: your messages, the agent's replies, and one line per command, file edit or tool call. The bridge masks secret-looking text (tokens, keys, passwords, `Authorization` headers, credentials in URLs and `.env`-style lines) and cuts each line to 400 characters before sending. Flow shows the transcript only to you, in your agent's panel.

The reporting user can answer supported T3 approvals in Flow. Open T3 Code or Claude Code to answer T3 questions, Claude Code prompts, and T3 requests that lack a reviewable approval summary. A delegated T3 thread with a pending prompt appears separately so Flow can show its prompt.

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
