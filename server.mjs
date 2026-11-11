import http from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,copyFileSync,readdirSync,unlinkSync,statSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {resolve,extname,sep,join} from 'node:path';
const root=fileURLToPath(new URL('./public/',import.meta.url));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json','.txt':'text/plain','.md':'text/markdown'};
// Storage: BACKUP_DIR, SAVES_DIR and INBOX_DIR (e.g. a Railway volume at /data/backups, /data/saves,
// /data/inbox). Without INBOX_DIR the inbox sits beside BACKUP_DIR when that is set.
const backupRoot=process.env.BACKUP_DIR?pathToFileURL(process.env.BACKUP_DIR.replace(/[\/]?$/,'/')):new URL('./data/',import.meta.url);
// .env holds DATABASE_URL for cloud saves (Railway › flygonlc › Form Storage). It is never committed.
try{process.loadEnvFile(fileURLToPath(new URL('./.env',import.meta.url)))}catch{}
const VERIFY=!!process.env.ORG_CHART_VERIFY;
const savesRoot=process.env.SAVES_DIR||fileURLToPath(new URL('./saves/',import.meta.url));
const KEEP_LOCAL=200;

const validDb=d=>Array.isArray(d?.charts)&&d.charts.length&&d.charts.some(c=>c.id===d.active)&&d.charts.every(c=>typeof c.name==='string'&&Array.isArray(c.nodes)&&Array.isArray(c.edges));
const json=(res,code,body)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body))};
function readBody(req,res,done){
  let body='',bytes=0;
  req.on('data',chunk=>{bytes+=chunk.length;if(bytes>5000000){res.writeHead(413);res.end();req.destroy();return;}body+=chunk;});
  req.on('end',()=>{if(!res.writableEnded)done(body)});
}
// Sign-in (OneProfileID when OPID_* is set, otherwise local single-user mode) and environments.
// Imported after .env is loaded so OPID_* values there are seen.
const auth=await import('./lib/auth.mjs');
const {registry,canRead,canWrite,DEFAULT_ENV}=await import('./lib/environments.mjs');
const envs=registry(fileURLToPath(backupRoot));
const {workspaceStore,SCHEMA:WORKSPACE_SCHEMA}=await import('./lib/workspaces.mjs');
const {sessionStore,SCHEMA:SESSION_SCHEMA}=await import('./lib/sessions.mjs');
const {inviteStore,validEmail,SCHEMA:INVITE_SCHEMA}=await import('./lib/invites.mjs');
const {createMailer,rateLimit,inviteEmail}=await import('./lib/mailer.mjs');
// Sharing (docs/sharing.md): the rules are pure (sharing-core), the store keeps shares, requests and placements.
const {shareStore,SCHEMA:SHARE_SCHEMA}=await import('./lib/shares.mjs');
const core=await import('./lib/sharing-core.mjs');
// Sign-in sessions survive deploys when Postgres is configured (memory otherwise).
auth.useSessionStore(sessionStore({db:()=>cloud(),max:auth.SESSION_MAX}));
const {shrinks,size,keepCounters}=await import('./public/sync-core.js');
const {carryRunners}=await import('./public/agentflow-core.js');
const readJson=(req,res,done)=>{if(!String(req.headers['content-type']||'').startsWith('application/json')){json(res,415,{error:'Expected JSON'});return}readBody(req,res,b=>{let v;try{v=JSON.parse(b)}catch{json(res,400,{error:'Invalid JSON'});return}done(v)})};
const appHost=auth.appOrigin?new URL(auth.appOrigin).host:'';

// Only the page served from this machine (or the configured app origin) may call the API:
// blocks cross-site requests and DNS rebinding.
function trusted(req){
  const host=req.headers.host||'',o=req.headers.origin;
  if(/^(127\.0\.0\.1|localhost):\d+$/.test(host))return !o||o===`http://${host}`;
  return !!appHost&&host===appHost&&(!o||o===auth.appOrigin);
}
// Signed-in user for an API request, or a 401 response (null).
async function requireUser(req,res){
  const user=await auth.userFor(req);
  if(!user)json(res,401,{error:'Sign in to continue'});
  return user;
}
// 404 for environments the user may not see; 403 for visible ones they may not change.
const denied=(res,e,user)=>canRead(e,user)?json(res,403,{error:'This environment is read-only for you'}):json(res,404,{error:'Not found'});

async function backup(req,res){
  const match=/^\/api\/backups\/([a-zA-Z0-9-]{1,64})$/.exec(req.url);
  if(!match)return false;
  if(req.method!=='PUT'||req.headers['content-type']!=='application/json'||!trusted(req)){res.writeHead(403);res.end();return true;}
  const user=await requireUser(req,res);if(!user)return true;
  readBody(req,res,body=>{try{
    let data=JSON.parse(body);
    if(!validDb(data))throw Error('Invalid chart database');
    const e=envs.of(data);if(!canWrite(e,user)){denied(res,e,user);return}
    stamp(data,envs.claim(data,user));data=stripLinked(data);
    mkdirSync(backupRoot,{recursive:true});
    const file=new URL(`${match[1]}.json`,backupRoot),temp=new URL(`${match[1]}.tmp`,backupRoot);
    writeFileSync(temp,JSON.stringify(data,null,2));
    if(existsSync(file))copyFileSync(file,new URL(`${match[1]}.previous.json`,backupRoot));
    renameSync(temp,file);json(res,200,{saved:true});
  }catch{res.writeHead(400);res.end('Unable to save backup');}});
  return true;
}

// ---------- saves: explicit snapshots, kept locally in saves/ and in the cloud (Postgres) ----------
// The table keeps its pre-rename name (org_chart_studio_saves) so existing cloud saves stay listed.
// Environment columns are additive and nullable: rows saved before them belong to Default workspace.
// These statements are idempotent and run once per server start, on first cloud use.
let pool=null;
async function cloud(){
  // verify.mjs never touches a real database; its Postgres tests opt in with a throwaway instance.
  if(!process.env.DATABASE_URL||(VERIFY&&!process.env.FLOW_ALLOW_DB_IN_VERIFY))return null;
  if(!pool){
    const {default:pg}=await import('pg');
    // DATABASE_SSL=no-verify for hosted Postgres behind a TLS proxy (e.g. Railway's public URL); sslmode in the URL also works.
    const ssl=process.env.DATABASE_SSL==='no-verify'?{rejectUnauthorized:false}:process.env.DATABASE_SSL==='1'?true:undefined;
    const p=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:8000,idleTimeoutMillis:30000,...(ssl?{ssl}:{})});
    p.on('error',()=>{});
    try{
      await p.query(`create table if not exists org_chart_studio_saves(id uuid primary key,saved_at timestamptz not null default now(),label text not null,charts int not null,items int not null,data jsonb not null)`);
      await p.query(`alter table org_chart_studio_saves add column if not exists env_id text, add column if not exists env_owner text, add column if not exists env_visibility text`);
      for(const q of [...WORKSPACE_SCHEMA,...SESSION_SCHEMA,...INVITE_SCHEMA,...SHARE_SCHEMA,...APIKEY_SCHEMA])await p.query(q);
      await p.query(`create table if not exists flygon_flow_prefs(user_id text primary key,email text,data jsonb not null,updated_at timestamptz not null default now())`);
      await p.query(`create table if not exists flygon_flow_environments(id text primary key,name text not null,owner_email text not null,visibility text not null default 'private',members jsonb not null default '[]',created_at timestamptz not null default now())`);
    }catch(e){p.end().catch(()=>{});throw e}
    pool=p;
  }
  return pool;
}
const summary=d=>({charts:d.charts.length,items:Array.isArray(d.timeline)?d.timeline.length:0});
function localList(){
  try{return readdirSync(savesRoot).filter(f=>f.endsWith('.json')).map(f=>{try{const s=JSON.parse(readFileSync(savesRoot+'/'+f,'utf8'));return s?.id?{id:s.id,at:s.at,label:s.label,charts:s.charts,items:s.items,env:envs.of(s.data)}:null}catch{return null}}).filter(Boolean)}
  catch{return []}
}
function writeLocal(s){
  mkdirSync(savesRoot,{recursive:true});
  writeFileSync(`${savesRoot}/${s.at.replace(/[:.]/g,'-')}_${s.id}.json`,JSON.stringify(s));
  const files=readdirSync(savesRoot).filter(f=>f.endsWith('.json')).sort();
  for(const f of files.slice(0,Math.max(0,files.length-KEEP_LOCAL)))unlinkSync(savesRoot+'/'+f);
}
const cloudError=e=>String(e?.message||e).replace(/postgres(ql)?:\/\/\S+/gi,'[database]').slice(0,200);
const rowEnv=r=>envs.get(r.env_id||DEFAULT_ENV.id)||{id:r.env_id,name:'Workspace',ownerEmail:r.env_owner||'',visibility:r.env_visibility==='public'?'public':'private',members:[]};
const envInfo=e=>({id:e.id,name:e.name,visibility:e.visibility,owner:e.ownerEmail});
// Stored payloads record their owner even when the browser had not filled it in yet.
function stamp(data,e){if(data.environment&&!data.environment.ownerEmail)data.environment.ownerEmail=e.ownerEmail}

