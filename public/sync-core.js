// Workspace sync rules shared by the browser, the server, the CLI and verify.mjs (pure, no I/O).
//
// The server holds each environment's workspace with a revision number. Clients send the whole
// workspace with the revision they started from; if the server moved on, the client merges with
// merge3(base, local, remote): per entity (by id) and per field, a side's change wins over an
// unchanged value, both-sides changes prefer local, and an entity is only dropped when one side
// deleted it and the other left it untouched. With no base (first sync) nothing is ever dropped.

const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const byIds=a=>Array.isArray(a)&&a.length>0&&a.every(x=>isObj(x)&&typeof x.id==='string');
export function same(a,b){
  if(a===b)return true;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return false;
  if(Array.isArray(a)!==Array.isArray(b))return false;
  if(Array.isArray(a))return a.length===b.length&&a.every((x,i)=>same(x,b[i]));
  const ka=Object.keys(a).filter(k=>a[k]!==undefined),kb=Object.keys(b).filter(k=>b[k]!==undefined);
  return ka.length===kb.length&&ka.every(k=>same(a[k],b[k]));
}
export function merge3(b,l,r){
  if(same(l,r))return l;
  if(b!==undefined&&same(b,l))return r;
  if(b!==undefined&&same(b,r))return l;
  if((byIds(l)||byIds(r))&&(Array.isArray(l)||l===undefined)&&(Array.isArray(r)||r===undefined))return mergeById(Array.isArray(b)?b:undefined,l||[],r||[]);
  if(isObj(l)&&isObj(r)){
    const out={};
    for(const k of new Set([...Object.keys(l),...Object.keys(r)])){
      const v=merge3(isObj(b)?b[k]:undefined,l[k],r[k]);
      if(v!==undefined)out[k]=v;
    }
    // nextNumber-style counters only grow.
    if(typeof l.nextNumber==='number'&&typeof r.nextNumber==='number')out.nextNumber=Math.max(l.nextNumber,r.nextNumber);
    return out;
  }
  return l===undefined?r:l;
}
function mergeById(b,l,r){
  const B=new Map((b||[]).map(x=>[x.id,x])),L=new Map(l.map(x=>[x.id,x])),R=new Map(r.map(x=>[x.id,x])),out=[];
  const keep=id=>{
    const inL=L.has(id),inR=R.has(id),inB=B.has(id);
    if(inL&&inR)return merge3(inB?B.get(id):undefined,L.get(id),R.get(id));
    if(inL)return !inB||!same(B.get(id),L.get(id))?L.get(id):undefined;   // remote deleted an untouched entity
    return !inB||!same(B.get(id),R.get(id))?R.get(id):undefined;          // local deleted an untouched entity
  };
  // Local order first; remote-only entities slot in after their remote predecessor.
  const placed=new Set();
  for(const x of l){const v=keep(x.id);placed.add(x.id);if(v!==undefined)out.push(v)}
  r.forEach((x,i)=>{
    if(placed.has(x.id))return;placed.add(x.id);
    const v=keep(x.id);if(v===undefined)return;
    const prev=r.slice(0,i).reverse().find(p=>out.some(o=>o.id===p.id));
    out.splice(prev?out.findIndex(o=>o.id===prev.id)+1:0,0,v);
  });
  return out;
}
// Shared records (docs/sharing.md): the fields another person may change too, by kind.
export const SHARED_FIELDS={node:['name','notes'],edge:['percent'],project:['name','color'],
  item:['title','kind','status','priority','start','end','owner','link','notes','release'],
  card:['title','description','column','points','due','labels','checklist','links','assignees']};
