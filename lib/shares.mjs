// Storage for Flow sharing (the rules live in lib/sharing-core.mjs): shares, re-share requests,
// per-environment placements of linked records, and per-field history of recipient edits.
// Postgres when DATABASE_URL is set (tables flygon_flow_shares, flygon_flow_share_requests,
// flygon_flow_share_placements, flygon_flow_share_history; additive, created idempotently), otherwise JSON
// files in BACKUP_DIR (_shares.json, _share_requests.json, _share_placements.json, _share_history.json).
// Revoking marks a share; nothing is deleted except placements, which a revoke clears.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

export const SCHEMA=[
  `create table if not exists flygon_flow_shares(id text primary key,owner_env text not null,owner_email text not null,recipient_email text not null,permission text not null default 'view',scope jsonb not null,name text not null default '',created_at timestamptz not null default now(),created_by text not null,revoked_at timestamptz,via text)`,
  `create index if not exists flygon_flow_shares_recipient on flygon_flow_shares(lower(recipient_email))`,
  `create index if not exists flygon_flow_shares_owner on flygon_flow_shares(owner_env)`,
  `create table if not exists flygon_flow_share_requests(id text primary key,share_id text not null,owner_email text not null,requested_by text not null,to_email text not null,permission text not null,note text not null default '',status text not null default 'pending',created_at timestamptz not null default now(),decided_at timestamptz,decided_by text,new_share_id text)`,
  `create index if not exists flygon_flow_share_requests_owner on flygon_flow_share_requests(lower(owner_email),status)`,
  `create table if not exists flygon_flow_share_placements(share_id text not null,env_id text not null,record_id text not null,chart_id text not null default '',x double precision,y double precision,w double precision,h double precision,updated_at timestamptz not null default now(),primary key(share_id,env_id,record_id))`,
  `create table if not exists flygon_flow_share_history(id bigserial primary key,share_id text not null,env_id text not null,kind text not null,record_id text not null,field text not null,old jsonb,new jsonb,by_email text not null,at timestamptz not null default now())`,
  `create index if not exists flygon_flow_share_history_record on flygon_flow_share_history(env_id,kind,record_id,at desc)`,
];
// Run the schema (safe to repeat).
export async function migrate(pg){for(const q of SCHEMA)await pg.query(q)}

const iso=v=>v?new Date(v).toISOString():null,num=v=>v===null||v===undefined?undefined:Number(v);
const shareRow=r=>r&&{id:r.id,ownerEnv:r.owner_env,ownerEmail:r.owner_email,recipientEmail:r.recipient_email,permission:r.permission,scope:r.scope,name:r.name,createdAt:iso(r.created_at),createdBy:r.created_by,revokedAt:iso(r.revoked_at),via:r.via||null};
const requestRow=r=>r&&{id:r.id,shareId:r.share_id,ownerEmail:r.owner_email,requestedBy:r.requested_by,toEmail:r.to_email,permission:r.permission,note:r.note,status:r.status,createdAt:iso(r.created_at),decidedAt:iso(r.decided_at),decidedBy:r.decided_by||null,newShareId:r.new_share_id||null};
const placementRow=r=>({shareId:r.share_id,envId:r.env_id,recordId:r.record_id,chartId:r.chart_id,x:num(r.x),y:num(r.y),w:num(r.w),h:num(r.h),updatedAt:iso(r.updated_at)});
const historyRow=r=>({shareId:r.share_id,envId:r.env_id,kind:r.kind,recordId:r.record_id,field:r.field,old:r.old,new:r.new,by:r.by_email,at:iso(r.at)});
const lc=v=>String(v||'').trim().toLowerCase();
const HISTORY_KEEP=20000,ATTACHED='*';

