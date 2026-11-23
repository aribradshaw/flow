import {sameName} from './agentflow-core.js';

// Node ids whose OneProfileID photo the workspace should load: linked person cards, and share
// members (@email) that carry a link. The server decides which photos actually exist.
export function linkedPhotoIds(db){
  const ids=[];
  const add=n=>{
    if(!n||typeof n.id!=='string')return;
    if(!((typeof n.opidUser==='string'&&n.opidUser)||n.opidLinked===true))return;
    if(!ids.includes(n.id))ids.push(n.id);
  };
  for(const c of db?.charts||[])for(const n of c.nodes||[])if(n.type==='person')add(n);
  for(const s of db?.shares||[])for(const m of s.members||[])add(m);
  for(const m of db?.shareMembers||[])add(m);
  for(const e of db?.combined||[]){for(const s of e.shares||[])for(const m of s.members||[])add(m);for(const m of e.shareMembers||[])add(m)}
  return ids.sort();
}

const emailKey=email=>String(email||'').trim().toLowerCase();
const matchesEmail=(node,key)=>node.linked?.opidEmail==='match'||emailKey(node.email)===key;

// Shared projections expose only the relationship to the recipient's email.
export function matchesLinkEmail(node,email){
  const key=emailKey(email);
  return !!key&&matchesEmail(node,key);
}

export function findLinkPrompt(db,user){
  const email=emailKey(user?.email);
  if(!user?.id||!email)return null;
  const matches=new Map(),mismatches=new Map();
  let hasMatch=false;
  for(const chart of db?.charts||[])for(const node of chart.nodes||[]){
    if(node.type!=='person'||node.linked?.stub||node.linked?.pending||node.id.startsWith('cx.'))continue;
    const match=matchesEmail(node,email);
    if(match)hasMatch=true;
    if(node.opidLinked||node.opidUser)continue;
    const card={id:node.id,name:node.name,chart:chart.name,shared:!!node.linked};
    if(match)matches.set(node.id,card);
    else if((node.email||node.linked?.opidEmail==='different')&&sameName(node.name,user.name))mismatches.set(node.id,card);
  }
  if(matches.size)return {kind:matches.size===1?'link':'pick',cards:[...matches.values()]};
  if(!hasMatch&&mismatches.size)return {kind:'mismatch',cards:[...mismatches.values()]};
  return null;
}
