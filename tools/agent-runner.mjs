#!/usr/bin/env node
// A reference AgentFlow runner for T3 Code (docs/concepts/09-agentflow.md, "Runners").
//
//   node tools/agent-runner.mjs report   tell Flow which models this machine can run (runners.report)
//   node tools/agent-runner.mjs tick     report, check running threads, start work for live agents
//   node tools/agent-runner.mjs status   print the live agents for this runner and what it is running
//   node tools/agent-runner.mjs retry 12 forget card #12, so the next tick starts it again
//   node tools/agent-runner.mjs jobs     print the scheduled jobs this machine would report (--json for
//                                        JSON); contacts no Flow server and needs no settings
//   node tools/agent-runner.mjs jobs --remote Laptop   the same for a remote machine (over SSH);
//                                        --all for this machine and every remote
//
// One pass per call: run `tick` from a timer (cron, a systemd timer) every few minutes.
// For each AgentFlow agent with `live` on whose `runtime` is this runner's name, it takes the first
// card in the agent's queue (Doing, then Requests), starts a T3 thread with the agent's brief and the
// card, and remembers it. When the thread finishes it moves the card to UAT for a person to approve.
// A thread waiting on a question is left for you to answer in T3; one interrupted or cancelled in T3
// is left alone (the card stays where it is).
//
// Models. An agent lists `models` in order: the primary first, then fallbacks. If `t3 thread start`
// fails on a model, the runner tries the next one. If a started thread fails (T3 status failed or
// rolled_back, or a short last reply that reads as a rate, usage or quota limit), the next pass
// starts the card again on the next model; every attempt is kept in the state file. When every model
// has failed the card is left where it is and logged; `retry <number>` lets it start over.
// With `auto` on, `models` is a pool and the runner picks per card: models this runner reported come
// first, then billing 'included' before unknown before 'metered', keeping the pool's order within
// each. If "router" is set and more than one model is in the best billing group, the runner asks the
// router model once per card (a short `t3 thread start --wait` thread in the card's T3 project, left
// in T3 as "[Flow] Pick a model …") to choose one of those ids from the card and the agent's purpose.
// Any error or an answer that is not one of the ids falls back to the rule choice. The rest of the
// pool, in rule order, are the card's fallbacks. A dry run logs the choice and asks no router.
//
// Settings: $XDG_CONFIG_HOME/flygon-flow/runner.json (default ~/.config), or --config <file>:
//   {
//     "name": "Home server",            the runner name agents put in Runs on
//     "env": "default-workspace",       the Flow environment
//     "url": "https://flow.example.com", "key": "flow_…"   or FLOW_URL / FLOW_API_KEY, or `flow login`
//     "dryRun": true,                    print what it would do and change nothing (the default)
//     "maxRunning": 1,                   threads running at once, across all agents
//     "project": "/path/to/repo",        T3 project (id or a path inside it) for cards without a match
//     "projects": {"Lantern": "/path/to/lantern"},   Flow project (name or id) -> T3 project
//     "worktree": "main",                optional: run each thread in a new worktree off this ref
//     "developer": "Cleo Park",          optional: person set as developer when a card enters Doing
//     "t3": "t3", "t3Home": "~/.t3",     the T3 binary and data directory
//     "opencode": "opencode", "grok": "grok",   CLIs asked for their model lists ("" to skip)
//     "models": [{"id": "cursor:composer-2.5", "label": "Cursor · Composer 2.5"}]   extra models
//     "billing": {"opencode:openai/": "included"},   billing override by instance id or id prefix
//     "router": "claudeAgent:claude-haiku-5",       optional: the model that picks for auto agents
//     "jobs": {"sources": ["systemd", "cron", "t3", "vercel", "railway", "github"],   the default: all
//              "repos": ["/path/to/repo"],       repos to read cron configs from (default: T3's projects)
//              "exclude": ["certbot", "systemd:system:*"],   globs (* ?) or substrings, on id and name
//              "include": ["logrotate"],         kept even when skipDistro or exclude would drop them
//              "skipDistro": true,               skip stock distribution timers (apt-daily, fstrim, …)
//              "notes": {"report-publisher": "Exits early when nothing changed"},   notes by job id or name
//                                                (globs or substrings); they win over notes found in READMEs
//              "platform": true}                 read live crons from Railway and Vercel when a token is set
//                                                "jobs": false reports no jobs (stored ones stay as they are)
//     "railwayToken": "…",               optional (or RAILWAY_API_TOKEN): a Railway account or workspace token
//     "railwayWorkspace": "…",           optional: the workspace id to list projects from
//     "vercelToken": "…",                optional (or VERCEL_TOKEN): a Vercel access token
//     "vercelTeam": "team_… or my-team", optional: the team (id or slug) that owns the projects
//     "remotes": [{"name": "Laptop",             other machines, each reported as its own runner (jobs only)
//                  "ssh": ["ssh", "-i", "~/.ssh/key", "-o", "BatchMode=yes", "me@laptop"],   the ssh command
//                  "python": "C:\\Python\\python.exe",   optional: Python on it (for Aside and Codex runs)
//                  "timezone": "America/Phoenix",    its time zone (default: this machine's)
//                  "sources": ["windows", "aside", "claude-desktop", "codex", "vercel", "railway", "github"],
//                  "repos": ["C:\\code\\shop"],      repos on it to read cron configs from (default: none)
//                  "exclude": [], "include": [],     as in "jobs"; include also keeps a vendor task
//                  "skipVendor": true,               skip vendor updater tasks (Adobe, Edge, Google, …)
//                  "keepDone": false,                also report finished Aside routines and Codex one-shots
//                  "notes": {},                      as in "jobs" (both apply; these win)
//                  "timeout": 40,                    seconds for the whole remote
//                  "enabled": true}]
//   }
// Model ids are "<T3 provider instance>:<model>", e.g. "claudeAgent:claude-sonnet-5-5" or
// "opencode:anthropic/claude-sonnet-5-5". The runner reports the current models from T3's model
// manifest for each enabled provider, plus `opencode models`, `grok models` and "models" above, each
// with its provider (the instance's display name) and billing: 'included' for Claude, Codex, Cursor,
// Grok and Antigravity instances (a subscription), and for OpenCode's own free models (opencode/…);
// 'metered' for other OpenCode models (paid per token). "billing" overrides by the longest matching
// key, an instance id ("opencode") or an id prefix ("opencode:anthropic/").
// Scheduled jobs. Each report also sends the machine's scheduled jobs (runners.report `jobs`), so Flow
// can show what runs where and when. Every source is best effort and skipped with a note if it fails:
//   systemd   user and system timers (systemctl list-timers / show): schedule from OnCalendar or the
//             monotonic settings, last and next run, status from the service's last result. Grouped
//             as the runner name, and "<runner> · system" for system timers. Stock timers are skipped.
//   cron      the user's crontab, one job a line (local time).
//   t3        T3 scheduled tasks, read only from <t3Home>/userdata/statev2.sqlite (needs node:sqlite).
//   vercel    vercel.json crons[] in each repo (and its services/* and apps/*), in UTC.
//   railway   deploy.cronSchedule in railway*.json and railway*.toml there, in UTC.
//   github    on.schedule crons in .github/workflows/*.yml, in UTC.
// Every job carries its full schedule: timezone (this machine's zone from timedatectl or Node, an
// OnCalendar line's own zone, CRON_TZ, UTC for repo crons, a remote's "timezone"), triggers (each rule
// with its raw expression: every OnCalendar line, OnUnitActiveSec as an interval and OnBootSec as boot,
// each cron line, each Windows trigger, an RRULE with its TZID), origin (repo, platform or machine) and,
// for repo crons, file (the config's path in the repo). A repo cron may get a note: the first sentence
// of its service folder's README (or its start script's or route's leading comment) that says it runs
// every N minutes, exits, or applies a condition ("only when", "unchanged", "skips"); never a sentence
// that mentions a secret. "notes" in the settings win.
// Platform schedules: with "railwayToken" the runner asks Railway's GraphQL API for every service's cron
// schedule and next run; with "vercelToken", Vercel's API for each project's crons. A repo cron matched
// to a service (by name) or project (by .vercel/project.json, else by name) is reported as the platform
// runs it (origin platform, its file kept), with "drift" saying how the repo file differs; a live cron
// no repo file has is reported too. No token, nothing is asked.
// Repo configs carry no last run; their next run is worked out from the cron expression. A job is
// marked ai when it is a T3 task or its command runs an AI CLI (claude, codex, opencode, grok,
// cursor-agent, agy, t3 thread, this runner). Commands are one line, with ~ for home and anything
// that looks like a key, token or password replaced by ***. A server from before jobs answers 400:
// the runner then reports the models alone and logs "server does not accept jobs yet".
// Remote machines ("remotes"). After its own pass, `tick` reads each remote over SSH, at most every
// 15 minutes (the last time is kept in the state file; `report` reads them every time), and reports
// it as a runner named after the remote, with `jobs` and no `models` (so Flow keeps what it has).
// The remote is a Windows machine; its login shell may be cmd.exe. The runner sends a PowerShell
// script (powershell -EncodedCommand reads it from stdin) and, when "python" is set, a Python one,
// both embedded below, both read only. A remote that cannot be reached within "timeout" (one retry
// on a failed connection) is logged and skipped; it never holds up this machine's pass.
//   windows         Task Scheduler, outside \Microsoft\: triggers as text (Daily 18:00, Every 15 min,
//                   At logon, On demand), last and next run, status from the last result (0 ok,
//                   running, else failed), off when disabled. Vendor updater tasks are skipped.
//   aside           Aside routines from %USERPROFILE%\.aside\u\<n>\state.db (copied with its WAL to a
//                   temp folder, read, removed; needs "python"): active and paused ones, the schedule
//                   from the RRULE, the model and prompt, the last run from the routine's newest
//                   session (suspended: running and "Waiting for approval"; errored: failed). One
//                   whose next run has passed is "(stale)".
//   claude-desktop  Claude desktop scheduled tasks (scheduled-tasks.json under %LOCALAPPDATA%\
//                   Claude-Data), cron in the remote's time, with what each does from its SKILL.md.
//   codex           Codex automations (%USERPROFILE%\.codex\automations\*\automation.toml): RRULE or
//                   cron, ACTIVE or PAUSED, the model; a used-up one-shot is skipped. The last run of
//                   a cron automation comes from Codex's state database (with "python").
//   vercel, railway, github   cron configs in "repos" on the remote, read as for local repos.
// Jobs are grouped as "<remote>", "<remote> · Aside", "<remote> · Claude", "<remote> · Codex".
// State (threads it started, when remotes last ran): $XDG_STATE_HOME/flygon-flow/runner-state.json.
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,readdirSync,statSync,realpathSync} from 'node:fs';
import {join,dirname,basename,relative} from 'node:path';
import {homedir,hostname} from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const home=homedir(),tilde=p=>String(p||'').replace(/^~(?=\/|$)/,home);
const cfgDir=join(process.env.XDG_CONFIG_HOME||join(home,'.config'),'flygon-flow');
const stateFile=join(process.env.XDG_STATE_HOME||join(home,'.local','state'),'flygon-flow','runner-state.json');
const readJson=f=>{try{return JSON.parse(readFileSync(f,'utf8').replace(/^\uFEFF/,''))}catch{return null}};
const writeJson=(f,v)=>{mkdirSync(dirname(f),{recursive:true,mode:0o700});writeFileSync(f+'.tmp',JSON.stringify(v,null,2),{mode:0o600});renameSync(f+'.tmp',f)};
const log=(...a)=>console.log(new Date().toISOString(),...a);

// Set by main(), so importing this file (the tests do) reads no settings and exits nowhere.
let args=[],cmd='tick',cfgPath='',cfg={},FLOW={url:'',key:''},DRY=true,T3='t3',T3HOME=tilde('~/.t3');
const splitModel=m=>{const i=m.indexOf(':');return i>0?[m.slice(0,i),m.slice(i+1)]:[null,m]};
const same=(a,b)=>String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();

