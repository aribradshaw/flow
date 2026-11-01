// Flow sharing, the pure part (no storage, no I/O): which records a share covers, what the recipient
// sees, which recipient edits reach the owner, and what a revoke removes. lib/shares.mjs stores it.
//
// share = {id, ownerEnv, ownerEmail, recipientEmail, permission:'view'|'comment'|'edit', scope, name,
//          createdAt, createdBy, revokedAt, via}   (via: the share request it was approved from)
// scope = {kind:'environment'} | {kind:'person', nodeId} | {kind:'label', label} | {kind:'project', projectId}
//       | {kind:'nodes', nodeIds:[...]}   plus an optional chartId that limits nodes and edges to one chart.
//
// Rules (Owner, cards #59-#63):
// - A person scope walks DOWN from the node over ownership and group edges (from = owner/parent). Nothing
//   above or beside that chain is included.
// - Every scoped node brings its direct owners/groupers (incoming edges) as read-only STUBS: name, type and
//   percent. A stub never brings anything else, in particular none of its other children.
// - A scoped node brings its projects (project.entity = node id), their timeline items and DevOps cards.
// - Recipients cannot re-share: they request it and the owner approves or denies.
// - In the recipient's environment a shared record has the id `sh.<shareId>.<owner id>`. Detection always
//   uses that prefix (the browser's clean* functions strip unknown fields such as `linked`). Private nodes
//   and edges never cross: projections are built only from the owner's data, and only whitelisted field
//   edits on in-scope, non-stub records go back. Person emails never cross (photos do).
import {COLUMNS,LINK_KINDS} from '../public/devops-core.js';
import {validPersonImage} from './cleaners.mjs';

export const PERMISSIONS=['view','comment','edit'];
export const SCOPES=['environment','person','label','project','nodes'];
const RANK={view:0,comment:1,edit:2};
export const allows=(share,need)=>!!share&&!share.revokedAt&&RANK[share.permission]>=RANK[need];
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
const clone=v=>structuredClone(v);
const uid=()=>globalThis.crypto.randomUUID();

// Linked ids: sh.<shareId>.<owner id>. Share ids are UUIDs (no dots), so the first dot after it splits.
export const linkedId=(shareId,id)=>`sh.${shareId}.${id}`;
export const prefix=shareId=>`sh.${shareId}.`;
export function parseLinkedId(x){const m=/^sh\.([A-Za-z0-9_-]+)\.(.+)$/.exec(String(x||''));return m?{shareId:m[1],id:m[2]}:null}
export const shareChartId=shareId=>linkedId(shareId,'chart');

// ---- Scope --------------------------------------------------------------------------------------
function graph(db,scope){
  const charts=(db.charts||[]).filter(c=>!scope?.chartId||c.id===scope.chartId);
  const nodes=new Map(charts.flatMap(c=>c.nodes||[]).map(n=>[n.id,n]));
  const edges=charts.flatMap(c=>c.edges||[]).filter(e=>nodes.has(e.from)&&nodes.has(e.to));
  return {nodes,edges};
}
// Everything reachable downward from `start` (start included). Cycles are safe.
export function walkDown(edges,start){
  const out=new Map();for(const e of edges)if(e.type==='ownership'||e.type==='group')(out.get(e.from)||out.set(e.from,[]).get(e.from)).push(e.to);
  const seen=new Set([start]),todo=[start];
  while(todo.length)for(const to of out.get(todo.pop())||[])if(!seen.has(to)){seen.add(to);todo.push(to)}
  return seen;
}

