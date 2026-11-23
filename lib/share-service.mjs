// Sharing as a service (docs/sharing.md): what a scope holds (previewOf, for the Share dialog and
// Settings › Sharing), creating shares (saveShare: the one rule set for the app's POST /api/shares and the
// API), and the shares.* operations of /api/v1 and MCP (forUser, ctx.sharing in lib/registry.mjs).
// The rules themselves are lib/sharing-core.mjs; storage is lib/shares.mjs.
//
//   const svc=shareServices({shares, workspaces, onRevoke})
//   svc.previewOf(db, share) / scopeLabel(db, scope) / shareSummary(db, share)
//   await svc.saveShare(w, user, {recipientEmail, scope, permission, name, adds}, {actor, dryRun})
//   await svc.updateShare(share, {permission?, adds?})
//   svc.forUser(user, keyAllows) -> {list, preview, create, update, revoke, incoming, requests, ask, decide}
// shares: lib/shares.mjs shareStore(); workspaces: lib/workspaces.mjs workspaceStore(); onRevoke: called
// after a revoke (the server clears its photo cache). keyAllows: lib/apikeys.mjs allows. Errors from
// forUser are thrown as {status, code, message}, like the registry's.
import * as core from './sharing-core.mjs';

const ENV_ID=/^[A-Za-z0-9-]{1,64}$/;
const sameEmail=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();

