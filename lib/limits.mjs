// Guardrails for a Flow that anyone with a OneProfileID can join (docs/self-hosting.md, "Limits").
//
//   caps(env)                  the configured limits (env vars, with defaults), and limitsFor(email)
//   memoryLimiter({max,ms})    fixed per-process sliding window: take(key) -> true while under max
//   rateStore({dir,db})        the same, kept in Postgres (flygon_flow_rate_events) or a JSON file, so
//                              limits survive deploys (invite emails, member invite quotas)
//   requestIp(req)             the client address for limits: the last X-Forwarded-For hop (the one the
//                              hosting proxy added), else the socket
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

const num=(v,d)=>{const n=Number(v);return v!==undefined&&v!==''&&Number.isFinite(n)&&n>=0?n:d};
const MB=1024*1024;
// Non-owner defaults first; the owner (OWNER_EMAIL) has its own, larger ones.
export function caps(env=process.env){
  const c={
    maxEnvironments:num(env.FLOW_MAX_ENVIRONMENTS,5),
    maxWorkspaceBytes:num(env.FLOW_MAX_WORKSPACE_BYTES,2*MB),ownerMaxWorkspaceBytes:num(env.FLOW_OWNER_MAX_WORKSPACE_BYTES,5*MB),
    historyKeep:num(env.FLOW_HISTORY_KEEP,20),ownerHistoryKeep:num(env.FLOW_OWNER_HISTORY_KEEP,100),
    maxApiKeys:num(env.FLOW_MAX_API_KEYS,5),ownerMaxApiKeys:num(env.FLOW_OWNER_MAX_API_KEYS,50),
    maxUserBytes:num(env.FLOW_MAX_USER_BYTES,25*MB),
    maxUsers:num(env.FLOW_MAX_USERS,500),
    // Cards, nodes, edges, projects, timeline items, agents and workflows in one workspace.
    maxItems:num(env.FLOW_MAX_ITEMS,20000),ownerMaxItems:num(env.FLOW_OWNER_MAX_ITEMS,100000),
    maxSaves:num(env.FLOW_MAX_SAVES,20),
    publicAfterDays:num(env.FLOW_PUBLIC_AFTER_DAYS,7),
    memberInvitesPerWeek:num(env.FLOW_MEMBER_INVITES_PER_WEEK,5),
    authPerIpPerMinute:num(env.FLOW_AUTH_RATE_IP,30),authPerUserPerMinute:num(env.FLOW_AUTH_RATE_USER,10),
  };
  return c;
}
// What applies to one person: the owner keeps the larger limits and no environment or storage cap.
export function limitsFor(c,{owner}){
  return owner?{owner:true,maxItems:c.ownerMaxItems,maxEnvironments:Infinity,maxWorkspaceBytes:c.ownerMaxWorkspaceBytes,historyKeep:c.ownerHistoryKeep,maxApiKeys:c.ownerMaxApiKeys,maxUserBytes:Infinity,maxSaves:Infinity,invitesPerWeek:Infinity}
    :{owner:false,maxItems:c.maxItems,maxEnvironments:c.maxEnvironments,maxWorkspaceBytes:c.maxWorkspaceBytes,historyKeep:c.historyKeep,maxApiKeys:c.maxApiKeys,maxUserBytes:c.maxUserBytes,maxSaves:c.maxSaves,invitesPerWeek:c.memberInvitesPerWeek};
}
export const bytesOf=data=>Buffer.byteLength(JSON.stringify(data??null));
export const fmtBytes=n=>n>=MB?`${Math.round(n/MB*10)/10} MB`:`${Math.round(n/1024)} KB`;

export function memoryLimiter({max,ms}){
  const hits=new Map();
  return {
    take(key){
      const now=Date.now(),a=(hits.get(key)||[]).filter(t=>now-t<ms);
      if(a.length>=max){hits.set(key,a);return false}
      a.push(now);hits.set(key,a);
      if(hits.size>20000)for(const k of hits.keys()){hits.delete(k);if(hits.size<10000)break}
      return true;
    },
  };
}
export const requestIp=req=>{const x=String(req.headers?.['x-forwarded-for']||'').split(',').map(s=>s.trim()).filter(Boolean);return x.at(-1)||req.socket?.remoteAddress||''};

