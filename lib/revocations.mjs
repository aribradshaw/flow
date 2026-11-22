// Removing someone from Flow: the owner removes a member (Settings › Account › People in Flow, or
// revoking an invite that was already claimed), or the membership is revoked on OneProfileID itself.
//
// Flow records the removal first (it then refuses that membership even if OneProfileID cannot be
// reached), asks OneProfileID to revoke the membership with the app secret (POST /membership/revoke;
// Flow has already checked that the caller is its owner), and ends the person's access here: their
// Flow sessions, API keys and MCP tokens (MCP uses API keys). A poller follows OneProfileID's
// /membership/events so revocations made elsewhere are applied the same way, and a new invitation that
// was claimed (a "claimed" event after the removal) lifts it again.
//
// Postgres tables flygon_flow_revocations and flygon_flow_state (additive), or BACKUP_DIR/_revocations.json
// and _membership-cursor.json. Nothing is deleted; a lifted removal keeps its row with clearedAt set.
//   {localId, email, opidId, by, source:'flow'|'opid', revokedAt, clearedAt, opidRevoked}
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

export const SCHEMA=[
  `create table if not exists flygon_flow_revocations(local_id text primary key,email text not null default '',opid_id text not null default '',by_email text not null default '',source text not null default 'flow',revoked_at timestamptz not null default now(),cleared_at timestamptz,opid_revoked boolean not null default false)`,
  `create table if not exists flygon_flow_state(key text primary key,value text not null,updated_at timestamptz not null default now())`,
];
const iso=v=>v?new Date(v).toISOString():null;
const row=r=>r&&{localId:r.local_id,email:r.email,opidId:r.opid_id,by:r.by_email,source:r.source,revokedAt:iso(r.revoked_at),clearedAt:iso(r.cleared_at),opidRevoked:!!r.opid_revoked};
const LOCAL_ID=/^[A-Za-z0-9_-]{1,128}$/;
const CACHE_MS=30e3;

export function revocationStore({dir,db}){
  const file=join(dir,'_revocations.json'),cursorFile=join(dir,'_membership-cursor.json');
  const read=f=>{try{const v=JSON.parse(readFileSync(f,'utf8'));return v}catch{return null}};
  const write=(f,v)=>{mkdirSync(dir,{recursive:true});writeFileSync(f+'.tmp',JSON.stringify(v,null,2));renameSync(f+'.tmp',f)};
  const list=()=>{const l=read(file);return Array.isArray(l)?l:[]};
  // A database error is thrown: a removal must not be recorded in (or read from) a different store.
  const pool=async()=>await db();
  let cache=null;
  // After a write the next read goes to the store (cache.at=0 keeps the old list only as the fallback).
  const changed=()=>{if(cache)cache.at=0};
  return {
    async all(){const pg=await pool();if(pg)return (await pg.query('select * from flygon_flow_revocations order by revoked_at desc')).rows.map(row);return list()},
    async get(localId){
      const pg=await pool();
      if(pg)return row((await pg.query('select * from flygon_flow_revocations where local_id=$1',[localId])).rows[0])||null;
      return list().find(r=>r.localId===localId)||null;
    },
    // Removals in force: membership ids, and the emails and OneProfileID ids they belong to. Cached briefly.
    async active(){
      if(cache&&Date.now()-cache.at<CACHE_MS)return cache;
      // While the database is unreachable the last list read stays in force; with none yet, this throws.
      let all;try{all=await this.all()}catch(e){if(cache)return cache;throw e}
      const on=all.filter(r=>!r.clearedAt);
      cache={at:Date.now(),ids:new Set(on.map(r=>r.localId)),list:on};
      return cache;
    },
    // A removal in force for this person (by email or OneProfileID id), or null.
    async forPerson({email,opidId}){
      email=String(email||'').toLowerCase();
      return (await this.active()).list.find(r=>(email&&r.email===email)||(opidId&&r.opidId===opidId))||null;
    },
    // Record (or renew) a removal. revokedAt: when it happened (a OneProfileID event's time), default now.
    async add({localId,email='',opidId='',by='',source='flow',revokedAt=null,opidRevoked=false}){
      if(!LOCAL_ID.test(String(localId||'')))throw Error('Invalid membership id');
      email=String(email||'').toLowerCase();opidId=String(opidId||'').slice(0,128);
      const at=revokedAt||new Date().toISOString(),pg=await pool();changed();
      if(pg){
        await pg.query(`insert into flygon_flow_revocations(local_id,email,opid_id,by_email,source,revoked_at,opid_revoked) values($1,$2,$3,$4,$5,$6,$7)
          on conflict (local_id) do update set cleared_at=null,
            revoked_at=case when flygon_flow_revocations.cleared_at is null then flygon_flow_revocations.revoked_at else excluded.revoked_at end,
            email=case when excluded.email<>'' then excluded.email else flygon_flow_revocations.email end,
            opid_id=case when excluded.opid_id<>'' then excluded.opid_id else flygon_flow_revocations.opid_id end,
            by_email=case when excluded.by_email<>'' then excluded.by_email else flygon_flow_revocations.by_email end,
            opid_revoked=flygon_flow_revocations.opid_revoked or excluded.opid_revoked`,[localId,email,opidId,by,source,at,opidRevoked]);
        return this.get(localId);
      }
      const l=list(),cur=l.find(r=>r.localId===localId);
      if(cur){if(cur.clearedAt){cur.revokedAt=at;cur.clearedAt=null}if(email)cur.email=email;if(opidId)cur.opidId=opidId;if(by)cur.by=by;cur.opidRevoked=cur.opidRevoked||opidRevoked}
      else l.push({localId,email,opidId,by,source,revokedAt:at,clearedAt:null,opidRevoked});
      write(file,l);return l.find(r=>r.localId===localId);
    },
    async markOpidRevoked(localId){
      const pg=await pool();changed();
      if(pg){await pg.query('update flygon_flow_revocations set opid_revoked=true where local_id=$1',[localId]);return}
      const l=list(),cur=l.find(r=>r.localId===localId);if(cur){cur.opidRevoked=true;write(file,l)}
    },
    // Lift a removal (the person claimed a new invitation for this membership).
    async clear(localId){
      const pg=await pool();changed();
      if(pg){await pg.query('update flygon_flow_revocations set cleared_at=now() where local_id=$1 and cleared_at is null',[localId]);return}
      const l=list(),cur=l.find(r=>r.localId===localId&&!r.clearedAt);if(cur){cur.clearedAt=new Date().toISOString();write(file,l)}
    },
    // Lift every removal of one person (they signed in with a membership that is not removed: a new invite).
    async clearPerson(person){
      for(let r=await this.forPerson(person);r;r=await this.forPerson(person))await this.clear(r.localId);
    },
    // The last /membership/events cursor seen.
    async cursor(){
      const pg=await pool();
      if(pg)return (await pg.query("select value from flygon_flow_state where key='opid.membership.cursor'")).rows[0]?.value||'';
      return String(read(cursorFile)?.cursor||'');
    },
    async setCursor(v){
      v=String(v);const pg=await pool();
      if(pg){await pg.query("insert into flygon_flow_state(key,value) values('opid.membership.cursor',$1) on conflict (key) do update set value=excluded.value,updated_at=now()",[v]);return}
      write(cursorFile,{cursor:v,at:new Date().toISOString()});
    },
  };
}