// -> {nodeIds, edgeIds, stubs:[{nodeId,name,nodeType,ownsNodeId,type,percent,edgeId}], projectIds, itemIds, cardIds, labelIds}
// Always computed live from the owner's current data.
export function resolveScope(db,share){
  const s=share?.scope||{},{nodes,edges}=graph(db,s),projects=db.projects||[],items=db.timeline||[],cards=db.devops?.cards||[];
  const ids=new Set(),projectIds=new Set(),itemIds=new Set(),cardIds=new Set();
  const everything=s.kind==='environment';
  if(everything){for(const id of nodes.keys())ids.add(id);for(const p of projects)projectIds.add(p.id);for(const i of items)itemIds.add(i.id);for(const c of cards)cardIds.add(c.id)}
  else if(s.kind==='person'){if(nodes.has(s.nodeId))for(const id of walkDown(edges,s.nodeId))ids.add(id)}
  else if(s.kind==='nodes'){for(const id of Array.isArray(s.nodeIds)?s.nodeIds:[])if(nodes.has(id))ids.add(id)}
  else if(s.kind==='project'){if(projects.some(p=>p.id===s.projectId))projectIds.add(s.projectId)}
  else if(s.kind==='label'&&s.label){
    // A DevOps label id, or a chart tag (nodes may carry an optional tags[] of strings).
    for(const n of nodes.values())if(Array.isArray(n.tags)&&n.tags.includes(s.label))ids.add(n.id);
    for(const c of cards)if(c.labels?.includes(s.label)){cardIds.add(c.id);if(c.item)itemIds.add(c.item)}
  }
  if(!everything){
    // A node's projects are the ones placed under it by id (never by a matching name: that could leak).
    for(const p of projects)if(p.entity&&ids.has(p.entity))projectIds.add(p.id);
    for(const i of items)if(i.projects?.some(p=>projectIds.has(p)))itemIds.add(i.id);
    for(const c of cards)if(c.project&&projectIds.has(c.project))cardIds.add(c.id);
  }
  const edgeIds=edges.filter(e=>ids.has(e.from)&&ids.has(e.to)).map(e=>e.id);
  const stubs=edges.filter(e=>ids.has(e.to)&&!ids.has(e.from)).map(e=>{const o=nodes.get(e.from);return {nodeId:o.id,name:o.name,nodeType:o.type,ownsNodeId:e.to,type:e.type,percent:e.percent,edgeId:e.id}});
  const labelIds=new Set(cards.filter(c=>cardIds.has(c.id)).flatMap(c=>c.labels||[]));
  return {nodeIds:[...ids],edgeIds,stubs,projectIds:[...projectIds],itemIds:[...items.filter(i=>itemIds.has(i.id)).map(i=>i.id)],cardIds:[...cardIds],labelIds:[...labelIds]};
}

// ---- Creating shares and re-share requests ------------------------------------------------------
export function validScope(s){
  if(!s||!SCOPES.includes(s.kind))return false;
  if(s.chartId!==undefined&&typeof s.chartId!=='string')return false;
  if(s.kind==='person')return typeof s.nodeId==='string'&&!!s.nodeId;
  if(s.kind==='project')return typeof s.projectId==='string'&&!!s.projectId;
  if(s.kind==='label')return typeof s.label==='string'&&!!s.label;
  if(s.kind==='nodes')return Array.isArray(s.nodeIds)&&s.nodeIds.length>0&&s.nodeIds.length<=2000&&s.nodeIds.every(x=>typeof x==='string');
  return true;
}
const cleanScope=s=>({kind:s.kind,...(s.chartId?{chartId:s.chartId}:{}),...(s.kind==='person'?{nodeId:s.nodeId}:s.kind==='project'?{projectId:s.projectId}:s.kind==='label'?{label:s.label}:s.kind==='nodes'?{nodeIds:[...new Set(s.nodeIds)]}:{})});
const EMAIL=/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

