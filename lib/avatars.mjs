// One avatar per account (docs/concepts/13-avatars.md): the portable spec (public/avatar-spec.js), stored
// per person by sign-in email, with their choice to show it instead of their photo. Every office, shared
// environments included, draws this one avatar; the look editor saves here.
//
// Postgres table flygon_flow_avatars (additive) or BACKUP_DIR/_avatars.json.
//   get(email) -> {email, avatar, custom, usePortrait, updated, source}
//                 avatar is always a full spec: the saved one, or the default for the person's seed.
//   many(emails) -> Map(email -> the same)
//   save(email, spec|null) -> the same     null goes back to the default (the row stays, so nothing is
//                                          migrated again)
//   setUsePortrait(email, on) -> the same
//
// seedOf(email): the stable seed for someone's default avatar (the office member key, an opaque HMAC).
// legacy(email) -> [{data, updated}]: looks saved before accounts had avatars (lib/office-storage.mjs
// legacyLooks). The first read of an account with no row takes the most recently saved one and keeps it
// here, so it is migrated once.
//
// source: an avatarSource seam for OneProfileID later ('local' today; see the doc). Nothing here calls out.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {readAvatar,validateAvatar,defaultAvatar,sameAvatar} from '../public/avatar-spec.js';

export const SCHEMA=[`create table if not exists flygon_flow_avatars(email text primary key,data jsonb,use_portrait boolean not null default false,updated bigint not null default 0,source text not null default 'local')`];

const lc=v=>String(v||'').trim().toLowerCase();
// The newest of several saved looks. Ties keep the first.
export function latestLook(rows){
  let best=null;
  for(const r of rows||[])if(r&&r.data&&typeof r.data==='object'&&(!best||Number(r.updated||0)>Number(best.updated||0)))best=r;
  return best;
}

export function avatarStore({dir,db,seedOf=email=>email,legacy=async()=>[],now=()=>Date.now()}){
  // No dir: memory only (tests, and an office hub given no store).
  const file=dir?join(dir,'_avatars.json'):null,mem={};
  const read=()=>{if(!file)return mem;try{const l=JSON.parse(readFileSync(file,'utf8'));return l&&typeof l==='object'&&!Array.isArray(l)?l:{}}catch{return {}}};
  const write=m=>{if(!file)return;mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(m));renameSync(file+'.tmp',file)};
  const pool=async()=>{try{return await db?.()||null}catch{return null}};
  // Accounts looked up with no row and nothing to migrate: not asked again by this process.
  const empty=new Set();
  const view=(email,row)=>{
    const seed=seedOf(email),custom=!!row?.data;
    return {email,avatar:custom?readAvatar(row.data,seed):defaultAvatar(seed),custom,usePortrait:!!row?.usePortrait,updated:Number(row?.updated||0),source:row?.source||'local'};
  };
  async function rowOf(email){
    const pg=await pool();
    if(pg){const r=(await pg.query('select data,use_portrait,updated,source from flygon_flow_avatars where email=$1',[email])).rows[0];return r?{data:r.data,usePortrait:r.use_portrait,updated:Number(r.updated),source:r.source}:null}
    return read()[email]||null;
  }
  async function put(email,row){
    const pg=await pool();
    if(pg){await pg.query(`insert into flygon_flow_avatars(email,data,use_portrait,updated,source) values($1,$2,$3,$4,$5)
      on conflict (email) do update set data=excluded.data,use_portrait=excluded.use_portrait,updated=excluded.updated,source=excluded.source`,[email,row.data?JSON.stringify(row.data):null,!!row.usePortrait,row.updated,row.source||'local']);return}
    const m=read();m[email]={...row,data:row.data?structuredClone(row.data):null};write(m);
  }
  // A row, migrating a legacy look into it on the first read.
  async function load(email){
    const row=await rowOf(email);if(row||empty.has(email))return row;
    let rows;try{rows=await legacy(email)}catch{return null} // the old store is down: try again next time
    const old=latestLook(rows);
    if(!old){empty.add(email);if(empty.size>20000)empty.clear();return null}
    const seed=seedOf(email),spec=readAvatar(old.data,seed);
    // A legacy look that is exactly the default is no avatar at all.
    const migrated={data:sameAvatar(spec,defaultAvatar(seed))?null:spec,usePortrait:false,updated:Number(old.updated||0)||now(),source:'local'};
    await put(email,migrated);
    return migrated;
  }
  const store={
    async get(email){email=lc(email);return view(email,await load(email))},
    async many(emails){
      const out=new Map();
      for(const e of new Set((emails||[]).map(lc).filter(Boolean)))out.set(e,view(e,await load(e)));
      return out;
    },
    // spec: anything validateAvatar accepts, or null for the default.
    async save(email,spec){
      email=lc(email);const seed=seedOf(email);
      let data=spec===null||spec===undefined?null:validateAvatar(spec);
      if(data&&sameAvatar(data,defaultAvatar(seed)))data=null;
      const cur=await load(email);
      const row={data,usePortrait:!!cur?.usePortrait,updated:now(),source:'local'};
      await put(email,row);empty.delete(email);
      return view(email,row);
    },
    async setUsePortrait(email,on){
      email=lc(email);const cur=await load(email);
      const row={data:cur?.data||null,usePortrait:!!on,updated:cur?.updated||now(),source:cur?.source||'local'};
      await put(email,row);empty.delete(email);
      return view(email,row);
    },
  };
  return store;
}
