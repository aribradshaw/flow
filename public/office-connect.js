// One-time key reveal and setup instructions for a reporter on the user's machine.
import {icon} from './icons.js';

const systems=['macOS','Windows','Linux'];
const install='npm install -g github:aribradshaw/flow';
const shellQuote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const psQuote=value=>"'"+value.replaceAll("'","''")+"'";

export function bridgePrompt(os,url,key){
  return `Connect my local coding agents to the Flow 3D office on ${os}.

Flow server: ${url}
Flow API key: ${key}

1. On this machine, install the Flow CLI with \`${install}\` (requires Node.js 24 or newer and Git).
2. Use a dedicated XDG_CONFIG_HOME for the office bridge so my normal Flow CLI login is preserved. Sign in to the Flow server above using \`flow login --url <server> --key-stdin\` and pass the key privately on stdin. Keep the key in the CLI config only. Never write it into a repo, command arguments, a service definition, logs or shell history. Don't print it again.
3. In the same configuration, run \`flow office bridge --once --dry-run\`. Show me what the bridge would send and wait for my approval before sending a report.
4. Set up \`flow office bridge\` as a background service that starts at login (launchd LaunchAgent on macOS, Task Scheduler on Windows, systemd user service on Linux). Use the same XDG_CONFIG_HOME, clear FLOW_URL and FLOW_API_KEY overrides, and ensure the service can find Node.js, Git and the Flow CLI. Start it now.
5. Verify that the reporter appears in the 3D office by checking \`flow office agents list --json\` with the same configuration and telling me which source and how many agents are connected.`;
}

