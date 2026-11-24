// The Flow app on iPhone and iPad (apps/ios): its own routes, push devices, the person's inbox and the
// pushes themselves. docs/ios-app.md.
//
// Device keys. The app signs in through the web session and makes itself an API key with the `device`
// scope (POST /api/keys, which only a signed-in person can call). /api/app/* takes only such keys, so an
// agent holding an ordinary key (MCP, CLI, the office bridge) can never answer an agent's permission
// prompt or read someone's inbox through it.
//
//   GET    /api/app/inbox                 -> {agents:[waiting agents], cards:[cards assigned to you], push:{enabled}}
//   POST   /api/app/agents/answer {source, agentId, requestId, decision:'allow'|'deny'}
//          or {source, agentId, kind:'message', text}                     -> {ok, action}
//   PUT    /api/app/devices {token, environment:'production'|'sandbox', bundle, prefs:{agents, cards}}
//   DELETE /api/app/devices {token}
//
// Pushes (only when lib/apns.mjs is configured): one of your agents starts waiting (unless Do not disturb is
// on); a card is assigned to you; a card assigned to you changes column. Never for a change you made.
// A device belongs to the key that registered it: once that key is revoked or expired, it gets nothing
// and is forgotten.
import {withoutPrivateRecords} from './workspace-privacy.mjs';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {validDeviceToken} from './apns.mjs';

export const DEVICE_SCOPE='device';
const lc=v=>String(v||'').trim().toLowerCase();
const COLUMN_NAMES={requests:'Requests',doing:'Doing',blocked:'Blocked',uat:'UAT',done:'Done',must:'Must Have',nice:'Nice to Have'};
const INBOX_ORDER=['uat','blocked','doing','requests','must','nice'];
const MAX_DEVICES=20,MAX_ENVS=25,MAX_CARDS=200,BUNDLE=/^[A-Za-z0-9.-]{1,155}$/;

// ---------- who is "me" in an environment's data ----------
// Person cards with my email or linked to my OneProfileID account, share members with my email (in a
// recipient's view their id is the owner's person card, sh.<share>.<id>), and the bare member id @email.
export function myAssigneeIds(db,{email,opidId}={}){
  const me=lc(email),ids=new Set(me?['@'+me]:[]);
  for(const c of Array.isArray(db?.charts)?db.charts:[])for(const n of Array.isArray(c?.nodes)?c.nodes:[]){
    if(n?.type!=='person')continue;
    if((me&&lc(n.email)===me)||(opidId&&n.opidUser===opidId))ids.add(n.id);
  }
  for(const s of Array.isArray(db?.shares)?db.shares:[])for(const m of Array.isArray(s?.members)?s.members:[])if(me&&lc(m?.email)===me&&typeof m.id==='string')ids.add(m.id);
  for(const m of Array.isArray(db?.shareMembers)?db.shareMembers:[])if(me&&lc(m?.email)===me&&typeof m.id==='string')ids.add(m.id);
  return ids;
}

// Cards assigned to me across environments ([{id, name, data}]): not done, the ones waiting on me first.
export function inboxCards(envs,who){
  const out=[];
  for(const e of envs){
    const db=e.data,ids=myAssigneeIds(db,who),projects=new Map((db?.projects||[]).map(p=>[p.id,p]));
    for(const c of Array.isArray(db?.devops?.cards)?db.devops.cards:[]){
      if(!c||c.column==='done'||!INBOX_ORDER.includes(c.column))continue;
      const roles=(c.assignees||[]).filter(a=>ids.has(a?.node)).map(a=>a.role||'developer');
      if(!roles.length)continue;
      const p=projects.get(c.project);
      out.push({env:e.id,envName:e.name,id:c.id,number:c.number??null,title:String(c.title||''),column:c.column,roles:[...new Set(roles)],
        project:p?{id:p.id,name:p.name,color:p.color||''}:null,due:c.due||'',updated:c.updated||null,snoozed:!!(c.snoozedUntil&&Date.parse(c.snoozedUntil)>Date.now())});
    }
  }
  return out.sort((a,b)=>INBOX_ORDER.indexOf(a.column)-INBOX_ORDER.indexOf(b.column)||String(b.updated||'').localeCompare(String(a.updated||''))).slice(0,MAX_CARDS);
}

