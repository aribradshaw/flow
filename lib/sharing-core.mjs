// Flow sharing, the pure part (no storage, no I/O): which records a share covers, what the recipient
// sees, which recipient edits reach the owner, and what a revoke removes. lib/shares.mjs stores it.
//
// share = {id, ownerEnv, ownerEmail, recipientEmail, permission:'view'|'comment'|'edit', scope, name,
//          createdAt, createdBy, revokedAt, via, actor}   (via: the share request it was approved from;
//          actor: the API key or MCP connector that made it, by name, or null)
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
// - A share's MEMBERS are its owner and the recipients of every active share of the same records (same
//   owner environment and scope: a share and the re-shares approved from it). They can be assigned to its
//   cards as `@<email>` (or as their person card, when the owner's charts have one with that email).
// - ADDITIONS (share.adds, edit shares only): 'off' (default), 'approve' (a new record the recipient makes
//   inside the share is a pending proposal the owner approves or denies) or 'direct' (it lands in the
//   owner's data at once). planAdditions finds them, additionsInScope keeps only what the scope can hold.
import {COLUMNS,LINK_KINDS,ROLES} from '../public/devops-core.js';
import {validPersonImage,validOpidUser} from './cleaners.mjs';

export const PERMISSIONS=['view','comment','edit'];
// What a recipient may add to the owner's data (edit shares only; view and comment shares are always 'off').
export const ADDS=['off','approve','direct'];
export const addsOf=s=>!!s&&!s.revokedAt&&s.permission==='edit'&&ADDS.includes(s.adds)?s.adds:'off';
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
const lc=v=>String(v||'').trim().toLowerCase();
// Field values compared as JSON, with missing, null and '' all meaning empty.
const J=v=>JSON.stringify(v===undefined||v===''?null:v);

