// Account UI: the avatar at the right end of the header, its menu (Settings, Log out), the Settings
// dialog and the OneProfileID sign-in screen.
//
//   accountHtml()  Avatar button markup for the header. The header is re-rendered with innerHTML,
//                  so the menu and dialogs live on <body> and every listener is delegated.
//
// Session comes from GET /api/auth/session ({mode:'local'|'opid', user}). In local mode there is no
// sign-in or Log out. In OneProfileID mode a missing session, or any /api request answering 401,
// opens the sign-in screen; a successful sign-in or Log out reloads the page so every module
// re-fetches its data as the new user. The shared OneProfileID button module is loaded only in
// OneProfileID mode. Styles are in account.css, linked once on import.

import {store,change} from './store.js';
import {STATUS_DEFAULTS,WORKFLOW_PRESETS,cleanWorkflow} from './workflow.js';
import {esc,setSessionUser,sessionPhoto} from './ui.js';
import {popIn,popOut} from './motion.js';
import {logoMark} from './logo-mark.js';
import {loadDevlog,currentVersion,mountDevlog} from './devlog.js';
import {SCOPES,SHORTCUTS,keysFor,showCombo,comboOf,rebind,resetShortcut,resetAll,isCustom} from './shortcuts.js';
import {getPref,setPref,onPrefs} from './prefs.js';
import {currentEnv,listEnvironments,switchEnvironment,createEnvironment,renameEnvironment,archiveEnvironment,refresh} from './sync.js';
import {sharingPane,openShareDialog,api as shareApi} from './share.js';
import {renderApiKeysTab} from './apikeys.js';
import {ask} from './modal.js';

