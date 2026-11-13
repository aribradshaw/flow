// Sharing in the browser (rules and enforcement live on the server: lib/sharing-core.mjs, docs/sharing.md).
//
//   linkOf(x)            {shareId, id, permission, ownerEmail, stub, readOnly} for a linked record, else null.
//                        Linked records carry ids sh.<shareId>.<owner id>; nodes and edges also keep `linked`.
//   canEdit(x)/canComment(x)   what the share lets this user do with a linked record.
//   openShareDialog({nodeId, scope, from})   the owner's Share dialog: what (person and everything below,
//                        one card, a project, a label or the whole environment), who, permission, and a live
//                        preview of exactly what the recipient will see.
//   historyHtml / loadHistory / postComment   the History and comment box of a linked record.
//   sharedBadge / sharedChip / sharedNote / linkedTip   how the timeline and DevOps mark linked records
//                        (the chart draws its own .sh-badge on linked boxes), and who owns them.
//   locked(x) / lockedMsg(x)   a linked record the user may not change (view, comment, a stub).
//   shareOf(x) / members(x)    the share a linked record came from; its members (owner and recipients).
//   clashHtml / clashClick     the "Changed by X just now — see previous" notice on a field whose value
//                        someone else overwrote (store.conflicts from sync.js), with a one-click restore.
import {store} from './store.js';
import {esc,hint} from './ui.js';
import {icon} from './icons.js';
import {detailModal} from './modal.js';

const RANK={view:0,comment:1,edit:2};
export const PERMS=[['view','Can view'],['comment','Can comment'],['edit','Can edit']];
export function linkOf(x){
  const m=/^sh\.([A-Za-z0-9_-]+)\.(.+)$/.exec(String(x?.id||''));if(!m)return null;
  const meta=(store.db.shares||[]).find(s=>s.id===m[1])||{},l=x.linked||{};
  return {shareId:m[1],id:m[2],permission:l.permission||meta.permission||'view',ownerEmail:meta.ownerEmail||'',ownerEnvName:meta.ownerEnvName||'',stub:!!l.stub,readOnly:!!(l.readOnly||l.stub)};
}
export const canEdit=x=>{const l=linkOf(x);return !l||(!l.readOnly&&RANK[l.permission]>=2)};
export const canComment=x=>{const l=linkOf(x);return !!l&&!l.readOnly&&RANK[l.permission]>=1};
export const locked=x=>!canEdit(x);
const PERM_WORDS={view:'view only',comment:'can comment',edit:'can edit'};
// Timeline items and DevOps cards: who shared it and what this user may do with it.
export const linkedTip=l=>l.stub?sharedTip(l):`Shared with you${l.ownerEmail?' by '+l.ownerEmail:''} · ${PERM_WORDS[l.permission]||l.permission}. ${l.permission==='edit'?'Fields the owner allows are editable; the rest are locked.':l.permission==='comment'?'You can comment; its fields are locked.':'Its fields are locked.'}`;
export const lockedMsg=x=>{const l=linkOf(x);return !l?'':l.stub?'Co-owner cards are read-only.':`Shared with you${l.ownerEmail?' by '+l.ownerEmail:''} · ${PERM_WORDS[l.permission]||l.permission}. Ask the owner for edit access.`};
// The link badge of the chart's linked boxes, for timeline items and DevOps cards. inline: in a row.
export function sharedBadge(x,{inline=false,tip=true}={}){
  const l=linkOf(x);if(!l)return '';
  const label=l.stub?'Co-owner stub, read-only':`Shared with you${l.ownerEmail?' by '+l.ownerEmail:''}`;
  return `<span class="sh-badge${inline?' in':''}${l.stub?' stub':''}" role="img" aria-label="${esc(label)}"${tip?` data-tip="${esc(linkedTip(l))}"`:''}>${icon(l.stub?'ban':'link',inline?9:11)}</span>`;
}
export const sharedChip=x=>{const l=linkOf(x);return l?`<span class="sh-chip${l.stub?' stub':''}" data-tip="${esc(linkedTip(l))}">${icon(l.stub?'ban':'link',11)}${l.stub?'Co-owner':'Shared'}</span>`:''};
export const sharedNote=x=>{const l=linkOf(x);return l?`<p class="sh-note">${esc(linkedTip(l))}</p>`:''};
// Two records from the same place: both one's own, or both from the same share.
export const sameSource=(x,y)=>(linkOf(x)?.shareId||'')===(linkOf(y)?.shareId||'');
export const shareOf=x=>{const l=linkOf(x);return l&&(store.db.shares||[]).find(s=>s.id===l.shareId)||null};
// Members of the share a linked record came from: [{id ('@email' or a linked person card), name, image?, owner}].
export const members=x=>shareOf(x)?.members||[];
export const sharedTip=l=>l.stub?`Co-owner of a card shared with you${l.ownerEmail?' by '+l.ownerEmail:''}. Name only; read-only.`:`Shared with you${l.ownerEmail?' by '+l.ownerEmail:''} · ${PERMS.find(p=>p[0]===l.permission)?.[1].toLowerCase()||l.permission}. Your layout is your own.`;

