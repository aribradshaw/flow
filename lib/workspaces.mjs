// Server-side workspaces: the source of truth for each environment's data.
//   {envId, rev, data, owner, visibility, name, updatedAt, updatedBy}
// Postgres when DATABASE_URL is set (tables flygon_flow_workspaces + flygon_flow_workspace_history,
// additive, created idempotently), otherwise JSON files under BACKUP_DIR/workspaces. Every write
// keeps the previous revision in the history first, so nothing is ever lost.
import {readFileSync,writeFileSync,mkdirSync,renameSync,readdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';

const KEEP=100;
export const SCHEMA=[
  `create table if not exists flygon_flow_workspaces(env_id text primary key,name text not null default '',owner_email text not null,visibility text not null default 'private',rev bigint not null,data jsonb not null,updated_at timestamptz not null default now(),updated_by text not null default '')`,
  `create table if not exists flygon_flow_workspace_history(id bigserial primary key,env_id text not null,rev bigint not null,data jsonb not null,saved_at timestamptz not null default now(),saved_by text not null default '')`,
  `create index if not exists flygon_flow_workspace_history_env on flygon_flow_workspace_history(env_id,rev desc)`,
  // Environments are archived, never deleted: an archived workspace is hidden but kept.
  `alter table flygon_flow_workspaces add column if not exists archived_at timestamptz`,
];
const row=r=>r&&{envId:r.env_id,name:r.name,owner:r.owner_email,visibility:r.visibility,rev:Number(r.rev),data:r.data,updatedAt:new Date(r.updated_at).toISOString(),updatedBy:r.updated_by,archivedAt:r.archived_at?new Date(r.archived_at).toISOString():null};

export function workspaceStore({dir,db}){
  const root=join(dir,'workspaces'),hist=join(root,'history'),file=id=>join(root,id+'.json');
  const readFile=id=>{try{return JSON.parse(readFileSync(file(id),'utf8'))}catch{return null}};
  const atomic=(f,v)=>{writeFileSync(f+'.tmp',JSON.stringify(v));renameSync(f+'.tmp',f)};
  return {
    async get(envId){
      const pg=await db();
      if(pg)return row((await pg.query('select * from flygon_flow_workspaces where env_id=$1',[envId])).rows[0])||null;
      return readFile(envId);
    },
    // The newest workspace a user owns (for a browser that does not know its environment yet).
    async ownedBy(email){
      const pg=await db();
      return (await this.owned(email))[0]||null;
    },
    // Every (not archived) workspace a user owns, newest first.
    async owned(email){
      const pg=await db();
      if(pg)return (await pg.query('select * from flygon_flow_workspaces where lower(owner_email)=lower($1) and archived_at is null order by updated_at desc',[email])).rows.map(row);
      try{return readdirSync(root).filter(f=>f.endsWith('.json')).map(f=>readFile(f.slice(0,-5))).filter(w=>w&&!w.archivedAt&&w.owner?.toLowerCase()===email.toLowerCase()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))}catch{return []}
    },
    async archive(envId){
      const pg=await db();
      if(pg){await pg.query('update flygon_flow_workspaces set archived_at=now() where env_id=$1',[envId]);return}
      const w=readFile(envId);if(w){w.archivedAt=new Date().toISOString();atomic(file(envId),w)}
    },
    // Write if the caller started from the current revision; otherwise report the conflict.
    async put(envId,{baseRev,data,by,owner,visibility='private',name=''}){
      const pg=await db(),now=new Date().toISOString();
      if(pg){
        const c=await pg.connect();
        try{
          await c.query('begin');
          const cur=row((await c.query('select * from flygon_flow_workspaces where env_id=$1 for update',[envId])).rows[0]);
          if((cur?.rev||0)!==baseRev){await c.query('rollback');return {conflict:true,current:cur}}
          if(cur){
            await c.query('insert into flygon_flow_workspace_history(env_id,rev,data,saved_by) values($1,$2,$3,$4)',[envId,cur.rev,cur.data,cur.updatedBy]);
            await c.query('delete from flygon_flow_workspace_history where env_id=$1 and id not in (select id from flygon_flow_workspace_history where env_id=$1 order by rev desc limit $2)',[envId,KEEP]);
            await c.query('update flygon_flow_workspaces set rev=$2,data=$3,updated_at=now(),updated_by=$4,name=$5,visibility=$6 where env_id=$1',[envId,cur.rev+1,data,by,name||cur.name,visibility||cur.visibility]);
          }else{
            const r=await c.query('insert into flygon_flow_workspaces(env_id,name,owner_email,visibility,rev,data,updated_by) values($1,$2,$3,$4,1,$5,$6) on conflict (env_id) do nothing',[envId,name,owner,visibility,data,by]);
            if(!r.rowCount){await c.query('rollback');return {conflict:true,current:await this.get(envId)}}
          }
          await c.query('commit');
          return {ok:true,rev:(cur?.rev||0)+1};
        }catch(e){await c.query('rollback').catch(()=>{});throw e}finally{c.release()}
      }
      // Files: single process, so read-check-write is atomic enough here.
      const cur=readFile(envId);
      if((cur?.rev||0)!==baseRev)return {conflict:true,current:cur};
      mkdirSync(hist,{recursive:true});
      if(cur){
        atomic(join(hist,`${envId}.${cur.rev}.json`),cur);
        const old=readdirSync(hist).filter(f=>f.startsWith(envId+'.')).sort((a,b)=>parseInt(a.split('.').at(-2))-parseInt(b.split('.').at(-2)));
        for(const f of old.slice(0,Math.max(0,old.length-KEEP)))unlinkSync(join(hist,f));
      }
      const next={envId,name:name||cur?.name||'',owner:cur?.owner||owner,visibility:visibility||cur?.visibility||'private',rev:(cur?.rev||0)+1,data,updatedAt:now,updatedBy:by};
      atomic(file(envId),next);
      return {ok:true,rev:next.rev};
    },
    async history(envId){
      const pg=await db();
      if(pg)return (await pg.query('select rev,saved_at,saved_by from flygon_flow_workspace_history where env_id=$1 order by rev desc limit 20',[envId])).rows.map(r=>({rev:Number(r.rev),savedAt:new Date(r.saved_at).toISOString(),savedBy:r.saved_by}));
      try{return readdirSync(hist).filter(f=>f.startsWith(envId+'.')).map(f=>({rev:parseInt(f.split('.').at(-2))})).sort((a,b)=>b.rev-a.rev).slice(0,20)}catch{return []}
    },
  };
}