const OPID_UI='https://oneprofileid.flygonlc.com/ui/v1/oneprofileid-ui.js';
const I={
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  lock:'<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  close:'<path d="M18 6 6 18M6 6l12 12"/>',
  swap:'<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  fingerprint:'<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .13-5.35 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>',
  reset:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
};
const svg=(n,s=16)=>`<svg class="i" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

// The badge draws its box in an open shadow root with no ::part, so outside CSS cannot widen it.
// An adopted sheet survives the component re-rendering its shadow content.
let fullSheet=null;
function fullWidthBadge(el){
  if(!el||typeof CSSStyleSheet!=='function')return;
  customElements.whenDefined('opid-badge').then(()=>{
    const root=el.shadowRoot;if(!root)return;
    if(!fullSheet){fullSheet=new CSSStyleSheet();fullSheet.replaceSync('.badge{display:flex;justify-content:center;width:100%;box-sizing:border-box}')}
    if(!root.adoptedStyleSheets.includes(fullSheet))root.adoptedStyleSheets=[...root.adoptedStyleSheets,fullSheet];
  }).catch(()=>{});
}

let session={mode:'local',user:null},ready=false,menu=null,signingIn=false;

if(!document.querySelector('link[data-account]')){
  const l=document.createElement('link');
  l.rel='stylesheet';l.href='/account.css';l.dataset.account='';
  document.head.append(l);
}

const user=()=>session.user;
// The signed-in user ({id,email,name,image}) or null; 'flow:session' fires on window when it changes.
export const sessionUser=()=>session.user||null;
let sessionKey='';
function sessionChanged(){
  const u=session.user,key=u?`${u.email}\n${u.name||''}\n${u.image||''}`:'';if(key===sessionKey)return;
  sessionKey=key;setSessionUser(u);window.dispatchEvent(new Event('flow:session'));
}
const opid=()=>session.mode==='opid';
const env=()=>store.db?.environment||null;
function initials(u){
  const s=(u?.name||u?.email||'').trim();
  const w=s.split(/[\s@._-]+/).filter(Boolean);
  return ((w[0]?.[0]||'?')+(w.length>1&&u?.name?w[1][0]:'')).toUpperCase();
}
function avatar(u,size){
  const st=`width:${size}px;height:${size}px;font-size:${Math.round(size*.4)}px`;
  // sessionPhoto() is the URL every person avatar uses for this photo (one cached copy, see ui.js).
  if(u?.image)return `<span class="acct-av" style="${st}"><img src="${esc(u===user()&&sessionPhoto()||u.image)}" alt="" referrerpolicy="no-referrer"></span>`;
  if(!u)return `<span class="acct-av anon" style="${st}"><svg width="${Math.round(size*.6)}" height="${Math.round(size*.6)}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8.5" r="4.5"/><path d="M3.5 21a8.5 8.5 0 0 1 17 0z"/></svg></span>`;
  return `<span class="acct-av" style="${st}">${esc(initials(u))}</span>`;
}

export function accountHtml(){
  const u=user(),label=u?`Account: ${u.name||u.email}`:'Account';
  return `<button type="button" id="acctBtn" class="acct-btn${menu?' on':''}${ready?'':' wait'}" aria-haspopup="menu" aria-expanded="${!!menu}" aria-label="${esc(label)}"${menu?'':` data-tip="${esc(u?(u.name||u.email):'Account')}"`}>${avatar(u,26)}</button>`;
}
function refreshButton(){const b=document.getElementById('acctBtn');if(b)b.outerHTML=accountHtml()}
function refreshPhotos(){
  sessionChanged();refreshButton();
  for(const head of document.querySelectorAll('.acct-head,.acct-card')){
    const old=head.querySelector('.acct-av');if(old)old.outerHTML=avatar(user(),head.classList.contains('acct-head')?38:44);
  }
  const remove=dlg?.querySelector('[data-photo-remove]');if(remove)remove.hidden=!user()?.image;
}
let refreshingSession=false,photoSaving=false,photoGeneration=0;
async function refreshSession(){
  if(!ready||!opid()||refreshingSession||photoSaving||document.hidden)return;
  refreshingSession=true;
  const generation=photoGeneration;
  try{
    const r=await nativeFetch('/api/auth/session?refresh=1',{credentials:'same-origin',cache:'no-store'});
    if(r.ok){const next=await r.json();if(generation!==photoGeneration)return;if(next.user?.id!==user()?.id){showSignIn();return}session=next;refreshPhotos();}
  }catch{}finally{refreshingSession=false;}
}
addEventListener('focus',refreshSession);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshSession()});

// ---- menu ----
function envRow(){
  const e=env();if(!e)return '';
  const pub=e.visibility==='public';
  return `<div class="acct-env" role="presentation"><span class="acct-env-k">Environment</span>
    <span class="acct-env-n">${esc(e.name)}</span>
    <span class="acct-vis ${pub?'pub':''}">${svg(pub?'globe':'lock',11)}${pub?'Public':'Private'}</span></div>
    <div class="acct-envs" data-envs></div>`;
}
// The user's other environments, to switch to from the menu (filled in once the list arrives).
async function fillMenuEnvs(){
  const box=menu?.querySelector('[data-envs]');if(!box)return;
  const list=await listEnvironments(),cur=currentEnv();if(!menu)return;
  const others=list.filter(x=>x.id!==cur);
  box.innerHTML=others.slice(0,6).map(x=>`<button type="button" role="menuitem" class="acct-item sub" data-acct="env" data-id="${esc(x.id)}">${svg('swap',14)}<span>${esc(x.name)}</span></button>`).join('')
    +`<button type="button" role="menuitem" class="acct-item sub" data-acct="env-new">${svg('plus',14)}<span>New environment</span></button>`;
}
function openMenu(){
  closeMenu();
  const u=user();
  menu=document.createElement('div');
  menu.className='acct-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','Account');
  menu.innerHTML=`<div class="acct-head">${avatar(u,38)}<div class="acct-id"><strong>${esc(u?.name||'Signed out')}</strong><span>${esc(u?.email||'')}</span></div></div>
    ${u?.local?'<div class="acct-note">Local mode · sign-in turns on when OneProfileID is configured</div>':''}
    ${envRow()}
    <div class="acct-sep" role="separator"></div>
    <div class="acct-row"><button type="button" role="menuitem" class="acct-item" data-acct="settings">${svg('settings')}Settings</button>${currentVersion()?`<button type="button" role="menuitem" class="acct-ver" data-acct="devlog" data-tip="DevLog" aria-label="DevLog: version ${esc(currentVersion())}">${esc(currentVersion())}</button>`:''}</div>
    ${opid()&&u?`<button type="button" role="menuitem" class="acct-item danger" data-acct="logout">${svg('logout')}Log out</button>`:''}
    ${opid()?'<div class="acct-foot"><opid-badge mode="light" kind="backed"></opid-badge></div>':''}`;
  document.body.append(menu);
  placeMenu();refreshButton();popIn(menu);fillMenuEnvs();fullWidthBadge(menu.querySelector('.acct-foot opid-badge'));
  menu.querySelector('[role=menuitem]')?.focus();
}
function placeMenu(){
  const b=document.getElementById('acctBtn');if(!menu||!b)return;
  const r=b.getBoundingClientRect();
  menu.style.top=`${r.bottom+6}px`;
  menu.style.right=`${Math.max(8,innerWidth-r.right)}px`;
}
function closeMenu(refocus=false){
  if(!menu)return;
  popOut(menu);menu=null;refreshButton();
  if(refocus)document.getElementById('acctBtn')?.focus();
}

document.addEventListener('click',e=>{
  const t=e.target instanceof Element?e.target:null;if(!t)return;
  if(t.closest('#acctBtn')){menu?closeMenu():openMenu();return}
  const item=t.closest('.acct-menu [data-acct]');
  if(item){const a=item.dataset.acct;closeMenu();if(a==='settings')openSettings();else if(a==='devlog')openSettings('devlog');else if(a==='logout')signOut();
    else if(a==='env')openEnv(item.dataset.id);else if(a==='env-new')openSettings('environment').then?.(()=>document.querySelector('#envNew')?.focus());return}
  if(menu&&!t.closest('.acct-menu'))closeMenu();
});
document.addEventListener('keydown',e=>{
  if(!menu)return;
  const items=[...menu.querySelectorAll('[role=menuitem]')],i=items.indexOf(document.activeElement);
  if(e.key==='Escape'){e.preventDefault();closeMenu(true)}
  else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const n=items.length;items[(i+(e.key==='ArrowDown'?1:n-1))%n]?.focus()}
  else if(e.key==='Home'||e.key==='End'){e.preventDefault();items[e.key==='Home'?0:items.length-1]?.focus()}
  else if(e.key==='Tab')closeMenu();
});
addEventListener('resize',placeMenu);
// While the sign-in screen or Settings is open, keep keystrokes away from the app's shortcuts.
addEventListener('keydown',e=>{
  // Keys inside Settings reach its own handlers (which stop them there); everything else is held back.
  if(signingIn||(document.querySelector('dialog.acct-dlg[open]')&&!e.target.closest?.('dialog.acct-dlg')))e.stopPropagation();
},true);

// ---- settings: Account · Environment · Sharing · API keys · Shortcuts · DevLog (last tab remembered in prefs) ----
const TABS=[['account','Account'],['environment','Environment'],['sharing','Sharing'],['apikeys','API keys'],['shortcuts','Shortcuts'],['devlog','DevLog']];
let dlg=null,recording=null,scMsg=null;
function accountPane(){
  const u=user();
  return `<div class="acct-card">${avatar(u,44)}<div class="acct-id"><strong>${esc(u?.name||'')}</strong><span>${esc(u?.email||'')}</span></div></div>
    ${opid()?`<div class="acct-photo-actions"><button type="button" class="txt" data-photo-change>Change photo</button><input type="file" accept="image/png,image/jpeg,image/webp" data-photo-file hidden><button type="button" class="txt" data-photo-remove${u?.image?'':' hidden'}>Remove photo</button></div><p class="acct-muted">Your photo is shared across OneProfileID, your personal page and connected apps.</p><p data-photo-status role="status" aria-live="polite"></p>`:''}
    <p class="acct-muted">${opid()?'Your name, password and two-factor sign-in are managed by your OneProfileID account.':'Running in local mode on this computer. Sign-in with OneProfileID turns on once the server is configured for it.'}</p>
    ${opid()?'<opid-badge mode="light" kind="backed"></opid-badge>':''}
    <div data-invites></div>`;
}
async function photoData(file){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10*1024*1024)throw Error('Choose a PNG, JPEG or WebP photo under 10 MB.');
  const bitmap=await createImageBitmap(file);
  try{
    const canvas=document.createElement('canvas'),scale=Math.min(1,512/Math.max(bitmap.width,bitmap.height));
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    let image=canvas.toDataURL('image/webp',.85);
    if(!image.startsWith('data:image/webp'))image=canvas.toDataURL('image/jpeg',.85);
    if(image.length>750000)throw Error('That photo is too large. Choose a smaller image.');
    return image;
  }finally{bitmap.close();}
}
async function savePhoto(panel,file){
  if(photoSaving)return;photoSaving=true;photoGeneration++;
  const status=panel.querySelector('[data-photo-status]'),controls=[...panel.querySelectorAll('[data-photo-change],[data-photo-remove],[data-photo-file]')];
  controls.forEach(x=>x.disabled=true);status.textContent='Saving photo…';status.setAttribute('aria-busy','true');
  try{
    const image=file?await photoData(file):null;
    const r=await post('/api/auth/profile/image',{image});
    if(!r.ok)throw Error(r.data?.error||'Could not save your account photo.');
    session.user={...user(),image:r.data.image||''};refreshPhotos();status.textContent='Account photo updated everywhere on OneProfileID.';
  }catch(e){status.textContent=e.message||'Could not save your account photo.';}
  finally{photoSaving=false;controls.forEach(x=>x.disabled=false);status.removeAttribute('aria-busy');const input=panel.querySelector('[data-photo-file]');if(input)input.value='';}
}
// Owner only (the server answers 403 to anyone else): invite an email to Flow itself.
// What happened to the invite email (shown under the invite form).
function inviteMsg(panel,j){
  const p=panel.querySelector('[data-invite-msg]');if(!p||!j?.invite)return;
  p.textContent=j.sent?`Invite email sent to ${j.invite.email}.`:j.notConfigured?`Invited ${j.invite.email} · email not configured, so tell them to sign in at ${location.origin}.`:j.emailError?`Invited ${j.invite.email}, but the email was not sent: ${j.emailError}`:`Invited ${j.invite.email}.`;
  p.hidden=false;
}
async function fillInvites(panel){
  const box=panel.querySelector('[data-invites]');if(!box)return;
  let r;try{r=await fetch('/api/invites',{cache:'no-store'})}catch{return}
  if(!r.ok)return;const {invites=[]}=await r.json();
  box.innerHTML=`<h3 class="acct-sub">Invite to Flow</h3>
    <p class="acct-muted">Invited people get an email with a link to sign in at ${esc(location.origin)} with OneProfileID using that address, and start in their own private workspace. They see nothing of yours unless you share it.</p>
    <form class="env-row" data-invite-form><input id="inviteEmail" type="email" placeholder="name@example.com" aria-label="Email to invite" required><button type="submit" class="txt primary">Invite</button></form>
    <p class="acct-err" data-invite-err hidden></p><p class="acct-muted" data-invite-msg hidden></p>
    <ul class="env-list">${invites.map(i=>`<li><span class="env-n">${esc(i.email)}</span><span class="env-s">${i.revokedAt?'Revoked':i.claimedAt?'Joined':'Invited'}</span>${!i.revokedAt&&!i.claimedAt?`<button type="button" class="txt" data-invite-resend="${esc(i.email)}">Resend</button>`:''}${!i.revokedAt?`<button type="button" class="txt" data-invite-revoke="${esc(i.email)}">Revoke</button>`:''}</li>`).join('')||'<li class="acct-muted">No invites yet</li>'}</ul>`;
}
function envPane(){
  const u=user(),e=env();if(!e)return '<p class="acct-muted">No environment loaded.</p>';
  const owner=e.ownerEmail?(e.ownerEmail===u?.email?'You':e.ownerEmail):'Not set';
  const editable=!opid()||e.ownerEmail===u?.email;
  const workflow=cleanWorkflow(store.db.workflow);
  return `<dl class="acct-dl"><dt>Name</dt><dd>${esc(e.name)}</dd><dt>Owner</dt><dd>${esc(owner)}</dd>
    <dt>Visibility</dt><dd><span class="acct-vis ${e.visibility==='public'?'pub':''}">${svg(e.visibility==='public'?'globe':'lock',11)}${e.visibility==='public'?'Public':'Private'}</span>
      <span class="acct-muted">${e.visibility==='public'?'Anyone signed in can view it; only the owner can edit.':'Only the owner can see it.'}</span></dd></dl>
    ${e.ownerEmail===u?.email||!opid()?'<p><button type="button" class="txt" data-sh-env>Share this environment…</button></p>':''}
    <h3 class="acct-sub">Your environments</h3>
    <ul class="env-list" data-env-list><li class="acct-muted">Loading…</li></ul>
    <form class="env-row" data-env-new><input id="envNew" maxlength="80" placeholder="New environment name" aria-label="New environment name"><button type="submit" class="txt">Create</button></form>
    <p class="acct-err" data-env-err hidden></p>
    <h3 class="acct-sub">Workflow</h3>
    <p class="acct-muted">Choose a starting layout, then name the timeline statuses and DevOps columns for this workspace. Existing cards keep their stage.</p>
    <form data-workflow-form>
      <label for="workflowPreset">Preset</label>
      <select id="workflowPreset" data-workflow-preset${editable?'':' disabled'}>${Object.entries(WORKFLOW_PRESETS).map(([id,p])=>`<option value="${id}"${workflow.preset===id?' selected':''}>${esc(p.name)}</option>`).join('')}</select>
      <h4>Timeline statuses</h4>
      <div class="workflow-fields">${Object.entries(STATUS_DEFAULTS).map(([id,label])=>`<label>${esc(label)}<input name="status:${id}" maxlength="40" value="${esc(workflow.statuses[id])}"${editable?'':' disabled'}></label>`).join('')}</div>
      <h4>DevOps columns</h4>
      <div class="workflow-fields">${store.db.devops.columns.map(c=>`<label>${esc(WORKFLOW_PRESETS.delivery.columns[c.id])}<input name="column:${c.id}" maxlength="80" value="${esc(c.name)}"${editable?'':' disabled'}></label>`).join('')}</div>
      ${editable?'<button type="submit" class="txt">Save workflow</button>':''}
    </form>`;
}
let renamingEnv=null;
async function fillEnvList(panel){
  const box=panel.querySelector('[data-env-list]');if(!box)return;
  const list=await listEnvironments(),cur=currentEnv();
  box.innerHTML=list.map(x=>`<li data-env="${esc(x.id)}">${renamingEnv===x.id?`<form class="env-row grow" data-env-rename-form="${esc(x.id)}"><input value="${esc(x.name)}" maxlength="80" aria-label="Environment name" data-env-rename-input><button type="submit" class="txt">Save</button></form>`
    :`<span class="env-n">${esc(x.name)}</span>${x.id===cur?'<span class="env-s">Open</span>':`<button type="button" class="txt" data-env-open="${esc(x.id)}">Open</button>`}<button type="button" class="txt" data-env-rename="${esc(x.id)}">Rename</button>${x.id!=='default-workspace'&&list.length>1?`<button type="button" class="txt" data-env-archive="${esc(x.id)}">Archive</button>`:''}`}</li>`).join('')||'<li class="acct-muted">None yet</li>';
  box.querySelector('[data-env-rename-input]')?.focus();
}
async function openEnv(id){
  try{await switchEnvironment(id);alertBox('Opened '+(env()?.name||'environment'),'ok')}
  catch(e){alertBox(e.message)}
}
const kbd=c=>`<kbd>${esc(showCombo(c)||c)}</kbd>`;
function shortcutsPane(){
  return `<div class="sc-head"><p class="acct-muted">Click a shortcut and press the new keys. Esc cancels.</p><button type="button" class="txt" data-sc-reset-all>Reset all</button></div>
    ${SCOPES.map(([scope,name])=>`<h4 class="sc-scope">${name}</h4><ul class="sc-list">${SHORTCUTS.filter(x=>x.scope===scope).map(x=>{
      const keys=keysFor(x.id),rec=recording===x.id,msg=scMsg?.id===x.id?scMsg:null;
      return `<li class="sc-row${rec?' rec':''}" data-row="${x.id}"><span class="sc-d">${esc(x.desc)}</span>
        ${x.fixed?`<span class="sc-k fixed" data-tip="This one cannot be changed">${keys.map(kbd).join('')}</span>`
          :`<button type="button" class="sc-k" data-sc="${x.id}" aria-label="${esc(x.desc)}: ${esc(keys.map(showCombo).join(' or '))}. Change">${rec?'<span class="sc-rec">Press keys…</span>':keys.map(kbd).join('<span class="sc-or">or</span>')}</button>`}
        ${isCustom(x.id)?`<button type="button" class="ib sc-reset" data-sc-reset="${x.id}" data-tip="Reset to ${esc(SHORTCUTS.find(y=>y.id===x.id).keys.map(showCombo).join(' or '))}" aria-label="Reset">${svg('reset',14)}</button>`:''}
        ${msg?`<div class="sc-msg${msg.conflict?' warn':' err'}" role="alert">${esc(msg.text)}${msg.conflict?` <button type="button" class="txt" data-sc-swap="${esc(msg.combo)}">Swap</button><button type="button" class="txt" data-sc-cancel>Cancel</button>`:''}</div>`:''}</li>`}).join('')}</ul>`).join('')}`;
}
async function drawTab(id){
  if(!dlg)return;
  if(id==='whatsnew')id='devlog';
  const tab=TABS.some(([t])=>t===id)?id:'account';
  for(const b of dlg.querySelectorAll('[role=tab]')){const on=b.dataset.tab===tab;b.setAttribute('aria-selected',on);b.tabIndex=on?0:-1}
  const panel=dlg.querySelector('[role=tabpanel]');panel.setAttribute('aria-labelledby','acctTab-'+tab);
  if(tab==='devlog'){panel.innerHTML='<div class="hp-log"></div>';await mountDevlog(panel.firstChild)}
  else if(tab==='apikeys')await renderApiKeysTab(panel);
  else if(tab==='sharing'){panel.innerHTML='<p class="acct-muted">Loading…</p>';const html=await sharingPane(currentEnv(),await listEnvironments());if(dlg&&panel.isConnected&&panel.getAttribute('aria-labelledby')==='acctTab-sharing')panel.innerHTML=html}
  else panel.innerHTML=tab==='account'?accountPane():tab==='environment'?envPane():shortcutsPane();
  if(tab==='account')fillInvites(panel);if(tab==='environment')fillEnvList(panel);
  if(getPref('settingsTab')!==tab)setPref('settingsTab',tab);
}
// Settings closes with a short fade and its backdrop fades too (instant with reduced motion).
function closeDlg(d){
  if(d.dataset.closing!==undefined)return;d.dataset.closing='';
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return d.close();
  d.animate([{opacity:1,transform:'none'},{opacity:0,transform:'scale(.97)'}],{duration:120,easing:'ease-in',fill:'forwards'});
  try{d.animate([{opacity:1},{opacity:0}],{duration:120,pseudoElement:'::backdrop',fill:'forwards'})}catch{}
  setTimeout(()=>d.close(),120);
}
function openSettings(tab=getPref('settingsTab')||'account'){
  renamingEnv=null;
  dlg?.close();recording=null;scMsg=null;
  const d=document.createElement('dialog');dlg=d;
  d.className='acct-dlg acct-tabs';d.setAttribute('aria-labelledby','acctSetT');
  d.innerHTML=`<div class="acct-dlg-h"><h2 id="acctSetT">Settings</h2><button type="button" class="ib" data-close aria-label="Close">${svg('close')}</button></div>
    <div class="acct-tablist" role="tablist" aria-label="Settings sections">${TABS.map(([t,n])=>`<button type="button" role="tab" id="acctTab-${t}" data-tab="${t}" aria-controls="acctPanel">${n}</button>`).join('')}</div>
    <div class="acct-panel" id="acctPanel" role="tabpanel" tabindex="0"></div>`;
  document.body.append(d);
  d.addEventListener('close',()=>{if(dlg===d)dlg=null;recording=null;d.remove();document.getElementById('acctBtn')?.focus()});
  // Esc closes with the same exit animation as the ✕ button.
  d.addEventListener('cancel',ev=>{if(recording)return ev.preventDefault();ev.preventDefault();closeDlg(d)});
  d.addEventListener('click',ev=>{
    const t=ev.target;
    if(t===d||t.closest?.('[data-close]'))return closeDlg(d);
    const tb=t.closest?.('[role=tab]');if(tb){drawTab(tb.dataset.tab);return}
    const panel=d.querySelector('[role=tabpanel]'),envErr=m=>{const p=panel.querySelector('[data-env-err]');if(p){p.textContent=m;p.hidden=!m}};
    if(t.closest?.('[data-photo-change]')){panel.querySelector('[data-photo-file]')?.click();return}
    if(t.closest?.('[data-photo-remove]')){savePhoto(panel,null);return}
    const eo=t.closest?.('[data-env-open]');if(eo){openEnv(eo.dataset.envOpen).then(()=>drawTab('environment'));return}
    const er=t.closest?.('[data-env-rename]');if(er){renamingEnv=er.dataset.envRename;fillEnvList(panel);return}
    const ea=t.closest?.('[data-env-archive]');if(ea){const id=ea.dataset.envArchive,name=ea.closest('li').querySelector('.env-n')?.textContent||'';
      ask(`Archive “${name}”?\nIt is hidden from your list; its data is kept on the server.`,{ok:'Archive',danger:true}).then(async ok=>{if(!ok)return;try{await archiveEnvironment(id);if(id===currentEnv()){const rest=(await listEnvironments())[0];if(rest)await switchEnvironment(rest.id)}drawTab('environment')}catch(e){envErr(e.message)}});return}
    const ivr=t.closest?.('[data-invite-resend]');if(ivr){fetch('/api/invites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:ivr.dataset.inviteResend,resend:true})}).then(r=>r.json()).then(j=>{fillInvites(panel).then(()=>inviteMsg(panel,j))});return}
    // Sharing: owner actions (permission, revoke, requests) and recipient actions (add to / remove from an environment).
    const shErr=m=>{const p=panel.querySelector('[data-sh-err]');if(p){p.textContent=m;p.hidden=!m}};
    const shDo=(fn,after)=>fn().then(async()=>{if(after)await refresh();await drawTab('sharing')}).catch(e=>shErr(e.message));
    if(t.closest?.('[data-sh-new],[data-sh-env]')){closeDlg(d);openShareDialog(t.closest('[data-sh-env]')?{scope:{kind:'environment'}}:{});return}
    const sr=t.closest?.('[data-sh-revoke]');if(sr){ask(`Stop sharing with ${sr.dataset.who}?\nThe shared cards disappear from their workspace. Their own data stays.`,{ok:'Revoke',danger:true}).then(ok=>{if(ok)shDo(()=>shareApi.revoke(sr.dataset.shRevoke))});return}
    const sa=t.closest?.('[data-sh-approve]');if(sa){shDo(()=>shareApi.decide(sa.dataset.shApprove,true,panel.querySelector(`[data-sh-req-perm="${sa.dataset.shApprove}"]`)?.value));return}
    const sd=t.closest?.('[data-sh-deny]');if(sd){shDo(()=>shareApi.decide(sd.dataset.shDeny,false));return}
    // Adding a share closes Settings and opens its chart, so the linked boxes are right there.
    const sat=t.closest?.('[data-sh-attach]');if(sat){const id=sat.dataset.shAttach;shareApi.attach(id,currentEnv()).then(()=>refresh()).then(()=>{
      closeDlg(d);const c=store.db.charts.find(x=>x.id===`sh.${id}.chart`)||store.db.charts.find(x=>x.nodes.some(n=>n.id.startsWith(`sh.${id}.`)));
      if(c&&store.db.active!==c.id){store.db.active=c.id;store.onChange()}alertBox('Added. Shared boxes show a link badge; co-owners are read-only stubs.')}).catch(e=>shErr(e.message));return}
    const sdt=t.closest?.('[data-sh-detach]');if(sdt){ask('Remove these shared cards from this environment?\nYou can add them again any time.',{ok:'Remove'}).then(ok=>{if(ok)shDo(()=>shareApi.detach(sdt.dataset.shDetach,currentEnv()),true)});return}
    const ir=t.closest?.('[data-invite-revoke]');if(ir){fetch('/api/invites?email='+encodeURIComponent(ir.dataset.inviteRevoke),{method:'DELETE'}).then(()=>fillInvites(panel));return}
    const sc=t.closest?.('[data-sc]');if(sc){recording=sc.dataset.sc;scMsg=null;drawTab('shortcuts').then(()=>d.querySelector(`[data-sc="${recording}"]`)?.focus());return}
    const rs=t.closest?.('[data-sc-reset]');if(rs){resetShortcut(rs.dataset.scReset);scMsg=null;drawTab('shortcuts');return}
    if(t.closest?.('[data-sc-reset-all]')){resetAll();scMsg=null;recording=null;drawTab('shortcuts');return}
    const sw=t.closest?.('[data-sc-swap]');if(sw&&scMsg){const res=rebind(scMsg.id,sw.dataset.scSwap,{swap:true});scMsg=res.error?{id:scMsg.id,text:res.error}:null;drawTab('shortcuts');return}
    if(t.closest?.('[data-sc-cancel]')){scMsg=null;drawTab('shortcuts');return}
  });
  d.addEventListener('change',ev=>{
    if(ev.target.matches?.('[data-photo-file]')&&ev.target.files?.[0])savePhoto(d.querySelector('[role=tabpanel]'),ev.target.files[0]);
    if(ev.target.matches?.('[data-workflow-preset]')){
      const preset=WORKFLOW_PRESETS[ev.target.value];if(!preset)return;
      const form=ev.target.closest('form');
      for(const [id,name] of Object.entries(preset.statuses))form.elements.namedItem(`status:${id}`).value=name;
      for(const [id,name] of Object.entries(preset.columns))form.elements.namedItem(`column:${id}`).value=name;
    }
  });
  d.addEventListener('keydown',ev=>ev.stopPropagation());
  d.addEventListener('change',ev=>{
    const p=ev.target.closest?.('[data-sh-perm]');
    if(p)shareApi.setPermission(p.dataset.shPerm,p.value).catch(e=>alertBox(e.message));
  });
  d.addEventListener('submit',async ev=>{
    ev.preventDefault();const f=ev.target,panel=d.querySelector('[role=tabpanel]');
    const err=(sel,m)=>{const p=panel.querySelector(sel);if(p){p.textContent=m||'';p.hidden=!m}};
    try{
      if(f.matches('[data-workflow-form]')){
        const preset=f.elements.namedItem('workflowPreset').value;
        const statuses=Object.fromEntries(Object.keys(STATUS_DEFAULTS).map(id=>[id,f.elements.namedItem(`status:${id}`).value]));
        const names=Object.fromEntries(store.db.devops.columns.map(c=>[c.id,f.elements.namedItem(`column:${c.id}`).value.trim().slice(0,80)]));
        change(()=>{store.db.workflow=cleanWorkflow({preset,statuses});for(const c of store.db.devops.columns)c.name=names[c.id]||WORKFLOW_PRESETS[preset].columns[c.id];store.db.devops.namesCustomized=true});
        await drawTab('environment');alertBox('Workflow saved','ok');
      }
      else if(f.matches('[data-env-new]')){const name=f.querySelector('input').value.trim();if(!name)return;const id=await createEnvironment(name);await switchEnvironment(id);await drawTab('environment')}
      else if(f.matches('[data-env-rename-form]')){const name=f.querySelector('input').value.trim();if(!name)return;await renameEnvironment(f.dataset.envRenameForm,name);renamingEnv=null;await drawTab('environment')}
      else if(f.matches('[data-sh-ask]')){
        await shareApi.request(f.dataset.shAsk,{toEmail:f.querySelector('input').value.trim()});alertBox('Asked the owner. They approve or deny it.','ok');await drawTab('sharing');
      }
      else if(f.matches('[data-invite-form]')){
        const r=await fetch('/api/invites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.querySelector('input').value.trim()})});
        const j=await r.json().catch(()=>({}));if(!r.ok)return err('[data-invite-err]',j.error||'Could not invite');await fillInvites(panel);inviteMsg(panel,j);
      }
    }catch(e){err(f.matches('[data-invite-form]')?'[data-invite-err]':f.matches('[data-sh-ask]')?'[data-sh-err]':'[data-env-err]',e.message)}
  });
  d.addEventListener('keydown',ev=>{
    // Recording a new combo: the next key press (with modifiers) becomes the binding.
    if(recording){
      ev.preventDefault();ev.stopPropagation();
      if(ev.key==='Escape'){recording=null;drawTab('shortcuts');return}
      const combo=comboOf(ev);if(!combo)return;
      const id=recording;recording=null;const res=rebind(id,combo);
      scMsg=res.ok?null:res.conflict?{id,combo,conflict:true,text:`${showCombo(combo)} is already used by “${res.conflict.desc}”.${res.conflict.fixed?'':' Swap them?'}`}:{id,text:res.error};
      if(res.conflict?.fixed)scMsg={id,text:`${showCombo(combo)} is used by “${res.conflict.desc}”, which cannot change.`};
      drawTab('shortcuts').then(()=>d.querySelector(`[data-sc="${id}"]`)?.focus());return;
    }
    const tb=ev.target.closest?.('[role=tab]');
    if(tb&&['ArrowLeft','ArrowRight','Home','End'].includes(ev.key)){
      ev.preventDefault();const tabs=[...d.querySelectorAll('[role=tab]')],i=tabs.indexOf(tb),n=tabs.length;
      const next=tabs[ev.key==='Home'?0:ev.key==='End'?n-1:(i+(ev.key==='ArrowRight'?1:n-1))%n];next.focus();drawTab(next.dataset.tab);
    }
  });
  d.showModal();popIn(d);drawTab(tab).then(()=>d.querySelector('[aria-selected=true]')?.focus());
}
onPrefs((p,k)=>{if(dlg&&(k==='shortcuts'||k==='*')&&!recording){const cur=dlg.querySelector('[aria-selected=true]')?.dataset.tab;if(cur==='shortcuts')drawTab('shortcuts')}});
loadDevlog();
window.flowSettings={open:openSettings};

// ---- sign in / out ----
async function post(path,body){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'});
  let data={};try{data=await r.json()}catch{}
  return {ok:r.ok,status:r.status,data};
}
async function signOut(){
  const r=await post('/api/auth/sign-out',{});
  if(r.ok)location.reload();
  else alertBox(r.data.error||'Could not log out. Try again.');
}
function alertBox(msg){
  const t=document.createElement('div');t.className='acct-toast';t.setAttribute('role','alert');t.textContent=msg;
  document.body.append(t);popIn(t);setTimeout(()=>popOut(t),4000);
}

let opidUi=null;
const loadOpidUi=()=>opidUi||=import(OPID_UI).catch(()=>null);

function showSignIn(){
  if(signingIn)return;signingIn=true;closeMenu();
  const o=document.createElement('div');
  o.className='acct-gate';o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');o.setAttribute('aria-labelledby','acctGateT');
  o.innerHTML=`<div class="acct-gate-card">
    <span class="logo acct-gate-logo">${logoMark(40)}</span>
    <h1 id="acctGateT">Sign in to Flygon Flow</h1>
    <p class="acct-muted">Use your OneProfileID account.</p>
    ${session.sso?`<div class="acct-form acct-sso" id="flow-sso">
      <opid-sign-in id="acctSso" type="button" mode="light" variant="solid"></opid-sign-in>
      <button type="button" class="acct-submit fallback" data-sso hidden>Continue with OneProfileID</button>
      <p class="acct-hint">${svg('fingerprint',14)}Face ID, Touch ID, Windows Hello or a security key</p>
      <p class="acct-err" role="alert" hidden></p>
      <button type="button" class="acct-link" data-pw>Use email and password instead</button>
    </div>`:''}
    <form id="flow-login" class="acct-form" novalidate${session.sso?' hidden':''}>
      <label for="acctEmail">Email</label><input id="acctEmail" name="email" type="email" autocomplete="username" required>
      <label for="acctPass">Password</label><input id="acctPass" name="password" type="password" autocomplete="current-password" required>
      <p class="acct-err" role="alert" hidden></p>
      ${session.sso?`<button type="submit" class="acct-submit">Sign in</button>
      <button type="button" class="acct-link" data-passkey>Use a passkey instead</button>`
      :`<opid-sign-in type="submit" form="flow-login" mode="light" variant="solid"></opid-sign-in>
      <button type="submit" class="acct-submit fallback" hidden>Continue with OneProfileID</button>`}
    </form>
    <form id="flow-2fa" class="acct-form" novalidate hidden>
      <p class="acct-muted">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
      <label for="acctCode">Code</label><input id="acctCode" name="code" autocomplete="one-time-code" inputmode="text" maxlength="64" required>
      <label class="acct-check"><input type="checkbox" name="trust"> Trust this device</label>
      <p class="acct-err" role="alert" hidden></p>
      <button type="submit" class="acct-submit">Verify</button>
      <button type="button" class="acct-link" data-back>Use a different account</button>
    </form></div>`;
  document.body.append(o);
  document.body.classList.add('acct-locked');
  for(const el of document.querySelectorAll('body > header, body > main'))el.inert=true;
  const ssoBox=o.querySelector('#flow-sso');
  const focusSso=()=>{const h=o.querySelector('#acctSso');customElements.whenDefined('opid-sign-in').then(()=>(h.shadowRoot?.querySelector('button')||h).focus())};
  if(ssoBox)focusSso();else o.querySelector('#acctEmail').focus();

  loadOpidUi().then(m=>{if(!m||!customElements.get('opid-sign-in'))for(const f of o.querySelectorAll('.fallback'))f.hidden=false});
  const login=o.querySelector('#flow-login'),tfa=o.querySelector('#flow-2fa');
  const err=(f,m)=>{const p=f.querySelector('.acct-err');p.textContent=m||'';p.hidden=!m};

  // Passkeys and biometrics run on OneProfileID's own page; it sends the browser straight back here.
  if(ssoBox){
    const go=()=>{o.querySelector('#acctSso').toggleAttribute('loading',true);location.assign('/api/auth/sso/start')};
    o.querySelector('#acctSso').addEventListener('opid-sign-in',e=>{e.preventDefault();go()});
    o.querySelector('[data-sso]').addEventListener('click',go);
    o.querySelector('[data-pw]').addEventListener('click',()=>{ssoBox.hidden=true;login.hidden=false;login.email.focus()});
    login.querySelector('[data-passkey]').addEventListener('click',()=>{login.hidden=true;ssoBox.hidden=false;focusSso()});
    const SIGNIN={denied:'This OneProfileID account does not have access to Flygon Flow.',expired:'That sign-in took too long or was interrupted. Try again.',
      failed:'Sign-in did not complete. Try again.',unavailable:'OneProfileID is temporarily unavailable. Try again shortly.'};
    const q=new URLSearchParams(location.search),why=q.get('signin');
    if(why){err(ssoBox,SIGNIN[why]||SIGNIN.failed);q.delete('signin');history.replaceState(null,'',location.pathname+(q.size?'?'+q:'')+location.hash)}
  }
  const busy=(f,on)=>{f.querySelectorAll('input,button').forEach(x=>x.disabled=on);const b=f.querySelector('opid-sign-in');if(b)b.toggleAttribute('loading',on)};
  const done=()=>location.reload();

  login.addEventListener('submit',async e=>{
    e.preventDefault();err(login,'');
    const email=login.email.value.trim(),password=login.password.value;
    if(!email||!password){err(login,'Enter your email and password.');(email?login.password:login.email).focus();return}
    busy(login,true);
    let r;try{r=await post('/api/auth/sign-in',{email,password})}catch{r={data:{error:'Could not reach the server. Check your connection.'}}}
    busy(login,false);
    if(r.ok&&r.data.step==='verify'){login.hidden=true;tfa.hidden=false;tfa.code.focus();return}
    if(r.ok&&r.data.step==='enroll'){err(login,r.data.error||'Set up two-factor sign-in in OneProfileID first, then come back.');return}
    if(r.ok&&r.data.user)return done();
    err(login,r.data.error||'Sign-in failed. Try again.');login.password.select();
  });
  tfa.addEventListener('submit',async e=>{
    e.preventDefault();err(tfa,'');
    const code=tfa.code.value.trim();
    if(!code){err(tfa,'Enter your code.');tfa.code.focus();return}
    busy(tfa,true);
    let r;try{r=await post('/api/auth/two-factor',{code,trust:tfa.trust.checked})}catch{r={data:{error:'Could not reach the server. Check your connection.'}}}
    busy(tfa,false);
    if(r.ok&&r.data.user)return done();
    err(tfa,r.data.error||'That code did not work.');tfa.code.select();
  });
  tfa.querySelector('[data-back]').addEventListener('click',()=>{tfa.hidden=true;login.hidden=false;tfa.reset();login.password.value='';login.email.focus()});
}

// Any /api 401 while signed in to OneProfileID mode means the session ended: ask to sign in again.
const nativeFetch=window.fetch.bind(window);
window.fetch=async(...args)=>{
  const res=await nativeFetch(...args);
  if(res.status===401&&opid()){
    const url=new URL(typeof args[0]==='string'?args[0]:args[0]?.url||'',location.href);
    if(url.origin===location.origin&&url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/api/auth/'))showSignIn();
  }
  return res;
};

(async()=>{
  try{
    const r=await nativeFetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});
    if(r.ok)session=await r.json();
  }catch{}
  ready=true;sessionChanged();refreshButton();
  if(opid()){loadOpidUi();if(!user())showSignIn()}
})();
