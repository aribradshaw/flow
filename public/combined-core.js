// Combined view, the pure part (browser and server; docs/combined.md). The environment that is open is
// the HOME: new cards and projects go there and the mind map shows it. Other environments of the same
// user can be combined into its DevOps board and Timeline. Their records are projected into the home
// workspace on every read with ids `cx.<env id>.<their id>` (references between them mapped the same
// way, `@email` share members kept as they are), like shared records (`sh.*`, lib/sharing-core.mjs).
//
// Rules:
// - Combined records are never stored in the home environment: the server strips them, and every
//   reference a home record holds to one, from every save (stripCombined).
// - Only field edits travel back, to the record's own environment, and only the fields shared records
//   allow (sync-core SHARED_FIELDS), each one only when the browser's copy changed it (fieldBase), so a
//   copy that is merely out of date never overwrites anything. Creating, deleting and re-parenting
//   (project, timeline item) stay in the record's own environment.
// - The people of a combined environment (its person cards, for assignees) come along in db.combined,
//   never as mind map cards: the mind map stays the home environment's.
import {SHARED_FIELDS,same} from './sync-core.js';
import {COLUMNS,moveCard} from './devops-core.js';

export const MAX_COMBINED=8;
const ENV=/^[A-Za-z0-9-]{1,64}$/;
export const isForeign=id=>typeof id==='string'&&id.startsWith('cx.');
export const foreignId=(env,id)=>`cx.${env}.${id}`;
export function parseForeign(x){const m=/^cx\.([A-Za-z0-9-]{1,64})\.(.+)$/.exec(String(x||''));return m?{env:m[1],id:m[2]}:null}
// The environment a record shows from: its env id for a combined record, '' for the home environment's own.
export const envOf=x=>parseForeign(typeof x==='string'?x:x?.id)?.env||'';
// A list of environment ids to combine (an array or "a,b"): valid, unique, never the home, at most MAX_COMBINED.
export function cleanCombine(list,home=''){
  const raw=Array.isArray(list)?list:typeof list==='string'?list.split(','):[];
  return [...new Set(raw.map(x=>String(x||'').trim()).filter(x=>ENV.test(x)&&x!==home))].slice(0,MAX_COMBINED);
}

const clone=v=>structuredClone(v);
// One environment's workspace (as its owner is served it, shares included) as combined records.
// meta: {env, name, rev}. -> {meta:{env,name,rev,people,shares,shareMembers}, projects, timeline, cards, labels}
export function projectEnv(data,{env,name='',rev=0}={}){
  const L=id=>typeof id==='string'&&id?foreignId(env,id):'';
  const P=id=>typeof id==='string'&&id.startsWith('@')?id:L(id);
  const people=new Map();
  for(const c of data?.charts||[])for(const n of c?.nodes||[])
    if(n?.type==='person'&&typeof n.id==='string'&&!people.has(n.id)&&!n.linked?.stub)people.set(n.id,{id:L(n.id),name:String(n.name||''),type:'person',...(typeof n.image==='string'&&n.image?{image:n.image}:{})});
  const projects=(data?.projects||[]).filter(p=>typeof p?.id==='string').map(p=>({id:L(p.id),name:p.name,color:p.color,entity:L(p.entity)}));
  const timeline=(data?.timeline||[]).filter(i=>typeof i?.id==='string').map(i=>{const {inbox,linked,...rest}=i;
    return {...clone(rest),id:L(i.id),projects:(i.projects||[]).map(L).filter(Boolean),release:L(i.release)}});
  const labels=(data?.devops?.labels||[]).filter(l=>typeof l?.id==='string').map(l=>{const {linked,...rest}=l;return {...rest,id:L(l.id)}});
  const cards=(data?.devops?.cards||[]).filter(c=>typeof c?.id==='string').map(c=>{const {inbox,linked,...rest}=c;
    return {...clone(rest),id:L(c.id),project:L(c.project),item:L(c.item),labels:(c.labels||[]).map(L).filter(Boolean),
      assignees:(c.assignees||[]).filter(a=>typeof a?.node==='string').map(a=>({node:P(a.node),role:a.role}))}});
  const shares=(data?.shares||[]).map(s=>({id:s.id,permission:s.permission,ownerEmail:s.ownerEmail||'',ownerEnv:s.ownerEnv||'',ownerEnvName:s.ownerEnvName||'',members:(s.members||[]).map(m=>({...m,id:P(m.id)}))}));
  const shareMembers=(data?.shareMembers||[]).map(m=>({...m,cards:(m.cards||[]).map(L)}));
  return {meta:{env,name:String(name||data?.environment?.name||'Workspace').slice(0,80),rev,people:[...people.values()],shares,shareMembers},projects,timeline,cards,labels};
}

