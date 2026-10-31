// App sessions that survive deploys: stored in Postgres when DATABASE_URL is set (table
// flygon_flow_sessions, additive), in memory otherwise. Only a SHA-256 hash of the session id is
// stored, so a database dump cannot be replayed as cookies. A session alone never authenticates:
// lib/auth.mjs still revalidates the central OneProfileID session on every request.
import {createHash} from 'node:crypto';

export const SCHEMA=[
  `create table if not exists flygon_flow_sessions(id_hash text primary key,user_id text not null,user_json jsonb not null,created_at timestamptz not null,last_at timestamptz not null,expires_at timestamptz not null)`,
  `create index if not exists flygon_flow_sessions_expires on flygon_flow_sessions(expires_at)`,
];
const hash=sid=>createHash('sha256').update(String(sid)).digest('base64url');
const TOUCH=60e3;

// db: async () => pg Pool | null.  max: absolute lifetime (ms).
export function sessionStore({db=async()=>null,max}={}){
  const mem=new Map();let swept=0;
  const pool=()=>db().catch(()=>null);
  return {
    async get(sid){
      const h=hash(sid),cached=mem.get(h);if(cached)return cached;
      const pg=await pool();if(!pg)return null;
      const r=(await pg.query('select user_json,created_at,last_at from flygon_flow_sessions where id_hash=$1 and expires_at>now()',[h])).rows[0];
      if(!r)return null;
      const s={user:r.user_json,created:new Date(r.created_at).getTime(),last:new Date(r.last_at).getTime(),saved:new Date(r.last_at).getTime()};
      mem.set(h,s);return s;
    },
    async set(sid,s){
      const h=hash(sid);s.saved=s.last;mem.set(h,s);
      const pg=await pool();if(!pg)return;
      await pg.query('insert into flygon_flow_sessions(id_hash,user_id,user_json,created_at,last_at,expires_at) values($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),to_timestamp($6/1000.0)) on conflict (id_hash) do update set user_json=excluded.user_json,last_at=excluded.last_at',
        [h,s.user.id,s.user,s.created,s.last,s.created+max]);
      if(Date.now()-swept>3600e3){swept=Date.now();pg.query('delete from flygon_flow_sessions where expires_at<now()').catch(()=>{})}
    },
    // Record activity; the database is updated at most once a minute per session.
    async touch(sid,s){
      if(s.last-(s.saved||0)<TOUCH)return;
      s.saved=s.last;const pg=await pool();if(!pg)return;
      await pg.query('update flygon_flow_sessions set last_at=to_timestamp($2/1000.0),user_json=$3 where id_hash=$1',[hash(sid),s.last,s.user]).catch(()=>{});
    },
    async delete(sid){
      const h=hash(sid);mem.delete(h);
      const pg=await pool();if(pg)await pg.query('delete from flygon_flow_sessions where id_hash=$1',[h]).catch(()=>{});
    },
  };
}
