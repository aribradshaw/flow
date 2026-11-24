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
//   Additions (share.adds): a record the recipient added that waits for the owner is linked with pending
//                        (linkOf(x).pending) and marked "Pending approval"; decisionNotice() says once when
//                        the owner approved or denied some. The owner sets "Recipients can add" per edit share
//                        and decides in Settings › Sharing.
import {store} from './store.js';
import {esc,hint} from './ui.js';
import {icon} from './icons.js';
import {detailModal} from './modal.js';
import {parseForeign} from './combined-core.js';
import {envBadge} from './combined.js';
import {additionSentence,recordWords,addsHelp,summaryWords,plural} from './share-words.js';

const RANK={view:0,comment:1,edit:2};
export const PERMS=[['view','Can view'],['comment','Can comment'],['edit','Can edit']];
// Records of another environment shown combined with this one (combined-core.js, ids cx.<env>.<id>) are
// linked too: foreign:true, env and envName say where they live. A shared record placed in that environment
// keeps its share's permission (innerShare: its share id there).
const SH=/^sh\.([A-Za-z0-9_-]+)\.(.+)$/;
function foreignLink(x,f){
  const meta=(store.db.combined||[]).find(m=>m.env===f.env)||{},inner=SH.exec(f.id),sm=inner&&(meta.shares||[]).find(s=>s.id===inner[1]);
  return {shareId:inner?`cx.${f.env}.sh.${inner[1]}`:`cx.${f.env}`,id:f.id,foreign:true,env:f.env,envName:meta.name||'another environment',innerShare:inner?inner[1]:'',
    permission:inner?(sm?.permission||'view'):'edit',ownerEmail:inner?(sm?.ownerEmail||''):'',ownerEnvName:meta.name||'',stub:false,readOnly:false};
}
export function linkOf(x){
  const f=parseForeign(x?.id);if(f)return foreignLink(x,f);
  const m=SH.exec(String(x?.id||''));if(!m)return null;
  const meta=(store.db.shares||[]).find(s=>s.id===m[1])||{},l=x.linked||{};
  return {shareId:m[1],id:m[2],permission:l.permission||meta.permission||'view',ownerEmail:meta.ownerEmail||'',ownerEnvName:meta.ownerEnvName||'',stub:!!l.stub,readOnly:!!(l.readOnly||l.stub),
    pending:!!(l.pending||meta.pending?.includes(x.id))};
}
// What a share lets its recipient add: 'off', 'approve' (the owner approves each addition) or 'direct'.
export const ADDS=[['off','Off'],['approve','Needs your approval'],['direct','Allowed']];
const PENDING_TIP=l=>`Pending approval: you added this to ${l.ownerEmail||'the owner'}’s environment. It is theirs once they approve it; if they deny it, it goes.`;
export const canEdit=x=>{const l=linkOf(x);return !l||(!l.readOnly&&RANK[l.permission]>=2)};
export const canComment=x=>{const l=linkOf(x);return !!l&&!l.foreign&&!l.readOnly&&RANK[l.permission]>=1};
export const locked=x=>!canEdit(x);
const PERM_WORDS={view:'view only',comment:'can comment',edit:'can edit'};
// Timeline items and DevOps cards: who shared it and what this user may do with it.
const foreignTip=l=>`From ${l.envName}, shown combined with this environment. ${l.innerShare?`Shared with you there${l.ownerEmail?' by '+l.ownerEmail:''} · ${PERM_WORDS[l.permission]||l.permission}. `:''}Edits go back to ${l.envName}; open it to delete, add or re-file.`;
export const linkedTip=l=>l.foreign?foreignTip(l):l.pending?PENDING_TIP(l):l.stub?sharedTip(l):`Shared with you${l.ownerEmail?' by '+l.ownerEmail:''} · ${PERM_WORDS[l.permission]||l.permission}. ${l.permission==='edit'?'Fields the owner allows are editable; the rest are locked.':l.permission==='comment'?'You can comment; its fields are locked.':'Its fields are locked.'}`;
export const lockedMsg=x=>{const l=linkOf(x);return !l?'':l.foreign&&!l.innerShare?`This is in ${l.envName}. Open it there to change that.`:l.stub?'Co-owner cards are read-only.':`Shared with you${l.ownerEmail?' by '+l.ownerEmail:''} · ${PERM_WORDS[l.permission]||l.permission}. Ask the owner for edit access.`};
// The link badge of the chart's linked boxes, for timeline items and DevOps cards. inline: in a row.
// Where a record that is not this environment's own belongs, for a refusal (delete, duplicate, re-file).
export const ownerMsg=(x,what='It')=>{const l=linkOf(x);return l?.foreign?`${what} is in ${l.envName}. Open ${l.envName} to delete, add or re-file it.`:`${what} belongs to its owner. Remove the share in Settings › Sharing.`};
export function sharedBadge(x,{inline=false,tip=true}={}){
  const l=linkOf(x);if(!l)return '';
  if(l.foreign)return envBadge(x,{inline,tip:tip?linkedTip(l):'',shared:!!l.innerShare});
  const label=l.pending?'Pending approval':l.stub?'Co-owner stub, read-only':`Shared with you${l.ownerEmail?' by '+l.ownerEmail:''}`;
  return `<span class="sh-badge${inline?' in':''}${l.stub?' stub':''}${l.pending?' pending':''}" role="img" aria-label="${esc(label)}"${tip?` data-tip="${esc(linkedTip(l))}"`:''}>${icon(l.pending?'clock':l.stub?'ban':'link',inline?9:11)}</span>`;
}
export const sharedChip=x=>{const l=linkOf(x);return l?.foreign?envBadge(x,{tip:linkedTip(l),shared:!!l.innerShare}):l?`<span class="sh-chip${l.stub?' stub':''}${l.pending?' pending':''}" data-tip="${esc(linkedTip(l))}">${icon(l.pending?'clock':l.stub?'ban':'link',11)}${l.pending?'Pending approval':l.stub?'Co-owner':'Shared'}</span>`:''};
export const sharedNote=x=>{const l=linkOf(x);return l?`<p class="sh-note">${esc(linkedTip(l))}</p>`:''};
// Two records from the same place: both one's own, or both from the same share.
export const sameSource=(x,y)=>(linkOf(x)?.shareId||'')===(linkOf(y)?.shareId||'');
export const shareOf=x=>{const l=linkOf(x);if(!l)return null;
  if(l.foreign){const meta=(store.db.combined||[]).find(m=>m.env===l.env)||{};
    // A share placed in that environment, or that environment's own card: the recipients it is shared with.
    return l.innerShare?(meta.shares||[]).find(s=>s.id===l.innerShare)||null:{members:(meta.shareMembers||[]).filter(m=>m.cards?.includes(x.id))}}
  return (store.db.shares||[]).find(s=>s.id===l.shareId)||null};
