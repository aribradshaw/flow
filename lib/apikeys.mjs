// API keys per environment (Settings › API keys), for /api/v1, the MCP server and the CLI.
//   {id, owner, name, env:'<env id>'|'*', scopes:['read'|'write'|'admin'], mode:'live'|'test', prefix,
//    createdAt, expiresAt?, lastUsedAt, lastUsedIp, revokedAt}
// Keys look like flow_live_<40 base62> (flow_test_ on servers that are not the public deploy). Only a
// SHA-256 hash of the key and its display prefix (flow_live_ plus 8 characters) are stored; the full
// key is returned once, by create(). Postgres when the pool exists (tables flygon_flow_api_keys and
// flygon_flow_api_key_audit, additive, created idempotently on first use), otherwise
// BACKUP_DIR/_apikeys.json and _apikeys-audit.json. Revoking marks the key; nothing is deleted.
// Scopes: admin implies write, write implies read. Every create, revoke, use (throttled), refusal
// and rate-limit hit is appended to the audit log, which keeps AUDIT_DAYS days.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';

export const SCHEMA=[
  `create table if not exists flygon_flow_api_keys(id text primary key,owner_email text not null,name text not null,env_id text not null,scopes jsonb not null,mode text not null default 'live',prefix text not null,key_hash text not null,created_at timestamptz not null default now(),expires_at timestamptz,last_used_at timestamptz,last_used_ip text,revoked_at timestamptz)`,
  `create index if not exists flygon_flow_api_keys_prefix on flygon_flow_api_keys(prefix)`,
  `create index if not exists flygon_flow_api_keys_owner on flygon_flow_api_keys(lower(owner_email))`,
  `create table if not exists flygon_flow_api_key_audit(id bigserial primary key,key_id text not null,op text not null,at timestamptz not null default now(),ip text not null default '')`,
  `create index if not exists flygon_flow_api_key_audit_at on flygon_flow_api_key_audit(at)`,
];
export const SCOPES=['read','write','admin'];
export const AUDIT_DAYS=90;
const AUDIT_MAX=20000,TOUCH=60e3,PREFIX_LEN=8,BODY_LEN=40,MAX_KEYS=50;
const KEY=/^flow_(live|test)_([A-Za-z0-9]{40})$/,ENV=/^[A-Za-z0-9-]{1,64}$/;
const B62='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const hash=k=>createHash('sha256').update(String(k)).digest('hex');
const iso=d=>d?new Date(d).toISOString():null;
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();

// 40 base62 characters (~238 bits), without modulo bias.
function body(){
  let s='';
  while(s.length<BODY_LEN)for(const b of randomBytes(64))if(b<248&&s.length<BODY_LEN)s+=B62[b%62];
  return s;
}
// ['write'] -> ['read','write']; unknown scopes are dropped.
export function normScopes(list){
  const s=new Set((Array.isArray(list)?list:[list]).filter(x=>SCOPES.includes(x)));
  if(s.has('admin'))s.add('write');if(s.has('write'))s.add('read');
  return SCOPES.filter(x=>s.has(x));
}
// May this authenticated key do `scope` in environment `env`? (env omitted: any environment it has)
export const allows=(auth,scope,env)=>!!auth?.user&&normScopes(auth.scopes).includes(scope)&&(env===undefined||auth.envs.includes('*')||auth.envs.includes(env));
// What the API and UI may see: never the hash.
const view=k=>k&&{id:k.id,owner:k.owner,name:k.name,env:k.env,scopes:k.scopes,mode:k.mode,prefix:k.prefix,createdAt:k.createdAt,expiresAt:k.expiresAt||null,lastUsedAt:k.lastUsedAt||null,lastUsedIp:k.lastUsedIp||null,revokedAt:k.revokedAt||null};
const row=r=>r&&{id:r.id,owner:r.owner_email,name:r.name,env:r.env_id,scopes:r.scopes,mode:r.mode,prefix:r.prefix,hash:r.key_hash,createdAt:iso(r.created_at),expiresAt:iso(r.expires_at),lastUsedAt:iso(r.last_used_at),lastUsedIp:r.last_used_ip||null,revokedAt:iso(r.revoked_at)};

// Run SCHEMA once per pool (the server may also run it with its other tables; both are idempotent).
const migrated=new WeakSet();
export async function migrate(pg){if(migrated.has(pg))return;for(const q of SCHEMA)await pg.query(q);migrated.add(pg)}

