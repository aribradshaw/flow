#!/usr/bin/env node
// A reference AgentFlow runner for T3 Code (docs/concepts/09-agentflow.md, "Runners").
//
//   node tools/agent-runner.mjs report   tell Flow which models this machine can run (runners.report)
//   node tools/agent-runner.mjs tick     report, check running threads, start work for live agents
//   node tools/agent-runner.mjs status   print the live agents for this runner and what it is running
//   node tools/agent-runner.mjs retry 12 forget card #12, so the next tick starts it again
//   node tools/agent-runner.mjs jobs     print the scheduled jobs this machine would report (--json for
//                                        JSON); contacts no Flow server and needs no settings
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
//              "skipDistro": true}               skip stock distribution timers (apt-daily, fstrim, …)
//                                                "jobs": false reports no jobs (stored ones stay as they are)
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
// Repo configs carry no last run; their next run is worked out from the cron expression. A job is
// marked ai when it is a T3 task or its command runs an AI CLI (claude, codex, opencode, grok,
// cursor-agent, agy, t3 thread, this runner). Commands are one line, with ~ for home and anything
// that looks like a key, token or password replaced by ***. A server from before jobs answers 400:
// the runner then reports the models alone and logs "server does not accept jobs yet".
// State (threads it started): $XDG_STATE_HOME/flygon-flow/runner-state.json.
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,readdirSync,statSync,realpathSync} from 'node:fs';
import {join,dirname,basename,relative} from 'node:path';
import {homedir,hostname} from 'node:os';
import {spawnSync} from 'node:child_process';
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
  if(!r.ok)throw Object.assign(new Error(`${method} ${path}: ${r.status} ${d?.error?.code||''} ${d?.error?.message||''}`.trim()),{code:d?.error?.code,status:r.status});
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
  return models.filter(m=>!seen.has(m.id)&&seen.add(m.id)).slice(0,500).map(m=>{
    const p=byId.get(splitModel(m.id)[0]),provider=m.provider||p?.label||'',billing=billingOf(m.id,p?.driver||splitModel(m.id)[0],m.billing);
    return {id:m.id,label:m.label||m.id,...(provider?{provider:String(provider).slice(0,80)}:{}),...(billing==='included'||billing==='metered'?{billing}:{})};
  });
}
// Billing for a model id on an instance with this driver: the longest matching "billing" key, else
// what an extra model in "models" says, else the driver's default.
const INCLUDED=new Set(['claudeAgent','codex','cursor','grok','antigravity']);
function billingOf(id,driver,given){
  const over=Object.entries(cfg.billing||{}).filter(([k])=>id===k||id.startsWith(k.includes(':')?k:k+':')).sort((a,b)=>b[0].length-a[0].length)[0];
  if(over)return over[1];
  if(given)return given;
  if(INCLUDED.has(driver))return 'included';
  if(driver==='opencode')return splitModel(id)[1].startsWith('opencode/')?'included':'metered';
  return '';
}
async function report(){
  const models=catalog(),path=`/runners/${encodeURIComponent(cfg.name)}`;
  let jobs;
  if(jobsOn(cfg)){try{jobs=await discoverJobs(cfg,{note:m=>log('jobs:',m)})}catch(e){log('job discovery failed:',e.message)}}
  let r;
  try{r=await flow('POST',path,{models,...(jobs?{jobs}:{})})}
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
export function nextCron(expr,from=new Date(),{utc=false}={}){
  const p=parseCron(expr);if(!p)return null;
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
// Does a command start an AI CLI? A simple heuristic: one of the CLIs as a program name.
const AI_CLI=/(?:^|[\s/;&|'"(])(?:claude|codex|opencode|grok|cursor-agent|agy|gemini|aider)(?=$|[\s;&|'")])|(?:^|[\s/])t3\s+thread\b|agent-runner\.mjs/i;
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
// One job per timer from the show blocks of the timer and its service.
export function systemdJob({unit,service,next,last},timer={},svc={},{scope='user',group=''}={}){
  const cal=[].concat(timer.TimersCalendar??[]).map(v=>/OnCalendar=(.*?)\s*;/.exec(v)?.[1]).filter(Boolean);
  const mono=[].concat(timer.TimersMonotonic??[]).map(v=>/(On\w+)=(.*?)\s*;/.exec(v)).filter(Boolean).map(m=>[m[1],m[2]]);
  const command=tidy(execOf(svc.ExecStart)),lastRun=last||showTime(timer.LastTriggerUSec),nextRun=next||showTime(timer.NextElapseUSecRealtime);
  const running=/^(active|activating|reloading|deactivating)$/.test(svc.ActiveState||'');
  const lastStatus=running?'running':!lastRun||!svc.Result?'unknown':svc.Result==='success'?'ok':'failed';
  return {id:`systemd:${scope}:${unit}`,name:clip(svc.Description||timer.Description||unit.replace(/\.timer$/,''),120),source:'systemd',group,
    schedule:clip(cal.length?cal.map(humaniseOnCalendar).join('; '):humaniseMonotonic(mono)||'Unknown',200),
    ...(command?{command}:{}),ai:aiCommand(command),
    enabled:timer.ActiveState?timer.ActiveState==='active':!/^(disabled|masked)/.test(timer.UnitFileState||''),
    ...(lastRun?{lastRun}:{}),lastStatus,...(nextRun?{nextRun}:{}),...(isDistroTimer(unit)?{distro:true}:{})};
}
// Crontab text to jobs (one a line; comments and VAR=value lines skipped). Times are local.
export function crontabJobs(text,{group='',now=new Date()}={}){
  const out=[];
  for(const raw of String(text).split('\n')){
    const line=raw.trim();
    if(!line||line.startsWith('#')||/^[A-Za-z_]\w*\s*=/.test(line))continue;
    const w=line.split(/\s+/),n=w[0].startsWith('@')?1:5;
    if(w.length<=n)continue;
    const expr=w.slice(0,n).join(' '),command=w.slice(n).join(' ');
    if(n===5&&!parseCron(expr))continue;
    const next=nextCron(expr,now);
    out.push({id:`cron:user:${createHash('sha1').update(line).digest('hex').slice(0,12)}`,name:commandName(shortHome(command)),source:'cron',group,
      schedule:humaniseCron(expr),cron:clip(expr,120),command:tidy(command),ai:aiCommand(command),enabled:true,lastStatus:'unknown',...(next?{nextRun:next}:{})});
  }
  return out;
}
// Repo cron configs. Vercel, Railway and GitHub run crons in UTC.
const repoCron=(expr,now)=>{const next=nextCron(expr,now,{utc:true});return {schedule:humaniseCron(expr,{utc:true}),cron:clip(expr,120),ai:false,enabled:true,lastStatus:'unknown',...(next?{nextRun:next}:{})}};
export function vercelJobs(text,{repo,now=new Date()}){
  let d;try{d=JSON.parse(text)}catch{return []}
  return (Array.isArray(d?.crons)?d.crons:[]).filter(c=>c?.path&&c?.schedule).map(c=>({id:clip(`vercel:${repo}:${c.path}`,200),name:clip(c.path,120),source:'vercel',
    group:clip(`Vercel · ${repo}`,120),command:clip(`GET ${c.path}`,300),...repoCron(c.schedule,now)}));
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
export function railwayJobs(text,{repo,service,file,toml=false,now=new Date()}){
  const c=railwayConfig(text,toml);if(!c.cronSchedule)return [];
  return [{id:clip(`railway:${repo}:${file}`,200),name:clip(service,120),source:'railway',group:clip(`Railway · ${service}`,120),
    ...(c.startCommand?{command:tidy(c.startCommand)}:{}),...repoCron(c.cronSchedule,now)}];
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
  const {name,crons}=workflowCrons(text);
  return crons.map((c,i)=>({id:clip(`github:${repo}:${file}${crons.length>1?`#${i+1}`:''}`,200),name:clip(`${name||file}${crons.length>1?` (${i+1})`:''}`,120),
    source:'github',group:clip(`GitHub · ${repo}`,120),command:clip(`.github/workflows/${file}`,300),...repoCron(c,now)}));
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
function t3Jobs(db,note){
  const cols=columns(db,'scheduled_tasks');
  if(!cols.has('task_id')){note('T3 has no scheduled_tasks table');return []}
  // Only these columns: the table also holds webhook tokens and secrets.
  const want=['task_id','title','prompt','enabled','schedule_json','project_id','model_selection_json','next_run_at','last_run_at','last_run_status'].filter(c=>cols.has(c));
  const titles=new Map(columns(db,'projection_projects').has('title')?db.prepare('SELECT project_id,title FROM projection_projects').all().map(r=>[r.project_id,r.title]):[]);
  const json=s=>{try{return JSON.parse(s)}catch{return null}};
  return db.prepare(`SELECT ${want.join(',')} FROM scheduled_tasks`).all().map(r=>{
    const ms=json(r.model_selection_json)||{},model=[ms.instanceId||ms.provider,ms.model].filter(x=>typeof x==='string'&&x).join(':');
    const prompt=String(r.prompt||'').split('\n').find(l=>l.trim())||'',lastRun=anyTime(r.last_run_at),nextRun=anyTime(r.next_run_at);
    const project=titles.get(r.project_id);
    return {id:clip(`t3:${r.task_id}`,200),name:clip(r.title||prompt||r.task_id,120),source:'t3',group:clip(project?`T3 · ${project}`:'T3',120),
      schedule:clip(t3Schedule(json(r.schedule_json)),200),command:clip(redact((model?`${model} · `:'')+prompt),300),ai:true,
      enabled:r.enabled===undefined?true:!!Number(r.enabled),...(lastRun?{lastRun}:{}),lastStatus:lastRun?t3Status(r.last_run_status):'unknown',...(nextRun?{nextRun}:{})};
  });
}
function t3Roots(db){
  const cols=columns(db,'projection_projects');if(!cols.has('workspace_root'))return [];
  return db.prepare(`SELECT workspace_root FROM projection_projects${cols.has('deleted_at')?' WHERE deleted_at IS NULL':''}`).all().map(r=>r.workspace_root).filter(Boolean);
}
function systemdJobs(scope,group,note){
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
  return timers.map(t=>systemdJob(t,T.get(t.unit),S.get(t.service),{scope,group}));
}
function repoJobs(roots,sources,note,now){
  const out=[],ls=d=>{try{return readdirSync(d)}catch{return []}},isDir=p=>{try{return statSync(p).isDirectory()}catch{return false}};
  const seen=new Set();
  for(const r of roots){
    let root;try{root=realpathSync(tilde(r))}catch{continue}
    if(seen.has(root)||!isDir(root))continue;seen.add(root);
    const repo=basename(root);
    try{
      const dirs=[root,...['services','apps'].flatMap(s=>ls(join(root,s)).map(x=>join(root,s,x)).filter(isDir))];
      for(const dir of dirs){
        const rel=relative(root,dir),files=ls(dir);
        if(sources.has('vercel')&&files.includes('vercel.json'))out.push(...vercelJobs(readFileSync(join(dir,'vercel.json'),'utf8'),{repo:rel?`${repo}/${rel}`:repo,now}));
        if(sources.has('railway'))for(const f of files.filter(f=>/^railway(\.[\w.-]+)?\.(json|toml)$/.test(f))){
          // railway.<name>.json is a config for another service: "<repo> (<name>)".
          const extra=f.replace(/\.(json|toml)$/,'').replace(/^railway\.?/,''),base=rel?basename(dir):repo;
          const service=extra?`${base} (${extra})`:base;
          out.push(...railwayJobs(readFileSync(join(dir,f),'utf8'),{repo,service,file:rel?`${rel}/${f}`:f,toml:f.endsWith('.toml'),now}));
        }
      }
      if(sources.has('github')){
        const wf=join(root,'.github','workflows');
        for(const f of ls(wf).filter(f=>/\.ya?ml$/.test(f)))out.push(...workflowJobs(readFileSync(join(wf,f),'utf8'),{repo,file:f,now}));
      }
    }catch(e){note(`${repo}: ${e.message}`)}
  }
  return out;
}
export const jobsOn=c=>c?.jobs!==false&&c?.jobs?.enabled!==false;
const SOURCES=['systemd','cron','t3','vercel','railway','github'];
// Every scheduled job this machine knows of, filtered, deduplicated by id and capped at 500.
export async function discoverJobs(c={},{note=()=>{}}={}){
  const o=c.jobs&&typeof c.jobs==='object'?c.jobs:{},sources=new Set(Array.isArray(o.sources)?o.sources:SOURCES);
  const runner=clip(c.name||hostname(),100),now=new Date(),jobs=[];
  const step=(label,fn)=>{try{jobs.push(...fn())}catch(e){note(`${label}: ${e.message}`)}};
  if(sources.has('systemd')){step('systemd user timers',()=>systemdJobs('user',runner,note));step('systemd system timers',()=>systemdJobs('system',`${runner} · system`,note))}
  if(sources.has('cron'))step('crontab',()=>{
    const r=run('crontab',['-l'],{timeout:5000});
    if(r.error?.code==='ENOENT')return [];
    if(r.status!==0){if(!/no crontab/i.test(r.stderr))note(`crontab -l: ${clip(r.stderr,160)}`);return []}
    return crontabJobs(r.stdout,{group:runner,now});
  });
  const wantRepos=['vercel','railway','github'].some(s=>sources.has(s));
  const db=sources.has('t3')||(wantRepos&&!Array.isArray(o.repos))?await openT3(tilde(c.t3Home||'~/.t3'),note):null;
  try{
    if(db&&sources.has('t3'))step('T3 tasks',()=>t3Jobs(db,note));
    if(wantRepos){
      let roots=Array.isArray(o.repos)?o.repos:[];
      if(!Array.isArray(o.repos)&&db)try{roots=t3Roots(db)}catch(e){note(`T3 projects: ${e.message}`)}
      step('repo crons',()=>repoJobs(roots,sources,note,now));
    }
  }finally{db?.close()}
  const seen=new Set();
  return filterJobs(jobs,{include:o.include||[],exclude:o.exclude||[],skipDistro:o.skipDistro!==false})
    .filter(j=>!seen.has(j.id)&&seen.add(j.id)).slice(0,500).map(({distro,...j})=>j);
}
// The `jobs` table: one line a job, grouped.
const when=iso=>{if(!iso)return '';const d=new Date(iso);return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${hm(d.getHours(),d.getMinutes())}`};
export function jobsTable(jobs){
  if(!jobs.length)return 'No scheduled jobs found.';
  const rows=[...jobs].sort((a,b)=>(a.group||'').localeCompare(b.group||'')||a.name.localeCompare(b.name))
    .map(j=>[j.group||'',j.source,j.name,j.schedule,j.enabled===false?'off':'on',j.ai?'ai':'',when(j.lastRun),j.lastStatus||'',when(j.nextRun)]);
  const head=['GROUP','SOURCE','NAME','SCHEDULE','ON','AI','LAST RUN','STATUS','NEXT RUN'],cap=[30,8,44,34,3,2,16,7,16];
  const cut=(s,n)=>s.length>n?s.slice(0,n-1)+'~':s;
  const w=head.map((h,i)=>Math.min(cap[i],Math.max(h.length,...rows.map(r=>r[i].length))));
  return [head,...rows].map(r=>r.map((x,i)=>cut(x,w[i]).padEnd(w[i])).join('  ').trimEnd()).join('\n');
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
async function tick(){
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

async function jobsCmd(){
  const t0=Date.now(),notes=[];
  if(!jobsOn(cfg))notes.push('jobs are off in the runner settings ("jobs": false); this is what would be found');
  const jobs=await discoverJobs(cfg,{note:m=>notes.push(m)});
  for(const n of notes)console.error('note: '+n);
  if(args.includes('--json'))console.log(JSON.stringify(jobs,null,2));
  else console.log(jobsTable(jobs));
  console.error(`${jobs.length} jobs in ${Date.now()-t0} ms`);
}

async function main(argv){
  args=argv;cmd=args.find(a=>!a.startsWith('-'))||'tick';
  cfgPath=args.includes('--config')?args[args.indexOf('--config')+1]:join(cfgDir,'runner.json');
  cfg=readJson(cfgPath)||{};
  const cmds={report,tick,status,retry,jobs:jobsCmd};
  if(!cmds[cmd]){console.error('Use: report | tick | status | retry <card number> | jobs [--json]');process.exit(2)}
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
