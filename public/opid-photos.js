// Linked cards' OneProfileID photos (docs/concepts/10-opid-photos.md). The server looks them up live for
// the cards this user sees in the current environment; they are shown only, never saved.
// Loaded on start, when the environment or its set of linked cards changes, and when the window
// regains focus. linkCard() links a card to the signed-in user's own account (or unlinks it).
import {setMemberPhotos} from './ui.js';
import {linkedPhotoIds} from './opid-prompt-core.js';
import {fadeIn} from './motion.js';
import {currentEnv,refresh} from './sync.js';
import {sessionUser,signInMode} from './account.js';

let rerender=()=>{},getDb=()=>null,key='',loading=null,again=false;
const enabled=()=>signInMode()==='opid'&&!!sessionUser()?.id;

export async function loadPhotos(){
  if(loading){again=true;return loading}
  loading=(async()=>{
    try{
      const env=currentEnv();
      if(!enabled()||!env||!linkedPhotoIds(getDb()).length){apply({});return}
      const r=await fetch('/api/opid/photos?env='+encodeURIComponent(env),{cache:'no-store'});
      // Not available (signed out, OneProfileID not ready): keep what is shown.
      if(r.ok)apply(await r.json().catch(()=>({})));
    }catch{}
  })();
  try{await loading}finally{loading=null;if(again){again=false;loadPhotos()}}
}
function apply(map){
  const fresh=setMemberPhotos(map&&typeof map==='object'&&!Array.isArray(map)?map:{});
  if(!fresh)return;
  rerender();
  if(fresh.length){const urls=new Set(fresh);fadeIn([...document.querySelectorAll('img.pa-img')].filter(i=>urls.has(i.getAttribute('src'))))}
}
// Called after every render: a new environment or a card linked or unlinked loads the photos again.
export function photosMaybe(){
  const k=(enabled()?currentEnv()||'':'')+'\n'+linkedPhotoIds(getDb()).join(',');
  if(k===key)return;key=k;queueMicrotask(loadPhotos);
}
export function startOpidPhotos({db,render}){
  getDb=db;rerender=render;
  addEventListener('focus',()=>loadPhotos());
  addEventListener('flow:session',()=>{key='';photosMaybe()});
}
// -> {ok} | {ok:false, error}
export async function linkCard(nodeId,link){
  try{
    const r=await fetch('/api/opid/link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({env:currentEnv(),nodeId,link})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)return {ok:false,error:d.error||'Could not change the link. Try again.'};
    await refresh();key='';photosMaybe();
    return {ok:true};
  }catch{return {ok:false,error:'Could not reach the server. Try again.'}}
}
