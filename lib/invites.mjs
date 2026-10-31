// App invites: the owner invites an email to Flygon Flow itself (not to an environment). On that
// person's first verified OneProfileID sign-in the server claims their own Flow membership (a
// localId derived from the invite, never 'owner'). Postgres table flygon_flow_invites (additive)
// or BACKUP_DIR/_invites.json. Revoking marks the invite; nothing is deleted. No email is sent here.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';

export const SCHEMA=[`create table if not exists flygon_flow_invites(email text primary key,local_id text not null,invited_by text not null,created_at timestamptz not null default now(),claimed_at timestamptz,revoked_at timestamptz)`];
const EMAIL=/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const validEmail=e=>typeof e==='string'&&e.length<=254&&EMAIL.test(e.trim());
const row=r=>r&&{email:r.email,localId:r.local_id,invitedBy:r.invited_by,createdAt:new Date(r.created_at).toISOString(),claimedAt:r.claimed_at?new Date(r.claimed_at).toISOString():null,revokedAt:r.revoked_at?new Date(r.revoked_at).toISOString():null};

export function inviteStore({dir,db}){
  const file=join(dir,'_invites.json');
  const read=()=>{try{return JSON.parse(readFileSync(file,'utf8'))}catch{return []}};
  const write=list=>{mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(list,null,2));renameSync(file+'.tmp',file)};
  const pool=()=>db().catch(()=>null);
  return {
    async list(){const pg=await pool();if(pg)return (await pg.query('select * from flygon_flow_invites order by created_at desc')).rows.map(row);return read()},
    // Invites nobody has claimed yet (not revoked), newest first.
    async listOpen(){return (await this.list()).filter(i=>!i.claimedAt&&!i.revokedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))},
    async find(email){
      email=String(email||'').trim().toLowerCase();const pg=await pool();
      if(pg)return row((await pg.query('select * from flygon_flow_invites where email=$1',[email])).rows[0])||null;
      return read().find(i=>i.email===email)||null;
    },
    // Create or re-open an invite (a revoked one becomes active again; its localId is kept).
    async add(email,by){
      email=email.trim().toLowerCase();const localId='u-'+randomBytes(9).toString('base64url'),pg=await pool();
      if(pg){await pg.query('insert into flygon_flow_invites(email,local_id,invited_by) values($1,$2,$3) on conflict (email) do update set revoked_at=null',[email,localId,by]);return this.find(email)}
      const list=read(),cur=list.find(i=>i.email===email);
      if(cur)cur.revokedAt=null;else list.push({email,localId,invitedBy:by,createdAt:new Date().toISOString(),claimedAt:null,revokedAt:null});
      write(list);return list.find(i=>i.email===email);
    },
    async revoke(email){
      email=String(email||'').trim().toLowerCase();const pg=await pool();
      if(pg){await pg.query('update flygon_flow_invites set revoked_at=now() where email=$1',[email]);return}
      const list=read(),cur=list.find(i=>i.email===email);if(cur){cur.revokedAt=new Date().toISOString();write(list)}
    },
    async claimed(email){
      email=String(email||'').trim().toLowerCase();const pg=await pool();
      if(pg){await pg.query('update flygon_flow_invites set claimed_at=coalesce(claimed_at,now()) where email=$1',[email]);return}
      const list=read(),cur=list.find(i=>i.email===email);if(cur&&!cur.claimedAt){cur.claimedAt=new Date().toISOString();write(list)}
    },
  };
}
