#!/usr/bin/env node
// A reference AgentFlow runner for T3 Code (docs/concepts/09-agentflow.md, "Runners").
//
//   node tools/agent-runner.mjs report   tell Flow which models this machine can run (runners.report)
//   node tools/agent-runner.mjs tick     report, check running threads, start work for live agents
//   node tools/agent-runner.mjs status   print the live agents for this runner and what it is running
//
// One pass per call: run `tick` from a timer (cron, a systemd timer) every few minutes.
// For each AgentFlow agent with `live` on whose `runtime` is this runner's name, it takes the first
// card in the agent's queue (Doing, then Requests), starts a T3 thread on the agent's `model` with the
// agent's brief and the card, and remembers it. When the thread finishes it moves the card to UAT for
// a person to approve. A thread waiting on a question is left for you to answer in T3.
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
//   }
// Model ids are "<T3 provider instance>:<model>", e.g. "claudeAgent:claude-sonnet-5-5" or
// "opencode:anthropic/claude-sonnet-5-5". The runner reports the current models from T3's model
// manifest for each enabled provider, plus `opencode models`, `grok models` and "models" above.
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
  const models=[];
  for(const p of on){
    for(const m of manifest.providers?.[p.driver]?.models||[])if(m.status==='current')models.push({id:`${p.id}:${m.slug}`,label:`${p.label} · ${m.name||m.slug}`});
    if(p.driver==='opencode'&&cfg.opencode!=='')for(const m of lines(run(tilde(cfg.opencode||'opencode'),['models'])))models.push({id:`${p.id}:${m}`,label:`${p.label} · ${m}`});
    if(p.driver==='grok'&&cfg.grok!=='')for(const l of lines(run(tilde(cfg.grok||'grok'),['models']))){const m=/^[*-]\s+([\w.-]+)/.exec(l);if(m)models.push({id:`${p.id}:${m[1]}`,label:`${p.label} · ${m[1]}`})}
  }
  models.push(...(cfg.models||[]).filter(m=>m?.id));
  const seen=new Set();return models.filter(m=>!seen.has(m.id)&&seen.add(m.id)).slice(0,500);
}
async function report(){
  const models=catalog(),r=await flow('POST',`/runners/${encodeURIComponent(cfg.name)}`,{models});
  log(`reported ${models.length} models as "${cfg.name}"${r.changed?'':' (unchanged)'}`);
  return models;
}

// ---------- T3 ----------
const t3=(argv,input)=>{const r=run(T3,[...argv,'--json'],{input,timeout:120000});if(r.status!==0)throw new Error(`t3 ${argv[0]} ${argv[1]}: ${(r.stderr||r.stdout).trim().slice(0,400)}`);return JSON.parse(r.stdout)};
const splitModel=m=>{const i=m.indexOf(':');return i>0?[m.slice(0,i),m.slice(i+1)]:[null,m]};
function projectFor(card,projects){
  const map=cfg.projects||{},p=projects.find(x=>x.id===card.project);
  const hit=Object.entries(map).find(([k])=>k===card.project||(p&&same(k,p.name)));
  return tilde(hit?.[1]||cfg.project||'');
}
function prompt(agent,brief,card){
  const checklist=(card.checklist||[]).map(x=>`- [${x.done?'x':' '}] ${x.text}`).join('\n');
  return `You are working as the AgentFlow agent "${agent.name}". Your brief follows, then the card to work on.\n\n${brief}\n\n---\n\n`
    +`# Card #${card.number}: ${card.title}\n\n${card.description||'(no description)'}\n\n${checklist?`## Checklist\n\n${checklist}\n\n`:''}${card.due?`Due: ${card.due}\n\n`:''}`
    +`Do the work for this card. When you finish, reply with a short summary of what you did, anything left undone, and links to any pull requests or commits. `
    +`The runner moves the card to UAT for a person to review when this thread finishes, so do not move it yourself.`;
}