// Only the environment's owner may share it; a recipient never can (they request instead).
// env = {id, ownerEmail} (lib/environments.mjs).  -> {ok, share} | {ok:false, error}
export function createShare(env,user,{recipientEmail,scope,permission='view',name=''}={},via=null){
  if(!env?.id||!user?.email||!same(env.ownerEmail,user.email))return {ok:false,error:'forbidden'};
  const to=String(recipientEmail||'').trim().toLowerCase();
  if(!EMAIL.test(to)||to.length>254)return {ok:false,error:'invalid',field:'recipientEmail'};
  if(same(to,user.email))return {ok:false,error:'invalid',field:'recipientEmail'};
  if(!validScope(scope))return {ok:false,error:'invalid',field:'scope'};
  if(!PERMISSIONS.includes(permission))return {ok:false,error:'invalid',field:'permission'};
  return {ok:true,share:{id:uid(),ownerEnv:env.id,ownerEmail:user.email.toLowerCase(),recipientEmail:to,permission,scope:cleanScope(scope),name:String(name||'').slice(0,80),
    createdAt:new Date().toISOString(),createdBy:user.email.toLowerCase(),revokedAt:null,via}};
}
// A recipient asks the owner to share the same scope with someone else, at most at their own level.
export function requestReshare(share,user,{toEmail,permission,note=''}={}){
  if(!share||share.revokedAt)return {ok:false,error:'revoked'};
  if(!user?.email||!same(share.recipientEmail,user.email))return {ok:false,error:'forbidden'};
  const to=String(toEmail||'').trim().toLowerCase();permission=permission||share.permission;
  if(!EMAIL.test(to)||same(to,share.ownerEmail)||same(to,user.email))return {ok:false,error:'invalid',field:'toEmail'};
  if(!PERMISSIONS.includes(permission)||RANK[permission]>RANK[share.permission])return {ok:false,error:'invalid',field:'permission'};
  return {ok:true,request:{id:uid(),shareId:share.id,ownerEmail:share.ownerEmail,requestedBy:user.email.toLowerCase(),toEmail:to,permission,note:String(note||'').slice(0,500),
    status:'pending',createdAt:new Date().toISOString(),decidedAt:null,decidedBy:null,newShareId:null}};
}
// The owner approves (optionally lowering the permission) or denies. Approving returns the new share.
export function decideRequest(request,share,user,approve,{permission}={}){
  if(!request||request.status!=='pending')return {ok:false,error:'decided'};
  if(!share||share.id!==request.shareId||!user?.email||!same(share.ownerEmail,user.email))return {ok:false,error:'forbidden'};
  const decided={...request,status:approve?'approved':'denied',decidedAt:new Date().toISOString(),decidedBy:user.email.toLowerCase()};
  if(!approve)return {ok:true,request:decided};
  if(share.revokedAt)return {ok:false,error:'revoked'};
  permission=permission||request.permission;
  if(!PERMISSIONS.includes(permission)||RANK[permission]>RANK[request.permission])return {ok:false,error:'invalid',field:'permission'};
  const r=createShare({id:share.ownerEnv,ownerEmail:share.ownerEmail},user,{recipientEmail:request.toEmail,scope:share.scope,permission,name:share.name},request.id);
  if(!r.ok)return r;
  return {ok:true,request:{...decided,newShareId:r.share.id},share:r.share};
}

// ---- What the recipient sees --------------------------------------------------------------------
// placements: [{recordId, chartId, x, y, w, h}] for this share in the recipient's environment (recordId may
// be the owner id or the linked id). Without one, a node sits in the share's own chart at the owner's x/y.
// -> {share, chart:{id,name}, nodes, edges, projects, timeline, cards, labels}  (null when revoked)
export function projectForRecipient(ownerDb,share,placements=[]){
  if(!share||share.revokedAt)return null;
  const sc=resolveScope(ownerDb,share),L=id=>linkedId(share.id,id),{nodes,edges}=graph(ownerDb,share.scope);
  const nodeIds=new Set(sc.nodeIds),projectIds=new Set(sc.projectIds),itemIds=new Set(sc.itemIds),labelIds=new Set(sc.labelIds);
  const chart={id:shareChartId(share.id),name:share.name||`Shared · ${ownerDb.environment?.name||share.ownerEmail}`};
  const at=new Map(placements.map(p=>[parseLinkedId(p.recordId)?.id||p.recordId,p]));
  const linked=(id,extra={})=>({share:share.id,id,home:share.ownerEnv,permission:share.permission,...extra});
  const layout=n=>{const p=at.get(n.id),num=v=>Number.isFinite(v)?v:undefined;
    return {chartId:p?.chartId||chart.id,x:num(p?.x)??n.x,y:num(p?.y)??n.y,...(num(p?.w)??n.w?{w:num(p?.w)??n.w}:{}),...(num(p?.h)??n.h?{h:num(p?.h)??n.h}:{})}};
  // A person's photo travels with their card (anyone who sees the card may see it); their email never does.
  const photo=n=>n.type==='person'&&validPersonImage(n.image)?{image:n.image}:{};
  const outNodes=[...nodeIds].map(id=>nodes.get(id)).map(n=>({id:L(n.id),name:n.name,type:n.type,...(n.notes?{notes:n.notes}:{}),...photo(n),...layout(n),linked:linked(n.id)}));
  for(const id of new Set(sc.stubs.map(s=>s.nodeId))){const n=nodes.get(id);outNodes.push({id:L(n.id),name:n.name,type:n.type,...photo(n),...layout(n),linked:linked(n.id,{stub:true,readOnly:true})})}
  const edgeIds=new Set(sc.edgeIds),stubEdges=new Set(sc.stubs.map(s=>s.edgeId));
  const outEdges=edges.filter(e=>edgeIds.has(e.id)||stubEdges.has(e.id)).map(e=>({id:L(e.id),from:L(e.from),to:L(e.to),type:e.type,percent:e.percent,linked:linked(e.id,stubEdges.has(e.id)?{stub:true,readOnly:true}:{})}));
  const projects=(ownerDb.projects||[]).filter(p=>projectIds.has(p.id)).map(p=>({id:L(p.id),name:p.name,color:p.color,entity:nodeIds.has(p.entity)?L(p.entity):'',linked:linked(p.id)}));
  // item.release names another item by title: kept only when that release is shared too.
  const shared=(ownerDb.timeline||[]).filter(i=>itemIds.has(i.id)),titles=new Set(shared.map(i=>i.title));
  const timeline=shared.map(i=>{const {inbox,...rest}=i;return {...clone(rest),id:L(i.id),projects:(i.projects||[]).filter(p=>projectIds.has(p)).map(L),release:titles.has(i.release)?i.release:'',linked:linked(i.id)}});
  const cardIds=new Set(sc.cardIds);
  const cards=(ownerDb.devops?.cards||[]).filter(c=>cardIds.has(c.id)).map(c=>{const {inbox,...rest}=c;return {...clone(rest),id:L(c.id),
    project:projectIds.has(c.project)?L(c.project):'',item:itemIds.has(c.item)?L(c.item):'',labels:(c.labels||[]).map(L),
    assignees:(c.assignees||[]).filter(a=>nodeIds.has(a.node)).map(a=>({...a,node:L(a.node)})),linked:linked(c.id)}});
  const labels=(ownerDb.devops?.labels||[]).filter(l=>labelIds.has(l.id)).map(l=>({...l,id:L(l.id),linked:linked(l.id,{readOnly:true})}));
  return {share:{id:share.id,permission:share.permission,ownerEnv:share.ownerEnv,ownerEmail:share.ownerEmail},chart,nodes:outNodes,edges:outEdges,projects,timeline,cards,labels};
}