// The home workspace with these projections in it (a new db). Combined records already there are replaced.
export function applyCombined(db,projections=[]){
  const d=stripRecords(clone(db));if(!projections.length)return d;
  d.projects=[...(d.projects||[]),...projections.flatMap(p=>clone(p.projects))];
  d.timeline=[...(d.timeline||[]),...projections.flatMap(p=>clone(p.timeline))];
  d.devops=d.devops||{columns:COLUMNS.map(([id,name])=>({id,name})),cards:[],nextNumber:1,labels:[]};
  d.devops.cards=[...(d.devops.cards||[]),...projections.flatMap(p=>clone(p.cards))];
  d.devops.labels=[...(d.devops.labels||[]),...projections.flatMap(p=>clone(p.labels))];
  d.combined=projections.map(p=>clone(p.meta));
  return d;
}
function stripRecords(d){
  if(!d||typeof d!=='object')return d;
  delete d.combined;
  if(Array.isArray(d.projects))d.projects=d.projects.filter(x=>!isForeign(x?.id));
  if(Array.isArray(d.timeline))d.timeline=d.timeline.filter(x=>!isForeign(x?.id));
  if(d.devops&&typeof d.devops==='object'){
    if(Array.isArray(d.devops.cards))d.devops.cards=d.devops.cards.filter(x=>!isForeign(x?.id));
    if(Array.isArray(d.devops.labels))d.devops.labels=d.devops.labels.filter(x=>!isForeign(x?.id));
  }
  return d;
}
// The home workspace without any combined record, and without any reference one of its own records holds
// to one (a new object; the input is not changed). What the server stores, whatever a browser sent.
export function stripCombined(db){
  if(!db||typeof db!=='object')return db;
  const d=stripRecords(clone(db)),no=v=>!isForeign(v);
  for(const p of d.projects||[])if(isForeign(p?.entity))p.entity='';
  for(const i of d.timeline||[]){if(Array.isArray(i?.projects))i.projects=i.projects.filter(no);if(isForeign(i?.release))i.release=''}
  for(const c of d.devops?.cards||[]){
    if(!c||typeof c!=='object')continue;
    if(isForeign(c.project))c.project='';if(isForeign(c.item))c.item='';
    if(Array.isArray(c.labels))c.labels=c.labels.filter(no);
    if(Array.isArray(c.assignees))c.assignees=c.assignees.filter(a=>no(a?.node));
  }
  for(const a of [...(d.agentflow?.agents||[]),...(d.agentflow?.workflows||[])])for(const k of ['cards','projects','items'])if(Array.isArray(a?.[k]))a[k]=a[k].filter(no);
  return d;
}
// Whether a workspace holds any combined record, or a reference to one (cheap: no copy).
export function hasCombined(d){
  if(!d||typeof d!=='object')return false;
  if(d.combined)return true;
  const f=isForeign;
  for(const p of d.projects||[])if(f(p?.id)||f(p?.entity))return true;
  for(const i of d.timeline||[])if(f(i?.id)||f(i?.release)||(Array.isArray(i?.projects)&&i.projects.some(f)))return true;
  for(const l of d.devops?.labels||[])if(f(l?.id))return true;
  for(const c of d.devops?.cards||[])if(f(c?.id)||f(c?.project)||f(c?.item)||(Array.isArray(c?.labels)&&c.labels.some(f))||(Array.isArray(c?.assignees)&&c.assignees.some(a=>f(a?.node))))return true;
  for(const a of [...(d.agentflow?.agents||[]),...(d.agentflow?.workflows||[])])for(const k of ['cards','projects','items'])if(Array.isArray(a?.[k])&&a[k].some(f))return true;
  return false;
}
// Environments that have combined records in a workspace.
export function combinedEnvs(db){
  const out=new Set(),add=x=>{const e=envOf(x?.id);if(e)out.add(e)};
  for(const x of [...(db?.projects||[]),...(db?.timeline||[]),...(db?.devops?.cards||[])])add(x);
  return [...out];
}
// Copy the combined records (and db.combined) of `from` into `own`, a copy of the home's own data: used
// where something works on the home's records only (the agent inbox) and must keep what is shown.
export function carryCombined(own,from){
  const d=stripRecords(clone(own));if(!from?.combined)return d;
  d.projects=[...(d.projects||[]),...(from.projects||[]).filter(x=>isForeign(x.id))];
  d.timeline=[...(d.timeline||[]),...(from.timeline||[]).filter(x=>isForeign(x.id))];
  if(d.devops){d.devops.cards=[...(d.devops.cards||[]),...(from.devops?.cards||[]).filter(x=>isForeign(x.id))];d.devops.labels=[...(d.devops.labels||[]),...(from.devops?.labels||[]).filter(x=>isForeign(x.id))]}
  d.combined=clone(from.combined);
  return clone(d);
}