export const SCHEMA=[
  `create table if not exists flygon_flow_rate_events(id bigserial primary key,key text not null,at timestamptz not null default now())`,
  `create index if not exists flygon_flow_rate_events_key on flygon_flow_rate_events(key,at desc)`,
];
// Persistent rolling windows. take(key,max,ms) records one event when under max; count(key,ms) reads.
export function rateStore({dir,db}){
  const file=join(dir,'_rate-events.json');
  const read=()=>{try{const v=JSON.parse(readFileSync(file,'utf8'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}catch{return {}}};
  const write=v=>{mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(v));renameSync(file+'.tmp',file)};
  const pool=()=>db().catch(()=>null);
  let chain=Promise.resolve();
  const serial=fn=>{const r=chain.then(fn);chain=r.catch(()=>{});return r};
  return {
    async count(key,ms){
      const pg=await pool();
      if(pg)return (await pg.query(`select count(*)::int n from flygon_flow_rate_events where key=$1 and at>now()-($2::bigint*interval '1 millisecond')`,[key,ms])).rows[0].n;
      const now=Date.now();return (read()[key]||[]).filter(t=>now-t<ms).length;
    },
    take(key,max,ms){return serial(async()=>{
      const pg=await pool();
      if(pg){
        const c=await pg.connect();
        try{
          await c.query('begin');
          await c.query('select pg_advisory_xact_lock(hashtextextended($1,7))',[key]);
          const n=(await c.query(`select count(*)::int n from flygon_flow_rate_events where key=$1 and at>now()-($2::bigint*interval '1 millisecond')`,[key,ms])).rows[0].n;
          if(n>=max){await c.query('rollback');return false}
          await c.query('insert into flygon_flow_rate_events(key) values($1)',[key]);
          // Old events are of no use to any window.
          if(Math.random()<0.02)await c.query(`delete from flygon_flow_rate_events where at<now()-interval '30 days'`);
          await c.query('commit');return true;
        }catch(e){await c.query('rollback').catch(()=>{});throw e}finally{c.release()}
      }
      const all=read(),now=Date.now(),a=(all[key]||[]).filter(t=>now-t<Math.max(ms,864e5));
      if(a.filter(t=>now-t<ms).length>=max){all[key]=a;write(all);return false}
      a.push(now);all[key]=a;
      for(const k of Object.keys(all))if(!all[k].some(t=>now-t<30*864e5))delete all[k];
      write(all);return true;
    })},
  };
}

// A workspace store (lib/workspaces.mjs) with the caps applied on every write. A refused write
// returns {refused:{status, code, error}} and changes nothing. Writes that do not grow a workspace
// are never refused for size, so someone over a limit can always delete things. mirror writes (a
// local copy of the authoritative server) are not checked.
//   isOwner(email)   the Flow owner (OWNER_EMAIL)
//   accountOf(email) -> {firstSeen} | null (lib/users.mjs)
//   count(data)      things in a workspace (public/sync-core.js size)
export function cappedWorkspaces(store,{caps:c,isOwner,accountOf,count}){
  const refuse=(status,code,error)=>({refused:{status,code,error}});
  // Creating an environment is checked and written one at a time per owner, so parallel first saves
  // cannot all pass the environment count and storage caps before any of them is written.
  const turns=new Map();
  const ownerTurn=(owner,fn)=>{const prev=turns.get(owner)||Promise.resolve(),run=prev.then(fn,fn);
    const tail=run.catch(()=>{});turns.set(owner,tail);tail.then(()=>{if(turns.get(owner)===tail)turns.delete(owner)});return run};
  return {...store,
    async put(envId,opts){
      if(opts.mirror)return store.put(envId,opts);
      const first=await store.get(envId);
      if(!first)return ownerTurn(String(opts.owner||'').toLowerCase(),()=>this.putNow(envId,opts));
      return this.putNow(envId,opts,first);
    },
    async putNow(envId,opts,known){
      const cur=known!==undefined?known:await store.get(envId),owner=cur?.owner||opts.owner||'',L=limitsFor(c,{owner:isOwner(owner)});
      const n=count(opts.data),before=cur?.data?count(cur.data):0;
      if(n>L.maxItems&&n>before)return refuse(413,'too_many_items',`This workspace would hold ${n.toLocaleString('en-US')} cards, nodes and items; a workspace holds up to ${L.maxItems.toLocaleString('en-US')}. Nothing was saved.`);
      const b=bytesOf(opts.data),had=cur?.data?bytesOf(cur.data):0;
      if(b>L.maxWorkspaceBytes&&b>had)return refuse(413,'workspace_too_large',`This workspace would be ${fmtBytes(b)}; a workspace holds up to ${fmtBytes(L.maxWorkspaceBytes)}. Nothing was saved. Remove some cards or large notes and photos, or split it into another environment.`);
      if(!L.owner){
        if(!cur&&(await store.owned(owner)).length>=L.maxEnvironments)return refuse(403,'too_many_environments',`You have ${L.maxEnvironments} environments, the most an account can have. Archive one in Settings › Environment first.`);
        const all=await store.bytesOwned(owner),total=Object.values(all).reduce((s,x)=>s+x,0)-(all[envId]||0)+b;
        if(total>L.maxUserBytes&&b>had)return refuse(413,'storage_full',`Your environments would use ${fmtBytes(total)}; an account can store up to ${fmtBytes(L.maxUserBytes)}. Nothing was saved. Remove some cards, notes or photos (archived environments count too).`);
        // Too new to publish: the write goes through, kept private, and says why (publicRefused).
        if(opts.visibility==='public'&&cur?.visibility!=='public'){
          const why=await this.publicRefusal(owner);
          if(why){
            const data={...opts.data,environment:{...(opts.data?.environment||{}),visibility:'private'}};
            return {...await store.put(envId,{...opts,data,visibility:'private',keep:L.historyKeep}),publicRefused:why};
          }
        }
      }
      return store.put(envId,{...opts,keep:L.historyKeep});
    },
    // Why this owner may not make an environment public yet, or '' (the owner and older accounts may).
    async publicRefusal(owner){
      if(isOwner(owner))return '';
      const u=await accountOf(owner),since=u?.firstSeen?Date.parse(u.firstSeen):Date.now();
      if((Date.now()-since)/864e5>=c.publicAfterDays)return '';
      return `New accounts can make an environment public ${c.publicAfterDays} days after they join (from ${new Date(since+c.publicAfterDays*864e5).toISOString().slice(0,10)}). It stays private until then.`;
    },
  };
}
