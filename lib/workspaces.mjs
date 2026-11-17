// Server-side workspaces: the source of truth for each environment's data.
//   {envId, rev, data, owner, visibility, name, updatedAt, updatedBy}
// Postgres when DATABASE_URL is set (tables flygon_flow_workspaces + flygon_flow_workspace_history,
// additive, created idempotently), otherwise JSON files under BACKUP_DIR/workspaces. Every write
// keeps the previous revision in the history first, so nothing is ever lost.
//
// Deleted cards: a write that removes DevOps cards records each one first, in the same transaction
// (table flygon_flow_card_deletes, or workspaces/deleted/<env>.json): the whole card as it was, who
// removed it and how (source.via: board, undo, snapshot, api, mcp, ...; source.actor: an API key's
// name), the revision it was last in and the environment. These are kept RETAIN_DAYS, apart from the
// revision history (KEEP revisions), so a card can be restored long after its revision rolled off.
import {readFileSync,writeFileSync,mkdirSync,renameSync,readdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {keepOpidLinks} from './opid-photos.mjs';

const KEEP=100;
export const RETAIN_DAYS=180;
const RETAIN_MS=RETAIN_DAYS*864e5;
export const SCHEMA=[
  `create table if not exists flygon_flow_workspaces(env_id text primary key,name text not null default '',owner_email text not null,visibility text not null default 'private',rev bigint not null,data jsonb not null,updated_at timestamptz not null default now(),updated_by text not null default '')`,
  `create table if not exists flygon_flow_workspace_history(id bigserial primary key,env_id text not null,rev bigint not null,data jsonb not null,saved_at timestamptz not null default now(),saved_by text not null default '')`,
  `create index if not exists flygon_flow_workspace_history_env on flygon_flow_workspace_history(env_id,rev desc)`,
  // Environments are archived, never deleted: an archived workspace is hidden but kept.
  `alter table flygon_flow_workspaces add column if not exists archived_at timestamptz`,
  `create table if not exists flygon_flow_card_deletes(id text primary key,env_id text not null,card_id text not null,number integer,title text not null default '',card jsonb not null,agents jsonb not null default '[]',deleted_at timestamptz not null default now(),deleted_by text not null default '',via text not null default '',actor text not null default '',from_rev bigint not null default 0,rev bigint not null default 0,restored_at timestamptz,restored_by text not null default '',restored_number integer)`,
  `create index if not exists flygon_flow_card_deletes_env on flygon_flow_card_deletes(env_id,deleted_at desc)`,
];
// Cards in `before` that are not in `after` (by id). Linked copies of shared cards (sh.*) belong to
// their owner's environment and are never recorded here.
const cardsOf=d=>Array.isArray(d?.devops?.cards)?d.devops.cards.filter(c=>c&&typeof c.id==='string'&&!c.id.startsWith('sh.')):[];
export function droppedCards(before,after){
  const keep=new Set(cardsOf(after).map(c=>c.id));
  return cardsOf(before).filter(c=>!keep.has(c.id));
}
// One record per dropped card. source = {via, actor, board:[card ids deleted on the board]}.
export function deleteEntries(envId,before,after,{by='',source={},fromRev=0,rev=0,at=new Date().toISOString()}={}){
  const board=new Set(Array.isArray(source.board)?source.board:[]),agents=before?.agentflow?.agents||[];
  return droppedCards(before,after).map(c=>({id:'del_'+randomUUID(),env:envId,cardId:c.id,number:Number.isInteger(c.number)?c.number:null,title:String(c.title||'').slice(0,200),
    card:c,agents:agents.filter(a=>Array.isArray(a?.cards)&&a.cards.includes(c.id)).map(a=>a.id),deletedAt:at,deletedBy:String(by||''),
    via:board.has(c.id)?'board':String(source.via||'save'),actor:String(source.actor||'').slice(0,80),fromRev,rev,restoredAt:null,restoredBy:'',restoredNumber:null}));
}
const delRow=r=>r&&{id:r.id,env:r.env_id,cardId:r.card_id,number:r.number,title:r.title,card:r.card,agents:r.agents||[],deletedAt:new Date(r.deleted_at).toISOString(),deletedBy:r.deleted_by,
  via:r.via,actor:r.actor,fromRev:Number(r.from_rev),rev:Number(r.rev),restoredAt:r.restored_at?new Date(r.restored_at).toISOString():null,restoredBy:r.restored_by||'',restoredNumber:r.restored_number??null};
const row=r=>r&&{envId:r.env_id,name:r.name,owner:r.owner_email,visibility:r.visibility,rev:Number(r.rev),data:r.data,updatedAt:new Date(r.updated_at).toISOString(),updatedBy:r.updated_by,archivedAt:r.archived_at?new Date(r.archived_at).toISOString():null};

export function workspaceStore({dir,db}){
  const root=join(dir,'workspaces'),hist=join(root,'history'),file=id=>join(root,id+'.json');
  const readFile=id=>{try{return JSON.parse(readFileSync(file(id),'utf8'))}catch{return null}};
  const atomic=(f,v)=>{writeFileSync(f+'.tmp',JSON.stringify(v));renameSync(f+'.tmp',f)};
  const delRoot=join(root,'deleted'),delFile=id=>join(delRoot,id+'.json');
  const readDel=id=>{try{const l=JSON.parse(readFileSync(delFile(id),'utf8'));return Array.isArray(l)?l:[]}catch{return []}};
  const writeDel=(id,list)=>{mkdirSync(delRoot,{recursive:true});const cut=Date.now()-RETAIN_MS;atomic(delFile(id),list.filter(e=>Date.parse(e.deletedAt)>=cut))};
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
    // source (optional): how the change was made, for the deleted-cards record (see above).
    // OneProfileID links on person cards (lib/opid-photos.mjs keepOpidLinks): opidUser is the saving
    // user's own account id, the only new link this write may add (none without it); mirror keeps every
    // link of a copy of the authoritative server's data. The result says which links were refused.
    async put(envId,{baseRev,data,by,owner,visibility='private',name='',source,opidUser=null,mirror=false}){
      const pg=await db(),now=new Date().toISOString();let refused=[];
      if(pg){
        const c=await pg.connect();
        let gone=[];
        try{
          await c.query('begin');
          const cur=row((await c.query('select * from flygon_flow_workspaces where env_id=$1 for update',[envId])).rows[0]);
          if((cur?.rev||0)!==baseRev){await c.query('rollback');return {conflict:true,current:cur}}
          ({refused}=keepOpidLinks(cur?.data,data,{as:opidUser,email:by,mirror}));
          if(cur){
            await c.query('insert into flygon_flow_workspace_history(env_id,rev,data,saved_by) values($1,$2,$3,$4)',[envId,cur.rev,cur.data,cur.updatedBy]);
            await c.query('delete from flygon_flow_workspace_history where env_id=$1 and id not in (select id from flygon_flow_workspace_history where env_id=$1 order by rev desc limit $2)',[envId,KEEP]);
            await c.query('update flygon_flow_workspaces set rev=$2,data=$3,updated_at=now(),updated_by=$4,name=$5,visibility=$6 where env_id=$1',[envId,cur.rev+1,data,by,name||cur.name,visibility||cur.visibility]);
            gone=deleteEntries(envId,cur.data,data,{by,source,fromRev:cur.rev,rev:cur.rev+1});
            for(const e of gone)await c.query('insert into flygon_flow_card_deletes(id,env_id,card_id,number,title,card,agents,deleted_by,via,actor,from_rev,rev) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
              [e.id,envId,e.cardId,e.number,e.title,e.card,JSON.stringify(e.agents),e.deletedBy,e.via,e.actor,e.fromRev,e.rev]);
            if(gone.length)await c.query(`delete from flygon_flow_card_deletes where env_id=$1 and deleted_at<now()-interval '${RETAIN_DAYS} days'`,[envId]);
          }else{
            const r=await c.query('insert into flygon_flow_workspaces(env_id,name,owner_email,visibility,rev,data,updated_by) values($1,$2,$3,$4,1,$5,$6) on conflict (env_id) do nothing',[envId,name,owner,visibility,data,by]);
            if(!r.rowCount){await c.query('rollback');return {conflict:true,current:await this.get(envId)}}
          }
          await c.query('commit');
          return {ok:true,rev:(cur?.rev||0)+1,deleted:gone,opidRefused:refused};
        }catch(e){await c.query('rollback').catch(()=>{});throw e}finally{c.release()}
      }
      // Files: single process, so read-check-write is atomic enough here.
      const cur=readFile(envId);
      if((cur?.rev||0)!==baseRev)return {conflict:true,current:cur};
      ({refused}=keepOpidLinks(cur?.data,data,{as:opidUser,email:by,mirror}));
      mkdirSync(hist,{recursive:true});
      if(cur){
        atomic(join(hist,`${envId}.${cur.rev}.json`),cur);
        const old=readdirSync(hist).filter(f=>f.startsWith(envId+'.')).sort((a,b)=>parseInt(a.split('.').at(-2))-parseInt(b.split('.').at(-2)));
        for(const f of old.slice(0,Math.max(0,old.length-KEEP)))unlinkSync(join(hist,f));
      }
      const next={envId,name:name||cur?.name||'',owner:cur?.owner||owner,visibility:visibility||cur?.visibility||'private',rev:(cur?.rev||0)+1,data,updatedAt:now,updatedBy:by};
      const gone=cur?deleteEntries(envId,cur.data,data,{by,source,fromRev:cur.rev,rev:next.rev,at:now}):[];
      if(gone.length)writeDel(envId,[...readDel(envId),...gone]);
      atomic(file(envId),next);
      return {ok:true,rev:next.rev,deleted:gone,opidRefused:refused};
    },
    // Recently deleted cards, newest first (restored ones too, unless pending:true).
    async deletedCards(envId,{pending=false,limit=500}={}){
      const pg=await db();
      if(pg)return (await pg.query(`select * from flygon_flow_card_deletes where env_id=$1 and deleted_at>=now()-interval '${RETAIN_DAYS} days'${pending?' and restored_at is null':''} order by deleted_at desc,id limit $2`,[envId,limit])).rows.map(delRow);
      const cut=Date.now()-RETAIN_MS;
      return readDel(envId).filter(e=>Date.parse(e.deletedAt)>=cut&&(!pending||!e.restoredAt)).sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt)||a.id.localeCompare(b.id)).slice(0,limit);
    },
    async deletedCard(envId,id){
      const pg=await db();
      if(pg)return delRow((await pg.query('select * from flygon_flow_card_deletes where env_id=$1 and id=$2',[envId,id])).rows[0])||null;
      return readDel(envId).find(e=>e.id===id)||null;
    },
    async markRestored(envId,id,{by='',number=null}={}){
      const pg=await db(),at=new Date().toISOString();
      if(pg){await pg.query('update flygon_flow_card_deletes set restored_at=$3,restored_by=$4,restored_number=$5 where env_id=$1 and id=$2',[envId,id,at,by,number]);return}
      writeDel(envId,readDel(envId).map(e=>e.id===id?{...e,restoredAt:at,restoredBy:by,restoredNumber:number}:e));
    },
    async history(envId){
      const pg=await db();
      if(pg)return (await pg.query('select rev,saved_at,saved_by from flygon_flow_workspace_history where env_id=$1 order by rev desc limit 20',[envId])).rows.map(r=>({rev:Number(r.rev),savedAt:new Date(r.saved_at).toISOString(),savedBy:r.saved_by}));
      try{return readdirSync(hist).filter(f=>f.startsWith(envId+'.')).map(f=>({rev:parseInt(f.split('.').at(-2))})).sort((a,b)=>b.rev-a.rev).slice(0,20)}catch{return []}
    },
  };
}