async function saves(req,res){
  const url=req.url.split('?')[0];
  if(!url.startsWith('/api/saves'))return false;
  if(!trusted(req)){res.writeHead(403);res.end();return true;}
  const user=await requireUser(req,res);if(!user)return true;
  try{
    if(req.method==='GET'&&url==='/api/saves'){
      const local=localList().filter(s=>canRead(s.env,user)),byId=new Map(local.map(s=>[s.id,{...s,env:envInfo(s.env),local:true,cloud:false}]));
      let status='off';
      try{const db=await cloud();if(db){status='ok';
        for(const r of (await db.query('select id,saved_at,label,charts,items,env_id,env_owner,env_visibility from org_chart_studio_saves order by saved_at desc limit 200')).rows){
          const e=rowEnv(r);if(!canRead(e,user))continue;
          const s=byId.get(r.id)||{id:r.id,at:r.saved_at.toISOString(),label:r.label,charts:r.charts,items:r.items,env:envInfo(e),local:false};s.cloud=true;byId.set(r.id,s);
        }}}catch(e){status='error: '+cloudError(e)}
      json(res,200,{cloud:status,user:{email:user.email},saves:[...byId.values()].sort((a,b)=>b.at.localeCompare(a.at))});return true;
    }
    if(req.method==='POST'&&url==='/api/saves'){
      if(req.headers['content-type']!=='application/json'){res.writeHead(403);res.end();return true;}
      readBody(req,res,async body=>{
        let data;try{data=JSON.parse(body)}catch{}
        if(!validDb(data)){json(res,400,{error:'Invalid chart database'});return}
        const e0=envs.of(data);if(!canWrite(e0,user)){denied(res,e0,user);return}
        const e=envs.claim(data,user);stamp(data,e);data=stripLinked(data);
        const n=summary(data),s={id:randomUUID(),at:new Date().toISOString(),label:data.charts.map(c=>c.name).join(', ').slice(0,200),...n,data};
        let local=false,cloudOk=false,error='';
        try{writeLocal(s);local=true}catch(err){error='Local save failed'}
        try{const db=await cloud();if(db){
          await db.query('insert into flygon_flow_environments(id,name,owner_email,visibility,members) values($1,$2,$3,$4,$5) on conflict (id) do update set name=excluded.name,visibility=excluded.visibility',[e.id,e.name,e.ownerEmail,e.visibility,JSON.stringify(e.members)]);
          await db.query('insert into org_chart_studio_saves(id,saved_at,label,charts,items,data,env_id,env_owner,env_visibility) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[s.id,s.at,s.label,n.charts,n.items,data,e.id,e.ownerEmail,e.visibility]);cloudOk=true}else if(!VERIFY)error||='Cloud not configured'}
        catch(err){error||='Cloud save failed: '+cloudError(err)}
        json(res,local||cloudOk?200:500,{id:s.id,at:s.at,local,cloud:cloudOk,env:envInfo(e),error});
      });
      return true;
    }
    const m=/^\/api\/saves\/([0-9a-f-]{36})$/.exec(url);
    if(req.method==='GET'&&m){
      const f=existsSync(savesRoot)&&readdirSync(savesRoot).find(f=>f.endsWith(`_${m[1]}.json`));
      if(f){const data=JSON.parse(readFileSync(savesRoot+'/'+f,'utf8')).data;if(!canRead(envs.of(data),user)){json(res,404,{error:'Save not found'});return true}json(res,200,{data});return true}
      const db=await cloud(),r=db&&(await db.query('select data,env_id,env_owner,env_visibility from org_chart_studio_saves where id=$1',[m[1]])).rows[0];
      if(r&&canRead(rowEnv(r),user))json(res,200,{data:r.data});else json(res,404,{error:'Save not found'});
      return true;
    }
    res.writeHead(404);res.end();return true;
  }catch(e){json(res,500,{error:cloudError(e)});return true}
}

// ---------- agent inbox: patches agents drop in inbox/ (see tools/inbox.mjs and README) ----------
// GET lists pending patches for environments the user may write; POST /:id/ack claims one by moving
// it to inbox/applied/ (atomic rename, so only one browser or tab applies it). Nothing is deleted.
const {validatePatch}=await import('./public/inbox-core.js');
const inboxRoot=process.env.INBOX_DIR||(process.env.BACKUP_DIR?resolve(process.env.BACKUP_DIR,'..','inbox'):fileURLToPath(new URL('./inbox/',import.meta.url)));
const appliedRoot=join(inboxRoot,'applied');
function pendingPatches(){
  try{return readdirSync(inboxRoot).filter(f=>f.endsWith('.json')).map(f=>{try{const p=JSON.parse(readFileSync(join(inboxRoot,f),'utf8'));return !validatePatch(p).length&&f===p.id+'.json'?p:null}catch{return null}}).filter(Boolean)}
  catch{return []}
}
async function inbox(req,res){
  const url=req.url.split('?')[0];
  if(!url.startsWith('/api/inbox'))return false;
  if(!trusted(req)){res.writeHead(403);res.end();return true}
  const user=await requireUser(req,res);if(!user)return true;
  const writable=p=>canWrite(envs.get(p.env||DEFAULT_ENV.id),user)&&(p.env===undefined||envs.get(p.env)?.id===p.env);
  if(req.method==='GET'&&url==='/api/inbox'){
    json(res,200,{patches:pendingPatches().filter(writable).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))});return true;
  }
  const m=/^\/api\/inbox\/([A-Za-z0-9_-]{1,80})\/ack$/.exec(url);
  if(req.method==='POST'&&m){
    const file=join(inboxRoot,m[1]+'.json');
    let p;try{p=JSON.parse(readFileSync(file,'utf8'))}catch{json(res,409,{error:'Already applied or not found'});return true}
    if(!writable(p)){json(res,404,{error:'Not found'});return true}
    try{mkdirSync(appliedRoot,{recursive:true});renameSync(file,join(appliedRoot,m[1]+'.json'))}catch{json(res,409,{error:'Already applied'});return true}
    try{writeFileSync(join(appliedRoot,m[1]+'.json'),JSON.stringify({...p,appliedAt:new Date().toISOString(),appliedBy:user.email},null,2))}catch{}
    json(res,200,{claimed:true});return true;
  }
  res.writeHead(404);res.end();return true;
}

// ---------- workspaces: the server is the source of truth (GET/PUT /api/workspace) ----------
// GET  /api/workspace[?env=<id>][&since=<rev>]  -> {env, rev, data, updatedAt} (rev 0 / data null: nothing yet)
// PUT  /api/workspace?env=<id>  {baseRev, data[, allowShrink]} -> {rev} | 409 {rev, data} | 422 shrink
// Auth: the signed-in user, or `Authorization: Bearer <FLOW_SYNC_TOKEN>` acting as the owner
// (OWNER_EMAIL) for imports and for a local app syncing to production.
// With FLOW_SYNC_URL + FLOW_SYNC_TOKEN set (e.g. Owner's local app), these calls are relayed to that
// server; the local file copy is the offline fallback.
const workspaces=workspaceStore({dir:fileURLToPath(backupRoot),db:()=>cloud().catch(()=>null)});
const invites=inviteStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
auth.useInvites(invites);
const shares=shareStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
// ---- sharing in workspaces ----
// Linked copies (ids sh.<shareId>.<owner id>) are never stored in the recipient's workspace: they are
// projected from the owner's current data on every read, for the recipient only. What is stored is the
// recipient's own data, plus their private edges to linked cards (just ids).
const isLinked=id=>typeof id==='string'&&id.startsWith('sh.');
function stripLinked(d){
  if(!d||typeof d!=='object')return d;
  const out={...d,charts:(d.charts||[]).map(c=>({...c,nodes:(c.nodes||[]).filter(n=>!isLinked(n.id)),edges:(c.edges||[]).filter(e=>!isLinked(e.id))}))};
  delete out.shares;
  if(Array.isArray(d.projects))out.projects=d.projects.filter(x=>!isLinked(x?.id));
  if(Array.isArray(d.timeline))out.timeline=d.timeline.filter(x=>!isLinked(x?.id));
  if(d.devops&&typeof d.devops==='object')out.devops={...d.devops,cards:(d.devops.cards||[]).filter(x=>!isLinked(x?.id)),labels:(d.devops.labels||[]).filter(x=>!isLinked(x?.id))};
  return out;
}
// Edges that point at a linked card that is not there (share revoked, detached, or a reader who is not
// the recipient) are left out of what is served.
function dropDangling(d){
  if(!d?.charts)return d;
  for(const c of d.charts){const ids=new Set(c.nodes.map(n=>n.id));c.edges=c.edges.filter(e=>ids.has(e.from)&&ids.has(e.to))}
  if(d.charts.length&&!d.charts.some(c=>c.id===d.active))d.active=d.charts[0].id;
  return d;
}
// Active shares placed in one of the user's own environments, with their owner's workspace.
async function attachedShares(envId,user){
  const out=[];
  for(const sid of await shares.attachedTo(envId)){
    const s=await shares.get(sid);if(!s||s.revokedAt||!sameEmail(s.recipientEmail,user.email))continue;
    const home=await workspaces.get(s.ownerEnv);if(!home?.data||home.archivedAt)continue;
    out.push({share:s,home});
  }
  return out;
}
// The workspace as its owner sees it: their own data plus the linked copies of shares placed in it.
// shared: a signature of those shares (ids, permissions and the owners' revisions), so a client polling
// with ?since=<rev> still hears about the owner's edits.
async function withShares(envId,user,data){
  if(!data)return {data,shared:''};
  // Sharing must never break reading one's own workspace: on any failure, serve it without linked copies.
  try{return await project(envId,user,data)}catch(e){console.error('share projection failed',e?.message);return {data:dropDangling(structuredClone(stripLinked(data))),shared:''}}
}
async function project(envId,user,data){
  let d=structuredClone(stripLinked(data));const sig=[],meta=[];
  for(const {share:s,home} of user.token?[]:await attachedShares(envId,user)){
    d=core.applyProjection(d,core.projectForRecipient(home.data,s,await shares.placements(s.id,envId)));
    sig.push(`${s.id}:${s.permission}:${home.rev}`);
    meta.push({id:s.id,permission:s.permission,ownerEmail:s.ownerEmail,ownerEnv:s.ownerEnv,ownerEnvName:home.name||home.data.environment?.name||'',name:s.name});
  }
  for(const sid of core.linkedShareIds(d))if(!meta.some(m=>m.id===sid)){
    d=core.revokeEffects(d,{id:sid}).db;
    // The share's chart stays when the user put their own cards in it; it no longer names the owner.
    for(const c of d.charts)if(c.id===core.shareChartId(sid)&&c.name.startsWith('Shared · '))c.name='Formerly shared';
  }
  d=dropDangling(d);if(meta.length)d.shares=meta;
  return {data:d,shared:sig.join(',')};
}
// A recipient saved their workspace: layout of linked cards becomes placements, and field edits their
// share permits go to the owner's workspace (with history). Anything else is dropped (it comes back on
// the next read).
async function applyRecipientSave(envId,user,data){
  for(const {share:s} of await attachedShares(envId,user)){
    for(let attempt=0;attempt<3;attempt++){
      const home=await workspaces.get(s.ownerEnv);if(!home?.data)break;
      const p=core.projectForRecipient(home.data,s,await shares.placements(s.id,envId));
      const {placements,edits}=core.extractRecipientChanges(p,data);
      if(attempt===0)await shares.place(s.id,envId,placements);
      const patch=[],hist=[];
      for(const e of edits){const r=core.applyRecipientEdit(home.data,s,e,user);if(r.ok){patch.push(...r.ownerDbPatch);hist.push(...r.history)}}
      if(!patch.length)break;
      const out=await workspaces.put(s.ownerEnv,{baseRev:home.rev,data:core.applyOwnerPatch(home.data,patch),by:user.email,owner:home.owner,visibility:home.visibility,name:home.name});
      if(out.conflict)continue;
      await shares.record(hist);break;
    }
  }
}
// A new, empty workspace (one blank chart) for an environment.
const emptyWorkspace=(id,name,owner)=>({active:'chart-'+id,charts:[{id:'chart-'+id,name:'Untitled chart',nodes:[],edges:[]}],projects:[],timeline:[],environment:{id,name,ownerEmail:owner,visibility:'private',members:[]}});
async function createEnvironment(user,name){
  const id=randomUUID();name=String(name||'My workspace').trim().slice(0,80)||'My workspace';
  await workspaces.put(id,{baseRev:0,data:emptyWorkspace(id,name,user.email),by:user.email,owner:user.email,name});
  envs.claim({environment:{id,name,visibility:'private'}},user);
  return id;
}
const ENV_ID=/^[A-Za-z0-9-]{1,64}$/;
// Under verify.mjs a relay may only point at a loopback test server, never at production
// (a developer's .env can hold the real FLOW_SYNC_URL).
const SYNC_URL=(u=>VERIFY&&u&&!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u)?'':u)((process.env.FLOW_SYNC_URL||'').replace(/\/+$/,'')),SYNC_TOKEN=process.env.FLOW_SYNC_TOKEN||'';
const SYNC_HOST=SYNC_URL?(()=>{try{return new URL(SYNC_URL).host}catch{return SYNC_URL}})():'';
function tokenUser(req){
  const m=/^Bearer\s+(\S+)$/.exec(req.headers.authorization||''),t=SYNC_TOKEN;
  if(!m||!t||t.length<32)return null;
  const a=Buffer.from(m[1]),b=Buffer.from(t);
  return a.length===b.length&&timingSafeEqual(a,b)?{id:'owner-token',email:auth.OWNER_EMAIL,name:'Owner (token)',token:true}:null;
}
const ownerOf=(w,envId)=>w?.owner||envs.get(envId)?.ownerEmail||'';
const sameEmail=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
async function relay(req,body){
  const u=new URL(req.url,'http://x');
  try{
    const r=await fetch(SYNC_URL+u.pathname+u.search,{method:req.method,headers:{authorization:'Bearer '+SYNC_TOKEN,...(body?{'content-type':'application/json'}:{})},body,signal:AbortSignal.timeout(15000)});
    return {status:r.status,data:await r.json().catch(()=>({}))};
  }catch{return null}
}
async function workspace(req,res){
  const u=new URL(req.url,'http://x');
  if(u.pathname!=='/api/workspace')return false;
  const tok=tokenUser(req);
  // A token that does not match is refused outright (no fallback to the browser session).
  if(!tok&&req.headers.authorization){json(res,401,{error:'Invalid token'});return true}
  if(!tok&&!trusted(req)){res.writeHead(403);res.end();return true}
  const user=tok||await requireUser(req,res);if(!user)return true;
  const local=!tok&&SYNC_URL&&SYNC_TOKEN&&auth.mode==='local';
  if(req.method==='GET'){
    if(local){
      const r=await relay(req);
      if(r&&r.status===200&&r.data?.env&&r.data.data){await workspaces.put(r.data.env,{baseRev:(await workspaces.get(r.data.env))?.rev||0,data:r.data.data,by:'relay',owner:user.email}).catch(()=>{})}
      if(r){json(res,r.status,{...r.data,relayed:true,via:SYNC_HOST});return true}
      const w=await workspaces.get(u.searchParams.get('env')||DEFAULT_ENV.id);
      json(res,200,{env:w?.envId||u.searchParams.get('env')||DEFAULT_ENV.id,rev:0,data:w?.data||null,offline:true});return true;
    }
    let envId=u.searchParams.get('env');
    if(envId&&!ENV_ID.test(envId)){json(res,400,{error:'Bad environment id'});return true}
    let w=envId?await workspaces.get(envId):null;
    // No environment named: the owner's is Default workspace (even before it has data); others get their newest.
    if(!envId){const owner=sameEmail(user.email,auth.OWNER_EMAIL);w=owner?await workspaces.get(DEFAULT_ENV.id):null;w||=await workspaces.ownedBy(user.email);envId=w?.envId||(owner?DEFAULT_ENV.id:null)}
    // Someone signed in for the first time (an invited person): their own new, empty environment.
    if(!envId&&!user.token){envId=await createEnvironment(user,'My workspace');w=await workspaces.get(envId)}
    if(!envId){json(res,200,{env:null,rev:0,data:null});return true}
    if(w?.archivedAt){json(res,404,{error:'Not found'});return true}
    const e={...(envs.get(envId)||{id:envId,ownerEmail:'',visibility:'private',members:[],unregistered:!w}),...(w?{ownerEmail:w.owner,visibility:w.visibility}:{})};
    if(!canRead(e,user)&&!(e.unregistered&&!w)){json(res,404,{error:'Not found'});return true}
    const since=parseInt(u.searchParams.get('since')),mine=sameEmail(ownerOf(w,envId),user.email);
    // Linked copies are added for the environment's owner only; anyone else gets the stored data as is.
    const v=mine?await withShares(envId,user,w?.data||null):{data:dropDangling(w?.data?structuredClone(stripLinked(w.data)):null),shared:''};
    if(w&&since===w.rev&&(u.searchParams.get('shared')||'')===v.shared){json(res,200,{env:envId,rev:w.rev,shared:v.shared,unchanged:true});return true}
    json(res,200,{env:envId,rev:w?.rev||0,data:v.data,shared:v.shared,updatedAt:w?.updatedAt||null,owner:ownerOf(w,envId),readOnly:!!w&&!mine});
    return true;
  }
  if(req.method==='PUT'){
    if(req.headers['content-type']!=='application/json'){res.writeHead(415);res.end();return true}
    readBody(req,res,async raw=>{
      try{
        if(local){
          const r=await relay(req,raw);
          // Keep this computer's copy current too: it is the offline fallback.
          if(r?.status===200){try{const b=JSON.parse(raw),id=u.searchParams.get('env');if(ENV_ID.test(id||'')){const cur=await workspaces.get(id);await workspaces.put(id,{baseRev:cur?.rev||0,data:carryRunners(cur?.data,b.data).data,by:'relay',owner:user.email})}}catch{}}
          if(r){json(res,r.status,{...r.data,relayed:true,via:SYNC_HOST});return}
          json(res,503,{error:'Offline: the server could not be reached',offline:true});return;
        }
        const envId=u.searchParams.get('env');
        if(!envId||!ENV_ID.test(envId)){json(res,400,{error:'Bad environment id'});return}
        let body;try{body=JSON.parse(raw)}catch{}
        if(!body||!Number.isInteger(body.baseRev)||!validDb(body.data)){json(res,400,{error:'Expected {baseRev, data}'});return}
        const w=await workspaces.get(envId),reg=envs.get(envId);
        if(w?.archivedAt){json(res,404,{error:'Not found'});return}
        const owner=w?.owner||reg?.ownerEmail||(envId===DEFAULT_ENV.id?auth.OWNER_EMAIL:user.email);
        if(!sameEmail(owner,user.email)){json(res,w&&(w.visibility==='public')?403:404,{error:w?.visibility==='public'?'This environment is read-only for you':'Not found'});return}
        // Linked copies of shared records are not stored (they are re-projected on every read).
        const incoming=stripLinked(body.data),stored=w?stripLinked(w.data):null;
        if(w&&w.rev===body.baseRev&&shrinks(stored,incoming)&&!body.allowShrink){json(res,422,{error:`This save would remove most of the workspace (${size(stored)} → ${size(incoming)} things). Nothing was changed.`,shrink:true});return}
        // Runners are the server's (only runners.report changes them): a save never drops or rolls back
        // what a runner reported, e.g. a tab running older code that saves runners without their jobs.
        const kept=carryRunners(w?.data,incoming);
        // Card numbers only grow. A browser that sent a lower one reads the workspace back (below).
        const counted=keepCounters(w?.data,kept.data);
        const data={...counted,environment:{...(kept.data.environment||{}),id:envId,ownerEmail:owner}};
        const out=await workspaces.put(envId,{baseRev:body.baseRev,data,by:user.email,owner,visibility:data.environment.visibility==='public'?'public':'private',name:String(data.environment.name||reg?.name||'').slice(0,80)});
        if(out.conflict){json(res,409,{error:'The server has newer changes',rev:out.current?.rev||0,data:out.current?.data?(await withShares(envId,user,out.current.data)).data:null});return}
        envs.claim(data,{email:owner});
        // Placements and permitted edits of linked records (after the save, so a 409 changes nothing).
        if(!user.token)await applyRecipientSave(envId,user,body.data).catch(e=>console.error('share write-back failed',e?.message));
        const v=user.token?{shared:''}:await withShares(envId,user,data);
        json(res,200,{env:envId,rev:out.rev,shared:v.shared,...(kept.changed?{runnersKept:true}:{}),...(counted!==kept.data?{countersKept:true}:{})});
      }catch(e){json(res,500,{error:'Could not save the workspace'})}
    });
    return true;
  }
  res.writeHead(405);res.end();return true;
}