// dir: BACKUP_DIR.  db: async () => pg Pool | null.  mode: 'live' on the public deploy, else 'test'.
export function apiKeyStore({dir,db=async()=>null,mode='test',now=()=>Date.now()}){
  const file=join(dir,'_apikeys.json'),auditFile=join(dir,'_apikeys-audit.json');
  const read=f=>{try{return JSON.parse(readFileSync(f,'utf8'))}catch{return []}};
  const write=(f,v)=>{mkdirSync(dir,{recursive:true});writeFileSync(f+'.tmp',JSON.stringify(v,null,2));renameSync(f+'.tmp',f)};
  // A database error is thrown, never turned into the file fallback: keys made or checked while
  // Postgres is down must not land in (or be read from) a different store. Fail closed.
  const pool=async()=>{const pg=await db();if(pg)await migrate(pg);return pg};
  const touched=new Map();let pruned=0;
  return {
    mode:mode==='live'?'live':'test',now,
    // -> {key, apiKey}: the full key, shown once, and its stored record (without the hash).
    async create({owner,name,env,scopes,expiresAt=null}){
      const m=this.mode,b=body(),key=`flow_${m}_${b}`,prefix=`flow_${m}_${b.slice(0,PREFIX_LEN)}`;
      const k={id:'key_'+randomUUID(),owner:String(owner).toLowerCase(),name:String(name).slice(0,80),env,scopes:normScopes(scopes),mode:m,prefix,hash:hash(key),createdAt:new Date(now()).toISOString(),expiresAt:iso(expiresAt),lastUsedAt:null,lastUsedIp:null,revokedAt:null};
      const pg=await pool();
      if(pg)await pg.query('insert into flygon_flow_api_keys(id,owner_email,name,env_id,scopes,mode,prefix,key_hash,created_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[k.id,k.owner,k.name,k.env,JSON.stringify(k.scopes),k.mode,k.prefix,k.hash,k.createdAt,k.expiresAt]);
      else{const list=read(file);list.push(k);write(file,list)}
      return {key,apiKey:view(k)};
    },
    // A user's keys, newest first (revoked ones too, marked).
    async list(owner){
      const pg=await pool();
      const all=pg?(await pg.query('select * from flygon_flow_api_keys where lower(owner_email)=lower($1) order by created_at desc',[owner])).rows.map(row)
        :read(file).filter(k=>same(k.owner,owner)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      return all.map(view);
    },
    async activeCount(owner){return (await this.list(owner)).filter(k=>!k.revokedAt&&!(k.expiresAt&&Date.parse(k.expiresAt)<=now())).length},
    async get(id){
      const pg=await pool();
      return view(pg?row((await pg.query('select * from flygon_flow_api_keys where id=$1',[id])).rows[0]):read(file).find(k=>k.id===id));
    },
    // Internal: candidates for a presented key (with hashes). Never send these anywhere.
    async byPrefix(prefix){
      const pg=await pool();
      if(pg)return (await pg.query('select * from flygon_flow_api_keys where prefix=$1',[prefix])).rows.map(row);
      return read(file).filter(k=>k.prefix===prefix);
    },
    // Revoke one of the owner's keys. false: no such key for this owner (or already revoked).
    async revoke(id,owner,ip=''){
      const pg=await pool();let ok;
      if(pg)ok=(await pg.query('update flygon_flow_api_keys set revoked_at=now() where id=$1 and lower(owner_email)=lower($2) and revoked_at is null',[id,owner])).rowCount>0;
      else{const list=read(file),k=list.find(x=>x.id===id&&same(x.owner,owner)&&!x.revokedAt);ok=!!k;if(k){k.revokedAt=new Date(now()).toISOString();write(file,list)}}
      if(ok)await this.audit(id,'revoke',ip);
      return ok;
    },
    // Record a use; written at most once a minute per key (the audit gets a 'use' entry each time).
    async touch(id,ip=''){
      const t=now();if(t-(touched.get(id)||0)<TOUCH)return false;
      touched.set(id,t);const at=new Date(t).toISOString(),pg=await pool();
      if(pg)await pg.query('update flygon_flow_api_keys set last_used_at=$2,last_used_ip=$3 where id=$1',[id,at,ip]);
      else{const list=read(file),k=list.find(x=>x.id===id);if(k){k.lastUsedAt=at;k.lastUsedIp=ip;write(file,list)}}
      await this.audit(id,'use',ip);
      return true;
    },
    // Append to the audit log; entries older than AUDIT_DAYS are dropped (checked at most hourly).
    async audit(keyId,op,ip=''){
      const t=now(),at=new Date(t).toISOString(),cut=new Date(t-AUDIT_DAYS*864e5).toISOString(),prune=t-pruned>3600e3,pg=await pool();
      if(prune)pruned=t;
      if(pg){
        await pg.query('insert into flygon_flow_api_key_audit(key_id,op,at,ip) values($1,$2,$3,$4)',[keyId,op,at,String(ip).slice(0,64)]);
        if(prune)await pg.query('delete from flygon_flow_api_key_audit where at<$1',[cut]).catch(()=>{});
        return;
      }
      let log=read(auditFile);log.push({keyId,op,at,ip:String(ip).slice(0,64)});
      if(prune)log=log.filter(e=>e.at>=cut);
      write(auditFile,log.slice(-AUDIT_MAX));
    },
    async auditLog(keyId){
      const pg=await pool();
      if(pg)return (await pg.query('select key_id,op,at,ip from flygon_flow_api_key_audit where ($1::text is null or key_id=$1) order by id desc limit 200',[keyId||null])).rows.map(r=>({keyId:r.key_id,op:r.op,at:iso(r.at),ip:r.ip}));
      return read(auditFile).filter(e=>!keyId||e.keyId===keyId).reverse().slice(0,200);
    },
    MAX_KEYS,
  };
}

// ---------- rate limit: an in-memory token bucket per key ----------
// Defaults: bursts of 60, refilled at 2 requests a second. configureRateLimit() changes them;
// useRateLimiter(fn) swaps in another limiter (fn(keyId) -> {ok, retryAfter, remaining}), e.g. a
// shared one if the app ever runs on several instances, or a no-op in tests.
let LIMIT={capacity:60,refill:2,now:()=>Date.now()};
const buckets=new Map();
export function configureRateLimit(o={}){LIMIT={...LIMIT,...o};buckets.clear()}
export function resetRateLimits(){buckets.clear()}
function bucket(id){
  const t=LIMIT.now();let b=buckets.get(id);
  if(!b){b={tokens:LIMIT.capacity,at:t};buckets.set(id,b);if(buckets.size>10000)for(const k of buckets.keys()){buckets.delete(k);if(buckets.size<=5000)break}}
  b.tokens=Math.min(LIMIT.capacity,b.tokens+(t-b.at)/1000*LIMIT.refill);b.at=t;
  if(b.tokens>=1){b.tokens-=1;return {ok:true,remaining:Math.floor(b.tokens),retryAfter:0}}
  return {ok:false,remaining:0,retryAfter:Math.max(1,Math.ceil((1-b.tokens)/LIMIT.refill))};
}
let limiter=bucket;
export const useRateLimiter=fn=>{limiter=typeof fn==='function'?fn:bucket};
export const rateLimit=id=>limiter(id);

// ---------- authentication ----------
export const clientIp=req=>String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim()||req.socket?.remoteAddress||'';
// The presented key, if the Authorization header holds one of ours.
export function bearerKey(req){
  const m=/^Bearer\s+(\S+)$/.exec(req.headers?.authorization||'');
  return m&&KEY.test(m[1])?m[1]:null;
}
// -> null (no key, unknown, wrong, expired or revoked),
//    {limited:true, retryAfter, keyId} (valid but over its rate limit; no user), or
//    {user:{email}, envs:['<id>'|'*'], scopes, keyId, name, mode, remaining}.
export async function authenticateApiKey(req,store){
  const key=bearerKey(req);if(!key)return null;
  const m=KEY.exec(key),prefix=`flow_${m[1]}_${m[2].slice(0,PREFIX_LEN)}`,h=Buffer.from(hash(key),'hex'),ip=clientIp(req);
  let found=null;
  for(const k of await store.byPrefix(prefix)){
    const b=Buffer.from(String(k.hash||''),'hex');
    if(b.length===h.length&&timingSafeEqual(b,h))found=k;
  }
  if(!found)return null;
  const t=(store.now||Date.now)();
  if(found.revokedAt||(found.expiresAt&&Date.parse(found.expiresAt)<=t)){await store.audit(found.id,found.revokedAt?'denied-revoked':'denied-expired',ip).catch(()=>{});return null}
  const r=rateLimit(found.id);
  if(!r.ok){await store.audit(found.id,'limited',ip).catch(()=>{});return {limited:true,retryAfter:r.retryAfter,keyId:found.id}}
  await store.touch(found.id,ip).catch(()=>{});
  return {user:{email:found.owner},envs:[found.env],scopes:normScopes(found.scopes),keyId:found.id,name:found.name,mode:found.mode,remaining:r.remaining};
}
// For route handlers: authenticate, check scope (and environment), and answer 401/403/429 itself.
// Returns the auth object, or null once it has responded.
export async function requireApiKey(req,res,store,{scope='read',env}={}){
  const send=(code,body,headers={})=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(body))};
  let a;try{a=await authenticateApiKey(req,store)}catch{send(503,{error:'API keys are unavailable; try again shortly'});return null}
  if(!a){send(401,{error:'Invalid or expired API key'},{'WWW-Authenticate':'Bearer'});return null}
  if(a.limited){send(429,{error:'Too many requests'},{'Retry-After':String(a.retryAfter)});return null}
  if(!allows(a,scope,env)){send(403,{error:`This key does not allow ${scope}${env?' in this environment':''}`});return null}
  return a;
}
export const validEnv=e=>e==='*'||ENV.test(String(e||''));