// The field edits a home save makes to one combined environment's records, applied to that environment's
// workspace as served to its owner (shares included). submitted: the whole home workspace the browser sent;
// base: its fieldBase (sync-core), keyed by combined ids. -> {data (a new copy of served), edits:[{kind,id,field}],
// base (fieldBase in that environment's own ids, for its shared records)}. Fields the browser did not change,
// records that are not there any more and references to another environment are left alone.
export function combinedEdits(served,submitted,base,env){
  const pre=`cx.${env}.`,U=id=>typeof id==='string'&&id.startsWith(pre)?id.slice(pre.length):null;
  const data=clone(served),edits=[],out={},now=new Date().toISOString();
  const lists={project:[data.projects||[],submitted?.projects||[]],item:[data.timeline||[],submitted?.timeline||[]],card:[data.devops?.cards||[],submitted?.devops?.cards||[]]};
  // A submitted value in the environment's own ids. SKIP: it points somewhere else (or is missing), so it
  // is not sent; WAKE: no snooze.
  const SKIP=Symbol('skip'),WAKE=Symbol('wake');
  const value=(kind,f,v)=>{
    if(kind==='card'&&f==='snoozedUntil')return v?v:WAKE;
    if(v===undefined)return SKIP;
    if(kind==='card'&&f==='labels'){if(!Array.isArray(v))return SKIP;const ids=v.map(U);return ids.every(Boolean)?ids:SKIP}
    if(kind==='card'&&f==='assignees'){if(!Array.isArray(v))return SKIP;const list=v.map(a=>({node:typeof a?.node==='string'&&a.node.startsWith('@')?a.node:U(a?.node),role:a?.role}));return list.every(a=>a.node)?list:SKIP}
    if(kind==='item'&&f==='release')return !v?'':U(v)??SKIP;
    if(kind==='card'&&f==='column')return COLUMNS.some(([k])=>k===v)?v:SKIP;
    return v;
  };
  for(const [kind,[have,sent]] of Object.entries(lists)){
    const byId=new Map(have.map(x=>[x?.id,x]));
    for(const x of sent){
      const id=U(x?.id),t=id&&byId.get(id),fb=base?.[kind]?.[x?.id];if(!t||!fb||typeof fb!=='object')continue;
      let changed=false;
      for(const f of SHARED_FIELDS[kind]){
        if(!(f in fb))continue;
        const v=value(kind,f,x[f]);if(v===SKIP)continue;
        if(v===WAKE?!t[f]:same(t[f],v))continue;
        if(kind==='card'&&f==='column')moveCard(data.devops,id,v);
        else if(v===WAKE)delete t[f];
        else t[f]=clone(v);
        const b=fb[f]===null?null:value(kind,f,fb[f]);
        ((out[kind]??={})[id]??={})[f]=b===SKIP||b===WAKE?null:b;
        edits.push({kind,id,field:f});changed=true;
      }
      if(changed&&kind==='card')t.updated=now;
    }
  }
  return {data,edits,base:out};
}