// The removal itself, and the poller.
//   store    revocationStore
//   opid     {revoke(localId) -> {ok,status,payload}, events(after) -> {ok,status,payload}} | null (local mode)
//   resolve  async localId -> {email, opidId} | null: who in Flow holds that membership
//   endAccess async {email, opidId} -> void: end their sessions, API keys and MCP tokens
export function membershipControl({store,opid,resolve,endAccess,log=console}){
  let running=null,timer=null,lastProblem='';
  const problem=msg=>{if(msg!==lastProblem){lastProblem=msg;log.error?.(`membership sync: ${msg}`)}};
  const tryOpid=async localId=>{
    if(!opid)return false;
    try{const r=await opid.revoke(localId);if(r.ok){await store.markOpidRevoked(localId);return true}problem(`OneProfileID did not revoke a membership (${r.status})`)}
    catch{problem('OneProfileID could not be reached to revoke a membership')}
    return false;
  };
  async function apply(person){if(person&&(person.email||person.opidId))await endAccess(person)}
  return {
    // The owner removes someone. The caller has checked that it is the owner and that this is not the owner.
    // -> {localId, opidRevoked}
    async revoke({localId,email='',opidId='',by=''}){
      const who=await resolve(localId).catch(()=>null);
      const person={email:String(email||who?.email||'').toLowerCase(),opidId:opidId||who?.opidId||''};
      await store.add({localId,...person,by,source:'flow'});
      const opidRevoked=await tryOpid(localId);
      await apply(person);
      return {localId,opidRevoked};
    },
    // One pass over OneProfileID's membership events (and a retry of removals it has not confirmed yet).
    // -> {applied, cursor} | null when it could not run.
    async poll(){
      if(!opid)return null;
      if(running)return running;
      running=(async()=>{
        let applied=0,after=await store.cursor();
        for(const r of (await store.active()).list)if(r.source==='flow'&&!r.opidRevoked)await tryOpid(r.localId);
        for(let page=0;page<20;page++){
          let r;try{r=await opid.events(after)}catch{problem('OneProfileID could not be reached for membership events');return null}
          if(!r.ok){problem(`membership events are unavailable (${r.status})`);return null}
          const {events=[],cursor,more}=r.payload||{};
          for(const e of Array.isArray(events)?events:[]){
            if(!LOCAL_ID.test(String(e?.localId||''))||!e.createdAt)continue;
            const cur=await store.get(e.localId);
            if(e.kind==='revoked'){
              // An old revocation that a later invitation already lifted changes nothing.
              if(cur?.clearedAt&&Date.parse(e.createdAt)<=Date.parse(cur.clearedAt))continue;
              const who=await resolve(e.localId).catch(()=>null);
              if(!cur||cur.clearedAt)await store.add({localId:e.localId,...(who||{}),source:'opid',revokedAt:new Date(e.createdAt).toISOString(),opidRevoked:true});
              await apply(who||cur);applied++;
            }else if(e.kind==='claimed'&&cur&&!cur.clearedAt&&Date.parse(e.createdAt)>Date.parse(cur.revokedAt)){await store.clear(e.localId);applied++}
          }
          if(typeof cursor==='string'&&/^\d{1,18}$/.test(cursor)&&cursor!==after){after=cursor;await store.setCursor(cursor)}
          if(!more)break;
        }
        lastProblem='';
        return {applied,cursor:after};
      })().catch(e=>{problem(e?.message||'failed');return null}).finally(()=>{running=null});
      return running;
    },
    // Poll every intervalMs (0: never). The timer does not keep the process alive.
    start(intervalMs){
      if(!opid||!(intervalMs>0)||timer)return false;
      timer=setInterval(()=>{this.poll()},intervalMs);timer.unref?.();
      setTimeout(()=>this.poll(),Math.min(intervalMs,5000)).unref?.();
      return true;
    },
    stop(){clearInterval(timer);timer=null},
  };
}