function terminalCommands(os,url){
  if(os==='Windows')return `# Run each section in PowerShell. Paste the key at the hidden prompt.
${install}
$env:XDG_CONFIG_HOME = Join-Path $env:LOCALAPPDATA 'FlowOffice'
Remove-Item Env:FLOW_URL, Env:FLOW_API_KEY -ErrorAction SilentlyContinue
$key = Read-Host 'Paste the Flow API key' -AsSecureString
([Net.NetworkCredential]::new('', $key)).Password | flow.cmd login --url ${psQuote(url)} --key-stdin
Remove-Variable key
flow.cmd office bridge --once --dry-run

# After reviewing the preview, start the bridge. Press Ctrl+C before continuing.
flow.cmd office bridge

# Start the bridge now and at every sign-in.
$runner = Join-Path $env:XDG_CONFIG_HOME 'bridge.ps1'
$flow = (Get-Command flow.cmd -ErrorAction Stop).Source.Replace("'", "''")
$nodeDir = (Split-Path (Get-Command node.exe -ErrorAction Stop).Source).Replace("'", "''")
@'
$env:XDG_CONFIG_HOME = $PSScriptRoot
Remove-Item Env:FLOW_URL, Env:FLOW_API_KEY -ErrorAction SilentlyContinue
$env:PATH = '{0};' + $env:PATH
& '{1}' office bridge
exit $LASTEXITCODE
'@ -f $nodeDir, $flow | Set-Content -LiteralPath $runner -Encoding UTF8
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File \`"$runner\`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Flow office bridge' -Action $action -Trigger $trigger -Settings $settings -User $user -Force
Start-ScheduledTask -TaskName 'Flow office bridge'`;
  const setup=`# Run each section in Terminal. Paste the key at the hidden prompt.
${install}
export XDG_CONFIG_HOME="\${XDG_CONFIG_HOME:-$HOME/.config}"
case "$XDG_CONFIG_HOME" in */flow-office) ;; *) export XDG_CONFIG_HOME="$XDG_CONFIG_HOME/flow-office";; esac
unset FLOW_URL FLOW_API_KEY
printf 'Paste the Flow API key: '
read -rs flow_office_key
printf '\\n'
printf '%s\\n' "$flow_office_key" | flow login --url ${shellQuote(url)} --key-stdin
unset flow_office_key
flow office bridge --once --dry-run

# After reviewing the preview, start the bridge. Press Ctrl+C before continuing.
flow office bridge

# Start the bridge now and at every sign-in.
bridge_path="$(dirname "$(command -v node)"):$(dirname "$(command -v flow)"):$PATH"`;
  if(os==='macOS')return setup+`
label=com.flygon.flow-office-bridge
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
mkdir -p "$HOME/Library/LaunchAgents"
launchctl bootout "$domain/$label" 2>/dev/null || true
/usr/bin/plutil -create xml1 "$plist"
/usr/bin/plutil -insert Label -string "$label" "$plist"
/usr/bin/plutil -insert EnvironmentVariables -dictionary "$plist"
/usr/bin/plutil -insert EnvironmentVariables.PATH -string "$bridge_path" "$plist"
/usr/bin/plutil -insert EnvironmentVariables.XDG_CONFIG_HOME -string "$XDG_CONFIG_HOME" "$plist"
/usr/bin/plutil -insert ProgramArguments -array "$plist"
/usr/bin/plutil -insert ProgramArguments.0 -string "$(command -v flow)" "$plist"
/usr/bin/plutil -insert ProgramArguments.1 -string office "$plist"
/usr/bin/plutil -insert ProgramArguments.2 -string bridge "$plist"
/usr/bin/plutil -insert RunAtLoad -bool YES "$plist"
/usr/bin/plutil -insert KeepAlive -bool YES "$plist"
launchctl bootstrap "$domain" "$plist"`;
  return setup+`
unit_dir="\${XDG_CONFIG_HOME%/flow-office}/systemd/user"
mkdir -p "$unit_dir"
# Escape literal path characters for systemd's quoted values.
unit_value() { printf '%s' "$1" | sed 's/[\\\\"]/\\\\&/g; s/%/%%/g'; }
cat > "$unit_dir/flow-office-bridge.service" <<EOF_UNIT
[Unit]
Description=Flow office bridge

[Service]
Environment="PATH=$(unit_value "$bridge_path")"
Environment="XDG_CONFIG_HOME=$(unit_value "$XDG_CONFIG_HOME")"
UnsetEnvironment=FLOW_URL FLOW_API_KEY
ExecStart=/usr/bin/env flow office bridge
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF_UNIT
# Point systemctl to the usual configuration root, alongside the bridge profile.
export XDG_CONFIG_HOME="\${XDG_CONFIG_HOME%/flow-office}"
systemctl --user daemon-reload
systemctl --user enable flow-office-bridge.service
systemctl --user restart flow-office-bridge.service
export XDG_CONFIG_HOME="$XDG_CONFIG_HOME/flow-office"`;
}

const detectSystem=()=>{
  const platform=navigator.userAgentData?.platform||navigator.platform||navigator.userAgent;
  if(/win/i.test(platform))return 'Windows';
  return /mac|ios/i.test(platform)?'macOS':'Linux';
};

