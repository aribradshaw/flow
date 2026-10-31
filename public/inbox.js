import {store,applyDb,step,PALETTE} from './store.js';
import {esc,clone} from './ui.js';
import {applyPatch} from './inbox-core.js';
import {popIn} from './motion.js';

// Agent inbox (client): on load and every 20 s while the tab is visible, fetch pending patches for this
// workspace's environment, claim each one (so only one tab or browser applies it), then merge it as one
// undoable step through the normal store path (validated, saved to browser storage and the disk backup).
const EVERY=20000;
let running=false,timer=0;
export function startInbox(){
  setTimeout(poll,800); // after the store has settled its environment (see store.js)
  timer=setInterval(()=>{if(document.visibilityState==='visible')poll()},EVERY);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')poll()});
}
export async function poll(){
  if(running)return;running=true;
  try{
    const r=await fetch('/api/inbox',{cache:'no-store'});if(!r.ok)return;
    const {patches=[]}=await r.json(),env=store.db.environment?.id;
    for(const p of patches){
      if((p.env||'default-workspace')!==env)continue;
      const claim=await fetch(`/api/inbox/${encodeURIComponent(p.id)}/ack`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if(!claim.ok)continue;
      const next=clone(store.db),res=applyPatch(next,p,{palette:PALETTE});
      if(res.notes.length)console.info(`Inbox ${p.id} (${p.source}):\n`+res.notes.join('\n'));
      if(!res.changed){if(res.notes.length)notify(`${p.source}: nothing new · kept ${res.notes.length} of your edit${res.notes.length===1?'':'s'}`);continue}
      applyDb(next);
      notify(res.summary+(res.notes.length?` · kept ${res.notes.length} of your edit${res.notes.length===1?'':'s'}`:''),store.undo.length);
    }
  }catch{}finally{running=false}
}
// Toast with Undo (only while this patch is still the latest undo step).
let hideTimer=0;
function notify(text,undoAt){
  let el=document.getElementById('inboxToast');
  if(!el){el=document.createElement('div');el.id='inboxToast';el.setAttribute('role','status');document.body.append(el)}
  el.innerHTML=`<span>${esc(text)}</span>${undoAt?'<button type="button" data-undo>Undo</button>':''}`;
  el.className='on';popIn(el);
  el.querySelector('[data-undo]')?.addEventListener('click',()=>{if(store.undo.length===undoAt)step(-1);el.className=''});
  clearTimeout(hideTimer);hideTimer=setTimeout(()=>el.className='',9000);
}