// ---------- Flow ----------
async function flow(method,path,body){
  const r=await fetch(`${FLOW.url}/api/v1/envs/${encodeURIComponent(cfg.env)}${path}`,{method,signal:AbortSignal.timeout(30000),
    headers:{authorization:'Bearer '+FLOW.key,accept:'application/json',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>null);
  // Flow answers {error: message, code}; {error: {code, message}} is read too.
  const e=d?.error,code=(typeof e==='object'?e?.code:d?.code)||'',msg=(typeof e==='object'?e?.message:e)||'';
  if(!r.ok)throw Object.assign(new Error(`${method} ${path}: ${r.status} ${code} ${msg}`.replace(/\s+/g,' ').trim()),{code,status:r.status});
  return d;
}
async function all(path){
  const out=[];let cursor='';
  do{const d=await flow('GET',path+(path.includes('?')?'&':'?')+'limit=200'+(cursor?'&cursor='+cursor:''));out.push(...d.items);cursor=d.nextCursor||''}while(cursor);
  return out;
}

// ---------- what this machine can run ----------
const run=(bin,argv,opts={})=>spawnSync(bin,argv,{encoding:'utf8',timeout:opts.timeout||60000,input:opts.input,maxBuffer:32<<20,env:{...process.env,PATH:`${join(home,'.local','bin')}:${process.env.PATH}`}});
const lines=r=>r.status===0?r.stdout.split('\n').map(s=>s.trim()).filter(Boolean):[];
function catalog(){
  const settings=readJson(join(T3HOME,'userdata','settings.json'))||{},manifest=readJson(join(T3HOME,'userdata','model-manifest.json'))?.manifest||{};
  const names={claudeAgent:'Claude',codex:'Codex',opencode:'OpenCode',grok:'Grok',cursor:'Cursor',antigravity:'Antigravity'};
  // Provider instances: Claude and Codex are on unless switched off; the rest when enabled.
  const inst={claudeAgent:{driver:'claudeAgent'},codex:{driver:'codex'}};
  for(const [id,x] of Object.entries(settings.providerInstances||{}))inst[id]={...inst[id],...x};
  const on=Object.entries(inst).filter(([,x])=>x.enabled!==false&&x.driver).map(([id,x])=>({id,driver:x.driver,label:x.displayName||names[x.driver]||id}));
  const models=[],add=(p,slug,name)=>models.push({id:`${p.id}:${slug}`,label:`${p.label} · ${name||slug}`});
  for(const p of on){
    for(const m of manifest.providers?.[p.driver]?.models||[])if(m.status==='current')add(p,m.slug,m.name);
    if(p.driver==='opencode'&&cfg.opencode!=='')for(const m of lines(run(tilde(cfg.opencode||'opencode'),['models'])))add(p,m);
    if(p.driver==='grok'&&cfg.grok!=='')for(const l of lines(run(tilde(cfg.grok||'grok'),['models']))){const m=/^[*-]\s+([\w.-]+)/.exec(l);if(m)add(p,m[1])}
  }
  models.push(...(cfg.models||[]).filter(m=>m?.id).map(m=>({...m})));
  const byId=new Map(on.map(p=>[p.id,p])),seen=new Set();
  // Included (subscription or free) models first, so the server's model cap only ever trims metered ones.
  const out=models.filter(m=>!seen.has(m.id)&&seen.add(m.id)).map(m=>{
    const p=byId.get(splitModel(m.id)[0]),provider=m.provider||p?.label||'',billing=billingOf(m.id,p?.driver||splitModel(m.id)[0],m.billing);
    return {id:m.id,label:m.label||m.id,...(provider?{provider:String(provider).slice(0,80)}:{}),...(billing==='included'||billing==='metered'?{billing}:{})};
  });
  const rank=m=>m.billing==='metered'?1:0;
  return out.map((m,i)=>[m,i]).sort((x,y)=>rank(x[0])-rank(y[0])||x[1]-y[1]).map(([m])=>m).slice(0,MODEL_CAP);
}
// Billing for a model id on an instance with this driver: the longest matching "billing" key, else
// what an extra model in "models" says, else the driver's default.
const MODEL_CAP=1500;   // the server's LIMITS.models
const INCLUDED=new Set(['claudeAgent','codex','cursor','grok','antigravity']);
function billingOf(id,driver,given){
  const over=Object.entries(cfg.billing||{}).filter(([k])=>id===k||id.startsWith(k.includes(':')?k:k+':')).sort((a,b)=>b[0].length-a[0].length)[0];
  if(over)return over[1];
  if(given)return given;
  if(INCLUDED.has(driver))return 'included';
  if(driver==='opencode')return splitModel(id)[1].startsWith('opencode/')?'included':'metered';
  return '';
}
// The job fields a server from before schedule details knows.
const LEGACY=['id','name','source','group','schedule','cron','command','ai','enabled','lastRun','lastStatus','nextRun'];
export const legacyJobs=jobs=>jobs.map(j=>Object.fromEntries(Object.entries(j).filter(([k])=>LEGACY.includes(k))));
const NEWER=/timezone|triggers|origin|drift|note|file/;
// POST a report; a server from before schedule details (it rejects timezone, triggers…) gets the
// report again with the jobs' older fields only.
async function postReport(path,body){
  try{return {r:await flow('POST',path,body),body}}
  catch(e){
    if(e.status!==400||!NEWER.test(e.message)||!/additional|unknown|not allowed|unexpected/i.test(e.message))throw e;
    log(`server does not accept schedule details yet (${e.message.slice(0,160)}); reporting jobs without them`);
    const {timezone,...rest}=body,b={...rest,...(rest.jobs?{jobs:legacyJobs(rest.jobs)}:{})};
    return {r:await flow('POST',path,b),body:b};
  }
}
async function report(){
  const models=catalog(),path=`/runners/${encodeURIComponent(cfg.name)}`,timezone=localZone();
  let jobs;
  if(jobsOn(cfg)){try{jobs=await discoverJobs(cfg,{note:m=>log('jobs:',m)})}catch(e){log('job discovery failed:',e.message)}}
  let r;
  try{({r}=await postReport(path,{models,...(jobs?{jobs}:{}),timezone}))}
  catch(e){
    // A server from before jobs rejects the unknown field: report the models alone.
    if(!jobs||e.status!==400||!/jobs|additional|unknown|not allowed|unexpected/i.test(e.message))throw e;
    log(`server does not accept jobs yet (${e.message.slice(0,160)}); reporting models only`);
    jobs=undefined;r=await flow('POST',path,{models});
  }
  log(`reported ${models.length} models${jobs?` and ${jobs.length} jobs`:''} as "${cfg.name}"${r.changed?'':' (unchanged)'}`);
  return models;
}

// ---------- scheduled jobs on this machine ----------
// Each source is best effort: a failure is noted and skipped. Everything here up to discoverJobs is
// pure (text in, jobs out) and exported for the tests.
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],DAYS_LONG=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const pad2=n=>String(n).padStart(2,'0'),hm=(h,m)=>`${pad2(h)}:${pad2(m)}`;
const clip=(s,n)=>String(s??'').replace(/\s+/g,' ').trim().slice(0,n);
const nums=s=>/^\d+(,\d+)*$/.test(s);
// "Saturdays", "Weekdays", "Mon, Wed" for a set of weekdays (0 is Sunday).
export function dayPhrase(days){
  const d=[...new Set(days)].sort((a,b)=>a-b);
  if(d.length===7)return 'Daily';
  if(d.length===1)return DAYS_LONG[d[0]]+'s';
  if(d.join()==='1,2,3,4,5')return 'Weekdays';
  if(d.join()==='0,6')return 'Weekends';
  if(d.length>2&&d.every((x,i)=>!i||x===d[i-1]+1))return `${DAYS[d[0]]}-${DAYS[d.at(-1)]}`;
  return d.map(i=>DAYS[i]).join(', ');
}
const timesOf=(hours,minutes)=>{const t=[];for(const h of hours)for(const m of minutes)t.push(hm(h,m));return t.length<=4?t.join(', '):null};

// systemd OnCalendar ("Sat *-*-01..07 20:00:00") as text; anything it does not know comes back as is.
const DOW_IX={sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
function parseDows(s){
  const out=[];
  for(const part of s.toLowerCase().split(',')){
    const [a,b]=part.split('..').map(x=>DOW_IX[x.slice(0,3)]);
    if(a===undefined||(part.includes('..')&&b===undefined))return null;
    if(b===undefined)out.push(a);else for(let i=a;;i=(i+1)%7){out.push(i);if(i===b)break}
  }
  return out;
}
export function humaniseOnCalendar(spec){
  const raw=clip(spec,200);if(!raw)return '';
  const short={minutely:'Every minute',hourly:'Hourly',daily:'Daily 00:00',weekly:'Mondays 00:00',monthly:'Monthly on day 1 00:00',
    yearly:'Yearly (Jan 1 00:00)',annually:'Yearly (Jan 1 00:00)',quarterly:'Quarterly',semiannually:'Twice a year'};
  if(short[raw.toLowerCase()])return short[raw.toLowerCase()];
  let tok=raw.split(' '),tz='',dow=null;
  const last=tok.at(-1);
  if(tok.length>1&&!/[:*\d]/.test(last[0])&&(last.includes('/')||/^(UTC|GMT|[A-Z]{3,5})$/.test(last))){tz=' '+last;tok=tok.slice(0,-1)}
  if(/^[A-Za-z]/.test(tok[0]||'')){dow=parseDows(tok[0]);if(!dow)return raw;tok=tok.slice(1)}
  let date='*-*-*',time='00:00:00';
  if(tok.length===2)[date,time]=tok;else if(tok.length===1){if(tok[0].includes(':'))time=tok[0];else date=tok[0]}else if(tok.length)return raw;
  const dp=date.split('-');if(dp.length===2)dp.unshift('*');
  const tp=time.split(':');if(tp.length===2)tp.push('00');
  if(dp.length!==3||tp.length!==3)return raw;
  const [Y,M,D]=dp,[H,Mi,S]=tp;
  if(Y!=='*'||M!=='*'||!/^0+$/.test(S))return raw;
  let every=null,m;
  if(H==='*'){
    if(Mi==='*')every='Every minute';
    else if((m=/^(?:\*|0+)\/(\d+)$/.exec(Mi)))every=+m[1]===1?'Every minute':`Every ${+m[1]} min`;
    else if(/^\d+(,\d+)+$/.test(Mi)){const v=Mi.split(',').map(Number),st=v[1]-v[0];if(v[0]<st&&60%st===0&&v.length===60/st&&v.every((x,i)=>x===v[0]+i*st))every=`Every ${st} min`}
    else if(/^\d+$/.test(Mi))every=+Mi===0?'Hourly':`Hourly at :${pad2(Mi)}`;
    if(!every)return raw;
  }else if((m=/^(?:\*|\d+)\/(\d+)$/.exec(H))&&/^\d+$/.test(Mi))every=`Every ${+m[1]} h${+Mi?` at :${pad2(Mi)}`:''}`;
  if(every){if(D!=='*')return raw;return dow&&dow.length<7?`${dayPhrase(dow)}, ${every[0].toLowerCase()}${every.slice(1)}`:every}
  if(!nums(H)||!nums(Mi))return raw;
  const t=timesOf(H.split(',').map(Number).sort((a,b)=>a-b),Mi.split(',').map(Number).sort((a,b)=>a-b));
  if(!t)return raw;
  const T=t+tz;
  if(D==='*')return `${dow?dayPhrase(dow):'Daily'} ${T}`;
  if((m=/^(\d+)\.\.(\d+)$/.exec(D))&&dow?.length===1&&+m[2]-+m[1]===6&&[1,8,15,22].includes(+m[1]))
    return `${['First','Second','Third','Fourth'][(+m[1]-1)/7]} ${DAYS_LONG[dow[0]]} monthly ${T}`;
  if(/^\d+$/.test(D)&&!dow)return `Monthly on day ${+D} ${T}`;
  return raw;
}
// A systemd duration ("5min", "1h 30min", "1d") as text.
export function humaniseDuration(s){
  const unit={us:'us',ms:'ms',s:'s',sec:'s',min:'min',m:'min',h:'h',hr:'h',d:'day',w:'week',M:'month',y:'year'};
  const parts=[...String(s).matchAll(/(\d+(?:\.\d+)?)\s*(us|ms|sec|min|hr|s|m|h|d|w|M|y)\b/g)].map(([,n,u])=>{const w=unit[u];return `${+n} ${w}${/day|week|month|year/.test(w)&&+n!==1?'s':''}`});
  return parts.join(' ')||String(s).trim();
}
// Monotonic timers: [[key, duration]], keys as systemctl show prints them (OnUnitActiveUSec) or as
// written in the unit (OnUnitActiveSec).
export function humaniseMonotonic(list){
  const of=k=>list.find(([x])=>x.replace(/USec$/,'Sec').toLowerCase()===k.toLowerCase())?.[1];
  const every=of('OnUnitActiveSec')||of('OnUnitInactiveSec');
  if(every){const d=humaniseDuration(every),one={'1 min':'minute','1 h':'hour','1 day':'day','1 week':'week','1 month':'month'}[d];return one?`Every ${one}`:`Every ${d}`}
  if(of('OnBootSec'))return `${humaniseDuration(of('OnBootSec'))} after boot`;
  if(of('OnStartupSec'))return `${humaniseDuration(of('OnStartupSec'))} after start`;
  if(of('OnActiveSec'))return `${humaniseDuration(of('OnActiveSec'))} after the timer starts`;
  return list.length?list.map(([k,v])=>`${k}=${v}`).join(', '):'';
}

// Cron: five fields or a macro. Returns the sets, or null when it does not parse.
const MON_N={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
const MACRO={'@yearly':'0 0 1 1 *','@annually':'0 0 1 1 *','@monthly':'0 0 1 * *','@weekly':'0 0 * * 0','@daily':'0 0 * * *','@midnight':'0 0 * * *','@hourly':'0 * * * *'};
function cronField(s,min,max,names){
  const out=new Set();
  for(const part of String(s).toLowerCase().split(',')){
    const m=/^(\*|[a-z0-9]+)(?:-([a-z0-9]+))?(?:\/(\d+))?$/.exec(part);
    if(!m||(m[1]==='*'&&m[2]))return null;
    const val=x=>names&&x in names?names[x]:/^\d+$/.test(x)?+x:NaN;
    const lo=m[1]==='*'?min:val(m[1]),hi=m[1]==='*'?max:m[2]!==undefined?val(m[2]):m[3]?max:lo,step=m[3]?+m[3]:1;
    if(!(lo>=min&&hi<=max&&lo<=hi&&step>0))return null;
    for(let i=lo;i<=hi;i+=step)out.add(i);
  }
  return out;
}
export function parseCron(expr){
  const e=MACRO[String(expr).trim().toLowerCase()]||String(expr).trim(),f=e.split(/\s+/);
  if(f.length!==5)return null;
  const [mi,h,dom,mon,dow]=f;
  const p={min:cronField(mi,0,59),hour:cronField(h,0,23),dom:cronField(dom,1,31),mon:cronField(mon,1,12,MON_N),dow:cronField(dow,0,7,DOW_IX),domStar:dom[0]==='*',dowStar:dow[0]==='*',fields:f};
  if(Object.values(p).some(v=>v===null))return null;
  if(p.dow.has(7)){p.dow.delete(7);p.dow.add(0)}
  return p;
}
export function humaniseCron(expr,{utc=false}={}){
  const e=clip(expr,120),tz=utc?' UTC':'',fb=`cron ${e}${tz}`;
  if(/^@reboot$/i.test(e))return 'At boot';
  if(/^@(yearly|annually)$/i.test(e))return `Yearly (Jan 1 00:00${tz})`;
  const p=parseCron(e);if(!p)return fb;
  const [mi,h,dom,mon,dow]=p.fields,allDays=dom==='*'&&dow==='*';let m;
  if(mon!=='*')return fb;
  if(allDays&&h==='*'){
    if(mi==='*')return 'Every minute';
    if((m=/^\*\/(\d+)$/.exec(mi)))return +m[1]===1?'Every minute':`Every ${+m[1]} min`;
    if(/^\d+$/.test(mi))return +mi===0?'Hourly':`Hourly at :${pad2(mi)}`;
    if((m=/^(\d+)-(\d+)\/(\d+)$/.exec(mi))&&+m[2]+ +m[3]>59)return `Every ${+m[3]} min from :${pad2(m[1])}`;
    if(/^\d+(,\d+){1,3}$/.test(mi))return `Hourly at ${[...p.min].sort((a,b)=>a-b).map(x=>':'+pad2(x)).join(', ')}`;
    return fb;
  }
  if(allDays&&(m=/^\*\/(\d+)$/.exec(h))&&/^\d+$/.test(mi))return `Every ${+m[1]} h${+mi?` at :${pad2(mi)}`:''}`;
  if(!nums(mi)||!nums(h))return fb;
  const t=timesOf([...p.hour].sort((a,b)=>a-b),[...p.min].sort((a,b)=>a-b));
  if(!t)return fb;
  if(allDays)return `Daily ${t}${tz}`;
  if(dom==='*')return `${dayPhrase(p.dow)} ${t}${tz}`;
  if(dow==='*'&&/^\d+$/.test(dom))return `Monthly on day ${+dom} ${t}${tz}`;
  return fb;
}
// The next time a cron expression fires after `from`, as an ISO string (null if never within 4 years).
// Day of month and day of week both set means either matches, as in cron.
export function nextCron(expr,from=new Date(),{utc=false,tz=''}={}){
  const p=parseCron(expr);if(!p)return null;
  if(tz&&!utc)return nextCronIn(p,from,tz);
  const get=d=>utc?[d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),d.getUTCDay(),d.getUTCHours(),d.getUTCMinutes()]:[d.getFullYear(),d.getMonth(),d.getDate(),d.getDay(),d.getHours(),d.getMinutes()];
  let t=new Date(Math.floor(from.getTime()/60000)*60000+60000);
  const end=from.getTime()+4*366*864e5;
  while(t.getTime()<end){
    const [y,mo,dd,wd,hh,mm]=get(t);
    const day=p.domStar&&p.dowStar?true:p.domStar?p.dow.has(wd):p.dowStar?p.dom.has(dd):p.dom.has(dd)||p.dow.has(wd);
    if(!p.mon.has(mo+1)||!day){t=utc?new Date(Date.UTC(y,mo,dd+1)):new Date(y,mo,dd+1);continue}
    if(!p.hour.has(hh)){t=new Date(t.getTime()+(60-mm)*60000);continue}
    if(!p.min.has(mm)){t=new Date(t.getTime()+60000);continue}
    return t.toISOString();
  }
  return null;
}
// Wall-clock time in a time zone ('' is this machine's, 'UTC' is UTC), as a "wall" number: the
// milliseconds Date.UTC gives for that wall-clock reading. A remote machine's cron lines and
// schedules are in its own zone (its "timezone" setting).
const W=(y,mo,d,h=0,mi=0,s=0)=>Date.UTC(y,mo-1,d,h,mi,s);
const wf=w=>{const d=new Date(w);return {y:d.getUTCFullYear(),mo:d.getUTCMonth()+1,d:d.getUTCDate(),h:d.getUTCHours(),mi:d.getUTCMinutes(),s:d.getUTCSeconds(),wd:d.getUTCDay()}};
const fmts=new Map();
export function validTz(tz){if(!tz||tz==='UTC')return true;try{new Intl.DateTimeFormat('en-US',{timeZone:tz});return true}catch{return false}}
export function wallOf(ms,tz=''){
  if(tz==='UTC')return Math.floor(ms/1000)*1000;
  let f=fmts.get(tz);
  if(!f)fmts.set(tz,f=new Intl.DateTimeFormat('en-US',{...(tz?{timeZone:tz}:{}),hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'}));
  const p={};for(const x of f.formatToParts(new Date(ms)))p[x.type]=x.value;
  return W(+p.year,+p.month,+p.day,+p.hour%24,+p.minute,+p.second);
}
// The instant (ms) a wall-clock reading in tz stands for (around a DST change, the nearest one).
export function wallToMs(w,tz=''){if(tz==='UTC')return w;let g=w-(wallOf(w,tz)-w);g=w-(wallOf(g,tz)-g);return g}
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dateIn=(ms,tz)=>{const f=wf(wallOf(ms,tz));return `${MON[f.mo-1]} ${f.d} ${hm(f.h,f.mi)}`};
function nextCronIn(p,from,tz){
  let w=Math.floor(wallOf(from.getTime(),tz)/60000)*60000+60000;
  const end=w+4*366*864e5;
  while(w<end){
    const f=wf(w),day=p.domStar&&p.dowStar?true:p.domStar?p.dow.has(f.wd):p.dowStar?p.dom.has(f.d):p.dom.has(f.d)||p.dow.has(f.wd);
    if(!p.mon.has(f.mo)||!day){w=W(f.y,f.mo,f.d+1);continue}
    if(!p.hour.has(f.h)){w=W(f.y,f.mo,f.d,f.h+1);continue}
    if(!p.min.has(f.mi)){w+=60000;continue}
    const t=wallToMs(w,tz);
    if(t>from.getTime())return new Date(t).toISOString();
    w+=60000;
  }
  return null;
}

// Stock timers a distribution installs, skipped unless "include" names them. Globs on the unit name.
export const DISTRO_TIMERS=['apt-daily*','dpkg-db-backup','e2scrub*','fstrim','fwupd*','logrotate','man-db','motd-news','sysstat*',
  'update-notifier*','systemd-*','xfs_scrub*','snap*','ua-timer','ua-*','ubuntu-advantage*','esm-cache','apport*','launchpadlib*',
  'anacron','phpsessionclean','plocate*','mlocate*','updatedb','unattended-upgrades*','packagekit*','dnf-makecache','shadow',
  'btrfs-scrub*','mdcheck*','mdmonitor*','raid-check','pmlogger*','pmie*','atop*','exim4-base','spamassassin*','sa-update',
  'grub-boot-success','tracker-*','pamac*','archlinux-keyring*','man-db-*','lvm2-*','fwupd-refresh'];
// A pattern with * or ? is a glob on the whole value; anything else matches as a substring. Both ignore case.
export function matches(pattern,value){
  const p=String(pattern),v=String(value??'');
  if(!/[*?]/.test(p))return v.toLowerCase().includes(p.toLowerCase());
  return new RegExp('^'+p.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i').test(v);
}
export const isDistroTimer=(unit,list=DISTRO_TIMERS)=>{const b=String(unit).replace(/\.(timer|service)$/,'');return list.some(p=>matches(p,b))};
// Keep a job if "include" names it; otherwise drop stock timers (with skipDistro) and what "exclude" names.
// Patterns are tried on the id and the name.
export function filterJobs(jobs,{include=[],exclude=[],skipDistro=true}={}){
  const hit=(list,j)=>list.some(p=>matches(p,j.id)||matches(p,j.name));
  return jobs.filter(j=>hit(include,j)||!((skipDistro&&j.distro)||hit(exclude,j)));
}
// Hide what looks like a secret in a command line: key=value pairs, --token value, bearer tokens,
// passwords in URLs and well known key prefixes.
export function redact(s){
  return String(s??'')
    .replace(/\b(bearer\s+)\S+/gi,'$1***')
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g,'$1***@')
    .replace(/((?:^|[\s"'])--?[\w-]*(?:key|token|secret|password|passwd|pwd|auth)[\w-]*(?:=|\s+))(?!-)\S+/gi,'$1***')
    .replace(/(\b[\w]*(?:key|token|secret|password|passwd|pwd|auth)[\w]*\s*[=:]\s*)(?!\*\*\*|bearer\s)\S+/gi,'$1***')
    .replace(/\b(sk|pk|rk|flow|ghp|gho|ghs|github_pat|xox[abpr]|glpat)[-_][A-Za-z0-9_-]{8,}/g,'***');
}
// Does a command start an AI CLI? A simple heuristic: one of the CLIs as a program name (on Windows
// too: C:\Tools\codex.exe).
const AI_CLI=/(?:^|[\s/\\;&|'"(])(?:claude|codex|opencode|grok|cursor-agent|agy|gemini|aider)(?:\.(?:exe|cmd|bat|ps1))?(?=$|[\s;&|'")])|(?:^|[\s/\\])t3(?:\.exe)?\s+thread\b|agent-runner\.mjs/i;
export const aiCommand=s=>AI_CLI.test(String(s||''));
const shortHome=s=>home&&home!=='/'?String(s).split(home+'/').join('~/'):String(s);
const tidy=s=>clip(redact(shortHome(s)),300);
// A short name for a command line: the program (or the script an interpreter runs) and its arguments.
const INTERP=/^(node|nodejs|python\d*(\.\d+)?|bash|sh|zsh|bun|deno|ruby|perl|php|npx|uv)$/;
export function commandName(cmd){
  const segs=String(cmd).replace(/\s*\d*>>?\s*&?\S+/g,'').split(/&&|\|\||;|\|/).map(s=>s.trim()).filter(Boolean);
  const seg=segs.find(s=>!/^(cd|export|source|\.|sleep|test|\[)\b/.test(s))||segs[0]||'';
  let w=seg.split(/\s+/).filter(x=>!/^[A-Za-z_]\w*=/.test(x));
  if(w[0]==='env')w=w.slice(1);
  if(INTERP.test(basename(w[0]||''))&&w[1]&&!w[1].startsWith('-'))w=w.slice(1);
  return clip(redact([basename(w[0]||''),...w.slice(1)].join(' ')),80)||clip(redact(cmd),80);
}

// `systemctl show` output: blocks split by blank lines; repeated keys become arrays.
export function parseShow(text){
  const out=[];let cur=null;
  for(const line of String(text).split('\n')){
    if(!line.trim()){cur=null;continue}
    const i=line.indexOf('=');if(i<1)continue;
    if(!cur)out.push(cur={});
    const k=line.slice(0,i),v=line.slice(i+1);
    cur[k]=k in cur?[].concat(cur[k],v):v;
  }
  return out;
}
// `systemctl list-timers --no-legend` text: the .timer unit and the unit it activates on each line.
export const parseTimerList=text=>String(text).split('\n').map(l=>l.trim().split(/\s+/)).map(w=>{const i=w.findIndex(x=>/\.timer$/.test(x));return i<0?null:{unit:w[i],service:w[i+1]||''}}).filter(Boolean);
const usec=n=>Number(n)>0?new Date(Number(n)/1000).toISOString():undefined;
const showTime=v=>{const s=[].concat(v??'')[0];if(!s||s==='n/a')return undefined;const m=/^@(\d+)$/.exec(s);if(m)return new Date(m[1]*1000).toISOString();const t=Date.parse(s);return Number.isFinite(t)?new Date(t).toISOString():undefined};
const execOf=v=>[].concat(v??[]).map(x=>/argv\[\]=(.*?)\s*;\s*(?:ignore_errors|$)/.exec(x)?.[1]||'').filter(Boolean).join(' && ');
// The zone an OnCalendar spec names at its end ("*-*-* 06:00:00 Europe/Berlin", "… UTC"), or ''.
export function calendarZone(spec){
  const tok=clip(spec,200).split(' '),last=tok.at(-1)||'';
  return tok.length>1&&!/[:*\d]/.test(last[0])&&(last.includes('/')||/^(UTC|GMT|[A-Z]{3,5})$/.test(last))?last:'';
}
// A timer's triggers: each OnCalendar line ('calendar'), and each monotonic setting: OnUnitActiveSec
// and OnUnitInactiveSec as 'interval', OnBootSec and OnStartupSec as 'boot', others as 'other'.
export function systemdTriggers(cal=[],mono=[]){
  const kind=k=>/^On(Boot|Startup)Sec$/i.test(k)?'boot':/^OnUnit(Active|Inactive)Sec$/i.test(k)?'interval':'other';
  return [...cal.map(c=>({kind:'calendar',expr:clip(c,200),text:humaniseOnCalendar(c)})),
    ...mono.map(([k,v])=>{const key=k.replace(/USec$/,'Sec');return {kind:kind(key),expr:clip(`${key}=${v}`,200),text:clip(humaniseMonotonic([[key,v]]),200)}})].slice(0,10);
}
// One job per timer from the show blocks of the timer and its service. tz: the machine's zone (an
// OnCalendar line that names its own zone wins).
export function systemdJob({unit,service,next,last},timer={},svc={},{scope='user',group='',tz=''}={}){
  const cal=[].concat(timer.TimersCalendar??[]).map(v=>/OnCalendar=(.*?)\s*;/.exec(v)?.[1]).filter(Boolean);
  const mono=[].concat(timer.TimersMonotonic??[]).map(v=>/(On\w+)=(.*?)\s*;/.exec(v)).filter(Boolean).map(m=>[m[1],m[2]]);
  const triggers=systemdTriggers(cal,mono),zone=cal.map(calendarZone).find(Boolean)||tz;
  const command=tidy(execOf(svc.ExecStart)),lastRun=last||showTime(timer.LastTriggerUSec),nextRun=next||showTime(timer.NextElapseUSecRealtime);
  const running=/^(active|activating|reloading|deactivating)$/.test(svc.ActiveState||'');
  const lastStatus=running?'running':!lastRun||!svc.Result?'unknown':svc.Result==='success'?'ok':'failed';
  return {id:`systemd:${scope}:${unit}`,name:clip(svc.Description||timer.Description||unit.replace(/\.timer$/,''),120),source:'systemd',group,
    schedule:clip(cal.length?cal.map(humaniseOnCalendar).join('; '):humaniseMonotonic(mono)||'Unknown',200),
    ...(zone?{timezone:zone}:{}),...(triggers.length?{triggers}:{}),origin:'machine',...(command?{command}:{}),ai:aiCommand(command),
    enabled:timer.ActiveState?timer.ActiveState==='active':!/^(disabled|masked)/.test(timer.UnitFileState||''),
    ...(lastRun?{lastRun}:{}),lastStatus,...(nextRun?{nextRun}:{}),...(isDistroTimer(unit)?{distro:true}:{})};
}
// Crontab text to jobs (one a line; comments and VAR=value lines skipped). Times are in tz (the
// machine's zone), or in the zone a CRON_TZ= line sets for the lines after it (cronie).
export function crontabJobs(text,{group='',now=new Date(),tz=''}={}){
  const out=[];let zone='';
  for(const raw of String(text).split('\n')){
    const line=raw.trim(),ctz=/^CRON_TZ\s*=\s*["']?([^"'\s]*)["']?$/.exec(line);
    if(ctz){zone=validTz(ctz[1])?ctz[1]:'';continue}
    if(!line||line.startsWith('#')||/^[A-Za-z_]\w*\s*=/.test(line))continue;
    const w=line.split(/\s+/),n=w[0].startsWith('@')?1:5;
    if(w.length<=n)continue;
    const expr=w.slice(0,n).join(' '),command=w.slice(n).join(' ');
    if(n===5&&!parseCron(expr))continue;
    const next=zone?nextCron(expr,now,{tz:zone}):nextCron(expr,now),schedule=humaniseCron(expr,{utc:zone==='UTC'}),z=zone||tz;
    out.push({id:`cron:user:${createHash('sha1').update(line).digest('hex').slice(0,12)}`,name:commandName(shortHome(command)),source:'cron',group,
      schedule,cron:clip(expr,120),...(z?{timezone:z}:{}),triggers:[{kind:/^@reboot$/i.test(expr)?'boot':'cron',expr:clip(expr,200),text:schedule}],origin:'machine',
      command:tidy(command),ai:aiCommand(command),enabled:true,lastStatus:'unknown',...(next?{nextRun:next}:{})});
  }
  return out;
}
// Repo cron configs. Vercel, Railway and GitHub run crons in UTC. file: the config's path in the repo.
const cronTimes=(expr,now)=>{const next=nextCron(expr,now,{utc:true}),schedule=humaniseCron(expr,{utc:true});
  return {schedule,cron:clip(expr,120),timezone:'UTC',triggers:[{kind:'cron',expr:clip(expr,200),text:schedule}],...(next?{nextRun:next}:{})}};
const repoCron=(expr,now,file)=>({...cronTimes(expr,now),origin:'repo',...(file?{file:clip(file,200)}:{}),ai:false,enabled:true,lastStatus:'unknown'});
// ctx (optional, for the note): read(path in the repo) gives a file's text or null; project: the
// Vercel project the folder is linked to (.vercel/project.json).
export function vercelJobs(text,{repo,file='vercel.json',dir='',ctx={},now=new Date()}){
  let d;try{d=JSON.parse(text)}catch{return []}
  return (Array.isArray(d?.crons)?d.crons:[]).filter(c=>c?.path&&c?.schedule).map(c=>{
    const note=ctx.read?noteFrom(vercelEntry(c.path,dir,ctx.read),{comment:true}):'';
    return {id:clip(`vercel:${repo}:${c.path}`,200),name:clip(c.path,120),source:'vercel',
      group:clip(`Vercel · ${repo}`,120),command:clip(`GET ${c.path}`,300),...repoCron(c.schedule,now,file),...(note?{note}:{}),
      _match:{platform:'vercel',name:basename(repo),projectId:ctx.project?.projectId||'',path:String(c.path)}};
  });
}
// The source of a Vercel cron's route: api/…, app/api/…/route, pages/api/… (with src/), or ''.
function vercelEntry(path,dir,read){
  const p=String(path).split('?')[0].replace(/^\/+|\/+$/g,'');if(!p||p.includes('..'))return '';
  const at=x=>dir?`${dir}/${x}`:x,ext=['ts','js','mjs','tsx','py','go'];
  for(const base of ['','src/'])for(const c of [...ext.map(e=>`${base}${p}.${e}`),...ext.map(e=>`${base}${p}/index.${e}`),...['ts','js'].map(e=>`${base}app/${p}/route.${e}`),...['ts','js'].map(e=>`${base}pages/${p}.${e}`)]){
    const t=read(at(c));if(t)return t;
  }
  return '';
}
// railway.json or railway.toml: deploy.cronSchedule (and startCommand for the summary).
export function railwayConfig(text,toml=false){
  if(!toml){try{const d=JSON.parse(text);return {cronSchedule:d?.deploy?.cronSchedule||'',startCommand:d?.deploy?.startCommand||''}}catch{return {}}}
  const out={};let section='';
  for(const l of String(text).split('\n')){
    const s=l.replace(/\s+#.*$/,'').trim(),sec=/^\[([^\]]+)\]$/.exec(s);
    if(sec){section=sec[1].trim();continue}
    const kv=/^(cronSchedule|startCommand)\s*=\s*(["'])(.*)\2$/.exec(s);
    if(kv&&(section==='deploy'||section===''))out[kv[1]]=kv[3];
  }
  return out;
}
// ctx (optional, for the note): readme, the service folder's README text; read(path in the repo) for
// the start command's script. alias: the service name Railway may know it by (railway.<alias>.json).
export function railwayJobs(text,{repo,service,file,toml=false,alias='',ctx={},now=new Date()}){
  const c=railwayConfig(text,toml);if(!c.cronSchedule)return [];
  const dir=file.includes('/')?file.slice(0,file.lastIndexOf('/')):'',script=entryScript(c.startCommand);
  const note=noteFrom(ctx.readme||'')||(script&&ctx.read?noteFrom(ctx.read(dir?`${dir}/${script}`:script)||'',{comment:true}):'');
  return [{id:clip(`railway:${repo}:${file}`,200),name:clip(service,120),source:'railway',group:clip(`Railway · ${service}`,120),
    ...(c.startCommand?{command:tidy(c.startCommand)}:{}),...repoCron(c.cronSchedule,now,file),...(note?{note}:{}),
    _match:{platform:'railway',names:[...new Set([service,alias,dir?basename(dir):'',repo].filter(Boolean))]}}];
}
// The script a start command runs ("node run.mjs" -> run.mjs), or ''.
export function entryScript(cmd){
  const w=String(cmd||'').trim().split(/\s+/).filter(x=>!/^[A-Za-z_]\w*=/.test(x));
  const f=w.find((x,i)=>i<4&&/^[\w./-]+\.(m?js|cjs|ts|py|sh|rb)$/.test(x)&&!x.includes('..'));
  return f?f.replace(/^\.\//,''):'';
}
// GitHub Actions: the workflow name and every on.schedule cron, by simple line reading.
export function workflowCrons(text){
  let name='',sched=-1;const crons=[];
  for(const l of String(text).split('\n')){
    if(!l.trim()||/^\s*#/.test(l))continue;
    const ind=l.length-l.trimStart().length,s=l.trim();
    const n=/^name\s*:\s*(["']?)(.*?)\1\s*(#.*)?$/.exec(l);if(n&&ind===0)name=n[2];
    if(sched>=0&&ind<=sched&&!s.startsWith('-'))sched=-1;
    if(/^schedule\s*:/.test(s)){sched=ind;for(const m of s.matchAll(/cron\s*:\s*(["'])(.*?)\1/g))crons.push(m[2].trim());continue}
    if(sched>=0){const m=/^-?\s*cron\s*:\s*(["']?)(.*?)\1\s*(#.*)?$/.exec(s);if(m)crons.push(m[2].trim())}
  }
  return {name,crons};
}
export function workflowJobs(text,{repo,file,now=new Date()}){
  const {name,crons}=workflowCrons(text),note=noteFrom(text,{comment:true});
  return crons.map((c,i)=>({id:clip(`github:${repo}:${file}${crons.length>1?`#${i+1}`:''}`,200),name:clip(`${name||file}${crons.length>1?` (${i+1})`:''}`,120),
    source:'github',group:clip(`GitHub · ${repo}`,120),command:clip(`.github/workflows/${file}`,300),...repoCron(c,now,`.github/workflows/${file}`),...(note?{note}:{})}));
}
// A short note on conditions a job's script applies itself, read from a README or a script's leading
// comment (comment: true), or ''. Conservative: the first sentence (in the first 4000 characters,
// outside code blocks and headings) that says how often it runs, that it exits, or a condition ("only
// when", "unless", "unchanged", "skips"…), plus, when that first one says no condition, the first that
// does, if both fit in 200 characters. Sentences that mention secrets, tokens or credentials are never
// used, and what looks like a secret is hidden.
const NOTE_STRONG=/\b(only (when|if|on|after|while)|unless|unchanged|no (new )?changes?|nothing (new|changed|to do)|skips?|skipped|do(es)? not (run|publish|send|post)|no-?op|exits? (early|immediately|without|when|if|unless))\b/i;
const NOTE_WEAK=/\b(every (\w+|\d+) (minutes?|hours?|seconds?|days?|weeks?)|and exits|then exits|retr(y|ies) (at|on) the next run)\b/i;
const NOTE_SECRET=/(token|secret|password|passwd|credential|api[_ -]?key|private key|_URL\b|connection string|bearer)/i;
// Code, not prose: braces, arrows, assignments, statements.
const NOTE_CODE=/[{}<>]|=>|\s=\s|\b(function|const|let|import|export|return)\s/;
export function noteFrom(text,{comment=false}={}){
  let t=String(text??'').replace(/^﻿/,'');
  if(comment){
    // The leading comment: //, # (not a shebang) lines, a /* … */ block, or a Python docstring.
    const lines=t.split('\n'),out=[];let i=0;
    if(lines[0]?.startsWith('#!'))i++;
    while(i<lines.length&&!lines[i].trim())i++;
    const first=lines[i]?.trim()||'';
    if(/^\/\*/.test(first)){const a=t.indexOf('/*'),end=t.indexOf('*/',a);t=end<0?'':t.slice(a+2,end).split('\n').map(l=>l.replace(/^\s*\*\s?/,'')).join('\n')}
    else if(/^("{3}|'{3})/.test(first)){const q=first.slice(0,3),body=t.slice(t.indexOf(q)+3),end=body.indexOf(q);t=end<0?'':body.slice(0,end)}
    else{for(;i<lines.length;i++){const m=/^\s*(\/\/+|#+)\s?(.*)$/.exec(lines[i]);if(!m)break;out.push(m[2])}t=out.join('\n')}
  }
  t=t.slice(0,4000).replace(/```[\s\S]*?(```|$)/g,'\n\n').replace(/<[^>]+>/g,' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[`*_]{1,3}([^`*_\n]+)[`*_]{1,3}/g,'$1');
  const paras=t.split(/\n\s*\n/).map(p=>p.split('\n').filter(l=>!/^\s*(#{1,6}\s|[-=]{3,}\s*$|\||@\w+)/.test(l)).map(l=>l.replace(/^\s*([-*+]|\d+\.)\s+/,'')).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean);
  const sentences=paras.flatMap(p=>p.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)).map(x=>x.trim()).filter(x=>x.length>=12&&x.length<=200&&!NOTE_SECRET.test(x)&&!NOTE_CODE.test(x));
  const strong=sentences.find(x=>NOTE_STRONG.test(x)),first=sentences.find(x=>NOTE_STRONG.test(x)||NOTE_WEAK.test(x));
  if(!first)return '';
  const end=x=>/[.!?]$/.test(x)?x:x+'.';
  const both=strong&&first!==strong?`${end(first)} ${end(strong)}`:'';
  return clip(redact(both&&both.length<=200?both:end(first)),200);
}
// Notes from the settings ("notes": {"<job id or name, a glob or substring>": "text"}) win over the
// ones found: the first key that matches a job's id or name gives its note (text up to 500, secrets
// hidden; "" removes the note found).
export function applyNotes(jobs,notes){
  const list=notes&&typeof notes==='object'&&!Array.isArray(notes)?Object.entries(notes).filter(([k,v])=>k&&typeof v==='string'):[];
  if(!list.length)return jobs;
  return jobs.map(j=>{
    const hit=list.find(([k])=>matches(k,j.id)||matches(k,j.name));if(!hit)return j;
    const note=clip(redact(hit[1]),500),{note:_,...rest}=j;return note?{...rest,note}:rest;
  });
}
// T3 scheduled task schedules: {type:'interval',everyMs}, {type:'fixed_time',timeOfDay,weekdays?}, {type:'webhook'}.
export function t3Schedule(s){
  if(s?.type==='interval'&&s.everyMs>0){
    const ms=s.everyMs,[n,u]=ms%864e5===0?[ms/864e5,'day']:ms%36e5===0?[ms/36e5,'h']:[Math.round(ms/6e4),'min'];
    return n===1?{day:'Every day',h:'Hourly',min:'Every minute'}[u]:`Every ${n} ${u==='day'?'days':u}`;
  }
  if(s?.type==='fixed_time'&&s.timeOfDay){
    const [h,m='0']=String(s.timeOfDay).split(':'),t=hm(+h,+m);
    return `${Array.isArray(s.weekdays)&&s.weekdays.length?dayPhrase(s.weekdays):'Daily'} ${t}`;
  }
  if(s?.type==='webhook')return 'On webhook';
  return 'Unknown';
}
// A T3 schedule as a trigger: the raw schedule JSON as T3 holds it, and it in words.
export function t3Trigger(s){
  const kind=s?.type==='interval'?'interval':s?.type==='fixed_time'?'calendar':'other';
  let expr='';try{expr=s?JSON.stringify(s):''}catch{}
  return {kind,...(expr?{expr:clip(expr,200)}:{}),text:t3Schedule(s)};
}
const anyTime=v=>{if(v==null||v==='')return undefined;const n=Number(v);const t=Number.isFinite(n)?(n>1e12?n:n*1000):Date.parse(v);return Number.isFinite(t)&&t>0?new Date(t).toISOString():undefined};
const t3Status=s=>/^(succeeded|success|completed|ok|done)$/i.test(s||'')?'ok':/fail|error|timed?_?out|cancel/i.test(s||'')?'failed':/^(running|in_progress|started|active)$/i.test(s||'')?'running':'unknown';

// T3's state database, read only, with Node's built-in SQLite (Node 22.5+).
async function openT3(t3Home,note){
  const file=join(t3Home,'userdata','statev2.sqlite');
  if(!existsSync(file)){note(`no T3 database in ${t3Home}; skipping T3 tasks and project repos`);return null}
  let sqlite;
  const warn=process.emitWarning;
  process.emitWarning=function(w,...a){if(/SQLite/i.test(String(w?.message??w)))return;return warn.call(this,w,...a)};
  try{sqlite=await import('node:sqlite')}catch{note('node:sqlite is not in this Node version; skipping T3 tasks and project repos');return null}
  finally{process.emitWarning=warn}
  try{return new sqlite.DatabaseSync(file,{readOnly:true})}catch(e){note(`cannot open the T3 database: ${e.message}`);return null}
}
const columns=(db,table)=>new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
function t3Jobs(db,note,tz=''){
  const cols=columns(db,'scheduled_tasks');
  if(!cols.has('task_id')){note('T3 has no scheduled_tasks table');return []}
  // Only these columns: the table also holds webhook tokens and secrets.
  const want=['task_id','title','prompt','enabled','schedule_json','project_id','model_selection_json','next_run_at','last_run_at','last_run_status'].filter(c=>cols.has(c));
  const titles=new Map(columns(db,'projection_projects').has('title')?db.prepare('SELECT project_id,title FROM projection_projects').all().map(r=>[r.project_id,r.title]):[]);
  const json=s=>{try{return JSON.parse(s)}catch{return null}};
  return db.prepare(`SELECT ${want.join(',')} FROM scheduled_tasks`).all().map(r=>{
    const ms=json(r.model_selection_json)||{},model=[ms.instanceId||ms.provider,ms.model].filter(x=>typeof x==='string'&&x).join(':');
    const prompt=String(r.prompt||'').split('\n').find(l=>l.trim())||'',lastRun=anyTime(r.last_run_at),nextRun=anyTime(r.next_run_at);
    const project=titles.get(r.project_id),sch=json(r.schedule_json),zone=[sch?.timezone,sch?.timeZone,sch?.tz].find(z=>typeof z==='string'&&z&&validTz(z))||tz;
    return {id:clip(`t3:${r.task_id}`,200),name:clip(r.title||prompt||r.task_id,120),source:'t3',group:clip(project?`T3 · ${project}`:'T3',120),
      schedule:clip(t3Schedule(sch),200),...(zone?{timezone:zone}:{}),triggers:[t3Trigger(sch)],origin:'machine',command:clip(redact((model?`${model} · `:'')+prompt),300),ai:true,
      enabled:r.enabled===undefined?true:!!Number(r.enabled),...(lastRun?{lastRun}:{}),lastStatus:lastRun?t3Status(r.last_run_status):'unknown',...(nextRun?{nextRun}:{})};
  });
}
function t3Roots(db){
  const cols=columns(db,'projection_projects');if(!cols.has('workspace_root'))return [];
  return db.prepare(`SELECT workspace_root FROM projection_projects${cols.has('deleted_at')?' WHERE deleted_at IS NULL':''}`).all().map(r=>r.workspace_root).filter(Boolean);
}
function systemdJobs(scope,group,note,tz=''){
  const base=scope==='user'?['--user']:[],sc=a=>run('systemctl',[...base,'--no-pager',...a],{timeout:5000});
  let timers=null;
  const r=sc(['list-timers','--all','--output=json']);
  if(r.error?.code==='ENOENT'){note('no systemctl; skipping systemd timers');return []}
  if(r.status===0){try{const d=JSON.parse(r.stdout);if(Array.isArray(d))timers=d.map(t=>({unit:t.unit,service:t.activates||'',next:usec(t.next),last:usec(t.last)}))}catch{}}
  if(!timers){
    const t=sc(['list-timers','--all','--no-legend']);
    if(t.status!==0){note(`systemctl ${scope} list-timers failed: ${clip(t.stderr||t.error?.message,160)}`);return []}
    timers=parseTimerList(t.stdout);
  }
  timers=timers.filter(t=>t.unit);
  if(!timers.length)return [];
  const show=(props,units)=>{
    let s=sc(['show','--timestamp=unix','-p',props,...units]);
    if(s.status!==0)s=sc(['show','-p',props,...units]);
    return new Map(s.status===0?parseShow(s.stdout).filter(b=>b.Id).map(b=>[b.Id,b]):[]);
  };
  const T=show('Id,Description,OnCalendar,TimersCalendar,TimersMonotonic,Unit,UnitFileState,ActiveState,LastTriggerUSec,NextElapseUSecRealtime,Result',timers.map(t=>t.unit));
  for(const t of timers)t.service||=[].concat(T.get(t.unit)?.Unit??'')[0]||t.unit.replace(/\.timer$/,'.service');
  const S=show('Id,ExecStart,Result,ActiveState,ExecMainStatus,Description',[...new Set(timers.map(t=>t.service))]);
  return timers.map(t=>systemdJob(t,T.get(t.unit),S.get(t.service),{scope,group,tz}));
}
// The cron configs of one repo, from its files: [{dir, name, text}], dir '' for the root, e.g.
// 'services/api', or '.github/workflows'. Used for local repos and for repos on a remote machine.
// A README.md in a service's folder (and .vercel/project.json, with dir '<dir>/.vercel') may come
// with them, for the note and the Vercel project; read(path in the repo), when given, reads other
// files (the scripts crons run) for the note.
export function repoFileJobs(repo,files,{sources=new Set(['vercel','railway','github']),now=new Date(),read=null}={}){
  const out=[],of=(dir,re)=>files.find(f=>(f.dir||'')===dir&&re.test(f.name))?.text||'';
  for(const {dir='',name,text} of files){
    if(dir==='.github/workflows'){if(sources.has('github')&&/\.ya?ml$/.test(name))out.push(...workflowJobs(text,{repo,file:name,now}));continue}
    const at=x=>dir?`${dir}/${x}`:x;
    if(sources.has('vercel')&&name==='vercel.json'){
      let project=null;try{project=JSON.parse(of(dir?`${dir}/.vercel`:'.vercel',/^project\.json$/)||'null')}catch{}
      out.push(...vercelJobs(text,{repo:dir?`${repo}/${dir}`:repo,file:at(name),dir,ctx:{read,project},now}));
    }
    if(sources.has('railway')&&/^railway(\.[\w.-]+)?\.(json|toml)$/.test(name)){
      // railway.<name>.json is a config for another service: "<repo> (<name>)".
      const extra=name.replace(/\.(json|toml)$/,'').replace(/^railway\.?/,''),base=dir?basename(dir):repo;
      out.push(...railwayJobs(text,{repo,service:extra?`${base} (${extra})`:base,alias:extra,file:at(name),toml:name.endsWith('.toml'),now,
        ctx:{readme:extra?'':of(dir,/^readme\.md$/i),read}}));
    }
  }
  return out;
}
const REPO_FILE=/^(vercel\.json|railway(\.[\w.-]+)?\.(json|toml)|readme\.md)$/i;
function repoJobs(roots,sources,note,now){
  const out=[],ls=d=>{try{return readdirSync(d)}catch{return []}},isDir=p=>{try{return statSync(p).isDirectory()}catch{return false}};
  const seen=new Set();
  for(const r of roots){
    let root;try{root=realpathSync(tilde(r))}catch{continue}
    if(seen.has(root)||!isDir(root))continue;seen.add(root);
    const repo=basename(root);
    try{
      const dirs=[root,...['services','apps'].flatMap(s=>ls(join(root,s)).map(x=>join(root,s,x)).filter(isDir))],files=[];
      for(const dir of dirs){
        const names=ls(dir).filter(f=>REPO_FILE.test(f));
        // A README only matters next to a cron config.
        if(!names.some(f=>!/^readme\.md$/i.test(f)))continue;
        for(const f of names)files.push({dir:relative(root,dir),name:f,text:readFileSync(join(dir,f),'utf8').slice(0,200000)});
        const vp=join(dir,'.vercel','project.json');
        if(existsSync(vp))files.push({dir:relative(root,join(dir,'.vercel')),name:'project.json',text:readFileSync(vp,'utf8').slice(0,10000)});
      }
      const wf=join(root,'.github','workflows');
      for(const f of ls(wf).filter(f=>/\.ya?ml$/.test(f)))files.push({dir:'.github/workflows',name:f,text:readFileSync(join(wf,f),'utf8')});
      // Scripts named by crons, for their notes: inside the repo only, and small files only.
      const read=rel=>{try{const p=join(root,rel);if(relative(root,p).startsWith('..')||statSync(p).size>200000)return null;return readFileSync(p,'utf8')}catch{return null}};
      out.push(...repoFileJobs(repo,files,{sources,now,read}));
    }catch(e){note(`${repo}: ${e.message}`)}
  }
  return out;
}
// ---------- platform schedules (Railway, Vercel) ----------
// With a token in the settings, the live cron schedules are read from the hosting platform and
// matched to the repo's cron configs: a matched job is reported as the platform runs it (origin
// 'platform', its file kept), with drift saying how the repo file differs; a live cron no repo file
// has is reported too. Without a token nothing is asked. Matching and comparing are pure (below).
// Two cron lines are the same schedule when they fire at the same times ("*/5" and "0-59/5").
export function sameCron(a,b){
  const x=String(a??'').trim().replace(/\s+/g,' '),y=String(b??'').trim().replace(/\s+/g,' ');
  if(x===y)return true;
  const p=parseCron(x),q=parseCron(y);if(!p||!q)return false;
  const sets=c=>JSON.stringify(['min','hour','dom','mon','dow'].map(k=>[...c[k]].sort((m,n)=>m-n)).concat([c.domStar,c.dowStar]));
  return sets(p)===sets(q);
}
// How a repo file's cron differs from the platform's live one: '' when they agree. live null or ''
// means the platform has no cron for it.
export function scheduleDrift({platform='Railway',file='',fileExpr='',live=null}={}){
  const f=file||'the repo file',ex=String(fileExpr||'').trim();
  if(live==null||!String(live).trim())return clip(`${platform} has no cron schedule for it; ${f} has ${ex||'one'}${ex?` (${humaniseCron(ex,{utc:true})})`:''}`,200);
  if(!ex)return clip(`${f} has no cron schedule; ${platform} runs ${String(live).trim()}`,200);
  if(sameCron(ex,live))return '';
  return clip(`${platform} runs ${String(live).trim()} (${humaniseCron(live,{utc:true})}); ${f} has ${ex} (${humaniseCron(ex,{utc:true})})`,200);
}
const norm=s=>String(s??'').toLowerCase().replace(/[^a-z0-9]+/g,'');
// Railway's GraphQL answer to services: [{projectId, project, serviceId, service, environment,
// cronSchedule, nextRun, startCommand}], one a service (its production instance, else the one with a
// cron, else the first).
export function railwayServices(data){
  const edges=x=>Array.isArray(x?.edges)?x.edges.map(e=>e?.node).filter(Boolean):[];
  const projects=[...edges(data?.projects),...edges(data?.me?.projects)],out=[],seen=new Set();
  for(const p of projects){
    if(!p?.id||seen.has(p.id))continue;seen.add(p.id);
    const envs=new Map(edges(p.environments).map(e=>[e.id,e.name||'']));
    for(const sv of edges(p.services)){
      const inst=edges(sv.serviceInstances),prod=x=>/^prod/i.test(envs.get(x.environmentId)||'');
      const i=inst.find(x=>prod(x)&&x.cronSchedule)||inst.find(x=>x.cronSchedule)||inst.find(prod)||inst[0]||{};
      out.push({projectId:p.id,project:p.name||'',serviceId:sv.id||'',service:sv.name||'',environment:envs.get(i.environmentId)||'',
        cronSchedule:i.cronSchedule||'',nextRun:anyTime(i.nextCronRunAt)||'',startCommand:i.startCommand||''});
    }
  }
  return out;
}
// Vercel projects (as /v9/projects lists them, or one project) to [{projectId, project, path,
// schedule, enabled, known}]: known is false when the answer had no crons field (nothing can be said).
export function vercelCrons(projects){
  const out=[];
  for(const p of Array.isArray(projects)?projects:[]){
    if(!p?.id)continue;
    if(!p.crons||typeof p.crons!=='object'){out.push({projectId:p.id,project:p.name||'',known:false});continue}
    const enabled=!p.crons.disabledAt;
    for(const d of Array.isArray(p.crons.definitions)?p.crons.definitions:[])if(d?.path&&d?.schedule)
      out.push({projectId:p.id,project:p.name||'',path:String(d.path),schedule:String(d.schedule),enabled,known:true});
    if(!(p.crons.definitions||[]).length)out.push({projectId:p.id,project:p.name||'',known:true,enabled,none:true});
  }
  return out;
}
const asPlatform=(j,expr,now,platform,nextRun)=>{
  const t=cronTimes(expr,now);
  return {...j,...t,origin:'platform',...(nextRun?{nextRun}:{}),_drift:platform};
};
// Repo jobs (with _match) and the platform's live crons to the jobs to report: matched ones as the
// platform runs them, with drift; the rest as they were; then the platform's crons no file matched.
export function mergePlatform(jobs,{railway=null,vercel=null}={},{now=new Date()}={}){
  const used=new Set(),out=[];
  for(const j of jobs){
    const m=j._match;
    if(m?.platform==='railway'&&railway){
      const names=new Set(m.names.map(norm)),hits=railway.filter(s=>names.has(norm(s.service)));
      // A name several projects use: the one named like the repo, else the one with a cron.
      const s=hits.length===1?hits[0]:hits.find(x=>names.has(norm(x.project))&&x.cronSchedule)||hits.find(x=>x.cronSchedule)||hits[0];
      if(s){used.add(s.serviceId||s.service);
        const drift=scheduleDrift({platform:'Railway',file:j.file,fileExpr:j.cron,live:s.cronSchedule||null});
        out.push(s.cronSchedule?{...asPlatform(j,s.cronSchedule,now,'railway',s.nextRun),...(drift?{drift}:{})}:{...j,...(drift?{drift}:{})});continue}
    }
    if(m?.platform==='vercel'&&vercel){
      const proj=vercel.filter(v=>m.projectId?v.projectId===m.projectId:norm(v.project)===norm(m.name));
      if(proj.length&&proj.every(v=>v.known!==false)){
        const v=proj.find(x=>x.path===m.path);
        if(v){used.add(`${v.projectId}${v.path}`);
          const drift=scheduleDrift({platform:'Vercel',file:j.file,fileExpr:j.cron,live:v.schedule});
          out.push({...asPlatform(j,v.schedule,now,'vercel'),enabled:v.enabled!==false&&j.enabled!==false,...(drift?{drift}:v.enabled===false?{drift:'Crons are turned off for this project on Vercel'}:{})});continue}
        out.push({...j,drift:clip(`Not among ${proj[0].project||'the project'}'s live crons on Vercel; ${j.file||'vercel.json'} has ${j.cron} (not deployed yet?)`,200)});continue;
      }
    }
    out.push(j);
  }
  for(const s of railway||[])if(s.cronSchedule&&!used.has(s.serviceId||s.service))
    out.push({id:clip(`railway:${s.project}/${s.service}`,200),name:clip(s.service,120),source:'railway',group:clip(`Railway · ${s.service}`,120),
      ...cronTimes(s.cronSchedule,now),origin:'platform',...(s.nextRun?{nextRun:s.nextRun}:{}),...(s.startCommand?{command:tidy(s.startCommand)}:{}),
      note:clip(`Only on Railway (project ${s.project}${s.environment?`, ${s.environment}`:''}): no repo file has this cron`,200),ai:aiCommand(s.startCommand),enabled:true,lastStatus:'unknown'});
  for(const v of vercel||[])if(v.path&&!used.has(`${v.projectId}${v.path}`))
    out.push({id:clip(`vercel:${v.project}:${v.path}`,200),name:clip(v.path,120),source:'vercel',group:clip(`Vercel · ${v.project}`,120),
      ...cronTimes(v.schedule,now),origin:'platform',command:clip(`GET ${v.path}`,300),
      note:clip(`Only on Vercel (project ${v.project}): no vercel.json read here has this cron`,200),ai:false,enabled:v.enabled!==false,lastStatus:'unknown'});
  return out.map(({_drift,...j})=>j);
}
const RAILWAY_API='https://backboard.railway.com/graphql/v2';
const RAILWAY_Q=(next=true,ws=false)=>`query${ws?'($w:String!)':''}{projects${ws?'(workspaceId:$w)':''}{edges{node{id name environments{edges{node{id name}}}services{edges{node{id name serviceInstances{edges{node{environmentId cronSchedule startCommand${next?' nextCronRunAt':''}}}}}}}}}}}`;
async function railwayLive(token,{workspace='',note=()=>{}}={}){
  const ask=async q=>{
    const r=await fetch(RAILWAY_API,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({query:q,...(workspace?{variables:{w:workspace}}:{})}),signal:AbortSignal.timeout(20000)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok&&!d?.data)throw new Error(`HTTP ${r.status}${d?.errors?.[0]?.message?`: ${clip(d.errors[0].message,160)}`:''}`);
    return d;
  };
  let d=await ask(RAILWAY_Q(true,!!workspace));
  // An API without nextCronRunAt: ask again without it.
  if(d?.errors?.length&&!d?.data?.projects&&/nextCronRunAt/.test(JSON.stringify(d.errors)))d=await ask(RAILWAY_Q(false,!!workspace));
  if(d?.errors?.length&&!d?.data?.projects)throw new Error(clip(d.errors.map(e=>e.message).join('; '),200));
  return railwayServices(d.data);
}
async function vercelLive(token,{team='',note=()=>{},want=[]}={}){
  const q=team?`${/^team_/.test(team)?'teamId':'slug'}=${encodeURIComponent(team)}`:'';
  const get=async path=>{
    const r=await fetch(`https://api.vercel.com${path}${path.includes('?')?'&':'?'}${q}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(`HTTP ${r.status}${d?.error?.message?`: ${clip(d.error.message,160)}`:''}`);
    return d;
  };
  const projects=[];let until='';
  for(let page=0;page<10;page++){
    const d=await get(`/v9/projects?limit=100${until?`&until=${until}`:''}`);
    projects.push(...(Array.isArray(d?.projects)?d.projects:[]));
    until=d?.pagination?.next;if(!until)break;
  }
  // A list without crons: read the projects the repos are linked to one by one.
  const ids=new Set(want.map(w=>w.projectId).filter(Boolean)),names=new Set(want.map(w=>norm(w.name)));
  for(const [i,p] of projects.entries())if(!p.crons&&(ids.has(p.id)||names.has(norm(p.name)))){
    try{projects[i]=await get(`/v9/projects/${encodeURIComponent(p.id)}`)}catch(e){note(`Vercel project ${p.name}: ${e.message}`)}
  }
  return vercelCrons(projects);
}
// The platform pass: reads what the tokens allow and merges it into jobs. Failures are noted.
export async function platformJobs(jobs,c={},{note=()=>{},now=new Date(),env=process.env}={}){
  const o=c.jobs&&typeof c.jobs==='object'?c.jobs:{};
  const rt=c.railwayToken||env.RAILWAY_API_TOKEN||'',vt=c.vercelToken||env.VERCEL_TOKEN||'';
  if(o.platform===false||(!rt&&!vt))return jobs;
  const live={};
  if(rt){
    try{live.railway=await railwayLive(rt,{workspace:c.railwayWorkspace||'',note})}catch(e){note(`Railway API: ${e.message}`)}
  }
  if(vt){
    try{live.vercel=await vercelLive(vt,{team:c.vercelTeam||'',note,want:jobs.filter(j=>j._match?.platform==='vercel').map(j=>j._match)})}catch(e){note(`Vercel API: ${e.message}`)}
  }
  return mergePlatform(jobs,live,{now});
}
// A job as it is reported: without the fields used while discovering.
const bare=({distro,_match,...j})=>j;
// This machine's time zone: timedatectl's, else Node's.
let ZONE=null;
export function localZone(){
  if(ZONE!==null)return ZONE;
  const r=run('timedatectl',['show','-p','Timezone','--value'],{timeout:3000}),t=r.status===0?r.stdout.trim():'';
  ZONE=t&&validTz(t)?t:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  return ZONE;
}
export const jobsOn=c=>c?.jobs!==false&&c?.jobs?.enabled!==false;
const SOURCES=['systemd','cron','t3','vercel','railway','github'];
// Every scheduled job this machine knows of, filtered, deduplicated by id and capped at 500.
export async function discoverJobs(c={},{note=()=>{}}={}){
  const o=c.jobs&&typeof c.jobs==='object'?c.jobs:{},sources=new Set(Array.isArray(o.sources)?o.sources:SOURCES);
  const runner=clip(c.name||hostname(),100),now=new Date(),jobs=[],tz=localZone();
  const step=(label,fn)=>{try{jobs.push(...fn())}catch(e){note(`${label}: ${e.message}`)}};
  if(sources.has('systemd')){step('systemd user timers',()=>systemdJobs('user',runner,note,tz));step('systemd system timers',()=>systemdJobs('system',`${runner} · system`,note,tz))}
  if(sources.has('cron'))step('crontab',()=>{
    const r=run('crontab',['-l'],{timeout:5000});
    if(r.error?.code==='ENOENT')return [];
    if(r.status!==0){if(!/no crontab/i.test(r.stderr))note(`crontab -l: ${clip(r.stderr,160)}`);return []}
    return crontabJobs(r.stdout,{group:runner,now,tz});
  });
  const wantRepos=['vercel','railway','github'].some(s=>sources.has(s));
  const db=sources.has('t3')||(wantRepos&&!Array.isArray(o.repos))?await openT3(tilde(c.t3Home||'~/.t3'),note):null;
  try{
    if(db&&sources.has('t3'))step('T3 tasks',()=>t3Jobs(db,note,tz));
    if(wantRepos){
      let roots=Array.isArray(o.repos)?o.repos:[];
      if(!Array.isArray(o.repos)&&db)try{roots=t3Roots(db)}catch(e){note(`T3 projects: ${e.message}`)}
      step('repo crons',()=>repoJobs(roots,sources,note,now));
    }
  }finally{db?.close()}
  const seen=new Set();
  const found=filterJobs(jobs,{include:o.include||[],exclude:o.exclude||[],skipDistro:o.skipDistro!==false}).filter(j=>!seen.has(j.id)&&seen.add(j.id));
  const merged=await platformJobs(found,c,{note,now}),seen2=new Set();
  return applyNotes(filterJobs(merged,{include:o.include||[],exclude:o.exclude||[],skipDistro:false}).filter(j=>!seen2.has(j.id)&&seen2.add(j.id)).slice(0,500).map(bare),o.notes);
}
// The `jobs` table: one line a job, grouped. TZ is the zone the job's schedule is in, ORIGIN where it
// was read (repo, platform or machine; "!" marks drift from the repo file).
// Times are shown in tz (a remote's "timezone"), else in this machine's.
const when=(iso,tz='')=>{if(!iso)return '';const d=wf(wallOf(Date.parse(iso),tz));return `${d.y}-${pad2(d.mo)}-${pad2(d.d)} ${hm(d.h,d.mi)}`};
export function jobsTable(jobs,{tz=''}={}){
  if(!jobs.length)return 'No scheduled jobs found.';
  const rows=[...jobs].sort((a,b)=>(a.group||'').localeCompare(b.group||'')||a.name.localeCompare(b.name))
    .map(j=>[j.group||'',j.source,j.name,j.schedule,j.timezone||'',`${j.origin||''}${j.drift?'!':''}`,j.enabled===false?'off':'on',j.ai?'ai':'',when(j.lastRun,tz),j.lastStatus||'',when(j.nextRun,tz)]);
  const head=['GROUP','SOURCE','NAME','SCHEDULE','TZ','ORIGIN','ON','AI','LAST RUN','STATUS','NEXT RUN'],cap=[30,8,44,34,20,9,3,2,16,7,16];
  const cut=(s,n)=>s.length>n?s.slice(0,n-1)+'~':s;
  const w=head.map((h,i)=>Math.min(cap[i],Math.max(h.length,...rows.map(r=>r[i].length))));
  return [head,...rows].map(r=>r.map((x,i)=>cut(x,w[i]).padEnd(w[i])).join('  ').trimEnd()).join('\n');
}

// ---------- scheduled jobs on a remote machine (SSH) ----------
// A remote's raw data comes back from small scripts run over SSH (below); turning it into jobs is
// pure and exported for the tests, like the local parsers above.

// RFC 5545 recurrence rules as Aside and Codex write them: an optional DTSTART line (TZID=…, or
// UTC with Z, or floating) and an RRULE line (or the bare rule). null when there is no FREQ.
const DAY2={SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};
const stamp=v=>{const m=/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/i.exec(v);return m?{w:W(+m[1],+m[2],+m[3],+(m[4]||0),+(m[5]||0),+(m[6]||0)),utc:!!m[7]}:null};
export function parseRRule(text){
  const r={freq:'',interval:1,by:{}};
  for(const raw of String(text??'').replace(/\\n/g,'\n').split(/[\r\n]+/)){
    const line=raw.trim();let m;
    if(!line)continue;
    if((m=/^DTSTART(?:;TZID=([^:;]+))?:(\S+)$/i.exec(line))){const s=stamp(m[2]);if(s){r.start=s.w;r.tz=s.utc?'UTC':m[1]||''}continue}
    const body=line.replace(/^RRULE:/i,'');
    if(!/^[A-Z]+=/i.test(body))continue;
    for(const part of body.split(';')){
      const [k='',v='']=part.split('='),K=k.toUpperCase(),list=v.split(',');
      if(K==='FREQ')r.freq=v.toUpperCase();
      else if(K==='INTERVAL')r.interval=Math.max(1,parseInt(v)||1);
      else if(K==='COUNT')r.count=parseInt(v)||undefined;
      else if(K==='UNTIL'){const s=stamp(v);if(s)r.until=s}
      else if(K==='BYDAY'){r.by.day=list.map(x=>DAY2[x.slice(-2).toUpperCase()]).filter(x=>x!==undefined);if(list.some(x=>/^[+-]?\d/.test(x)))r.by.nth=true}
      else if(/^BY(HOUR|MINUTE|SECOND|MONTH|MONTHDAY)$/.test(K))r.by[K.slice(2).toLowerCase()]=list.map(Number).filter(Number.isFinite);
    }
  }
  return /^(MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(r.freq)?r:null;
}
// The next occurrence of a rule after `now` (ms): {next: ISO or null, first: ISO of the first
// occurrence or null, done: no occurrence after now}. Times are worked out in the rule's zone (its
// DTSTART TZID), else in tz. A rule without DTSTART starts at `anchor` (ms). null when the rule
// uses what this does not follow (BYDAY with a number, like 1MO).
export function rruleNext(r,{tz='',anchor=Date.now(),now=Date.now()}={}){
  if(typeof r==='string')r=parseRRule(r);
  if(!r||r.by.nth)return null;
  const z=r.tz||tz;if(!validTz(z))return null;
  const S=r.start??Math.floor(wallOf(anchor,z)/60000)*60000,s=wf(S),by=r.by,iv=r.interval||1;
  if((r.freq==='MONTHLY'||r.freq==='YEARLY')&&by.day)return null;
  const until=r.until?(r.until.utc?r.until.w:wallToMs(r.until.w,z)):Infinity;
  const hours=by.hour||[s.h],mins=by.minute||[s.mi],sec=(by.second||[s.s])[0]||0;
  const ok=w=>{const f=wf(w);return (!by.month||by.month.includes(f.mo))&&(!by.monthday||by.monthday.includes(f.d))&&(!by.day||by.day.includes(f.wd))&&(!by.hour||by.hour.includes(f.h))&&(!by.minute||by.minute.includes(f.mi))};
  const times=day=>hours.flatMap(h=>mins.map(m=>day+h*36e5+m*6e4+sec*1e3));
  const midnight=w=>w-(((w%864e5)+864e5)%864e5);
  const inMonth=(y,mo,d)=>{const w=W(y,mo,d);return wf(w).mo===((mo-1)%12+12)%12+1?[w]:[]};
  const period=p=>{
    switch(r.freq){
      case 'MINUTELY':return [S+p*iv*6e4];
      case 'HOURLY':{const f=wf(S+p*iv*36e5),b=W(f.y,f.mo,f.d,f.h);return mins.map(m=>b+m*6e4+sec*1e3)}
      case 'DAILY':return times(midnight(S)+p*iv*864e5);
      case 'WEEKLY':{const mon=midnight(S)-((s.wd+6)%7)*864e5+p*iv*7*864e5;return (by.day||[s.wd]).flatMap(d=>times(mon+((d+6)%7)*864e5))}
      case 'MONTHLY':{const t=s.mo-1+p*iv,y=s.y+Math.floor(t/12),mo=t%12+1;return (by.monthday||[s.d]).flatMap(d=>inMonth(y,mo,d)).flatMap(times)}
      default:{const y=s.y+p*iv;return (by.month||[s.mo]).flatMap(mo=>(by.monthday||[s.d]).flatMap(d=>inMonth(y,mo,d))).flatMap(times)}
    }
  };
  // Without COUNT the occurrences before now need no counting: start a little before now.
  const len={MINUTELY:6e4,HOURLY:36e5,DAILY:864e5,WEEKLY:7*864e5}[r.freq]*iv;
  let p=!r.count&&len&&Number.isFinite(now)?Math.max(0,Math.floor((wallOf(now,z)-S)/len)-2):0,n=0,first=null;
  const stop=(Number.isFinite(now)?wallOf(now,z):S)+5*366*864e5;
  for(let i=0;i<100000;i++,p++){
    const c=period(p).sort((a,b)=>a-b);
    if(c.length&&c[0]>stop)break;
    for(const w of c){
      if(w<S||!ok(w))continue;
      const t=wallToMs(w,z);
      if(t>until)return {next:null,first,done:true};
      n++;first??=new Date(t).toISOString();
      if(t>now)return {next:new Date(t).toISOString(),first,done:false};
      if(r.count&&n>=r.count)return {next:null,first,done:true};
    }
  }
  return {next:null,first,done:true};
}
// A rule as text: "Daily 09:00", "Tue-Fri 09:00", "Every 15 min", "Once Nov 1 18:00", with
// ", 7 times" or ", until Oct 27" when it ends. Times are in the rule's zone; a zone other than
// tz (the machine's) is named after the time. A UTC start without BYHOUR is shown in tz.
export function humaniseRRule(text,{tz='',anchor=Date.now()}={}){
  let r=typeof text==='string'?parseRRule(text):text;
  if(!r)return clip(text,200)||'Unknown';
  if(r.tz==='UTC'&&tz&&tz!=='UTC'&&r.start!==undefined&&!r.by.hour&&validTz(tz))r={...r,start:wallOf(r.start,tz),tz};
  const z=r.tz||tz,zone=r.tz&&r.tz!==tz?` ${r.tz}`:'';
  const s=r.start!==undefined?wf(r.start):null,by=r.by,iv=r.interval||1;
  if(r.count===1){const x=rruleNext(r,{tz,anchor,now:-Infinity});return x?.first?`Once ${dateIn(Date.parse(x.first),z)}${zone}`:'Once'}
  const H=by.hour||(s?[s.h]:null),M=by.minute||(s?[s.mi]:H?[0]:null);
  const t=H&&M?timesOf([...H].sort((a,b)=>a-b),[...M].sort((a,b)=>a-b)):null;
  const at=t?` ${t}`:H&&M?` (${H.length*M.length} times a day)`:'';
  const wd=s?s.wd:null;
  let base;
  switch(r.freq){
    case 'MINUTELY':base=iv===1?'Every minute':`Every ${iv} min`;break;
    case 'HOURLY':base=iv===1?(M?.length===1&&M[0]?`Hourly at :${pad2(M[0])}`:'Hourly'):`Every ${iv} h`;break;
    case 'DAILY':base=by.day?`${dayPhrase(by.day)}${at}`:iv===1?`Daily${at}`:`Every ${iv} days${at}`;break;
    case 'WEEKLY':{const d=by.day||(wd!==null?[wd]:null);base=`${iv>1?`Every ${iv} weeks, `:''}${d?dayPhrase(d):'Weekly'}${at}`;break}
    case 'MONTHLY':{const d=by.monthday||(s?[s.d]:null);base=`${iv>1?`Every ${iv} months`:'Monthly'}${d?` on day ${d.join(', ')}`:''}${at}`;break}
    default:{const mo=(by.month||(s?[s.mo]:[]))[0],d=(by.monthday||(s?[s.d]:[]))[0];base=`Yearly${mo&&d?` on ${MON[mo-1]} ${d}`:''}${at}`}
  }
  const end=r.count>1?`, ${r.count} times`:r.until?`, until ${(f=>`${MON[f.mo-1]} ${f.d}`)(wf(r.until.utc&&validTz(z)?wallOf(r.until.w,z):r.until.w))}`:'';
  return clip(base+zone+end,200);
}

// Windows Task Scheduler. A trigger as the PowerShell script sends it: {type (the CIM class, e.g.
// MSFT_TaskDailyTrigger), start (StartBoundary, local time), enabled, days (DaysInterval), weeks
// (WeeksInterval), dow (DaysOfWeek: Sunday 1, Monday 2, … Saturday 64), dom (DaysOfMonth: day 1
// is bit 0), wom (WeeksOfMonth: first 1 … fourth 8, last 16), interval and duration (Repetition,
// ISO 8601 durations such as PT15M)}.
export function isoDuration(s){
  const m=/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s??''));
  if(!m||!m.slice(1).some(Boolean))return null;
  const [d,h,mi,se]=m.slice(1).map(x=>+x||0);
  return {ms:((d*24+h)*60+mi)*6e4+se*1e3,text:[d&&`${d} day${d>1?'s':''}`,h&&`${h} h`,mi&&`${mi} min`,se&&`${se} s`].filter(Boolean).join(' ')};
}
const everyDur=d=>({'1 day':'Every day','1 h':'Hourly','1 min':'Every minute'}[d.text]||`Every ${d.text}`);
export function humaniseWinTrigger(t={}){
  const type=String(t.type||'').replace(/^MSFT_Task/,'').replace(/Trigger$/,''),start=String(t.start||'');
  const tm=/T(\d\d):(\d\d)/.exec(start),time=tm?`${tm[1]}:${tm[2]}`:'',at=time?` ${time}`:'';
  const rep=isoDuration(t.interval),dur=isoDuration(t.duration),allDay=!dur||dur.ms>=23*36e5;
  const days=[0,1,2,3,4,5,6].filter(i=>(+t.dow||0)&(1<<i));
  switch(type){
    case 'Daily':{
      if(rep&&allDay)return everyDur(rep);
      const base=+t.days>1?`Every ${+t.days} days${at}`:`Daily${at}`;
      return rep?`${base}, then every ${rep.text} for ${dur.text}`:base;
    }
    case 'Weekly':{
      const base=`${+t.weeks>1?`Every ${+t.weeks} weeks, `:''}${days.length?dayPhrase(days):'Weekly'}${at}`;
      return rep?`${base}, then every ${rep.text}${allDay?'':` for ${dur.text}`}`:base;
    }
    case 'Time':{
      if(rep)return rep.ms===864e5&&time?`Daily ${time}`:everyDur(rep);
      const d=/^(\d{4})-(\d\d)-(\d\d)/.exec(start);
      return d?`Once ${MON[+d[2]-1]} ${+d[3]}${+d[1]!==new Date().getFullYear()?` ${d[1]}`:''}${at}`:'Once';
    }
    case 'Monthly':{
      const dom=[...Array(32).keys()].filter(i=>(+t.dom||0)&(2**i)).map(i=>i+1),last=(+t.dom||0)&(2**31)?['the last day']:[];
      return `Monthly${dom.length||last.length?` on day ${[...dom.filter(d=>d<32),...last].join(', ')}`:''}${at}`;
    }
    case 'MonthlyDOW':{
      const w=['First','Second','Third','Fourth','Last'].filter((_,i)=>(+t.wom||0)&(1<<i));
      return days.length===1&&w.length===1?`${w[0]} ${DAYS_LONG[days[0]]} monthly${at}`:`Monthly${w.length?` (${w.join(', ').toLowerCase()} week)`:''}${days.length?` on ${dayPhrase(days)}`:''}${at}`;
    }
    case 'Logon':return rep?`At logon, then every ${rep.text}`:'At logon';
    case 'Boot':return rep?`At boot, then every ${rep.text}`:'At boot';
    case 'Event':return 'On an event';
    case 'Idle':return 'When idle';
    case 'Registration':return 'When created';
    case 'SessionStateChange':return 'On lock or unlock';
    default:return 'Custom trigger';
  }
}
// A trigger as {kind, expr, text}: expr is the trigger as Task Scheduler holds it (its type, start
// boundary, intervals, days and repetition), text it in words.
const WIN_KIND={Daily:'calendar',Weekly:'calendar',Monthly:'calendar',MonthlyDOW:'calendar',Logon:'logon',Boot:'boot'};
export function winTrigger(t={}){
  const type=String(t.type||'').replace(/^MSFT_Task/,'').replace(/Trigger$/,'')||'Custom',rep=isoDuration(t.interval),dur=isoDuration(t.duration);
  const kind=type==='Time'?(rep?'interval':'once'):type==='Daily'&&rep&&(!dur||dur.ms>=23*36e5)?'interval':WIN_KIND[type]||'other';
  const days=[0,1,2,3,4,5,6].filter(i=>(+t.dow||0)&(1<<i)).map(i=>DAYS[i]);
  const expr=[`${type}Trigger`,t.start&&`start ${t.start}`,+t.days>1&&`every ${+t.days} days`,+t.weeks>1&&`every ${+t.weeks} weeks`,days.length&&`on ${days.join(',')}`,
    +t.dom&&`days-of-month mask ${+t.dom}`,+t.wom&&`weeks-of-month mask ${+t.wom}`,t.interval&&`repeat ${t.interval}${t.duration?` for ${t.duration}`:''}`,t.enabled===false&&'(disabled)'].filter(Boolean).join(', ');
  return {kind,expr:clip(expr,200),text:clip(humaniseWinTrigger(t)+(t.enabled===false?' (off)':''),200)};
}
export function humaniseWinTriggers(list){
  const on=(Array.isArray(list)?list:[list]).filter(Boolean);
  if(!on.length)return 'On demand';
  const live=on.filter(t=>t.enabled!==false);
  if(!live.length)return 'On demand (triggers off)';
  return clip([...new Set(live.map(humaniseWinTrigger))].join('; '),200);
}
// Vendor tasks (updaters, telemetry, OEM helpers), skipped unless "include" names them. Globs on
// "\Folder\TaskName", ignoring case. "include" and "exclude" are tried on that and on the name.
export const VENDOR_TASKS=['*\\Adobe*','*Adobe *','*Brave*Update*','*MicrosoftEdgeUpdate*','\\Google*','*GoogleUpdate*','*Zoom*Update*',
  '*McAfee*','\\HP\\*','\\Hewlett-Packard\\*','*HPOneAgent*','\\Omen*','*SystemOptimizer*','*OneDrive *','*BlueStacks*',
  '*Git for Windows Updater*','*Quick Share*','*AsideUpdater*','*Dropbox*','*Opera*Autoupdate*','*Opera scheduled*','\\Mozilla\\*','*Firefox*',
  '*NVIDIA*','\\SoftLanding\\*','\\CreateExplorerShellUnelevatedTask','*EqualizerAPO*','*CCXProcess*','\\Intel\\*','\\Lenovo\\*',
  '\\Dell\\*','\\ASUS\\*','*npcapwatchdog*','*CCleaner*','*Avast*','*AVG*','*Norton*'];
export const isVendorTask=(path,list=VENDOR_TASKS)=>list.some(p=>matches(p,path));
// LastTaskResult (COM gives it signed): 0 is success; 0x41301 is running; the other SCHED_S_* codes mean it has not run
// (ready, disabled, never run, no more runs, not scheduled); anything else is a failure.
const WIN_IDLE=new Set([267008,267010,267011,267012,267013]);
export function winStatus(state,result,last){
  if(String(state)==='Running'||+result===267009)return 'running';
  if(!last||result==null||WIN_IDLE.has(+result))return 'unknown';
  return +result===0?'ok':'failed';
}
// Windows paths under the user's profile as ~, and secrets hidden, as tidy does for local commands.
const winTidy=(s,profile)=>{let x=String(s??'');if(profile)x=x.replace(new RegExp(profile.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'~');return clip(redact(x),300)};
export function windowsJobs(tasks,{group='',profile='',include=[],exclude=[],skipVendor=true,tz=''}={}){
  return (Array.isArray(tasks)?tasks:[]).filter(t=>t?.name).flatMap(t=>{
    const path=`${t.path||'\\'}${t.name}`,hit=list=>list.some(x=>matches(x,path)||matches(x,t.name));
    if(!hit(include)&&((skipVendor&&isVendorTask(path))||hit(exclude)))return [];
    const command=winTidy((Array.isArray(t.actions)?t.actions:[t.actions]).filter(Boolean).map(a=>/ComHandler/.test(a.type||'')?'COM handler':[a.exe,a.args].filter(Boolean).join(' ')).filter(Boolean).join(' && '),profile);
    const lastRun=anyTime(t.last),nextRun=anyTime(t.next);
    const trig=(Array.isArray(t.triggers)?t.triggers:[t.triggers]).filter(Boolean).slice(0,10).map(winTrigger);
    return [{id:clip(`windows:${path}`,200),name:clip(t.name,120),source:'windows',group:clip(group,120),schedule:humaniseWinTriggers(t.triggers),
      ...(tz?{timezone:tz}:{}),triggers:trig.length?trig:[{kind:'manual',text:'On demand'}],origin:'machine',...(command?{command}:{}),ai:aiCommand(command),enabled:String(t.state)!=='Disabled',...(lastRun?{lastRun}:{}),
      lastStatus:winStatus(t.state,t.result,lastRun),...(nextRun&&String(t.state)!=='Disabled'?{nextRun}:{})}];
  });
}

// Aside routines, as the Python script reads them from each state.db: the routines row (prompt cut
// short, the model from session_config) and `last`, the newest session of the routine with its
// newest turn ({status, started, finished, aborted}, unix seconds; an idle session is done, a
// suspended one waits for approval). A routine whose next_run_at has
// passed is stale (Aside is not running, or it missed it): its status is unknown.
const unix=v=>v==null||v===''?undefined:anyTime(+v>1e12?+v:+v*1000);
const STALE_GRACE=15*60e3;
// A rule as a trigger, and the zone its times are in: its DTSTART TZID, else tz (a UTC start
// without BYHOUR is shown in tz).
export function rruleTrigger(text,{tz='',anchor=Date.now()}={}){
  const raw=String(text??'').replace(/\\n/g,'\n').split(/[\r\n]+/).map(x=>x.trim()).filter(Boolean).join(' '),r=parseRRule(text);
  const zone=r?.tz&&!(r.tz==='UTC'&&!r.by.hour&&tz)?r.tz:tz;
  return {trigger:{kind:'rrule',...(raw?{expr:clip(raw,200)}:{}),text:humaniseRRule(text,{tz,anchor})},zone};
}
export function asideJobs(routines,{group='',tz='',zone=tz,now=Date.now()}={}){
  return (Array.isArray(routines)?routines:[]).filter(r=>r?.id).map(r=>{
    const next=anyTime(r.next_run_at),stale=r.status==='active'&&next&&Date.parse(next)<now-STALE_GRACE,l=r.last||{};
    const waiting=l.status==='suspended',lastRun=unix(l.started);
    const lastStatus=stale||!r.last?'unknown':waiting?'running':l.status==='errored'||l.aborted||/^(aborted|interrupted)$/.test(l.status||'')?'failed'
      :l.status==='idle'||l.finished?'ok':l.started?'running':'unknown';
    const model=[r.model?.provider,r.model?.modelId].filter(Boolean).join('/');
    const prompt=clip(String(r.prompt||'').split('\n').find(x=>x.trim())||'',200),anchor=unix(r.created_at)?Date.parse(unix(r.created_at)):now;
    const rt=rruleTrigger(r.rrule,{tz,anchor}),z=rt.zone||zone;
    return {id:clip(`aside:${r.id}`,200),name:clip(r.name||prompt||r.id,120),source:'aside',group:clip(group,120),
      schedule:clip(humaniseRRule(r.rrule,{tz,anchor})+(stale?' (stale)':''),200),...(z?{timezone:z}:{}),triggers:[rt.trigger],origin:'machine',
      command:clip(redact([waiting&&'Waiting for approval',model,prompt].filter(Boolean).join(' · ')),300),ai:true,enabled:r.status==='active',
      ...(lastRun?{lastRun}:{}),lastStatus,...(next&&!stale&&r.status==='active'?{nextRun:next}:{})};
  });
}

// Claude desktop scheduled tasks: scheduled-tasks.json {scheduledTasks: [{id, displayName,
// cronExpression (local time), enabled, lastRunAt, …}]}, and each task's SKILL.md for what it does.
export function claudeTasks(text){
  let d;try{d=typeof text==='string'?JSON.parse(text):text}catch{return []}
  return (Array.isArray(d?.scheduledTasks)?d.scheduledTasks:[]).filter(t=>t&&typeof t.id==='string'&&t.id);
}
// What a SKILL.md says it does: the front matter's description, else the first heading or line.
export function skillSummary(md){
  const text=String(md??'').replace(/^\uFEFF/,''),fm=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const desc=fm&&/^description:\s*(.+)$/m.exec(fm[1])?.[1].trim().replace(/^(["'])(.*)\1$/,'$2');
  if(desc)return clip(desc,300);
  const line=(fm?text.slice(fm[0].length):text).split('\n').map(l=>l.trim()).find(Boolean)||'';
  return clip(line.replace(/^#+\s*/,''),300);
}
export function claudeJobs(tasks,{group='',tz='',zone=tz,skills={},now=new Date()}={}){
  return (Array.isArray(tasks)?tasks:[]).filter(t=>t?.id).map(t=>{
    const expr=clip(t.cronExpression,120),enabled=t.enabled!==false,lastRun=anyTime(t.lastRunAt),next=enabled&&expr?nextCron(expr,now,{tz}):null;
    const what=skills[t.id]!==undefined?skillSummary(skills[t.id]):'';
    const schedule=expr?humaniseCron(expr):'On demand';
    return {id:clip(`claude:${t.id}`,200),name:clip(t.displayName||t.id,120),source:'claude',group:clip(group,120),
      schedule,...(expr?{cron:expr}:{}),...(zone?{timezone:zone}:{}),triggers:[expr?{kind:'cron',expr,text:schedule}:{kind:'manual',text:schedule}],origin:'machine',...(what?{command:clip(redact(what),300)}:{}),ai:true,enabled,
      ...(lastRun?{lastRun}:{}),lastStatus:'unknown',...(next?{nextRun:next}:{})};
  });
}

// Codex automations: automation.toml, read as simple "key = value" lines (strings, numbers,
// booleans, string arrays; inline tables are kept as text). A string cut short has no closing quote.
export function parseToml(text){
  const out={};
  for(const line of String(text??'').split('\n')){
    if(/^\s*\[/.test(line))break;
    const m=/^\s*([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(line);if(!m)continue;
    out[m[1]]=tomlValue(m[2].trim());
  }
  return out;
}
function tomlValue(v){
  if(v[0]==='"'){
    let s='',i=1;
    for(;i<v.length&&v[i]!=='"';i++){
      if(v[i]!=='\\'){s+=v[i];continue}
      const c=v[++i];
      if(c==='u'||c==='U'){const n=c==='u'?4:8;s+=String.fromCodePoint(parseInt(v.slice(i+1,i+1+n),16)||0xfffd);i+=n}
      else s+={n:'\n',t:'\t',r:'\r','"':'"','\\':'\\',b:'\b',f:'\f'}[c]??c??'';
    }
    return s;
  }
  if(v[0]==="'"){const e=v.indexOf("'",1);return e<0?v.slice(1):v.slice(1,e)}
  if(v[0]==='['&&v.endsWith(']')){const items=[...v.slice(1,-1).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(x=>x[2]??tomlValue(`"${x[1]}"`));return items}
  if(/^(true|false)$/.test(v))return v==='true';
  const c=v.replace(/\s+#.*$/,'');
  if(/^[+-]?\d[\d_]*(\.\d+)?$/.test(c))return Number(c.replace(/_/g,''));
  return c;
}
// One job per automation. kind "cron" starts a new thread each run (runs: {id: [count, newest
// created_at in unix seconds]} from Codex's state database); "heartbeat" wakes an existing thread,
// so its last run is not known. Its schedule is an RRULE (no DTSTART: it counts from when the
// automation was created), a cron line, or times. A one-shot whose runs are used up is skipped, or with keepDone
// marked "(done)".
export function codexJobs(automations,{group='',tz='',zone=tz,runs={},now=Date.now(),keepDone=false}={}){
  const out=[];
  for(const a of Array.isArray(automations)?automations:[]){
    const id=String(a?.id||'').trim();if(!id)continue;
    const anchor=+a.created_at||+a.updated_at||now,anchorMs=anchor>1e12?anchor:anchor*1000;
    let schedule='',next=null,done=false,triggers=[],z=zone;
    if(a.rrule){const x=rruleNext(a.rrule,{tz,anchor:anchorMs,now}),rt=rruleTrigger(a.rrule,{tz,anchor:anchorMs});schedule=rt.trigger.text;triggers=[rt.trigger];z=rt.zone||zone;next=x?.next||null;done=!!x?.done}
    else if(a.cron){schedule=humaniseCron(a.cron);triggers=[{kind:'cron',expr:clip(a.cron,200),text:schedule}];next=nextCron(a.cron,new Date(now),{tz})}
    else if(Array.isArray(a.times)&&a.times.length){
      const ts=a.times.map(anyTime).filter(Boolean).sort();next=ts.find(t=>Date.parse(t)>now)||null;done=!next;
      schedule=ts.length===1?`Once ${dateIn(Date.parse(ts[0]),tz)}`:`${ts.length} set times`;
      triggers=ts.slice(0,10).map(t=>({kind:'once',expr:t,text:`Once ${dateIn(Date.parse(t),tz)}`}));
    }else{schedule=a.kind==='heartbeat'?'Heartbeat':'Unknown';triggers=[{kind:'other',...(a.kind?{expr:clip(`kind = ${a.kind}`,200)}:{}),text:schedule}]}
    if(done&&!keepDone)continue;
    const enabled=String(a.status||'ACTIVE').toUpperCase()==='ACTIVE',r=runs[id],lastRun=Array.isArray(r)&&r[1]?unix(r[1]):undefined;
    const model=a.model?`codex:${a.model}${a.reasoning_effort?` (${a.reasoning_effort})`:''}`:'';
    const prompt=clip(String(a.prompt||'').split('\n').find(x=>x.trim())||'',200);
    out.push({id:clip(`codex:${id}`,200),name:clip(a.name||a.title||id,120),source:'codex',group:clip(group,120),schedule:clip(schedule+(done?' (done)':''),200),
      ...(a.cron?{cron:clip(a.cron,120)}:{}),...(z?{timezone:z}:{}),triggers,origin:'machine',command:clip(redact([model,prompt].filter(Boolean).join(' · ')),300),ai:true,enabled,
      ...(lastRun?{lastRun}:{}),lastStatus:'unknown',...(next&&enabled?{nextRun:next}:{})});
  }
  return out;
}

// The scripts. PowerShell (always there on Windows) reads Task Scheduler and files; Python, when
// "python" is set, reads the SQLite databases (Aside, Codex), and then also the Claude and Codex
// files. Both only read; Aside's database is copied (with its WAL) to a temp folder that is removed
// after. Each prints one JSON object, ASCII only. CFG is prepended: {sources, repos, asideStatuses}.
// The PowerShell one uses the Task Scheduler COM API and writes its JSON itself: the ScheduledTasks
// and JSON cmdlets of Windows PowerShell 5.1 made a run take 5 to over 60 seconds.
const PS_SCRIPT=String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$want=@($CFG.sources)
$out=@{home=$env:USERPROFILE;errors=@()}
function Iso($d){ if($d -and $d.Year -gt 2000){ $d.ToUniversalTime().ToString('o') } else { $null } }
function Head($p,$n){ $t=[IO.File]::ReadAllText($p); if($t.Length -gt $n){ $t.Substring(0,$n) } else { $t } }
if($want -contains 'windows'){ try {
  # The Task Scheduler COM API: much faster than the ScheduledTasks cmdlets (CIM), and it knows
  # monthly triggers. Folders are walked with a queue, \Microsoft left out.
  $TT=@{0='Event';1='Time';2='Daily';3='Weekly';4='Monthly';5='MonthlyDOW';6='Idle';7='Registration';8='Boot';9='Logon';11='SessionStateChange'}
  $ST=@{0='Unknown';1='Disabled';2='Queued';3='Ready';4='Running'}
  $svc=New-Object -ComObject Schedule.Service; $svc.Connect()
  $q=New-Object System.Collections.Queue; $q.Enqueue($svc.GetFolder('\'))
  $list=New-Object System.Collections.ArrayList
  while($q.Count -gt 0){ $f=$q.Dequeue()
    if($f.Path -eq '\Microsoft'){ continue }
    try { foreach($s in @($f.GetFolders(0))){ [void]$q.Enqueue($s) } } catch { $out.errors+=('windows '+$f.Path+': '+$_.Exception.Message) }
    $tasks=@(); try { $tasks=@($f.GetTasks(1)) } catch { $out.errors+=('windows '+$f.Path+': '+$_.Exception.Message) }
    foreach($t in $tasks){ try { $d=$t.Definition
      [void]$list.Add([ordered]@{ path=($f.Path.TrimEnd('\')+'\'); name=$t.Name; state=$ST[[int]$t.State]
        triggers=@(foreach($g in @($d.Triggers)){ [ordered]@{ type=('MSFT_Task'+$TT[[int]$g.Type]+'Trigger'); start=$g.StartBoundary; enabled=$g.Enabled
          days=$g.DaysInterval; weeks=$g.WeeksInterval; dow=$g.DaysOfWeek; dom=$g.DaysOfMonth; wom=$g.WeeksOfMonth; interval=$g.Repetition.Interval; duration=$g.Repetition.Duration } })
        actions=@(foreach($a in @($d.Actions)){ [ordered]@{ type=$(if($a.Type -eq 5){'MSFT_TaskComHandlerAction'}elseif($a.Type -eq 0){'MSFT_TaskExecAction'}else{'other'}); exe=$a.Path; args=$a.Arguments } })
        last=(Iso $t.LastRunTime); next=(Iso $t.NextRunTime); result=$t.LastTaskResult })
    } catch { $out.errors+=('windows '+$t.Name+': '+$_.Exception.Message) } }
  }
  $out.windows=@($list)
} catch { $out.errors+=('windows: '+$_.Exception.Message) } }
if($CFG.repos){ $out.repos=@(foreach($r in @($CFG.repos)){ try {
  $root=(Resolve-Path -LiteralPath ([Environment]::ExpandEnvironmentVariables($r))).ProviderPath
  $dirs=@($root)+@(foreach($s in 'services','apps'){ $p=Join-Path $root $s; if(Test-Path -LiteralPath $p -PathType Container){ Get-ChildItem -LiteralPath $p -Directory | ForEach-Object { $_.FullName } } })
  $files=@()
  foreach($d in $dirs){ $rel=$d.Substring($root.Length).TrimStart('\').Replace('\','/')
    foreach($f in @(Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(vercel\.json|railway(\.[\w.-]+)?\.(json|toml))$' })){ $files+=[ordered]@{ dir=$rel; name=$f.Name; text=(Head $f.FullName 200000) } }
    $rm=Join-Path $d 'README.md'; if(($files | Where-Object { $_.dir -eq $rel }) -and (Test-Path -LiteralPath $rm -PathType Leaf)){ $files+=[ordered]@{ dir=$rel; name='README.md'; text=(Head $rm 20000) } } }
  $wf=Join-Path $root '.github\workflows'
  if(Test-Path -LiteralPath $wf){ foreach($f in @(Get-ChildItem -LiteralPath $wf -File | Where-Object { $_.Name -match '\.ya?ml$' })){ $files+=[ordered]@{ dir='.github/workflows'; name=$f.Name; text=(Head $f.FullName 200000) } } }
  [ordered]@{ repo=(Split-Path $root -Leaf); files=$files }
} catch { $out.errors+=('repo '+$r+': '+$_.Exception.Message) } }) }
if($want -contains 'claude-desktop'){ try {
  $tasks=@{}
  $base=Join-Path $env:LOCALAPPDATA 'Claude-Data'
  foreach($f in @(Get-ChildItem -Path (Join-Path $base 'claude_*\claude-code-sessions') -Recurse -Filter 'scheduled-tasks.json' -File -ErrorAction SilentlyContinue)){
    try { $d=[IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json
      foreach($t in @($d.scheduledTasks)){ if($t.id){ $o=$tasks[$t.id]; if(-not $o -or [string]$t.lastRunAt -gt [string]$o.lastRunAt){
        $tasks[$t.id]=[ordered]@{ id=$t.id; displayName=$t.displayName; cronExpression=$t.cronExpression; enabled=$t.enabled; lastRunAt=[string]$t.lastRunAt } } } }
    } catch { $out.errors+=('claude: '+$_.Exception.Message) } }
  $skills=@{}
  foreach($f in @(Get-ChildItem -Path (Join-Path $env:USERPROFILE '.claude\scheduled-tasks\*\SKILL.md') -File -ErrorAction SilentlyContinue)){ $skills[$f.Directory.Name]=(Head $f.FullName 2000) }
  $out.claude=@{ tasks=@($tasks.Values); skills=$skills }
} catch { $out.errors+=('claude: '+$_.Exception.Message) } }
if($want -contains 'codex'){ try {
  $out.codex=@{ automations=@(foreach($f in @(Get-ChildItem -Path (Join-Path $env:USERPROFILE '.codex\automations\*\automation.toml') -File -ErrorAction SilentlyContinue)){
    [ordered]@{ dir=$f.Directory.Name; text=((Get-Content -LiteralPath $f.FullName -Encoding UTF8 | ForEach-Object { if($_.Length -gt 800){ $_.Substring(0,800) } else { $_ } }) -join [char]10) } }); runs=@{} }
} catch { $out.errors+=('codex: '+$_.Exception.Message) } }
# JSON by hand: the JSON cmdlet is slow on Windows PowerShell 5.1, and this keeps the output ASCII.
function E($s){ [regex]::Replace($s,'[\\"\x00-\x1f\x7f-\uffff]',{ param($m) $c=[int][char]$m.Value; if($c -eq 92){ '\\' } elseif($c -eq 34){ '\"' } else { '\u{0:x4}' -f $c } }) }
function J($v){
  if($null -eq $v){ return 'null' }
  if($v -is [string] -or $v -is [char]){ return '"'+(E ([string]$v))+'"' }
  if($v -is [bool]){ if($v){ return 'true' } else { return 'false' } }
  if($v -is [datetime]){ return '"'+(Iso $v)+'"' }
  if($v -is [ValueType]){ return [Convert]::ToString($v,[Globalization.CultureInfo]::InvariantCulture) }
  if($v -is [Collections.IDictionary]){ $p=foreach($k in @($v.Keys)){ '"'+(E ([string]$k))+'":'+(J $v[$k]) }; return '{'+(@($p) -join ',')+'}' }
  if($v -is [Collections.IEnumerable]){ $p=foreach($x in $v){ J $x }; return '['+(@($p) -join ',')+']' }
  return '"'+(E ([string]$v))+'"'
}
[Console]::Out.Write((J $out))
`;
const PY_SCRIPT=String.raw`
import os,sys,json,glob,re,sqlite3,shutil,tempfile
H=os.environ.get('USERPROFILE') or os.path.expanduser('~')
L=os.environ.get('LOCALAPPDATA') or os.path.join(H,'AppData','Local')
want=set(CFG.get('sources') or [])
out={'home':H,'errors':[]}
def err(s,e): out['errors'].append('%s: %s'%(s,str(e)[:200]))
def snapshot(p):
  d=tempfile.mkdtemp(prefix='flow-jobs-')
  for s in ('','-wal'):
    if os.path.exists(p+s): shutil.copyfile(p+s,os.path.join(d,'db'+s))
  return d,sqlite3.connect(os.path.join(d,'db'))
def head(p,n):
  with open(p,encoding='utf-8',errors='replace') as f: return f.read(n)
if 'aside' in want:
  out['aside']=[]
  keep=set(CFG.get('asideStatuses') or ['active','paused'])
  for u in sorted(glob.glob(os.path.join(H,'.aside','u','*'))):
    n=os.path.basename(u); p=os.path.join(u,'state.db')
    if not n.isdigit() or not os.path.isfile(p): continue
    d=None; c=None
    try:
      d,c=snapshot(p); c.row_factory=sqlite3.Row
      for r in c.execute('SELECT id,name,prompt,rrule,status,next_run_at,paused_at,created_at,session_config FROM routines'):
        if r['status'] not in keep: continue
        x={k:r[k] for k in ('id','name','rrule','status','next_run_at','paused_at','created_at')}
        x['prompt']=(r['prompt'] or '')[:600]
        try:
          m=(json.loads(r['session_config'] or '{}').get('model') or {}); x['model']={'provider':m.get('provider'),'modelId':m.get('modelId')}
        except Exception: x['model']={}
        s=c.execute('SELECT id,status FROM sessions WHERE routine_id=? ORDER BY created_at DESC LIMIT 1',(r['id'],)).fetchone()
        if s:
          t=c.execute('SELECT started_at,finished_at,aborted_at FROM session_turns WHERE session_id=? ORDER BY started_at DESC LIMIT 1',(s['id'],)).fetchone()
          x['last']={'status':s['status'],'started':t['started_at'] if t else None,'finished':t['finished_at'] if t else None,'aborted':t['aborted_at'] if t else None}
        out['aside'].append(x)
    except Exception as e: err('aside '+n,e)
    finally:
      if c: c.close()
      if d: shutil.rmtree(d,ignore_errors=True)
if 'claude-desktop' in want:
  tasks={}; skills={}
  for f in glob.glob(os.path.join(L,'Claude-Data','claude_*','claude-code-sessions','**','scheduled-tasks.json'),recursive=True):
    try:
      with open(f,encoding='utf-8') as fh: data=json.load(fh)
      for t in data.get('scheduledTasks') or []:
        if not isinstance(t,dict) or not t.get('id'): continue
        t={k:t.get(k) for k in ('id','displayName','cronExpression','enabled','lastRunAt')}
        o=tasks.get(t['id'])
        if not o or str(t.get('lastRunAt') or '')>str(o.get('lastRunAt') or ''): tasks[t['id']]=t
    except Exception as e: err('claude',e)
  for f in glob.glob(os.path.join(H,'.claude','scheduled-tasks','*','SKILL.md')):
    try: skills[os.path.basename(os.path.dirname(f))]=head(f,2000)
    except Exception as e: err('claude skill',e)
  out['claude']={'tasks':list(tasks.values()),'skills':skills}
if 'codex' in want:
  autos=[]; runs={}
  for f in glob.glob(os.path.join(H,'.codex','automations','*','automation.toml')):
    try: autos.append({'dir':os.path.basename(os.path.dirname(f)),'text':'\n'.join(l[:800] for l in head(f,400000).split('\n'))})
    except Exception as e: err('codex',e)
  dbs=sorted(glob.glob(os.path.join(H,'.codex','state_*.sqlite')),key=lambda p:int(re.sub(r'\D','',os.path.basename(p)) or 0))
  if dbs:
    d=None; c=None
    try:
      d,c=snapshot(dbs[-1])
      for t,f,at in c.execute("SELECT substr(title,1,400),substr(first_user_message,1,400),created_at FROM threads WHERE thread_source='automation'"):
        m=re.search(r'Automation ID: (\S+)',(t or '')+'\n'+(f or ''))
        if m:
          k=m.group(1); n,last=runs.get(k,[0,0]); runs[k]=[n+1,max(last,at or 0)]
    except Exception as e: err('codex runs',e)
    finally:
      if c: c.close()
      if d: shutil.rmtree(d,ignore_errors=True)
  out['codex']={'automations':autos,'runs':runs}
sys.stdout.write(json.dumps(out))
`;
export const REMOTE_SOURCES=['windows','aside','claude-desktop','codex','vercel','railway','github'];
const PS_BOOT=Buffer.from('$s=[Console]::In.ReadToEnd();iex $s','utf16le').toString('base64');
const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64');
// The settings as PowerShell literals (strings in base64, so the script stays ASCII).
const psLit=v=>Array.isArray(v)?`@(${v.map(psLit).join(',')})`:v&&typeof v==='object'?`@{${Object.entries(v).map(([k,x])=>`${k}=${psLit(x)}`).join(';')}}`
  :typeof v==='boolean'?(v?'$true':'$false'):typeof v==='number'?String(v):`([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(String(v??'')).toString('base64')}')))`;
export const psScript=c=>`$CFG=${psLit(c)}\n${PS_SCRIPT}`;
export const pyScript=c=>`import json,base64\nCFG=json.loads(base64.b64decode('${b64(c)}').decode('utf-8'))\n${PY_SCRIPT}`;
// What each script does for a remote: Python takes Aside, Claude and Codex when it is there.
export function remotePlan(remote={}){
  const sources=new Set(Array.isArray(remote.sources)?remote.sources:REMOTE_SOURCES),py=!!remote.python;
  const repos=['vercel','railway','github'].some(s=>sources.has(s))&&Array.isArray(remote.repos)?remote.repos:[];
  const pySources=py?['aside','claude-desktop','codex'].filter(s=>sources.has(s)):[];
  const psSources=['windows',...(py?[]:['claude-desktop','codex'])].filter(s=>sources.has(s));
  return {sources,repos,pySources,psSources,needsPython:!py&&sources.has('aside')};
}
// Raw script output to jobs, filtered ("include", "exclude", "skipVendor") and capped like local ones.
// zone: the remote's time zone for the jobs' timezone (its "timezone", else this machine's).
export function remoteJobs(remote,raw,{now=Date.now(),note=()=>{},zone=remote.timezone||'',notes={}}={}){
  const name=clip(remote.name,100),tz=remote.timezone||'',plan=remotePlan(remote),jobs=[];
  const ps=raw.ps||{},py=raw.py||{},profile=ps.home||py.home||'';
  for(const e of [...(ps.errors||[]),...(py.errors||[])])note(`${name}: ${e}`);
  const step=(label,fn)=>{try{jobs.push(...fn())}catch(e){note(`${name} ${label}: ${e.message}`)}};
  const o={include:remote.include||[],exclude:remote.exclude||[]};
  if(plan.sources.has('windows')&&ps.windows)step('windows',()=>windowsJobs(ps.windows,{group:name,profile,skipVendor:remote.skipVendor!==false,tz:zone,...o}));
  if(plan.sources.has('aside')&&py.aside)step('aside',()=>asideJobs(py.aside,{group:`${name} · Aside`,tz,zone,now}));
  const claude=py.claude||ps.claude,codex=py.codex||ps.codex;
  if(plan.sources.has('claude-desktop')&&claude)step('claude',()=>claudeJobs(claudeTasks({scheduledTasks:claude.tasks}),{group:`${name} · Claude`,tz,zone,skills:claude.skills||{},now:new Date(now)}));
  if(plan.sources.has('codex')&&codex)step('codex',()=>codexJobs((codex.automations||[]).map(a=>({id:a.dir,...parseToml(a.text)})),
    {group:`${name} · Codex`,tz,zone,runs:codex.runs||{},now,keepDone:!!remote.keepDone}));
  for(const r of Array.isArray(ps.repos)?ps.repos:[])step(`repo ${r.repo}`,()=>repoFileJobs(r.repo,r.files||[],{sources:plan.sources,now:new Date(now)}));
  const seen=new Set();
  return applyNotes(filterJobs(jobs,{...o,skipDistro:false}).filter(j=>!seen.has(j.id)&&seen.add(j.id)).slice(0,500).map(bare),{...notes,...remote.notes});
}
// spawn with a time limit (spawnSync would hold up the pass); {status, stdout, stderr, timedOut}.
function runAsync(bin,argv,{input='',timeout=40000}={}){
  return new Promise(res=>{
    let p;try{p=spawn(bin,argv,{stdio:['pipe','pipe','pipe']})}catch(error){res({status:null,error,stdout:'',stderr:''});return}
    let stdout='',stderr='',timedOut=false;
    const t=setTimeout(()=>{timedOut=true;p.kill('SIGKILL')},timeout);
    p.stdout.setEncoding('utf8').on('data',d=>{stdout+=d});p.stderr.setEncoding('utf8').on('data',d=>{stderr+=d});
    p.on('error',error=>{clearTimeout(t);res({status:null,error,stdout,stderr,timedOut})});
    p.on('close',status=>{clearTimeout(t);res({status,stdout,stderr,timedOut})});
    p.stdin.on('error',()=>{});p.stdin.end(input);
  });
}
const jsonOut=s=>{const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a<0||b<a)throw new Error('no JSON in the output');return JSON.parse(s.slice(a,b+1))};
const sshErr=r=>clip(String(r.stderr||r.error?.message||'').split('\n').filter(l=>l.trim()&&!/^\*\*|post-quantum|store now|upgraded/i.test(l)).join(' ')||`exit ${r.status}`,200);
// One script over SSH; a connection failure (ssh exits 255) is tried once more while time is left.
async function overSsh(remote,command,script,deadline){
  const argv=remote.ssh.map(a=>tilde(String(a)));
  for(let attempt=1;;attempt++){
    const left=deadline-Date.now();if(left<2000)throw new Error('out of time');
    const r=await runAsync(argv[0],[...argv.slice(1),command],{input:script,timeout:left});
    if(r.timedOut)throw new Error(`timed out after ${Math.round((remote.timeout||40))} s`);
    if(r.status===0)return jsonOut(r.stdout);
    if(r.status===255&&attempt<2&&deadline-Date.now()>10000)continue;
    throw new Error(`ssh exit ${r.status}: ${sshErr(r)}`);
  }
}
// Every job a remote machine has, or throws (nothing reachable). Parts that fail are noted.
const notesOf=c=>c?.jobs&&typeof c.jobs==='object'&&c.jobs.notes||{};
export async function discoverRemote(remote,{note=()=>{},now=Date.now()}={}){
  if(!remote?.name||!Array.isArray(remote.ssh)||!remote.ssh.length)throw new Error('a remote needs "name" and "ssh" (the ssh command as a list)');
  if(remote.timezone&&!validTz(remote.timezone))note(`${remote.name}: unknown timezone "${remote.timezone}"; using this machine's`);
  const r={...remote,timezone:validTz(remote.timezone)?remote.timezone:''},plan=remotePlan(r),deadline=Date.now()+(+r.timeout||40)*1000;
  if(plan.needsPython)note(`${r.name}: set "python" (python.exe on it) to read Aside routines and Codex runs`);
  const cfgFor=sources=>({sources,repos:plan.repos,asideStatuses:r.keepDone?['active','paused','completed']:['active','paused']});
  const quote=s=>/[\s"]/.test(s)?`"${s.replace(/"/g,'')}"`:s;
  const [ps,py]=await Promise.allSettled([
    plan.psSources.length||plan.repos.length?overSsh(r,`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${PS_BOOT}`,psScript(cfgFor(plan.psSources)),deadline):null,
    plan.pySources.length?overSsh(r,`${quote(r.python)} -`,pyScript(cfgFor(plan.pySources)),deadline):null]);
  if(ps.status==='rejected')note(`${r.name} PowerShell: ${ps.reason.message}`);
  if(py.status==='rejected')note(`${r.name} Python: ${py.reason.message}`);
  if(ps.status==='rejected'&&(py.status==='rejected'||!plan.pySources.length))throw new Error(ps.reason.message);
  if(py.status==='rejected'&&!plan.psSources.length&&!plan.repos.length)throw new Error(py.reason.message);
  return remoteJobs(r,{ps:ps.value||{},py:py.value||{}},{now,note,zone:r.timezone||localZone(),notes:notesOf(cfg)});
}
const REMOTE_EVERY=15*60e3;
const remotesOf=c=>(Array.isArray(c?.remotes)?c.remotes:[]).filter(x=>x&&x.enabled!==false);
// Report each remote as its own runner (jobs only), at most every 15 minutes unless forced. A
// remote that cannot be reached is logged and tried again next time; the local pass never waits on it.
async function reportRemotes({force=false}={}){
  if(!jobsOn(cfg))return;
  for(const rm of remotesOf(cfg)){
    const name=String(rm.name||'').trim();
    if(!name){log('remote without a name; skipped');continue}
    if(same(name,cfg.name)){log(`remote "${name}" has this runner's name; skipped (it would replace this machine's jobs)`);continue}
    const st=readJson(stateFile)||{runs:{}},last=Date.parse(st.remotes?.[name]?.at||'');
    if(!force&&Date.now()-last<REMOTE_EVERY)continue;
    const mark=(o)=>{const s=readJson(stateFile)||{runs:{}};(s.remotes||={})[name]={at:new Date().toISOString(),...o};writeJson(stateFile,s)};
    let jobs;
    try{jobs=await discoverRemote(rm,{note:m=>log('jobs:',m)})}
    catch(e){log(`remote "${name}": ${e.message}`);mark({error:clip(e.message,200)});continue}
    try{
      const {r}=await postReport(`/runners/${encodeURIComponent(name)}`,{jobs,timezone:validTz(rm.timezone)&&rm.timezone?rm.timezone:localZone()});
      log(`reported ${jobs.length} jobs as "${name}"${r.changed?'':' (unchanged)'}`);mark({jobs:jobs.length});
    }catch(e){
      log(e.status===400&&/models/i.test(e.message)?`remote "${name}": this Flow server needs models in runners.report; update Flow to report remotes (${clip(e.message,120)})`:`remote "${name}": ${e.message}`);
      mark({error:clip(e.message,200)});
    }
  }
}

// ---------- T3 ----------
const t3=(argv,input)=>{const r=run(T3,[...argv,'--json'],{input,timeout:120000});if(r.status!==0)throw new Error(`t3 ${argv[0]} ${argv[1]}: ${(r.error?.message||r.stderr||r.stdout||`exit ${r.status}`).trim().slice(0,400)}`);return JSON.parse(r.stdout)};
function projectFor(card,projects){
  const map=cfg.projects||{},p=projects.find(x=>x.id===card.project);
  const hit=Object.entries(map).find(([k])=>k===card.project||(p&&same(k,p.name)));
  return tilde(hit?.[1]||cfg.project||'');
}
// ---------- choosing models ----------
// An agent's models in order (older Flow servers only send model).
const modelsOf=a=>Array.isArray(a.models)&&a.models.length?a.models:a.model?[a.model]:[];
const TIER={included:0,metered:2};
// The order to try a card's models in, and why. Without auto it is the agent's list as it stands.
async function plan(a,card,project,catalogue){
  const pool=modelsOf(a).filter(m=>splitModel(m)[0]);
  if(!a.auto||pool.length<2)return {order:pool,why:a.auto?'the only model in the pool':'primary, then fallbacks in order'};
  const info=new Map(catalogue.map(m=>[m.id,m])),tier=id=>info.has(id)?(TIER[info.get(id).billing]??1):3;
  const order=pool.map((id,i)=>({id,i})).sort((x,y)=>tier(x.id)-tier(y.id)||x.i-y.i).map(x=>x.id);
  const best=order.filter(id=>tier(id)===tier(order[0])),group=info.get(order[0])?.billing||(info.has(order[0])?'unknown billing':'not reported');
  let pick=order[0],why=`rules: first ${group} model in the pool`;
  if(cfg.router&&best.length>1){
    if(DRY)why+=`; a live run would ask ${cfg.router} to choose among ${best.length}`;
    else{
      const r=await route(a,card,project,best,info);
      if(r.id){pick=r.id;why=`${cfg.router} chose it from ${best.length} ${group} models${r.reason?`: ${r.reason}`:''}`}
      else why+=` (router: ${r.error})`;
    }
  }
  return {order:[pick,...order.filter(id=>id!==pick)],why};
}
// Ask the router model, once, which candidate fits the card. Returns {id, reason} or {error}.
async function route(a,card,project,ids,info){
  const [provider,model]=splitModel(cfg.router);
  if(!provider||!model)return {error:'"router" is not of the form provider:model'};
  const list=ids.map(id=>`- ${id}${info.get(id)?.label&&info.get(id).label!==id?` (${info.get(id).label})`:''}`).join('\n');
  const ask=`Pick the model best suited to this task. Do not do the task, and do not use any tools.\n\n`
    +`Agent: ${a.name}. Purpose: ${(a.purpose||'not given').slice(0,1000)}\n\nTask: #${card.number} ${card.title}\n${(card.description||'').slice(0,2000)}\n\n`
    +`Models:\n${list}\n\nReply on the first line with exactly one model id from the list, then one short line saying why.`;
  const r=run(T3,['thread','start','--provider',provider,'--model',model,'--title',`[Flow] Pick a model for #${card.number}`.slice(0,120),'--wait','--json',project,'-'],{input:ask,timeout:300000});
  let d;try{d=JSON.parse(r.stdout)}catch{return {error:(r.stderr||r.stdout||`exit ${r.status}`).trim().slice(0,200)}}
  if(d.status!=='completed'||typeof d.reply!=='string')return {error:`router thread ${d.status||'failed'}${d.error?`: ${String(d.error).slice(0,200)}`:''}`};
  const [first='',...rest]=d.reply.trim().split('\n'),clean=first.replace(/[`*"']/g,'').trim();
  const id=ids.find(x=>x===clean)||ids.filter(x=>d.reply.includes(x)).sort((x,y)=>y.length-x.length)[0];
  return id?{id,reason:rest.join(' ').trim().slice(0,200)}:{error:`answered "${first.slice(0,80)}", not one of the ids`};
}
// Did a thread that is no longer running fail? T3 run statuses: completed, interrupted, failed,
// cancelled, rolled_back (plus the active ones). A completed thread whose last reply is short and
// reads as a limit error is counted as failed too, since some providers end the turn that way.
const LIMIT=/rate.?limit|usage limit|quota|limit (reached|exceeded)|too many requests|\b429\b|overloaded|out of (credits|tokens)|insufficient (credit|balance|funds)/i;
function outcome(th,messages){
  if(['failed','rolled_back','error'].includes(th.status))return {failed:true,why:`thread ${th.status}`};
  if(['interrupted','cancelled'].includes(th.status))return {stopped:true,why:`thread ${th.status} in T3`};
  const last=[...(messages||[])].reverse().find(m=>m.role==='assistant');
  if(last&&String(last.text).length<500&&LIMIT.test(last.text))return {failed:true,why:`hit a limit: ${String(last.text).trim().slice(0,160)}`};
  if(!last&&th.status!=='completed')return {failed:true,why:`thread ended ${th.status||'without a reply'}`};
  return {};
}
// Start a thread on the first model in order that T3 accepts. Returns {thread, model, tried}.
function startOn(order,argvFor,text,label){
  const tried=[];
  for(const m of order){
    const [provider,model]=splitModel(m);
    try{const th=t3(argvFor(provider,model),text);tried.push({model:m,ok:true});return {thread:th.threadId||th.thread?.threadId||th.id,model:m,tried}}
    catch(e){tried.push({model:m,ok:false,error:e.message.slice(0,300)});log(`${label}: could not start on ${m}: ${e.message}`)}
  }
  return {thread:null,model:null,tried};
}
const attemptsOf=(tried,thread,at)=>tried.map(t=>({model:t.model,started:at,...(t.ok?{thread}:{result:'not started',why:t.error})}));
function prompt(agent,brief,card,retry){
  const checklist=(card.checklist||[]).map(x=>`- [${x.done?'x':' '}] ${x.text}`).join('\n');
  return `You are working as the AgentFlow agent "${agent.name}". Your brief follows, then the card to work on.\n\n${brief}\n\n---\n\n`
    +`# Card #${card.number}: ${card.title}\n\n${card.description||'(no description)'}\n\n${checklist?`## Checklist\n\n${checklist}\n\n`:''}${card.due?`Due: ${card.due}\n\n`:''}`
    +`Do the work for this card. When you finish, reply with a short summary of what you did, anything left undone, and links to any pull requests or commits. `
    +`The runner moves the card to UAT for a person to review when this thread finishes, so do not move it yourself.`
    +(retry?`\n\nAn earlier attempt on ${retry} did not finish. Check the project for partial work from it before you start.`:'');
}
const titleOf=(a,card)=>`[Flow] ${a.name}: #${card.number} ${card.title}`.slice(0,120);
const startArgv=(title,project)=>(provider,model)=>['thread','start','--provider',provider,'--model',model,'--title',title,...(cfg.worktree?['--worktree',cfg.worktree]:[]),project,'-'];

// ---------- one pass ----------
// The local pass, then any remotes that are due (they never hold up the local pass).
async function tick(){
  try{await tickLocal()}
  finally{await reportRemotes().catch(e=>log('remotes:',e.message))}
}
async function tickLocal(){
  const state=readJson(stateFile)||{runs:{}};const save=()=>DRY||writeJson(stateFile,state);
  const catalogue=await report().catch(e=>{log('report failed:',e.message);return catalog()});
  // Threads started earlier: done ones send their card to UAT, failed ones go on to the next model.
  for(const r of Object.values(state.runs).filter(r=>r.status==='running')){
    let shown;try{shown=t3(['thread','show',r.thread,'--messages','3'])}catch(e){log(`#${r.number}: cannot read thread ${r.thread}: ${e.message}`);continue}
    const th=shown.thread||{};
    if(th.activeRunId||['running','preparing','queued','starting'].includes(th.status)){log(`#${r.number} (${r.agent}) still running on ${r.model||'its model'}`);continue}
    if(th.pendingRequestCount>0||th.status==='waiting'){log(`#${r.number} (${r.agent}) is waiting for an answer in T3: ${th.title}`);continue}
    const end=outcome(th,shown.messages),attempts=r.attempts||(r.attempts=[]),now=new Date().toISOString();
    const cur=attempts.find(x=>x.thread===r.thread);
    if(cur){cur.result=end.failed?'failed':end.stopped?'stopped':'done';cur.why=end.why||'';cur.ended=now}
    if(end.stopped){log(`#${r.number} (${r.agent}): ${end.why}; leaving the card where it is`);r.status='stopped';r.finished=now;save();continue}
    if(end.failed){
      const order=r.order||[],rest=order.slice(order.indexOf(r.model)+1);
      log(`#${r.number} (${r.agent}) failed on ${r.model}: ${end.why}`);
      if(DRY){log(`dry run: would start #${r.number} again on ${rest[0]||'nothing (no models left)'}`);continue}
      const again=rest.length&&r.card?startOn(rest,startArgv(r.title,r.project),prompt(r.card.agent,r.card.brief,r.card,r.model),`#${r.number}`):{thread:null,tried:[]};
      attempts.push(...attemptsOf(again.tried,again.thread,now));
      if(again.thread){Object.assign(r,{thread:again.thread,model:again.model});log(`#${r.number} restarted on ${again.model}: thread ${again.thread}`)}
      else{r.status='failed';r.finished=now;log(`#${r.number} (${r.agent}): every model failed (${attempts.map(x=>x.model).join(', ')}); left where it is. Run "retry ${r.number}" to start it over.`)}
      save();continue;
    }
    log(`#${r.number} (${r.agent}) finished on ${r.model||'its model'}; moving it to UAT`);
    if(!DRY){try{await flow('POST',`/cards/${encodeURIComponent(r.number)}/move`,{column:'uat'})}catch(e){log(`#${r.number}: could not move to UAT: ${e.message}`)}}
    r.status='done';r.finished=now;save();
  }
  const running=()=>Object.values(state.runs).filter(r=>r.status==='running').length;
  const agents=(await all('/agents?live=true')).filter(a=>a.kind==='agent'&&same(a.runtime,cfg.name));
  if(!agents.length){log(`no live agents run on "${cfg.name}"`);return}
  const projects=await all('/projects').catch(()=>[]);
  for(const a of agents){
    if(running()>=(cfg.maxRunning??1)){log(`at maxRunning (${cfg.maxRunning??1}); the rest wait for the next pass`);break}
    if(Object.values(state.runs).some(r=>r.status==='running'&&r.agentId===a.id))continue;
    if(!modelsOf(a).some(m=>splitModel(m)[0])){log(`${a.name}: live but no model of the form provider:model; skipped`);continue}
    const work=await flow('GET',`/agents/${encodeURIComponent(a.id)}/work?columns=doing,requests&limit=20`);
    const card=work.items.find(c=>!state.runs[c.id]);
    if(!card){log(`${a.name}: nothing to do`);continue}
    const project=projectFor(card,projects);
    if(!project){log(`${a.name}: #${card.number} has no T3 project (set "project" or "projects"); skipped`);continue}
    const title=titleOf(a,card),{order,why}=await plan(a,card,project,catalogue);
    log(`${a.name}: #${card.number} on ${order[0]} (${why})${order.length>1?`; then ${order.slice(1).join(', ')}`:''}`);
    if(DRY){log(`dry run: would start "${title}" on ${order[0]} in ${project}`);continue}
    const st=startOn(order,startArgv(title,project),prompt(a,work.brief,card),a.name);
    if(!st.thread){log(`${a.name}: #${card.number} could not start on any model; left for the next pass`);continue}
    if(card.column==='requests'){
      try{await flow('POST',`/cards/${encodeURIComponent(card.number)}/move`,{column:'doing',...(cfg.developer?{developer:cfg.developer}:{})})}
      catch(e){log(`#${card.number}: left in Requests (${e.code||e.message})`)}
    }
    const now=new Date().toISOString();
    // The card and brief are kept so a fallback can start it again without asking Flow.
    state.runs[card.id]={agent:a.name,agentId:a.id,number:card.number,thread:st.thread,model:st.model,order,why,status:'running',started:now,title,project,
      card:{number:card.number,title:card.title,description:card.description||'',checklist:card.checklist||[],due:card.due||'',brief:work.brief,agent:{name:a.name}},
      attempts:attemptsOf(st.tried,st.thread,now)};
    save();
    log(`started ${title} on ${st.model}: thread ${st.thread}`);
  }
}
async function status(){
  const state=readJson(stateFile)||{runs:{}};
  const agents=(await all('/agents?live=true')).filter(a=>a.kind==='agent'&&same(a.runtime,cfg.name));
  console.log(`${cfg.name} · ${cfg.env} · ${DRY?'dry run':'live'} · ${agents.length} live agents`);
  for(const a of agents){const ms=modelsOf(a);console.log(`  ${a.name}: ${ms.length?`${a.auto?'auto from ':''}${ms.join(', ')}`:'(no model)'}`)}
  for(const r of Object.values(state.runs).filter(r=>r.status==='running'))console.log(`  running: #${r.number} for ${r.agent} on ${r.model||'?'}, thread ${r.thread}`);
  for(const r of Object.values(state.runs).filter(r=>r.status==='failed'))console.log(`  failed: #${r.number} for ${r.agent} on every model (${(r.attempts||[]).map(x=>x.model).join(', ')})`);
}
async function retry(){
  const n=String(args.filter(a=>!a.startsWith('-'))[1]||'').replace(/^#/,''),state=readJson(stateFile)||{runs:{}};
  const hit=Object.entries(state.runs).find(([,r])=>String(r.number)===n);
  if(!hit){console.error(`No card #${n} in ${stateFile}`);process.exit(1)}
  if(hit[1].status==='running'){console.error(`#${n} is running (thread ${hit[1].thread})`);process.exit(1)}
  delete state.runs[hit[0]];writeJson(stateFile,state);log(`#${n} forgotten; the next tick may start it again`);
}

// `jobs` prints this machine's jobs; `jobs --remote <name>` a remote's; `jobs --all` both.
async function jobsCmd(){
  const t0=Date.now(),notes=[],note=m=>notes.push(m),json=args.includes('--json');
  if(!jobsOn(cfg))notes.push('jobs are off in the runner settings ("jobs": false); this is what would be found');
  const want=args.includes('--remote')?args[args.indexOf('--remote')+1]||'':null,all=args.includes('--all'),remotes=remotesOf(cfg);
  const parts=[];
  if(want===null)parts.push({name:cfg.name||hostname(),tz:'',jobs:await discoverJobs(cfg,{note})});
  const pick=want!==null?remotes.filter(r=>same(r.name,want)):all?remotes:[];
  if(want!==null&&!pick.length){console.error(`No remote "${want}" in "remotes" (${remotes.map(r=>r.name).join(', ')||'none set'})`);process.exit(1)}
  for(const r of pick){
    try{parts.push({name:r.name,tz:validTz(r.timezone)?r.timezone||'':'',jobs:await discoverRemote(r,{note})})}
    catch(e){notes.push(`${r.name}: ${e.message}`);parts.push({name:r.name,tz:'',jobs:[],failed:true})}
  }
  for(const n of notes)console.error('note: '+n);
  if(json)console.log(JSON.stringify(parts.length===1?parts[0].jobs:Object.fromEntries(parts.map(p=>[p.name,p.jobs])),null,2));
  else console.log(parts.map(p=>(parts.length>1?`== ${p.name}${p.tz?` (${p.tz})`:''}\n`:'')+(p.failed?'Not reachable.':jobsTable(p.jobs,{tz:p.tz}))).join('\n\n'));
  console.error(`${parts.reduce((n,p)=>n+p.jobs.length,0)} jobs in ${Date.now()-t0} ms`);
  if(parts.some(p=>p.failed)&&parts.length===1)process.exitCode=1;
}
async function reportCmd(){await report();await reportRemotes({force:true})}

async function main(argv){
  args=argv;cmd=args.find(a=>!a.startsWith('-'))||'tick';
  cfgPath=args.includes('--config')?args[args.indexOf('--config')+1]:join(cfgDir,'runner.json');
  cfg=readJson(cfgPath)||{};
  const cmds={report:reportCmd,tick,status,retry,jobs:jobsCmd};
  if(!cmds[cmd]){console.error('Use: report | tick | status | retry <card number> | jobs [--json] [--remote <name> | --all]');process.exit(2)}
  // `jobs` only looks at this machine, so it needs no Flow server (and no settings file).
  if(cmd!=='jobs'){
    if(!cfg?.name||!cfg?.env){console.error(`Set "name" and "env" in ${cfgPath} (see the top of this file).`);process.exit(1)}
    const login=readJson(join(cfgDir,'config.json'))||{};
    FLOW={url:(process.env.FLOW_URL||cfg.url||login.url||'').replace(/\/+$/,''),key:process.env.FLOW_API_KEY||cfg.key||login.key||''};
    if(!FLOW.url||!FLOW.key){console.error('No Flow server or key: set url and key in the runner settings, FLOW_URL and FLOW_API_KEY, or run flow login.');process.exit(1)}
  }
  DRY=cfg.dryRun!==false||args.includes('--dry-run');T3=tilde(cfg.t3||'t3');T3HOME=tilde(cfg.t3Home||'~/.t3');
  await cmds[cmd]();
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1]))
  main(process.argv.slice(2)).catch(e=>{console.error(e.message||e);process.exit(1)});
