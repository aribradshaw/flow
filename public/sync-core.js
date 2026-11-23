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
  card:['title','description','column','points','actual','due','labels','checklist','links','assignees','snoozedUntil']};
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
// Linked copies of shared records (ids sh.<share>.<id>): the shared fields as a copy holds them,
// {kind:{id:{field:value}}} (deep copies, so later in-place edits of the copy do not change them).
// Records of environments combined with this one (cx.*, combined-core.js) are linked the same way: only
// the edits this user makes to them are sent back to their own environments.
const isLinked=id=>typeof id==='string'&&(id.startsWith('sh.')||id.startsWith('cx.'));
export function linkedFields(d){
  const out={},R=recordsOf(d);
  for(const kind of Object.keys(SHARED_FIELDS))for(const x of R[kind])if(isLinked(x?.id)){
    const o=(out[kind]??={})[x.id]={};for(const f of SHARED_FIELDS[kind])o[f]=x[f]===undefined?null:structuredClone(x[f]);
  }
  return out;
}
// The user's own edits of linked records, the only changes a save sends back to their owners
// (docs/sharing.md): edits ({kind:{id:{field:value before the first edit}}}) plus what changed from
// before (linkedFields of the copy just before one local change) to after (the copy now). A field
// changed back to where it started drops out. Copies taken from the server (or merged) never add to it,
// so a copy that is only out of date (an old tab, a browser that could not store its latest copy)
// can never pass its old values off as edits.
export function noteEdits(edits,before,after){
  const out=structuredClone(edits||{}),now=linkedFields(after);
  for(const [kind,recs] of Object.entries(now))for(const [id,fields] of Object.entries(recs)){
    const was=before?.[kind]?.[id];if(!was)continue;
    for(const [f,v] of Object.entries(fields)){
      if(same(was[f],v))continue;
      const e=out[kind]?.[id];
      if(e&&f in e){if(same(e[f],v))drop(out,kind,id,f)}
      else ((out[kind]??={})[id]??={})[f]=was[f]??null;
    }
  }
  return out;
}
const drop=(edits,kind,id,f)=>{const e=edits[kind][id];delete e[f];if(!Object.keys(e).length)delete edits[kind][id];if(!Object.keys(edits[kind]).length)delete edits[kind]};
// After a save carried sentEdits (with the copy sent, sentDb): what is still unsent in edits. A field
// unchanged since is done; one edited again meanwhile now starts from the value that was sent.
export function settleEdits(edits,sentEdits,sentDb,nowDb){
  const out=structuredClone(edits||{}),S=linkedFields(sentDb),N=linkedFields(nowDb);
  for(const [kind,recs] of Object.entries(sentEdits||{}))for(const [id,fields] of Object.entries(recs||{}))for(const f of Object.keys(fields||{})){
    const e=out[kind]?.[id];if(!e||!(f in e))continue;
    const sent=S[kind]?.[id]?.[f],now=N[kind]?.[id]?.[f];
    if(same(sent,now))drop(out,kind,id,f);else e[f]=sent??null;
  }
  return out;
}
// fieldBase with held clashes laid over it (a held field keeps its older base).
export function withHeld(base,held){
  const out=structuredClone(base||{});
  for(const [kind,recs] of Object.entries(held||{}))for(const [id,fields] of Object.entries(recs||{}))Object.assign((out[kind]??={})[id]??={},fields);
  return out;
}
// ---- DevOps cards: a save changes only the cards this copy edited itself (card #447) ----
// A copy of the board can be out of date (a tab that slept, a browser that could not store its latest
// copy, a merge without the right base). Sending it whole put old descriptions, columns and due dates
// back on cards that agents had just changed through the API. So a browser keeps a journal of its own
// card edits as they happen: {card id: the card as the server had it when this copy first changed it,
// or null for a card created here}. Saves send cardEditsOf(journal) and the server writes only those
// cards and fields (applyCardEdits); every other card keeps the server's version. Linked copies of
// shared cards (sh.*) are not in the journal: their edits go to the owner as sharedEdits (noteEdits).
const ownCard=c=>!!c&&typeof c.id==='string'&&!isLinked(c.id);
const ownCards=d=>(Array.isArray(d?.devops?.cards)?d.devops.cards:[]).filter(ownCard);
const eqv=(a,b)=>same(a??null,b??null),STAMPS=new Set(['updated','moved']);
export function sameCard(a,b){
  if(a===b)return true;if(!a||!b)return false;
  for(const k of new Set([...Object.keys(a),...Object.keys(b)]))if(!eqv(a[k],b[k]))return false;
  return true;
}
// The same apart from timestamps (a change by someone else always changes something else too).
const sameContent=(a,b)=>!!a&&!!b&&[...new Set([...Object.keys(a),...Object.keys(b)])].every(k=>STAMPS.has(k)||eqv(a[k],b[k]));
// The cards of a copy as it is now (to tell later local changes from it): Map id -> JSON.
export const cardSnapshot=d=>new Map(ownCards(d).map(c=>[c.id,JSON.stringify(c)]));
// After a local change: journal plus every card that differs from seen (cardSnapshot from just before).
// A card changed back to how the server had it drops out.
export function noteCardEdits(journal,seen,d){
  const out={...(journal||{})},now=new Map(ownCards(d).map(c=>[c.id,c]));
  for(const [id,s] of seen||[])if(!Object.hasOwn(out,id)){const c=now.get(id);if(!c||JSON.stringify(c)!==s)out[id]=JSON.parse(s)}
  for(const id of now.keys())if(!seen?.has(id)&&!Object.hasOwn(out,id))out[id]=null;
  for(const id of Object.keys(out)){const b=out[id],c=now.get(id)??null;if(b===null?c===null:!!c&&sameCard(b,c))delete out[id]}
  return out;
}
// What a save sends: {changed:{id:{field:value before this copy changed it}}, added:[ids], removed:{id:card
// as it was}}, from the journal and the copy being sent.
export function cardEditsOf(journal,d){
  const now=new Map(ownCards(d).map(c=>[c.id,c])),out={changed:{},added:[],removed:{}};
  for(const [id,b] of Object.entries(journal||{})){
    const c=now.get(id);
    if(!b){if(c)out.added.push(id);continue}
    if(!c){out.removed[id]=b;continue}
    const f={};for(const k of new Set([...Object.keys(b),...Object.keys(c)]))if(!eqv(b[k],c[k]))f[k]=b[k]===undefined?null:b[k];
    if(Object.keys(f).length)out.changed[id]=f;
  }
  return out;
}
// The cards after applying a copy's edits to the server's cards: server order and values, except the
// fields the copy changed (and cards it added or removed). Cards it moved (column or position) go after
// the card before them in the copy. clashes: edits made over a value the copy never saw (someone else
// changed that field, edited a card it removed, or removed a card it edited); the edit still wins here
// (the server answers 409 instead, so the copy sees the newer value first). ignored: cards where the copy
// differs from the server without having changed them (an out-of-date copy), left as the server has them.
// Linked cards (sh.*) are left as the server lists them.
export function applyCardEdits(server,client,edits){
  server=Array.isArray(server)?server:[];client=Array.isArray(client)?client:[];
  const C=new Map(client.filter(ownCard).map(c=>[c.id,c])),S=new Set(server.map(c=>c?.id));
  const changed=edits?.changed||{},added=new Set(edits?.added||[]),removed=edits?.removed||{};
  const out=[],place=new Set(),clashes=[];let ignored=0;
  const clash=(c,fields)=>clashes.push({id:c.id,number:Number.isInteger(c.number)?c.number:null,title:String(c.title||'').slice(0,200),fields});
  const take=(s,c,f)=>{
    const n={...s},lost=[];
    for(const k of Object.keys(f)){
      if(eqv(s[k],c[k]))continue;
      // Timestamps every edit stamps are not edits of their own: the later one is kept, never a clash.
      // (moved also says this copy placed the card, so its value stays: an undone move keeps its older one.)
      if(STAMPS.has(k)){n[k]=k==='moved'||String(c[k]??'')>String(s[k]??'')?c[k]:s[k];continue}
      if(!eqv(s[k],f[k])){
        // Lists and objects (checklist, links, labels, assignees) merge item by item, as merge3 does, so a
        // change to another checklist item is kept; only a plain value both sides changed is a clash.
        if(c[k]!==null&&typeof c[k]==='object'&&s[k]!==null&&typeof s[k]==='object'){n[k]=structuredClone(merge3(f[k]??undefined,c[k],s[k]));continue}
        lost.push(k);
      }
      if(c[k]===undefined)delete n[k];else n[k]=structuredClone(c[k]);
    }
    if(lost.length)clash(s,lost);
    if(Object.keys(c).some(k=>!Object.hasOwn(f,k)&&!eqv(s[k],c[k])))ignored++;
    if(Object.hasOwn(f,'column')||Object.hasOwn(f,'moved'))place.add(s.id);
    return n;
  };
  for(const s of server){
    if(!ownCard(s)){out.push(s);continue}
    const id=s.id,c=C.get(id);
    if(Object.hasOwn(removed,id)&&!c){if(sameContent(s,removed[id]))continue;clash(s,['removed']);out.push(s);continue}
    if(Object.hasOwn(changed,id)&&c){out.push(take(s,c,changed[id]));continue}
    if(added.has(id)&&c){if(!sameCard(s,c))clash(s,Object.keys({...s,...c}).filter(k=>!eqv(s[k],c[k])));out.push(structuredClone(c));place.add(id);continue}
    if(!c||!sameCard(s,c))ignored++;
    out.push(s);
  }
  for(const c of C.values()){
    if(S.has(c.id))continue;
    // Edited here, removed meanwhile by someone else: the edit keeps the card (as merge3 does).
    // (Only re-stamped, e.g. text typed and changed back: nothing to keep it for.)
    if(Object.hasOwn(changed,c.id)&&Object.keys(changed[c.id]).some(k=>!STAMPS.has(k))){clash(c,['deleted']);out.push(structuredClone(c));place.add(c.id)}
    else if(added.has(c.id)){out.push(structuredClone(c));place.add(c.id)}
    else if(!Object.hasOwn(changed,c.id))ignored++;
  }
  if(place.size){
    // Next to the nearest card of the same column in the copy (after the one before it, else before the
    // one after it); a card alone in its column stays where it is.
    // Moved cards go in the copy's order, each anchored only to a card already in place (one not moved,
    // or moved and placed before it), so several moves in one save keep their order.
    const order=client.map(c=>c?.id),done=new Set();
    for(const id of order){
      if(!place.has(id))continue;
      done.add(id);
      const k=out.find(x=>x.id===id)?.column,i=order.indexOf(id),there=j=>order[j]!==id&&(!place.has(order[j])||done.has(order[j]))&&out.some(y=>y.id===order[j]&&y.column===k);
      let after=null,before=null;
      for(let j=i-1;j>=0&&!after;j--)if(there(j))after=order[j];
      if(!after)for(let j=i+1;j<order.length&&!before;j++)if(there(j))before=order[j];
      if(!after&&!before)continue;
      const [c]=out.splice(out.findIndex(x=>x.id===id),1);
      if(after)out.splice(out.findIndex(x=>x.id===after)+1,0,c);else out.splice(out.findIndex(x=>x.id===before),0,c);
    }
  }
  return {cards:out,clashes,ignored};
}
// A browser merging the server's copy into its own: its card edits replayed onto the server's cards, and
// the journal now based on what the server has. Clashes keep this copy's value (it is the user's edit).
export function rebaseCards(remote,local,journal){
  const r=applyCardEdits(remote,local,cardEditsOf(journal,{devops:{cards:local}}));
  const R=new Map((remote||[]).filter(ownCard).map(c=>[c.id,c])),O=new Map(r.cards.filter(ownCard).map(c=>[c.id,c])),j={};
  for(const id of Object.keys(journal||{})){
    const base=R.get(id)??null,now=O.get(id)??null;
    if(base===null?now!==null:now===null||!sameCard(base,now))j[id]=base&&structuredClone(base);
  }
  return {cards:r.cards,journal:j,clashes:r.clashes};
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