// ---- Members ------------------------------------------------------------------------------------
export const memberId=email=>'@'+lc(email);
export const memberEmail=id=>typeof id==='string'&&id.startsWith('@')?id.slice(1):'';
// Emails of a share's members: its owner, then the recipients of active shares of the same records.
export function shareMembers(share,shares=[]){
  if(!share)return [];
  const key=J(share.scope),out=[lc(share.ownerEmail),lc(share.recipientEmail)];
  for(const s of shares)if(s&&!s.revokedAt&&s.ownerEnv===share.ownerEnv&&J(s.scope)===key)out.push(lc(s.recipientEmail));
  return [...new Set(out.filter(Boolean))];
}
// Person cards that carry an email (the first one per email), across every chart of the owner's data.
function personsByEmail(db){
  const m=new Map();
  for(const c of db.charts||[])for(const n of c.nodes||[])if(n.type==='person'&&typeof n.email==='string'&&n.email&&!m.has(lc(n.email)))m.set(lc(n.email),n);
  return m;
}

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
  // AgentFlow comes with whole-environment shares only (agents and workflows; runners are read-only).
  const af=everything?db.agentflow||{}:{},agentIds=(af.agents||[]).filter(a=>typeof a?.id==='string').map(a=>a.id),workflowIds=(af.workflows||[]).filter(w=>typeof w?.id==='string').map(w=>w.id);
  return {nodeIds:[...ids],edgeIds,stubs,projectIds:[...projectIds],itemIds:[...items.filter(i=>itemIds.has(i.id)).map(i=>i.id)],cardIds:[...cardIds],labelIds:[...labelIds],agentIds,workflowIds};
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
export function createShare(env,user,{recipientEmail,scope,permission='view',name='',adds='off'}={},via=null){
  if(!env?.id||!user?.email||!same(env.ownerEmail,user.email))return {ok:false,error:'forbidden'};
  const to=String(recipientEmail||'').trim().toLowerCase();
  if(!EMAIL.test(to)||to.length>254)return {ok:false,error:'invalid',field:'recipientEmail'};
  if(same(to,user.email))return {ok:false,error:'invalid',field:'recipientEmail'};
  if(!validScope(scope))return {ok:false,error:'invalid',field:'scope'};
  if(!PERMISSIONS.includes(permission))return {ok:false,error:'invalid',field:'permission'};
  if(!ADDS.includes(adds||'off'))return {ok:false,error:'invalid',field:'adds'};
  return {ok:true,share:{id:uid(),ownerEnv:env.id,ownerEmail:user.email.toLowerCase(),recipientEmail:to,permission,scope:cleanScope(scope),name:String(name||'').slice(0,80),
    adds:permission==='edit'?adds||'off':'off',createdAt:new Date().toISOString(),createdBy:user.email.toLowerCase(),revokedAt:null,via}};
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
// How a share shows values of the owner's records to its recipient. members: emails (shareMembers).
// assignee(a) -> the assignee's node as the recipient sees it (linked id, or @email for a member), or
// null when it stays hidden (a person outside the scope who is not a member).
function viewer(ownerDb,share,sc=resolveScope(ownerDb,share),members=shareMembers(share)){
  const L=id=>linkedId(share.id,id),nodeIds=new Set(sc.nodeIds),itemIds=new Set(sc.itemIds),mem=new Set(members.map(lc));
  const byEmail=personsByEmail(ownerDb),emailOf=new Map([...byEmail].map(([e,n])=>[n.id,e]));
  const assignee=a=>{
    if(nodeIds.has(a.node))return L(a.node);
    const e=lc(memberEmail(a.node)||emailOf.get(a.node));if(!e||!mem.has(e))return null;
    // A member with an in-scope person card is that card (as in share.members).
    const n=byEmail.get(e);return n&&nodeIds.has(n.id)?L(n.id):memberId(e);
  };
  const value=(kind,field,v)=>{
    if(kind==='card'&&field==='labels'&&Array.isArray(v))return v.map(L);
    if(kind==='card'&&field==='assignees'&&Array.isArray(v))return v.map(a=>({...a,node:assignee(a)})).filter(a=>a.node);
    if(kind==='item'&&field==='release')return itemIds.has(v)?L(v):'';
    if(kind==='agent'||kind==='workflow')return afValue(field,v);
    return v;
  };
  // AgentFlow references (whole-environment shares): only to records the share covers; others stay hidden.
  const agentIds=new Set(sc.agentIds||[]),refSets={projects:new Set(sc.projectIds),cards:new Set(sc.cardIds),items:itemIds};
  const refL=(set,x)=>typeof x==='string'&&set.has(x)?L(x):'';
  const afValue=(field,v)=>{
    if(field==='reportsTo')return refL(agentIds,v);
    if(field==='supervisor')return refL(nodeIds,v);
    if(refSets[field]&&Array.isArray(v))return v.filter(x=>refSets[field].has(x)).map(L);
    if(field==='steps'&&Array.isArray(v))return v.map(x=>({...x,agent:refL(agentIds,x?.agent)}));
    return v;
  };
  return {sc,L,nodeIds,itemIds,mem,byEmail,assignee,value};
}
// An entry of field history as the recipient may see it: values in their ids, hidden people left out.
export function historyForRecipient(ownerDb,share,entry,members){
  if(entry.field==='comment')return entry;
  const v=viewer(ownerDb,share,undefined,members);
  return {...entry,old:v.value(entry.kind,entry.field,entry.old),new:v.value(entry.kind,entry.field,entry.new)};
}

// placements: [{recordId, chartId, x, y, w, h}] for this share in the recipient's environment (recordId may
// be the owner id or the linked id). Without one, a node sits in the share's own chart at the owner's x/y.
// opts.members: the share's member emails (shareMembers; default its owner and recipient). They come
// along as share.members [{id, email, name, image?, owner}] so they can be assigned to its cards.
// -> {share, chart:{id,name}, nodes, edges, projects, timeline, cards, labels}  (null when revoked)
// opts.viewer: the recipient's OneProfileID id. A card linked to their account carries opidUser (so they
// can unlink it); a card linked to anyone else carries only opidLinked:true (lib/opid-photos.mjs).
// opts.pending: the recipient's pending proposals for this share (additions waiting for the owner). Their
// records come along like linked ones, with linked.pending = the proposal id, and share.pending lists them.
export function projectForRecipient(ownerDb,share,placements=[],{members,viewer:viewerOpid,pending=[]}={}){
  if(!share||share.revokedAt)return null;
  const view=viewer(ownerDb,share,undefined,members||shareMembers(share));
  const {sc,L}=view,{nodes,edges}=graph(ownerDb,share.scope);
  const nodeIds=new Set(sc.nodeIds),projectIds=new Set(sc.projectIds),itemIds=new Set(sc.itemIds),labelIds=new Set(sc.labelIds);
  const chart={id:shareChartId(share.id),name:share.name||`Shared · ${ownerDb.environment?.name||share.ownerEmail}`};
  const at=new Map(placements.map(p=>[parseLinkedId(p.recordId)?.id||p.recordId,p]));
  const linked=(id,extra={})=>({share:share.id,id,home:share.ownerEnv,permission:share.permission,...extra});
  const layout=n=>{const p=at.get(n.id),num=v=>Number.isFinite(v)?v:undefined;
    return {chartId:p?.chartId||chart.id,x:num(p?.x)??n.x,y:num(p?.y)??n.y,...(num(p?.w)??n.w?{w:num(p?.w)??n.w}:{}),...(num(p?.h)??n.h?{h:num(p?.h)??n.h}:{})}};
  // A person's photo travels with their card (anyone who sees the card may see it); their email never does.
  const photo=n=>n.type!=='person'?{}:{...(validPersonImage(n.image)?{image:n.image}:{}),
    ...(validOpidUser(n.opidUser)?(viewerOpid&&n.opidUser===viewerOpid?{opidUser:viewerOpid}:{opidLinked:true}):{})};
  const outNodes=[...nodeIds].map(id=>nodes.get(id)).map(n=>({id:L(n.id),name:n.name,type:n.type,...(n.notes?{notes:n.notes}:{}),...photo(n),...layout(n),linked:linked(n.id)}));
  for(const id of new Set(sc.stubs.map(s=>s.nodeId))){const n=nodes.get(id);outNodes.push({id:L(n.id),name:n.name,type:n.type,...photo(n),...layout(n),linked:linked(n.id,{stub:true,readOnly:true})})}
  const edgeIds=new Set(sc.edgeIds),stubEdges=new Set(sc.stubs.map(s=>s.edgeId));
  const outEdges=edges.filter(e=>edgeIds.has(e.id)||stubEdges.has(e.id)).map(e=>({id:L(e.id),from:L(e.from),to:L(e.to),type:e.type,percent:e.percent,linked:linked(e.id,stubEdges.has(e.id)?{stub:true,readOnly:true}:{})}));
  const projects=(ownerDb.projects||[]).filter(p=>projectIds.has(p.id)).map(p=>({id:L(p.id),name:p.name,color:p.color,entity:nodeIds.has(p.entity)?L(p.entity):'',linked:linked(p.id)}));
  // item.release is another item's id: kept (as its linked id) only when that release is shared too.
  const timeline=(ownerDb.timeline||[]).filter(i=>itemIds.has(i.id)).map(i=>{const {inbox,...rest}=i;return {...clone(rest),id:L(i.id),projects:(i.projects||[]).filter(p=>projectIds.has(p)).map(L),release:view.value('item','release',i.release),linked:linked(i.id)}});
  const cardIds=new Set(sc.cardIds);
  // Assignees outside the scope stay hidden unless they are members of the share.
  const cards=(ownerDb.devops?.cards||[]).filter(c=>cardIds.has(c.id)).map(c=>{const {inbox,...rest}=c;return {...clone(rest),id:L(c.id),
    project:projectIds.has(c.project)?L(c.project):'',item:itemIds.has(c.item)?L(c.item):'',labels:(c.labels||[]).map(L),
    assignees:view.value('card','assignees',c.assignees||[]),linked:linked(c.id)}});
  const labels=(ownerDb.devops?.labels||[]).filter(l=>labelIds.has(l.id)).map(l=>({...l,id:L(l.id),linked:linked(l.id,{readOnly:true})}));
  // Members: a person card with their email names them (in scope: that card is the assignee).
  const memberList=[...view.mem].map(e=>{const n=view.byEmail.get(e);return {id:n&&nodeIds.has(n.id)?L(n.id):memberId(e),email:e,name:n?.name||e,...(n&&validPersonImage(n.image)?{image:n.image}:{}),owner:e===lc(share.ownerEmail)}});
  // Pending additions: in the recipient's ids, references kept only to what they can see.
  const pend=new Map(),pendingIds=[];
  for(const p of pending||[])if(p?.status==='pending'&&p.shareId===share.id)for(const k of KIND_KEYS)for(const r of p.records?.[k]||[])pend.set(r.id,{p,k,r});
  const seen=id=>!!id&&(nodeIds.has(id)||projectIds.has(id)||itemIds.has(id)||pend.has(id)),rv=id=>seen(id)?L(id):'';
  const pl=(id,extra={})=>linked(id,{pending:extra.p.id});
  for(const {p,k,r} of pend.values()){
    pendingIds.push(L(r.id));const at0=p.createdAt||new Date().toISOString();
    if(k==='node')outNodes.push({id:L(r.id),name:r.name,type:r.type,...(r.notes?{notes:r.notes}:{}),...layout(r),linked:pl(r.id,{p})});
    else if(k==='edge'){if((nodeIds.has(r.from)||pend.get(r.from)?.k==='node')&&(nodeIds.has(r.to)||pend.get(r.to)?.k==='node'))outEdges.push({id:L(r.id),from:L(r.from),to:L(r.to),type:r.type,percent:r.percent,linked:pl(r.id,{p})})}
    else if(k==='project')projects.push({id:L(r.id),name:r.name,color:r.color,entity:rv(r.entity),linked:pl(r.id,{p})});
    else if(k==='item')timeline.push({...clone(r),id:L(r.id),projects:(r.projects||[]).filter(seen).map(L),release:rv(r.release),linked:pl(r.id,{p})});
    else if(k==='card'){const {localNumber,localId,...c}=r;cards.push({...clone(c),id:L(r.id),number:Number.isInteger(localNumber)?localNumber:0,project:rv(r.project),item:rv(r.item),labels:(r.labels||[]).filter(l=>labelIds.has(l)).map(L),
      assignees:view.value('card','assignees',r.assignees||[]),created:at0,updated:p.updatedAt||at0,moved:at0,linked:pl(r.id,{p})})}
  }
  return {share:{id:share.id,permission:share.permission,ownerEnv:share.ownerEnv,ownerEmail:share.ownerEmail,adds:addsOf(share),members:memberList,pending:pendingIds},chart,nodes:outNodes,edges:outEdges,projects,timeline,cards,labels};
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

// ---- Opening a shared environment (docs/sharing.md, "Opening a shared environment") ---------------
// The recipient of a whole-environment share can open the owner's environment itself: a virtual environment
// share-<shareId> that shows the owner's charts, timeline, DevOps board and AgentFlow as the owner has them,
// through this share's projection (the same linked ids, fields and locks as placed copies, so nothing else of
// the owner's: private records outside the scope's chartId, person emails, the owner's own share list and
// members never cross). It is never stored. The server builds it from the owner's current data on every read,
// and a save sends back only what the share allows (extractRecipientChanges, applyRecipientEdit).
export const OPENED_PREFIX='share-';
export const openedEnvId=shareId=>OPENED_PREFIX+shareId;
export function parseOpenedEnv(id){const m=/^share-([A-Za-z0-9_-]{1,58})$/.exec(String(id||''));return m?m[1]:null}
// Only active whole-environment shares can be opened; other scopes are placed in the recipient's own environments.
export const canOpen=s=>!!s&&!s.revokedAt&&s.scope?.kind==='environment';
// The projection of an opened environment: projectForRecipient's records, with every mind map card on its own
// chart (charts: the owner's charts, as linked ids), every label of the board, and AgentFlow: agents and
// workflows (references only to what the share covers) and runners, read-only and without their job commands.
// placements: x, y, w, h only (a card always stays on its owner's chart). opts: as projectForRecipient.
// -> {...projection, charts:[{id,name}], active, agents, workflows, runners, columns, nextNumber, workflow, envName} | null
export function openedProjection(ownerDb,share,placements=[],opts={}){
  if(!canOpen(share)||!ownerDb)return null;
  const p=projectForRecipient(ownerDb,share,(placements||[]).map(({chartId,...x})=>x),opts);if(!p)return null;
  const L=id=>linkedId(share.id,id),view=viewer(ownerDb,share,undefined,opts.members||shareMembers(share));
  const charts=(ownerDb.charts||[]).filter(c=>!share.scope.chartId||c.id===share.scope.chartId);
  const chartOf=new Map(charts.flatMap(c=>(c.nodes||[]).map(n=>[L(n.id),L(c.id)])));
  // A pending mind map card sits on the owner's chart it will be added to.
  for(const pr of opts.pending||[])if(pr?.status==='pending'&&pr.shareId===share.id)for(const r of pr.records?.node||[])if(charts.some(c=>c.id===r.chart))chartOf.set(L(r.id),L(r.chart));
  const fallback=charts.length?L(charts[0].id):p.chart.id;
  for(const n of p.nodes)n.chartId=chartOf.get(n.id)||fallback;
  const linked=(id,extra={})=>({share:share.id,id,home:share.ownerEnv,permission:share.permission,...extra});
  const af=ownerDb.agentflow||{},agentIds=new Set(view.sc.agentIds),workflowIds=new Set(view.sc.workflowIds),v=view.value;
  const agents=(af.agents||[]).filter(a=>agentIds.has(a?.id)).map(a=>({...clone(a),id:L(a.id),reportsTo:v('agent','reportsTo',a.reportsTo||''),supervisor:v('agent','supervisor',a.supervisor||''),
    projects:v('agent','projects',a.projects||[]),cards:v('agent','cards',a.cards||[]),items:v('agent','items',a.items||[]),linked:linked(a.id)}));
  const workflows=(af.workflows||[]).filter(w=>workflowIds.has(w?.id)).map(w=>({...clone(w),id:L(w.id),steps:v('workflow','steps',w.steps||[]),
    projects:v('workflow','projects',w.projects||[]),cards:v('workflow','cards',w.cards||[]),items:v('workflow','items',w.items||[]),linked:linked(w.id)}));
  // A runner's job commands are command lines on the owner's machines: they stay there.
  const runners=(af.runners||[]).filter(r=>r&&typeof r.name==='string').map(r=>{const {jobs,...x}=clone(r);return {...x,jobs:(Array.isArray(jobs)?jobs:[]).map(({command,...j})=>j)}});
  const has=new Set(p.labels.map(l=>l.id));
  const labels=[...p.labels,...(ownerDb.devops?.labels||[]).filter(l=>!has.has(L(l.id))).map(l=>({...clone(l),id:L(l.id),linked:linked(l.id,{readOnly:true})}))];
  return {...p,labels,agents,workflows,runners,charts:charts.length?charts.map(c=>({id:L(c.id),name:c.name})):[{id:p.chart.id,name:p.chart.name}],
    active:charts.some(c=>c.id===ownerDb.active)?L(ownerDb.active):fallback,columns:Array.isArray(ownerDb.devops?.columns)?clone(ownerDb.devops.columns):null,
    nextNumber:Number.isInteger(ownerDb.devops?.nextNumber)?ownerDb.devops.nextNumber:1,workflow:ownerDb.workflow&&typeof ownerDb.workflow==='object'?clone(ownerDb.workflow):null,envName:ownerDb.environment?.name||''};
}
// The workspace an opened environment serves (environment id share-<shareId>). name: the owner environment's name.
export function openedDb(p,{name}={}){
  if(!p)return null;
  const charts=p.charts.map(c=>({id:c.id,name:c.name,nodes:[],edges:[]})),byId=new Map(charts.map(c=>[c.id,c])),where=new Map();
  for(const {chartId,...n} of p.nodes){const c=byId.get(chartId)||charts[0];c.nodes.push(clone(n));where.set(n.id,c)}
  for(const e of p.edges){const c=where.get(e.from);if(c&&where.get(e.to)===c)c.edges.push(clone(e))}
  const next=Math.max(p.nextNumber||1,...p.cards.map(c=>Number.isInteger(c.number)?c.number+1:1));
  return {active:byId.has(p.active)?p.active:charts[0].id,charts,projects:clone(p.projects),timeline:clone(p.timeline),
    devops:{...(p.columns?{columns:clone(p.columns)}:{}),cards:clone(p.cards),labels:clone(p.labels),nextNumber:next},
    agentflow:{agents:clone(p.agents||[]),workflows:clone(p.workflows||[]),runners:clone(p.runners||[])},...(p.workflow?{workflow:clone(p.workflow)}:{}),
    environment:{id:openedEnvId(p.share.id),name:String(name||p.envName||'Shared environment').slice(0,80),ownerEmail:p.share.ownerEmail,visibility:'private',members:[]}};
}

// ---- Recipient edits ----------------------------------------------------------------------------
// Only these fields travel back to the owner. Layout (x, y, w, h, chart) is per-environment placement.
const DATE=/^\d{4}-\d{2}-\d{2}$/,COLOR=/^#[0-9a-f]{6}$/i;
// Kept in step with public/store.js (which cannot load in Node).
const ITEM_KINDS=['feature','milestone','release','deadline','project','phase','event'],ITEM_PRIORITY=['high','medium','low'],ITEM_STATUS=['planned','active','risk','blocked','done','cancelled'];
const text=(max,required)=>v=>typeof v==='string'&&v.length<=max&&(!required||!!v.trim());
const oneOf=list=>v=>list.includes(v);
const date=v=>v===''||(typeof v==='string'&&DATE.test(v));
const ref=v=>typeof v==='string'&&v.length<=300;
const refList=v=>Array.isArray(v)&&v.length<=100&&v.every(ref);
const texts=v=>Array.isArray(v)&&v.length<=50&&v.every(x=>typeof x==='string'&&x.length<=200);
export const FIELDS={
  node:{name:text(160,true),notes:text(2000)},
  edge:{percent:v=>v===''||(v!==null&&v!==true&&v!==false&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=100)},
  project:{name:text(80,true),color:v=>typeof v==='string'&&COLOR.test(v)},
  item:{title:text(200,true),kind:oneOf(ITEM_KINDS),status:oneOf(ITEM_STATUS),priority:oneOf(['',...ITEM_PRIORITY]),start:date,end:date,owner:text(120),link:text(500),notes:text(4000),release:text(200)},
  card:{title:text(200,true),description:text(8000),column:oneOf(COLUMNS.map(([k])=>k)),points:v=>v===null||(Number.isFinite(v)&&v>=0&&v<=1000),actual:v=>v===null||(Number.isFinite(v)&&v>=0&&v<=1000),due:date,
    labels:v=>Array.isArray(v)&&v.length<=50&&v.every(x=>typeof x==='string'),
    // An ISO time; null or '' clears it.
    snoozedUntil:v=>v===null||v===''||(typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))),
    checklist:v=>Array.isArray(v)&&v.length<=200&&v.every(x=>x&&typeof x.text==='string'&&x.text.length<=300),
    links:v=>Array.isArray(v)&&v.length<=50&&v.every(x=>x&&typeof x.url==='string'&&x.url.trim()&&x.url.length<=500&&(!x.kind||LINK_KINDS[x.kind])),
    // People the recipient can see: in-scope person cards (linked ids) and the share's members (@email).
    assignees:v=>Array.isArray(v)&&v.length<=20&&v.every(a=>a&&typeof a.node==='string'&&a.node.length<=300&&(a.role===undefined||ROLES.includes(a.role)))},
  // AgentFlow (whole-environment shares). Card delegation is agent.cards. Kept in step with SHARED_FIELDS in
  // public/sync-core.js and the kinds and statuses of public/agentflow-core.js.
  agent:{name:text(120,true),title:text(120),status:oneOf(['draft','active','paused','retired']),purpose:text(2000),inputs:texts,outputs:texts,
    reportsTo:ref,supervisor:ref,projects:refList,cards:refList,items:refList},
  workflow:{name:text(120,true),description:text(4000),status:oneOf(['draft','active','paused']),trigger:oneOf(['manual','schedule','event']),schedule:text(200),
    steps:v=>Array.isArray(v)&&v.length<=100&&v.every(x=>x&&typeof x==='object'&&(x.id===undefined||(typeof x.id==='string'&&x.id.length<=80))&&ref(x.agent??'')&&text(500)(x.action??'')&&text(300)(x.output??'')),
    projects:refList,cards:refList,items:refList},
};
// What runs on the owner's machines stays the owner's: an agent's live switch, the runner it runs on
// (runtime), its models, how it picks them (auto), its schedule, standing instructions, tools, kind (an
// automation is never live) and the runner job it came from. Runners are read-only (only runners.report
// changes them). A recipient's change to any of these is refused with 'owner-only'.
export const OWNER_ONLY={agent:['live','runtime','models','model','auto','schedule','instructions','tools','kind','job']};
function record(db,kind,id){
  if(kind==='node')return (db.charts||[]).flatMap(c=>c.nodes||[]).find(n=>n.id===id);
  if(kind==='edge')return (db.charts||[]).flatMap(c=>c.edges||[]).find(e=>e.id===id);
  if(kind==='project')return (db.projects||[]).find(p=>p.id===id);
  if(kind==='item')return (db.timeline||[]).find(i=>i.id===id);
  if(kind==='card')return (db.devops?.cards||[]).find(c=>c.id===id);
  if(kind==='agent')return (db.agentflow?.agents||[]).find(a=>a.id===id);
  if(kind==='workflow')return (db.agentflow?.workflows||[]).find(w=>w.id===id);
}
const inScope=(sc,kind,id)=>({node:sc.nodeIds,edge:sc.edgeIds,project:sc.projectIds,item:sc.itemIds,card:sc.cardIds,agent:sc.agentIds,workflow:sc.workflowIds})[kind]?.includes(id);
// An AgentFlow field from a recipient, in the owner's ids: references must be records the share covers.
// Owner-side references the share does not show (e.g. to cards shared into the owner's environment) stay.
// -> {value} | null (invalid)
function afField(ownerDb,sc,kind,field,value,rec,own){
  const sets={projects:sc.projectIds,cards:sc.cardIds,items:sc.itemIds};
  if(field==='reportsTo'){if(value==='')return {value};const o=own(value);return o&&o!==rec.id&&sc.agentIds.includes(o)?{value:o}:null}
  if(field==='supervisor'){if(value==='')return {value};const o=own(value),n=o&&sc.nodeIds.includes(o)?record(ownerDb,'node',o):null;return n?.type==='person'?{value:o}:null}
  if(sets[field]){
    const set=new Set(sets[field]),out=[];
    for(const x of value){const o=own(x);if(!o||!set.has(o))return null;if(!out.includes(o))out.push(o)}
    return {value:[...(rec[field]||[]).filter(x=>!set.has(x)),...out]};
  }
  if(field==='steps'){
    const out=[];
    for(const x of value){const a=x.agent?own(x.agent):'';if(a===null||(a&&!sc.agentIds.includes(a)))return null;out.push({id:typeof x.id==='string'&&x.id?x.id:uid(),agent:a||'',action:x.action??'',output:x.output??''})}
    return {value:out};
  }
  if(field==='inputs'||field==='outputs')return {value:[...new Set(value.map(x=>x.trim()).filter(Boolean))]};
  return {value};
}

