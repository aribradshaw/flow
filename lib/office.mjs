// The 3D office (docs/concepts/12-office.md): live coding agents reported by people's machines, and the
// live channel (Server-Sent Events) for presence, status, chat and emotes in an environment's office.
//
//   normalizeRepo(text) / repoMatches(projectRepos, repo)   repo names, owner/name and git remotes
//   cleanReport(input)                                      a reporter's PUT body, validated and capped
//   inferKind(text, status)                                 an activityKind from free-text activity
//   officeState({now, staleMs})                             reported agents and queued answers, per user
//   viewAgent(agent, {owner, full, key})                    one agent as one viewer may see it
//   officeHub({state, context, ...})                        SSE clients, presence, status and chat, per environment;
//                                                           alert streams per person (hub.alerts)
//
// Streams and avatar positions live in this process. Reports, answers, chat and status can be
// backed by office-storage.mjs, and clients resend their positions when they reconnect.
// Agents belong to a person (the API key's owner), not to an environment: they show in the office of
// every environment that person is a member of, redacted per viewer on the server (viewAgent).
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {cleanSeatTag,seatIndex,resolveSeat,seatFor,canSeeAgent,canSeeCard,deskOf} from './office-seats.mjs';
import {transcriptText} from './office-mask.mjs';
import {createPresenceBook} from './office-status.mjs';

export const VENDORS=['claude','codex','gemini','deepseek','grok','other'];
export const STATUSES=['running','waiting','idle'];
export const EMOTES=['wave','thumbs','clap','heart'];
export const TRANSCRIPT_MAX=12,TRANSCRIPT_TEXT=400,TRANSCRIPT_ROLES=['user','assistant','tool'];
// What an agent is doing, for its animation: editing files, reading, searching, running shell commands,
// running tests, thinking, on the web, or idle. Reporters may send it; otherwise it comes from activity.
export const ACTIVITY_KINDS=['edit','read','search','run','test','think','web','idle'];
// Steering a live agent from the office (owner only, on agents whose reporter lists the kind in can).
export const STEER_KINDS=['message','stop'],MESSAGE_MAX=2000;
// Token buckets [burst, refill per second]: per person for every steer, per agent for each kind.
export const STEER_LIMITS={person:[10,1/6],message:[3,1/10],stop:[2,1/30]};
export const STALE_MS=90e3,MAX_AGENTS=200,MAX_CHILDREN=20,CHAT_KEEP=50,SAY_MAX=280,ACTION_KEEP_MS=36e5;
const lc=s=>String(s||'').trim().toLowerCase(),same=(a,b)=>lc(a)===lc(b);
const after=(value,fn)=>value?.then?value.then(fn):fn(value);
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
// ---------- activityKind ----------
// A coding agent's tool name first (Claude Code's "Edit", "Bash", "WebFetch"…; Codex's "apply_patch",
// "shell"), then plain keywords ("Running tests", "Reading the docs"). A shell command that runs tests is
// a test. Nothing recognised: a running or waiting agent is thinking; an idle one is idle.
const TOOL_KIND={edit:'edit',multiedit:'edit',write:'edit',notebookedit:'edit',apply_patch:'edit',applypatch:'edit',patch:'edit',str_replace:'edit',create:'edit',
  read:'read',view:'read',notebookread:'read',cat:'read',open:'read',
  grep:'search',glob:'search',ls:'search',find:'search',rg:'search',search:'search',codesearch:'search',
  bash:'run',shell:'run',exec:'run',exec_command:'run',terminal:'run',command:'run',powershell:'run',
  webfetch:'web',websearch:'web',web_search:'web',fetch:'web',browser:'web',
  task:'think',agent:'think',todowrite:'think',think:'think',plan:'think',update_plan:'think'};
