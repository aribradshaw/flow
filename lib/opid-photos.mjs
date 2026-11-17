// OneProfileID photos on person cards (docs/concepts/10-opid-photos.md).
//
// A person links a card to their own OneProfileID account, explicitly (node.opidUser = their account
// id). Nothing is ever linked because an email or a name matches. The card then shows that account's
// current photo to everyone who can see the card, looked up live and never stored in workspace data.
//
// - keepOpidLinks(before, after, as): the write guard every workspace save goes through
//   (lib/workspaces.mjs put). A link that is new or changed is kept only when it is the saving user's
//   own id (`as`); anyone who may save can remove one. Refused links go back to what was stored.
// - photoTargets(...): which cards a viewer sees that carry a link, and in which environment the link
//   lives (the owner's, for cards that reach the viewer through a share).
// - memberStore: who has opened which workspace (as its owner or through a share). Only those
//   members' photos are ever looked up for a workspace's cards.
// Postgres table flygon_flow_opid_members (additive, created idempotently), otherwise
// BACKUP_DIR/_opid_members.json.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {validOpidUser} from './cleaners.mjs';
import {resolveScope,linkedId} from './sharing-core.mjs';

export const SCHEMA=[
  `create table if not exists flygon_flow_opid_members(env_id text not null,opid_user_id text not null,email text not null default '',first_seen timestamptz not null default now(),last_seen timestamptz not null default now(),primary key(env_id,opid_user_id))`,
];

const personNodes=d=>(d?.charts||[]).flatMap(c=>c?.nodes||[]).filter(n=>n&&typeof n==='object');

// The write guard. Mutates and returns `after`. as: the saving user's OneProfileID id, or null when
// the writer has none (local mode, the owner token, API keys, MCP). mirror: a copy of the authoritative
// server's data (a local app's relay cache) that is kept as is.
// -> {data, refused:[node ids whose link was refused]}
export function keepOpidLinks(before,after,{as=null,mirror=false}={}){
  const refused=[];if(!after||typeof after!=='object')return {data:after,refused};
  const was=new Map(personNodes(before).filter(n=>n.type==='person'&&validOpidUser(n.opidUser)).map(n=>[n.id,n.opidUser]));
  for(const n of personNodes(after)){
    // opidLinked only describes a link to a viewer who may not see its id; it is never stored.
    delete n.opidLinked;
    if(!('opidUser' in n))continue;
    const v=n.opidUser,prev=n.type==='person'?was.get(n.id):undefined;
    // Removing a link (unlinking) is open to anyone who may save.
    if(v===''||v===null||v===undefined){delete n.opidUser;continue}
    if(n.type==='person'&&validOpidUser(v)&&(mirror||v===prev||(!!as&&v===as)))continue;
    if(n.type==='person')refused.push(n.id);
    if(prev)n.opidUser=prev;else delete n.opidUser;
  }
  return {data:after,refused};
}

// What a viewer who is not the owner may see of the links in stored data: their own id, and only
// opidLinked:true on everyone else's. Mutates and returns d.
export function maskOpidLinks(d,viewer){
  for(const n of personNodes(d))if(n.opidUser){if(n.opidUser!==viewer){delete n.opidUser;n.opidLinked=true}}
  return d;
}

// The linked cards a viewer sees in one environment.
//   own: the environment's stored data (its own cards; for a public reader, everything they see)
//   envId: that environment's id
//   shared: [{share, home}] shares placed there for this viewer (home: the owner's workspace)
// -> [{nodeId (as the viewer has it), env (where the link lives), opidUser}]
export function photoTargets({envId,own,shared=[]}){
  const out=[];
  for(const n of personNodes(own))if(n.type==='person'&&validOpidUser(n.opidUser)&&!String(n.id).startsWith('sh.'))out.push({nodeId:n.id,env:envId,opidUser:n.opidUser});
  for(const {share,home} of shared){
    if(!share||share.revokedAt||!home?.data)continue;
    // The cards the share brings: in-scope nodes and the read-only stubs above them (their photos travel too).
    const sc=resolveScope(home.data,share),ids=new Set([...sc.nodeIds,...sc.stubs.map(s=>s.nodeId)]);
    for(const n of personNodes(home.data))if(ids.has(n.id)&&n.type==='person'&&validOpidUser(n.opidUser))out.push({nodeId:linkedId(share.id,n.id),env:share.ownerEnv,opidUser:n.opidUser});
  }
  return out;
}

// Keep the targets whose linked person is a member of the environment the link lives in.
// members: Map env -> Set of OneProfileID ids (memberStore.members, already checked for current access).
export const eligibleTargets=(targets,members)=>targets.filter(t=>members.get(t.env)?.has(t.opidUser));

const lc=v=>String(v||'').trim().toLowerCase();
const SEEN_EVERY=6*3600e3;
export function memberStore({dir,db=async()=>null}){
  const file=join(dir,'_opid_members.json'),read=()=>{try{const l=JSON.parse(readFileSync(file,'utf8'));return Array.isArray(l)?l:[]}catch{return []}};
  const write=list=>{mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(list,null,2));renameSync(file+'.tmp',file)};
  const pool=()=>db().catch(()=>null),seen=new Map();
  return {
    // A signed-in OneProfileID user opened envId (as its owner or through a share). Cheap to call on
    // every read: each pair is written at most once every few hours per process.
    async record(envId,user){
      if(!envId||!validOpidUser(user?.id)||!user.email)return;
      const k=envId+'\n'+user.id,t=Date.now();if(t-(seen.get(k)||0)<SEEN_EVERY)return;seen.set(k,t);
      const pg=await pool();
      if(pg){await pg.query('insert into flygon_flow_opid_members(env_id,opid_user_id,email) values($1,$2,$3) on conflict (env_id,opid_user_id) do update set email=excluded.email,last_seen=now()',[envId,user.id,lc(user.email)]);return}
      const list=read(),cur=list.find(m=>m.envId===envId&&m.opidUser===user.id),at=new Date().toISOString();
      if(cur)Object.assign(cur,{email:lc(user.email),lastSeen:at});else list.push({envId,opidUser:user.id,email:lc(user.email),firstSeen:at,lastSeen:at});
      write(list);
    },
    // Recorded members of envId among ids -> [{opidUser, email}]
    async list(envId,ids){
      const want=[...new Set(ids)].filter(validOpidUser);if(!want.length)return [];
      const pg=await pool();
      if(pg)return (await pg.query('select opid_user_id,email from flygon_flow_opid_members where env_id=$1 and opid_user_id=any($2)',[envId,want])).rows.map(r=>({opidUser:r.opid_user_id,email:r.email}));
      const w=new Set(want);return read().filter(m=>m.envId===envId&&w.has(m.opidUser)).map(m=>({opidUser:m.opidUser,email:m.email}));
    },
  };
}
