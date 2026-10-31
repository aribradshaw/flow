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
// How much a workspace holds (cards, connections, projects, items, DevOps cards).
export function size(d){
  if(!d)return 0;
  return (d.charts||[]).reduce((s,c)=>s+(c.nodes?.length||0)+(c.edges?.length||0),0)+(d.projects?.length||0)+(d.timeline?.length||0)+(d.devops?.cards?.length||0);
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
  return c.name===SEED.name&&c.nodes.every(n=>SEED_NODES.has(n.id))&&c.edges.every(e=>SEED_EDGES.has(e.id))&&!d.projects?.length&&!d.timeline?.length&&!d.devops?.cards?.length;
}