// Remove a share's records from a recipient workspace (in place), with the recipient's private edges and
// references to them. keep: linked ids that stay. Returns what was removed.
function detach(db,shareId,keep=new Set()){
  const pre=prefix(shareId),gone=id=>typeof id==='string'&&id.startsWith(pre)&&!keep.has(id);
  const removed={nodes:[],edges:[],projects:[],items:[],cards:[],labels:[],charts:[]};
  for(const c of db.charts||[]){
    c.nodes=c.nodes.filter(n=>gone(n.id)?(removed.nodes.push(n.id),false):true);
    const here=new Set(c.nodes.map(n=>n.id));
    c.edges=c.edges.filter(e=>gone(e.id)||!here.has(e.from)||!here.has(e.to)?(removed.edges.push(e.id),false):true);
  }
  const chartId=shareChartId(shareId);
  if(!keep.has(chartId)&&db.charts?.some(c=>c.id===chartId&&!c.nodes.length)){db.charts=db.charts.filter(c=>c.id!==chartId||c.nodes.length);removed.charts.push(chartId)}
  if(db.charts&&!db.charts.some(c=>c.id===db.active))db.active=db.charts[0]?.id;
  db.projects=(db.projects||[]).filter(p=>gone(p.id)?(removed.projects.push(p.id),false):true);
  for(const p of db.projects)if(gone(p.entity))p.entity='';
  db.timeline=(db.timeline||[]).filter(i=>gone(i.id)?(removed.items.push(i.id),false):true);
  for(const i of db.timeline)if(i.projects)i.projects=i.projects.filter(p=>!gone(p));
  if(db.devops){
    db.devops.cards=(db.devops.cards||[]).filter(c=>gone(c.id)?(removed.cards.push(c.id),false):true);
    db.devops.labels=(db.devops.labels||[]).filter(l=>gone(l.id)?(removed.labels.push(l.id),false):true);
    for(const c of db.devops.cards){
      if(gone(c.project))c.project='';if(gone(c.item))c.item='';
      if(c.labels)c.labels=c.labels.filter(l=>!gone(l));if(c.assignees)c.assignees=c.assignees.filter(a=>!gone(a.node));
    }
  }
  return removed;
}