// ---------- environments: a user's own workspaces (list, create, rename, archive) ----------
//   GET /api/environments            -> [{id, name, visibility, rev, updatedAt}] the user owns
//   POST /api/environments {name}    -> {id}
//   PATCH /api/environments/<id> {name?, visibility?}   DELETE /api/environments/<id> (archives it)
async function environments(req,res){
  const u=new URL(req.url,'http://x');if(!u.pathname.startsWith('/api/environments'))return false;
  const id=u.pathname.split('/')[3];
  // The owner token may list and archive the owner's environments (tools/env.mjs environments|archive).
  const tok=(!id&&req.method==='GET')||(id&&req.method==='DELETE')?tokenUser(req):null;
  if(!tok&&req.headers.authorization){json(res,401,{error:'Invalid token'});return true}
  if(!tok&&!trusted(req)){res.writeHead(403);res.end();return true}
  const user=tok||await requireUser(req,res);if(!user)return true;
  if(!id&&req.method==='GET'){
    const own=await workspaces.owned(user.email);
    json(res,200,{environments:own.map(w=>({id:w.envId,name:w.name||w.data?.environment?.name||'Workspace',visibility:w.visibility,rev:w.rev,updatedAt:w.updatedAt}))});return true;
  }
  if(!id&&req.method==='POST'){readJson(req,res,async b=>{json(res,200,{id:await createEnvironment(user,b?.name)})});return true}
  if(!id||!ENV_ID.test(id)){json(res,404,{error:'Not found'});return true}
  if(req.method==='DELETE'&&id===DEFAULT_ENV.id&&sameEmail(user.email,auth.OWNER_EMAIL)){json(res,400,{error:"Default workspace cannot be removed"});return true}
  const w=await workspaces.get(id);
  if(!w||w.archivedAt||!sameEmail(w.owner,user.email)){json(res,404,{error:'Not found'});return true}
  if(req.method==='PATCH'){
    readJson(req,res,async b=>{
      const name=b?.name!==undefined?String(b.name).trim().slice(0,80):w.name,visibility=b?.visibility==='public'?'public':b?.visibility==='private'?'private':w.visibility;
      if(!name){json(res,400,{error:'A name is required'});return}
      const data={...w.data,environment:{...(w.data.environment||{}),id,name,visibility,ownerEmail:w.owner}};
      const out=await workspaces.put(id,{baseRev:w.rev,data,by:user.email,owner:w.owner,visibility,name});
      if(out.conflict){json(res,409,{error:'Changed meanwhile; try again'});return}
      envs.claim(data,{email:w.owner});json(res,200,{id,name,visibility,rev:out.rev});
    });
    return true;
  }
  if(req.method==='DELETE'){
    if(id===DEFAULT_ENV.id){json(res,400,{error:"Default workspace cannot be removed"});return true}
    if((await workspaces.owned(user.email)).length<=1){json(res,400,{error:'Keep at least one environment'});return true}
    await workspaces.archive(id);json(res,200,{archived:true});return true;
  }
  res.writeHead(405);res.end();return true;
}
// ---------- app invites (owner only): invite an email to Flow itself; no email is sent ----------
const mailer=createMailer(),limit=rateLimit();
const APP_URL=(auth.appOrigin||process.env.FLOW_PUBLIC_URL||'http://127.0.0.1:4317').replace(/\/+$/,'');
async function sendInvite(email,user){
  if(!mailer.configured)return {ok:false,notConfigured:true,error:'Email is not configured'};
  const why=limit(user.email,email);if(why)return {ok:false,error:why};
  return mailer.send({to:email,...inviteEmail({to:email,appUrl:APP_URL,inviter:user.name&&user.name!=='Owner (token)'?user.name:'Example Owner'})});
}
async function invitesApi(req,res){
  const u=new URL(req.url,'http://x');if(u.pathname!=='/api/invites')return false;
  // The owner token works here too (tools/env.mjs invite|invites|revoke); a wrong token is refused.
  const tok=tokenUser(req);
  if(!tok&&req.headers.authorization){json(res,401,{error:'Invalid token'});return true}
  if(!tok&&!trusted(req)){res.writeHead(403);res.end();return true}
  const user=tok||await requireUser(req,res);if(!user)return true;
  if(!sameEmail(user.email,auth.OWNER_EMAIL)){json(res,403,{error:'Only the owner can invite people'});return true}
  if(req.method==='GET'){json(res,200,{invites:await invites.list()});return true}
  // POST {email[, resend:true][, send:false]}: record (or re-open) the invite, then email it unless
  // send:false. resend:true only emails an existing, not revoked invite.
  if(req.method==='POST'){readJson(req,res,async b=>{
    if(!validEmail(b?.email)){json(res,400,{error:'Enter a valid email address'});return}
    if(sameEmail(b.email,auth.OWNER_EMAIL)){json(res,400,{error:'That is the owner'});return}
    let invite;
    if(b.resend){invite=await invites.find(b.email);if(!invite||invite.revokedAt){json(res,404,{error:'No open invite for that email'});return}}
    else invite=await invites.add(b.email,user.email);
    if(b.send===false){json(res,200,{invite,sent:false});return}
    const mail=await sendInvite(invite.email,user);
    json(res,200,{invite,sent:mail.ok,...(mail.ok?{}:{emailError:mail.error,notConfigured:!!mail.notConfigured})});
  });return true}
  if(req.method==='DELETE'){await invites.revoke(u.searchParams.get('email'));json(res,200,{revoked:true});return true}
  res.writeHead(405);res.end();return true;
}

