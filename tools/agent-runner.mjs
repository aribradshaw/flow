#!/usr/bin/env node
// A reference AgentFlow runner for T3 Code (docs/concepts/09-agentflow.md, "Runners").
//
//   node tools/agent-runner.mjs report   tell Flow which models this machine can run (runners.report)
//   node tools/agent-runner.mjs tick     report, check running threads, start work for live agents
//   node tools/agent-runner.mjs status   print the live agents for this runner and what it is running
//   node tools/agent-runner.mjs retry 12 forget card #12, so the next tick starts it again
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
//     "router": "claudeAgent:claude-haiku-5"        optional: the model that picks for auto agents
//   }
// Model ids are "<T3 provider instance>:<model>", e.g. "claudeAgent:claude-sonnet-5-5" or
// "opencode:anthropic/claude-sonnet-5-5". The runner reports the current models from T3's model
// manifest for each enabled provider, plus `opencode models`, `grok models` and "models" above, each
// with its provider (the instance's display name) and billing: 'included' for Claude, Codex, Cursor,
// Grok and Antigravity instances (a subscription), and for OpenCode's own free models (opencode/…);
// 'metered' for other OpenCode models (paid per token). "billing" overrides by the longest matching
// key, an instance id ("opencode") or an id prefix ("opencode:anthropic/").
// State (threads it started): $XDG_STATE_HOME/flygon-flow/runner-state.json.
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';

const home=homedir(),tilde=p=>String(p||'').replace(/^~(?=\/|$)/,home);
const cfgDir=join(process.env.XDG_CONFIG_HOME||join(home,'.config'),'flygon-flow');
const stateFile=join(process.env.XDG_STATE_HOME||join(home,'.local','state'),'flygon-flow','runner-state.json');
const readJson=f=>{try{return JSON.parse(readFileSync(f,'utf8').replace(/^﻿/,''))}catch{return null}};
const writeJson=(f,v)=>{mkdirSync(dirname(f),{recursive:true,mode:0o700});writeFileSync(f+'.tmp',JSON.stringify(v,null,2),{mode:0o600});renameSync(f+'.tmp',f)};
const log=(...a)=>console.log(new Date().toISOString(),...a);

const args=process.argv.slice(2),cmd=args.find(a=>!a.startsWith('-'))||'tick';
const cfgPath=args.includes('--config')?args[args.indexOf('--config')+1]:join(cfgDir,'runner.json');
const cfg=readJson(cfgPath);
if(!cfg?.name||!cfg?.env){console.error(`Set "name" and "env" in ${cfgPath} (see the top of this file).`);process.exit(1)}
const login=readJson(join(cfgDir,'config.json'))||{};
const FLOW={url:(process.env.FLOW_URL||cfg.url||login.url||'').replace(/\/+$/,''),key:process.env.FLOW_API_KEY||cfg.key||login.key||''};
if(!FLOW.url||!FLOW.key){console.error('No Flow server or key: set url and key in the runner settings, FLOW_URL and FLOW_API_KEY, or run flow login.');process.exit(1)}
const DRY=cfg.dryRun!==false||args.includes('--dry-run'),T3=tilde(cfg.t3||'t3'),T3HOME=tilde(cfg.t3Home||'~/.t3');
const splitModel=m=>{const i=m.indexOf(':');return i>0?[m.slice(0,i),m.slice(i+1)]:[null,m]};
const same=(a,b)=>String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();

// ---------- Flow ----------
async function flow(method,path,body){
  const r=await fetch(`${FLOW.url}/api/v1/envs/${encodeURIComponent(cfg.env)}${path}`,{method,signal:AbortSignal.timeout(30000),
    headers:{authorization:'Bearer '+FLOW.key,accept:'application/json',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>null);
  if(!r.ok)throw Object.assign(new Error(`${method} ${path}: ${r.status} ${d?.error?.code||''} ${d?.error?.message||''}`.trim()),{code:d?.error?.code});
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
  const models=catalog(),r=await flow('POST',`/runners/${encodeURIComponent(cfg.name)}`,{models});
  log(`reported ${models.length} models as "${cfg.name}"${r.changed?'':' (unchanged)'}`);
  return models;
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

const cmds={report,tick,status,retry};
if(!cmds[cmd]){console.error('Use: report | tick | status | retry <card number>');process.exit(2)}
if(!existsSync(cfgPath))process.exit(1);
cmds[cmd]().catch(e=>{console.error(e.message||e);process.exit(1)});