// ---------- what changed for whom, from one save of an environment ----------
// -> [{to:{email}|{opidUser}, kind:'assigned'|'moved', card:{id, number, title, column}}]. Nothing for
// the person who saved (by), or for cards that are linked copies of someone else's (sh.<share>.<id>).
export function cardEvents(before,after,{by}={}){
  const cards=d=>Array.isArray(d?.devops?.cards)?d.devops.cards.filter(c=>c&&typeof c.id==='string'&&!c.id.startsWith('sh.')):[];
  if(!before||!after)return [];
  before=withoutPrivateRecords(before);
  after=withoutPrivateRecords(after);
  const people=new Map();
  for(const d of [before,after])for(const c of Array.isArray(d?.charts)?d.charts:[])for(const n of Array.isArray(c?.nodes)?c.nodes:[])
    if(n?.type==='person'&&(n.email||n.opidUser))people.set(n.id,n.email?{email:lc(n.email)}:{opidUser:n.opidUser});
  const who=node=>typeof node==='string'&&node.startsWith('@')?{email:lc(node.slice(1))}:people.get(node)||null;
  const old=new Map(cards(before).map(c=>[c.id,c])),self=lc(by),out=[];
  for(const c of cards(after)){
    const prev=old.get(c.id),card={id:c.id,number:c.number??null,title:String(c.title||'').slice(0,200),column:c.column};
    const had=new Set((prev?.assignees||[]).map(a=>a?.node)),seen=new Set();
    for(const a of c.assignees||[]){
      const to=who(a?.node),k=to&&(to.email||'opid:'+to.opidUser);
      if(!to||seen.has(k)||(to.email&&to.email===self))continue;
      seen.add(k);
      if(!had.has(a.node))out.push({to,kind:'assigned',card});
      else if(prev&&prev.column!==c.column)out.push({to,kind:'moved',card,from:prev.column});
    }
  }
  return out;
}

// ---------- the devices ----------
const SCHEMA=['create table if not exists flygon_flow_push_devices(token text primary key, owner_email text not null, key_id text not null, environment text not null, bundle text not null, prefs jsonb not null default \'{}\'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now())',
  'create index if not exists flygon_flow_push_devices_owner on flygon_flow_push_devices(lower(owner_email))'];
const migrated=new WeakSet();
const cleanPrefs=p=>({agents:p?.agents!==false,cards:p?.cards!==false});
export function pushDeviceStore({dir,db=async()=>null}){
  const file=join(dir,'_push-devices.json');
  const read=()=>{try{return JSON.parse(readFileSync(file,'utf8'))}catch{return []}};
  const write=v=>{mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(v,null,2));renameSync(file+'.tmp',file)};
  const pool=async()=>{const pg=await db();if(pg&&!migrated.has(pg)){for(const q of SCHEMA)await pg.query(q);migrated.add(pg)}return pg};
  const view=r=>r&&{token:r.token,owner:r.owner_email??r.owner,keyId:r.key_id??r.keyId,environment:r.environment,bundle:r.bundle,prefs:cleanPrefs(r.prefs),updatedAt:new Date(r.updated_at??r.updatedAt).toISOString()};
  return {
    async upsert({token,owner,keyId,environment,bundle,prefs}){
      const d={token,owner:lc(owner),keyId,environment:environment==='sandbox'?'sandbox':'production',bundle,prefs:cleanPrefs(prefs),updatedAt:new Date().toISOString()};
      const pg=await pool();
      if(pg){await pg.query(`insert into flygon_flow_push_devices(token,owner_email,key_id,environment,bundle,prefs) values($1,$2,$3,$4,$5,$6)
        on conflict (token) do update set owner_email=excluded.owner_email,key_id=excluded.key_id,environment=excluded.environment,bundle=excluded.bundle,prefs=excluded.prefs,updated_at=now()`,[d.token,d.owner,d.keyId,d.environment,d.bundle,JSON.stringify(d.prefs)]);return d}
      const list=read().filter(x=>x.token!==token);list.push(d);
      // Each person keeps their newest MAX_DEVICES.
      const mine=list.filter(x=>x.owner===d.owner).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(MAX_DEVICES).map(x=>x.token);
      write(list.filter(x=>!mine.includes(x.token)));return d;
    },
    async remove(token,owner){
      const pg=await pool();
      if(pg)return (await pg.query(`delete from flygon_flow_push_devices where token=$1${owner?' and lower(owner_email)=lower($2)':''}`,owner?[token,owner]:[token])).rowCount>0;
      const list=read(),next=list.filter(x=>!(x.token===token&&(!owner||x.owner===lc(owner))));
      if(next.length!==list.length)write(next);return next.length!==list.length;
    },
    async forOwner(email){
      const pg=await pool();
      if(pg)return (await pg.query('select * from flygon_flow_push_devices where lower(owner_email)=lower($1) order by updated_at desc limit $2',[email,MAX_DEVICES])).rows.map(view);
      return read().filter(x=>x.owner===lc(email)).map(view);
    },
  };
}

