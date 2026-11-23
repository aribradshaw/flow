import {isDeepStrictEqual} from 'node:util';
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
// Guardrails (lib/limits.mjs): per-person caps, persistent rate windows; people who signed in (lib/users.mjs).
const limitsMod=await import('./lib/limits.mjs');
const {userStore,accessRequestStore,SCHEMA:USER_SCHEMA,REQUEST_SCHEMA}=await import('./lib/users.mjs');
const {createMailer,inviteEmail}=await import('./lib/mailer.mjs');
// Sharing (docs/sharing.md): the rules are pure (sharing-core), the store keeps shares, requests and placements.
const {shareStore,SCHEMA:SHARE_SCHEMA}=await import('./lib/shares.mjs');
const core=await import('./lib/sharing-core.mjs');
// Combined view (docs/combined.md): other environments of the same user shown in the open one's board and timeline.
const combined=await import('./public/combined-core.js');
// OneProfileID photos on person cards a person linked to their account (docs/concepts/10-opid-photos.md).
const opidPhotos=await import('./lib/opid-photos.mjs');
const {validOpidUser,normalize:normalizeDb}=await import('./lib/cleaners.mjs');
// Sign-in sessions survive deploys when Postgres is configured (memory otherwise).
const flowSessions=sessionStore({db:()=>cloud(),max:auth.SESSION_MAX});auth.useSessionStore(flowSessions);
// Removing people from Flow (lib/revocations.mjs): the owner's removals and OneProfileID's membership events.
const {revocationStore,membershipControl,SCHEMA:REVOCATION_SCHEMA}=await import('./lib/revocations.mjs');
const {shrinks,size,keepCounters,fieldBase,applyCardEdits,sameCard}=await import('./public/sync-core.js');
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
  // On a shared server, disk backups are the owner's: everyone else's work is in the server's workspace
  // history already, and per-browser files would let anyone fill the disk.
  if(auth.mode==='opid'&&!isOwnerEmail(user.email)){req.resume();json(res,200,{saved:false,skipped:'Disk backups are kept for the owner only; your workspace is saved on the server with its history.'});return true}
  readBody(req,res,body=>{try{
    let data=JSON.parse(body);
    if(!validDb(data))throw Error('Invalid chart database');
    // An opened shared environment is its owner's: never backed up as this user's.
    if(core.parseOpenedEnv(data.environment?.id)){json(res,200,{saved:false,skipped:'A shared environment is saved by its owner.'});return}
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
      for(const q of [...WORKSPACE_SCHEMA,...SESSION_SCHEMA,...INVITE_SCHEMA,...USER_SCHEMA,...REQUEST_SCHEMA,...limitsMod.SCHEMA,...SHARE_SCHEMA,...APIKEY_SCHEMA,...opidPhotos.SCHEMA,...REVOCATION_SCHEMA])await p.query(q);
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
// File names: <time>_<owner tag>_<id>.json (older ones: <time>_<id>.json, counted as the owner's).
// Each owner's saves are pruned on their own, so nobody's saves can push out anyone else's.
const ownerTag=email=>isOwnerEmail(email)?'o':'u'+Buffer.from(String(email||'').toLowerCase()).toString('base64url').slice(0,40).replace(/_/g,'-');
function writeLocal(s,owner){
  mkdirSync(savesRoot,{recursive:true});
  const tag=ownerTag(owner),keep=isOwnerEmail(owner)?KEEP_LOCAL:Math.min(KEEP_LOCAL,CAPS.maxSaves);
  writeFileSync(`${savesRoot}/${s.at.replace(/[:.]/g,'-')}_${tag}_${s.id}.json`,JSON.stringify(s));
  const mine=f=>{const p=f.slice(0,-5).split('_');return p.length===3?p[1]===tag:tag==='o'};
  const files=readdirSync(savesRoot).filter(f=>f.endsWith('.json')&&mine(f)).sort();
  for(const f of files.slice(0,Math.max(0,files.length-keep)))unlinkSync(savesRoot+'/'+f);
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
      // Listed: environments the user owns or is a member of. Public ones of others open by id only;
      // they are never listed or discoverable here.
      const listable=e=>canRead(e,user)&&(sameEmail(e.ownerEmail,user.email)||e.members?.some(m=>sameEmail(m,user.email)));
      const local=localList().filter(s=>listable(s.env)),byId=new Map(local.map(s=>[s.id,{...s,env:envInfo(s.env),local:true,cloud:false}]));
      let status='off';
      try{const db=await cloud();if(db){status='ok';
        for(const r of (await db.query('select id,saved_at,label,charts,items,env_id,env_owner,env_visibility from org_chart_studio_saves order by saved_at desc limit 200')).rows){
          const e=rowEnv(r);if(!listable(e))continue;
          const s=byId.get(r.id)||{id:r.id,at:r.saved_at.toISOString(),label:r.label,charts:r.charts,items:r.items,env:envInfo(e),local:false};s.cloud=true;byId.set(r.id,s);
        }}}catch(e){status='error: '+cloudError(e)}
      json(res,200,{cloud:status,user:{email:user.email},saves:[...byId.values()].sort((a,b)=>b.at.localeCompare(a.at))});return true;
    }
    if(req.method==='POST'&&url==='/api/saves'){
      if(req.headers['content-type']!=='application/json'){res.writeHead(403);res.end();return true;}
      readBody(req,res,async body=>{
        let data;try{data=JSON.parse(body)}catch{}
        if(!validDb(data)){json(res,400,{error:'Invalid chart database'});return}
        if(core.parseOpenedEnv(data.environment?.id)){json(res,400,{error:'This environment is shared with you: its owner keeps its saves.'});return}
        const e0=envs.of(data);if(!canWrite(e0,user)){denied(res,e0,user);return}
        const L=limitsOf(e0.unregistered?user.email:e0.ownerEmail),things=size(data),bytes=limitsMod.bytesOf(data);
        if(things>L.maxItems){json(res,413,{error:`This workspace holds ${things.toLocaleString('en-US')} cards, nodes and items; a workspace holds up to ${L.maxItems.toLocaleString('en-US')}. Nothing was saved.`,code:'too_many_items'});return}
        if(bytes>L.maxWorkspaceBytes){json(res,413,{error:`This save is ${limitsMod.fmtBytes(bytes)}; a save holds up to ${limitsMod.fmtBytes(L.maxWorkspaceBytes)}. Nothing was saved.`,code:'workspace_too_large'});return}
        const e=envs.claim(data,user);stamp(data,e);data=stripLinked(data);
        const n=summary(data),s={id:randomUUID(),at:new Date().toISOString(),label:data.charts.map(c=>c.name).join(', ').slice(0,200),...n,data};
        let local=false,cloudOk=false,error='';
        try{writeLocal(s,e.ownerEmail);local=true}catch(err){error='Local save failed'}
        try{const db=await cloud();if(db){
          await db.query('insert into flygon_flow_environments(id,name,owner_email,visibility,members) values($1,$2,$3,$4,$5) on conflict (id) do update set name=excluded.name,visibility=excluded.visibility',[e.id,e.name,e.ownerEmail,e.visibility,JSON.stringify(e.members)]);
          await db.query('insert into org_chart_studio_saves(id,saved_at,label,charts,items,data,env_id,env_owner,env_visibility) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[s.id,s.at,s.label,n.charts,n.items,data,e.id,e.ownerEmail,e.visibility]);cloudOk=true;
          if(!isOwnerEmail(e.ownerEmail))await db.query('delete from org_chart_studio_saves where lower(env_owner)=lower($1) and id not in (select id from org_chart_studio_saves where lower(env_owner)=lower($1) order by saved_at desc limit $2)',[e.ownerEmail,CAPS.maxSaves])}else if(!VERIFY)error||='Cloud not configured'}
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
// PUT  /api/workspace?env=<id>  {baseRev, data[, allowShrink][, cardEdits]} -> {rev} | 409 {rev, data} | 422 shrink
//      cardEdits (the board, sync-core cardEditsOf): only those cards and fields are written; a card edit
//      over a value the browser never saw is 409 {code:'card_conflict', clashes}. A browser tab running
//      older code (intent but no cardEdits) that changes cards is refused with 428: it must reload.
// Auth: the signed-in user, or `Authorization: Bearer <FLOW_SYNC_TOKEN>` acting as the owner
// (OWNER_EMAIL) for imports and for a local app syncing to production.
// With FLOW_SYNC_URL + FLOW_SYNC_TOKEN set (e.g. Owner's local app), these calls are relayed to that
// server; the local file copy is the offline fallback.
let officeHistory,appPush;
const rawWorkspaces=workspaceStore({dir:fileURLToPath(backupRoot),db:()=>cloud().catch(()=>null),
  onSaved:(env,before,after,meta)=>{officeHistory?.cards(env,before,after);appPush?.saved(env,before,after,meta)}});
const CAPS=auth.CAPS,isOwnerEmail=e=>sameEmail(e,auth.OWNER_EMAIL),limitsOf=email=>limitsMod.limitsFor(CAPS,{owner:isOwnerEmail(email)});
const users=userStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
// Someone with no row yet who already owns data used Flow before people were recorded: not new.
const accountOf=async email=>await users.get(email).catch(()=>null)||((await rawWorkspaces.owned(email)).length?{firstSeen:'1970-01-01T00:00:00.000Z'}:null);
auth.useUsers(users,async email=>(await rawWorkspaces.owned(email)).length>0);
const workspaces=limitsMod.cappedWorkspaces(rawWorkspaces,{caps:CAPS,isOwner:isOwnerEmail,accountOf,count:d=>size(d)});
const rates=limitsMod.rateStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
const accessRequests=accessRequestStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});auth.useAccessRequests(accessRequests);
const invites=inviteStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
auth.useInvites(invites);
const revocations=revocationStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
auth.useRevocations(revocations,args=>memberships.revoke({...args,by:'flow'}));
// Who in Flow holds a OneProfileID membership id: recorded at sign-in, else an open sign-up's own id, else an invite's.
async function memberOf(localId){
  if(localId==='owner')return {email:auth.OWNER_EMAIL,opidId:(await users.get(auth.OWNER_EMAIL))?.opidId||''};
  const u=await users.byLocalId(localId)||(await users.list()).find(x=>x.opidId&&auth.selfLocalId(x.opidId)===localId);
  if(u)return {email:u.email,opidId:u.opidId};
  const i=await invites.byLocalId(localId);if(!i)return null;
  const v=await users.get(i.email);return {email:i.email,opidId:v?.opidId||''};
}
// A removed person's access ends everywhere here: Flow sessions, API keys, and so MCP and the CLI.
async function endAccess({email,opidId}){
  await flowSessions.deleteUser({email,opidId});
  if(email)await apiKeys.revokeAll(email);
}
const memberships=membershipControl({store:revocations,opid:auth.opidMembership,resolve:memberOf,endAccess});
// The membership id to revoke for someone who uses Flow.
async function localIdOf(u){
  if(u.localId)return u.localId;
  const i=await invites.find(u.email);if(i?.claimedAt)return i.localId;
  return u.opidId?auth.selfLocalId(u.opidId):'';
}
const shares=shareStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
// Who opened which workspace with their OneProfileID account (its owner, or a share's recipient).
const opidMembers=opidPhotos.memberStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
// The user's OneProfileID account id, for links on person cards; null for the owner token, API keys
// and local mode, which can never add a link.
const opidId=u=>auth.mode==='opid'&&u&&!u.token&&!u.key&&!u.local&&validOpidUser(u.id)?u.id:null;
const seenBy=(envId,user)=>{if(opidId(user))opidMembers.record(envId,user).catch(e=>console.error('opid members failed',e?.message))};
// ---- sharing in workspaces ----
// Linked copies (ids sh.<shareId>.<owner id>) are never stored in the recipient's workspace: they are
// projected from the owner's current data on every read, for the recipient only. What is stored is the
// recipient's own data, plus their private edges to linked cards (just ids).
const isLinked=id=>typeof id==='string'&&id.startsWith('sh.');
function stripLinked(d){
  if(!d||typeof d!=='object')return d;
  // Combined records (cx.*) and references to them never belong to the workspace that showed them.
  if(combined.hasCombined(d))d=combined.stripCombined(d);
  const out={...d,charts:(d.charts||[]).map(c=>({...c,nodes:(c.nodes||[]).filter(n=>!isLinked(n.id)),edges:(c.edges||[]).filter(e=>!isLinked(e.id))}))};
  delete out.shares;delete out.shareMembers;
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
// The members of a share (its owner and the recipients of the same records), who can be assigned to its cards.
const membersOf=async s=>core.shareMembers(s,await shares.list({ownerEnv:s.ownerEnv}));
// Conflicts are shown to the person who lost them for a day (docs/sharing.md).
const CONFLICT_MS=864e5;
// The workspace as its owner sees it: their own data plus the linked copies of shares placed in it.
// shared: a signature of those shares (ids, permissions and the owners' revisions), so a client polling
// with ?since=<rev> still hears about the owner's edits. conflicts: recent edits by others that overwrote
// this user's value on a shared record (core.conflictView).
async function withShares(envId,user,data){
  if(!data)return {data,shared:'',conflicts:[]};
  // Sharing must never break reading one's own workspace: on any failure, serve it without linked copies.
  try{return await project(envId,user,data)}catch(e){console.error('share projection failed',e?.message);return {data:dropDangling(structuredClone(stripLinked(data))),shared:'',conflicts:[]}}
}
async function project(envId,user,data){
  const own=stripLinked(data);let d=structuredClone(own);const sig=[],meta=[],conflicts=[],since=new Date(Date.now()-CONFLICT_MS).toISOString();
  for(const {share:s,home} of user.token?[]:await attachedShares(envId,user)){
    const members=await membersOf(s),mine=await shares.proposals({shareId:s.id,proposedBy:user.email,limit:50}),pending=mine.filter(x=>x.status==='pending');
    const p=core.projectForRecipient(home.data,s,await shares.placements(s.id,envId),{members,viewer:opidId(user),pending});
    d=core.applyProjection(d,p);seenBy(s.ownerEnv,user);
    // Decided in the last week (the browser tells the recipient once): approved, denied.
    const decided=mine.filter(x=>(x.status==='approved'||x.status==='denied')&&x.decidedAt>=new Date(Date.now()-7*CONFLICT_MS).toISOString())
      .map(x=>({id:x.id,status:x.status,at:x.decidedAt,titles:core.proposalPreview(inScope(home.data,s),x).map(r=>r.title).slice(0,5)}));
    sig.push(`${s.id}:${s.permission}:${core.addsOf(s)}:${home.rev}:${pending.map(x=>x.id+'@'+x.updatedAt).join('+')}:${decided.length}`);
    meta.push({id:s.id,permission:s.permission,adds:core.addsOf(s),ownerEmail:s.ownerEmail,ownerEnv:s.ownerEnv,ownerEnvName:home.name||home.data.environment?.name||'',name:s.name,members:p.share.members.map(m=>({...m,officeKey:officeHub.memberKey(m.email)})),
      ...(p.share.pending.length?{pending:p.share.pending}:{}),...(decided.length?{decided}:{})});
    const sc=core.resolveScope(home.data,s);
    for(const e of await shares.history({envId:s.ownerEnv,over:user.email,since,limit:200}))
      if(sc[SCOPE_KEY[e.kind]]?.includes(e.recordId))conflicts.push(core.conflictView(e,{ownerDb:home.data,share:s,members}));
  }
  // The owner's own shared records: recipients of this environment's shares can be assigned to the cards
  // shared with them (person cards with their email already can), and conflicts they lost.
  if(!user.token&&sameEmail(data.environment?.ownerEmail||user.email,user.email)){
    const out=await shares.list({ownerEnv:envId}),emails=new Set((own.charts||[]).flatMap(c=>c.nodes||[]).filter(n=>n.type==='person'&&n.email).map(n=>n.email.toLowerCase())),members=new Map();
    for(const s of out){
      const e=s.recipientEmail.toLowerCase();if(emails.has(e))continue;
      const m=members.get(e)||members.set(e,{id:core.memberId(e),email:e,name:e,cards:new Set()}).get(e);
      for(const id of core.resolveScope(own,s).cardIds)m.cards.add(id);
    }
    if(members.size)d.shareMembers=[...members.values()].map(m=>({...m,officeKey:officeHub.memberKey(m.email),cards:[...m.cards]}));
    if(out.length)for(const e of await shares.history({envId,over:user.email,since,limit:200}))conflicts.push(core.conflictView(e));
  }
  for(const sid of core.linkedShareIds(d))if(!meta.some(m=>m.id===sid)){
    d=core.revokeEffects(d,{id:sid}).db;
    // The share's chart stays when the user put their own cards in it; it no longer names the owner.
    for(const c of d.charts)if(c.id===core.shareChartId(sid)&&c.name.startsWith('Shared · '))c.name='Formerly shared';
  }
  d=dropDangling(d);if(meta.length)d.shares=meta;
  const seen=new Set();
  return {data:d,shared:sig.join(','),conflicts:conflicts.filter(c=>{const k=[c.kind,c.id,c.field,c.at].join('|');return !seen.has(k)&&seen.add(k)})};
}
// ---- opened shared environments (docs/sharing.md, "Opening a shared environment") ----
// The recipient of an active whole-environment share opens the owner's environment as share-<shareId>: what the
// owner has, through the share's projection (core.openedProjection), built from the owner's current data on every
// read and never stored. Saves send back only the edits the share allows (applyRecipientSave) and the additions its
// adds setting allows (planAdds). Anyone but the share's recipient gets 404; a revoked share answers 410.
// -> {share, home} | {gone:true} | null
async function openedShare(envId,user){
  const sid=core.parseOpenedEnv(envId);if(!sid||!user?.email||user.token||user.key)return null;
  const s=await shares.get(sid);if(!s||!sameEmail(s.recipientEmail,user.email)||s.scope?.kind!=='environment')return null;
  if(s.revokedAt)return {gone:true};
  const home=await workspaces.get(s.ownerEnv);if(!home?.data||home.archivedAt)return {gone:true};
  return {share:s,home};
}
const GONE={error:'This environment is no longer shared with you',code:'share_revoked'};
// The share as it is right now, just before a write to the owner's data: null once revoked. A save in flight
// re-reads it here, so a revoke or a lower permission between the save's first check and its write wins.
const shareNow=async s=>{const cur=await shares.get(s.id).catch(()=>null);return cur&&!cur.revokedAt?cur:null};
// What an opened environment serves: {data, shared (a signature, as for placed shares), conflicts, rev (the owner's)}.
async function openedView(envId,user,{share:s,home}){
  const members=await membersOf(s),mine=await shares.proposals({shareId:s.id,proposedBy:user.email,limit:50}),pending=mine.filter(x=>x.status==='pending');
  const p=core.openedProjection(home.data,s,await shares.placements(s.id,envId),{members,viewer:opidId(user),pending});
  const name=home.name||home.data.environment?.name||'',data=core.openedDb(p,{name});
  const decided=mine.filter(x=>(x.status==='approved'||x.status==='denied')&&x.decidedAt>=new Date(Date.now()-7*CONFLICT_MS).toISOString())
    .map(x=>({id:x.id,status:x.status,at:x.decidedAt,titles:core.proposalPreview(inScope(home.data,s),x).map(r=>r.title).slice(0,5)}));
  const ownerName=await personName(s.ownerEmail);
  data.shares=[{id:s.id,permission:s.permission,adds:core.addsOf(s),ownerEmail:s.ownerEmail,ownerEnv:s.ownerEnv,ownerEnvName:name,name:s.name,members:p.share.members,
    ...(p.share.pending.length?{pending:p.share.pending}:{}),...(decided.length?{decided}:{})}];
  data.opened={shareId:s.id,ownerEnv:s.ownerEnv,ownerEmail:s.ownerEmail,ownerName,permission:s.permission,adds:core.addsOf(s)};
  const since=new Date(Date.now()-CONFLICT_MS).toISOString(),sc=core.resolveScope(home.data,s),conflicts=[];
  for(const e of await shares.history({envId:s.ownerEnv,over:user.email,since,limit:200}))
    if(sc[SCOPE_KEY[e.kind]]?.includes(e.recordId))conflicts.push(core.conflictView(e,{ownerDb:home.data,share:s,members}));
  seenBy(s.ownerEnv,user);
  return {data,rev:home.rev,conflicts,shared:`open:${s.id}:${s.permission}:${core.addsOf(s)}:${home.rev}:${pending.map(x=>x.id+'@'+x.updatedAt).join('+')}:${decided.length}`};
}
// PUT /api/workspace?env=share-<shareId>. Nothing is stored for the recipient: layout becomes placements, edits go
// to the owner (sharedEdits only, as for placed copies, with the same 20-record guard) and new records go through
// the share's additions setting.
async function putOpened(res,envId,user,body){
  const o=await openedShare(envId,user);
  if(!o){json(res,404,{error:'Not found'});return}
  if(o.gone){json(res,410,GONE);return}
  const adds=await planAdds(envId,user,body.data,{},{opened:o}).catch(e=>{console.error('share additions failed',e?.message);return null});
  if(adds?.plans.length)await commitAdds(envId,user,adds.plans).catch(e=>console.error('share additions failed',e?.message));
  const back=await applyRecipientSave(envId,user,body.data,fieldMap(body.sharedEdits)||{},{opened:o}).catch(e=>{console.error('share write-back failed',e?.message);return {}});
  const now=await openedShare(envId,user);
  if(!now||now.gone){json(res,410,GONE);return}
  const v=await openedView(envId,user,now);
  json(res,200,{env:envId,rev:v.rev,shared:v.shared,...(adds?.notAdded?{notAdded:adds.notAdded}:{}),...(back?.bulk?{bulkRefused:true}:{})});
}
// The board's own card edits (sync-core cardEditsOf) from a request body; null if not sent.
function cardEditsBody(v){
  if(!plain(v))return null;
  const changed={},removed={};
  if(plain(v.changed))for(const [id,f] of Object.entries(v.changed))if(plain(f))changed[id]=f;
  if(plain(v.removed))for(const [id,c] of Object.entries(v.removed))if(plain(c))removed[id]=c;
  return {changed,added:Array.isArray(v.added)?v.added.filter(x=>typeof x==='string').slice(0,5000):[],removed};
}
// Whether two workspaces hold the same own DevOps cards, in the same order.
function sameCards(a,b){
  const x=(a?.devops?.cards||[]).filter(c=>!isLinked(c?.id)),y=(b?.devops?.cards||[]).filter(c=>!isLinked(c?.id));
  return x.length===y.length&&x.every((c,i)=>c?.id===y[i]?.id&&sameCard(c,y[i]));
}
const SCOPE_KEY={node:'nodeIds',edge:'edgeIds',project:'projectIds',item:'itemIds',card:'cardIds',agent:'agentIds',workflow:'workflowIds'};
// {kind:{id:{field:value}}} from a request body (fieldBase, sharedEdits), keeping only that shape; null if none.
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fieldMap(v){
  if(!plain(v))return null;const out={};
  for(const kind of Object.keys(SCOPE_KEY))if(plain(v[kind]))for(const [id,f] of Object.entries(v[kind]))if(plain(f))(out[kind]??={})[id]=f;
  return out;
}
// A recipient saved their workspace: layout of linked cards becomes placements, and field edits their
// share permits go to the owner's workspace (with history). Anything else is dropped (it comes back on
// the next read). base: the fields the recipient changed, each with the value it had before (the browser's
// sharedEdits, or for /api/v1 and /mcp a fieldBase from what the read served). Only those are written, so
// a stale copy never overwrites the owner, and an edit that overwrote someone's unseen change records
// them as `over`. A save that changes many records at once is refused (bulkWrite).
// opened: {share} when envId is an opened shared environment (share-<shareId>, openedView): its one share, with
// the opened projection (every chart, AgentFlow). -> {bulk: a save refused for changing too many records}
async function applyRecipientSave(envId,user,data,base,{opened=null}={}){
  const result={bulk:false};
  for(let {share:s} of opened?[opened]:await attachedShares(envId,user)){
    const members=await membersOf(s);
    for(let attempt=0;attempt<3;attempt++){
      const home=await workspaces.get(s.ownerEnv);if(!home?.data||home.archivedAt)break;
      const pending=await shares.proposals({shareId:s.id,proposedBy:user.email,status:'pending'}),place=await shares.placements(s.id,envId);
      const p=opened?core.openedProjection(home.data,s,place,{members,pending}):core.projectForRecipient(home.data,s,place,{members,pending});
      const {placements,edits,pending:pendingEdits}=core.extractRecipientChanges(p,data,base||{});
      if(attempt===0){
        await shares.place(s.id,envId,placements);
        // Edits of the recipient's pending additions change their proposal.
        for(const e of pendingEdits){const cur=pending.find(x=>x.id===e.proposal),next=core.applyPendingEdit(home.data,s,cur,e,user,{members});if(next){await shares.updateProposal(next);Object.assign(cur,next)}}
      }
      const patch=[],hist=[];
      for(const e of edits){
        const r=core.applyRecipientEdit(home.data,s,e,user,{members});if(!r.ok)continue;
        patch.push(...r.ownerDbPatch);hist.push(...r.history);
        // Last write wins; the person whose value this replaced unseen gets a notice on that field.
        if(e.clash)for(const h of r.history.filter(h=>e.clash.includes(h.field))){
          const norm=(x,v)=>core.historyForRecipient(home.data,s,{kind:x.kind,field:x.field,new:v},members).new;
          h.over=core.overwritten(await shares.history({envId:s.ownerEnv,kind:h.kind,recordId:h.recordId,limit:50}),h.field,h.old,user.email,s.ownerEmail,norm)||undefined;
        }
      }
      if(!patch.length)break;
      if(bulkWrite(hist)){result.bulk=true;console.error('share write-back refused: too many records in one save',JSON.stringify({share:s.id,env:envId,records:new Set(hist.map(h=>h.recordId)).size,fields:hist.length}));break}
      const fresh=await shareNow(s);if(!fresh)break;
      if(fresh.permission!==s.permission){s=fresh;continue} // permission changed mid-save: redo the edits under the new one
      const out=await workspaces.put(s.ownerEnv,{baseRev:home.rev,data:core.applyOwnerPatch(home.data,patch),by:user.email,owner:home.owner,visibility:home.visibility,name:home.name});
      if(out.refused)break;
      if(out.conflict)continue;
      await shares.record(hist);break;
    }
  }
  return result;
}
// A last guard against a copy that is only out of date: the browser sends the edits it saw its user make
// (one card at a time on the board), so one save that changes shared fields on BULK_RECORDS or more
// records is a client putting back an old copy (Nov 2026: 60 fields on 43 cards), not edits. Refused.
const BULK_RECORDS=20;
const bulkWrite=hist=>new Set(hist.filter(h=>h.field!=='comment').map(h=>h.kind+'|'+h.recordId)).size>=BULK_RECORDS;
// ---- Additions (docs/sharing.md): records a recipient makes inside a share go to its owner, at once
// (adds 'direct') or as a proposal the owner approves (adds 'approve'). planAdds runs before the recipient's own
// data is saved (what it takes is not stored there), commitAdds after that save succeeded.
// -> {data (submitted, without what the shares took), plans:[{share, mode, plan}], refusal?:{status, code, error}}
// api: the caller is an API key or MCP: an addition the share does not allow is refused (403) instead of
// staying the recipient's own, as it does in the app.
// opened: {share, home} for an opened shared environment: a new record there is meant for the share, and one the
// share cannot take is left out (notAdded counts them: nothing of the recipient's own is kept there).
async function planAdds(envId,user,submitted,stored,{api=false,opened=null}={}){
  let data=submitted;const plans=[];let notAdded=0;
  if(user.token||!submitted)return {data,plans,notAdded};
  for(const {share:s,home} of opened?[opened]:await attachedShares(envId,user)){
    const mode=core.addsOf(s),members=await membersOf(s),known=await shares.proposals({shareId:s.id,proposedBy:user.email,limit:500});
    const plan=core.planAdditions(home.data,s,data,stored,{pending:known.filter(x=>x.status==='pending'),known,members,promote:mode!=='off',opened:!!opened});
    if(opened)notAdded+=plan.refused.length+(mode==='off'?core.proposalSize(plan):0);
    const pendingNow=known.filter(x=>x.status==='pending').length,n=core.proposalSize(plan),what=['card','item','project','node','edge'].find(k=>plan.records[k].length||plan.refused.some(r=>r.kind===k));
    const words={card:'DevOps cards',item:'timeline items',project:'projects',node:'mind map cards',edge:'connections'};
    if(api&&mode==='off'&&(n||plan.refused.length))return {data,plans,refusal:{status:403,code:'share_adds_off',error:`This share does not let you add ${words[what]} to ${s.ownerEmail}'s environment. Ask them to allow additions (Settings › Sharing).`}};
    if(n&&(n>MAX_ADD_RECORDS||(mode==='approve'&&!plan.joins.length&&pendingNow>=MAX_PENDING))){
      if(opened&&mode!=='off')notAdded+=n;
      if(api)return {data,plans,refusal:{status:429,code:'share_adds_full',error:n>MAX_ADD_RECORDS?`Add at most ${MAX_ADD_RECORDS} records at once to a share`:`${pendingNow} additions already wait for ${s.ownerEmail}'s approval. Wait until they decide.`}};
      continue;
    }
    if(api&&plan.refused.length){const r=plan.refused[0];return {data,plans,refusal:r.reason==='out-of-scope'?{status:409,code:'share_add_out_of_scope',error:`That ${r.kind} cannot be added to this share: it would fall outside what is shared`}:{status:400,code:'share_add_refused',error:`That ${r.kind} cannot be added to this share (${r.reason})`}}}
    if(mode==='off'){
      // Additions stay the recipient's own, as before; only stale copies of records proposed earlier leave.
      const stale=plan.taken.filter(t=>!Object.hasOwn(plan.map,t.id));
      if(stale.length){data=core.takeAdditions(data,s.id,{taken:stale,map:{}});plans.push({share:s,mode,plan:{...plan,records:{node:[],edge:[],project:[],item:[],card:[]},map:{},joins:[]}})}
      continue;
    }
    if(!plan.taken.length)continue;
    data=core.takeAdditions(data,s.id,plan);plans.push({share:s,mode,plan});
  }
  return {data,plans,notAdded};
}
// Cards that left the recipient's data for a share's owner are not deletions (lib/workspaces.mjs source.moved).
const movedCards=adds=>{const ids=(adds?.plans||[]).flatMap(p=>p.plan.taken.filter(t=>t.kind==='card').map(t=>t.id));return ids.length?{moved:ids}:{}};
// The owner's mind map cards a share covers, for naming connections in what its recipient is shown.
const inScope=(db,s)=>{const ids=new Set(core.resolveScope(db,s).nodeIds);return {charts:[{nodes:(db.charts||[]).flatMap(c=>c.nodes||[]).filter(n=>ids.has(n.id))}]}};
// A recipient's pending proposals per share, and records per save: past these, additions wait (they stay theirs).
const MAX_PENDING=200,MAX_ADD_RECORDS=500;
// One decision at a time per proposal (a double click must not add its records twice).
const proposalTurns=new Map();
function proposalTurn(id,fn){const run=(proposalTurns.get(id)||Promise.resolve()).then(fn),tail=run.catch(()=>{});proposalTurns.set(id,tail);tail.then(()=>{if(proposalTurns.get(id)===tail)proposalTurns.delete(id)});return run}
const addedHistory=(s,records,map,by,note)=>Object.entries(records).flatMap(([kind,list])=>(list||[]).map(r=>({shareId:s.id,envId:s.ownerEnv,kind,recordId:map?.[r.id]||r.id,field:'added',old:null,new:note||r.name||r.title||'',by,at:new Date().toISOString()})));
// -> {<the id the caller used>: {id (linked id in the recipient's environment), pending}}
async function commitAdds(envId,user,plans){
  const out={};
  for(const {share:s,mode,plan} of plans){
    const members=await membersOf(s);
    // A stale copy sent a pending record again: its fields update the proposal.
    for(const r of plan.resent){
      const cur=await shares.getProposal(r.proposal),home=await workspaces.get(s.ownerEnv);if(!cur||!home?.data)continue;
      const next=core.applyPendingEdit(home.data,s,cur,{kind:r.kind,id:r.id,fields:r.rec},user,{members});if(next)await shares.updateProposal(next);
    }
    if(!core.proposalSize(plan))continue;
    const now=new Date().toISOString(),ids=(map,pending)=>{for(const [lid,oid] of Object.entries(plan.map))out[lid]={id:core.linkedId(s.id,map?.[oid]||oid),pending}};
    const join=plan.joins.length?await shares.getProposal(plan.joins[0]):null;
    if(mode==='direct'&&!(join?.status==='pending')){
      let done=false;
      for(let attempt=0;attempt<4&&!done;attempt++){
        const home=await workspaces.get(s.ownerEnv);if(!home?.data||home.archivedAt)break;
        const fresh=await shareNow(s);if(!fresh||core.addsOf(fresh)!=='direct')break; // revoked or additions turned down mid-save
        const {db,map}=core.applyAdditions(home.data,plan.records);
        const w=await workspaces.put(s.ownerEnv,{baseRev:home.rev,data:db,by:user.email,owner:home.owner,visibility:home.visibility,name:home.name,source:{via:'share'}});
        if(w.refused)break;if(w.conflict)continue;
        await shares.addProposal({id:randomUUID(),shareId:s.id,ownerEnv:s.ownerEnv,ownerEmail:s.ownerEmail,proposedBy:user.email,envId,records:plan.records,status:'applied',createdAt:now,decidedAt:now,decidedBy:user.email,map});
        await shares.record(addedHistory(s,plan.records,map,user.email));
        ids(map,false);done=true;
      }
      if(done)continue;
      // The owner's workspace could not take it (a limit, or it kept changing): it waits as a proposal instead.
    }
    {const cur=await shareNow(s);if(!cur||core.addsOf(cur)==='off')continue} // revoked, or additions off, mid-save: nothing waits
    if(join?.status==='pending'){
      const merged={...join,records:Object.fromEntries(Object.entries(join.records).map(([k,list])=>[k,[...list,...(plan.records[k]||[])]]))};
      if(await shares.updateProposal(merged)){ids(null,true);continue}
    }
    await shares.addProposal({id:randomUUID(),shareId:s.id,ownerEnv:s.ownerEnv,ownerEmail:s.ownerEmail,proposedBy:user.email,envId,records:plan.records,status:'pending',createdAt:now});
    ids(null,true);
  }
  return out;
}
// A proposal as its owner sees it in Settings › Sharing and through the API: what it adds, from whom.
const proposalView=(p,home,s)=>({id:p.id,shareId:p.shareId,env:p.ownerEnv,proposedBy:p.proposedBy,recipientEmail:s?.recipientEmail||p.proposedBy,status:p.status,createdAt:p.createdAt,updatedAt:p.updatedAt||p.createdAt,decidedAt:p.decidedAt||null,decidedBy:p.decidedBy||null,
  preview:core.proposalPreview(home?.data,p),records:p.records});
// The owner approves (the records land in their data, owned by them) or denies (the recipient's pending copy goes).
// -> {status, body}
async function decideShareProposal(id,user,approve,env=null){
  return proposalTurn(id,async()=>{
    for(let attempt=0;attempt<4;attempt++){
      const p=await shares.getProposal(id);if(!p||!sameEmail(p.ownerEmail,user.email)||(env&&p.ownerEnv!==env))return {status:404,body:{error:'No such proposal in this environment',code:'proposal_not_found'}};
      if(p.status!=='pending')return {status:409,body:{error:'Already decided',code:'proposal_decided',proposal:p.status}};
      const s=await shares.get(p.shareId),home=await workspaces.get(p.ownerEnv);
      if(!s||!home?.data)return {status:404,body:{error:'Not found',code:'not_found'}};
      const r=core.decideProposal(home.data,s,p,user,approve);
      if(!r.ok){
        if(r.error==='out-of-scope')return {status:409,body:{error:'Part of this no longer fits the share (what it was added to was removed or is no longer shared). Deny it, or share that part again.',code:'proposal_out_of_scope'}};
        return {status:r.error==='revoked'?410:403,body:{error:r.error==='revoked'?'This share was revoked':'Only the owner can decide',code:'proposal_'+r.error}};
      }
      if(approve){
        const w=await workspaces.put(p.ownerEnv,{baseRev:home.rev,data:r.db,by:user.email,owner:home.owner,visibility:home.visibility,name:home.name,source:{via:'share'}});
        if(w.refused)return {status:w.refused.status||403,body:{error:w.refused.error,code:w.refused.code||'limit'}};
        if(w.conflict)continue;
        await shares.record(addedHistory(s,p.records,r.map,user.email,`Proposed by ${p.proposedBy}`));
      }
      const done=await shares.decideProposal(r.proposal);
      return {status:200,body:{proposal:proposalView(done||r.proposal,approve?{data:r.db}:home,s)}};
    }
    return {status:409,body:{error:'The workspace kept changing; try again',code:'conflict'}};
  });
}
// Proposals for an environment: to its owner (from its shares' recipients), and the caller's own made from it.
async function proposalsFor(envId,user,{status}={}){
  const w=await workspaces.get(envId);if(!w)return [];
  const out=[];
  if(sameEmail(w.owner,user.email)){const list=await shares.list({ownerEnv:envId});
    for(const p of await shares.proposals({ownerEnv:envId,ownerEmail:user.email,status:status||undefined,limit:200}))if(p.status!=='applied'||status==='applied')out.push({...proposalView(p,w,list.find(s=>s.id===p.shareId)),role:'owner'})}
  for(const p of await shares.proposals({proposedBy:user.email,status:status||undefined,limit:200}))if(p.envId===envId){const h=await workspaces.get(p.ownerEnv),s=await shares.get(p.shareId);out.push({...proposalView(p,h&&s?{data:inScope(h.data,s)}:null,null),records:undefined,role:'proposer'})}
  return out;
}
// The owner saved an environment that has shares: changes to shared records become field history (so
// recipients see who changed what), and one that overwrote a recipient's unseen change records them as
// `over` (they get a notice on that field).
async function recordOwnerChanges(envId,user,before,after,base){
  if(!before||!after)return;
  const list=await shares.list({ownerEnv:envId});if(!list.length)return;
  const entries=core.ownerChanges(before,after,list,user,base),byId=new Map(list.map(s=>[s.id,s])),found=new Map();
  for(const e of entries){
    if(!e.clash)continue;
    const k=[e.kind,e.recordId,e.field].join('|');
    if(!found.has(k)){
      // A recipient's entry holds the people they could see: compare in their terms.
      const norm=(x,v)=>x.field==='assignees'&&byId.get(x.shareId)?core.historyForRecipient(before,byId.get(x.shareId),{kind:x.kind,field:x.field,new:v}).new:v;
      found.set(k,core.overwritten(await shares.history({envId,kind:e.kind,recordId:e.recordId,limit:50}),e.field,e.old,user.email,'',norm));
    }
    if(found.get(k))e.over=found.get(k);
  }
  await shares.record(entries.map(({clash,...e})=>e));
}
// ---- combined view (docs/combined.md) ----
// The other environments a request asks to combine (?combine=a,b) that this user owns: [{envId, w}].
async function combinable(homeEnv,user,list){
  if(!user||user.token)return [];
  const out=[];
  for(const id of combined.cleanCombine(list,homeEnv)){
    const w=await workspaces.get(id).catch(()=>null);
    if(w?.data&&!w.archivedAt&&sameEmail(w.owner,user.email))out.push({envId:id,w});
  }
  return out;
}
// The home workspace as served (v: withShares' result) with the combined environments' records in it.
// shared gets each one's revision (and its shares' signature), so a client polling with ?since hears of
// their changes too.
async function withCombined(homeEnv,user,v,list){
  if(!v?.data)return v;
  const envList=await combinable(homeEnv,user,list);if(!envList.length)return v;
  const projections=[],sig=[];
  for(const {envId,w} of envList){
    try{
      const s=await withShares(envId,user,w.data);
      projections.push(combined.projectEnv(normalizeDb(structuredClone(s.data)),{env:envId,name:w.name||s.data.environment?.name||'Workspace',rev:w.rev}));
      sig.push(`cx:${envId}:${w.rev}${s.shared?':'+s.shared:''}`);
    }catch(e){console.error('combined projection failed',e?.message)}
  }
  return {...v,data:combined.applyCombined(v.data,projections),shared:[v.shared,...sig].filter(Boolean).join(',')};
}
// A home save that changed combined records: each edit goes to the record's own environment (only the
// fields shared records allow, only those this user changed: base is the browser's sharedEdits), through the same path as a save there,
// so edits to shares placed in that environment go on to their owner. Never creates or deletes anything.
async function applyCombinedSave(homeEnv,user,data,base){
  for(const {envId} of await combinable(homeEnv,user,combined.combinedEnvs(data))){
    for(let attempt=0;attempt<3;attempt++){
      const w=await workspaces.get(envId);if(!w?.data||w.archivedAt)break;
      const served=normalizeDb(structuredClone((await withShares(envId,user,w.data)).data));
      const out=combined.combinedEdits(served,data,base,envId);if(!out.edits.length)break;
      // The same last guard as for shares (bulkWrite): one save changing many records is an old copy, not edits.
      if(bulkWrite(out.edits.map(e=>({kind:e.kind,recordId:e.id,field:e.field})))){console.error('combined write-back refused: too many records in one save',JSON.stringify({env:envId,records:new Set(out.edits.map(e=>e.kind+'|'+e.id)).size}));break}
      const next=normalizeDb(out.data),stored=stripLinked(next),before=stripLinked(served);
      let ok=true;
      if(JSON.stringify(stored)!==JSON.stringify(before)){
        const put=await workspaces.put(envId,{baseRev:w.rev,data:keepCounters(w.data,{...stored,environment:{...(stored.environment||{}),id:envId,ownerEmail:w.owner}}),by:user.email,owner:w.owner,visibility:w.visibility,name:w.name,source:{via:'save'},opidUser:opidId(user)});
        if(put.conflict)continue;
        ok=!put.refused;
        if(ok)await recordOwnerChanges(envId,user,before,stored,out.base).catch(e=>console.error('share history failed',e?.message));
      }
      if(ok)await applyRecipientSave(envId,user,next,out.base).catch(e=>console.error('share write-back failed',e?.message));
      break;
    }
  }
}
// A new, empty workspace (one blank chart) for an environment.
const emptyWorkspace=(id,name,owner)=>({active:'chart-'+id,charts:[{id:'chart-'+id,name:'Untitled chart',nodes:[],edges:[]}],projects:[],timeline:[],environment:{id,name,ownerEmail:owner,visibility:'private',members:[]}});
async function createEnvironment(user,name){
  const id=randomUUID();name=String(name||'My workspace').trim().slice(0,80)||'My workspace';
  const out=await workspaces.put(id,{baseRev:0,data:emptyWorkspace(id,name,user.email),by:user.email,owner:user.email,name});
  if(out.refused){const e=Error(out.refused.error);e.refused=out.refused;throw e}
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
      // The mirror is this environment's own data: never the records of environments combined with it.
      if(r&&r.status===200&&r.data?.env&&r.data.data&&!core.parseOpenedEnv(r.data.env)){await workspaces.put(r.data.env,{baseRev:(await workspaces.get(r.data.env))?.rev||0,data:combined.stripCombined(r.data.data),by:'relay',owner:user.email,mirror:true}).catch(()=>{})}
      if(r){json(res,r.status,{...r.data,relayed:true,via:SYNC_HOST});return true}
      const w=await workspaces.get(u.searchParams.get('env')||DEFAULT_ENV.id);
      json(res,200,{env:w?.envId||u.searchParams.get('env')||DEFAULT_ENV.id,rev:0,data:w?.data||null,offline:true});return true;
    }
    let envId=u.searchParams.get('env');
    if(envId&&!ENV_ID.test(envId)){json(res,400,{error:'Bad environment id'});return true}
    // An opened shared environment (share-<shareId>): the owner's, through the share.
    if(core.parseOpenedEnv(envId)){
      const o=await openedShare(envId,user);
      if(!o){json(res,404,{error:'Not found'});return true}
      if(o.gone){json(res,410,GONE);return true}
      const v=await openedView(envId,user,o),since=parseInt(u.searchParams.get('since'));
      if(since===v.rev&&(u.searchParams.get('shared')||'')===v.shared){json(res,200,{env:envId,rev:v.rev,shared:v.shared,unchanged:true});return true}
      json(res,200,{env:envId,rev:v.rev,data:v.data,shared:v.shared,conflicts:v.conflicts,updatedAt:o.home.updatedAt||null,owner:o.share.ownerEmail,opened:v.data.opened});
      return true;
    }
    let w=envId?await workspaces.get(envId):null;
    // No environment named: the owner's is Default workspace (even before it has data); others get their newest.
    if(!envId){const owner=sameEmail(user.email,auth.OWNER_EMAIL);w=owner?await workspaces.get(DEFAULT_ENV.id):null;w||=await workspaces.ownedBy(user.email);envId=w?.envId||(owner?DEFAULT_ENV.id:null)}
    // Someone signed in for the first time (invited, or open sign-up): their own new, empty environment.
    if(!envId&&!user.token){envId=await createEnvironment(user,'My workspace');w=await workspaces.get(envId)}
    if(!envId){json(res,200,{env:null,rev:0,data:null});return true}
    if(w?.archivedAt){json(res,404,{error:'Not found'});return true}
    const e={...(envs.get(envId)||{id:envId,ownerEmail:'',visibility:'private',members:[],unregistered:!w}),...(w?{ownerEmail:w.owner,visibility:w.visibility}:{})};
    if(!canRead(e,user)&&!(e.unregistered&&!w)){json(res,404,{error:'Not found'});return true}
    const since=parseInt(u.searchParams.get('since')),mine=sameEmail(ownerOf(w,envId),user.email);
    // Linked copies are added for the environment's owner only; anyone else gets the stored data as is.
    let v=mine?await withShares(envId,user,w?.data||null):{data:dropDangling(w?.data?structuredClone(stripLinked(w.data)):null),shared:''};
    // Other environments of this user combined into this one's board and timeline (?combine=a,b).
    if(mine&&u.searchParams.get('combine'))v=await withCombined(envId,user,v,u.searchParams.get('combine'));
    // Only the owner sees whose account a card is linked to; other readers see their own link only.
    if(!mine&&v.data)opidPhotos.maskOpidLinks(v.data,opidId(user));
    if(mine&&w)seenBy(envId,user);
    if(w&&since===w.rev&&(u.searchParams.get('shared')||'')===v.shared){json(res,200,{env:envId,rev:w.rev,shared:v.shared,unchanged:true});return true}
    json(res,200,{env:envId,rev:w?.rev||0,data:v.data,shared:v.shared,conflicts:v.conflicts||[],updatedAt:w?.updatedAt||null,owner:ownerOf(w,envId),readOnly:!!w&&!mine});
    return true;
  }
  if(req.method==='PUT'){
    if(req.headers['content-type']!=='application/json'){res.writeHead(415);res.end();return true}
    readBody(req,res,async raw=>{
      try{
        if(local){
          const r=await relay(req,raw);
          // Keep this computer's copy current too: it is the offline fallback.
          if(r?.status===200){try{const b=JSON.parse(raw),id=u.searchParams.get('env');if(ENV_ID.test(id||'')&&!core.parseOpenedEnv(id)){const cur=await workspaces.get(id);await workspaces.put(id,{baseRev:cur?.rev||0,data:carryRunners(cur?.data,combined.stripCombined(b.data)).data,by:'relay',owner:user.email,source:{via:'relay'},mirror:true})}}catch{}}
          if(r){json(res,r.status,{...r.data,relayed:true,via:SYNC_HOST});return}
          json(res,503,{error:'Offline: the server could not be reached',offline:true});return;
        }
        const envId=u.searchParams.get('env');
        if(!envId||!ENV_ID.test(envId)){json(res,400,{error:'Bad environment id'});return}
        let body;try{body=JSON.parse(raw)}catch{}
        if(!body||!Number.isInteger(body.baseRev)||!validDb(body.data)){json(res,400,{error:'Expected {baseRev, data}'});return}
        if(core.parseOpenedEnv(envId)){await putOpened(res,envId,user,body);return}
        const w=await workspaces.get(envId),reg=envs.get(envId);
        if(w?.archivedAt){json(res,404,{error:'Not found'});return}
        const owner=w?.owner||reg?.ownerEmail||(envId===DEFAULT_ENV.id?auth.OWNER_EMAIL:user.email);
        if(!sameEmail(owner,user.email)){json(res,w&&(w.visibility==='public')?403:404,{error:w?.visibility==='public'?'This environment is read-only for you':'Not found'});return}
        // Records made inside a share that lets its recipient add go to its owner (planAdds), not into this save.
        const adds=user.token?null:await planAdds(envId,user,body.data,w?stripLinked(w.data):null).catch(e=>{console.error('share additions failed',e?.message);return null});
        if(adds)body.data=adds.data;
        // Linked copies of shared records are not stored (they are re-projected on every read).
        let incoming=stripLinked(body.data);const stored=w?stripLinked(w.data):null;
        // DevOps cards (card #447): a copy of the board can be out of date, and sending it whole put old
        // descriptions and columns back on cards agents had just changed. The board says which cards and
        // fields it changed (cardEdits); everything else stays as stored. A tab running older code sends
        // the whole board as it holds it, so when that would change cards it is asked to reload instead.
        const cardEdits=cardEditsBody(body.cardEdits);let cardsKept=false;
        if(stored&&!cardEdits&&!user.token&&body.intent&&!sameCards(stored,incoming)){json(res,428,{error:'Flow was updated. Reload this page to keep saving (your last change was not saved).',code:'reload_required'});return}
        if(stored&&cardEdits&&w.rev===body.baseRev){
          const r=applyCardEdits(stored.devops?.cards,incoming.devops?.cards,cardEdits);
          if(r.clashes.length){json(res,409,{error:'Someone else changed these cards meanwhile',code:'card_conflict',clashes:r.clashes,rev:w.rev,data:(await withCombined(envId,user,await withShares(envId,user,w.data),u.searchParams.get('combine')||'')).data});return}
          // A card whose content changes gets a newer updated than the one stored, so an API client holding the
          // old one (ifUpdated) is refused: a merged or undone copy can carry an updated that is not newer.
          const was=new Map((stored.devops?.cards||[]).map(c=>[c?.id,c])),at=new Date().toISOString();let stamped=false;
          const later=t=>{const x=Date.parse(t);return Number.isFinite(x)&&x>=Date.parse(at)?new Date(x+1).toISOString():at};
          const cards=r.cards.map(c=>{const o=was.get(c?.id);if(!o||sameCard(o,c)||String(c.updated||'')>String(o.updated||''))return c;stamped=true;return {...c,updated:later(o.updated)}});
          incoming={...incoming,devops:{...(incoming.devops||{}),cards}};cardsKept=r.ignored>0||stamped;
        }
        if(w&&w.rev===body.baseRev&&shrinks(stored,incoming)&&!body.allowShrink){json(res,422,{error:`This save would remove most of the workspace (${size(stored)} → ${size(incoming)} things). Nothing was changed.`,shrink:true});return}
        // Runners are the server's (only runners.report changes them): a save never drops or rolls back
        // what a runner reported, e.g. a tab running older code that saves runners without their jobs.
        const kept=carryRunners(w?.data,incoming);
        // Card numbers only grow. A browser that sent a lower one reads the workspace back (below).
        const counted=keepCounters(w?.data,kept.data);
        const data={...counted,environment:{...(kept.data.environment||{}),id:envId,ownerEmail:owner}};
        // Why cards left (lib/workspaces.mjs records each one): deleted on the board, an undo, or else a
        // snapshot (a restored or merged whole workspace). Tabs running older code send no intent: 'save'.
        const it=body.intent&&typeof body.intent==='object'&&!Array.isArray(body.intent)?body.intent:null;
        const source={...(it?{via:it.undo?'undo':'snapshot',board:Array.isArray(it.deleted)?it.deleted.filter(x=>typeof x==='string').slice(0,500):[]}:{via:'save'}),...movedCards(adds)};
        const out=await workspaces.put(envId,{baseRev:body.baseRev,data,by:user.email,owner,visibility:data.environment.visibility==='public'?'public':'private',name:String(data.environment.name||reg?.name||'').slice(0,80),source,opidUser:opidId(user)});
        if(out.refused){json(res,out.refused.status,{error:out.refused.error,code:out.refused.code,limit:true});return}
        if(out.conflict){json(res,409,{error:'The server has newer changes',rev:out.current?.rev||0,data:out.current?.data?(await withCombined(envId,user,await withShares(envId,user,out.current.data),u.searchParams.get('combine')||'')).data:null});return}
        envs.claim(data,{email:owner});
        // What the browser's copy held before each change (sync-core fieldBase): tells the owner's edits from
        // a merge that kept a value they never saw (conflict notices).
        const base=fieldMap(body.fieldBase);
        await recordOwnerChanges(envId,user,stored,data,base).catch(e=>console.error('share history failed',e?.message));
        // Additions first (after the save, so a 409 changes nothing).
        if(adds?.plans.length)await commitAdds(envId,user,adds.plans).catch(e=>console.error('share additions failed',e?.message));
        // Placements, and the edits of linked records this user actually made (sync-core noteEdits; after the
        // save, so a 409 changes nothing). Never the difference between the copy sent and the owner's: a
        // copy can be out of date (an old tab, a browser that could not store its latest copy), and a tab
        // running older code sends no sharedEdits, so its copy changes nothing on the owner's side.
        if(!user.token)await applyRecipientSave(envId,user,body.data,fieldMap(body.sharedEdits)||{}).catch(e=>console.error('share write-back failed',e?.message));
        // Edits this user made to combined records go to their own environments (never stored here:
        // stripLinked above), from sharedEdits only, like shared records.
        if(!user.token)await applyCombinedSave(envId,user,body.data,fieldMap(body.sharedEdits)||{}).catch(e=>console.error('combined write-back failed',e?.message));
        const v=user.token?{shared:''}:await withCombined(envId,user,await withShares(envId,user,data),u.searchParams.get('combine')||'');
        // Cards removed other than by Delete: the browser says where to restore them (DevOps › Recently deleted).
        const removed=(out.deleted||[]).filter(e=>e.via!=='board').map(e=>({id:e.id,number:e.number,title:e.title}));
        // OneProfileID links this save tried to add for someone else were refused: the browser reads the workspace back.
        if(out.opidRefused?.length)photoCache.clear();
        json(res,200,{env:envId,rev:out.rev,shared:v.shared,...(out.publicRefused?{publicRefused:out.publicRefused}:{}),...(out.opidRefused?.length?{opidRefused:out.opidRefused}:{}),...(kept.changed?{runnersKept:true}:{}),...(counted!==kept.data?{countersKept:true}:{}),...(cardsKept?{cardsKept:true}:{}),...(removed.length?{removedCards:removed}:{})});
      }catch(e){json(res,500,{error:'Could not save the workspace'})}
    });
    return true;
  }
  res.writeHead(405);res.end();return true;
}

// ---------- OneProfileID photos on person cards (docs/concepts/10-opid-photos.md) ----------
// GET  /api/opid/photos?env=<id>              -> {<node id>: image} for linked cards this user sees there
// POST /api/opid/link {env, nodeId, link}     link:true links the card to the user's own account; false unlinks
// Photos are looked up live (OneProfileID decides too), cached a minute per viewer, never stored.
const PHOTO_TTL=60e3,photoCache=new Map();
// Emails with access to an environment right now: its owner and the recipients of its active shares.
async function currentPeople(envId){
  const w=await workspaces.get(envId);if(!w||w.archivedAt)return new Set();
  return new Set([String(w.owner||'').toLowerCase(),...(await shares.list({ownerEnv:envId})).map(s=>s.recipientEmail.toLowerCase())]);
}
async function lookupPhotos(req,targets){
  const byEnv=new Map();for(const t of targets)(byEnv.get(t.env)||byEnv.set(t.env,new Set()).get(t.env)).add(t.opidUser);
  const members=new Map();
  for(const [env,ids] of byEnv){const now=await currentPeople(env);members.set(env,new Set((await opidMembers.list(env,[...ids])).filter(m=>now.has(m.email)).map(m=>m.opidUser)))}
  const ok=opidPhotos.eligibleTargets(targets,members);if(!ok.length)return {};
  const images=await auth.memberImages(req,ok.map(t=>t.opidUser)),out={};
  for(const t of ok)if(images[t.opidUser])out[t.nodeId]=images[t.opidUser];
  return out;
}
const findNode=(d,id)=>(d?.charts||[]).flatMap(c=>c.nodes||[]).find(n=>n.id===id);
async function opidApi(req,res){
  const u=new URL(req.url,'http://x');if(!u.pathname.startsWith('/api/opid/'))return false;
  if(!trusted(req)||req.headers.authorization){res.writeHead(403);res.end();return true}
  const user=await requireUser(req,res);if(!user)return true;
  const me=opidId(user);
  if(u.pathname==='/api/opid/photos'&&req.method==='GET'){
    const envId=u.searchParams.get('env')||'';
    if(!me||!ENV_ID.test(envId)){json(res,200,{});return true}
    const key=me+'\n'+envId,hit=photoCache.get(key);
    if(hit&&Date.now()-hit.at<PHOTO_TTL){json(res,200,hit.photos);return true}
    let photos={};
    try{
      const w=await workspaces.get(envId);
      if(w?.data&&!w.archivedAt){
        const mine=sameEmail(w.owner,user.email),e={...(envs.get(envId)||{id:envId,members:[]}),ownerEmail:w.owner,visibility:w.visibility};
        if(mine||canRead(e,user))photos=await lookupPhotos(req,opidPhotos.photoTargets({envId,own:stripLinked(w.data),shared:mine?await attachedShares(envId,user):[]}));
      }
    }catch(err){console.error('opid photos failed',err?.message);photos={}}
    photoCache.set(key,{at:Date.now(),photos});
    if(photoCache.size>500)for(const [k,v] of photoCache)if(Date.now()-v.at>=PHOTO_TTL||photoCache.size>400)photoCache.delete(k);
    json(res,200,photos);return true;
  }
  if(u.pathname==='/api/opid/link'&&req.method==='POST'){readJson(req,res,async b=>{
    try{
      if(!me)return json(res,400,{error:'Sign in with OneProfileID to link a card to your account.'});
      const envId=b?.env,nodeId=b?.nodeId;
      if(!ENV_ID.test(String(envId||''))||typeof nodeId!=='string'||!nodeId||nodeId.length>300||typeof b.link!=='boolean')return json(res,400,{error:'Expected {env, nodeId, link}'});
      const w=await workspaces.get(envId);
      if(!w?.data||w.archivedAt||!sameEmail(w.owner,user.email))return json(res,404,{error:'Not found'});
      // A shared card (sh.<share>.<id>) is linked in its owner's workspace, if the share is placed here.
      const p=core.parseLinkedId(nodeId);let share=null,target={env:envId,id:nodeId};
      if(p){
        const a=(await attachedShares(envId,user)).find(x=>x.share.id===p.shareId);
        if(!a||!core.resolveScope(a.home.data,a.share).nodeIds.includes(p.id))return json(res,404,{error:'Not found'});
        share=a.share;target={env:share.ownerEnv,id:p.id};
      }
      for(let attempt=0;attempt<3;attempt++){
        const home=await workspaces.get(target.env);if(!home?.data||home.archivedAt)return json(res,404,{error:'Not found'});
        const data=structuredClone(home.data),n=findNode(data,target.id);
        if(!n||n.type!=='person')return json(res,404,{error:'Not found'});
        const cur=validOpidUser(n.opidUser)?n.opidUser:'';
        if(b.link){
          if(cur===me)return json(res,200,{linked:true});
          if(cur)return json(res,409,{error:'This card is linked to someone else. Unlink it first.'});
          // Only the person the card names may claim it: its email must be their verified sign-in email.
          // The explicit request plus that match is the claim; neither alone links anything.
          if(!n.email||!sameEmail(n.email,user.email))return json(res,403,{error:'Add your email to this card before linking it to your OneProfileID.'});
          n.opidUser=me;
        }else{
          if(!cur)return json(res,200,{linked:false});
          // Anyone may unlink their own account; someone else's link needs edit access to the card.
          if(cur!==me&&share&&!core.allows(share,'edit'))return json(res,403,{error:'Only people who can edit this card can unlink it.'});
          delete n.opidUser;
        }
        const out=await workspaces.put(target.env,{baseRev:home.rev,data,by:user.email,owner:home.owner,visibility:home.visibility,name:home.name,source:{via:'opid-link'},opidUser:me});
        if(out.refused)return json(res,out.refused.status,{error:out.refused.error,code:out.refused.code});
        if(out.conflict)continue;
        photoCache.clear();if(b.link)seenBy(target.env,user);
        return json(res,200,{linked:b.link,rev:out.rev});
      }
      json(res,409,{error:'The workspace changed. Try again.'});
    }catch(err){console.error('opid link failed',err?.message);json(res,500,{error:'Could not change the link. Try again.'})}
  });return true}
  json(res,404,{error:'Not found'});return true;
}

// ---------- chat with OneProfileID friends (lib/chat.mjs, docs/concepts/11-chat.md) ----------
// A Flow card in a message is a link to its environment and id. resolveCards looks each one up with the
// viewer's own access, the same rules as reading the workspace: its owner and readers of the environment
// see it; a share recipient sees it as the share shows it (and opens their linked copy); anyone else
// gets {access:false} with nothing about the card, not even whether it exists.
const {chatRoutes}=await import('./lib/chat.mjs');
const chatCore=await import('./public/chat-core.js');
async function resolveCards(req,user,refs){
  const homes=new Map(),home=env=>homes.get(env)||homes.set(env,workspaces.get(env).catch(()=>null)).get(env);
  let incoming=null;const mineShares=async()=>incoming??=(user.token||user.key?[]:(await shares.list({recipientEmail:user.email})).filter(s=>!s.revokedAt));
  const out=[];
  for(const ref of refs){
    try{
      const w=await home(ref.env);
      if(!w?.data||w.archivedAt){out.push({access:false});continue}
      const e={...(envs.get(ref.env)||{id:ref.env,members:[]}),ownerEmail:w.owner,visibility:w.visibility};
      if(sameEmail(w.owner,user.email)||canRead(e,user)){
        const card=chatCore.summarize(stripLinked(w.data),ref);
        out.push(card?{access:true,card,open:{env:ref.env,id:ref.id}}:{access:false});continue;
      }
      let found=null;
      for(const s of (await mineShares()).filter(x=>x.ownerEnv===ref.env)){
        const sc=core.resolveScope(w.data,s);
        if(!(ref.kind==='card'?sc.cardIds:sc.nodeIds).includes(ref.id))continue;
        // Exactly what the share shows its recipient (assignees, labels and projects limited to its scope).
        const p=core.projectForRecipient(w.data,s,[],{members:await membersOf(s),viewer:opidId(user)});if(!p)continue;
        const id=core.linkedId(s.id,ref.id);
        const card=chatCore.summarize({charts:[{nodes:p.nodes}],projects:p.projects,devops:{cards:p.cards,labels:p.labels},shares:[{members:p.share.members}]},{kind:ref.kind,id});
        if(!card)continue;
        // It opens where the recipient placed the share (one of their own environments), if anywhere.
        let at=null;for(const envId of await shares.envsFor(s.id)){const mine=await workspaces.get(envId);if(mine&&!mine.archivedAt&&sameEmail(mine.owner,user.email)){at=envId;break}}
        found={access:true,card,open:at?{env:at,id}:null};break;
      }
      out.push(found||{access:false});
    }catch(err){console.error('chat card lookup failed',err?.message);out.push({access:false})}
  }
  return out;
}
const chatApi=chatRoutes({mode:auth.mode,userFor:auth.userFor,call:auth.opidMessages,out:auth.outCookies,trusted,readJson,resolveCards});

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
    // Environments shared with this user as a whole (active whole-environment shares): they open as share-<shareId>.
    const shared=[];
    if(!user.token)for(const s of await shares.list({recipientEmail:user.email}).catch(()=>[])){
      if(!core.canOpen(s))continue;const w=await workspaces.get(s.ownerEnv).catch(()=>null);if(!w?.data||w.archivedAt)continue;
      shared.push({id:core.openedEnvId(s.id),shareId:s.id,name:w.name||w.data.environment?.name||'Workspace',ownerEmail:s.ownerEmail,ownerName:await personName(s.ownerEmail),permission:s.permission,adds:core.addsOf(s)});
    }
    json(res,200,{environments:own.map(w=>({id:w.envId,name:w.name||w.data?.environment?.name||'Workspace',visibility:w.visibility,rev:w.rev,updatedAt:w.updatedAt})),shared});return true;
  }
  if(!id&&req.method==='POST'){readJson(req,res,async b=>{
    try{json(res,200,{id:await createEnvironment(user,b?.name)})}
    catch(e){if(e.refused)json(res,e.refused.status,{error:e.refused.error,code:e.refused.code});else json(res,500,{error:'Could not create the environment'})}
  });return true}
  if(!id||!ENV_ID.test(id)){json(res,404,{error:'Not found'});return true}
  if(req.method==='DELETE'&&id===DEFAULT_ENV.id&&sameEmail(user.email,auth.OWNER_EMAIL)){json(res,400,{error:"Default workspace cannot be removed"});return true}
  const w=await workspaces.get(id);
  if(!w||w.archivedAt||!sameEmail(w.owner,user.email)){json(res,404,{error:'Not found'});return true}
  if(req.method==='PATCH'){
    readJson(req,res,async b=>{
      const name=b?.name!==undefined?String(b.name).trim().slice(0,80):w.name,visibility=b?.visibility==='public'?'public':b?.visibility==='private'?'private':w.visibility;
      if(!name){json(res,400,{error:'A name is required'});return}
      if(visibility==='public'&&w.visibility!=='public'){const why=await workspaces.publicRefusal(w.owner);if(why){json(res,403,{error:why,code:'public_too_soon'});return}}
      const data={...w.data,environment:{...(w.data.environment||{}),id,name,visibility,ownerEmail:w.owner}};
      const out=await workspaces.put(id,{baseRev:w.rev,data,by:user.email,owner:w.owner,visibility,name});
      if(out.refused){json(res,out.refused.status,{error:out.refused.error,code:out.refused.code});return}
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
// ---------- app invites: members invite an email to Flow itself, and the invite email is sent ----------
const mailer=createMailer();
const APP_URL=(auth.appOrigin||process.env.FLOW_PUBLIC_URL||'http://127.0.0.1:4317').replace(/\/+$/,'');
// Invite emails are limited per sender and per recipient in persistent windows (they survive deploys).
async function mailLimit(sender,recipient){
  if(!await rates.take('mail:s:'+sender.toLowerCase(),20,3600e3))return 'You have sent a lot of invites in the last hour. Try again later.';
  if(!await rates.take('mail:r:'+recipient.toLowerCase(),3,3600e3))return 'This person was emailed several times in the last hour. Try again later.';
  return '';
}
// The inviter's name as OneProfileID has it: the signed-in session's, or for the owner token the
// owner's from their last sign-in. Never a name typed into Flow.
async function inviterName(user){
  if(!user.token)return user.name||'';
  return (await users.get(auth.OWNER_EMAIL).catch(()=>null))?.name||'';
}
async function sendInvite(email,user,{link=APP_URL}={}){
  if(!mailer.configured)return {ok:false,notConfigured:true,error:'Email is not configured'};
  const why=await mailLimit(user.email,email);if(why)return {ok:false,error:why};
  return mailer.send({to:email,...inviteEmail({to:email,appUrl:APP_URL,link,inviter:await inviterName(user)})});
}
// The invite link: a OneProfileID invitation token when the registration allows invitations (one use,
// 72 hours, bound to the address), else the join page with the address only (matched at sign-in).
async function inviteLink(req,invite){
  const t=await auth.opidInvite(req,{localId:invite.localId,email:invite.email}).catch(()=>null);
  const q=new URLSearchParams(t?{invite:t.token,email:invite.email}:{email:invite.email});
  return {link:`${APP_URL}/join?${q}`,token:!!t};
}
const WEEK=7*864e5;
async function invitesApi(req,res){
  const u=new URL(req.url,'http://x');if(u.pathname!=='/api/invites')return false;
  // The owner token works here too (tools/env.mjs invite|invites|revoke); a wrong token is refused.
  const tok=tokenUser(req);
  if(!tok&&req.headers.authorization){json(res,401,{error:'Invalid token'});return true}
  if(!tok&&!trusted(req)){res.writeHead(403);res.end();return true}
  const user=tok||await requireUser(req,res);if(!user)return true;
  // Any member may invite friends: the owner without limit, others FLOW_MEMBER_INVITES_PER_WEEK in a
  // rolling week. Members see and manage only the invites they sent.
  const isOwner=isOwnerEmail(user.email),L=limitsOf(user.email),quotaKey='invite:m:'+user.email.toLowerCase();
  const quota=async()=>isOwner?null:{limit:L.invitesPerWeek,used:await rates.count(quotaKey,WEEK)};
  const mine=async()=>(await invites.list()).filter(i=>isOwner||sameEmail(i.invitedBy,user.email));
  if(req.method==='GET'){json(res,200,{invites:await mine(),quota:await quota(),...(isOwner?{requests:await accessRequests.list()}:{})});return true}
  // POST {email[, resend:true][, send:false]}: record (or re-open) the invite, then email it unless
  // send:false. resend:true only emails an existing, not revoked invite.
  if(req.method==='POST'){readJson(req,res,async b=>{
    if(!validEmail(b?.email)){json(res,400,{error:'Enter a valid email address'});return}
    if(sameEmail(b.email,auth.OWNER_EMAIL)||sameEmail(b.email,user.email)){json(res,400,{error:isOwner||sameEmail(b.email,user.email)?'That is you':'That person is already in Flow'});return}
    if(!isOwner&&await users.get(b.email)){json(res,409,{error:`${b.email.trim().toLowerCase()} already uses Flow. Share with them from the Share button instead.`});return}
    let invite=await invites.find(b.email);
    if(b.resend){if(!invite||invite.revokedAt||(!isOwner&&!sameEmail(invite.invitedBy,user.email))){json(res,404,{error:'No open invite for that email'});return}}
    else if(invite&&!invite.revokedAt&&!isOwner&&!sameEmail(invite.invitedBy,user.email)){json(res,409,{error:'Someone already invited that person.'});return}
    if(!isOwner&&b.send!==false&&!await rates.take(quotaKey,L.invitesPerWeek,WEEK)){
      json(res,429,{error:`You can send ${L.invitesPerWeek} invites a week. Try again in a few days.`,code:'invite_quota',quota:await quota()});return}
    if(!b.resend){invite=await invites.add(b.email,isOwner?auth.OWNER_EMAIL:user.email);await accessRequests.remove(b.email).catch(()=>{})}
    if(b.send===false){json(res,200,{invite,sent:false});return}
    const {link,token}=await inviteLink(req,invite);
    const mail=await sendInvite(invite.email,user,{link});
    json(res,200,{invite,sent:mail.ok,token,quota:await quota(),...(mail.ok?{}:{emailError:mail.error,notConfigured:!!mail.notConfigured,link})});
  });return true}
  if(req.method==='DELETE'){
    const i=await invites.find(u.searchParams.get('email'));
    // Revoking an invite someone already used removes them from Flow: that is the owner's to do.
    if(i?.claimedAt&&!i.revokedAt){
      if(!isOwner){json(res,403,{error:'Only the owner can remove someone who joined.'});return true}
      const r=await memberships.revoke({localId:i.localId,email:(await users.byLocalId(i.localId))?.email||i.email,by:user.email});
      await invites.revoke(i.email);
      json(res,200,{revoked:true,removed:true,opidRevoked:r.opidRevoked});return true;
    }
    if(i&&(isOwner||sameEmail(i.invitedBy,user.email)))await invites.revoke(i.email);
    json(res,200,{revoked:true});return true;
  }
  res.writeHead(405);res.end();return true;
}

// ---------- people in Flow: the owner sees who joined and can remove someone ----------
//   GET    /api/members                 owner: everyone who signed in, with removals
//   DELETE /api/members?email=<address> owner: revoke their membership (here and on OneProfileID), end
//                                        their sessions and disable their API keys. Their data stays.
async function membersApi(req,res){
  const u=new URL(req.url,'http://x');if(u.pathname!=='/api/members')return false;
  const tok=tokenUser(req);
  if(!tok&&req.headers.authorization){json(res,401,{error:'Invalid token'});return true}
  if(!tok&&!trusted(req)){res.writeHead(403);res.end();return true}
  const user=tok||await requireUser(req,res);if(!user)return true;
  if(!isOwnerEmail(user.email)){json(res,403,{error:'Only the owner manages who is in Flow'});return true}
  if(req.method==='GET'){
    const {list}=await revocations.active(),gone=new Map(list.filter(r=>r.email).map(r=>[r.email,r.revokedAt]));
    const members=(await users.list()).map(m=>({email:m.email,name:m.name,firstSeen:m.firstSeen,lastSeen:m.lastSeen,owner:isOwnerEmail(m.email),removedAt:gone.get(m.email)||null}));
    json(res,200,{members});return true;
  }
  if(req.method==='DELETE'){
    const email=String(u.searchParams.get('email')||'').trim().toLowerCase();
    if(isOwnerEmail(email)){json(res,400,{error:'The owner cannot be removed'});return true}
    const m=await users.get(email);if(!m){json(res,404,{error:'Nobody with that email uses Flow'});return true}
    const localId=await localIdOf(m);
    if(!localId||localId==='owner'){json(res,409,{error:'Could not find their Flow membership'});return true}
    const r=await memberships.revoke({localId,email:m.email,opidId:m.opidId,by:user.email});
    const i=await invites.find(m.email);if(i&&!i.revokedAt)await invites.revoke(m.email);
    json(res,200,{removed:true,email:m.email,opidRevoked:r.opidRevoked});return true;
  }
  res.writeHead(405);res.end();return true;
}

// ---------- sharing (docs/sharing.md): owners share part of an environment with another Flow user ----------
//   POST /api/shares/preview {env, scope}               owner: exactly what a share would show (before sharing)
//   GET  /api/shares?env=<id>                           owner: shares of that environment + pending requests
//   POST /api/shares {env, recipientEmail, scope, permission, name}       owner only (a recipient cannot re-share)
//   PATCH /api/shares/<id> {permission, adds}   DELETE /api/shares/<id> (revoke)    owner (adds: off|approve|direct)
//   GET  /api/shares/<id>/preview                       owner or recipient
//   GET  /api/shares/incoming                           recipient: shares with me, and where they are placed
//   POST /api/shares/<id>/attach {env}   DELETE /api/shares/<id>/attach?env=<id>   recipient, own environment
//   POST /api/shares/<id>/requests {toEmail, permission, note}   recipient asks the owner to share it on
//   GET  /api/share-requests   POST /api/share-requests/<id> {approve, permission}   owner decides
//   GET  /api/share-proposals                           owner: additions waiting for them; mine: the caller's own
//   POST /api/share-proposals/<id> {approve}   owner decides   DELETE /api/share-proposals/<id>   recipient withdraws
//   POST /api/shares/<id>/comments {kind, id, comment}  GET /api/shares/<id>/history?kind=&id=
// Anything the user may not see answers 404. The owner token (tools/env.mjs) acts as the owner.
// previewOf, scopeLabel and shareSummary: what a scope holds (lib/share-service.mjs). saveShare and
// shareView: the one rule set for creating shares, here and in /api/v1 and MCP (shareService).
const shareSvc=(await import('./lib/share-service.mjs')).shareServices({shares,workspaces,onRevoke:()=>shareRevoked()});
// A revoke takes effect at once: photos, the office's access cache, and open office streams (lib/office.mjs
// recheck closes the ones that lost access, with a 'gone' event).
function shareRevoked(){photoCache.clear();officeSeen.clear();historyRooms.clear();officeHub.recheck({portals:true}).catch(()=>{})}
// A new share: its recipient's open offices get a door to the shared office.
function shareMade(){officeSeen.clear();historyRooms.clear();officeHub.recheck({portals:true}).catch(()=>{})}
const {previewOf,shareSummary,scopeLabel,saveShare,updateShare,shareView}=shareSvc;
async function sharesApi(req,res){
  const u=new URL(req.url,'http://x'),path=u.pathname;
  if(path!=='/api/shares'&&!path.startsWith('/api/shares/')&&path!=='/api/share-requests'&&!path.startsWith('/api/share-requests/')&&path!=='/api/share-proposals'&&!path.startsWith('/api/share-proposals/'))return false;
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
  const view=shareView;
  try{
    if(path==='/api/shares/preview'&&req.method==='POST'){readJson(req,res,async b=>{
      const w=await ownEnv(b?.env);if(!w)return nf();
      if(!core.validScope(b.scope))return json(res,400,{error:'Pick what to share'});
      const preview=previewOf(w.data,{scope:b.scope});
      json(res,200,{preview,label:scopeLabel(w.data,b.scope)});
    });return true}
    if(path==='/api/shares'&&req.method==='GET'){
      const w=await ownEnv(u.searchParams.get('env'));if(!w)return nf(),true;
      const list=await shares.list({ownerEnv:w.envId});
      json(res,200,{shares:list.map(s=>{const sum=shareSummary(w.data,s);return {...s,scopeLabel:sum.scopeLabel,summary:sum.summary,tip:sum.tip}}),requests:(await shares.requests({ownerEmail:user.email,status:'pending'})).filter(r=>list.some(s=>s.id===r.shareId)),
        proposals:(await shares.proposals({ownerEnv:w.envId,ownerEmail:user.email,status:'pending'})).map(p=>proposalView(p,w,list.find(s=>s.id===p.shareId)))});return true;
    }
    if(path==='/api/shares'&&req.method==='POST'){readJson(req,res,async b=>{
      const w=await ownEnv(b?.env);if(!w)return nf();
      const r=await saveShare(w,user,b||{});
      if(r.error==='linked')return json(res,400,{error:'Cards shared with you cannot be shared on. Ask the owner from Settings › Sharing.'});
      if(!r.ok)return fail(r);
      if(!r.existing)shareMade();
      json(res,200,{share:await view(r.share),existing:r.existing,preview:previewOf(w.data,r.share)});
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
    // Additions waiting for the owner (docs/sharing.md): the owner's to decide, the recipient's own to follow.
    if(path==='/api/share-proposals'&&req.method==='GET'){
      const pend=await shares.proposals({ownerEmail:user.email,status:'pending'}),homes=new Map(),shareOf=new Map();
      for(const p of pend){if(!homes.has(p.ownerEnv))homes.set(p.ownerEnv,await workspaces.get(p.ownerEnv));if(!shareOf.has(p.shareId))shareOf.set(p.shareId,await shares.get(p.shareId))}
      const mine=await shares.proposals({proposedBy:user.email,limit:50});
      json(res,200,{proposals:pend.map(p=>proposalView(p,homes.get(p.ownerEnv),shareOf.get(p.shareId))),mine:mine.filter(p=>p.status!=='applied').map(p=>({...proposalView(p,null,null),records:undefined,preview:core.proposalPreview({},p)}))});return true;
    }
    m=/^\/api\/share-proposals\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if(m&&req.method==='POST'){readJson(req,res,async b=>{const r=await decideShareProposal(m[1],user,!!b?.approve);json(res,r.status,r.body)});return true}
    // The recipient takes back one of their pending proposals.
    if(m&&req.method==='DELETE'){
      const p=await shares.getProposal(m[1]);if(!p||!sameEmail(p.proposedBy,user.email))return nf(),true;
      const done=await shares.decideProposal({...p,status:'withdrawn',decidedBy:user.email,decidedAt:new Date().toISOString()});
      if(!done)return json(res,409,{error:'Already decided'}),true;
      json(res,200,{proposal:{...proposalView(done,null,null),records:undefined}});return true;
    }
    m=/^\/api\/shares\/([A-Za-z0-9-]{1,64})(?:\/(preview|attach|requests|comments|history))?$/.exec(path);
    if(!m)return nf(),true;
    const s=await shares.get(m[1]),isOwner=s&&sameEmail(s.ownerEmail,user.email),isRecipient=s&&!s.revokedAt&&sameEmail(s.recipientEmail,user.email)&&!user.token;
    if(!isOwner&&!isRecipient)return nf(),true;
    const sub=m[2]||'';
    if(!sub&&req.method==='GET'){json(res,200,{share:await view(s)});return true}
    if(!sub&&req.method==='PATCH'){if(!isOwner)return nf(),true;readJson(req,res,async b=>{
      if(b?.permission===undefined&&b?.adds===undefined)return json(res,400,{error:'Send permission or adds'});
      if(b.permission!==undefined&&!core.PERMISSIONS.includes(b.permission))return json(res,400,{error:'Pick view, comment or edit'});
      if(b.adds!==undefined&&!core.ADDS.includes(b.adds))return json(res,400,{error:'Pick off, approve or direct'});
      if(s.revokedAt)return fail({error:'revoked'});
      json(res,200,{share:await view(await updateShare(s,b))});
    });return true}
    if(!sub&&req.method==='DELETE'){if(!isOwner)return nf(),true;const gone=await shares.revoke(s.id);shareRevoked();json(res,200,{share:await view(gone),revoked:true});return true}
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
      if(!isOwner){const home=await workspaces.get(s.ownerEnv),sc=home?.data?core.resolveScope(home.data,s):null,k=SCOPE_KEY;
        const members=sc?await membersOf(s):[];
        list=sc?list.filter(e=>sc[k[e.kind]]?.includes(e.recordId)).map(e=>{const {over,...x}=core.historyForRecipient(home.data,s,e,members);return x}):[]}
      json(res,200,{history:list});return true;
    }
    res.writeHead(405);res.end();return true;
  }catch(e){console.error('shares',e?.message);json(res,500,{error:'Sharing failed'});return true}
}

// ---------- public API: /api/v1 (REST + OpenAPI), API keys (Settings › API keys) and MCP at /mcp ----------
// docs/api.md, docs/api-keys.md, docs/mcp-cli.md. /api/v1 and /mcp take Authorization: Bearer flow_… keys
// (or the owner token); they are not tied to the page origin. A key is limited to its environment and
// scopes on top of the usual ownership rules. In the caller's own environments it sees the linked copies of
// the shares placed there too (apiStore below), like the app.
const {apiV1,envCheckFor,memoryRateLimit}=await import('./lib/api-v1.mjs');
const registryMod=await import('./lib/registry.mjs');
const {apiKeyStore,authenticateApiKey,bearerKey,allows:keyAllows,SCHEMA:APIKEY_SCHEMA}=await import('./lib/apikeys.mjs');
const {apiKeyRoutes}=await import('./lib/apikeys-routes.mjs');
const appDeviceMod=await import('./lib/app-device.mjs'),apnsMod=await import('./lib/apns.mjs');
const {mcpHandler}=await import('./lib/mcp.mjs');
// 'live' keys only on the public deploy; local mode and verify make flow_test_ keys. db without a catch:
// a database error fails closed.
const apiKeys=apiKeyStore({dir:fileURLToPath(backupRoot),db:()=>cloud(),mode:auth.mode==='opid'&&!VERIFY?'live':'test'});
const keyEnvs=async u=>[...new Set([...(await workspaces.owned(u.email)).map(w=>w.envId),...(sameEmail(u.email,auth.OWNER_EMAIL)?[DEFAULT_ENV.id]:[])])];
const keysApi=apiKeyRoutes({userFor:auth.userFor,store:apiKeys,readJson,trusted,envsFor:keyEnvs,maxKeys:u=>limitsOf(u.email).maxApiKeys});
const apiLimit=memoryRateLimit({perMinute:120}),baseEnvCheck=envCheckFor(workspaces);
// The store the API works on: each environment's own data (edges to linked copies it cannot see left
// out), and for a key, only the environments it is for. In the caller's own environments it also holds
// the linked copies of the shares placed there, as the app shows them, and a write sends their changes
// back with the same rules as a browser save (applyRecipientSave). Never for the owner token.
// Readers other than the owner (members, public environments) see only that a card is linked, as in the app.
// Cards whose latest change came from a share recipient, not the environment's owner (agents.work holds them).
async function heldCards(envId,ids){
  const out=new Set();if(!ids.length)return out;
  const w=await workspaces.get(envId).catch(()=>null);if(!w)return out;
  if(!(await shares.list({ownerEnv:envId})).length)return out;
  for(const id of ids){const h=(await shares.history({envId,kind:'card',recordId:id,limit:1}))[0];if(h&&!sameEmail(h.by,w.owner))out.add(id)}
  return out;
}
const SHARE_REFUSAL={permission:[403,'share_permission','This share does not let you change that'],stub:[403,'share_read_only','That record is read-only: it belongs to someone outside the share'],
  forbidden:[403,'share_permission','This share does not let you change that'],revoked:[409,'share_revoked','That share was revoked'],
  'out-of-scope':[409,'share_out_of_scope','That record is no longer shared with you'],'owner-only':[403,'share_owner_only','Only the owner can change that: it decides what runs on their machines'],'not-found':[409,'share_out_of_scope','That record is no longer shared with you'],invalid:[400,'invalid_shared_field','Invalid value for a shared record']};
// What a write to linked records would be refused for, checked before anything is saved:
// {status, code, error} | null. seen: the workspace as get() served it.
async function sharedRefusal(envId,user,seen,data,base){
  const locked=core.lockedChanges(seen,data)[0];
  if(locked)return locked.field==='deleted'?{status:403,code:'share_delete',error:`${locked.id} is shared with you: only its owner can delete it`}
    :locked.stub?{status:403,code:SHARE_REFUSAL.stub[1],error:SHARE_REFUSAL.stub[2]}
    :{status:403,code:'share_read_only_field',error:`The ${locked.field} of a shared ${locked.kind} can only be changed by its owner`};
  for(const {share:s,home} of await attachedShares(envId,user)){
    const members=await membersOf(s),p=core.projectForRecipient(home.data,s,await shares.placements(s.id,envId),{members});
    for(const e of core.extractRecipientChanges(p,data,base).edits){
      const r=core.applyRecipientEdit(home.data,s,e,user,{members});if(r.ok)continue;
      const [status,code,error]=SHARE_REFUSAL[r.error]||[403,'share_permission','This share does not let you change that'];
      return {status,code,error:r.field&&r.error==='invalid'?`${error}: ${r.field}`:error};
    }
  }
  return null;
}
const apiStore=(key,user)=>{
  // What get() served for each environment that holds linked copies, cleaned the way every operation cleans
  // what it reads, so a write sends only the fields the caller changed (fieldBase), and a copy that is
  // merely out of date never overwrites the owner.
  const served=new Map(),withLinked=w=>!!user?.email&&!user.token&&sameEmail(w.owner,user.email);
  return {...workspaces,
    async get(id){const w=await workspaces.get(id);if(!w?.data)return w;
      if(withLinked(w)){const {data}=await withShares(id,user,w.data);if(core.linkedShareIds(data).length||data.shareMembers?.length){served.set(id,normalizeDb(structuredClone(data)));return {...w,data}}}
      served.delete(id);
      const data=dropDangling(structuredClone(stripLinked(w.data)));
      if(!user?.token&&!sameEmail(w.owner,user?.email))opidPhotos.maskOpidLinks(data,null);return {...w,data}},
    async owned(email){return (await workspaces.owned(email)).filter(w=>!key||keyAllows(key,'read',w.envId))},
    async put(id,opts){
      const seen=served.get(id);if(!seen)return workspaces.put(id,opts);
      const base=fieldBase(seen,opts.data),refused=await sharedRefusal(id,user,seen,opts.data,base);
      if(refused)return {refused};
      // A record made inside a share: added to its owner's data, proposed, or refused (planAdds).
      const adds=await planAdds(id,user,opts.data,stripLinked(seen),{api:true});
      if(adds.refusal)return {refused:adds.refusal};
      const out=await workspaces.put(id,{...opts,data:stripLinked(adds.data),source:{...opts.source,...movedCards(adds)}});
      if(!out.ok)return out;
      const added=adds.plans.length?await commitAdds(id,user,adds.plans).catch(e=>{console.error('share additions failed',e?.message);return {}}):{};
      await applyRecipientSave(id,user,adds.data,base).catch(e=>console.error('share write-back failed',e?.message));
      return Object.keys(added).length?{...out,added}:out;
    },
  };
};
const keyEnvCheck=async(envId,user,mode)=>(!user?.key||keyAllows(user.key,mode==='write'?'write':'read',envId))&&baseEnvCheck(envId,user,mode);
// Authorization: Bearer flow_… (an API key) or the owner token. -> {user, scopes} | null
async function apiAuth(req){
  if(bearerKey(req)){const a=await authenticateApiKey(req,apiKeys).catch(()=>null);return a?.user?{user:{id:'key:'+a.keyId,email:a.user.email,key:a},scopes:a.scopes}:null}
  const t=tokenUser(req);return t?{user:t,scopes:['read','write','admin']}:null;
}
// ---------- 3D office (lib/office.mjs, docs/concepts/12-office.md) ----------
// Streams and poses stay local. Postgres (or BACKUP_DIR) keeps the durable office state.
// Members of an environment: its owner, its members, and everyone with an active share into it.
const officeMod=await import('./lib/office.mjs'),afCore=await import('./public/agentflow-core.js');
// Use the existing local key to seed the shared key during an upgrade.
const officeSecretSeed=(()=>{const f=join(fileURLToPath(backupRoot),'_office-secret');try{const v=readFileSync(f,'utf8').trim();if(v.length>=32)return v}catch{}
  const v=randomUUID()+randomUUID();try{mkdirSync(fileURLToPath(backupRoot),{recursive:true});writeFileSync(f,v,{mode:0o600})}catch{}return v})();
const {officeStorage:openOfficeStorage}=await import('./lib/office-storage.mjs');
const officeStorage=await openOfficeStorage({db:await cloud(),dir:fileURLToPath(backupRoot),secret:officeSecretSeed}).catch(e=>{
  throw Error('Could not initialize office storage: '+cloudError(e));
});
const {createOfficeHistory,openOfficeHistoryStore}=await import('./lib/office-history.mjs');
const officeHistoryStore=await openOfficeHistoryStore({db:await cloud(),dir:fileURLToPath(backupRoot)});
const officeState=officeMod.officeState({storage:officeStorage});
await officeState.refresh().catch(e=>{throw Error('Could not load office reports: '+cloudError(e))});
const officeLimit=memoryRateLimit({perMinute:600});
const personName=async email=>(await users.get(email).catch(()=>null))?.name||(auth.mode==='local'&&sameEmail(email,auth.localUser?.email)?auth.localUser.name:'')||String(email).split('@')[0];
async function officeEnv(envId){
  const w=await workspaces.get(envId).catch(()=>null),e=envs.get(envId),data=w?.data?normalizeDb(structuredClone(stripLinked(w.data))):null;
  if(w?.archivedAt)return {id:envId,members:[],projects:[],agents:[],cards:[]};
  const owner=String(w?.owner||e?.ownerEmail||'').toLowerCase();
  const recipients=(await shares.list({ownerEnv:envId}).catch(()=>[])).filter(s=>!s.revokedAt).map(s=>s.recipientEmail);
  const emails=[...new Set([owner,...(e?.members||[]),...(data?.environment?.members||[]),...recipients].map(x=>String(x||'').toLowerCase()).filter(Boolean))];
  const people=afCore.peopleOf(data||{});
  const members=await Promise.all(emails.map(async email=>{const u=await users.get(email).catch(()=>null);return {email,name:u?.name||await personName(email),lastSeen:u?.lastSeen||'',personIds:people.filter(p=>sameEmail(p.email,email)).map(p=>p.id)}}));
  return {id:envId,name:w?.name||data?.environment?.name||e?.name||'Workspace',ownerEmail:owner,members,
    projects:(data?.projects||[]).map(p=>({id:p.id,name:p.name,repos:p.repos||[]})),
    world:data?.agentflow?.office?.world||'classic',
    agents:(data?.agentflow?.agents||[]).map(a=>({id:a.id,name:a.name,kind:a.kind,title:a.title||'',status:a.status,reportsTo:a.reportsTo||'',projects:a.projects||[],cards:a.cards||[],
      ...(a.kind==='human'?{memberEmail:humanMember(a,data,members)}:{})})),
    // For seats (lib/office-seats.mjs): which card a live session works on, and each agent's queue.
    cards:(data?.devops?.cards||[]).map(c=>({id:c.id,number:c.number,title:c.title,column:c.column,moved:c.moved||'',project:c.project||'',due:c.due||'',snoozedUntil:c.snoozedUntil||''}))};
}
// The member a human AgentFlow agent is: the one member whose account has its name, else the email of the one
// person card with its name, else its supervisor's person card's email. The name comes first because a human
// agent's supervisor is often someone else (their manager), and a person card's email is not always the one
// they sign in with. Each step only counts when it names a member.
function humanMember(a,data,members){
  const emails=new Set(members.map(m=>m.email)),people=afCore.peopleOf(data),mail=p=>{const e=String(p?.email||'').toLowerCase();return emails.has(e)?e:''};
  const hits=members.filter(m=>afCore.sameName(m.name,a.name));if(hits.length===1)return hits[0].email;
  const named=mail(afCore.personNamed(people,a.name));if(named)return named;
  return mail(people.find(p=>p.id===a.supervisor));
}
// Who may enter an environment's office, and which of its projects they see: everyone who can read it
// sees all of them; a share's recipient sees the projects in their shares' scopes (all for a whole-environment share).
async function officeAccessNow(envId,user){
  const w=await workspaces.get(envId).catch(()=>null);if(w?.archivedAt)return {ok:false};
  const e={...(envs.get(envId)||{id:envId,ownerEmail:'',visibility:'private',members:[]}),...(w?{ownerEmail:w.owner,visibility:w.visibility}:{})};
  const members=w?.data?.environment?.members;
  const full=canRead(e,user)||(Array.isArray(members)&&members.some(m=>sameEmail(m,user.email)));
  if(sameEmail(e.ownerEmail,user.email))return {ok:true,all:true,projectIds:new Set()};
  const active=(await shares.list({ownerEnv:envId}).catch(()=>[])).filter(s=>!s.revokedAt);
  const mine=active.filter(s=>sameEmail(s.recipientEmail,user.email));
  if(!mine.length||!w?.data)return {ok:full,all:full,projectIds:new Set()};
  const d=normalizeDb(structuredClone(stripLinked(w.data))),projectIds=new Set(),cardIds=new Set(),scopes=[];
  let all=full;
  for(const s of mine){
    const scope=core.resolveScope(d,s);
    if(s.scope?.kind==='environment')all=true;
    for(const id of scope.projectIds)projectIds.add(id);
    for(const id of scope.cardIds)cardIds.add(id);
    scopes.push({id:s.id,nodeIds:new Set(scope.nodeIds),cardIds:new Set(scope.cardIds)});
  }
  return {ok:true,all,projectIds,cardIds,scopes};
}
const officeSeen=new Map();
async function officeAccess(envId,user){
  const k=envId+'\n'+String(user.email).toLowerCase(),hit=officeSeen.get(k);
  if(hit&&Date.now()-hit.at<15000)return hit.access;
  const access=await officeAccessNow(envId,user);if(officeSeen.size>5000)officeSeen.clear();officeSeen.set(k,{at:Date.now(),access});return access;
}
// Doors to the other offices this person can enter that sharing connects to them (docs/concepts/12-office.md):
// the offices of environments shared with them ("<owner>'s office"), and their own environments that they share
// (where their recipients meet them). When they are visiting someone else's office, also a door back to their own.
// -> [{env, label, sub, own}]
async function officePortals(envId,user){
  const out=[],seen=new Set([envId]);if(!user?.email||user.token||user.key)return out;
  const add=async(env,label,own)=>{if(seen.has(env)||out.length>=12)return;seen.add(env);const w=await workspaces.get(env).catch(()=>null);if(!w?.data||w.archivedAt)return;out.push({env,label,sub:w.name||w.data.environment?.name||'',own})};
  // One door per environment: read each once.
  const byEnv=list=>[...new Map(list.map(s=>[s.ownerEnv,s])).values()];
  for(const s of byEnv(await shares.list({recipientEmail:user.email}).catch(()=>[])))if(!seen.has(s.ownerEnv))await add(s.ownerEnv,`${await personName(s.ownerEmail)}'s office`,false);
  for(const s of byEnv(await shares.list({ownerEmail:user.email}).catch(()=>[])))if(!seen.has(s.ownerEnv)&&sameEmail((await workspaces.get(s.ownerEnv).catch(()=>null))?.owner,user.email))await add(s.ownerEnv,'Your office',true);
  const here=await workspaces.get(envId).catch(()=>null);
  if(!sameEmail(here?.owner,user.email)){const mine=await workspaces.ownedBy(user.email).catch(()=>null);if(mine?.envId)await add(mine.envId,'Your office',true)}
  return out;
}
const historyError=e=>console.error('Office history:',cloudError(e));
const historyRooms=new Map();
async function historyEnvironments(email){
  const hit=historyRooms.get(email);if(hit&&Date.now()-hit.at<5000)return hit.contexts;
  const [ownedOrMember,shared]=await Promise.all([rawWorkspaces.memberEnvs(email),shares.list({recipientEmail:email})]);
  const registered=envs.list().filter(e=>[e.ownerEmail,...e.members].some(m=>sameEmail(m,email))).map(e=>e.id);
  const ids=new Set([...ownedOrMember,...shared.map(s=>s.ownerEnv),...registered]);
  const contexts=await Promise.all([...ids].map(officeEnv));
  const visible=contexts.filter(ctx=>ctx.members.some(m=>sameEmail(m.email,email)));
  if(historyRooms.size>=2000)historyRooms.clear();
  historyRooms.set(email,{at:Date.now(),contexts:visible});return visible;
}
const officeHub=officeMod.officeHub({history:()=>officeHistory,state:officeState,context:{env:officeEnv,access:officeAccessNow,portals:officePortals},secret:officeStorage.secret,storage:officeStorage,onError:e=>console.error('Office storage or refresh failed:',cloudError(e))});
officeHistory=createOfficeHistory({store:officeHistoryStore,state:officeState,environments:historyEnvironments,context:officeEnv,
  memberKey:officeHub.memberKey,agentKey:officeHub.agentKey,onError:historyError});
officeHistory.start();
// Voice and screen sharing (lib/office-rtc.mjs): WebRTC signalling over the office stream, and ICE servers (TURN from env vars).
const officeRtcMod=await import('./lib/office-rtc.mjs');
const officeRtc=officeRtcMod.officeRtc({hub:officeHub}),officeIce=officeRtcMod.iceConfig();
// /api/office/{env}/events (SSE), history, presence, status, look, knock, admit, enter, say, emote, decorate, answer and steer (an answer, a message or a stop: lib/office.mjs), rtc (GET: ICE servers;
// POST: voice signalling, lib/office-rtc.mjs; never logged), and /api/office/alerts (SSE, per person):
// the app's page only, signed in (local mode too).
async function officeApi(req,res){
  const u=new URL(req.url,'http://x');if(!u.pathname.startsWith('/api/office/'))return false;
  // Your own agents' waits, for alerts while the office is closed (lib/office.mjs hub.alerts): the app's page only.
  if(u.pathname==='/api/office/alerts'){
    if(!trusted(req)){res.writeHead(403);res.end();return true}
    if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});res.end();return true}
    const user=await requireUser(req,res);if(!user)return true;
    try{await officeState.refresh([String(user.email).trim().toLowerCase()]);if(!res.destroyed)officeHub.alerts(user,req,res)}
    catch(e){console.error('office alerts failed',cloudError(e));if(!res.headersSent)json(res,500,{error:'Could not open office alerts'});else res.end()}
    return true;
  }
  const m=/^\/api\/office\/([A-Za-z0-9-]{1,64})\/(events|presence|say|emote|answer|steer|status|look|history|rtc|knock|admit|enter|decorate)$/.exec(u.pathname);
  if(!m){json(res,404,{error:'Not found'});return true}
  // The events stream also takes an API key (read scope, for that environment), e.g. a dashboard watching the office.
  const keyed=m[2]==='events'&&!!req.headers.authorization;
  if(!keyed&&!trusted(req)){res.writeHead(403);res.end();return true}
  let user;
  if(keyed){const a=await apiAuth(req);if(!a||!a.scopes.some(x=>x==='read'||x==='write'||x==='admin')||(a.user.key&&!keyAllows(a.user.key,'read',m[1]))){json(res,401,{error:'Invalid or expired API key'});return true}user={...a.user,name:(await personName(a.user.email))}}
  else{user=await requireUser(req,res);if(!user)return true}
  let [,envId,what]=m;
  if(what==='history'&&(user.token||user.key)){json(res,401,{error:'Sign in to continue'});return true}
  // An opened shared environment's office (share-<shareId>) is its owner environment's office: one office for everyone.
  const virtual=core.parseOpenedEnv(envId)?envId:null;
  if(virtual){const o=keyed?null:await openedShare(virtual,user);if(!o?.share){json(res,404,{error:'Not found'});return true}envId=o.share.ownerEnv}
  const access=await (what==='history'?officeAccessNow:officeAccess)(envId,user);
  if(!access.ok){json(res,404,{error:'Not found'});return true}
  if(what==='history'){
    if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});res.end();return true}
    res.setHeader('Cache-Control','private, no-store');
    try{
      const data=await officeHistory.page(envId,user,access,u.searchParams.get('day'),u.searchParams.get('tz'),u.searchParams.get('cursor'));
      const current=data&&await officeAccessNow(envId,user);
      if(!current?.ok||(virtual&&!(await openedShare(virtual,user))?.share))json(res,404,{error:'Not found'});
      else if(!isDeepStrictEqual(current,access))json(res,409,{error:'Office access changed. Reload the day.'});
      else json(res,200,data);
    }catch(e){
      if(e instanceof RangeError)json(res,400,{error:e.message});
      else{historyError(e);json(res,500,{error:'Could not load office history'})}
    }
    return true;
  }
  if(what==='events'){
    if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});res.end();return true}
    try{await officeHub.connect(envId,user,access,req,res)}catch(e){console.error('office stream failed',cloudError(e));if(!res.headersSent)json(res,500,{error:'Could not open the office'});else res.end()}
    return true;
  }
  if(what==='rtc'&&req.method==='GET'){res.setHeader('Cache-Control','no-store');json(res,200,await officeIce.get(user));return true}
  if(req.method!=='POST'){res.writeHead(405,{Allow:what==='rtc'?'GET, POST':'POST'});res.end();return true}
  readJson(req,res,async b=>{
    try{
      const out=await (what==='rtc'?officeRtc.signal(envId,user,b):what==='presence'?officeHub.move(envId,user,b||{}):what==='say'?officeHub.say(envId,user,b?.text):what==='emote'?officeHub.emote(envId,user,b?.emote):what==='status'?officeHub.setStatus(envId,user,b||{}):what==='look'?officeHub.setLook(envId,user,b):what==='knock'?officeHub.knock(envId,user,b||{}):what==='admit'?officeHub.admit(envId,user,b||{}):what==='enter'?officeHub.enter(envId,user,b||{}):what==='decorate'?officeHub.decorate(envId,user,b||{}):officeHub.answer(envId,user,b));
      json(res,200,out);
    }catch(e){const status=Number.isInteger(e?.status)?e.status:500;if(status===500)console.error('office:',cloudError(e));json(res,status,{error:status===500?'Something went wrong':e.message,code:e.code||'internal'})}
  });
  return true;
}
const apiRateLimit=a=>a.operation?.tags?.includes('office')?officeLimit(a):apiLimit(a);
// Share additions for the API and MCP (proposals.*): never for the owner token.
const apiProposals={list:(envId,user,o)=>user.token?[]:proposalsFor(envId,user,o),decide:(id,user,approve,env)=>user.token?{status:404,body:{error:'Not found',code:'proposal_not_found'}}:decideShareProposal(id,user,approve,env)};
// ---------- the Flow app on iPhone and iPad (lib/app-device.mjs, lib/apns.mjs, docs/ios-app.md) ----------
// Device keys only (scope device). Pushes go out only when APNS_* is set; FLOW_PUSH_PREVIEWS=off leaves card
// titles and prompt text out of them.
const appDevices=appDeviceMod.pushDeviceStore({dir:fileURLToPath(backupRoot),db:()=>cloud()});
const apnsCfg=apnsMod.apnsConfig(process.env);
const appHub=appDeviceMod.pushHub({store:appDevices,sender:apnsCfg?apnsMod.apnsSender(apnsCfg):null,apiKeys,previews:process.env.FLOW_PUSH_PREVIEWS!=='off',
  emailOf:async opid=>(await users.list()).find(u=>u.opidId===opid)?.email||null,isQuiet:email=>officeHub.isQuiet(email)});
