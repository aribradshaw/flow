// People who have signed in to this Flow: one row per email (Flow keys ownership by email).
// Used for the user cap (FLOW_MAX_USERS), an account's age (new accounts wait before making an
// environment public) and the inviter name in invite emails, which is the name OneProfileID gave.
// Postgres table flygon_flow_users (additive) or BACKUP_DIR/_users.json.
//   seen(user, {existing})  record a sign-in; existing:true marks someone who used Flow before this
//                           table did (they keep full rights: firstSeen is the epoch)
//   get(email) -> {email, opidId, name, firstSeen, lastSeen} | null      count() -> number
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

export const SCHEMA=[`create table if not exists flygon_flow_users(email text primary key,opid_id text not null default '',name text not null default '',first_seen timestamptz not null default now(),last_seen timestamptz not null default now())`];
const EPOCH='1970-01-01T00:00:00.000Z';
const iso=v=>v?new Date(v).toISOString():null;
const row=r=>r&&{email:r.email,opidId:r.opid_id,name:r.name,firstSeen:iso(r.first_seen),lastSeen:iso(r.last_seen)};
const cleanName=v=>String(v||'').replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,100);

export function userStore({dir,db}){
  const file=join(dir,'_users.json');
  const read=()=>{try{const l=JSON.parse(readFileSync(file,'utf8'));return Array.isArray(l)?l:[]}catch{return []}};
  const write=l=>{mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(l,null,2));renameSync(file+'.tmp',file)};
  const pool=()=>db().catch(()=>null);
  return {
    async get(email){
      email=String(email||'').toLowerCase();const pg=await pool();
      if(pg)return row((await pg.query('select * from flygon_flow_users where email=$1',[email])).rows[0])||null;
      return read().find(u=>u.email===email)||null;
    },
    async count(){
      const pg=await pool();
      if(pg)return (await pg.query('select count(*)::int n from flygon_flow_users')).rows[0].n;
      return read().length;
    },
    async seen(user,{existing=false}={}){
      const email=String(user?.email||'').toLowerCase();if(!email)return null;
      const name=cleanName(user.name),opidId=String(user.id||'').slice(0,128),first=existing?EPOCH:new Date().toISOString(),pg=await pool();
      if(pg){await pg.query('insert into flygon_flow_users(email,opid_id,name,first_seen) values($1,$2,$3,$4) on conflict (email) do update set last_seen=now(),name=case when excluded.name<>\'\' then excluded.name else flygon_flow_users.name end,opid_id=case when excluded.opid_id<>\'\' then excluded.opid_id else flygon_flow_users.opid_id end',[email,opidId,name,first]);return this.get(email)}
      const l=read(),cur=l.find(u=>u.email===email),now=new Date().toISOString();
      if(cur){cur.lastSeen=now;if(name)cur.name=name;if(opidId)cur.opidId=opidId}else l.push({email,opidId,name,firstSeen:first,lastSeen:now});
      write(l);return l.find(u=>u.email===email);
    },
  };
}
// Days since firstSeen (Infinity for someone recorded as existing, or unknown with data already).
export const ageDays=(u,now=Date.now())=>u?.firstSeen?(now-Date.parse(u.firstSeen))/864e5:0;

// "Tell me when there is room": people who signed in to OneProfileID while Flow was full or invite-only.
// The email is the verified one from their OneProfileID session, never typed. One row per email.
export const REQUEST_SCHEMA=[`create table if not exists flygon_flow_access_requests(email text primary key,name text not null default '',reason text not null default '',created_at timestamptz not null default now())`];
const reqRow=r=>r&&{email:r.email,name:r.name,reason:r.reason,createdAt:iso(r.created_at)};
export function accessRequestStore({dir,db}){
  const file=join(dir,'_access-requests.json');
  const read=()=>{try{const l=JSON.parse(readFileSync(file,'utf8'));return Array.isArray(l)?l:[]}catch{return []}};
  const write=l=>{mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(l,null,2));renameSync(file+'.tmp',file)};
  const pool=()=>db().catch(()=>null);
  return {
    async add({email,name,reason}){
      email=String(email||'').toLowerCase();if(!email)return null;name=cleanName(name);reason=String(reason||'').slice(0,20);const pg=await pool();
      if(pg){await pg.query('insert into flygon_flow_access_requests(email,name,reason) values($1,$2,$3) on conflict (email) do nothing',[email,name,reason]);return reqRow((await pg.query('select * from flygon_flow_access_requests where email=$1',[email])).rows[0])}
      const l=read();if(!l.some(x=>x.email===email)){l.push({email,name,reason,createdAt:new Date().toISOString()});write(l)}
      return l.find(x=>x.email===email);
    },
    async list(){
      const pg=await pool();
      if(pg)return (await pg.query('select * from flygon_flow_access_requests order by created_at')).rows.map(reqRow);
      return read();
    },
    async remove(email){
      email=String(email||'').toLowerCase();const pg=await pool();
      if(pg){await pg.query('delete from flygon_flow_access_requests where email=$1',[email]);return}
      write(read().filter(x=>x.email!==email));
    },
  };
}