const call=async(method,path,body)=>{
  const r=await fetch(path,{method,cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body&&JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d;
};
export const api={
  preview:(env,scope)=>call('POST','/api/shares/preview',{env,scope}),
  create:body=>call('POST','/api/shares',body),
  list:env=>call('GET','/api/shares?env='+encodeURIComponent(env)),
  incoming:()=>call('GET','/api/shares/incoming'),
  setPermission:(id,permission)=>call('PATCH','/api/shares/'+id,{permission}),
  revoke:id=>call('DELETE','/api/shares/'+id),
  attach:(id,env)=>call('POST',`/api/shares/${id}/attach`,{env}),
  detach:(id,env)=>call('DELETE',`/api/shares/${id}/attach?env=${encodeURIComponent(env)}`),
  request:(id,body)=>call('POST',`/api/shares/${id}/requests`,body),
  requests:()=>call('GET','/api/share-requests'),
  decide:(id,approve,permission)=>call('POST','/api/share-requests/'+id,{approve,permission}),
  comment:(id,kind,recordId,comment)=>call('POST',`/api/shares/${id}/comments`,{kind,id:recordId,comment}),
  history:(id,kind,recordId)=>call('GET',`/api/shares/${id}/history?kind=${kind}&id=${encodeURIComponent(recordId)}`),
};

// ---- History + comments of a linked record (inspector) ----
const when=t=>{try{return new Date(t).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}catch{return t}};
export function historyHtml(x,kind){
  const l=linkOf(x);if(!l||l.stub)return '';
  return `<label>Shared${l.ownerEmail?` by ${esc(l.ownerEmail)}`:''}</label>
    ${canComment(x)?`<div class="sh-cmt"><textarea data-sh-comment rows="2" maxlength="4000" placeholder="Comment for ${esc(l.ownerEmail||'the owner')}"></textarea><button type="button" class="txt" data-i="shComment" data-kind="${kind}">Comment</button></div>`:''}
    <ul class="sh-hist" data-sh-hist="${esc(x.id)}" data-kind="${kind}"><li class="acct-muted">Loading history…</li></ul>`;
}
export async function loadHistory(root){
  const box=root.querySelector('[data-sh-hist]');if(!box)return;
  const l=linkOf({id:box.dataset.shHist});
  try{
    const {history}=await api.history(l.shareId,box.dataset.kind,l.id);
    box.innerHTML=history.map(e=>`<li><span class="sh-who">${esc(e.by)}</span> <span class="sh-at">${esc(when(e.at))}</span><div>${e.field==='comment'?esc(e.new):`${esc(e.field)}: <s>${esc(fmt(e.old))}</s> → ${esc(fmt(e.new))}`}</div></li>`).join('')||'<li class="acct-muted">No changes or comments yet</li>';
  }catch{box.innerHTML='<li class="acct-muted">History unavailable</li>'}
}
const fmt=v=>v===null||v===undefined||v===''?'—':typeof v==='string'?v.slice(0,120):JSON.stringify(v).slice(0,120);
export async function postComment(root,x){
  const t=root.querySelector('[data-sh-comment]'),l=linkOf(x),kind=root.querySelector('[data-sh-hist]')?.dataset.kind;
  if(!t?.value.trim()||!l)return;
  await api.comment(l.shareId,kind,l.id,t.value.trim());t.value='';await loadHistory(root);
}

// ---- The owner's Share dialog ----
const envId=()=>store.db.environment?.id;
function scopeOptions(nodeId){
  const db=store.db,nodes=db.charts.flatMap(c=>c.nodes),n=nodes.find(x=>x.id===nodeId),out=[];
  if(n&&!linkOf(n)){out.push([JSON.stringify({kind:'person',nodeId:n.id}),`${n.name} and everything below`]);out.push([JSON.stringify({kind:'nodes',nodeIds:[n.id]}),`Only ${n.name}`])}
  for(const p of db.projects||[])if(!linkOf(p))out.push([JSON.stringify({kind:'project',projectId:p.id}),`Project: ${p.name}`]);
  for(const l of db.devops?.labels||[])if(!linkOf(l))out.push([JSON.stringify({kind:'label',label:l.id}),`Label: ${l.name}`]);
  out.push([JSON.stringify({kind:'environment'}),`The whole environment (${db.environment?.name||'workspace'})`]);
  return out;
}
const list=(title,items,empty)=>`<h4 class="sh-pv-h">${title} <em>${items.length}</em></h4>${items.length?`<ul class="sh-pv-l">${items.join('')}</ul>`:`<p class="acct-muted">${empty}</p>`}`;
function previewHtml(p){
  return list('Cards',p.nodes.map(n=>`<li>${esc(n.name)} <em>${esc(n.type)}</em></li>`),'No cards')
    +list('Co-owners, name only',p.stubs.map(t=>`<li>${icon('ban',11)} ${esc(t.name)} <em>${t.edge==='group'?'groups':t.percent?esc(t.percent)+'% of':'owns'} ${esc(t.owns)}</em></li>`),'None')
    +list('Projects',p.projects.map(x=>`<li><i class="sh-dot" style="background:${esc(x.color||'#ccc')}"></i>${esc(x.name)}</li>`),'None')
    +`<p class="acct-muted">${p.items.length} timeline item${p.items.length===1?'':'s'} · ${p.cards.length} DevOps card${p.cards.length===1?'':'s'}. Nothing else in this environment is shared.</p>`;
}
export function openShareDialog({nodeId=null,scope=null,from=null}={}){
  const opts=scopeOptions(nodeId),first=scope?JSON.stringify(scope):opts[0][0];
  if(scope&&!opts.some(o=>o[0]===first))opts.unshift([first,'Selected']);
  let seq=0,shown=null;
  const m=detailModal({cls:'share-modal',label:'Share',from,events:{
    change:e=>{if(e.target.id==='shScope')refresh()},
    click:e=>{if(e.target.closest('[data-sh-close]'))m.close()},
    submit:async e=>{
      e.preventDefault();const b=m.body,msg=b.querySelector('[data-sh-msg]'),btn=b.querySelector('[type=submit]');
      msg.className='sh-msg';msg.textContent='';btn.disabled=true;
      try{
        const d=await api.create({env:envId(),scope:JSON.parse(b.querySelector('#shScope').value),recipientEmail:b.querySelector('#shEmail').value.trim(),permission:b.querySelector('#shPerm').value});
        msg.className='sh-msg ok';msg.textContent=`${d.existing?'Updated the share with':'Shared with'} ${d.share.recipientEmail} (${d.share.permission}). They add it to their workspace from Settings › Sharing.`;
      }catch(err){msg.className='sh-msg err';msg.textContent=err.message}
      finally{btn.disabled=false}
    }}});
  m.body.innerHTML=`<div class="ihead cd-h"><span class="k">${icon('link')}</span><strong>Share</strong><span class="sp"></span><button type="button" class="ib" data-sh-close aria-label="Close">${icon('x')}</button></div>
    <form class="ibody sh-form" autocomplete="off">
      <label for="shScope">What</label><select id="shScope">${opts.map(([v,t])=>`<option value="${esc(v)}"${v===first?' selected':''}>${esc(t)}</option>`).join('')}</select>
      <div class="sh-two"><div><label for="shEmail">With <em>their OneProfileID email</em></label><input id="shEmail" type="email" required placeholder="name@example.com"></div>
        <div><label for="shPerm">Permission</label><select id="shPerm">${PERMS.map(([v,t])=>`<option value="${v}"${v==='view'?' selected':''}>${t}</option>`).join('')}</select></div></div>
      <label>They will see exactly this</label><div class="sh-pv" data-sh-pv aria-live="polite"><p class="acct-muted">Loading…</p></div>
      <p class="sh-msg" data-sh-msg role="status"></p>
      <div class="ask-b"><button type="button" class="txt" data-sh-close>Close</button><button type="submit" class="txt primary">Share</button></div>
    </form>`;
  async function refresh(){
    const n=++seq,box=m.body.querySelector('[data-sh-pv]'),v=m.body.querySelector('#shScope').value;
    if(shown===v)return;
    try{const d=await api.preview(envId(),JSON.parse(v));if(n!==seq)return;shown=v;box.innerHTML=previewHtml(d.preview)}
    catch(e){if(n===seq)box.innerHTML=`<p class="sh-msg err">${esc(e.message==='Not found'?'Only the owner of this environment can share it. Save it to the server first.':e.message)}</p>`}
  }
  refresh();setTimeout(()=>m.body.querySelector('#shEmail')?.focus(),50);
  return m;
}

// ---- Settings › Sharing ----
export async function sharingPane(currentEnvId,ownEnvs){
  const [mine,incoming,reqs]=await Promise.all([api.list(currentEnvId).catch(()=>null),api.incoming().catch(()=>({shares:[]})),api.requests().catch(()=>({requests:[],mine:[]}))]);
  const permSel=(attr,id,cur,max='edit')=>`<select ${attr}="${esc(id)}" aria-label="Permission">${PERMS.filter(([v])=>RANK[v]<=RANK[max]).map(([v,t])=>`<option value="${v}"${v===cur?' selected':''}>${t}</option>`).join('')}</select>`;
  const sec=(title,tip='',action='')=>`<div class="acct-sec"><h3 class="acct-sub">${esc(title)}</h3>${tip?hint(tip,title):''}${action?`<span class="acct-sec-a">${action}</span>`:''}</div>`;
  const by=mine?`${sec(`Shared by you from ${store.db.environment?.name||'this environment'}`,'Select a card on a mind map and choose Share in its panel, or use Share something to pick what to share.','<button type="button" class="txt" id="shNew" data-sh-new>Share something…</button>')}
    <ul class="env-list">${mine.shares.map(s=>`<li><span class="env-n">${esc(s.recipientEmail)}<em class="sh-sub">${esc(s.scopeLabel)}</em></span>${permSel('data-sh-perm',s.id,s.permission)}<button type="button" class="txt" data-sh-revoke="${esc(s.id)}" data-who="${esc(s.recipientEmail)}">Revoke</button></li>`).join('')||'<li class="acct-muted">Not shared with anyone</li>'}</ul>`:'';
  const pending=reqs.requests||[];
  const asks=pending.length?`${sec('Requests to share')}<ul class="env-list">${pending.map(r=>`<li><span class="env-n">${esc(r.requestedBy)} asks to share with ${esc(r.toEmail)}${r.note?`<em class="sh-sub">${esc(r.note)}</em>`:''}</span>${permSel('data-sh-req-perm',r.id,r.permission,r.permission)}<button type="button" class="txt primary" data-sh-approve="${esc(r.id)}">Approve</button><button type="button" class="txt" data-sh-deny="${esc(r.id)}">Deny</button></li>`).join('')}</ul>`:'';
  const own=new Map(ownEnvs.map(e=>[e.id,e.name]));
  const withMe=`${sec('Shared with you','Add a share to one of your environments: its cards appear there as linked boxes with your own layout. Co-owners show as read-only name stubs.')}
    <ul class="env-list sh-in">${incoming.shares.map(s=>`<li><div class="sh-in-h"><span class="env-n">${esc(s.scopeLabel)}<em class="sh-sub">from ${esc(s.ownerEmail)} · ${esc(s.ownerEnvName||'')} · ${esc(PERMS.find(p=>p[0]===s.permission)?.[1]||s.permission)}</em></span>
        ${s.envs.includes(currentEnvId)?`<button type="button" class="txt" data-sh-detach="${esc(s.id)}">Remove from this environment</button>`:`<button type="button" class="txt primary" data-sh-attach="${esc(s.id)}">Add to ${esc(own.get(currentEnvId)||'this environment')}</button>`}</div>
        ${s.envs.filter(e=>e!==currentEnvId).length?`<span class="acct-muted">Also in: ${s.envs.filter(e=>e!==currentEnvId).map(e=>esc(own.get(e)||e)).join(', ')}</span>`:''}
        <form class="env-row" data-sh-ask="${esc(s.id)}"><input type="email" required placeholder="Ask ${esc(s.ownerEmail)} to share it with…" aria-label="Email to ask the owner to share with"><button type="submit" class="txt">Ask</button></form></li>`).join('')||'<li class="acct-muted">Nothing is shared with you yet</li>'}</ul>`;
  const sent=(reqs.mine||[]).filter(r=>r.status==='pending');
  return by+asks+withMe+(sent.length?`<p class="acct-muted">Waiting for the owner: ${sent.map(r=>esc(r.toEmail)).join(', ')}</p>`:'')+'<p class="acct-err" data-sh-err hidden></p>';
}

// ---- Conflicts (docs/sharing.md): last write wins; the person who lost sees it on the field ----
// store.conflicts: [{kind, id, field, by, at, previous, value}] from the server (sync.js), for this user.
const SEEN='flygon-flow-conflicts-seen',same=(a,b)=>JSON.stringify(a===undefined||a===''?null:a)===JSON.stringify(b===undefined||b===''?null:b);
let seen;try{seen=new Set(JSON.parse(localStorage.getItem(SEEN))||[])}catch{seen=new Set()}
const ckey=c=>[c.id,c.field,c.at].join('|');
const forget=c=>{seen.add(ckey(c));try{localStorage.setItem(SEEN,JSON.stringify([...seen].slice(-300)))}catch{}};
// The newest conflict on x.field that still shows the value that replaced this user's.
export function clashOf(x,field){
  if(!x)return null;
  return (store.conflicts||[]).filter(c=>c.id===x.id&&c.field===field&&!seen.has(ckey(c))&&same(x[field],c.value)).sort((a,b)=>b.at.localeCompare(a.at))[0]||null;
}
const ago=t=>{const s=(Date.now()-Date.parse(t))/1000;return s<90?'just now':s<3600?`${Math.round(s/60)} min ago`:s<86400?`${Math.round(s/3600)} h ago`:when(t)};
const shown=v=>v===null||v===undefined||v===''||(Array.isArray(v)&&!v.length)?'empty':typeof v==='string'?v.length>200?v.slice(0,200)+'…':v:Array.isArray(v)?v.map(x=>x?.text??x?.url??x?.name??x?.node??x).join(', '):String(v);
// show(value) -> text for the previous value (names for ids). Restore is offered when the user may edit x.
export function clashHtml(x,field,{show=shown}={}){
  const c=clashOf(x,field);if(!c)return '';
  return `<div class="sh-clash" role="status">${icon('alert',12)}<span>Changed by <b>${esc(c.by)}</b> ${esc(ago(c.at))} — <button type="button" class="sh-lnk" data-clash-see="${esc(field)}" aria-expanded="false">see previous</button></span>
    <div class="sh-clash-prev" hidden><span>Before: <s>${esc(String(show(c.previous)||'empty'))}</s></span>${canEdit(x)?`<button type="button" class="txt" data-clash-restore="${esc(field)}">Restore</button>`:''}<button type="button" class="txt" data-clash-dismiss="${esc(field)}">Dismiss</button></div></div>`;
}
// A click in a panel: true when it was one of the notice's buttons. apply(field, value) restores (an
// ordinary edit, so the share's permission applies); rerender() redraws after a dismiss.
export function clashClick(b,x,apply,rerender){
  const f=b?.dataset.clashSee||b?.dataset.clashRestore||b?.dataset.clashDismiss;if(!f)return false;
  if(b.dataset.clashSee){const box=b.closest('.sh-clash')?.querySelector('.sh-clash-prev');if(box){box.hidden=!box.hidden;b.setAttribute('aria-expanded',String(!box.hidden))}return true}
  const c=clashOf(x,f);if(!c)return true;
  forget(c);
  if(b.dataset.clashRestore&&canEdit(x))apply(f,structuredClone(c.previous));else rerender();
  return true;
}
