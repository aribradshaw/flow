// Settings › API keys: create, list and revoke the signed-in user's API keys (lib/apikeys-routes.mjs),
// plus copy-paste setup for curl, MCP (Claude Code, Codex) and the CLI.
//
//   renderApiKeysTab(container)  Renders the whole tab into container (e.g. the Settings tabpanel)
//                                and returns a promise that settles once the list has loaded.
//                                Listeners are bound to the container's content, so re-rendering is safe.
//
// A new key is shown once, with Copy and a "you won't see this again" warning; afterwards only its
// prefix is ever shown. Snippets use placeholders only and never include a real key. Rows, the reveal
// box and errors animate in and out (motion.js; nothing snaps); prefers-reduced-motion turns that off.
// Styles are in apikeys.css, linked once on import.

import {esc,hint} from './ui.js';
import {enter,popIn,busy} from './motion.js';
import {ask} from './modal.js';

if(!document.querySelector('link[data-apikeys]')){
  const l=document.createElement('link');
  l.rel='stylesheet';l.href='/apikeys.css';l.dataset.apikeys='';
  document.head.append(l);
}

const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE='cubic-bezier(.2,.7,.2,1)';
const LEVELS=[['read','Read',['read']],['write','Read & write',['read','write']],['admin','Admin',['read','write','admin']]];
const EXPIRY=[['30','30 days'],['90','90 days'],['365','1 year'],['','Never']];
const HOST='https://<your-flow-host>',ENVID='<environment-id>';
// Placeholders only: the real key is pasted by the user. The /api/v1, /mcp and CLI names follow docs/api-keys.md.
export const SNIPPETS=[
  ['curl','curl',m=>`export FLOW_API_KEY="flow_${m}_<your-key>"
curl -H "Authorization: Bearer $FLOW_API_KEY" \\
  "${HOST}/api/v1/workspace?env=${ENVID}"`],
  ['claude','Claude Code',m=>`claude mcp add --transport http flygon-flow "${HOST}/mcp" \\
  --header "Authorization: Bearer flow_${m}_<your-key>"`],
  ['codex','Codex',m=>`# ~/.codex/config.toml
[mcp_servers.flygon-flow]
url = "${HOST}/mcp"
bearer_token_env_var = "FLOW_API_KEY"

# then, in your shell
export FLOW_API_KEY="flow_${m}_<your-key>"`],
  ['cli','CLI',m=>`export FLOW_URL="${HOST}"
export FLOW_API_KEY="flow_${m}_<your-key>"
flow cards list --env ${ENVID}`],
];
const I={
  copy:'<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  key:'<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14 9l2 2"/>',
  warn:'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  chevron:'<path d="m9 6 6 6-6 6"/>',
};
const svg=(n,s=14)=>`<svg class="i" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

// Height + fade in/out for blocks that join or leave the flow (so neighbours glide instead of jumping).
function reveal(el){
  if(!el?.animate||reduced())return;
  const h=el.offsetHeight;
  el.animate([{opacity:0,height:0,marginTop:0,marginBottom:0,overflow:'hidden'},{opacity:1,height:h+'px',overflow:'hidden'}],{duration:180,easing:EASE});
}
function leave(el){
  if(!el)return Promise.resolve();
  el.classList.add('ak-leaving');
  if(!el.animate||reduced()){el.remove();return Promise.resolve()}
  const a=el.animate([{opacity:1,height:el.offsetHeight+'px',overflow:'hidden'},{opacity:0,height:0,paddingTop:0,paddingBottom:0,marginTop:0,marginBottom:0,borderTopWidth:0,overflow:'hidden'}],{duration:160,easing:'ease-in',fill:'forwards'});
  return Promise.race([a.finished.catch(()=>{}),new Promise(r=>setTimeout(r,300))]).then(()=>el.remove());
}
async function copy(btn,text){
  try{await navigator.clipboard.writeText(text)}
  catch{const t=document.createElement('textarea');t.value=text;t.style.cssText='position:fixed;opacity:0';document.body.append(t);t.select();try{document.execCommand('copy')}catch{}t.remove()}
  const label=btn.querySelector('span');if(!label)return;
  clearTimeout(btn._t);btn.classList.add('done');btn.querySelector('.i').outerHTML=svg('check');label.textContent='Copied';
  btn._t=setTimeout(()=>{btn.classList.remove('done');btn.querySelector('.i').outerHTML=svg('copy');label.textContent='Copy'},1600);
}
const day=iso=>iso?new Date(iso).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'';
function ago(iso){
  if(!iso)return 'Never used';
  const s=(Date.now()-Date.parse(iso))/1000;
  if(s<90)return 'Used just now';if(s<5400)return `Used ${Math.round(s/60)} min ago`;if(s<129600)return `Used ${Math.round(s/3600)} h ago`;
  return 'Used '+day(iso);
}
const level=scopes=>scopes?.includes('admin')?'admin':scopes?.includes('write')?'write':'read';
const expired=k=>k.expiresAt&&Date.parse(k.expiresAt)<=Date.now();
// What is open and half typed outlives a redraw of the tab. The key itself is never kept.
const ui={form:false,use:false,snip:'curl',scope:'read',draft:{}};

async function api(method,path,body){
  const r=await fetch(path,{method,cache:'no-store',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||`Request failed (${r.status})`);
  return data;
}

export async function renderApiKeysTab(container){
  if(!container)return;
  const st={keys:[],envs:[],mode:'live'};
  container.innerHTML=`<div class="ak">
    <div class="acct-sec"><h3 class="acct-sub">Your keys</h3>${hint('API keys let scripts, the CLI and AI agents (MCP) read or change one of your environments without signing in.','API keys')}<span class="acct-sec-a"><button type="button" class="txt ak-add" id="akNewBtn" data-ak-toggle aria-expanded="${ui.form}" aria-controls="akForm">${svg('plus')}<span>New key</span></button></span></div>
    <div class="ak-slot" data-ak-reveal></div>
    <form class="ak-form" id="akForm" data-ak-form${ui.form?'':' hidden'}>
      <label class="ak-f"><span>Name</span><input id="akName" name="label" maxlength="80" placeholder="e.g. Claude on my laptop" required autocomplete="off" value="${esc(ui.draft.label||'')}"></label>
      <label class="ak-f"><span>Environment</span><select id="akEnv" name="env"><option value="*">All my environments</option></select></label>
      <div class="ak-f"><span id="akScopeL">Scopes</span><div class="seg txt ak-seg" role="radiogroup" aria-labelledby="akScopeL">${LEVELS.map(([v,n])=>`<button type="button" role="radio" id="akScope-${v}" data-ak-scope="${v}" aria-checked="${v===ui.scope}" class="${v===ui.scope?'on':''}">${n}</button>`).join('')}</div></div>
      <label class="ak-f"><span>Expires</span><select id="akExp" name="exp">${EXPIRY.map(([v,n])=>`<option value="${v}"${v===(ui.draft.exp??'90')?' selected':''}>${n}</option>`).join('')}</select></label>
      <div class="ak-foot"><p class="ak-care">${svg('warn')}<span>Treat a key like a password; anyone with it can act as you, within its scopes.</span></p><button type="submit" class="txt primary ak-create" id="akCreate">${svg('key')}<span>Create key</span></button></div>
    </form>
    <div class="ak-slot" data-ak-err></div>
    <ul class="ak-list" data-ak-list></ul>
    <div class="acct-sec acct-sec-disc"><h3 class="acct-sub"><button type="button" class="acct-disc" id="akUseBtn" data-ak-use aria-expanded="${ui.use}" aria-controls="akUse">${svg('chevron')}<span class="acct-disc-t">Use a key</span><span class="acct-disc-s">${SNIPPETS.map(([,n])=>esc(n)).join(' · ')}</span></button></h3></div>
    <div class="ak-snips" id="akUse" data-ak-snips${ui.use?'':' hidden'}></div>
  </div>`;
  const root=container.firstElementChild,$=s=>root.querySelector(s);
  const form=$('[data-ak-form]'),list=$('[data-ak-list]');
  const envSel=form.elements.env;
  const setForm=open=>{ui.form=open;form.hidden=!open;$('[data-ak-toggle]').setAttribute('aria-expanded',open)};

  const envName=id=>id==='*'?'All environments':st.envs.find(e=>e.id===id)?.name||id;
  const row=k=>`<li class="ak-row${k.revokedAt||expired(k)?' off':''}" data-key="${esc(k.id)}">
      <div class="ak-main"><span class="ak-n">${esc(k.name)}</span><code class="ak-pre">${esc(k.prefix)}…</code></div>
      <div class="ak-meta"><span class="ak-scope ${level(k.scopes)}">${esc(LEVELS.find(([v])=>v===level(k.scopes))[1])}</span><span>${esc(envName(k.env))}</span>
        <span>Created ${esc(day(k.createdAt))}</span><span>${esc(k.revokedAt?'Revoked '+day(k.revokedAt):expired(k)?'Expired '+day(k.expiresAt):ago(k.lastUsedAt))}</span>${!k.revokedAt&&!expired(k)&&k.expiresAt?`<span>Expires ${esc(day(k.expiresAt))}</span>`:''}</div>
      ${k.revokedAt?'':`<button type="button" class="txt ak-revoke" id="akRevoke-${esc(k.id)}" data-ak-revoke="${esc(k.id)}">Revoke</button>`}
    </li>`;
  const empty='<li class="ak-empty acct-muted">No keys yet. Choose New key to create one.</li>';
  // Active keys first; revoked and expired ones stay listed, faded, for the record.
  const sorted=()=>[...st.keys].sort((a,b)=>(!!(a.revokedAt||expired(a))-!!(b.revokedAt||expired(b)))||b.createdAt.localeCompare(a.createdAt));
  const drawList=()=>{list.innerHTML=st.keys.length?sorted().map(row).join(''):empty};
  const drawSnips=()=>{
    const s=SNIPPETS.find(([id])=>id===ui.snip)||SNIPPETS[0],focused=document.activeElement?.closest?.('[data-ak-snips]')?document.activeElement.id:'';
    $('[data-ak-snips]').innerHTML=`<div class="seg txt ak-tabs" role="radiogroup" aria-label="Snippet for">${SNIPPETS.map(([id,n])=>`<button type="button" role="radio" id="akSnip-${id}" data-ak-snip="${id}" aria-checked="${id===s[0]}" class="${id===s[0]?'on':''}">${n}</button>`).join('')}</div>
      <div class="ak-code"><pre id="akSnipCode" tabindex="0"><code>${esc(s[2](st.mode))}</code></pre><button type="button" class="txt ak-copy" id="akCopySnip" data-ak-copy-snip>${svg('copy')}<span>Copy</span></button></div>
      <p class="acct-muted ak-hint">Replace <code>&lt;your-flow-host&gt;</code>, <code>&lt;your-key&gt;</code> and <code>&lt;environment-id&gt;</code>. Keep keys in environment variables or a secret manager, not in code.</p>`;
    if(focused)document.getElementById(focused)?.focus();
  };
  const showErr=msg=>{
    const slot=$('[data-ak-err]'),cur=slot.querySelector(':scope>:not(.ak-leaving)');
    if(!msg){leave(cur);return}
    if(cur){cur.textContent=msg;popIn(cur);return}
    const p=document.createElement('p');p.className='acct-err';p.setAttribute('role','alert');p.textContent=msg;slot.replaceChildren(p);reveal(p);
  };
  const showKey=(key,k)=>{
    const slot=$('[data-ak-reveal]');slot.innerHTML=`<div class="ak-new" role="status">
      <div class="ak-warn">${svg('warn',16)}<div><strong>Copy “${esc(k.name)}” now. You won't see this key again.</strong><span>Only its prefix is kept for the list. If you lose it, revoke it and create a new one.</span></div></div>
      <div class="ak-keyrow"><input class="ak-key" readonly value="${esc(key)}" aria-label="New API key" spellcheck="false"><button type="button" class="txt primary ak-copy" data-ak-copy-key>${svg('copy')}<span>Copy</span></button></div>
      <div class="ak-actions"><button type="button" class="txt" data-ak-done>I've saved it</button></div></div>`;
    const box=slot.firstElementChild;reveal(box);
    const input=box.querySelector('.ak-key');input.focus();input.select();
  };

  root.addEventListener('click',async ev=>{
    const t=ev.target;
    if(t.closest('[data-ak-toggle]')){setForm(!ui.form);if(ui.form){reveal(form);form.elements.label.focus()}return}
    if(t.closest('[data-ak-use]')){ui.use=!ui.use;const b=$('[data-ak-snips]');b.hidden=!ui.use;$('[data-ak-use]').setAttribute('aria-expanded',ui.use);if(ui.use){reveal(b);b.scrollIntoView({block:'nearest'})}return}
    const sc=t.closest('[data-ak-scope]');
    if(sc){ui.scope=sc.dataset.akScope;for(const b of root.querySelectorAll('[data-ak-scope]')){const on=b===sc;b.classList.toggle('on',on);b.setAttribute('aria-checked',on)}return}
    const sn=t.closest('[data-ak-snip]');
    if(sn){if(ui.snip===sn.dataset.akSnip)return;ui.snip=sn.dataset.akSnip;drawSnips();$('[data-ak-snip].on')?.focus();enter($('[data-ak-snips]'),['.ak-code']);return}
    const ck=t.closest('[data-ak-copy-key]');
    if(ck){copy(ck,$('.ak-key').value);return}
    const cs=t.closest('[data-ak-copy-snip]');
    if(cs){copy(cs,$('[data-ak-snips] code').textContent);return}
    if(t.closest('[data-ak-done]')){
      const box=$('.ak-new');
      // Clear the key from the page before the box animates away.
      const k=box.querySelector('.ak-key');k.value='';k.blur();
      await leave(box);(ui.form?form.elements.label:$('[data-ak-toggle]')).focus();return;
    }
    const rv=t.closest('[data-ak-revoke]');
    if(rv){
      const k=st.keys.find(x=>x.id===rv.dataset.akRevoke);if(!k)return;
      if(!await ask(`Revoke “${k.name}”?\nAnything using ${k.prefix}… stops working at once. This cannot be undone.`,{ok:'Revoke',danger:true}))return;
      rv.disabled=true;
      try{
        await api('DELETE','/api/keys/'+encodeURIComponent(k.id));showErr('');
        k.revokedAt=new Date().toISOString();
        // The row leaves its place, then comes back faded among the revoked keys.
        const li=list.querySelector(`[data-key="${CSS.escape(k.id)}"]`);await leave(li);
        drawList();const back=list.querySelector(`[data-key="${CSS.escape(k.id)}"]`);reveal(back);
        // Its Revoke button is gone: focus the next key's, or New key.
        (list.querySelector('[data-ak-revoke]')||$('[data-ak-toggle]')).focus();
      }catch(e){rv.disabled=false;showErr(e.message)}
    }
  });
  root.addEventListener('keydown',ev=>{
    const g=ev.target.closest('[role=radiogroup]');if(!g||!['ArrowLeft','ArrowRight'].includes(ev.key))return;
    ev.preventDefault();const bs=[...g.querySelectorAll('button')],i=bs.indexOf(ev.target),n=bs[(i+(ev.key==='ArrowRight'?1:bs.length-1))%bs.length];
    n.focus();n.click();
  });
  // Half-typed values come back if the tab is redrawn.
  form.addEventListener('input',ev=>{if(ev.target.name)ui.draft[ev.target.name]=ev.target.value});
  form.addEventListener('submit',async ev=>{
    ev.preventDefault();
    const name=form.elements.label.value.trim();if(!name){form.elements.label.focus();return}
    const btn=form.querySelector('.ak-create');btn.disabled=true;
    try{
      const exp=form.elements.exp.value,{key,apiKey}=await api('POST','/api/keys',{name,env:form.elements.env.value,scopes:LEVELS.find(([v])=>v===ui.scope)[2],expiresInDays:exp?Number(exp):null});
      showErr('');form.elements.label.value='';ui.draft.label='';
      // The next key starts at the least access again, however this one was scoped.
      ui.scope='read';for(const b of root.querySelectorAll('[data-ak-scope]')){const on=b.dataset.akScope==='read';b.classList.toggle('on',on);b.setAttribute('aria-checked',on)}
      st.keys.unshift(apiKey);
      if(list.querySelector('.ak-empty'))list.innerHTML='';
      list.insertAdjacentHTML('afterbegin',row(apiKey));reveal(list.firstElementChild);
      setForm(false);showKey(key,apiKey);
    }catch(e){showErr(e.message)}
    finally{btn.disabled=false}
  });

  drawSnips();
  enter(root,['.ak-form .ak-f','.acct-sec-disc','.ak-snips']);
  const load=Promise.all([
    api('GET','/api/keys'),
    fetch('/api/environments',{cache:'no-store'}).then(r=>r.ok?r.json():{environments:[]}).catch(()=>({environments:[]})),
  ]).then(([k,e])=>{
    if(!root.isConnected)return;
    st.keys=k.keys||[];st.mode=k.mode==='test'?'test':'live';st.envs=e.environments||[];
    envSel.insertAdjacentHTML('beforeend',st.envs.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join(''));
    if(ui.draft.env&&[...envSel.options].some(o=>o.value===ui.draft.env))envSel.value=ui.draft.env;
    drawList();drawSnips();enter(list,['.ak-row']);
  }).catch(e=>{if(root.isConnected){list.innerHTML=empty;showErr(e.message)}});
  return busy(list,load,{rows:3,rowHeight:44});
}