// Put a fresh projection into the recipient's workspace (returns a new db). Records of this share are
// replaced; records that left the scope disappear with the recipient's private edges to them.
export function applyProjection(recipientDb,projection){
  const db=clone(recipientDb);if(!projection)return db;
  const {share,chart}=projection,keep=new Set([chart.id,...projection.nodes.map(n=>n.id),...projection.edges.map(e=>e.id),...projection.projects.map(p=>p.id),...projection.timeline.map(i=>i.id),...projection.cards.map(c=>c.id),...projection.labels.map(l=>l.id)]);
  // Linked records currently placed: drop them first (kept ids too; they are re-inserted fresh below),
  // but remember the recipient's private edges to kept nodes.
  db.charts=db.charts||[];
  const privateEdges=db.charts.map(c=>[c.id,c.edges.filter(e=>!e.id.startsWith(prefix(share.id))&&(keep.has(e.from)||keep.has(e.to)))]);
  detach(db,share.id,keep);
  const pre=prefix(share.id),mine=id=>id.startsWith(pre);
  for(const c of db.charts){c.nodes=c.nodes.filter(n=>!mine(n.id));c.edges=c.edges.filter(e=>!mine(e.id)&&!mine(e.from)&&!mine(e.to))}
  const charts=new Set(db.charts.map(c=>c.id));
  const target=n=>charts.has(n.chartId)?n.chartId:chart.id;
  if(projection.nodes.some(n=>target(n)===chart.id)&&!charts.has(chart.id)){db.charts.push({id:chart.id,name:chart.name,nodes:[],edges:[]});charts.add(chart.id)}
  const where=new Map();
  for(const {chartId,...n} of projection.nodes){const c=db.charts.find(x=>x.id===target({chartId}));c.nodes.push(clone(n));where.set(n.id,c.id)}
  for(const c of db.charts){
    const here=new Set(c.nodes.map(n=>n.id));
    for(const e of projection.edges)if(where.get(e.from)===c.id&&where.get(e.to)===c.id)c.edges.push(clone(e));
    for(const e of privateEdges.find(([id])=>id===c.id)?.[1]||[])if(here.has(e.from)&&here.has(e.to))c.edges.push(e);
  }
  // Every node placed in the recipient's own charts: the share's chart is not needed.
  db.charts=db.charts.filter(c=>c.id!==chart.id||c.nodes.length);
  if(!db.charts.some(c=>c.id===db.active))db.active=db.charts[0]?.id;
  const swap=(list,add)=>[...(list||[]).filter(x=>!mine(x.id)),...clone(add)];
  db.projects=swap(db.projects,projection.projects);
  db.timeline=swap(db.timeline,projection.timeline);
  db.devops=db.devops||{columns:COLUMNS.map(([id,name])=>({id,name})),cards:[],nextNumber:1,labels:[]};
  db.devops.cards=swap(db.devops.cards,projection.cards);
  db.devops.labels=swap(db.devops.labels,projection.labels);
  return db;
}

// Revoke: everything of the share leaves the recipient's workspace, with their private edges to it.
// -> {db, removed:{nodes,edges,projects,items,cards,labels,charts}}
export function revokeEffects(recipientDb,share){
  const db=clone(recipientDb),removed=detach(db,share.id);
  return {db,removed};
}

// Share ids that have linked records in a workspace. Any that is no longer an active, attached share
// should go through revokeEffects (e.g. on GET after a revoke).
export function linkedShareIds(db){
  const ids=new Set(),add=id=>{const p=parseLinkedId(id);if(p)ids.add(p.shareId)};
  for(const c of db.charts||[]){add(c.id);for(const n of c.nodes||[])add(n.id);for(const e of c.edges||[])add(e.id)}
  for(const x of [...(db.projects||[]),...(db.timeline||[]),...(db.devops?.cards||[]),...(db.devops?.labels||[])])add(x.id);
  return [...ids];
}