// ---------- sharing (docs/sharing.md): owners share part of an environment with another Flow user ----------
//   POST /api/shares/preview {env, scope}               owner: exactly what a share would show (before sharing)
//   GET  /api/shares?env=<id>                           owner: shares of that environment + pending requests
//   POST /api/shares {env, recipientEmail, scope, permission, name}       owner only (a recipient cannot re-share)
//   PATCH /api/shares/<id> {permission}   DELETE /api/shares/<id> (revoke)          owner
//   GET  /api/shares/<id>/preview                       owner or recipient
//   GET  /api/shares/incoming                           recipient: shares with me, and where they are placed
//   POST /api/shares/<id>/attach {env}   DELETE /api/shares/<id>/attach?env=<id>   recipient, own environment
//   POST /api/shares/<id>/requests {toEmail, permission, note}   recipient asks the owner to share it on
//   GET  /api/share-requests   POST /api/share-requests/<id> {approve, permission}   owner decides
//   POST /api/shares/<id>/comments {kind, id, comment}  GET /api/shares/<id>/history?kind=&id=
// Anything the user may not see answers 404. The owner token (tools/env.mjs) acts as the owner.
function previewOf(db,share){
  const sc=core.resolveScope(db,share),nodes=new Map((db.charts||[]).filter(c=>!share.scope?.chartId||c.id===share.scope.chartId).flatMap(c=>c.nodes||[]).map(n=>[n.id,n]));
  const items=new Map((db.timeline||[]).map(i=>[i.id,i])),cards=new Map((db.devops?.cards||[]).map(c=>[c.id,c]));
  return {nodes:sc.nodeIds.map(id=>nodes.get(id)).filter(Boolean).map(n=>({id:n.id,name:n.name,type:n.type})),
    stubs:sc.stubs.map(t=>({id:t.nodeId,name:t.name,type:t.nodeType,owns:nodes.get(t.ownsNodeId)?.name||'',edge:t.type,percent:t.percent})),
    projects:(db.projects||[]).filter(p=>sc.projectIds.includes(p.id)).map(p=>({id:p.id,name:p.name,color:p.color})),
    items:sc.itemIds.map(id=>items.get(id)).filter(Boolean).map(i=>({id:i.id,title:i.title,kind:i.kind,start:i.start})),
    cards:sc.cardIds.map(id=>cards.get(id)).filter(Boolean).map(c=>({id:c.id,number:c.number,title:c.title}))};
}
function scopeLabel(db,scope){
  const n=id=>(db?.charts||[]).flatMap(c=>c.nodes||[]).find(x=>x.id===id)?.name||'a card';
  if(scope?.kind==='environment')return 'The whole environment';
  if(scope?.kind==='person')return `${n(scope.nodeId)} and everything below`;
  if(scope?.kind==='nodes')return scope.nodeIds.length<=3?scope.nodeIds.map(n).join(', '):`${scope.nodeIds.slice(0,2).map(n).join(', ')} and ${scope.nodeIds.length-2} more cards`;
  if(scope?.kind==='project')return `Project ${(db?.projects||[]).find(p=>p.id===scope.projectId)?.name||''}`.trim();
  if(scope?.kind==='label')return `Label ${(db?.devops?.labels||[]).find(l=>l.id===scope.label)?.name||scope.label}`;
  return 'Shared';
}
async function sharesApi(req,res){
  const u=new URL(req.url,'http://x'),path=u.pathname;
  if(path!=='/api/shares'&&!path.startsWith('/api/shares/')&&path!=='/api/share-requests'&&!path.startsWith('/api/share-requests/'))return false;
  const tok=tokenUser(req);
  if(!tok&&req.headers.authorization){json(res,401,{error:'Invalid token'});return true}
  if(!tok&&!trusted(req)){res.writeHead(403);res.end();return true}
  const user=tok||await requireUser(req,res);if(!user)return true;
  const nf=()=>json(res,404,{error:'Not found'});
  const ERR={forbidden:[403,'Only the owner can share this'],invalid:[400,'Check the details'],revoked:[410,'This share was revoked'],permission:[403,'Your permission does not allow that'],stub:[403,'Co-owner cards are read-only'],'out-of-scope':[404,'Not found'],'not-found':[404,'Not found'],decided:[409,'Already decided']};
  const fail=r=>{const [c,m]=ERR[r.error]||[400,'Not allowed'];json(res,c,{error:r.field?`${m} (${r.field})`:m,code:r.error,field:r.field})};
  // The user's own (not archived) environment, or null.
  const ownEnv=async id=>{if(!ENV_ID.test(id||''))return null;const w=await workspaces.get(id);return w&&!w.archivedAt&&sameEmail(w.owner,user.email)?w:null};
  const ownShare=async id=>{const s=await shares.get(id);return s&&sameEmail(s.ownerEmail,user.email)?s:null};
  const view=async s=>{const home=await workspaces.get(s.ownerEnv);return {...s,ownerEnvName:home?.name||home?.data?.environment?.name||'',scopeLabel:scopeLabel(home?.data,s.scope)}};
  try{
    if(path==='/api/shares/preview'&&req.method==='POST'){readJson(req,res,async b=>{
      const w=await ownEnv(b?.env);if(!w)return nf();
      if(!core.validScope(b.scope))return json(res,400,{error:'Pick what to share'});
      json(res,200,{preview:previewOf(w.data,{scope:b.scope}),label:scopeLabel(w.data,b.scope)});
    });return true}
    if(path==='/api/shares'&&req.method==='GET'){
      const w=await ownEnv(u.searchParams.get('env'));if(!w)return nf(),true;
      const list=await shares.list({ownerEnv:w.envId});
      json(res,200,{shares:list.map(s=>({...s,scopeLabel:scopeLabel(w.data,s.scope)})),requests:(await shares.requests({ownerEmail:user.email,status:'pending'})).filter(r=>list.some(s=>s.id===r.shareId))});return true;
    }
    if(path==='/api/shares'&&req.method==='POST'){readJson(req,res,async b=>{
      const w=await ownEnv(b?.env);if(!w)return nf();
      // Linked copies are not the user's to share: they ask the owner instead (a share request).
      if(/"sh\./.test(JSON.stringify(b.scope??null)))return json(res,400,{error:'Cards shared with you cannot be shared on. Ask the owner from Settings › Sharing.'});
      const r=core.createShare({id:w.envId,ownerEmail:w.owner},user,{recipientEmail:b.recipientEmail,scope:b.scope,permission:b.permission||'view',name:b.name});
      if(!r.ok)return fail(r);
      // Sharing the same thing with the same person again updates the permission instead of duplicating it.
      const dup=(await shares.list({ownerEnv:w.envId,recipientEmail:r.share.recipientEmail})).find(s=>JSON.stringify(s.scope)===JSON.stringify(r.share.scope));
      const s=dup?(dup.permission===r.share.permission?dup:await shares.setPermission(dup.id,r.share.permission)):await shares.create(r.share);
      json(res,200,{share:await view(s),existing:!!dup,preview:previewOf(w.data,s)});
    });return true}
    if(path==='/api/shares/incoming'&&req.method==='GET'){
      const own=new Set((await workspaces.owned(user.email)).map(w=>w.envId)),out=[];
      for(const s of await shares.list({recipientEmail:user.email}))out.push({...await view(s),envs:(await shares.envsFor(s.id)).filter(id=>own.has(id))});
      json(res,200,{shares:out});return true;
    }
    if(path==='/api/share-requests'&&req.method==='GET'){
      json(res,200,{requests:await shares.requests({ownerEmail:user.email,status:'pending'}),mine:await shares.requests({requestedBy:user.email})});return true;
    }
    let m=/^\/api\/share-requests\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if(m&&req.method==='POST'){readJson(req,res,async b=>{
      const r0=await shares.getRequest(m[1]);if(!r0||!sameEmail(r0.ownerEmail,user.email))return nf();
      const out=core.decideRequest(r0,await shares.get(r0.shareId),user,!!b?.approve,{permission:b?.permission});
      if(!out.ok)return fail(out);
      if(out.share)await shares.create(out.share);
      json(res,200,{request:await shares.decide(out.request),share:out.share||null});
    });return true}
    m=/^\/api\/shares\/([A-Za-z0-9-]{1,64})(?:\/(preview|attach|requests|comments|history))?$/.exec(path);
    if(!m)return nf(),true;
    const s=await shares.get(m[1]),isOwner=s&&sameEmail(s.ownerEmail,user.email),isRecipient=s&&!s.revokedAt&&sameEmail(s.recipientEmail,user.email)&&!user.token;
    if(!isOwner&&!isRecipient)return nf(),true;
    const sub=m[2]||'';
    if(!sub&&req.method==='GET'){json(res,200,{share:await view(s)});return true}
    if(!sub&&req.method==='PATCH'){if(!isOwner)return nf(),true;readJson(req,res,async b=>{
      if(!core.PERMISSIONS.includes(b?.permission))return json(res,400,{error:'Pick view, comment or edit'});
      if(s.revokedAt)return fail({error:'revoked'});
      json(res,200,{share:await view(await shares.setPermission(s.id,b.permission))});
    });return true}
    if(!sub&&req.method==='DELETE'){if(!isOwner)return nf(),true;json(res,200,{share:await view(await shares.revoke(s.id)),revoked:true});return true}
    if(sub==='preview'&&req.method==='GET'){
      if(s.revokedAt)return fail({error:'revoked'}),true;
      const home=await workspaces.get(s.ownerEnv);if(!home?.data)return nf(),true;
      json(res,200,{share:await view(s),preview:previewOf(home.data,s)});return true;
    }
    if(sub==='attach'){
      if(!isRecipient)return nf(),true;
      if(req.method==='POST'){readJson(req,res,async b=>{const w=await ownEnv(b?.env);if(!w)return nf();await shares.attach(s.id,w.envId);json(res,200,{attached:true,env:w.envId})});return true}
      if(req.method==='DELETE'){const w=await ownEnv(u.searchParams.get('env'));if(!w)return nf(),true;await shares.detach(s.id,w.envId);json(res,200,{attached:false,env:w.envId});return true}
    }
    if(sub==='requests'&&req.method==='POST'){if(!isRecipient)return nf(),true;readJson(req,res,async b=>{
      const r=core.requestReshare(s,user,{toEmail:b?.toEmail,permission:b?.permission,note:b?.note});if(!r.ok)return fail(r);
      json(res,200,{request:await shares.addRequest(r.request)});
    });return true}
    if(sub==='comments'&&req.method==='POST'){readJson(req,res,async b=>{
      const home=await workspaces.get(s.ownerEnv);if(!home?.data)return nf();
      let hist;
      if(isRecipient){const r=core.applyRecipientEdit(home.data,s,{kind:b?.kind,id:b?.id,comment:String(b?.comment??'')},user);if(!r.ok)return fail(r);hist=r.history}
      else{
        // The owner answers on a record of the share.
        const id=core.parseLinkedId(b?.id)?.id||b?.id,sc=core.resolveScope(home.data,s),t=String(b?.comment||'').trim();
        const ok={node:sc.nodeIds,edge:sc.edgeIds,project:sc.projectIds,item:sc.itemIds,card:sc.cardIds}[b?.kind]?.includes(id);
        if(!ok)return nf();if(!t||t.length>4000)return json(res,400,{error:'Write a comment'});
        hist=[{shareId:s.id,envId:s.ownerEnv,kind:b.kind,recordId:id,field:'comment',old:null,new:t,by:user.email.toLowerCase(),at:new Date().toISOString()}];
      }
      await shares.record(hist);json(res,200,{history:hist});
    });return true}
    if(sub==='history'&&req.method==='GET'){
      const kind=u.searchParams.get('kind')||undefined,id=core.parseLinkedId(u.searchParams.get('id'))?.id||u.searchParams.get('id')||undefined;
      let list=await shares.history({shareId:s.id,kind,recordId:id,limit:200});
      // A recipient only sees the history of records that are still shared with them.
      if(!isOwner){const home=await workspaces.get(s.ownerEnv),sc=home?.data?core.resolveScope(home.data,s):null,k={node:'nodeIds',edge:'edgeIds',project:'projectIds',item:'itemIds',card:'cardIds'};
        list=sc?list.filter(e=>sc[k[e.kind]]?.includes(e.recordId)):[]}
      json(res,200,{history:list});return true;
    }
    res.writeHead(405);res.end();return true;
  }catch(e){console.error('shares',e?.message);json(res,500,{error:'Sharing failed'});return true}
}

// ---------- public API: /api/v1 (REST + OpenAPI), API keys (Settings › API keys) and MCP at /mcp ----------
// docs/api.md, docs/api-keys.md, docs/mcp-cli.md. /api/v1 and /mcp take Authorization: Bearer flow_… keys
// (or the owner token); they are not tied to the page origin. A key is limited to its environment and
// scopes on top of the usual ownership rules. Linked copies of shares never appear here: the API sees
// each environment's own stored data only.
const {apiV1,envCheckFor,memoryRateLimit}=await import('./lib/api-v1.mjs');
const registryMod=await import('./lib/registry.mjs');
const {apiKeyStore,authenticateApiKey,bearerKey,allows:keyAllows,SCHEMA:APIKEY_SCHEMA}=await import('./lib/apikeys.mjs');
const {apiKeyRoutes}=await import('./lib/apikeys-routes.mjs');
const {mcpHandler}=await import('./lib/mcp.mjs');
// 'live' keys only on the public deploy; local mode and verify make flow_test_ keys. db without a catch:
// a database error fails closed.
const apiKeys=apiKeyStore({dir:fileURLToPath(backupRoot),db:()=>cloud(),mode:auth.mode==='opid'&&!VERIFY?'live':'test'});
const keyEnvs=async u=>[...new Set([...(await workspaces.owned(u.email)).map(w=>w.envId),...(sameEmail(u.email,auth.OWNER_EMAIL)?[DEFAULT_ENV.id]:[])])];
const keysApi=apiKeyRoutes({userFor:auth.userFor,store:apiKeys,readJson,trusted,envsFor:keyEnvs});
const apiLimit=memoryRateLimit({perMinute:120}),baseEnvCheck=envCheckFor(workspaces);
// The store the API works on: each environment's own data (no linked copies; edges to them left out),
// and for a key, only the environments it is for.
const apiStore=key=>({...workspaces,
  async get(id){const w=await workspaces.get(id);return w?.data?{...w,data:dropDangling(structuredClone(stripLinked(w.data)))}:w},
  async owned(email){return (await workspaces.owned(email)).filter(w=>!key||keyAllows(key,'read',w.envId))},
});
const keyEnvCheck=async(envId,user,mode)=>(!user?.key||keyAllows(user.key,mode==='write'?'write':'read',envId))&&baseEnvCheck(envId,user,mode);
// Authorization: Bearer flow_… (an API key) or the owner token. -> {user, scopes} | null
async function apiAuth(req){
  if(bearerKey(req)){const a=await authenticateApiKey(req,apiKeys).catch(()=>null);return a?.user?{user:{id:'key:'+a.keyId,email:a.user.email,key:a},scopes:a.scopes}:null}
  const t=tokenUser(req);return t?{user:t,scopes:['read','write','admin']}:null;
}
async function apiV1Route(req,res){
  if(!req.url.startsWith('/api/v1'))return false;
  // One authentication per request (it also counts towards the key's rate limit).
  let a;const authenticate=async r=>a!==undefined?a:(a=await apiAuth(r));
  if(req.headers.authorization)await authenticate(req);
  return apiV1(req,res,{authenticate,userFor:r=>trusted(r)?auth.userFor(r):null,store:apiStore(a?.user?.key),envCheck:keyEnvCheck,rateLimit:apiLimit});
}
async function mcpRoute(req,res){
  if(new URL(req.url,'http://x').pathname!=='/mcp')return false;
  return mcpHandler(req,res,{operations:registryMod.operations,invoke:registryMod.invoke,
    authenticate:async(token,r)=>(await apiAuth(r))?.user||null,
    ctx:user=>({user,store:apiStore(user.key),envCheck:keyEnvCheck}),
    origins:auth.appOrigin?[auth.appOrigin]:[]});
}

// ---------- DevLog: GET /api/devlog?page=N&q=text, one page (10) of releases ----------
// Releases recorded per production deploy (Postgres, lib/devlog-releases.mjs) come first, then the
// frozen history in public/devlog.json. Page origin only (trusted), no sign-in: DevLog is public product information.
const devlogMod=await import('./lib/devlog-releases.mjs');
const devlogHistory=()=>devlogMod.readHistory(join(root,'devlog.json'));
// Deploy releases change only when a deploy starts, so a minute of caching is plenty.
let devlogCache={at:0,list:[]};
async function deployedReleases(){
  if(Date.now()-devlogCache.at<60000)return devlogCache.list;
  let list=[];
  try{const db=await cloud();if(db)list=await (await devlogMod.releaseStore((q,p)=>db.query(q,p))).list({limit:1000})}catch{}
  devlogCache={at:Date.now(),list};return list;
}
async function devlogPage(req,res){
  const u=new URL(req.url,'http://x');if(u.pathname!=='/api/devlog')return false;
  if(!trusted(req)||req.method!=='GET'){res.writeHead(403);res.end();return true}
  json(res,200,devlogMod.devlogResponse({deployed:await deployedReleases(),history:devlogHistory(),page:u.searchParams.get('page'),q:u.searchParams.get('q')}));
  return true;
}
// Records this production deploy's release in the background once the server listens. Never
// blocks or stops startup; one log line either way.
async function recordDevlog(){
  try{
    const ctx=await devlogMod.deployToRecord(process.env);if(!ctx)return;
    const db=await cloud();if(!db)return;
    const result=await devlogMod.recordRelease({store:await devlogMod.releaseStore((q,p)=>db.query(q,p)),ctx,history:devlogHistory()});
    devlogCache.at=0;console.log(devlogMod.describeResult(result));
  }catch(e){console.error(`DevLog: release recording failed: ${cloudError(e)}`)}
}

// ---------- user preferences (shortcuts, Settings tab, ...): GET/PUT /api/prefs, own prefs only ----------
// Stored as BACKUP_DIR/prefs/<user>.json, and in Postgres (flygon_flow_prefs) when DATABASE_URL is set.
const PREFS_MAX=32000,prefsRoot=join(fileURLToPath(backupRoot),'prefs');
const prefsKey=u=>String(u.id&&u.id!=='local'?u.id:u.email||'local').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,100);
async function prefs(req,res){
  if(req.url.split('?')[0]!=='/api/prefs')return false;
  if(!trusted(req)){res.writeHead(403);res.end();return true}
  const user=await requireUser(req,res);if(!user)return true;
  const file=join(prefsRoot,prefsKey(user)+'.json');
  if(req.method==='GET'){
    let data=null;try{data=JSON.parse(readFileSync(file,'utf8'))}catch{}
    if(!data)try{const db=await cloud();const row=db&&(await db.query('select data from flygon_flow_prefs where user_id=$1',[prefsKey(user)])).rows[0];if(row)data=row.data}catch{}
    json(res,200,{prefs:data&&typeof data==='object'&&!Array.isArray(data)?data:{}});return true;
  }
  if(req.method==='PUT'){
    if(req.headers['content-type']!=='application/json'){res.writeHead(415);res.end();return true}
    readBody(req,res,async body=>{
      if(body.length>PREFS_MAX){json(res,413,{error:'Preferences are too large'});return}
      let data;try{data=JSON.parse(body)}catch{}
      if(!data||typeof data!=='object'||Array.isArray(data)){json(res,400,{error:'Expected an object'});return}
      try{mkdirSync(prefsRoot,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(data));renameSync(file+'.tmp',file)}catch{json(res,500,{error:'Could not save preferences'});return}
      try{const db=await cloud();if(db)await db.query('insert into flygon_flow_prefs(user_id,email,data,updated_at) values($1,$2,$3,now()) on conflict (user_id) do update set data=excluded.data,email=excluded.email,updated_at=now()',[prefsKey(user),user.email,data])}catch{}
      json(res,200,{saved:true});
    });
    return true;
  }
  res.writeHead(405);res.end();return true;
}