export function shareStore({dir,db=async()=>null}){
  const f=name=>join(dir,name),read=name=>{try{return JSON.parse(readFileSync(f(name),'utf8'))}catch{return []}};
  const write=(name,list)=>{mkdirSync(dir,{recursive:true});writeFileSync(f(name)+'.tmp',JSON.stringify(list,null,2));renameSync(f(name)+'.tmp',f(name))};
  const S='_shares.json',R='_share_requests.json',P='_share_placements.json',H='_share_history.json';
  const pool=()=>db().catch(()=>null);
  return {
    // ---- shares
    async create(s){
      const pg=await pool();
      if(pg){await pg.query('insert into flygon_flow_shares(id,owner_env,owner_email,recipient_email,permission,scope,name,created_at,created_by,revoked_at,via) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [s.id,s.ownerEnv,lc(s.ownerEmail),lc(s.recipientEmail),s.permission,JSON.stringify(s.scope),s.name||'',s.createdAt||new Date().toISOString(),lc(s.createdBy),s.revokedAt||null,s.via||null]);return this.get(s.id)}
      const list=read(S);if(list.some(x=>x.id===s.id))throw Error('share exists');
      const n={...s,ownerEmail:lc(s.ownerEmail),recipientEmail:lc(s.recipientEmail),createdBy:lc(s.createdBy),revokedAt:s.revokedAt||null,via:s.via||null};list.push(n);write(S,list);return n;
    },
    async get(id){
      const pg=await pool();
      if(pg)return shareRow((await pg.query('select * from flygon_flow_shares where id=$1',[id])).rows[0])||null;
      return read(S).find(s=>s.id===id)||null;
    },
    // filter: {ownerEnv, ownerEmail, recipientEmail, includeRevoked}. Newest first.
    async list({ownerEnv,ownerEmail,recipientEmail,includeRevoked=false}={}){
      const pg=await pool();
      if(pg){
        const w=[],a=[];const add=(sql,v)=>{a.push(v);w.push(sql.replace('?','$'+a.length))};
        if(ownerEnv)add('owner_env=?',ownerEnv);if(ownerEmail)add('lower(owner_email)=?',lc(ownerEmail));if(recipientEmail)add('lower(recipient_email)=?',lc(recipientEmail));
        if(!includeRevoked)w.push('revoked_at is null');
        return (await pg.query(`select * from flygon_flow_shares${w.length?' where '+w.join(' and '):''} order by created_at desc`,a)).rows.map(shareRow);
      }
      return read(S).filter(s=>(!ownerEnv||s.ownerEnv===ownerEnv)&&(!ownerEmail||s.ownerEmail===lc(ownerEmail))&&(!recipientEmail||s.recipientEmail===lc(recipientEmail))&&(includeRevoked||!s.revokedAt))
        .sort((x,y)=>y.createdAt.localeCompare(x.createdAt));
    },
    async setPermission(id,permission){
      const pg=await pool();
      if(pg){await pg.query('update flygon_flow_shares set permission=$2 where id=$1 and revoked_at is null',[id,permission]);return this.get(id)}
      const list=read(S),s=list.find(x=>x.id===id);if(s&&!s.revokedAt){s.permission=permission;write(S,list)}return s||null;
    },
    // Revoke keeps the share (and its history) but clears every placement of it.
    async revoke(id){
      const pg=await pool();
      if(pg){await pg.query('update flygon_flow_shares set revoked_at=coalesce(revoked_at,now()) where id=$1',[id]);await pg.query('delete from flygon_flow_share_placements where share_id=$1',[id]);return this.get(id)}
      const list=read(S),s=list.find(x=>x.id===id);if(s&&!s.revokedAt){s.revokedAt=new Date().toISOString();write(S,list)}
      write(P,read(P).filter(p=>p.shareId!==id));return s||null;
    },
    // ---- re-share requests
    async addRequest(r){
      const pg=await pool();
      if(pg){await pg.query('insert into flygon_flow_share_requests(id,share_id,owner_email,requested_by,to_email,permission,note,status,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [r.id,r.shareId,lc(r.ownerEmail),lc(r.requestedBy),lc(r.toEmail),r.permission,r.note||'',r.status||'pending',r.createdAt||new Date().toISOString()]);return this.getRequest(r.id)}
      const list=read(R);list.push({...r,decidedAt:null,decidedBy:null,newShareId:null});write(R,list);return list.at(-1);
    },
    async getRequest(id){
      const pg=await pool();
      if(pg)return requestRow((await pg.query('select * from flygon_flow_share_requests where id=$1',[id])).rows[0])||null;
      return read(R).find(r=>r.id===id)||null;
    },
    // filter: {ownerEmail, requestedBy, shareId, status}
    async requests({ownerEmail,requestedBy,shareId,status}={}){
      const pg=await pool();
      if(pg){
        const w=[],a=[];const add=(sql,v)=>{a.push(v);w.push(sql.replace('?','$'+a.length))};
        if(ownerEmail)add('lower(owner_email)=?',lc(ownerEmail));if(requestedBy)add('lower(requested_by)=?',lc(requestedBy));if(shareId)add('share_id=?',shareId);if(status)add('status=?',status);
        return (await pg.query(`select * from flygon_flow_share_requests${w.length?' where '+w.join(' and '):''} order by created_at desc`,a)).rows.map(requestRow);
      }
      return read(R).filter(r=>(!ownerEmail||r.ownerEmail===lc(ownerEmail))&&(!requestedBy||r.requestedBy===lc(requestedBy))&&(!shareId||r.shareId===shareId)&&(!status||r.status===status))
        .sort((x,y)=>y.createdAt.localeCompare(x.createdAt));
    },
    // Record a decision (from decideRequest). Only a pending request changes; returns null otherwise.
    async decide(r){
      const pg=await pool();
      if(pg){const u=await pg.query(`update flygon_flow_share_requests set status=$2,decided_at=$3,decided_by=$4,new_share_id=$5 where id=$1 and status='pending'`,[r.id,r.status,r.decidedAt,lc(r.decidedBy),r.newShareId||null]);return u.rowCount?this.getRequest(r.id):null}
      const list=read(R),cur=list.find(x=>x.id===r.id);if(!cur||cur.status!=='pending')return null;
      Object.assign(cur,{status:r.status,decidedAt:r.decidedAt,decidedBy:lc(r.decidedBy),newShareId:r.newShareId||null});write(R,list);return cur;
    },
    // ---- attaching: which of the recipient's environments a share is placed in (a row with record_id '*')
    async attach(shareId,envId){await this.place(shareId,envId,[{recordId:ATTACHED,chartId:''}])},
    async detach(shareId,envId){await this.dropPlacements(shareId,envId)},
    // Share ids attached to one environment / environments one share is attached to.
    async attachedTo(envId){
      const pg=await pool();
      if(pg)return (await pg.query('select share_id from flygon_flow_share_placements where env_id=$1 and record_id=$2',[envId,ATTACHED])).rows.map(r=>r.share_id);
      return read(P).filter(p=>p.envId===envId&&p.recordId===ATTACHED).map(p=>p.shareId);
    },
    async envsFor(shareId){
      const pg=await pool();
      if(pg)return (await pg.query('select env_id from flygon_flow_share_placements where share_id=$1 and record_id=$2',[shareId,ATTACHED])).rows.map(r=>r.env_id);
      return read(P).filter(p=>p.shareId===shareId&&p.recordId===ATTACHED).map(p=>p.envId);
    },
    // ---- placements: where a linked record sits in one recipient environment
    async placements(shareId,envId){
      const pg=await pool();
      if(pg)return (await pg.query('select * from flygon_flow_share_placements where share_id=$1 and env_id=$2 and record_id<>$3',[shareId,envId,ATTACHED])).rows.map(placementRow);
      return read(P).filter(p=>p.shareId===shareId&&p.envId===envId&&p.recordId!==ATTACHED);
    },
    async place(shareId,envId,list){
      if(!list?.length)return;
      const pg=await pool(),now=new Date().toISOString(),n=v=>Number.isFinite(v)?v:null;
      if(pg){for(const p of list)await pg.query('insert into flygon_flow_share_placements(share_id,env_id,record_id,chart_id,x,y,w,h,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,now()) on conflict (share_id,env_id,record_id) do update set chart_id=excluded.chart_id,x=excluded.x,y=excluded.y,w=excluded.w,h=excluded.h,updated_at=now()',
        [shareId,envId,p.recordId,p.chartId||'',n(p.x),n(p.y),n(p.w),n(p.h)]);return}
      const all=read(P);
      for(const p of list){const row={shareId,envId,recordId:p.recordId,chartId:p.chartId||'',x:n(p.x)??undefined,y:n(p.y)??undefined,w:n(p.w)??undefined,h:n(p.h)??undefined,updatedAt:now};
        const i=all.findIndex(x=>x.shareId===shareId&&x.envId===envId&&x.recordId===p.recordId);if(i<0)all.push(row);else all[i]=row}
      write(P,all);
    },
    async dropPlacements(shareId,envId){
      const pg=await pool();
      if(pg){await pg.query('delete from flygon_flow_share_placements where share_id=$1'+(envId?' and env_id=$2':''),envId?[shareId,envId]:[shareId]);return}
      write(P,read(P).filter(p=>!(p.shareId===shareId&&(!envId||p.envId===envId))));
    },
    // ---- per-field history of recipient edits (and comments, field 'comment'), in the owner's env
    async record(entries){
      if(!entries?.length)return;
      const pg=await pool();
      if(pg){for(const e of entries)await pg.query('insert into flygon_flow_share_history(share_id,env_id,kind,record_id,field,old,new,by_email,at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [e.shareId,e.envId,e.kind,e.recordId,e.field,JSON.stringify(e.old??null),JSON.stringify(e.new??null),lc(e.by),e.at||new Date().toISOString()]);return}
      const all=read(H);all.push(...entries.map(e=>({...e,old:e.old??null,new:e.new??null,by:lc(e.by),at:e.at||new Date().toISOString()})));write(H,all.slice(-HISTORY_KEEP));
    },
    // filter: {envId, kind, recordId, shareId, limit}. Newest first.
    async history({envId,kind,recordId,shareId,limit=100}={}){
      const pg=await pool();
      if(pg){
        const w=[],a=[];const add=(sql,v)=>{a.push(v);w.push(sql.replace('?','$'+a.length))};
        if(envId)add('env_id=?',envId);if(kind)add('kind=?',kind);if(recordId)add('record_id=?',recordId);if(shareId)add('share_id=?',shareId);
        a.push(Math.min(1000,limit));
        return (await pg.query(`select * from flygon_flow_share_history${w.length?' where '+w.join(' and '):''} order by at desc,id desc limit $${a.length}`,a)).rows.map(historyRow);
      }
      return read(H).filter(e=>(!envId||e.envId===envId)&&(!kind||e.kind===kind)&&(!recordId||e.recordId===recordId)&&(!shareId||e.shareId===shareId)).reverse().slice(0,Math.min(1000,limit));
    },
  };
}
