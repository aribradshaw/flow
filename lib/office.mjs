// The 3D office (docs/concepts/12-office.md): live coding agents reported by people's machines, and the
// live channel (Server-Sent Events) for presence, chat and emotes in an environment's office.
//
//   normalizeRepo(text) / repoMatches(projectRepos, repo)   repo names, owner/name and git remotes
//   cleanReport(input)                                      a reporter's PUT body, validated and capped
//   officeState({now, staleMs})                             reported agents and queued answers, per user
//   viewAgent(agent, {owner, full, key})                    one agent as one viewer may see it
//   officeHub({state, context, ...})                        SSE clients, presence and chat, per environment
//
// Everything here is in memory: Flow runs as a single server instance, so one process holds every
// office. A restart empties it; reporters fill it again within seconds, and open offices reconnect.
// Agents belong to a person (the API key's owner), not to an environment: they show in the office of
// every environment that person is a member of, redacted per viewer on the server (viewAgent).
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {cleanSeatTag,seatIndex,resolveSeat,seatFor,canSeeAgent,canSeeCard,deskOf} from './office-seats.mjs';
import {transcriptText} from './office-mask.mjs';

export const VENDORS=['claude','codex','gemini','deepseek','grok','other'];
export const STATUSES=['running','waiting','idle'];
export const EMOTES=['wave','thumbs','clap','heart'];
export const TRANSCRIPT_MAX=12,TRANSCRIPT_TEXT=400,TRANSCRIPT_ROLES=['user','assistant','tool'];
export const STALE_MS=90e3,MAX_AGENTS=200,MAX_CHILDREN=20,CHAT_KEEP=50,SAY_MAX=280,ACTION_KEEP_MS=36e5;
const lc=s=>String(s||'').trim().toLowerCase(),same=(a,b)=>lc(a)===lc(b);
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};