// ---------- the pushes ----------
// sender: lib/apns.mjs apnsSender (or null: pushes off). apiKeys: the key store (a device's key must still
// be active). emailOf(opidUser): the email of a OneProfileID account (for person cards linked by account).
// isQuiet(email): Do not disturb in the office. previews: false sends no card titles or prompt text.
export function pushHub({store,sender,apiKeys,emailOf=async()=>null,isQuiet=()=>false,previews=true,now=()=>Date.now()}){
  const live=k=>k&&!k.revokedAt&&!(k.expiresAt&&Date.parse(k.expiresAt)<=now())&&k.scopes?.includes(DEVICE_SCOPE);
  async function deliver(email,kind,payload,opts){
    if(!sender||!email)return 0;
    let sent=0;
    for(const d of await store.forOwner(email)){
      if(d.prefs[kind]===false||d.bundle!==sender.topic)continue;
      const k=await apiKeys.get(d.keyId).catch(()=>null);
      if(!live(k)||lc(k.owner)!==lc(email)){await store.remove(d.token).catch(()=>{});continue}
      const r=await sender.send(d,payload,opts).catch(()=>({ok:false,gone:false}));
      if(r.gone)await store.remove(d.token).catch(()=>{});
      if(r.ok)sent++;
    }
    return sent;
  }
  return {
    enabled:!!sender,
    // One of the person's agents started waiting (lib/office.mjs state event {type:'waiting', email, agent}).
    async agentWaiting(email,agent){
      if(!agent?.pending||isQuiet(email))return 0;
      const p=agent.pending,question=p.kind==='question',canAnswer=(p.can||[]).includes('allow')&&(p.can||[]).includes('deny');
      const name=String(agent.title||'An agent').slice(0,80);
      return deliver(email,'agents',{
        aps:{alert:{title:question?`${name} has a question`:`${name} is waiting for you`,body:previews?String(p.summary||'').slice(0,240)||'Open Flow to answer.':'Open Flow to answer.'},
          sound:'default','thread-id':'agents',category:question?'FLOW_AGENT_QUESTION':canAnswer?'FLOW_AGENT_APPROVAL':'FLOW_AGENT','interruption-level':'time-sensitive'},
        flow:{type:'agent',source:agent.source,agentId:agent.id,requestId:p.requestId,kind:p.kind}},
        {collapseId:`agent-${String(agent.id).slice(0,40)}`});
    },
    // A save of environment env ({id, name}) produced these cardEvents.
    async cards(env,events){
      let sent=0;
      for(const e of events){
        const email=e.to.email||await emailOf(e.to.opidUser).catch(()=>null);if(!email)continue;
        const n=e.card.number!=null?`#${e.card.number} `:'',title=previews?e.card.title:'a card';
        sent+=await deliver(email,'cards',{
          aps:{alert:{title:e.kind==='assigned'?'Assigned to you':`Moved to ${COLUMN_NAMES[e.card.column]||e.card.column}`,body:`${n}${title}`.trim(),...(env.name?{subtitle:String(env.name).slice(0,80)}:{})},
            sound:'default','thread-id':`env-${env.id}`,category:'FLOW_CARD'},
          flow:{type:'card',env:env.id,card:e.card.id,number:e.card.number}},
          {collapseId:`card-${e.card.id}`.slice(0,64)});
      }
      return sent;
    },
  };
}