export function previewOf(db,share){
  const sc=core.resolveScope(db,share),nodes=new Map((db.charts||[]).filter(c=>!share.scope?.chartId||c.id===share.scope.chartId).flatMap(c=>c.nodes||[]).map(n=>[n.id,n]));
  const items=new Map((db.timeline||[]).map(i=>[i.id,i])),cards=new Map((db.devops?.cards||[]).map(c=>[c.id,c]));
  const out={nodes:sc.nodeIds.map(id=>nodes.get(id)).filter(Boolean).map(n=>({id:n.id,name:n.name,type:n.type})),
    stubs:sc.stubs.map(t=>({id:t.nodeId,name:t.name,type:t.nodeType,owns:nodes.get(t.ownsNodeId)?.name||'',edge:t.type,percent:t.percent})),
    projects:(db.projects||[]).filter(p=>sc.projectIds.includes(p.id)).map(p=>({id:p.id,name:p.name,color:p.color})),
    items:sc.itemIds.map(id=>items.get(id)).filter(Boolean).map(i=>({id:i.id,title:i.title,kind:i.kind,start:i.start})),
    cards:sc.cardIds.map(id=>cards.get(id)).filter(Boolean).map(c=>({id:c.id,number:c.number,title:c.title,project:c.project}))};
  // Counts for Settings › Sharing rows (and the Share dialog tip) without a second round-trip.
  out.summary={nodes:out.nodes.length,stubs:out.stubs.length,projects:out.projects.length,items:out.items.length,cards:out.cards.length};
  // Mind-map-only scopes often surprise people: co-owner stubs show on the chart, but DevOps cards
  // only follow projects linked by entity id. Call that out so the owner can widen to the whole env.
  const kind=share.scope?.kind;
  out.tip=kind==='environment'?null
    :!out.nodes.length&&!out.projects.length&&!out.cards.length?'Nothing matches this scope yet.'
    :out.nodes.length&&!out.cards.length?'Mind map cards are in this share, but no DevOps cards. Board cards only come along when their project’s entity is one of those mind map cards. To share the whole board, pick “The whole environment”.'
    :out.nodes.length&&out.stubs.length&&out.cards.length?'Co-owner stubs (name only) do not bring their own DevOps cards. Widen to the whole environment if they should see the full board.'
    :null;
  return out;
}
export function shareSummary(db,share){
  const p=previewOf(db,share);return {scopeLabel:scopeLabel(db,share.scope),summary:p.summary,tip:p.tip};
}
export function scopeLabel(db,scope){
  const n=id=>(db?.charts||[]).flatMap(c=>c.nodes||[]).find(x=>x.id===id)?.name||'a card';
  if(scope?.kind==='environment')return 'The whole environment';
  if(scope?.kind==='person')return `${n(scope.nodeId)} and everything below`;
  if(scope?.kind==='nodes')return scope.nodeIds.length<=3?scope.nodeIds.map(n).join(', '):`${scope.nodeIds.slice(0,2).map(n).join(', ')} and ${scope.nodeIds.length-2} more cards`;
  if(scope?.kind==='project')return `Project ${(db?.projects||[]).find(p=>p.id===scope.projectId)?.name||''}`.trim();
  if(scope?.kind==='label')return `Label ${(db?.devops?.labels||[]).find(l=>l.id===scope.label)?.name||scope.label}`;
  return 'Shared';
}
export function shareServices({shares,workspaces,onRevoke=()=>{}}){
  // A share as Settings › Sharing lists it: with its owner environment's name, scope label and counts.
  async function shareView(s){
    const home=await workspaces.get(s.ownerEnv);const sum=home?.data?shareSummary(home.data,s):{scopeLabel:scopeLabel(null,s.scope),summary:null,tip:null};
    return {...s,ownerEnvName:home?.name||home?.data?.environment?.name||'',scopeLabel:sum.scopeLabel,summary:sum.summary,tip:sum.tip};
  }
  // Share part of w (the user's own environment): the one rule set for the app (POST /api/shares) and for
  // /api/v1 and MCP (forUser). Linked copies (sh.*) are not the user's to share: they ask the owner
  // instead (a share request). Sharing the same thing with the same person again updates the permission
  // instead of duplicating it (and what recipients may add, when b.adds is sent). actor: the API key's
  // name. dryRun: check and report, store nothing. -> {ok, share, existing} | {ok:false, error, field}
  async function saveShare(w,user,b,{actor=null,dryRun=false}={}){
    if(/"sh\./.test(JSON.stringify(b.scope??null)))return {ok:false,error:'linked'};
    const r=core.createShare({id:w.envId,ownerEmail:w.owner},user,{recipientEmail:b.recipientEmail,scope:b.scope,permission:b.permission||'view',name:b.name,adds:b.adds||'off'});
    if(!r.ok)return r;
    const dup=(await shares.list({ownerEnv:w.envId,recipientEmail:r.share.recipientEmail})).find(s=>JSON.stringify(s.scope)===JSON.stringify(r.share.scope));
    const addsChange=!!dup&&b.adds!==undefined&&dup.adds!==r.share.adds;
    if(dryRun)return {ok:true,share:dup?{...dup,permission:r.share.permission,...(addsChange?{adds:r.share.adds}:{})}:{...r.share,actor},existing:!!dup};
    let s=dup?(dup.permission===r.share.permission?dup:await shares.setPermission(dup.id,r.share.permission)):await shares.create({...r.share,actor});
    if(addsChange)s=await shares.setAdds(dup.id,r.share.adds);
    return {ok:true,share:s,existing:!!dup};
  }
  // Change a share's permission and/or what its recipient may add ({permission?, adds?}, both checked by
  // the caller). Only edit shares can add; view and comment shares are always off.
  async function updateShare(s,{permission,adds}){
    let out=s;if(permission!==undefined)out=await shares.setPermission(s.id,permission);
    if(adds!==undefined||out.permission!=='edit')out=await shares.setAdds(s.id,out.permission==='edit'?adds??out.adds:'off');
    return out;
  }
  const SHARE_ERR={forbidden:[403,'share_forbidden','Only the owner of an environment can share it'],invalid:[400,'invalid_share','Check the details'],
    revoked:[409,'share_revoked','This share was revoked'],decided:[409,'already_decided','This request was already decided'],
    linked:[400,'share_linked','Records shared with you cannot be shared on. Ask their owner instead: shares.requests.create with the share id from shares.incoming']};
  function forUser(user,keyAllows){
    const key=user.key||null,actor=key?.name||null;
    const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code,message})};
    const refuse=r=>{const [st,code,m]=SHARE_ERR[r.error]||[400,'invalid_share','Not allowed'];fail(st,r.field?`invalid_${r.field}`:code,r.field?`${m} (${r.field})`:m)};
    // The key's scope (403), then its environment: one it is not for is not found (404), as everywhere in the API.
    const nf=(what='Environment')=>fail(404,'not_found',`${what} not found`);
    const need=(scope,env)=>{if(!key)return;if(!keyAllows(key,scope))fail(403,'insufficient_scope',`This needs the ${scope} scope`);if(env!==undefined&&!keyAllows(key,scope,env))fail(404,'not_found','Not found')};
    const ownEnv=async(id,scope)=>{need(scope,id);if(!ENV_ID.test(id||''))nf();const w=await workspaces.get(id);if(!w||w.archivedAt||!w.data||!sameEmail(w.owner,user.email))nf();return w};
    const ownShare=async(id,scope)=>{const s=await shares.get(id);if(!s||!sameEmail(s.ownerEmail,user.email))nf('Share');need(scope,s.ownerEnv);return s};
    return {
      async list(env){
        const w=await ownEnv(env,'read'),list=await shares.list({ownerEnv:w.envId});
        return {shares:await Promise.all(list.map(shareView)),requests:(await shares.requests({ownerEmail:user.email,status:'pending'})).filter(r=>list.some(s=>s.id===r.shareId))};
      },
      async preview(env,scope){
        const w=await ownEnv(env,'read');
        if(/"sh\./.test(JSON.stringify(scope??null)))refuse({error:'linked'});
        if(!core.validScope(scope))fail(400,'invalid_scope','Pick what to share');
        return {preview:previewOf(w.data,{scope}),label:scopeLabel(w.data,scope)};
      },
      // Without confirm: what would be shared, and nothing is stored.
      async create(env,b,confirm){
        const w=await ownEnv(env,'write'),r=await saveShare(w,user,b,{actor,dryRun:!confirm});
        if(!r.ok)refuse(r);
        if(!confirm&&!r.existing)r.share.id=null;
        return {created:!!confirm&&!r.existing,existing:r.existing,confirmed:!!confirm,share:await shareView(r.share),preview:previewOf(w.data,r.share),label:scopeLabel(w.data,r.share.scope)};
      },
      async update(id,b){
        const s=await ownShare(id,'write');if(s.revokedAt)refuse({error:'revoked'});
        if(b.permission===undefined&&b.adds===undefined)fail(400,'invalid_input','Send permission or adds');
        return {share:await shareView(await updateShare(s,b))};
      },
      async revoke(id){
        const s=await ownShare(id,'write'),gone=await shares.revoke(s.id);onRevoke();
        return {share:await shareView(gone),revoked:true};
      },
      async incoming(){
        need('read');if(user.token)return {shares:[]};
        const own=new Set((await workspaces.owned(user.email)).map(w=>w.envId)),out=[];
        for(const s of await shares.list({recipientEmail:user.email}))out.push({...await shareView(s),envs:(await shares.envsFor(s.id)).filter(id=>own.has(id))});
        return {shares:out};
      },
      async requests(){
        need('read');
        return {requests:await shares.requests({ownerEmail:user.email,status:'pending'}),mine:await shares.requests({requestedBy:user.email})};
      },
      // A recipient asks the owner to share it on (they cannot share it themselves).
      async ask(id,b){
        need('write');
        const s=await shares.get(id);if(!s||s.revokedAt||user.token||!sameEmail(s.recipientEmail,user.email))nf('Share');
        const r=core.requestReshare(s,user,{toEmail:b.toEmail,permission:b.permission,note:b.note});if(!r.ok)refuse(r);
        return {request:await shares.addRequest(r.request)};
      },
      async decide(id,{approve,permission}){
        const r0=await shares.getRequest(id);if(!r0||!sameEmail(r0.ownerEmail,user.email))nf('Request');
        const s=await shares.get(r0.shareId);need('write',s?.ownerEnv);
        const out=core.decideRequest(r0,s,user,!!approve,{permission});if(!out.ok)refuse(out);
        const made=out.share?await shares.create({...out.share,actor}):null;
        return {request:await shares.decide(out.request),share:made?await shareView(made):null};
      },
    };
  }

  return {previewOf,shareSummary,scopeLabel,saveShare,updateShare,shareView,forUser};
}