export function openBridgeDialog({env,envName,sources,openProjects}){
  const url=location.origin,dialog=document.createElement('dialog');
  let key='',baseline=sources&&new Set(sources.map(s=>s.source)),connectedSource;
  dialog.className='of-connect';
  dialog.setAttribute('aria-labelledby','of-connect-title');
  dialog.innerHTML=`<div class="of-connect-header">
    <span class="of-connect-icon">${icon('bot',21)}</span>
    <h2 id="of-connect-title">Connect your agents</h2>
    <form method="dialog"><button class="ib" aria-label="Close setup">${icon('x')}</button></form>
  </div>
  <div class="of-connect-body">
    <p class="of-connect-intro">Bring your local coding agents into the 3D office. Set up the bridge yourself or ask your coding agent to do it.</p>
    <div class="of-connect-status" role="status"><i></i><span>Waiting for your agents…</span></div>
    <div class="of-connect-setup">
      <label for="of-connect-os">Operating system</label>
      <select id="of-connect-os" data-native autofocus>${systems.map(os=>`<option>${os}</option>`).join('')}</select>
      <button type="button" class="txt primary" data-mint>Create bridge key</button>
    </div>
    <p class="of-connect-scope">Read &amp; write access to <strong data-env-name></strong>. You can revoke this key in Settings › Connect.</p>
    <p class="of-connect-error" role="alert" hidden></p>
    <div data-key-setup hidden>
      <p class="of-connect-warning" role="status">Copy your key now. It’s shown once.</p>
      <div class="of-connect-key">
        <input type="text" readonly aria-label="Bridge API key" spellcheck="false" autocomplete="off">
        <button class="txt" type="button" data-copy="key" aria-label="Copy key">Copy key</button>
      </div>
      <section class="of-connect-block">
        <div><h3>Run it yourself</h3><button class="txt" type="button" data-copy="commands" aria-label="Copy commands">Copy commands</button></div>
        <p>Requires Node.js 24 or newer and Git. Run one section at a time.</p>
        <pre tabindex="0"><code data-commands></code></pre>
      </section>
      <section class="of-connect-block">
        <div><h3>Or paste this into your coding agent</h3><button class="txt" type="button" data-copy="prompt" aria-label="Copy prompt">Copy prompt</button></div>
        <p>Works with Claude Code, Codex, Cursor and other local agents that can run commands. The prompt contains your key.</p>
        <pre tabindex="0"><code data-prompt></code></pre>
      </section>
    </div>
    <p class="of-connect-privacy">Teammates see an agent’s details when its repo is attached to a project they can access. Otherwise they see <strong>Private project</strong> and its status. <a href="#timeline">Timeline › Projects › Repos</a></p>
  </div>`;
  const $=selector=>dialog.querySelector(selector),os=$('select'),mint=$('[data-mint]'),reveal=$('[data-key-setup]'),keyInput=$('input');
  const error=$('.of-connect-error'),status=$('.of-connect-status');
  function draw(){
    $('[data-commands]').textContent=terminalCommands(os.value,url);
    $('[data-prompt]').textContent=bridgePrompt(os.value,url,key);
  }
  function updateSources(next){
    baseline??=new Set(next.map(s=>s.source));
    const connected=next.find(s=>s.source===connectedSource)||next.find(s=>!baseline.has(s.source));
    connectedSource=connected?.source;
    status.classList.toggle('connected',!!connected);
    const label=connected?`Connected: ${connected.agents} ${connected.agents===1?'agent':'agents'} from ${connected.source}`:'Waiting for your agents…';
    if(status.lastElementChild.textContent!==label)status.lastElementChild.textContent=label;
  }
  os.value=detectSystem();
  $('[data-env-name]').textContent=envName||env;
  os.addEventListener('change',()=>{if(key)draw()});
  mint.addEventListener('click',async()=>{
    mint.disabled=true;error.hidden=true;
    try{
      const r=await fetch(`/api/office/${encodeURIComponent(env)}/bridge-key`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const data=await r.json().catch(()=>({}));
      if(!r.ok||!data.key)throw Error(data.error||'Could not create the bridge key. Try again.');
      if(!dialog.open)return;
      key=keyInput.value=data.key;
      draw();reveal.hidden=false;mint.hidden=true;keyInput.focus();keyInput.select();
    }catch(e){error.textContent=e.message;error.hidden=false}
    finally{mint.disabled=false}
  });
  dialog.addEventListener('click',async e=>{
    const button=e.target.closest('[data-copy]');if(!button)return;
    const text={key,commands:$('[data-commands]').textContent,prompt:$('[data-prompt]').textContent}[button.dataset.copy];
    try{
      await navigator.clipboard.writeText(text);
      button.textContent='Copied';
      setTimeout(()=>{button.textContent=button.getAttribute('aria-label')},1500);
    }catch{
      const selection=getSelection();
      if(button.dataset.copy==='key'){keyInput.focus();keyInput.select()}
      else selection.selectAllChildren($(`[data-${button.dataset.copy}]`));
      button.textContent='Press Ctrl+C or ⌘C';
    }
  });
  $('a').addEventListener('click',e=>{if(openProjects){e.preventDefault();openProjects()}});
  dialog.addEventListener('close',()=>{
    key=keyInput.value='';$('[data-prompt]').textContent='';dialog.remove();
  },{once:true});
  return {dialog,updateSources};
}