// ---------- repos ----------
// "flow", "owner/flow", "github.com/owner/flow", "https://github.com/owner/flow.git",
// "git@github.com:owner/flow.git", "ssh://git@host:22/owner/flow" -> {full:'owner/flow'|'', name:'flow'}
export function normalizeRepo(text){
  let s=lc(text).replace(/\\/g,'/');if(!s)return null;
  let host=false;
  const scp=/^[^@/\s]+@([^:/\s]+):(.+)$/.exec(s);
  if(scp){s=scp[2];host=false}
  else if(/^[^/:\s]+\.[^/:\s]+:(?!\d)/.test(s))s=s.replace(/^[^/:\s]+:/,''); // host:owner/name
  else if(/^[a-z][a-z0-9+.-]*:\/\//.test(s)){s=s.replace(/^[a-z][a-z0-9+.-]*:\/\//,'');host=true}
  s=s.replace(/[?#].*$/,'').replace(/\/+$/,'').replace(/\.git$/,'').replace(/\/+$/,'');
  let parts=s.split('/').filter(Boolean);
  if(host||(parts.length>1&&/[.:]/.test(parts[0])))parts=parts.slice(1);
  parts=parts.filter(p=>p!=='-'&&!/^_?git$/.test(p));
  if(!parts.length)return null;
  const name=parts.at(-1).replace(/\.git$/,'');if(!name)return null;
  return {full:parts.length>1?`${parts.at(-2)}/${name}`:'',name};
}
// Does a reported repo ({name, remote}) belong to a project with these repos? owner/name is compared
// when both sides have it; otherwise the bare name.
export function repoMatches(repos,repo){
  if(!Array.isArray(repos)||!repos.length||!repo)return false;
  const r=normalizeRepo(repo.remote)||normalizeRepo(repo.name);if(!r)return false;
  const named=normalizeRepo(repo.name);
  return repos.some(x=>{const p=normalizeRepo(x);if(!p)return false;
    if(p.full&&r.full)return p.full===r.full;
    return p.name===r.name||(!!named&&p.name===named.name);
  });
}
// The projects (ids) a repo belongs to.
export const projectsForRepo=(projects,repo)=>(projects||[]).filter(p=>repoMatches(p.repos,repo)).map(p=>p.id);
// A remote as it may be shown: no credentials, no query.
const safeRemote=s=>{const t=str(s,500);if(!t)return '';try{if(/^[a-z][a-z0-9+.-]*:\/\//i.test(t)){const u=new URL(t);u.username='';u.password='';u.search='';u.hash='';return u.toString().replace(/\/$/,'')}}catch{}return t.replace(/^[^@/\s:]+:[^@/\s]+@/,'')};

// ---------- reports ----------
const str=(v,n)=>typeof v==='string'||typeof v==='number'?String(v).replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,n):'';
const VENDOR_ALIAS={anthropic:'claude',claude:'claude',openai:'codex',codex:'codex',google:'gemini',gemini:'gemini',deepseek:'deepseek',grok:'grok',xai:'grok'};
// The vendor names the mascot (also shown to viewers who see nothing else): from the vendor, else the model.
const MODEL_VENDOR=[[/claude|opus|sonnet|haiku|fable|anthropic/,'claude'],[/gpt|codex|openai|\bo3\b|\bo4/,'codex'],[/deepseek/,'deepseek'],[/grok|xai/,'grok'],[/gemini/,'gemini']];
const vendorOf=(v,model)=>VENDOR_ALIAS[lc(v)]||MODEL_VENDOR.find(([re])=>re.test(lc(model)))?.[1]||'other';
const statusOf=v=>STATUSES.includes(lc(v))?lc(v):'idle';
function cleanPending(p,status){
  if(status!=='waiting'||!p||typeof p!=='object'||Array.isArray(p))return null;
  const requestId=str(p.requestId,300);if(!requestId)return null;
  const can=Array.isArray(p.can)?[...new Set(p.can.map(lc))].filter(x=>x==='allow'||x==='deny'):[];
  return {requestId,kind:lc(p.kind)==='question'?'question':'approval',summary:str(p.summary,500),can};
}
function cleanChild(c,i){
  if(!c||typeof c!=='object')return null;
  return {id:str(c.id,200)||'child-'+i,title:str(c.title,200),vendor:vendorOf(c.vendor,c.model),model:str(c.model,80),status:statusOf(c.status)};
}
function cleanAgent(a){
  if(!a||typeof a!=='object'||Array.isArray(a))return null;
  const id=str(a.id,200);if(!id)return null;
  const status=statusOf(a.status),r=a.repo&&typeof a.repo==='object'?{name:str(a.repo.name,200),remote:safeRemote(a.repo.remote)}:null;
  return {id,title:str(a.title,200),vendor:vendorOf(a.vendor,a.model),model:str(a.model,80),status,activity:str(a.activity,300),
    host:str(a.host,80),hostLabel:str(a.hostLabel,120),repo:r&&(r.name||r.remote)?r:null,
    children:(Array.isArray(a.children)?a.children:[]).slice(0,MAX_CHILDREN).map(cleanChild).filter(Boolean),
    pending:cleanPending(a.pending,status),...seatTag(a.agentflow),...transcriptOf(a.transcript)};
}
// The last TRANSCRIPT_MAX lines of its conversation, for its owner only (viewAgent): {role, text, at}, each text
// masked (lib/office-mask.mjs) and cut to TRANSCRIPT_TEXT characters. Unknown roles and empty lines are dropped.
function transcriptOf(v){
  if(!Array.isArray(v))return {};
  const out=[];
  for(const e of v.slice(-TRANSCRIPT_MAX*4)){
    if(!e||typeof e!=='object'||!TRANSCRIPT_ROLES.includes(lc(e.role)))continue;
    const text=transcriptText(e.text,TRANSCRIPT_TEXT);if(!text)continue;
    const at=Date.parse(e.at);out.push({role:lc(e.role),text,...Number.isFinite(at)?{at:new Date(at).toISOString()}:{}});
  }
  return {transcript:out.slice(-TRANSCRIPT_MAX)};
}
// The AgentFlow agent and card it works for, when its reporter knows (lib/office-seats.mjs; resolved per environment).
const seatTag=v=>{const t=cleanSeatTag(v);return t?{agentflow:t}:{}};
// {source, at, agents} -> {source, at, agents} (the first MAX_AGENTS with distinct ids; strings cut to size).
export function cleanReport(input){
  const source=str(input?.source,60);if(!source)fail(400,'invalid_input','source is required (up to 60 characters)');
  if(!Array.isArray(input?.agents))fail(400,'invalid_input','agents must be an array');
  const seen=new Set(),agents=[];
  for(const x of input.agents){if(agents.length>=MAX_AGENTS)break;const a=cleanAgent(x);if(a&&!seen.has(a.id)){seen.add(a.id);agents.push(a)}}
  const at=Date.parse(input.at);
  return {source,at:Number.isFinite(at)?new Date(at).toISOString():new Date().toISOString(),agents};
}

// ---------- state: reported agents and the answers queued for them ----------
// Events (on(fn)): {type:'agents', email} when someone's live agents changed (a report, a source going
// stale); {type:'action', email, action} when an answer is queued; {type:'result', email, action} when
// its reporter says how it went (email: the agent's owner, the only one who sees either).
export function officeState({now=()=>Date.now(),staleMs=STALE_MS}={}){
  const reports=new Map(),actions=new Map(),waiters=new Set(),listeners=new Set();
  const emit=e=>{for(const f of listeners)try{f(e)}catch{}};
  const mine=(email,source)=>[...actions.values()].filter(a=>same(a.email,email)&&a.source===source&&!a.delivered);
  const deliver=list=>list.map(a=>{a.delivered=true;a.deliveredAt=new Date(now()).toISOString();return outAction(a)});
  const wake=(email,source)=>{for(const w of [...waiters])if(same(w.email,email)&&w.source===source){const list=mine(email,source);if(!list.length)return;waiters.delete(w);clearTimeout(w.timer);w.resolve(deliver(list))}};
  function sweep(){
    const t=now();
    for(const [email,m] of reports){let changed=false;for(const [s,r] of m)if(t-r.received>staleMs){m.delete(s);changed=true}if(!m.size)reports.delete(email);if(changed)emit({type:'agents',email})}
    for(const [id,a] of actions)if(t-Date.parse(a.at)>ACTION_KEEP_MS)actions.delete(id);
  }
  const find=(email,source,agentId)=>reports.get(lc(email))?.get(source)?.agents.find(a=>a.id===agentId)||null;
  return {
    on(f){listeners.add(f);return ()=>listeners.delete(f)},
    sweep,
    // A reporter's PUT: replaces that source's set. -> {actions} not yet delivered for this user and source.
    report(email,input){
      const r=cleanReport(input),key=lc(email),m=reports.get(key)||new Map(),old=m.get(r.source),sig=JSON.stringify(r.agents);
      const received=now();
      m.set(r.source,{...r,received,sig});reports.set(key,m);
      if(!old||received-old.received>staleMs||old.sig!==sig)emit({type:'agents',email:key});
      return {actions:deliver(mine(key,r.source)),accepted:r.agents.length};
    },
    // Every live agent of one person: [{...agent, source}], newest sources dropped once stale.
    live(email){
      const t=now(),m=reports.get(lc(email));if(!m)return [];
      return [...m.values()].filter(r=>t-r.received<=staleMs).flatMap(r=>r.agents.map(a=>({...a,source:r.source})));
    },
    sources(email){const t=now(),m=reports.get(lc(email));return m?[...m.values()].filter(r=>t-r.received<=staleMs).map(r=>({source:r.source,at:r.at,agents:r.agents.length})):[]},
    // Allow / Deny from the office: only the agent's owner, only while it waits on that same request.
    answer({by,owner,source,agentId,requestId,decision}){
      if(!same(by,owner))fail(403,'not_owner','Only the agent\'s owner can answer it');
      if(decision!=='allow'&&decision!=='deny')fail(400,'invalid_input','decision must be allow or deny');
      const a=find(owner,source,agentId);
      if(!a)fail(404,'agent_not_found','That agent is not reporting any more');
      if(a.status!=='waiting'||!a.pending||a.pending.requestId!==requestId)fail(409,'not_waiting','It is not waiting on that request any more');
      if(!a.pending.can.includes(decision))fail(409,'cannot_answer','That prompt cannot be answered from Flow: answer it where the agent runs');
      if([...actions.values()].some(x=>same(x.email,owner)&&x.source===source&&x.agentId===agentId&&x.requestId===requestId))fail(409,'already_answered','That prompt was already answered');
      const act={id:'act_'+randomUUID(),email:lc(owner),source,agentId,requestId,decision,at:new Date(now()).toISOString(),delivered:false,result:null};
      actions.set(act.id,act);emit({type:'action',email:act.email,action:outAction(act)});wake(owner,source);
      return outAction(act);
    },
    // Long-poll: resolves with the undelivered answers as soon as there are any, else [] after ms.
    wait(email,source,ms){
      const list=mine(email,source);if(list.length||ms<=0)return Promise.resolve(deliver(list));
      return new Promise(resolve=>{const w={email:lc(email),source,resolve};w.timer=setTimeout(()=>{waiters.delete(w);resolve([])},ms);waiters.add(w)});
    },
    // The reporter says how an answer went.
    result(email,id,{ok,message}={}){
      const a=actions.get(id);if(!a||!same(a.email,email))fail(404,'action_not_found','No such action');
      a.result={ok:!!ok,message:str(message,300),at:new Date(now()).toISOString()};
      emit({type:'result',email:a.email,action:outAction(a)});return outAction(a);
    },
    recent(email){return [...actions.values()].filter(a=>same(a.email,email)).map(outAction)},
    close(){for(const w of waiters){clearTimeout(w.timer);w.resolve([])}waiters.clear()},
  };
}
const outAction=a=>({id:a.id,agentId:a.agentId,source:a.source,requestId:a.requestId,decision:a.decision,at:a.at,...(a.result?{result:a.result}:{})});

// ---------- one agent for one viewer ----------
// owner: the viewer reported it (only the owner ever gets its transcript); full: the viewer may see its project. Otherwise only the mascot,
// vendor and status leave the server, under an opaque id (key(agent) -> stable per process).
// projects: the names of this environment's projects its repo belongs to that the viewer can see.
// seat: the AgentFlow agent (id) and card it works for, as this viewer may see them (lib/office-seats.mjs seatFor).
export function viewAgent(a,{owner=false,full=false,key=x=>x.id,projects=[],seat=null}={}){
  if(!owner&&!full)return {id:key(a),vendor:a.vendor,status:a.status,private:true,children:a.children.map(c=>({vendor:c.vendor,status:c.status}))};
  const repo=a.repo?{name:normalizeRepo(a.repo.remote)?.name||normalizeRepo(a.repo.name)?.name||a.repo.name,slug:normalizeRepo(a.repo.remote)?.full||normalizeRepo(a.repo.name)?.full||''}:null;
  return {id:owner?a.id:key(a),...(owner?{source:a.source}:{}),title:a.title,vendor:a.vendor,model:a.model,status:a.status,activity:a.activity,host:a.host,hostLabel:a.hostLabel,repo,
    children:a.children.map(c=>({title:c.title,vendor:c.vendor,model:c.model,status:c.status})),
    pending:a.pending?{...(owner?{requestId:a.pending.requestId}:{}),kind:a.pending.kind,summary:a.pending.summary,can:owner?a.pending.can:[]}:null,
    projects,...(seat?{seat}:{}),...(owner&&a.transcript?{transcript:a.transcript}:{}),mine:owner,private:false};
}

// ---------- the live channel ----------
// context.env(envId)  -> {id, name, ownerEmail, members:[{email, name}], projects:[{id, name, repos}], agents:[AgentFlow agents
//                        with the card ids delegated to them; a human one with memberEmail when it is one of the members], cards:[DevOps cards: id, number, title, column, moved, project, due, snoozedUntil]}
// context.access(envId, user) -> {ok, all, projectIds:Set, cardIds?:Set} (all: every project of the environment is visible)
// secret: keys members and agents (opaque, stable for as long as the secret is: the server keeps one on disk).
export function officeHub({state,context,now=()=>Date.now(),heartbeatMs=15e3,ttlMs=20e3,secret=randomBytes(16)}){
  const clients=new Map(),presence=new Map(),chat=new Map(),cache=new Map(),limits=new Map(),left=new Map();
  const hash=s=>createHmac('sha256',secret).update(s).digest('base64url').slice(0,12);
  const memberKey=email=>'m'+hash('member\n'+lc(email));
  const agentKey=(email,a)=>'a'+hash(`agent\n${lc(email)}\n${a.source}\n${a.id}`);
  const accessSig=a=>JSON.stringify([a.all,[...a.projectIds||[]],[...a.cardIds||[]],
    a.scopes?.map(s=>[s.id,[...s.nodeIds]])]);
  const sigOf=ctx=>JSON.stringify([ctx.members.map(m=>[m.email,m.name,m.personIds]),ctx.projects.map(p=>[p.id,p.repos]),ctx.agents,(ctx.cards||[]).map(c=>[c.id,c.number,c.title,c.column,c.moved,c.project,c.snoozedUntil||''])]);
  async function env(envId,fresh=false){
    const c=cache.get(envId);if(c&&!fresh&&now()-c.at<ttlMs)return c.ctx;
    const ctx=await context.env(envId);cache.set(envId,{at:now(),ctx,sig:sigOf(ctx)});return ctx;
  }
  const send=(cl,type,data)=>{try{cl.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)}catch{}};
  const each=(envId,f)=>{for(const cl of clients.get(envId)||[])f(cl)};
  // A member's live agents as one client sees them. One seated at an AgentFlow agent's desk (lib/office-seats.mjs)
  // is shown in full to someone else only when, besides its project, they can see that agent or its card.
  function agentsFor(cl,ctx,email){
    const own=same(cl.user.email,email),ix=seatIndex(ctx);
    return state.live(email).map(a=>{
      const projects=projectsForRepo(ctx.projects,a.repo),seen=own||cl.access.all?projects:projects.filter(id=>cl.access.projectIds.has(id));
      const at=resolveSeat(ix,a);let full=!own&&seen.length>0;
      if(full&&at?.agent)full=canSeeAgent(cl.access,ix.agents.get(at.agent))||canSeeCard(cl.access,ix.cards.get(at.card));
      const names=seen.map(id=>ctx.projects.find(p=>p.id===id)?.name).filter(Boolean);
      return viewAgent(a,{owner:own,full,key:x=>agentKey(email,x),projects:names,seat:own||full?seatFor(ix,at,cl.access,{owner:own}):null});
    });
  }
  const person=p=>({key:p.key,name:p.name,image:p.image,x:p.x,y:p.y,z:p.z,heading:p.heading,moving:p.moving,jump:p.jump,sprint:p.sprint});
  function take(key,per){
    // A token bucket per key: per = [burst, refill per second].
    const t=now(),b=limits.get(key)||{tokens:per[0],at:t};b.tokens=Math.min(per[0],b.tokens+(t-b.at)/1000*per[1]);b.at=t;limits.set(key,b);
    if(limits.size>20000)limits.clear();
    if(b.tokens<1)return false;b.tokens-=1;return true;
  }
  const off=state.on(async e=>{
    if(e.type==='agents'){
      for(const set of clients.values())for(const cl of set)if(same(cl.user.email,e.email))send(cl,'yourSources',state.sources(e.email));
      for(const envId of clients.keys()){
        let ctx;try{ctx=await env(envId)}catch{continue}
        if(!ctx.members.some(m=>same(m.email,e.email)))continue;
        each(envId,cl=>send(cl,'agents',{member:memberKey(e.email),agents:agentsFor(cl,ctx,e.email)}));
      }
    }
    if(e.type==='action'||e.type==='result')for(const set of clients.values())for(const cl of set)if(same(cl.user.email,e.email))send(cl,e.type,e.action);
  });
  // The common area: every AgentFlow agent for those who can read the environment; for a share's
  // recipient, only the agents linked to a project they can see.
  // Each with its desk: its queue and recently finished cards, the ones this viewer can see (lib/office-seats.mjs deskOf).
  // A human agent linked to a member (memberEmail, see context.env) carries that member's key instead: their avatar is that agent.
  const agentflowFor=(ctx,cl)=>{const ix=seatIndex(ctx);return ctx.agents.filter(a=>canSeeAgent(cl.access,a)).map(({cards,memberEmail,...a})=>({...a,member:memberEmail?memberKey(memberEmail):'',cards:(cards||[]).filter(id=>ix.cards.has(id)&&canSeeCard(cl.access,ix.cards.get(id))),desk:deskOf(ix,a.id,cl.access,now())}))};
  // lastSeen: when they last had this office open (this process), else their last sign-in.
  const membersView=(ctx,cl)=>ctx.members.map(m=>{
    const key=memberKey(m.email),owner=same(m.email,ctx.ownerEmail),me=same(m.email,cl.user.email);
    const personIds=cl.access.scopes
      ?cl.access.scopes.flatMap(s=>(m.personIds||[]).filter(id=>s.nodeIds.has(id)).map(id=>`sh.${s.id}.${id}`))
      :m.personIds||[];
    return {key,name:m.name,owner,me,personIds:[...new Set(personIds)],lastSeen:left.get(ctx.id+'\n'+key)||m.lastSeen||''};
  });
  // Members or projects' repos changed (a new share, a project's repos edited): new rooms, re-redacted agents.
  const push=(cl,ctx)=>{send(cl,'members',{members:membersView(ctx,cl),agentflow:agentflowFor(ctx,cl)});for(const m of ctx.members)send(cl,'agents',{member:memberKey(m.email),agents:agentsFor(cl,ctx,m.email)})};
  // Re-read an environment; when its members or repos changed, everyone in its office hears.
  async function reread(envId){
    const before=cache.get(envId)?.sig,ctx=await env(envId,true);
    const changed=before!==undefined&&before!==cache.get(envId).sig;
    await Promise.all([...(clients.get(envId)||[])].map(async cl=>{
      let accessChanged=false;
      if(context.access){
        const access=await context.access(envId,cl.user);
        if(!access.ok){cl.res.end();return}
        accessChanged=accessSig(access)!==accessSig(cl.access);
        cl.access=access;
      }
      if(changed||accessChanged)push(cl,ctx);
    }));
    return ctx;
  }
  async function recheck(){for(const envId of [...clients.keys()])await reread(envId).catch(()=>{})}
  // A heartbeat event (not just a comment) every heartbeatMs: proxies see traffic, and the page can tell a stalled stream.
  const beat=setInterval(()=>{state.sweep();for(const set of clients.values())for(const cl of set)send(cl,'hb',{});recheck().catch(()=>{})},heartbeatMs);beat.unref?.();
  return {
    memberKey,
    // GET /api/office/{env}/events: the caller already checked access (context.access).
    async connect(envId,user,access,req,res){
      const ctx=await reread(envId),key=memberKey(user.email);
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
      res.write('retry: 3000\n\n');
      const cl={id:randomUUID(),envId,user,key,access,res};
      const set=clients.get(envId)||new Set();set.add(cl);clients.set(envId,set);
      const room=presence.get(envId)||new Map();presence.set(envId,room);
      const me=room.get(key)||{key,name:user.name||user.email.split('@')[0],image:typeof user.image==='string'&&user.image.length<=200000?user.image:'',x:null,y:0,z:null,heading:0,moving:false,jump:false,sprint:false,conns:0};
      me.conns++;room.set(key,me);
      const live={};for(const m of ctx.members)live[memberKey(m.email)]=agentsFor(cl,ctx,m.email);
      send(cl,'snapshot',{env:{id:ctx.id,name:ctx.name},me:{key,name:me.name},
        members:membersView(ctx,cl),
        agentflow:agentflowFor(ctx,cl),live,people:[...room.values()].filter(p=>p.x!==null).map(person),chat:chat.get(envId)||[],
        actions:state.recent(user.email),yourSources:state.sources(user.email)});
      const bye=()=>{
        if(!set.delete(cl))return;if(!set.size)clients.delete(envId);
        if(--me.conns<=0){room.delete(key);const at=new Date(now()).toISOString();left.set(envId+'\n'+key,at);if(left.size>20000)left.clear();each(envId,c=>send(c,'leave',{key,at}));if(!room.size)presence.delete(envId)}
      };
      req.on('close',bye);res.on('close',bye);res.on('error',bye);
      return cl;
    },
    move(envId,user,{x,y,z,heading,moving,jump,sprint}={}){
      const key=memberKey(user.email),p=presence.get(envId)?.get(key);if(!p)fail(409,'not_connected','Open the office first');
      if(!take('move\n'+key+'\n'+envId,[20,15]))fail(429,'rate_limited','Too many moves');
      const num=(v,lo,hi)=>Number.isFinite(v)?Math.max(lo,Math.min(hi,v)):null;
      const nx=num(x,-500,500),nz=num(z,-500,500);if(nx===null||nz===null)fail(400,'invalid_input','x and z must be numbers');
      const joined=p.x===null;Object.assign(p,{x:nx,y:num(y,0,8)??0,z:nz,heading:num(heading,-1e3,1e3)??0,moving:!!moving,jump:jump===true,sprint:sprint===true,at:now()});
      each(envId,c=>{if(c.key!==key)send(c,joined?'join':'move',person(p))});
      return {ok:true};
    },
    say(envId,user,text){
      const key=memberKey(user.email),t=str(text,SAY_MAX);if(!t)fail(400,'invalid_input','Say something');
      if(!presence.get(envId)?.get(key))fail(409,'not_connected','Open the office first');
      if(!take('say\n'+key,[5,1]))fail(429,'rate_limited','Slow down a little');
      const line={id:randomUUID(),key,name:presence.get(envId).get(key).name,text:t,at:new Date(now()).toISOString()};
      const log=chat.get(envId)||[];log.push(line);if(log.length>CHAT_KEEP)log.splice(0,log.length-CHAT_KEEP);chat.set(envId,log);
      each(envId,c=>send(c,'say',line));return {ok:true};
    },
    emote(envId,user,emote){
      const key=memberKey(user.email);if(!EMOTES.includes(emote))fail(400,'invalid_input','emote must be one of '+EMOTES.join(', '));
      if(!presence.get(envId)?.get(key))fail(409,'not_connected','Open the office first');
      if(!take('emote\n'+key,[6,2]))fail(429,'rate_limited','Slow down a little');
      each(envId,c=>send(c,'emote',{key,emote,at:new Date(now()).toISOString()}));return {ok:true};
    },
    // The owner's live agents as reported: the agent the answer is for (source + id) must be theirs.
    answer(envId,user,b){return state.answer({by:user.email,owner:user.email,source:str(b?.source,60),agentId:str(b?.agentId,200),requestId:str(b?.requestId,300),decision:b?.decision})},
    recheck,
    clients:()=>[...clients.values()].reduce((n,s)=>n+s.size,0),
    close(){clearInterval(beat);off();for(const set of clients.values())for(const cl of set)try{cl.res.end()}catch{}clients.clear()},
  };
}