const recordsOf=d=>({node:(d?.charts||[]).flatMap(c=>c.nodes||[]),edge:(d?.charts||[]).flatMap(c=>c.edges||[]),project:d?.projects||[],item:d?.timeline||[],card:d?.devops?.cards||[]});
// For each record a save changes, the value each changed field had in the copy it started from:
// {node|edge|project|item|card:{id:{field:value}}}. The server tells a real edit of a shared record from
// a copy that is only out of date, and notices an edit that overwrote someone else's change.
export function fieldBase(base,local){
  const out={};if(!base||!local)return out;
  const B=recordsOf(base),L=recordsOf(local);
  for(const kind of Object.keys(SHARED_FIELDS)){
    const was=new Map(B[kind].map(x=>[x.id,x]));
    for(const x of L[kind]){const b=was.get(x?.id);if(!b)continue;
      for(const f of SHARED_FIELDS[kind])if(!same(b[f],x[f]))((out[kind]??={})[x.id]??={})[f]=b[f]??null}
  }
  return out;
}
// Fields a merge kept from local although remote had changed them too (to something else): the value
// both started from, in fieldBase's shape. Sent with the next save so the server knows the local value
// replaced a change this copy never showed (a conflict, last write wins).
export function clashes(base,local,remote){
  const out={};if(!base||!local||!remote)return out;
  const B=recordsOf(base),R=recordsOf(remote),L=recordsOf(local);
  for(const kind of Object.keys(SHARED_FIELDS)){
    const was=new Map(B[kind].map(x=>[x.id,x])),there=new Map(R[kind].map(x=>[x.id,x]));
    for(const x of L[kind]){const b=was.get(x?.id),r=there.get(x?.id);if(!b||!r)continue;
      for(const f of SHARED_FIELDS[kind])if(!same(b[f],x[f])&&!same(b[f],r[f])&&!same(x[f],r[f]))((out[kind]??={})[x.id]??={})[f]=b[f]??null}
  }
  return out;
}
// fieldBase with held clashes laid over it (a held field keeps its older base).
export function withHeld(base,held){
  const out=structuredClone(base||{});
  for(const [kind,recs] of Object.entries(held||{}))for(const [id,fields] of Object.entries(recs||{}))Object.assign((out[kind]??={})[id]??={},fields);
  return out;
}
// Undo snapshots are whole workspaces, so a change from the server must be carried into each of them
// or undo would erase it. Replays before -> after onto every snapshot with the same merge rules; when
// both changed a field, what arrived wins, so undo never brings back a value someone has since replaced.
// Results may share objects with after and with each other: treat them as read-only (clone on use).
export const rebaseSnapshots=(snapshots,before,after)=>same(before,after)?snapshots:snapshots.map(s=>merge3(before,after,s));
// Card numbers only grow: returns incoming with the next number raised to stored's if it was lower.
export function keepCounters(stored,incoming){
  const have=stored?.devops?.nextNumber,got=incoming?.devops?.nextNumber;
  if(!Number.isInteger(have)||!incoming?.devops||(Number.isInteger(got)&&got>=have))return incoming;
  return {...incoming,devops:{...incoming.devops,nextNumber:have}};
}
// How much a workspace holds (cards, connections, projects, items, DevOps cards, AgentFlow agents and workflows).
export function size(d){
  if(!d)return 0;
  return (d.charts||[]).reduce((s,c)=>s+(c.nodes?.length||0)+(c.edges?.length||0),0)+(d.projects?.length||0)+(d.timeline?.length||0)+(d.devops?.cards?.length||0)+(d.agentflow?.agents?.length||0)+(d.agentflow?.workflows?.length||0);
}
// A save that would drop most of a large workspace is refused unless explicitly allowed.
export const shrinks=(current,incoming)=>size(current)>=50&&size(incoming)<size(current)*0.2;

// The untouched sample chart a new browser starts with: never uploaded, and never preferred over a
// workspace the server already has. (Positions may have been nudged; nothing real was added.)
import {starterChart} from './demo-seed.js';
const SEED=starterChart('seed'),SEED_NODES=new Set(SEED.nodes.map(n=>n.id)),SEED_EDGES=new Set(SEED.edges.map(e=>e.id));
export function isSeed(d){
  if(!d||!Array.isArray(d.charts)||d.charts.length!==1)return false;
  const c=d.charts[0];
  return c.name===SEED.name&&c.nodes.every(n=>SEED_NODES.has(n.id))&&c.edges.every(e=>SEED_EDGES.has(e.id))&&!d.projects?.length&&!d.timeline?.length&&!d.devops?.cards?.length&&!d.agentflow?.agents?.length&&!d.agentflow?.workflows?.length;
}