// edit = {kind:'node'|'edge'|'project'|'item'|'card', id (owner or linked id), fields:{...}} or
//        {kind, id, comment:'text'}.   opts.members: the share's member emails (shareMembers).
// card.assignees replaces the people the recipient can see; hidden ones (outside the scope) stay. A member
// is stored as their person card when the owner has one with that email, else as @email.
// -> {ok:true, ownerDbPatch:[{kind,id,field,value}], history:[{shareId,envId,kind,recordId,field,old,new,by,at}]}
//  | {ok:false, error:'revoked'|'forbidden'|'permission'|'stub'|'out-of-scope'|'not-found'|'invalid', field?}
// Never mutates ownerDb; apply the patch with applyOwnerPatch.
export function applyRecipientEdit(ownerDb,share,edit,user,{members}={}){
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
  const view=kind==='card'&&'assignees' in fields?viewer(ownerDb,share,sc,members||shareMembers(share)):null;
  const own=v=>{const p=parseLinkedId(v);return p?(p.shareId===share.id?p.id:null):v};
  for(let [field,value] of Object.entries(fields)){
    if(OWNER_ONLY[kind]?.includes(field))return {ok:false,error:'owner-only',field};
    const check=FIELDS[kind][field];if(!check||!check(value))return {ok:false,error:'invalid',field};
    if(kind==='agent'||kind==='workflow'){const r=afField(ownerDb,sc,kind,field,value,rec,own);if(!r)return {ok:false,error:'invalid',field};value=r.value}
    if(kind==='item'&&field==='release'){value=value?own(value):'';if(value===null||(value&&!sc.itemIds.includes(value)))return {ok:false,error:'invalid',field}}
    if(kind==='card'&&field==='assignees'){
      const persons=new Set((ownerDb.charts||[]).flatMap(c=>c.nodes||[]).filter(n=>n.type==='person'&&sc.nodeIds.includes(n.id)).map(n=>n.id)),out=[];
      for(const a of value){
        let node=memberEmail(a.node)?null:own(a.node);
        if(memberEmail(a.node)){const e=lc(memberEmail(a.node));if(!view.mem.has(e))return {ok:false,error:'invalid',field};node=view.byEmail.get(e)?.id||memberId(e)}
        else if(!node||!persons.has(node))return {ok:false,error:'invalid',field};
        const role=a.role||'developer';if(!out.some(x=>x.node===node&&x.role===role))out.push({node,role});
      }
      const hidden=(rec.assignees||[]).filter(a=>!view.assignee(a)),seen=(rec.assignees||[]).filter(a=>view.assignee(a));
      if(J(seen)===J(out))continue;
      // History holds what the recipient can see; the owner's record keeps the hidden people.
      patch.push({kind,id,field,value:[...hidden,...out]});history.push(entry(field,clone(seen),clone(out)));continue;
    }
    if(kind==='edge')value=value===''?'':String(Number(value));
    if(kind==='card'&&field==='labels'){value=[...new Set(value.map(l=>parseLinkedId(l)?.shareId===share.id?parseLinkedId(l).id:l))];if(!value.every(l=>ownerLabels.has(l)))return {ok:false,error:'invalid',field}}
    if(kind==='card'&&field==='checklist')value=value.map(x=>({id:typeof x.id==='string'?x.id:uid(),text:x.text,done:!!x.done}));
    if(kind==='card'&&field==='links')value=value.map(x=>({id:typeof x.id==='string'?x.id:uid(),kind:LINK_KINDS[x.kind]?x.kind:'url',url:x.url}));
    const old=rec[field]??(kind==='card'&&(field==='points'||field==='actual')?null:'');
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
    if(kind==='agent'||kind==='workflow')rec.updated=now;
  }
  return db;
}