// Members of the share a linked record came from: [{id ('@email' or a linked person card), name, image?, owner}].
export const members=x=>shareOf(x)?.members||[];
export const sharedTip=l=>l.pending?PENDING_TIP(l):l.stub?`Co-owner of a card shared with you${l.ownerEmail?' by '+l.ownerEmail:''}. Name only; read-only.`:`Shared with you${l.ownerEmail?' by '+l.ownerEmail:''} · ${PERMS.find(p=>p[0]===l.permission)?.[1].toLowerCase()||l.permission}. Your layout is your own.`;

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
  setAdds:(id,adds)=>call('PATCH','/api/shares/'+id,{adds}),
  proposals:()=>call('GET','/api/share-proposals'),
  decideProposal:(id,approve)=>call('POST','/api/share-proposals/'+id,{approve}),
  withdraw:id=>call('DELETE','/api/share-proposals/'+id),
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
  const l=linkOf(x);if(!l||l.stub||l.foreign)return '';
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
const more=(n,cap)=>n>cap?`<li class="acct-muted">…and ${n-cap} more</li>`:'';
function previewHtml(p){
  const cards=(p.cards||[]).slice(0,24).map(c=>`<li>#${esc(c.number)} ${esc(c.title)}</li>`);
  const tip=p.tip?`<p class="sh-pv-tip" role="status">${icon('alert',12)} ${esc(p.tip)}</p>`:'';
  return tip
    +list('Mind map',p.nodes.map(n=>`<li>${esc(n.name)} <em>${esc(n.type)}</em></li>`),'No mind map cards')
    +list('Co-owners, name only',p.stubs.map(t=>`<li>${icon('ban',11)} ${esc(t.name)} <em>${t.edge==='group'?'groups':t.percent?esc(t.percent)+'% of':'owns'} ${esc(t.owns)}</em></li>`),'None — stubs never bring DevOps cards')
    +list('Projects',p.projects.map(x=>`<li><i class="sh-dot" style="background:${esc(x.color||'#ccc')}"></i>${esc(x.name)}</li>`),'None linked by entity to the mind map cards above')
    +list('DevOps cards',cards.concat(more((p.cards||[]).length,24)),'None — pick “The whole environment” to share the full board')
    +`<p class="acct-muted">${p.items.length} timeline item${p.items.length===1?'':'s'} · ${p.cards.length} DevOps card${p.cards.length===1?'':'s'}. Nothing else in this environment is shared.</p>`;
}
const addsSelect=(attrs,cur='off',disabled=false)=>`<select ${attrs} aria-label="Recipients can add"${disabled?' disabled title="Only edit shares can add"':''}>${ADDS.map(([v,t])=>`<option value="${v}"${v===(cur||'off')?' selected':''}>${t}</option>`).join('')}</select>`;
export function openShareDialog({nodeId=null,scope=null,from=null,email='',permission='view',adds='off'}={}){
  const opts=scopeOptions(nodeId),first=scope?JSON.stringify(scope):opts[0][0];
  if(scope&&!opts.some(o=>o[0]===first))opts.unshift([first,scope.kind==='environment'?`The whole environment (${store.db.environment?.name||'workspace'})`:'Selected']);
  // Prefer the whole-environment option near the top when sharing from Settings (no card picked).
  if(!nodeId&&scope?.kind==='environment'){
    const i=opts.findIndex(([v])=>v===first);if(i>0){const [row]=opts.splice(i,1);opts.unshift(row)}
  }
  let seq=0,shown=null;
  const m=detailModal({cls:'share-modal',label:'Share',from,events:{
    change:e=>{if(e.target.id==='shScope')refresh();if(e.target.id==='shPerm')m.body.querySelector('[data-sh-adds-row]').hidden=e.target.value!=='edit'},
    click:e=>{if(e.target.closest('[data-sh-close]'))m.close()},
    submit:async e=>{
      e.preventDefault();const b=m.body,msg=b.querySelector('[data-sh-msg]'),btn=b.querySelector('[type=submit]');
      msg.className='sh-msg';msg.textContent='';btn.disabled=true;
      try{
        const perm=b.querySelector('#shPerm').value;
        const d=await api.create({env:envId(),scope:JSON.parse(b.querySelector('#shScope').value),recipientEmail:b.querySelector('#shEmail').value.trim(),permission:perm,adds:perm==='edit'?b.querySelector('#shAdds').value:'off'});
        const n=d.preview?.summary?.cards??d.preview?.cards?.length,adds=d.share.adds&&d.share.adds!=='off'?` · they can add (${ADDS.find(a=>a[0]===d.share.adds)[1].toLowerCase()})`:'';
        msg.className='sh-msg ok';msg.textContent=`${d.existing?'Updated the share with':'Shared with'} ${d.share.recipientEmail} (${d.share.permission}${adds})${n!=null?` · ${n} DevOps card${n===1?'':'s'}`:''}. They add it to their workspace from Settings › Sharing.`;
      }catch(err){msg.className='sh-msg err';msg.textContent=err.message}
      finally{btn.disabled=false}
    }}});
  m.body.innerHTML=`<div class="ihead cd-h"><span class="k">${icon('link')}</span><strong>Share</strong><span class="sp"></span><button type="button" class="ib" data-sh-close aria-label="Close">${icon('x')}</button></div>
    <form class="ibody sh-form" autocomplete="off">
      <p class="acct-muted sh-lead">DevOps cards follow only when their project is linked to a shared mind map card. To share the full board and map, choose <strong>The whole environment</strong>.</p>
      <label for="shScope">What</label><select id="shScope">${opts.map(([v,t])=>`<option value="${esc(v)}"${v===first?' selected':''}>${esc(t)}</option>`).join('')}</select>
      <div class="sh-two"><div><label for="shEmail">With <em>their OneProfileID email</em></label><input id="shEmail" type="email" required placeholder="name@example.com" value="${esc(email)}"></div>
        <div><label for="shPerm">Permission</label><select id="shPerm">${PERMS.map(([v,t])=>`<option value="${v}"${v===(permission||'view')?' selected':''}>${t}</option>`).join('')}</select></div></div>
      <div data-sh-adds-row${permission==='edit'?'':' hidden'}><label for="shAdds">Recipients can add <em>cards, items, projects and mind map cards inside what you share</em></label>${addsSelect('id="shAdds"',adds)}</div>
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
  refresh();setTimeout(()=>{(email?m.body.querySelector('#shScope'):m.body.querySelector('#shEmail'))?.focus()},50);
  return m;
}

// ---- Settings › Sharing ----
// Sections of cards: additions waiting for your approval, what you share (one card per person), requests
// to share, and what others share with you. Hooks used by account.js: data-sh-new / data-sh-env (open the
// Share dialog), data-sh-perm / data-sh-adds (selects), data-sh-widen, data-sh-revoke, data-sh-approve /
// data-sh-deny / data-sh-req-perm (requests), data-sh-prop-approve / data-sh-prop-deny (additions),
// data-sh-attach / data-sh-detach / data-sh-withdraw and form[data-sh-ask] (shared with you), data-sh-err.
const PANE_ADDS=[['off','Not allowed'],['approve','Needs your approval'],['direct','Allowed']];
const initial=s=>esc((String(s||'?').trim()[0]||'?').toUpperCase());
const avatar=s=>`<span class="sh-av" aria-hidden="true">${initial(s)}</span>`;
const shHead=(id,title,desc,action='')=>`<div class="sh-sec-h"><div class="sh-sec-t"><h3 class="sh-h" id="${id}">${esc(title)}</h3>${desc?`<p class="sh-d">${desc}</p>`:''}</div>${action?`<div class="sh-sec-a">${action}</div>`:''}</div>`;
export async function sharingPane(currentEnvId,ownEnvs){
  const [mine,incoming,reqs,props]=await Promise.all([api.list(currentEnvId).catch(()=>null),api.incoming().catch(()=>({shares:[]})),api.requests().catch(()=>({requests:[],mine:[]})),api.proposals().catch(()=>({proposals:[],mine:[]}))]);
  const permSel=(attr,id,cur,max='edit',lid='')=>`<select ${attr}="${esc(id)}"${lid?` id="${lid}"`:' aria-label="Permission"'}>${PERMS.filter(([v])=>RANK[v]<=RANK[max]).map(([v,t])=>`<option value="${v}"${v===cur?' selected':''}>${t}</option>`).join('')}</select>`;
  const envName=store.db.environment?.name||'this environment';
  // Shared by you: one card per person.
  const outCard=s=>{
    const k=esc(s.id),edit=s.permission==='edit',adds=edit?(s.adds||'off'):'off';
    const meta=[esc(s.scopeLabel),summaryWords(s.summary)&&esc(summaryWords(s.summary))].filter(Boolean).join(' · ');
    const widen=s.scope?.kind==='environment'?'':`<button type="button" class="sh-lnk" data-sh-widen="${k}" data-email="${esc(s.recipientEmail)}" data-perm="${esc(s.permission)}" title="Share the whole environment with them so they get every DevOps card and mind map card">Share the whole environment instead</button>`;
    return `<li class="sh-card"><div class="sh-card-h">${avatar(s.recipientEmail)}<div class="sh-who"><strong class="sh-t">${esc(s.recipientEmail)}</strong><span class="sh-m">${meta}</span>
        ${s.actor?`<span class="sh-m">Created by ${esc(s.actor)}</span>`:''}${s.tip?`<span class="sh-m sh-warn">${esc(s.tip)}</span>`:''}${widen}</div></div>
      <div class="sh-ctl"><div class="sh-f"><label for="shPerm-${k}">Permission</label>${permSel('data-sh-perm',s.id,s.permission,'edit',`shPerm-${k}`)}</div>
        <div class="sh-f"><label for="shAdds-${k}">New things they add</label><select data-sh-adds="${k}" id="shAdds-${k}" aria-describedby="shAddsHelp-${k}"${edit?'':' disabled'}>${PANE_ADDS.map(([v,t])=>`<option value="${v}"${v===adds?' selected':''}>${t}</option>`).join('')}</select></div>
        <button type="button" class="txt sh-danger" data-sh-revoke="${k}" data-who="${esc(s.recipientEmail)}" aria-label="Revoke ${esc(s.recipientEmail)}’s access">Revoke access</button>
        <p class="sh-help" id="shAddsHelp-${k}" data-sh-adds-help>${esc(addsHelp(adds,s.permission))}</p></div></li>`;
  };
  const shareBtns=`<button type="button" class="txt sh-btn" id="shEnvTop" data-sh-env>${icon('link',12)} Share whole environment…</button><button type="button" class="txt sh-btn" id="shNew" data-sh-new>${icon('plus',12)} Share one part…</button>`;
  const by=mine?`<section class="sh-sec" aria-labelledby="shByH">${shHead('shByH','Shared by you',`Who can see <b>${esc(envName)}</b>, or part of it. Sharing part of the mind map brings only the DevOps cards of projects linked to it.`,shareBtns)}
    ${mine.shares.length?`<ul class="sh-cards">${mine.shares.map(outCard).join('')}</ul>`:'<p class="sh-empty">You have not shared this environment with anyone.</p>'}</section>`:'';
  // Requests from recipients to share with someone else.
  const pending=reqs.requests||[];
  const asks=pending.length?`<section class="sh-sec" aria-labelledby="shReqH">${shHead('shReqH','Requests to share','People you share with asked you to share with someone else.')}
    <ul class="sh-cards">${pending.map(r=>`<li class="sh-card"><div class="sh-card-h">${avatar(r.toEmail)}<div class="sh-who"><strong class="sh-t">${esc(r.toEmail)}</strong><span class="sh-m">Asked by ${esc(r.requestedBy)}</span>${r.note?`<span class="sh-m">“${esc(r.note)}”</span>`:''}</div></div>
      <div class="sh-card-f"><div class="sh-f"><label for="shReq-${esc(r.id)}">Permission</label>${permSel('data-sh-req-perm',r.id,r.permission,r.permission,`shReq-${esc(r.id)}`)}</div><span class="sp"></span><button type="button" class="txt" data-sh-deny="${esc(r.id)}">Deny</button><button type="button" class="txt primary-txt" data-sh-approve="${esc(r.id)}">Approve</button></div></li>`).join('')}</ul></section>`:'';
  // Additions waiting for the owner: everything each one adds, in words and as a list, with its actions.
  const waiting=mine?.proposals||[];
  const recRow=r=>{const w=recordWords(r);return `<li><span class="sh-kind">${esc(w.kind)}</span><span class="sh-rt">${esc(w.title)}</span>${w.detail?`<span class="sh-m">${esc(w.detail)}</span>`:''}</li>`};
  const propCard=p=>{const n=p.preview.length,k=esc(p.id);
    return `<li class="sh-card sh-prop"><div class="sh-card-h">${avatar(p.proposedBy)}<div class="sh-who"><strong class="sh-t">${esc(p.proposedBy)} added ${plural(n,'thing')}</strong><span class="sh-m">${esc(ago(p.updatedAt||p.createdAt))}</span></div></div>
      <p class="sh-say">${esc(additionSentence(p.preview))}</p>
      ${n>1?`<ul class="sh-recs">${p.preview.slice(0,8).map(recRow).join('')}${n>8?`<li class="sh-m">…and ${n-8} more</li>`:''}</ul>`:''}
      <div class="sh-card-f"><span class="sp"></span><button type="button" class="txt" data-sh-prop-deny="${k}">Deny</button><button type="button" class="txt primary-txt" data-sh-prop-approve="${k}" data-n="${n}">${n===1?'Approve':n===2?'Approve both':`Approve all ${n}`}</button></div></li>`};
  const adds=waiting.length?`<section class="sh-sec" aria-labelledby="shAddH">${shHead('shAddH','Waiting for your approval','Things people added inside what you share. Approve to keep them here as yours, or deny to remove them.')}
    <ul class="sh-cards">${waiting.map(propCard).join('')}</ul></section>`:'';
  // Shared with you.
  const own=new Map(ownEnvs.map(e=>[e.id,e.name]));
  const myProps=new Map();for(const p of props.mine||[])if(p.status==='pending'||p.status==='denied'||p.status==='approved')(myProps.get(p.shareId)||myProps.set(p.shareId,[]).get(p.shareId)).push(p);
  const statusWord={pending:'Waiting for approval',approved:'Approved',denied:'Denied'};
  const myAdds=s=>{const l=(myProps.get(s.id)||[]).slice(0,6);return l.length?`<div class="sh-mine-h">What you added</div><ul class="sh-mine" aria-label="What you added">${l.map(p=>`<li><span class="sh-st ${esc(p.status)}">${statusWord[p.status]}</span><span class="sh-rt">${esc(p.preview.map(r=>r.title).slice(0,3).join(', '))}</span>${p.status==='pending'?`<button type="button" class="txt" data-sh-withdraw="${esc(p.id)}">Withdraw</button>`:''}</li>`).join('')}</ul>`:''};
  const addsWord=s=>s.permission!=='edit'||!s.adds||s.adds==='off'?'':s.adds==='approve'?'You can add, with their approval':'You can add';
  // A whole environment shared with you opens as itself (share-<shareId>, docs/sharing.md); any share can also be added to one of yours.
  const openedId=s=>'share-'+s.id;
  const inCard=s=>{const k=esc(s.id),here=s.envs.includes(currentEnvId),also=s.envs.filter(e=>e!==currentEnvId),whole=s.scope?.kind==='environment'&&!s.revokedAt;
    const what=s.ownerEnvName?(/^the whole environment$/i.test(s.scopeLabel||'')?`All of ${s.ownerEnvName}`:`${s.scopeLabel}, in ${s.ownerEnvName}`):s.scopeLabel;
    const meta=[esc(what),esc(PERMS.find(p=>p[0]===s.permission)?.[1]||s.permission),esc(addsWord(s))].filter(Boolean).join(' · ');
    return `<li class="sh-card"><div class="sh-card-h">${avatar(s.ownerEmail)}<div class="sh-who"><strong class="sh-t">${esc(s.ownerEmail)}</strong><span class="sh-m">${meta}</span>${also.length?`<span class="sh-m">Also in ${also.map(e=>esc(own.get(e)||e)).join(', ')}</span>`:''}</div>${!whole?'':currentEnvId===openedId(s)?'<span class="acct-vis sh-open-now">Open now</span>':`<button type="button" class="txt primary-txt" data-env-open="${esc(openedId(s))}" data-tip="Open ${esc(s.ownerEnvName||'their environment')} itself: its charts, timeline, board, AgentFlow and office">Open</button>`}</div>
      ${myAdds(s)}
      <div class="sh-card-f"><details class="sh-ask"><summary>Ask to share with someone</summary>
        <form class="sh-ask-f" data-sh-ask="${k}"><label for="shAsk-${k}">Their email</label><div class="env-row"><input id="shAsk-${k}" type="email" required placeholder="name@example.com"><button type="submit" class="txt">Ask ${esc(s.ownerEmail)}</button></div></form></details>
        ${!own.has(currentEnvId)?'':here?`<button type="button" class="txt" data-sh-detach="${k}">Remove from ${esc(own.get(currentEnvId)||'this environment')}</button>`:`<button type="button" class="txt${whole?'':' primary-txt'}" data-sh-attach="${k}">Add to ${esc(own.get(currentEnvId)||'this environment')}</button>`}</div></li>`};
  const withMe=`<section class="sh-sec" aria-labelledby="shInH">${shHead('shInH','Shared with you','Open a whole environment shared with you to work in it with its owner, or add a share to an environment of yours to see its cards there.')}
    ${incoming.shares.length?`<ul class="sh-cards">${incoming.shares.map(inCard).join('')}</ul>`:'<p class="sh-empty">Nothing is shared with you yet.</p>'}</section>`;
  const sent=(reqs.mine||[]).filter(r=>r.status==='pending');
  return `<div class="sh-pane">${adds}${by}${asks}${withMe}${sent.length?`<p class="sh-empty">Waiting for the owner to share with ${sent.map(r=>esc(r.toEmail)).join(', ')}</p>`:''}<p class="acct-err" data-sh-err hidden role="alert"></p></div>`;
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

// ---- Additions: tell the recipient once when the owner approved or denied what they added ----
const DECIDED='flygon-flow-decided-seen';
let told;try{told=new Set(JSON.parse(localStorage.getItem(DECIDED))||[])}catch{told=new Set()}
// -> a message for the toast, or '' (each decision is told once per browser).
export function decisionNotice(){
  const fresh=(store.db.shares||[]).flatMap(s=>(s.decided||[]).map(d=>({...d,owner:s.ownerEmail}))).filter(d=>!told.has(d.id));
  if(!fresh.length)return '';
  for(const d of fresh)told.add(d.id);
  try{localStorage.setItem(DECIDED,JSON.stringify([...told].slice(-300)))}catch{}
  const say=d=>`${d.owner||'The owner'} ${d.status==='approved'?'approved':'denied'} ${d.titles?.length?`“${d.titles.slice(0,2).join('”, “')}”${d.titles.length>2?' and more':''}`:'what you added'}`;
  return fresh.slice(0,2).map(say).join('. ')+(fresh.length>2?` (and ${fresh.length-2} more)`:'')+(fresh.some(d=>d.status==='denied')?'. Denied additions were removed.':'.');
}