// ---------- one pass ----------
async function tick(){
  const state=readJson(stateFile)||{runs:{}};const save=()=>DRY||writeJson(stateFile,state);
  await report().catch(e=>log('report failed:',e.message));
  // Threads started earlier: done ones send their card to UAT.
  for(const [cardId,r] of Object.entries(state.runs).filter(([,r])=>r.status==='running')){
    let th;try{th=t3(['thread','show',r.thread,'--messages','0']).thread}catch(e){log(`#${r.number}: cannot read thread ${r.thread}: ${e.message}`);continue}
    if(th.activeRunId||th.status==='running'){log(`#${r.number} (${r.agent}) still running`);continue}
    if(th.pendingRequestCount>0){log(`#${r.number} (${r.agent}) is waiting for an answer in T3: ${th.title}`);continue}
    log(`#${r.number} (${r.agent}) finished; moving it to UAT`);
    if(!DRY){try{await flow('POST',`/cards/${encodeURIComponent(r.number)}/move`,{column:'uat'})}catch(e){log(`#${r.number}: could not move to UAT: ${e.message}`)}}
    r.status='done';r.finished=new Date().toISOString();save();
  }
  const running=()=>Object.values(state.runs).filter(r=>r.status==='running').length;
  const agents=(await all('/agents?live=true')).filter(a=>a.kind==='agent'&&same(a.runtime,cfg.name));
  if(!agents.length){log(`no live agents run on "${cfg.name}"`);return}
  const projects=await all('/projects').catch(()=>[]);
  for(const a of agents){
    if(running()>=(cfg.maxRunning??1)){log(`at maxRunning (${cfg.maxRunning??1}); the rest wait for the next pass`);break}
    if(Object.values(state.runs).some(r=>r.status==='running'&&r.agentId===a.id))continue;
    const [provider,model]=splitModel(a.model||'');
    if(!provider||!model){log(`${a.name}: live but no model of the form provider:model; skipped`);continue}
    const work=await flow('GET',`/agents/${encodeURIComponent(a.id)}/work?columns=doing,requests&limit=20`);
    const card=work.items.find(c=>!state.runs[c.id]);
    if(!card){log(`${a.name}: nothing to do`);continue}
    const project=projectFor(card,projects);
    if(!project){log(`${a.name}: #${card.number} has no T3 project (set "project" or "projects"); skipped`);continue}
    const title=`[Flow] ${a.name}: #${card.number} ${card.title}`.slice(0,120);
    if(DRY){log(`dry run: would start "${title}" on ${provider} / ${model} in ${project}`);continue}
    if(card.column==='requests'){
      try{await flow('POST',`/cards/${encodeURIComponent(card.number)}/move`,{column:'doing',...(cfg.developer?{developer:cfg.developer}:{})})}
      catch(e){log(`#${card.number}: left in Requests (${e.code||e.message})`)}
    }
    const argv=['thread','start','--provider',provider,'--model',model,'--title',title,...(cfg.worktree?['--worktree',cfg.worktree]:[]),project,'-'];
    let th;try{th=t3(argv,prompt(a,work.brief,card))}catch(e){log(`${a.name}: could not start a thread: ${e.message}`);continue}
    const id=th.threadId||th.thread?.threadId||th.id;
    state.runs[card.id]={agent:a.name,agentId:a.id,number:card.number,thread:id,status:'running',started:new Date().toISOString()};save();
    log(`started ${title} on ${provider} / ${model}: thread ${id}`);
  }
}
async function status(){
  const state=readJson(stateFile)||{runs:{}};
  const agents=(await all('/agents?live=true')).filter(a=>a.kind==='agent'&&same(a.runtime,cfg.name));
  console.log(`${cfg.name} · ${cfg.env} · ${DRY?'dry run':'live'} · ${agents.length} live agents`);
  for(const a of agents)console.log(`  ${a.name}: ${a.model||'(no model)'}`);
  for(const r of Object.values(state.runs).filter(r=>r.status==='running'))console.log(`  running: #${r.number} for ${r.agent}, thread ${r.thread}`);
}

const cmds={report,tick,status};
if(!cmds[cmd]){console.error('Use: report | tick | status');process.exit(2)}
if(!existsSync(cfgPath))process.exit(1);
cmds[cmd]().catch(e=>{console.error(e.message||e);process.exit(1)});