if(apnsCfg){
  officeState.on(e=>{if(e.type==='waiting')return appHub.agentWaiting(e.email,e.agent).catch(()=>{})});
  appPush={saved(env,before,after,meta){const ev=appDeviceMod.cardEvents(before,after,meta);if(ev.length)appHub.cards({id:env,name:after?.environment?.name||''},ev).catch(()=>{})}};
}
const appApi=appDeviceMod.appRoutes({authenticate:r=>authenticateApiKey(r,apiKeys),readJson,json,
  async envsFor(user,a){
    const st=apiStore(a,{id:'key:'+a.keyId,email:user.email,key:a}),out=[];
    for(const w of (await st.owned(user.email)).slice(0,25)){const g=await st.get(w.envId).catch(()=>null);if(g?.data)out.push({id:w.envId,name:w.name||g.data.environment?.name||'Workspace',data:g.data})}
    return out;
  },
  opidIdOf:async email=>(await users.get(email).catch(()=>null))?.opidId||'',
  office:{waitingOf:email=>officeHub.waitingOf(email),answer:(user,b)=>officeHub.answer(null,user,b),refresh:emails=>officeState.refresh(emails)},
  store:appDevices,hub:appHub});

async function apiV1Route(req,res){
  if(!req.url.startsWith('/api/v1'))return false;
  // One authentication per request (it also counts towards the key's rate limit).
  let a;const authenticate=async r=>a!==undefined?a:(a=await apiAuth(r));
  if(req.headers.authorization)await authenticate(req);
  return apiV1(req,res,{authenticate,userFor:r=>trusted(r)?auth.userFor(r):null,store:apiStore(a?.user?.key,a?.user),envCheck:keyEnvCheck,rateLimit:apiRateLimit,heldCards,office:officeState,proposals:apiProposals,sharing:u=>shareSvc.forUser(u,keyAllows)});
}
async function mcpRoute(req,res){
  if(new URL(req.url,'http://x').pathname!=='/mcp')return false;
  return mcpHandler(req,res,{operations:registryMod.operations,invoke:registryMod.invoke,
    authenticate:async(token,r)=>(await apiAuth(r))?.user||null,
    ctx:user=>({user,store:apiStore(user.key,user),envCheck:keyEnvCheck,via:'mcp',heldCards,office:officeState,proposals:apiProposals,sharing:shareSvc.forUser(user,keyAllows)}),
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

// @flygon/styles (dist/themes.css): Flygon's brand colors on :root plus its themes. index.html and the docs link it.
const FLYGON_STYLES_PATH='/flygon-styles.css',flygonStylesFile=fileURLToPath(import.meta.resolve('@flygon/styles/themes.css'));
// Static files: any existing file under public/ (so new modules need no restart). The decoded path
// is resolved and must stay inside public/; dotfiles and unknown types are refused.
// Vendored libraries (public/vendor, e.g. Three.js for the 3D office) change only with a release: a day of caching.
const vendorRoot=resolve(root,'vendor')+sep;
function resolveStatic(url){
  const rel=url==='/'?'index.html':url.replace(/^[\\/]+/,'');
  if(!rel||/[\u0000-\u001f:]/.test(rel)||rel.split(/[\\/]/).some(p=>p.startsWith('.')))return null;
  const file=resolve(root,rel);
  if(!file.startsWith(resolve(root)+sep)||!types[extname(file)]||!existsSync(file)||!statSync(file).isFile())return null;
  return file;
}
let draining=false;
const server=http.createServer(async(req,res)=>{
  res.once('finish',()=>{if(draining)setImmediate(()=>server.closeIdleConnections())});
  if(req.url.split('?')[0]==='/health'&&(req.method==='GET'||req.method==='HEAD')){
    res.writeHead(draining?503:200,{'Cache-Control':'no-store'});res.end();return;
  }
  // Who may frame Flow (lib/embed.mjs): this origin only, unless FLOW_FRAME_ANCESTORS adds others.
  // Decided once per request (lib/embed.mjs): the same answer sets the frame headers and the sign-in cookies.
  try{req.flowEmbed=await auth.embed.decide(req);for(const [k,v] of Object.entries(auth.embed.headers(req.flowEmbed)))res.setHeader(k,v)}catch{}
  if(req.url.split('?')[0]==='/api/instance'&&req.method==='GET'){
    const name=String(process.env.FLOW_INSTANCE_NAME||'Flow').trim().slice(0,80)||'Flow';
    const accent=/^#[0-9a-fA-F]{6}$/.test(process.env.FLOW_ACCENT_COLOR||'')?process.env.FLOW_ACCENT_COLOR:''; // '' keeps --flygon-green from @flygon/styles
    const logo=String(process.env.FLOW_LOGO_PATH||'');
    json(res,200,{name,accent,logo:/^\/(?!\/)[A-Za-z0-9/_-]+\.(?:svg|png|webp)$/.test(logo)&&!logo.includes('..')?logo:''});return;
  }
  // API clients (keys, CLI, MCP) have no page origin: these two authenticate with Bearer keys themselves.
  if(await apiV1Route(req,res)||await mcpRoute(req,res)||await appApi(req,res))return;
  if(req.url.startsWith('/api/auth/')){if(!trusted(req)){res.writeHead(403);res.end();return}if(await auth.handle(req,res,readJson))return}
  if(await backup(req,res)||await saves(req,res)||await inbox(req,res)||await prefs(req,res)||await workspace(req,res)||await opidApi(req,res)||await chatApi(req,res)||await environments(req,res)||await invitesApi(req,res)||await membersApi(req,res)||await sharesApi(req,res)||await keysApi(req,res)||await officeApi(req,res)||await devlogPage(req,res))return;
  // Generated docs (tools/docs.mjs): /docs opens the index; /skill.md is the agent skill. Public, no workspace data.
  const bare=req.url?.split('?')[0];
  if(bare==='/docs'||bare==='/docs/'){res.writeHead(302,{Location:'/docs/index.html'});res.end();return}
  // Flygon brand colors and themes from the @flygon/styles package, served as installed (not copied into public/).
  if(bare===FLYGON_STYLES_PATH&&(req.method==='GET'||req.method==='HEAD')){try{const b=readFileSync(flygonStylesFile);res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:b)}catch{res.writeHead(500);res.end('Unable to load file')}return}
  if(bare==='/skill.md'&&req.method==='GET'){try{const b=readFileSync(new URL('./skills/flygon-flow/SKILL.md',import.meta.url));res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(b)}catch{res.writeHead(404);res.end()}return}
  // /join?invite=<token>&email=<address> (an invite link): the token goes in an httpOnly cookie for the
  // sign-in that follows, and the page opens on the join screen (public/account.js).
  if(bare==='/join'&&(req.method==='GET'||req.method==='HEAD')){
    const q=new URL(req.url,'http://x').searchParams,t=q.get('invite')||'',e=q.get('email')||'';
    if(/^[A-Za-z0-9_-]{16,200}$/.test(t)&&validEmail(e))res.setHeader('Set-Cookie',auth.outCookies([auth.inviteCookie(t,e.trim().toLowerCase())],res));
    try{const b=readFileSync(join(root,'index.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(req.method==='HEAD'?undefined:b)}catch{res.writeHead(500);res.end('Unable to load file')}
    return;
  }
  let file;try{file=resolveStatic(decodeURIComponent(req.url?.split('?')[0]||'/'))}catch{file=null}
  if(!file||(req.method!=='GET'&&req.method!=='HEAD')){res.writeHead(404);res.end('Not found');return;}
  try{const body=readFileSync(file);res.setHeader('Content-Type',types[extname(file)]+(/^(text|application\/json)/.test(types[extname(file)])?'; charset=utf-8':''));res.setHeader('Cache-Control',file.startsWith(vendorRoot)?'public, max-age=86400':'no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(req.method==='HEAD'?undefined:body);}catch{res.writeHead(500);res.end('Unable to load file');}
});
// Local single-user mode only ever listens on loopback; a public deploy must run with OneProfileID.
// With OPID_* set it listens on HOST (default 0.0.0.0) at PORT, as hosts like Railway expect.
const LOOPBACK=['127.0.0.1','localhost','::1'];
const host=process.env.HOST||(auth.mode==='opid'?'0.0.0.0':'127.0.0.1');
if(auth.mode==='local'&&!LOOPBACK.includes(host)){console.error(`Refusing to listen on ${host} in local single-user mode. Set OPID_BASE_URL, OPID_APP_ID, OPID_APP_SECRET and OPID_APP_ORIGIN to serve it publicly with sign-in.`);process.exit(1)}
let port=Number(process.env.PORT||4317);
server.on('error',e=>{if(e.code==='EADDRINUSE'&&!process.env.PORT){port++;server.listen(port,host);}else{console.error(e);process.exit(1);}});
server.once('listening',()=>{setImmediate(()=>recordDevlog().catch(()=>{}))});
// Follow OneProfileID's membership events (revocations made elsewhere) every FLOW_MEMBERSHIP_POLL_SECONDS
// (default 60; 0 or off: never). Off in local mode.
server.once('listening',()=>{
  const v=String(process.env.FLOW_MEMBERSHIP_POLL_SECONDS??'60').trim(),s=v==='off'?0:Number(v);
  memberships.start(Number.isFinite(s)&&s>0?Math.max(1,s)*1000:0);
});
server.on('listening',()=>{const url=auth.mode==='opid'&&!LOOPBACK.includes(host)?`${auth.appOrigin} (listening on ${host}:${server.address().port})`:`http://${host==='::1'?'[::1]':host}:${server.address().port}`;if(!VERIFY&&auth.mode==='local')writeFileSync(new URL('./running.json',import.meta.url),JSON.stringify({url,pid:process.pid}));console.log(`Flygon Flow: ${url} (${auth.mode==='opid'?'OneProfileID sign-in':'local single-user mode'}${auth.mode==='local'&&SYNC_URL&&SYNC_TOKEN?`, syncing with ${SYNC_HOST}`:''})`);});
process.on('SIGTERM',()=>{
  if(draining)return;
  draining=true;
  memberships.stop();
  const deadline=setTimeout(()=>{server.closeAllConnections();process.exit(1)},25000);
  deadline.unref();
  server.close(async error=>{
    await officeHub.flush();
    await officeHistory.close();
    await pool?.end().catch(()=>{});
    clearTimeout(deadline);
    process.exit(error?1:0);
  });
  officeHub.close({restart:true});
  officeState.close();
});
server.listen(port,host);