const KIND_RE=[
  ['test',/\b(tests?|testing|specs?|pytest|jest|vitest|mocha|rspec|unittest|playwright test|(?:cargo|go|deno|bun|dotnet) test|node --test|npm (?:run )?(?:test|check)|npm t)\b/],
  ['web',/\b(web ?fetch|web ?search|websites?|web pages?|the web|brows(?:e|er|ing)|online|https?:\/\/)/],
  ['edit',/\b(edit(?:s|ed|ing)?|writ(?:e|es|ing)|patch(?:es|ing)?|refactor(?:s|ing)?|implement(?:s|ing)?|fix(?:es|ing)?|chang(?:e|es|ing)|updat(?:e|es|ing)|add(?:s|ing)?|creat(?:e|es|ing)|renam(?:e|es|ing)|delet(?:e|es|ing)|remov(?:e|es|ing))\b/],
  ['search',/\b(grep(?:ping)?|glob|rg|search(?:es|ing)?|find(?:s|ing)?|look(?:s|ing)? for|locat(?:e|es|ing)|scan(?:s|ning)?)\b/],
  ['read',/\b(read(?:s|ing)?|view(?:s|ing)?|open(?:s|ing)?|inspect(?:s|ing)?|look(?:s|ing)? at|review(?:s|ing)?|explor(?:e|es|ing)|studying)\b/],
  ['run',/(^\$ |\b(bash|shell|terminal|commands?|run(?:s|ning)?|exec(?:ut(?:e|es|ing))?|npm|npx|pnpm|yarn|git|make|build(?:s|ing)?|install(?:s|ing)?|deploy(?:s|ing)?|docker|compil(?:e|es|ing))\b)/],
  ['think',/\b(think(?:s|ing)?|plan(?:s|ning)?|reason(?:s|ing)?|consider(?:s|ing)?|analy[sz](?:e|es|ing)|summari[sz](?:e|es|ing)|draft(?:s|ing)?|respond(?:s|ing)?|answer(?:s|ing)?)\b/],
];
export function inferKind(text,status='running'){
  if(status==='idle')return 'idle';
  const t=lc(text);
  if(t){
    const first=/^[a-z_]+/.exec(t)?.[0]||'',tool=TOOL_KIND[first];
    if(tool&&(t.length===first.length||/^[\s:(\-·—]/.test(t.slice(first.length))))return tool==='run'&&KIND_RE[0][1].test(t)?'test':tool;
    // Tests and the web win wherever they are mentioned; otherwise the first word that says something
    // ("Planning the change" is thinking, "Fixing the plan" editing).
    let best=null,at=Infinity;
    for(const [kind,re] of KIND_RE){const m=re.exec(t);if(!m)continue;if(kind==='test'||kind==='web')return kind;if(m.index<at){best=kind;at=m.index}}
    if(best)return best;
  }
  return 'think';
}
// The reported kind when it is one of ours, else inferred; idle agents are always idle.
const kindOf=(v,text,status)=>status==='idle'?'idle':ACTIVITY_KINDS.includes(lc(v))?lc(v):inferKind(text,status);
function cleanPending(p,status){
  if(status!=='waiting'||!p||typeof p!=='object'||Array.isArray(p))return null;
  // Never cut a request id: reporters match it exactly (T3's run ~370 chars). Too long means no answerable prompt.
  const requestId=typeof p.requestId==='string'&&p.requestId.length<=1000?p.requestId.trim():'';if(!requestId)return null;
  const can=Array.isArray(p.can)?[...new Set(p.can.map(lc))].filter(x=>x==='allow'||x==='deny'):[];
  return {requestId,kind:lc(p.kind)==='question'?'question':'approval',summary:str(p.summary,500),can};
}
function cleanChild(c,i){
  if(!c||typeof c!=='object')return null;
  const status=statusOf(c.status);
  return {id:str(c.id,200)||'child-'+i,title:str(c.title,200),vendor:vendorOf(c.vendor,c.model),model:str(c.model,80),status,activityKind:kindOf(c.activityKind,str(c.activity,300)||str(c.title,200),status)};
}
function cleanAgent(a){
  if(!a||typeof a!=='object'||Array.isArray(a))return null;
  const id=str(a.id,200);if(!id)return null;
  const status=statusOf(a.status),r=a.repo&&typeof a.repo==='object'?{name:str(a.repo.name,200),remote:safeRemote(a.repo.remote)}:null,activity=str(a.activity,300);
  return {id,title:str(a.title,200),vendor:vendorOf(a.vendor,a.model),model:str(a.model,80),status,activity,activityKind:kindOf(a.activityKind,activity,status),
    host:str(a.host,80),hostLabel:str(a.hostLabel,120),repo:r&&(r.name||r.remote)?r:null,
    children:(Array.isArray(a.children)?a.children:[]).slice(0,MAX_CHILDREN).map(cleanChild).filter(Boolean),
    pending:cleanPending(a.pending,status),...seatTag(a.agentflow),...transcriptOf(a.transcript),...canOf(a.can)};
}
// What its owner may do from the office besides Allow / Deny: send a message (a new user turn) and stop it.
const canOf=v=>{const c=Array.isArray(v)?STEER_KINDS.filter(k=>v.some(x=>lc(x)===k)):[];return c.length?{can:c}:{}};
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
// stale); {type:'waiting', email, agent} when one of them starts waiting on its person (or on a new prompt);
// {type:'action', email, action} when an action is queued (an answer, a message, a stop); {type:'result',
// email, action} when its reporter says how it went. email is always the agent's owner: the hub sends
// waiting, action and result to them only.
// Actions: {kind:'answer', requestId, decision} (Allow / Deny; kind is "answer" when missing), {kind:'message', text}
// and {kind:'stop'}.
export function officeState({now=()=>Date.now(),staleMs=STALE_MS,storage}={}){
  const reports=new Map(),actions=new Map(),waiters=new Set(),listeners=new Set();
  let closing=false;
  const emit=e=>{for(const f of listeners)try{Promise.resolve(f(e)).catch(()=>{})}catch{}};
  const recentSince=()=>now()-ACTION_KEEP_MS;
  const mine=(email,source)=>[...actions.values()].filter(a=>same(a.email,email)&&a.source===source&&!a.delivered&&Date.parse(a.at)>=recentSince());
  function claim(email,source){
    if(storage)return after(storage.claim(lc(email),source,now(),recentSince()),list=>list.map(outAction));
    return mine(email,source).map(a=>{a.delivered=true;return outAction(a)});
  }
  function finish(w,list,error){
    if(!waiters.delete(w))return;
    clearTimeout(w.timer);clearInterval(w.poll);
    if(error)w.reject(error);else w.resolve(list);
  }
  async function check(w){
    if(w.busy){w.again=true;return}
    w.busy=true;
    try{
      do{
        w.again=false;
        const list=await claim(w.email,w.source);
        if(list.length||closing||w.expired){finish(w,list);return}
      }while(w.again);
    }catch(e){finish(w,[],e)}
    finally{w.busy=false}
  }
  const wake=(email,source)=>{for(const w of waiters)if(same(w.email,email)&&w.source===source)void check(w)};
  function merge(email,r,reportedHere=false){
    const m=reports.get(email)||new Map(),old=m.get(r.source);
    if(old?.received>r.received)return false;
    m.set(r.source,{...r,reportedHere:reportedHere||old?.reportedHere});reports.set(email,m);
    return !old||r.received-old.received>staleMs||!isDeepStrictEqual(old.agents,r.agents);
  }
  async function refresh(emails){
    if(!storage)return;
    const changed=new Set();
    for(const {email,data} of await storage.reports(now()-staleMs,emails))if(merge(email,data))changed.add(email);
    for(const email of changed)emit({type:'agents',email});
  }
  function sweep(){
    const t=now();
    for(const [email,m] of reports){let changed=false;for(const [s,r] of m)if(t-r.received>staleMs){m.delete(s);changed=true}if(!m.size)reports.delete(email);if(changed)emit({type:'agents',email})}
    for(const [id,a] of actions)if(t-Date.parse(a.at)>ACTION_KEEP_MS)actions.delete(id);
  }
  const find=(email,source,id)=>{
    const r=reports.get(lc(email))?.get(source);
    return r&&now()-r.received<=staleMs?r.agents.find(a=>a.id===id):null;
  };
  const buckets=new Map();
  const take=(key,[burst,rate])=>{const t=now(),b=buckets.get(key)||{tokens:burst,at:t};b.tokens=Math.min(burst,b.tokens+(t-b.at)/1000*rate);b.at=t;buckets.set(key,b);
    if(buckets.size>20000)buckets.clear();if(b.tokens<1)return false;b.tokens-=1;return true};
  function queue(act){
    const sameAgent=x=>x.email===act.email&&x.source===act.source&&x.agentId===act.agentId;
    const conflict=x=>sameAgent(x)&&(act.kind==='stop'
      ?x.kind==='stop'&&!x.result&&now()-Date.parse(x.at)<60000
      :act.kind==='answer'&&x.requestId===act.requestId&&Date.parse(x.at)>=recentSince());
    const queued=storage?storage.queue(act,recentSince()):![...actions.values()].some(conflict);
    return after(queued,ok=>{
      if(!ok){
        if(act.kind==='stop')fail(409,'already_stopping','It is already being stopped');
        fail(409,'already_answered','That prompt was already answered');
      }
      if(!storage)actions.set(act.id,act);
      const action=outAction(act);
      emit({type:'action',email:act.email,action});wake(act.email,act.source);
      return action;
    });
  }
  return {
    on(f){listeners.add(f);return ()=>listeners.delete(f)},
    refresh,
    sweep,
    prune:()=>storage?.prune(now()-staleMs,recentSince()),
    // A reporter's PUT replaces that source's set, then claims any pending answers.
    report(email,input){
      const key=lc(email),r={...cleanReport(input),received:now()};
      return after(storage?storage.saveReport(key,r):true,saved=>{
        const old=reports.get(key)?.get(r.source);
        if(saved&&merge(key,r,true)){
          emit({type:'agents',email:key});
          // Starts waiting: was not waiting before, is new in a source that is reporting, or waits on a new prompt.
          // A source's first report (a reporter starting, back after going stale, or this server restarting) alerts nobody.
          if(old?.reportedHere&&r.received-old.received<=staleMs)for(const a of r.agents){
            if(a.status!=='waiting')continue;
            const was=old.agents.find(x=>x.id===a.id);
            if(!was||was.status!=='waiting'||(a.pending?.requestId&&a.pending.requestId!==was.pending?.requestId))emit({type:'waiting',email:key,agent:{...a,source:r.source}});
          }
        }
        return after(claim(key,r.source),actions=>({actions,accepted:r.agents.length}));
      });
    },
    live(email){
      const t=now(),m=reports.get(lc(email));if(!m)return [];
      return [...m.values()].filter(r=>t-r.received<=staleMs).sort((a,b)=>a.source.localeCompare(b.source)).flatMap(r=>r.agents.map(a=>({...a,source:r.source})));
    },
    reporters:()=>[...reports.keys()],
    sources(email){const t=now(),m=reports.get(lc(email));return m?[...m.values()].filter(r=>t-r.received<=staleMs).map(r=>({source:r.source,at:r.at,agents:r.agents.length})):[]},
    answer({by,owner,source,agentId,requestId,decision}){
      if(!same(by,owner))fail(403,'not_owner','Only the agent\'s owner can answer it');
      if(decision!=='allow'&&decision!=='deny')fail(400,'invalid_input','decision must be allow or deny');
      return after(storage&&refresh([lc(owner)]),()=>{
        const a=find(owner,source,agentId);
        if(!a)fail(404,'agent_not_found','That agent is not reporting any more');
        if(a.status!=='waiting'||!a.pending||a.pending.requestId!==requestId)fail(409,'not_waiting','It is not waiting on that request any more');
        if(!a.pending.can.includes(decision))fail(409,'cannot_answer','That prompt cannot be answered from Flow: answer it where the agent runs');
        return queue({id:'act_'+randomUUID(),email:lc(owner),source,agentId,kind:'answer',requestId,decision,at:new Date(now()).toISOString(),result:null});
      });
    },
    // A message (a new user turn) or a stop for a live agent: only its owner, only when its reporter lists that
    // kind in the agent's can, rate-limited per person and per agent. A stop waits for the last one to finish.
    steer({by,owner,source,agentId,kind,text}){
      if(!same(by,owner))fail(403,'not_owner','Only the agent\'s owner can steer it');
      if(!STEER_KINDS.includes(kind))fail(400,'invalid_input','kind must be answer, message or stop');
      let body='';
      if(kind==='message'){
        body=typeof text==='string'?text.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').trim():'';
        if(!body)fail(400,'invalid_input','Write a message first');
        if(body.length>MESSAGE_MAX)fail(400,'invalid_input',`A message can be up to ${MESSAGE_MAX} characters`);
      }
      return after(storage&&refresh([lc(owner)]),()=>{
        const a=find(owner,source,agentId);
        if(!a)fail(404,'agent_not_found','That agent is not reporting any more');
        if(!a.can?.includes(kind))fail(409,'cannot_steer',kind==='message'?'This agent cannot take messages from Flow: talk to it where it runs':'This agent cannot be stopped from Flow: stop it where it runs');
        if(!take(`${kind}\n${lc(owner)}\n${source}\n${agentId}`,STEER_LIMITS[kind])||!take('person\n'+lc(owner),STEER_LIMITS.person))
          fail(429,'rate_limited',kind==='message'?'Too many messages: wait a little before sending another':'Wait a little before stopping it again');
        return queue({id:'act_'+randomUUID(),email:lc(owner),source,agentId,kind,...kind==='message'?{text:body}:{},at:new Date(now()).toISOString(),delivered:false,result:null});
      });
    },
    wait(email,source,ms){
      if(closing)return Promise.resolve([]);
      if(ms<=0)return Promise.resolve(claim(email,source));
      return new Promise((resolve,reject)=>{
        const w={email:lc(email),source,resolve,reject};
        waiters.add(w);
        w.timer=setTimeout(()=>{w.expired=true;if(!w.busy)finish(w,[])},ms);
        // A long poll can be on the other instance during deploy overlap.
        if(storage?.shared)w.poll=setInterval(()=>{if(!w.busy)void check(w)},1000);
        void check(w);
      });
    },
    result(email,id,{ok,message}={}){
      const result={ok:!!ok,message:str(message,300),at:new Date(now()).toISOString()};
      const a=actions.get(id);
      return after(storage?storage.result(lc(email),id,result):a&&same(a.email,email)&&Object.assign(a,{result}),saved=>{
        if(!saved)fail(404,'action_not_found','No such action');
        const action=outAction(saved);emit({type:'result',email:saved.email,action});return action;
      });
    },
    recent(email){
      const list=storage?storage.actions(lc(email),recentSince()):[...actions.values()].filter(a=>same(a.email,email)&&Date.parse(a.at)>=recentSince());
      return after(list,rows=>rows.map(outAction));
    },
    close(){closing=true;for(const w of waiters)if(!w.busy)finish(w,[])},
  };
}
const outAction=a=>({id:a.id,agentId:a.agentId,source:a.source,kind:a.kind||'answer',...a.kind==='message'?{text:a.text}:a.kind==='stop'?{}:{requestId:a.requestId,decision:a.decision},at:a.at,...(a.result?{result:a.result}:{})});

// ---------- one agent for one viewer ----------
// owner: the viewer reported it (only the owner ever gets its transcript); full: the viewer may see its project. Otherwise only the mascot,
// vendor and status leave the server, under an opaque id (key(agent) -> stable per process).
// projects: the names of this environment's projects its repo belongs to that the viewer can see.
// seat: the AgentFlow agent (id) and card it works for, as this viewer may see them (lib/office-seats.mjs seatFor).
export function viewAgent(a,{owner=false,full=false,key=x=>x.id,projects=[],seat=null}={}){
  // activityKind (editing, testing…) says nothing about the work itself, so private agents keep it.
  if(!owner&&!full)return {id:key(a),vendor:a.vendor,status:a.status,activityKind:a.activityKind,private:true,children:a.children.map(c=>({vendor:c.vendor,status:c.status,activityKind:c.activityKind}))};
  const repo=a.repo?{name:normalizeRepo(a.repo.remote)?.name||normalizeRepo(a.repo.name)?.name||a.repo.name,slug:normalizeRepo(a.repo.remote)?.full||normalizeRepo(a.repo.name)?.full||''}:null;
  return {id:owner?a.id:key(a),...(owner?{source:a.source}:{}),title:a.title,vendor:a.vendor,model:a.model,status:a.status,activity:a.activity,activityKind:a.activityKind,host:a.host,hostLabel:a.hostLabel,repo,
    children:a.children.map(c=>({title:c.title,vendor:c.vendor,model:c.model,status:c.status,activityKind:c.activityKind})),
    pending:a.pending?{...(owner?{requestId:a.pending.requestId}:{}),kind:a.pending.kind,summary:a.pending.summary,can:owner?a.pending.can:[]}:null,
    can:owner?a.can||[]:[],
    projects,...(seat?{seat}:{}),...(owner&&a.transcript?{transcript:a.transcript}:{}),mine:owner,private:false};
}

// ---------- the live channel ----------
// context.env(envId)  -> {id, name, ownerEmail, members:[{email, name}], projects:[{id, name, repos}], agents:[AgentFlow agents
//                        with the card ids delegated to them; a human one with memberEmail when it is one of the members], cards:[DevOps cards: id, number, title, column, moved, project, due, snoozedUntil]}
// context.access(envId, user) -> {ok, all, projectIds:Set, cardIds?:Set} (all: every project of the environment is visible)
//                        Re-checked every heartbeat (and on recheck()): a client that lost access gets 'gone' and is closed.
// context.portals(envId, user) -> [{env, label, sub, own}] doors to other offices this viewer can enter (snapshot.portals;
//                        sent again as 'portals' when recheck({portals:true}) finds them changed).
// secret: keys members and agents (opaque, stable for as long as the secret is: the server keeps one on disk).
export function officeHub({state,context,now=()=>Date.now(),heartbeatMs=15e3,ttlMs=20e3,secret=randomBytes(16),storage,history,onError=()=>{}}){
  const clients=new Map(),presence=new Map(),chat=new Map(),cache=new Map(),limits=new Map(),statuses=new Map(),pending=new Set(),alerts=new Set();
  // Presence (Available, Focus, Do not disturb, Away) is per person, separate from the saved status line.
  const book=createPresenceBook({now}),who=new Map(),heldAlerts=new Map();
  const epoch=randomUUID();
  let sequence=0,restarting=false,closing=false,lastPrune=now();
  function saveStatus(envId,key,data){
    statuses.set(envId+'\n'+key,{...statuses.get(envId+'\n'+key),...data});
    if(!storage)return;
    const write=Promise.resolve().then(()=>storage.status(envId,key,data));
    pending.add(write);
    write.then(()=>pending.delete(write),()=>pending.delete(write));
    return write;
  }
  const hash=s=>createHmac('sha256',secret).update(s).digest('base64url').slice(0,12);
  const memberKey=email=>'m'+hash('member\n'+lc(email));
  const agentKey=(email,a)=>'a'+hash(`agent\n${lc(email)}\n${a.source}\n${a.id}`);
  const accessSig=a=>JSON.stringify([a.all,[...a.projectIds||[]],[...a.cardIds||[]],
    a.scopes?.map(s=>[s.id,[...s.nodeIds],[...s.cardIds]])]);
  const sigOf=ctx=>JSON.stringify([ctx.members.map(m=>[m.email,m.name,m.personIds]),ctx.projects.map(p=>[p.id,p.repos]),ctx.agents,(ctx.cards||[]).map(c=>[c.id,c.number,c.title,c.column,c.moved,c.project,c.snoozedUntil||''])]);
  async function env(envId,fresh=false){
    const c=cache.get(envId);if(c&&!fresh&&now()-c.at<ttlMs)return c.ctx;
    const ctx=await context.env(envId);cache.set(envId,{at:now(),ctx,sig:sigOf(ctx)});return ctx;
  }
  const send=(cl,type,data,{retry}={})=>{
    try{cl.res.write(`${retry?'retry: '+retry+'\n':''}id: ${epoch}:${++sequence}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`)}catch{}
  };
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
  const person=p=>({key:p.key,name:p.name,image:p.image,x:p.x,y:p.y,z:p.z,heading:p.heading,moving:p.moving,jump:p.jump,sprint:p.sprint,...(p.status?{status:p.status}:{})});
  function take(key,per){
    // A token bucket per key: per = [burst, refill per second].
    const t=now(),b=limits.get(key)||{tokens:per[0],at:t};b.tokens=Math.min(per[0],b.tokens+(t-b.at)/1000*per[1]);b.at=t;limits.set(key,b);
    if(limits.size>20000)limits.clear();
    if(b.tokens<1)return false;b.tokens-=1;return true;
  }
  const off=state.on(async e=>{
    // The owner's alert streams: which of their agents wait now, and each new wait (first: the rest awaits).
    if(e.type==='agents')for(const cl of alerts)if(same(cl.user.email,e.email))send(cl,'mine',{waiting:waitingOf(e.email)});
    if(e.type==='waiting'){
      // Do not disturb keeps the badge (the mine event) and holds the notification until they switch back.
      const quiet=book.isQuiet(e.email),view=alertView(e.agent);
      if(quiet){
        const id=lc(e.email),list=heldAlerts.get(id)||[];
        if(!list.some(a=>a.source===view.source&&a.id===view.id&&a.pending?.requestId===view.pending?.requestId))list.push(view);
        heldAlerts.set(id,list);
      }else for(const cl of alerts)if(same(cl.user.email,e.email))send(cl,'waiting',view);
    }
    if(e.type==='agents'){
      for(const set of clients.values())for(const cl of set)if(same(cl.user.email,e.email))send(cl,'yourSources',state.sources(e.email));
      await Promise.all([...clients.keys()].map(async envId=>{
        let ctx;try{ctx=await env(envId)}catch{return}
        if(!ctx.members.some(m=>same(m.email,e.email)))return;
        each(envId,cl=>send(cl,'agents',{member:memberKey(e.email),agents:agentsFor(cl,ctx,e.email)}));
      }));
    }
    if(e.type==='action'||e.type==='result')for(const set of clients.values())for(const cl of set)if(same(cl.user.email,e.email))send(cl,e.type,e.action);
    // Everyone in the owner's offices sees the agent react to an Allow / Deny (a nod, a shake, then working until
    // the result), under the id each viewer knows it by. Only the decision and whether it went through: never the prompt.
    if((e.type==='action'||e.type==='result')&&(e.action?.decision==='allow'||e.action?.decision==='deny')){
      const a=e.action,r={member:memberKey(e.email),decision:a.decision,phase:e.type==='action'?'answered':'result',...(e.type==='result'?{ok:!!a.result?.ok}:{})};
      await Promise.all([...clients.keys()].map(async envId=>{
        let ctx;try{ctx=await env(envId)}catch{return}
        if(!ctx.members.some(m=>same(m.email,e.email)))return;
        each(envId,cl=>send(cl,'reaction',{...r,agent:same(cl.user.email,e.email)?a.agentId:agentKey(e.email,{source:a.source,id:a.agentId})}));
      }));
    }
  });
  // What an alert says about one of your own agents (only ever sent to you).
  const alertView=a=>({id:a.id,source:a.source,title:a.title,vendor:a.vendor,activityKind:a.activityKind,host:a.hostLabel||a.host,
    pending:a.pending?{requestId:a.pending.requestId,kind:a.pending.kind,summary:a.pending.summary}:null});
  const waitingOf=email=>state.live(email).filter(a=>a.status==='waiting').map(alertView);
  // The common area: every AgentFlow agent for those who can read the environment; for a share's
  // recipient, only the agents linked to a project they can see.
  // Each with its desk: its queue and recently finished cards, the ones this viewer can see (lib/office-seats.mjs deskOf).
  // A human agent linked to a member (memberEmail, see context.env) carries that member's key instead: their avatar is that agent.
  const agentflowFor=(ctx,cl)=>{
    const ix=seatIndex(ctx);
    return ctx.agents.filter(a=>canSeeAgent(cl.access,a)).map(({cards=[],memberEmail,...a})=>({
      ...a,member:memberEmail?memberKey(memberEmail):'',desk:deskOf(ix,a.id,cl.access,now()),
      // The client joins these projections against its own workspace. Raw queue ids stay on the server.
      boardCards:(cl.access.scopes||[]).flatMap(s=>cards.filter(id=>s.cardIds.has(id)&&canSeeCard(cl.access,ix.cards.get(id)))
        .map(id=>`sh.${s.id}.${id}`)),
    }));
  };
  // lastSeen: when they last had this office open, or their last sign-in.
  const membersView=(ctx,cl)=>ctx.members.map(m=>{
    const key=memberKey(m.email),owner=same(m.email,ctx.ownerEmail),me=same(m.email,cl.user.email);
    const personIds=cl.access.scopes
      ?cl.access.scopes.flatMap(s=>(m.personIds||[]).filter(id=>s.nodeIds.has(id)).map(id=>`sh.${s.id}.${id}`))
      :m.personIds||[];
    const saved=statuses.get(ctx.id+'\n'+key);
    return {key,name:m.name,owner,me,personIds:[...new Set(personIds)],lastSeen:saved?.lastSeen||m.lastSeen||'',...(saved?.status?{status:saved.status}:{})};
  });
  // Members or projects' repos changed (a new share, a project's repos edited): new rooms, re-redacted agents.
  const push=(cl,ctx)=>{send(cl,'members',{members:membersView(ctx,cl),agentflow:agentflowFor(ctx,cl)});for(const m of ctx.members)send(cl,'agents',{member:memberKey(m.email),agents:agentsFor(cl,ctx,m.email)})};
  // Re-read an environment; when its members or repos changed, everyone in its office hears.
  // portals: also send each client its doors again (context.portals) when they changed, e.g. after a share changed.
  async function reread(envId,{portals=false}={}){
    const before=cache.get(envId)?.sig,ctx=await env(envId,true);
    const changed=before!==undefined&&before!==cache.get(envId).sig;
    await Promise.all([...(clients.get(envId)||[])].map(async cl=>{
      let accessChanged=false;
      if(context.access){
        const access=await context.access(envId,cl.user);
        // Access ended (a share revoked): the page hears why and does not reconnect.
        if(!access.ok){send(cl,'gone',{reason:'access'});cl.res.end();cl.bye?.();return}
        accessChanged=accessSig(access)!==accessSig(cl.access);
        cl.access=access;
      }
      if(changed||accessChanged)push(cl,ctx);
      if(portals&&context.portals){const list=await context.portals(envId,cl.user).catch(()=>null);if(list&&JSON.stringify(list)!==JSON.stringify(cl.portals)){cl.portals=list;send(cl,'portals',list)}}
    }));
    return ctx;
  }
  async function recheck(opts){for(const envId of [...clients.keys()])await reread(envId,opts).catch(()=>{})}
  // A heartbeat event (not just a comment) every heartbeatMs: proxies see traffic, and the page can tell a stalled stream.
  const beat=setInterval(()=>{
    state.sweep();
    for(const [envId,room] of presence)for(const p of room.values())if(p.x!==null)history?.()?.sample(envId,p);
    for(const set of clients.values())for(const cl of set)send(cl,'hb',{});
    for(const cl of alerts)send(cl,'hb',{});
    recheck().catch(onError);
    if(now()-lastPrune>=60000){lastPrune=now();Promise.resolve().then(()=>state.prune()).catch(onError)}
  },heartbeatMs);beat.unref?.();
  return {
    memberKey,agentKey,
    // GET /api/office/{env}/events: the caller already checked access (context.access).
    async connect(envId,user,access,req,res){
      const ctx=await reread(envId),key=memberKey(user.email);
      const [stored,actions,portals]=await Promise.all([
        storage?.room(envId),state.recent(user.email),context.portals?.(envId,user).catch(()=>[])??[],
        state.refresh(ctx.members.map(m=>lc(m.email))),
      ]);
      if(res.destroyed)return;
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
      const cl={user,key,access,res,portals};
      if(closing){if(restarting)send(cl,'restart',{}, {retry:500});res.end();return}
      res.write('retry: 500\n\n');
      const cursor=req.headers?.['last-event-id']||new URL(req.url||'/', 'http://localhost').searchParams.get('lastEventId')||'';
      const resumedHere=/^\d+$/.test(cursor.slice(epoch.length+1))&&cursor.startsWith(epoch+':');
      const set=clients.get(envId)||new Set();set.add(cl);clients.set(envId,set);
      const room=presence.get(envId)||new Map();presence.set(envId,room);
      for(const {member,data} of stored?.status||[]){
        const id=envId+'\n'+member;
        if(!statuses.has(id)||data.lastSeen>=statuses.get(id).lastSeen)statuses.set(id,data);
      }
      who.set(key,lc(user.email));
      const me=room.get(key)||{key,name:user.name||user.email.split('@')[0],image:typeof user.image==='string'&&user.image.length<=200000?user.image:'',x:null,y:0,z:null,heading:0,moving:false,jump:false,sprint:false,conns:0,
        status:statuses.get(envId+'\n'+key)?.status||''};
      me.conns++;room.set(key,me);
      const fresh=me.conns===1;
      const live={};for(const m of ctx.members)live[memberKey(m.email)]=agentsFor(cl,ctx,m.email);
      const localChat=chat.get(envId)||[];
      // Include lines written here while the database snapshot was being read.
      const lines=[...new Map([...(stored?.chat||[]),...localChat].map(line=>[line.id,line])).values()]
        .sort((a,b)=>a.at.localeCompare(b.at)).slice(-CHAT_KEEP);
      send(cl,'snapshot',{env:{id:ctx.id,name:ctx.name},me:{key,name:me.name,status:me.status},resumedHere,
        members:membersView(ctx,cl),
        agentflow:agentflowFor(ctx,cl),live,people:[...room.values()].filter(p=>p.x!==null).map(person),chat:lines,
        statuses:book.forSnapshot(ctx.members.map(m=>({key:memberKey(m.email),email:m.email}))),
        actions,yourSources:state.sources(user.email),portals});
      if(fresh){const view=book.view(user.email);each(envId,c=>{if(c!==cl)send(c,'status',{key,status:view.status,text:view.text})})}
      const bye=()=>{
        if(!set.delete(cl))return;if(!set.size)clients.delete(envId);
        if(--me.conns<=0){
          room.delete(key);history?.()?.leave(envId,key);const at=new Date(now()).toISOString();
          try{saveStatus(envId,key,{lastSeen:at})?.catch(onError)}catch(e){onError(e)}
          if(statuses.size>20000)statuses.clear();
          each(envId,c=>send(c,'leave',{key,at}));if(!room.size)presence.delete(envId);
        }
      };
      cl.bye=bye;req.on('close',bye);res.on('close',bye);res.on('error',bye);
      return cl;
    },
    // GET /api/office/alerts: one signed-in person's own agents, for alerts while the office is closed.
    // No environment: agents are per person. Sends mine {waiting:[…]} now and whenever it changes, and
    // waiting {agent} each time one of them starts waiting. Nobody else's agents, ever.
    alerts(user,req,res){
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
      const cl={user,res};
      if(closing){if(restarting)send(cl,'restart',{}, {retry:500});res.end();return}
      res.write('retry: 500\n\n');
      alerts.add(cl);
      send(cl,'mine',{waiting:waitingOf(user.email)});
      const bye=()=>alerts.delete(cl);req.on('close',bye);res.on('close',bye);res.on('error',bye);
      return cl;
    },
    move(envId,user,{x,y,z,heading,moving,jump,sprint,status}={}){
      const key=memberKey(user.email),p=presence.get(envId)?.get(key);if(!p)fail(409,'not_connected','Open the office first');
      if(!take('move\n'+key+'\n'+envId,[20,15]))fail(429,'rate_limited','Too many moves');
      const num=(v,lo,hi)=>Number.isFinite(v)?Math.max(lo,Math.min(hi,v)):null;
      const nx=num(x,-500,500),nz=num(z,-500,500);if(nx===null||nz===null)fail(400,'invalid_input','x and z must be numbers');
      const joined=p.x===null,updated=typeof status==='string'?str(status,80):p.status;
      const write=joined||updated!==p.status||p.statusWriteFailed?saveStatus(envId,key,{status:updated,lastSeen:new Date(now()).toISOString()}):undefined;
      p.statusWriteFailed=false;
      Object.assign(p,{x:nx,y:num(y,0,8)??0,z:nz,heading:num(heading,-1e3,1e3)??0,moving:!!moving,jump:jump===true,sprint:sprint===true,status:updated,at:now()});
      history?.()?.sample(envId,p);
      each(envId,c=>{if(c.key!==key)send(c,joined?'join':'move',person(p))});
      return after(write?.catch(e=>{p.statusWriteFailed=true;throw e}),()=>({ok:true}));
    },
    say(envId,user,text){
      const key=memberKey(user.email),t=str(text,SAY_MAX);if(!t)fail(400,'invalid_input','Say something');
      if(!presence.get(envId)?.get(key))fail(409,'not_connected','Open the office first');
      if(!take('say\n'+key,[5,1]))fail(429,'rate_limited','Slow down a little');
      const line={id:randomUUID(),key,name:presence.get(envId).get(key).name,text:t,at:new Date(now()).toISOString()};
      const lines=storage?.say(envId,line)??[...(chat.get(envId)||[]),line].slice(-CHAT_KEEP);
      return after(lines,log=>{history?.()?.marker(envId,'message',key);chat.set(envId,log);each(envId,c=>send(c,'say',line));return {ok:true}});
    },
    // Available, Focus, Do not disturb or Away, plus a note of at most 60 characters.
    // Kept per person for the life of this process, and sent to every office they have open.
    setStatus(envId,user,body){
      const key=memberKey(user.email),p=presence.get(envId)?.get(key);if(!p)fail(409,'not_connected','Open the office first');
      if(!take('status\n'+key,[30,5]))fail(429,'rate_limited','Slow down a little');
      who.set(key,lc(user.email));
      const {clean,leftDnd}=book.set(user.email,body);
      const event={key,status:clean.status,text:clean.text};
      for(const [id,room] of presence)if((room.get(key)?.conns||0)>0)each(id,c=>send(c,'status',event));
      let released=0;
      if(leftDnd){
        const queued=heldAlerts.get(lc(user.email))||[];
        heldAlerts.delete(lc(user.email));
        released=queued.length;
        for(const cl of alerts)if(same(cl.user.email,user.email))for(const a of queued)send(cl,'waiting',a);
      }
      return {ok:true,...event,released};
    },
    // Do not disturb. userId is an email or the office member key.
    isQuiet(userId){
      const id=String(userId??''),email=id.includes('@')?id:who.get(id);
      return email?book.isQuiet(email):false;
    },
    emote(envId,user,emote){
      const key=memberKey(user.email);if(!EMOTES.includes(emote))fail(400,'invalid_input','emote must be one of '+EMOTES.join(', '));
      if(!presence.get(envId)?.get(key))fail(409,'not_connected','Open the office first');
      if(!take('emote\n'+key,[6,2]))fail(429,'rate_limited','Slow down a little');
      history?.()?.marker(envId,'emote',key,emote);
      each(envId,c=>send(c,'emote',{key,emote,at:new Date(now()).toISOString()}));return {ok:true};
    },
    // The owner's live agents as reported: the agent the answer is for (source + id) must be theirs.
    // kind "message" or "stop" steers it (state.steer); "answer", or no kind, is Allow / Deny (state.answer).
    answer(envId,user,b){
      const kind=b?.kind===undefined?'answer':b.kind,base={by:user.email,owner:user.email,source:str(b?.source,60),agentId:str(b?.agentId,200)};
      if(kind==='answer')return state.answer({...base,requestId:str(b?.requestId,300),decision:b?.decision});
      return state.steer({...base,kind,text:b?.text});
    },
    recheck,
    clients:()=>[...clients.values()].reduce((n,s)=>n+s.size,0),
    alertClients:()=>alerts.size,
    close({restart=false}={}){
      closing=true;restarting=restart;clearInterval(beat);off();
      const streams=[...alerts];
      for(const set of clients.values())streams.push(...set);
      for(const cl of streams){
        if(restart)send(cl,'restart',{}, {retry:500});
        cl.res.end();cl.bye?.();
      }
    },
    flush:()=>Promise.allSettled([...pending]),

  };
}