// ---------- the routes ----------
// authenticate(req) -> lib/apikeys.mjs authenticateApiKey result or null. readJson(req,res,fn).
// envsFor(user, key) -> [{id, name, data}] the person's environments as the API sees them (linked records
// included). opidIdOf(email). office: {waitingOf(email), answer(user, body), refresh(emails)}.
export function appRoutes({authenticate,readJson,json,envsFor,opidIdOf=async()=>'',office,store,hub}){
  return async function appApi(req,res){
    const url=req.url.split('?')[0];
    if(!url.startsWith('/api/app/'))return false;
    res.setHeader('Cache-Control','no-store');
    const a=await authenticate(req).catch(()=>null);
    if(a?.limited){res.setHeader('Retry-After',String(a.retryAfter||1));json(res,429,{error:'Too many requests',code:'rate_limited'});return true}
    if(!a?.user){json(res,401,{error:'Sign in to the Flow app again',code:'unauthorized'});return true}
    if(!a.scopes?.includes(DEVICE_SCOPE)){json(res,403,{error:'Only the Flow app\'s own sign-in can use this. Sign in to the app again.',code:'device_key_required'});return true}
    const email=lc(a.user.email),user={email,name:a.user.name||email};
    try{
      if(url==='/api/app/inbox'&&req.method==='GET'){
        await office.refresh([email]).catch(()=>{});
        const [envs,opidId]=await Promise.all([envsFor(user,a),opidIdOf(email).catch(()=>'')]);
        json(res,200,{agents:office.waitingOf(email),cards:inboxCards(envs.slice(0,MAX_ENVS),{email,opidId}),push:{enabled:hub.enabled}});return true;
      }
      if(url==='/api/app/agents/answer'&&req.method==='POST'){
        readJson(req,res,async b=>{
          try{json(res,200,{ok:true,action:await office.answer(user,b||{})})}
          catch(e){const s=Number.isInteger(e?.status)?e.status:500;json(res,s,{error:s===500?'Something went wrong':e.message,code:e.code||'internal'})}
        });
        return true;
      }
      if(url==='/api/app/devices'&&(req.method==='PUT'||req.method==='DELETE')){
        readJson(req,res,async b=>{
          try{
            if(!validDeviceToken(b?.token))return json(res,400,{error:'token: the APNs device token (hex)',code:'invalid_input'});
            if(req.method==='DELETE')return json(res,200,{removed:await store.remove(b.token,email)});
            if(!BUNDLE.test(String(b?.bundle||'')))return json(res,400,{error:'bundle: the app\'s bundle id',code:'invalid_input'});
            const d=await store.upsert({token:b.token,owner:email,keyId:a.keyId,environment:b.environment,bundle:b.bundle,prefs:b.prefs});
            json(res,200,{device:{environment:d.environment,prefs:d.prefs},push:{enabled:hub.enabled}});
          }catch{json(res,500,{error:'Could not save this device',code:'internal'})}
        });
        return true;
      }
      json(res,404,{error:'No such endpoint',code:'not_found'});
    }catch(e){console.error('app api:',e?.message);if(!res.headersSent)json(res,500,{error:'Something went wrong',code:'internal'})}
    return true;
  };
}