// ---- Recipient edits ----------------------------------------------------------------------------
// Only these fields travel back to the owner. Layout (x, y, w, h, chart) is per-environment placement.
const DATE=/^\d{4}-\d{2}-\d{2}$/,COLOR=/^#[0-9a-f]{6}$/i;
// Kept in step with public/store.js (which cannot load in Node).
const ITEM_KINDS=['feature','milestone','release','deadline','project','phase','event'],ITEM_PRIORITY=['high','medium','low'],ITEM_STATUS=['planned','active','risk','blocked','done','cancelled'];
const text=(max,required)=>v=>typeof v==='string'&&v.length<=max&&(!required||!!v.trim());
const oneOf=list=>v=>list.includes(v);
const date=v=>v===''||(typeof v==='string'&&DATE.test(v));
export const FIELDS={
  node:{name:text(160,true),notes:text(2000)},
  edge:{percent:v=>v===''||(v!==null&&v!==true&&v!==false&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=100)},
  project:{name:text(80,true),color:v=>typeof v==='string'&&COLOR.test(v)},
  item:{title:text(200,true),kind:oneOf(ITEM_KINDS),status:oneOf(ITEM_STATUS),priority:oneOf(['',...ITEM_PRIORITY]),start:date,end:date,owner:text(120),link:text(500),notes:text(4000),release:text(200)},
  card:{title:text(200,true),description:text(8000),column:oneOf(COLUMNS.map(([k])=>k)),points:v=>v===null||(Number.isFinite(v)&&v>=0&&v<=1000),due:date,
    labels:v=>Array.isArray(v)&&v.length<=50&&v.every(x=>typeof x==='string'),
    checklist:v=>Array.isArray(v)&&v.length<=200&&v.every(x=>x&&typeof x.text==='string'&&x.text.length<=300),
    links:v=>Array.isArray(v)&&v.length<=50&&v.every(x=>x&&typeof x.url==='string'&&x.url.trim()&&x.url.length<=500&&(!x.kind||LINK_KINDS[x.kind]))},
};
function record(db,kind,id){
  if(kind==='node')return (db.charts||[]).flatMap(c=>c.nodes||[]).find(n=>n.id===id);
  if(kind==='edge')return (db.charts||[]).flatMap(c=>c.edges||[]).find(e=>e.id===id);
  if(kind==='project')return (db.projects||[]).find(p=>p.id===id);
  if(kind==='item')return (db.timeline||[]).find(i=>i.id===id);
  if(kind==='card')return (db.devops?.cards||[]).find(c=>c.id===id);
}
const inScope=(sc,kind,id)=>({node:sc.nodeIds,edge:sc.edgeIds,project:sc.projectIds,item:sc.itemIds,card:sc.cardIds})[kind]?.includes(id);

// edit = {kind:'node'|'edge'|'project'|'item'|'card', id (owner or linked id), fields:{...}} or
//        {kind, id, comment:'text'}.
// -> {ok:true, ownerDbPatch:[{kind,id,field,value}], history:[{shareId,envId,kind,recordId,field,old,new,by,at}]}
//  | {ok:false, error:'revoked'|'forbidden'|'permission'|'stub'|'out-of-scope'|'not-found'|'invalid', field?}
// Never mutates ownerDb; apply the patch with applyOwnerPatch.
export function applyRecipientEdit(ownerDb,share,edit,user){
  if(!share||share.revokedAt)return {ok:false,error:'revoked'};
  if(!user?.email||!same(user.email,share.recipientEmail))return {ok:false,error:'forbidden'};
  const kind=edit?.kind,p=parseLinkedId(edit?.id),id=p?(p.shareId===share.id?p.id:null):edit?.id;
  if(!FIELDS[kind]||typeof id!=='string')return {ok:false,error:'invalid',field:'kind'};
  const isComment=typeof edit.comment==='string';
  if(!allows(share,isComment?'comment':'edit'))return {ok:false,error:'permission'};
  const sc=resolveScope(ownerDb,share);
  if((kind==='node'&&sc.stubs.some(s=>s.nodeId===id))||(kind==='edge'&&sc.stubs.some(s=>s.edgeId===id)))return {ok:false,error:'stub'};
  if(!inScope(sc,kind,id))return {ok:false,error:'out-of-scope'};
  const rec=record(ownerDb,kind,id);if(!rec)return {ok:false,error:'not-found'};
  const at=new Date().toISOString(),by=user.email.toLowerCase(),entry=(field,old,nw)=>({shareId:share.id,envId:share.ownerEnv,kind,recordId:id,field,old,new:nw,by,at});
  if(isComment){
    const t=edit.comment.trim();if(!t||t.length>4000)return {ok:false,error:'invalid',field:'comment'};
    return {ok:true,ownerDbPatch:[],history:[entry('comment',null,t)]};
  }
  const fields=edit.fields&&typeof edit.fields==='object'?edit.fields:{};
  const ownerLabels=new Set((ownerDb.devops?.labels||[]).map(l=>l.id)),patch=[],history=[];
  for(let [field,value] of Object.entries(fields)){
    const check=FIELDS[kind][field];if(!check||!check(value))return {ok:false,error:'invalid',field};
    if(kind==='edge')value=value===''?'':String(Number(value));
    if(kind==='card'&&field==='labels'){value=[...new Set(value.map(l=>parseLinkedId(l)?.shareId===share.id?parseLinkedId(l).id:l))];if(!value.every(l=>ownerLabels.has(l)))return {ok:false,error:'invalid',field}}
    if(kind==='card'&&field==='checklist')value=value.map(x=>({id:typeof x.id==='string'?x.id:uid(),text:x.text,done:!!x.done}));
    if(kind==='card'&&field==='links')value=value.map(x=>({id:typeof x.id==='string'?x.id:uid(),kind:LINK_KINDS[x.kind]?x.kind:'url',url:x.url}));
    const old=rec[field]??(kind==='card'&&field==='points'?null:'');
    if(JSON.stringify(old)===JSON.stringify(value))continue;
    patch.push({kind,id,field,value});history.push(entry(field,clone(old),clone(value)));
  }
  if(kind==='item'){const start=fields.start??rec.start,end=fields.end??rec.end;if(end&&(!start||end<start))return {ok:false,error:'invalid',field:'end'}}
  return {ok:true,ownerDbPatch:patch,history};
}
// Apply an ownerDbPatch to the owner's workspace (returns a new db).
export function applyOwnerPatch(ownerDb,patch){
  const db=clone(ownerDb),now=new Date().toISOString();
  for(const {kind,id,field,value} of patch){
    const rec=record(db,kind,id);if(!rec)continue;
    rec[field]=clone(value);
    if(kind==='card'){rec.updated=now;if(field==='column')rec.moved=now}
  }
  return db;
}