// Compare a workspace the recipient saved with the projection it was given: layout changes become
// placements (any permission), field changes become edits (checked by applyRecipientEdit), the rest is
// the recipient's own data. Deleting a shared record in the recipient's copy is ignored (it comes back).
// base (optional, from the browser: sync-core fieldBase): {node|edge|project|item|card:{<linked id>:
// {field: value before the recipient changed it}}}. With it, only fields the recipient changed are edits
// (a copy that is merely out of date never overwrites the owner), and an edit whose base is not the current
// value overwrote someone else's change: its field is listed in edit.clash (last write wins; docs/sharing.md).
// -> {placements:[{recordId,chartId,x,y,w,h}], edits:[{kind,id,fields,clash?:[field]}], pending:[{proposal,kind,id,fields}]}
export function extractRecipientChanges(projection,submittedDb,base=null){
  const out={placements:[],edits:[],pending:[]};if(!projection)return out;
  const pre=prefix(projection.share.id),own=id=>parseLinkedId(id).id;
  const byId=list=>new Map(list.map(x=>[x.id,x]));
  const diff=(kind,given,sent,map=(f,v)=>v)=>{
    if(!given||!sent)return;const b=base?base[kind]?.[sent.id]:null;if(base&&!b)return;
    const fields={},clash=[];
    for(const f of Object.keys(FIELDS[kind])){
      if(!(f in sent))continue;const now=J(map(f,sent[f]));
      if(now===J(map(f,given[f])))continue;
      if(b){if(!(f in b)||now===J(map(f,b[f])))continue;if(J(map(f,b[f]))!==J(map(f,given[f])))clash.push(f)}
      fields[f]=map(f,sent[f]);
    }
    if(!Object.keys(fields).length)return;
    // A pending addition is not the owner's yet: its edits change the proposal (applyPendingEdit).
    if(given.linked?.pending)out.pending.push({proposal:given.linked.pending,kind,id:own(sent.id),fields});
    else out.edits.push({kind,id:own(sent.id),fields,...(clash.length?{clash}:{})});
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
  // AgentFlow: only in an opened environment's projection (openedProjection).
  const A=byId(projection.agents||[]),W=byId(projection.workflows||[]);
  for(const a of submittedDb.agentflow?.agents||[])if(typeof a?.id==='string'&&a.id.startsWith(pre))diff('agent',A.get(a.id),a);
  for(const w of submittedDb.agentflow?.workflows||[])if(typeof w?.id==='string'&&w.id.startsWith(pre))diff('workflow',W.get(w.id),w);
  return out;
}

// ---- Owner edits and conflicts (card #61) ---------------------------------------------------------
const byKind=db=>({node:new Map((db.charts||[]).flatMap(c=>c.nodes||[]).map(x=>[x.id,x])),edge:new Map((db.charts||[]).flatMap(c=>c.edges||[]).map(x=>[x.id,x])),
  project:new Map((db.projects||[]).map(x=>[x.id,x])),item:new Map((db.timeline||[]).map(x=>[x.id,x])),card:new Map((db.devops?.cards||[]).map(x=>[x.id,x])),
  agent:new Map((db.agentflow?.agents||[]).map(x=>[x.id,x])),workflow:new Map((db.agentflow?.workflows||[]).map(x=>[x.id,x]))});
const SCOPE_KEYS={node:'nodeIds',edge:'edgeIds',project:'projectIds',item:'itemIds',card:'cardIds',agent:'agentIds',workflow:'workflowIds'};
// The owner saved their workspace: every change to an editable field of a shared record becomes field
// history for each active share that covers it, so its recipients see who changed what. base: as for
// extractRecipientChanges, keyed by owner ids. A change whose base is not the stored value overwrote
// someone else's change without the owner seeing it (a merge kept the owner's value): entry.clash.
// -> [{shareId, envId, kind, recordId, field, old, new, by, at, clash?}]
// For callers that change a workspace without the app's UI (the API and MCP): changes to linked records
// that a save cannot carry back, so they are refused instead of silently coming back on the next read.
// seen: the workspace as it was served; submitted: the same after the change.
// -> [{kind, id (linked id), field, stub?}] where field is the changed field, or 'deleted' when the record is gone.
// Layout (node x, y, w, h and chart) and the share's whitelisted FIELDS are fine; their values are
// checked later by applyRecipientEdit.
const FREE={node:['x','y','w','h'],card:['updated','moved','created','number'],agent:['x','y','updated','created'],workflow:['updated','created']};
export function lockedChanges(seen,submitted){
  const out=[],recs=d=>({node:(d?.charts||[]).flatMap(c=>c.nodes||[]),edge:(d?.charts||[]).flatMap(c=>c.edges||[]),project:d?.projects||[],item:d?.timeline||[],card:d?.devops?.cards||[],
    agent:d?.agentflow?.agents||[],workflow:d?.agentflow?.workflows||[]});
  const A=recs(seen),B=recs(submitted);
  for(const kind of Object.keys(FIELDS)){
    const after=new Map(B[kind].filter(x=>parseLinkedId(x?.id)).map(x=>[x.id,x]));
    for(const was of A[kind]){
      if(!parseLinkedId(was?.id))continue;const now=after.get(was.id);
      if(!now){out.push({kind,id:was.id,field:'deleted'});continue}
      for(const f of new Set([...Object.keys(was),...Object.keys(now)])){
        // A stub (someone outside the share) is read-only: only its layout may change.
        if(f==='linked'||(!was.linked?.stub&&f in FIELDS[kind])||FREE[kind]?.includes(f))continue;
        if(J(was[f])!==J(now[f]))out.push({kind,id:was.id,field:f,...(was.linked?.stub?{stub:true}:{})});
      }
    }
  }
  return out;
}
export function ownerChanges(oldDb,newDb,shares,user,base=null){
  const out=[];if(!oldDb||!newDb||!user?.email)return out;
  const at=new Date().toISOString(),by=lc(user.email),O=byKind(oldDb),N=byKind(newDb);
  for(const s of shares||[]){
    if(!s||s.revokedAt)continue;const sc=resolveScope(newDb,s);
    for(const [kind,key] of Object.entries(SCOPE_KEYS))for(const id of sc[key]){
      const a=O[kind].get(id),b=N[kind].get(id);if(!a||!b)continue;
      for(const f of Object.keys(FIELDS[kind])){
        if(J(a[f])===J(b[f]))continue;
        const bb=base?.[kind]?.[id],clash=!!(bb&&typeof bb==='object'&&f in bb&&J(bb[f])!==J(a[f]));
        out.push({shareId:s.id,envId:s.ownerEnv,kind,recordId:id,field:f,old:clone(a[f]??null),new:clone(b[f]??null),by,at,...(clash?{clash:true}:{})});
      }
    }
  }
  return out;
}
// Who wrote the value an edit replaced: the author of the newest history entry of that field when it
// still holds that value, else fallback (the owner, for a value from before any shared edit). null when
// that is the writer. history: entries of the record, newest first. norm(entry, value) compares values
// in the entry's terms (e.g. the people a recipient could see).
export function overwritten(history,field,value,writer,fallback='',norm=(e,v)=>v){
  const h=(history||[]).find(e=>e.field===field);
  const who=h&&J(norm(h,h.new))===J(norm(h,value))?h.by:fallback;
  return who&&!same(who,writer)?lc(who):null;
}
// A conflict this user lost, for the browser: on their copy of the record (linked id for a recipient),
// with the value they had (previous) and the one that replaced it (value). Recipients see values in their
// ids; people they cannot see are left out.
export function conflictView(entry,{ownerDb=null,share=null,members}={}){
  const view=share&&ownerDb?viewer(ownerDb,share,undefined,members||shareMembers(share)):null;
  const val=v=>view?view.value(entry.kind,entry.field,v):v;
  return {kind:entry.kind,id:view?view.L(entry.recordId):entry.recordId,field:entry.field,by:entry.by,at:entry.at,previous:val(entry.old),value:val(entry.new)};
}

// ---- Additions: recipients adding records to the owner's data (share.adds; docs/sharing.md) ----------------
// proposal = {id, shareId, ownerEnv, ownerEmail, proposedBy, envId (the recipient's), records:{node,edge,project,
//   item,card:[record in the owner's ids; nodes and edges carry chart, cards localNumber]}, status:'pending'|
//   'approved'|'denied'|'applied'|'withdrawn', createdAt, updatedAt, decidedAt, decidedBy}
// A record keeps localId when the id the recipient used is not its owner id (sh.<share>.new-<id>, or a clash).
const KIND_KEYS=['node','edge','project','item','card'];
const NODE_TYPES=['entity','person','area','note'],EDGE_TYPES=['ownership','group'];
// A client marks a new record for a share explicitly with this id (the API's `share` input does).
export const NEW_PREFIX='new-';
export const newLinkedId=(shareId,id)=>linkedId(shareId,NEW_PREFIX+id);
const emptyRecords=()=>({node:[],edge:[],project:[],item:[],card:[]});
function recordsWithChart(d){
  const out=emptyRecords();
  for(const c of d?.charts||[]){for(const n of c.nodes||[])out.node.push({rec:n,chart:c.id});for(const e of c.edges||[])out.edge.push({rec:e,chart:c.id})}
  for(const p of d?.projects||[])out.project.push({rec:p});for(const i of d?.timeline||[])out.item.push({rec:i});for(const c of d?.devops?.cards||[])out.card.push({rec:c});
  for(const k of KIND_KEYS)out[k]=out[k].filter(x=>x.rec&&typeof x.rec.id==='string');
  return out;
}
const idSets=d=>{const r=recordsWithChart(d),o={};for(const k of KIND_KEYS)o[k]=new Set(r[k].map(x=>x.rec.id));return o};
const everyId=d=>{const o=idSets(d);return new Set(KIND_KEYS.flatMap(k=>[...o[k]]).concat((d?.devops?.labels||[]).map(l=>l.id),(d?.charts||[]).map(c=>c.id)))};
const recordCount=r=>KIND_KEYS.reduce((n,k)=>n+(r?.[k]?.length||0),0);
export const proposalSize=p=>recordCount(p?.records);

// The owner's data with proposed records added as they are (ids kept, no card numbers): for scope checks.
export function withRecords(ownerDb,records){
  const db=clone(ownerDb||{});db.charts=db.charts||[];db.projects=db.projects||[];db.timeline=db.timeline||[];
  db.devops=db.devops||{columns:COLUMNS.map(([id,name])=>({id,name})),cards:[],nextNumber:1,labels:[]};db.devops.cards=db.devops.cards||[];
  const chartOf=id=>db.charts.find(c=>c.id===id)||db.charts[0];
  const where=new Map(db.charts.flatMap(c=>(c.nodes||[]).map(n=>[n.id,c])));
  for(const {chart,localId,...n} of records?.node||[]){const c=chartOf(chart);if(!c)continue;c.nodes.push(clone(n));where.set(n.id,c)}
  for(const {chart,localId,...e} of records?.edge||[]){const c=where.get(e.from);if(c&&where.get(e.to)===c)c.edges.push(clone(e))}
  for(const {localId,...p} of records?.project||[])db.projects.push(clone(p));
  for(const {localId,...i} of records?.item||[])db.timeline.push(clone(i));
  for(const {localId,localNumber,...c} of records?.card||[])db.devops.cards.push(clone(c));
  return db;
}
// Keep only the records the share's scope covers once they are added (with extra: other records already
// proposed). Repeats until stable, so a card in a project that fell out goes too.
// -> {records (kept), dropped:[{kind, id, localId?}]}
// An addition never widens the share over the owner's existing records: an edge to one of their nodes outside
// the scope (a co-owner stub, say) would bring it and everything below it in, so it is dropped, and a batch
// that still brings any existing record in is dropped whole.
export function additionsInScope(ownerDb,share,records,extra=null){
  let keep=clone(records||emptyRecords());const dropped=[];
  const base=extra?withRecords(ownerDb,extra):ownerDb,before=resolveScope(base,share),had=idSets(base);
  const was={node:new Set(before.nodeIds),edge:new Set(before.edgeIds),project:new Set(before.projectIds),item:new Set(before.itemIds),card:new Set(before.cardIds)};
  const drop=(k,r)=>{dropped.push({kind:k,id:r.id,...(r.localId?{localId:r.localId}:{})});return false};
  keep.edge=(keep.edge||[]).filter(e=>[e.from,e.to].every(v=>!had.node.has(v)||was.node.has(v))||drop('edge',e));
  for(let round=0;round<6;round++){
    const sc=resolveScope(withRecords(base,keep),share),inside={node:new Set(sc.nodeIds),edge:new Set(sc.edgeIds),project:new Set(sc.projectIds),item:new Set(sc.itemIds),card:new Set(sc.cardIds)};
    const widened=KIND_KEYS.some(k=>[...inside[k]].some(id=>had[k].has(id)&&!was[k].has(id)));
    let changed=false;
    for(const k of KIND_KEYS)keep[k]=(keep[k]||[]).filter(r=>(!widened&&inside[k].has(r.id))||(changed=true,drop(k,r)));
    if(!changed)break;
  }
  return {records:keep,dropped};
}

// The records a recipient's save adds to a share: new ones (not in what was stored before, not linked) that
// refer to the share's records and nothing private of theirs, plus ones marked sh.<share>.new-<id>.
//   node: in the share's chart.  edge: both ends are the share's (a node of theirs in the share's chart that an
//   edge joins to the share is promoted with it, when promote).  project: its entity is the share's.
//   item: every project tag is the share's.  card: its project and item are the share's (at least one), or it
//   has none and carries one of the share's labels.  A project, item or card of theirs that this save moves
//   into the share (it did not refer to it before) counts too, when promote.
// They are turned into the owner's ids and checked against the scope (additionsInScope); what the scope cannot
// hold stays the recipient's own (an explicitly marked one is refused instead).
// stored: the recipient's own data before this save. pending: their pending proposals for this share; known:
// all their proposals for it, so a stale copy that sends an added record again does not add it twice.
// -> {records (owner ids), taken:[{kind,id}] (to remove from the recipient's own data), map:{their id: owner id},
//     refused:[{kind,id,reason}], resent:[{proposal,kind,id (owner),rec}], joins:[proposal ids it builds on]}
// opened: the save is of an opened environment (openedProjection): every record that is not linked is new and
// meant for the share (there is nothing of the recipient's own there), and a new mind map card goes on the owner
// chart it was made on.
export function planAdditions(ownerDb,share,submitted,stored,{pending=[],known=[],members,promote=true,opened=false}={}){
  const out={records:emptyRecords(),taken:[],map:{},refused:[],resent:[],joins:[]};
  if(!share||share.revokedAt||!submitted||!ownerDb)return out;
  const pre=prefix(share.id),isS=id=>typeof id==='string'&&id.startsWith(pre),sChart=shareChartId(share.id);
  const marked=id=>isS(id)&&parseLinkedId(id).id.startsWith(NEW_PREFIX);
  const explicit=id=>marked(id)||(opened&&typeof id==='string'&&!/^(sh|cx)\./.test(id));
  const before=idSets(stored||{}),R=recordsWithChart(submitted);
  const proposed=new Map();
  for(const p of known)for(const k of KIND_KEYS)for(const r of p.records?.[k]||[])proposed.set(k+'|'+(r.localId||r.id),{p,k,r});
  const pendingRec=new Map();for(const p of pending)for(const k of KIND_KEYS)for(const r of p.records?.[k]||[])pendingRec.set(r.id,{p,k,r});
  // Never a linked copy (sh.) or a record of another environment shown combined with this one (cx., docs/combined.md).
  const fresh=(kind,id)=>explicit(id)||(typeof id==='string'&&!/^(sh|cx)\./.test(id)&&!before[kind].has(id));
  // A record sent again after it was proposed leaves the recipient's data; a pending one updates its proposal.
  const known1=(kind,x)=>{const hit=proposed.get(kind+'|'+x.rec.id);if(!hit)return false;
    out.taken.push({kind,id:x.rec.id});if(hit.p.status==='pending')out.resent.push({proposal:hit.p.id,kind,id:hit.r.id,rec:x.rec});return true};
  const batch=new Map(),promotable=new Map();
  const ofShare=ref=>(isS(ref)&&!explicit(ref))||batch.has(ref);
  for(const x of R.node){
    const id=x.rec.id;
    if(x.chart!==sChart&&!explicit(id))continue;
    if(fresh('node',id)){if(!known1('node',x))batch.set(id,{kind:'node',...x})}
    else if(promote&&x.chart===sChart&&!id.startsWith('sh.'))promotable.set(id,x);
  }
  for(const x of R.edge){
    const e=x.rec,ends=[e.from,e.to];
    if(!explicit(e.id)&&!ends.every(v=>ofShare(v)||promotable.has(v)))continue;
    if(!fresh('edge',e.id)||known1('edge',x))continue;
    for(const v of ends)if(promotable.has(v)&&!batch.has(v))batch.set(v,{kind:'node',...promotable.get(v),promoted:true});
    batch.set(e.id,{kind:'edge',...x});
  }
  // Which records refer to the share (ok: a reference to it).
  const refers={project:(p,ok)=>ok(p.entity),item:(i,ok)=>{const ps=Array.isArray(i.projects)?i.projects:[];return ps.length>0&&ps.every(ok)},
    card:(c,ok)=>{const refs=[c.project,c.item].filter(Boolean);return refs.length?refs.every(ok):(c.labels||[]).some(l=>isS(l))}};
  const prev=recordsWithChart(stored||{}),was=k=>new Map(prev[k].map(x=>[x.rec.id,x.rec])),wasOf={project:was('project'),item:was('item'),card:was('card')};
  const linkedRef=id=>isS(id)&&!explicit(id);
  for(const kind of ['project','item','card'])for(const x of R[kind]){
    const r=x.rec;if(!refers[kind](r,ofShare)&&!explicit(r.id))continue;
    if(fresh(kind,r.id)){if(!known1(kind,x))batch.set(r.id,{kind,...x});continue}
    // One of theirs that this save moves into the share (the app makes a card first and picks its project after).
    const before1=promote&&!/^(sh|cx)\./.test(r.id)?wasOf[kind].get(r.id):null;
    if(before1&&!refers[kind](before1,linkedRef))batch.set(r.id,{kind,...x,promoted:true});
  }
  if(!batch.size)return out;
  // Owner ids: the recipient's own id when it is free (sh.<share>.new-<id> gives <id>), else a new one.
  const taken=new Set([...everyId(ownerDb),...pendingRec.keys()]);
  for(const [lid,b] of batch){let oid=marked(lid)?parseLinkedId(lid).id.slice(NEW_PREFIX.length):lid;if(!/^[A-Za-z0-9_.:-]{1,200}$/.test(oid)||oid.startsWith('sh.')||taken.has(oid))oid=uid();taken.add(oid);b.oid=oid;out.map[lid]=oid}
  const joins=new Set();
  const toOwner=ref=>{
    if(typeof ref!=='string'||!ref)return '';
    if(batch.has(ref))return batch.get(ref).oid;
    if(isS(ref)&&!explicit(ref)){const id=parseLinkedId(ref).id;if(pendingRec.has(id))joins.add(pendingRec.get(id).p.id);return id}
    return null;
  };
  const sc=resolveScope(ownerDb,share),view=viewer(ownerDb,share,sc,members||shareMembers(share));
  const persons=new Set((ownerDb.charts||[]).flatMap(c=>c.nodes||[]).filter(n=>n.type==='person'&&sc.nodeIds.includes(n.id)).map(n=>n.id));
  const ownerLabels=new Set((ownerDb.devops?.labels||[]).map(l=>l.id));
  const str=(v,max)=>typeof v==='string'?v.slice(0,max):'',num=v=>Number.isFinite(v)?v:0,size=v=>Number.isFinite(v)&&v>0&&v<=5000;
  const day=v=>typeof v==='string'&&DATE.test(v)?v:'',pts=v=>Number.isFinite(v)&&v>=0&&v<=1000?v:null;
  // Where a new node goes in the owner's charts: the scope's chart, else the chart of a record it is joined to
  // by a new edge, else the owner's open chart.
  const chartIds=new Set((ownerDb.charts||[]).map(c=>c.id)),fallback=s=>chartIds.has(s)?s:chartIds.has(ownerDb.active)?ownerDb.active:ownerDb.charts?.[0]?.id||'';
  const nodeChart=new Map((ownerDb.charts||[]).flatMap(c=>(c.nodes||[]).map(n=>[n.id,c.id])));
  for(const {r} of pendingRec.values())if(r.chart)nodeChart.set(r.id,r.chart);
  const edgesIn=[...batch.values()].filter(b=>b.kind==='edge');
  for(let i=0;i<4;i++)for(const b of edgesIn){const a=toOwner(b.rec.from),z=toOwner(b.rec.to);if(a&&z){if(nodeChart.has(a)&&!nodeChart.has(z))nodeChart.set(z,nodeChart.get(a));if(nodeChart.has(z)&&!nodeChart.has(a))nodeChart.set(a,nodeChart.get(z))}}
  const recs=emptyRecords(),local=(b,lid)=>lid!==b.oid?{localId:lid}:{};
  for(const [lid,b] of batch){
    const x=b.rec,id=b.oid,bad=reason=>out.refused.push({kind:b.kind,id:lid,reason});
    if(b.kind==='node'){
      const on=opened?parseLinkedId(b.chart):null,made=on?.shareId===share.id&&chartIds.has(on.id)?on.id:'';
      const chart=share.scope?.chartId&&chartIds.has(share.scope.chartId)?share.scope.chartId:made||nodeChart.get(id)||fallback();
      if(!chart){bad('no-chart');continue}
      recs.node.push({id,name:str(x.name,160).trim()||'Untitled',type:NODE_TYPES.includes(x.type)?x.type:'entity',notes:str(x.notes,2000),x:num(x.x),y:num(x.y),...(size(x.w)?{w:x.w}:{}),...(size(x.h)?{h:x.h}:{}),chart,...local(b,lid)});
    }else if(b.kind==='edge'){
      const from=toOwner(x.from),to=toOwner(x.to);
      if(!from||!to||from===to){bad('invalid');continue}
      if(nodeChart.get(from)&&nodeChart.get(to)&&nodeChart.get(from)!==nodeChart.get(to)){bad('cross-chart');continue}
      const type=EDGE_TYPES.includes(x.type)?x.type:'ownership',p=String(x.percent??'').trim();
      recs.edge.push({id,from,to,type,percent:type==='group'||!FIELDS.edge.percent(p)||p===''?'':String(Number(p)),chart:nodeChart.get(from)||fallback(),...local(b,lid)});
    }else if(b.kind==='project'){
      const entity=toOwner(x.entity);if(entity===null){bad('private-reference');continue}
      recs.project.push({id,name:str(x.name,80).trim()||'Untitled project',color:typeof x.color==='string'&&COLOR.test(x.color)?x.color:'',entity,...local(b,lid)});
    }else if(b.kind==='item'){
      const projects=(Array.isArray(x.projects)?x.projects:[]).map(toOwner);if(projects.some(p=>p===null)){bad('private-reference');continue}
      const start=day(x.start),end=day(x.end),release=toOwner(x.release);
      recs.item.push({id,title:str(x.title,200).trim()||'Untitled',kind:ITEM_KINDS.includes(x.kind)?x.kind:start?'milestone':'feature',status:ITEM_STATUS.includes(x.status)?x.status:'planned',start,end:start&&end&&end>=start?end:'',
        priority:ITEM_PRIORITY.includes(x.priority)?x.priority:'',release:release||'',projects:[...new Set(projects.filter(Boolean))],owner:str(x.owner,120),link:str(x.link,500),notes:str(x.notes,4000),...local(b,lid)});
    }else{
      const project=toOwner(x.project),item=toOwner(x.item);if(project===null||item===null){bad('private-reference');continue}
      const assignees=[];
      for(const a of Array.isArray(x.assignees)?x.assignees:[]){
        if(!a||typeof a.node!=='string')continue;let node=null;
        if(memberEmail(a.node)){const e=lc(memberEmail(a.node));if(view.mem.has(e))node=view.byEmail.get(e)?.id||memberId(e)}
        else{const o=toOwner(a.node);if(o&&persons.has(o))node=o}
        const role=ROLES.includes(a.role)?a.role:'developer';if(node&&!assignees.some(y=>y.node===node&&y.role===role))assignees.push({node,role});
      }
      recs.card.push({id,title:str(x.title,200).trim()||'Untitled card',description:str(x.description,8000),column:COLUMNS.some(([k])=>k===x.column)?x.column:'requests',project,item,
        labels:[...new Set((x.labels||[]).map(l=>isS(l)?parseLinkedId(l).id:null).filter(l=>l&&ownerLabels.has(l)))],points:pts(x.points),actual:pts(x.actual),due:day(x.due),assignees:assignees.slice(0,20),
        checklist:(Array.isArray(x.checklist)?x.checklist:[]).filter(c=>c&&typeof c.text==='string').slice(0,200).map(c=>({id:typeof c.id==='string'?c.id:uid(),text:c.text.slice(0,300),done:!!c.done})),
        links:(Array.isArray(x.links)?x.links:[]).filter(l=>l&&typeof l.url==='string'&&l.url.trim()).slice(0,50).map(l=>({id:typeof l.id==='string'?l.id:uid(),kind:LINK_KINDS[l.kind]?l.kind:'url',url:l.url.slice(0,500)})),
        ...(Number.isInteger(x.number)?{localNumber:x.number}:{}),...local(b,lid)});
    }
  }
  // Only what the scope can hold once added (pending records of the share count as there).
  const extra=emptyRecords();for(const {k,r} of pendingRec.values())extra[k].push(r);
  const {records,dropped}=additionsInScope(ownerDb,share,recs,extra);
  for(const d of dropped){const lid=d.localId||d.id;if(explicit(lid))out.refused.push({kind:d.kind,id:lid,reason:'out-of-scope'})}
  const kept=new Set(KIND_KEYS.flatMap(k=>records[k].map(r=>k+'|'+(r.localId||r.id))));
  for(const [lid,b] of batch)if(kept.has(b.kind+'|'+lid))out.taken.push({kind:b.kind,id:lid});else delete out.map[lid];
  // Refused explicit records leave the recipient's data too (their sh. ids are never stored).
  out.records=records;out.joins=[...joins].filter(id=>KIND_KEYS.some(k=>records[k].length));
  return out;
}

// The recipient's own data without the records an addition took, with their references to them pointing at
// the linked copies (sh.<share>.<owner id>) instead.
export function takeAdditions(db,shareId,plan){
  const out=clone(db);if(!plan?.taken?.length)return out;
  const gone=new Map(plan.taken.map(t=>[t.kind+'|'+t.id,1])),is=(k,id)=>gone.has(k+'|'+id);
  const ref=id=>typeof id==='string'&&plan.map[id]?linkedId(shareId,plan.map[id]):id;
  for(const c of out.charts||[]){c.nodes=(c.nodes||[]).filter(n=>!is('node',n.id));c.edges=(c.edges||[]).filter(e=>!is('edge',e.id)).map(e=>({...e,from:ref(e.from),to:ref(e.to)}))}
  out.projects=(out.projects||[]).filter(p=>!is('project',p.id)).map(p=>({...p,entity:ref(p.entity)}));
  out.timeline=(out.timeline||[]).filter(i=>!is('item',i.id)).map(i=>({...i,...(Array.isArray(i.projects)?{projects:i.projects.map(ref)}:{}),release:ref(i.release)}));
  if(out.devops?.cards)out.devops.cards=out.devops.cards.filter(c=>!is('card',c.id)).map(c=>({...c,project:ref(c.project),item:ref(c.item),...(Array.isArray(c.assignees)?{assignees:c.assignees.map(a=>({...a,node:ref(a.node)}))}:{})}));
  return out;
}

// Approving (or a direct addition): the records land in the owner's data. Ids that are taken by now get new
// ones; cards get the owner's next numbers. -> {db, map:{proposed id: owner id}}
export function applyAdditions(ownerDb,records){
  const db=withRecords(ownerDb,{}),ids=everyId(db),map={},now=new Date().toISOString();
  for(const k of KIND_KEYS)for(const r of records?.[k]||[]){map[r.id]=ids.has(r.id)?uid():r.id;ids.add(map[r.id])}
  const m=id=>typeof id==='string'&&map[id]?map[id]:id;
  const ren={node:(records?.node||[]).map(r=>({...r,id:m(r.id)})),edge:(records?.edge||[]).map(r=>({...r,id:m(r.id),from:m(r.from),to:m(r.to)})),
    project:(records?.project||[]).map(r=>({...r,id:m(r.id),entity:m(r.entity)})),item:(records?.item||[]).map(r=>({...r,id:m(r.id),release:m(r.release),projects:(r.projects||[]).map(m)})),
    card:(records?.card||[]).map(r=>({...r,id:m(r.id),project:m(r.project),item:m(r.item)}))};
  const labels=new Set((db.devops.labels||[]).map(l=>l.id));
  let next=Math.max(1,Number.isInteger(db.devops.nextNumber)?db.devops.nextNumber:1,...db.devops.cards.map(c=>Number.isInteger(c.number)?c.number+1:1));
  ren.card=ren.card.map(c=>({...c,number:next++,labels:(c.labels||[]).filter(l=>labels.has(l)),created:now,updated:now,moved:now}));
  const out=withRecords(db,ren);out.devops.nextNumber=next;
  return {db:out,map};
}

// A recipient's edit of one of their pending records (extractRecipientChanges().pending, or a stale copy sent
// again): the same fields and rules as an edit of a linked record, applied to the proposal.
// -> the proposal with its record changed, or null when nothing changed or it is not allowed.
export function applyPendingEdit(ownerDb,share,proposal,edit,user,{members}={}){
  if(!proposal||proposal.status!=='pending'||proposal.shareId!==share?.id)return null;
  const rec=(proposal.records?.[edit.kind]||[]).find(r=>r.id===edit.id);if(!rec)return null;
  const fields={};for(const f of Object.keys(FIELDS[edit.kind]||{}))if(edit.fields&&f in edit.fields)fields[f]=edit.fields[f];
  if(!Object.keys(fields).length)return null;
  const cand=withRecords(ownerDb,proposal.records),next=clone(proposal),target=next.records[edit.kind].find(x=>x.id===edit.id);
  // Field by field: a value the share cannot carry (e.g. someone it does not show) is skipped, not the rest.
  let changed=false;
  for(const [f,v] of Object.entries(fields)){
    const r=applyRecipientEdit(cand,share,{kind:edit.kind,id:edit.id,fields:{[f]:v}},user,{members});
    if(r.ok)for(const {field,value} of r.ownerDbPatch){target[field]=clone(value);changed=true}
  }
  if(edit.kind==='item'&&target.end&&(!target.start||target.end<target.start))target.end='';
  if(!changed)return null;
  next.updatedAt=new Date().toISOString();
  return next;
}

// What a proposal adds, for the owner's Approve / Deny row: [{kind, id, title, detail?}].
export function proposalPreview(ownerDb,proposal){
  const names=new Map((ownerDb?.charts||[]).flatMap(c=>c.nodes||[]).map(n=>[n.id,n.name]));
  for(const n of proposal?.records?.node||[])names.set(n.id,n.name);
  const projects=new Map([...(ownerDb?.projects||[]),...(proposal?.records?.project||[])].map(p=>[p.id,p.name]));
  const out=[];const r=proposal?.records||{};
  for(const n of r.node||[])out.push({kind:'node',id:n.id,title:n.name,detail:n.type});
  for(const e of r.edge||[])out.push({kind:'edge',id:e.id,title:`${names.get(e.from)||'?'} → ${names.get(e.to)||'?'}`,detail:e.type==='group'?'groups':e.percent?`${e.percent}% ownership`:'ownership'});
  for(const p of r.project||[])out.push({kind:'project',id:p.id,title:p.name,...(names.get(p.entity)?{detail:`under ${names.get(p.entity)}`}:{})});
  for(const i of r.item||[])out.push({kind:'item',id:i.id,title:i.title,detail:[i.kind,i.start].filter(Boolean).join(' · ')});
  for(const c of r.card||[])out.push({kind:'card',id:c.id,title:c.title,...(projects.get(c.project)?{detail:projects.get(c.project)}:{})});
  return out;
}
// The owner decides. Approving checks the records still fit the share. -> {ok, proposal, db?, map?} | {ok:false, error}
export function decideProposal(ownerDb,share,proposal,user,approve){
  if(!proposal||proposal.status!=='pending')return {ok:false,error:'decided'};
  if(!share||share.id!==proposal.shareId||!user?.email||!same(share.ownerEmail,user.email))return {ok:false,error:'forbidden'};
  const decided={...proposal,status:approve?'approved':'denied',decidedAt:new Date().toISOString(),decidedBy:lc(user.email)};
  if(!approve)return {ok:true,proposal:decided};
  if(share.revokedAt)return {ok:false,error:'revoked'};
  const {dropped}=additionsInScope(ownerDb,share,proposal.records);
  if(dropped.length)return {ok:false,error:'out-of-scope',dropped};
  const {db,map}=applyAdditions(ownerDb,proposal.records);
  return {ok:true,proposal:{...decided,map},db,map};
}