// Static files: any existing file under public/ (so new modules need no restart). The decoded path
// is resolved and must stay inside public/; dotfiles and unknown types are refused.
function resolveStatic(url){
  const rel=url==='/'?'index.html':url.replace(/^[\\/]+/,'');
  if(!rel||/[\u0000-\u001f:]/.test(rel)||rel.split(/[\\/]/).some(p=>p.startsWith('.')))return null;
  const file=resolve(root,rel);
  if(!file.startsWith(resolve(root)+sep)||!types[extname(file)]||!existsSync(file)||!statSync(file).isFile())return null;
  return file;
}
const server=http.createServer(async(req,res)=>{
  // Who may frame Flow (lib/embed.mjs): this origin only, unless FLOW_FRAME_ANCESTORS adds others.
  try{for(const [k,v] of Object.entries(await auth.embed.headers(req)))res.setHeader(k,v)}catch{}
  if(req.url.split('?')[0]==='/api/instance'&&req.method==='GET'){
    const name=String(process.env.FLOW_INSTANCE_NAME||'Flow').trim().slice(0,80)||'Flow';
    const accent=/^#[0-9a-fA-F]{6}$/.test(process.env.FLOW_ACCENT_COLOR||'')?process.env.FLOW_ACCENT_COLOR:'#7cb980';
    const logo=String(process.env.FLOW_LOGO_PATH||'');
    json(res,200,{name,accent,logo:/^\/(?!\/)[A-Za-z0-9/_-]+\.(?:svg|png|webp)$/.test(logo)&&!logo.includes('..')?logo:''});return;
  }
  // API clients (keys, CLI, MCP) have no page origin: these two authenticate with Bearer keys themselves.
  if(await apiV1Route(req,res)||await mcpRoute(req,res))return;
  if(req.url.startsWith('/api/auth/')){if(!trusted(req)){res.writeHead(403);res.end();return}if(await auth.handle(req,res,readJson))return}
  if(await backup(req,res)||await saves(req,res)||await inbox(req,res)||await prefs(req,res)||await workspace(req,res)||await environments(req,res)||await invitesApi(req,res)||await sharesApi(req,res)||await keysApi(req,res)||await devlogPage(req,res))return;
  // Generated docs (tools/docs.mjs): /docs opens the index; /skill.md is the agent skill. Public, no workspace data.
  const bare=req.url?.split('?')[0];
  if(bare==='/docs'||bare==='/docs/'){res.writeHead(302,{Location:'/docs/index.html'});res.end();return}
  if(bare==='/skill.md'&&req.method==='GET'){try{const b=readFileSync(new URL('./skills/flygon-flow/SKILL.md',import.meta.url));res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(b)}catch{res.writeHead(404);res.end()}return}
  let file;try{file=resolveStatic(decodeURIComponent(req.url?.split('?')[0]||'/'))}catch{file=null}
  if(!file||(req.method!=='GET'&&req.method!=='HEAD')){res.writeHead(404);res.end('Not found');return;}
  try{const body=readFileSync(file);res.setHeader('Content-Type',types[extname(file)]+(/^(text|application\/json)/.test(types[extname(file)])?'; charset=utf-8':''));res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(req.method==='HEAD'?undefined:body);}catch{res.writeHead(500);res.end('Unable to load file');}
});
// Local single-user mode only ever listens on loopback; a public deploy must run with OneProfileID.
// With OPID_* set it listens on HOST (default 0.0.0.0) at PORT, as hosts like Railway expect.
const LOOPBACK=['127.0.0.1','localhost','::1'];
const host=process.env.HOST||(auth.mode==='opid'?'0.0.0.0':'127.0.0.1');
if(auth.mode==='local'&&!LOOPBACK.includes(host)){console.error(`Refusing to listen on ${host} in local single-user mode. Set OPID_BASE_URL, OPID_APP_ID, OPID_APP_SECRET and OPID_APP_ORIGIN to serve it publicly with sign-in.`);process.exit(1)}
let port=Number(process.env.PORT||4317);
server.on('error',e=>{if(e.code==='EADDRINUSE'&&!process.env.PORT){port++;server.listen(port,host);}else{console.error(e);process.exit(1);}});
server.once('listening',()=>{setImmediate(()=>recordDevlog().catch(()=>{}))});
server.on('listening',()=>{const url=auth.mode==='opid'&&!LOOPBACK.includes(host)?`${auth.appOrigin} (listening on ${host}:${server.address().port})`:`http://${host==='::1'?'[::1]':host}:${server.address().port}`;if(!VERIFY&&auth.mode==='local')writeFileSync(new URL('./running.json',import.meta.url),JSON.stringify({url,pid:process.pid}));console.log(`Flygon Flow: ${url} (${auth.mode==='opid'?'OneProfileID sign-in':'local single-user mode'}${auth.mode==='local'&&SYNC_URL&&SYNC_TOKEN?`, syncing with ${SYNC_HOST}`:''})`);});
server.listen(port,host);