// Compare a workspace the recipient saved with the projection it was given: layout changes become
// placements (any permission), field changes become edits (checked by applyRecipientEdit), the rest is
// the recipient's own data. Deleting a shared record in the recipient's copy is ignored (it comes back).
// -> {placements:[{recordId,chartId,x,y,w,h}], edits:[{kind,id,fields}]}
export function extractRecipientChanges(projection,submittedDb){
  const out={placements:[],edits:[]};if(!projection)return out;
  const pre=prefix(projection.share.id),own=id=>parseLinkedId(id).id;
  const byId=list=>new Map(list.map(x=>[x.id,x]));
  const diff=(kind,given,sent,map=(f,v)=>v)=>{
    if(!given||!sent)return;const fields={};
    for(const f of Object.keys(FIELDS[kind]))if(f in sent&&JSON.stringify(map(f,sent[f]))!==JSON.stringify(map(f,given[f])))fields[f]=map(f,sent[f]);
    if(Object.keys(fields).length)out.edits.push({kind,id:own(sent.id),fields});
  };
  const nodes=byId(projection.nodes),edges=byId(projection.edges);
  for(const c of submittedDb.charts||[]){
    for(const n of c.nodes||[]){
      if(!n.id.startsWith(pre))continue;const g=nodes.get(n.id);if(!g)continue;
      if(g.chartId!==c.id||g.x!==n.x||g.y!==n.y||g.w!==n.w||g.h!==n.h)out.placements.push({recordId:own(n.id),chartId:c.id,x:n.x,y:n.y,w:n.w,h:n.h});
      if(!g.linked?.stub)diff('node',g,n);
    }
    for(const e of c.edges||[])if(e.id.startsWith(pre)&&!edges.get(e.id)?.linked?.stub)diff('edge',edges.get(e.id),e);
  }
  const unlabel=(f,v)=>f==='labels'&&Array.isArray(v)?v.map(l=>parseLinkedId(l)?.id||l):v;
  const P=byId(projection.projects),I=byId(projection.timeline),C=byId(projection.cards);
  for(const p of submittedDb.projects||[])if(p.id.startsWith(pre))diff('project',P.get(p.id),p);
  for(const i of submittedDb.timeline||[])if(i.id.startsWith(pre))diff('item',I.get(i.id),i);
  for(const c of submittedDb.devops?.cards||[])if(c.id.startsWith(pre))diff('card',C.get(c.id),c,unlabel);
  return out;
}
