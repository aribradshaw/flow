import {store,adoptRemote} from './store.js';
import {merge3,same,size,isSeed,fieldBase,clashes,withHeld} from './sync-core.js';

// Server sync: the server's copy of the environment is the source of truth; browser storage is the
// offline cache. On load the browser asks the server for its workspace:
//   - server empty  -> upload the local workspace (never replace local data with an empty copy);
//   - fresh browser -> take the server copy;
//   - both changed  -> merge per entity and field (sync-core.js merge3), then upload the result.
// Every edit is sent (debounced) with the revision it started from; if the server moved on, the
// browser merges and retries. Remote changes are picked up every 20 s while the tab is visible.
const SKEY='flygon-flow-sync-v1',DEBOUNCE=700,POLL=20000;
// shared: the server's signature of shares placed in this environment (owner edits change it, not rev).
// held: fields a merge kept from this copy over someone else's change (sync-core clashes), sent once.
let st={env:null,rev:0,base:null,dirty:false,shared:'',held:null};
try{Object.assign(st,JSON.parse(localStorage.getItem(SKEY))||{})}catch{}
const persist=()=>{try{localStorage.setItem(SKEY,JSON.stringify(st))}catch{}};
let via='',timer=0,busy=false,again=false,edits=0,backoff=0,stopped=false,allowShrink=false;
const status=(s,t)=>store.onStatus(s,t);
const time=()=>new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
// Conflicts this user lost on shared records, from the server (share.js shows them on the field).
const keepConflicts=list=>{if(Array.isArray(list))store.conflicts=list};
const take=(data,rev,env,shared='',conflicts)=>{keepConflicts(conflicts);adoptRemote(data);st={env,rev,base:data,dirty:false,shared,held:null};persist()};
// Remember fields both sides changed before a merge keeps this copy's value.
const hold=(base,local,remote)=>{const c=clashes(base,local,remote);if(Object.keys(c).length)st.held=withHeld(st.held,c)};

export function startSync(){
  store.onSaved=({replace}={})=>{st.dirty=true;edits++;if(replace)allowShrink=true;persist();schedule(DEBOUNCE)};
  // Local edits made while the page was closed (or by another tool) count as unsynced.
  if(st.base&&!same(store.db,st.base))st.dirty=true;
  pull();
  setInterval(()=>{if(document.visibilityState==='visible')pull()},POLL);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pull()});
  addEventListener('online',()=>pull());
}
function schedule(ms){clearTimeout(timer);timer=setTimeout(push,ms)}

async function get(env,since){
  const q=new URLSearchParams();if(env)q.set('env',env);if(since){q.set('since',since);if(st.shared)q.set('shared',st.shared)}
  const r=await fetch('/api/workspace'+(q.size?'?'+q:''),{cache:'no-store'});
  return {status:r.status,data:await r.json().catch(()=>({}))};
}
export async function pull(){
  if(busy||stopped)return;busy=true;
  try{
    // A browser holding only the sample chart asks for the user's own default workspace (for Owner:
    // Default workspace) instead of its stale local environment, and never uploads the sample.
    const blank=(store.fresh||isSeed(store.db))&&!edits;
    const env=blank?'':st.env||store.db.environment.id;
    let r;try{r=await get(env,st.env&&st.rev?st.rev:0)}catch{status('warn','Offline · changes stay in this browser and sync when the server is back');return}
    if(r.status===404&&env){
      // Not this user's environment (another person's cache in this browser, or an archived one):
      // switch to the user's own default. The other copy stays in the disk backup.
      const d=await get('',0).catch(()=>null);
      if(d?.status===200&&d.data.env&&d.data.data){take(d.data.data,d.data.rev,d.data.env,d.data.shared,d.data.conflicts);status('ok','Opened your workspace');}
      else stopped=true;
      return;
    }
    if(r.status===401||r.status===403||r.status===404){stopped=r.status!==401;return}
    if(r.status!==200)return;
    const d=r.data;if(d.via)via=d.via;
    if(d.unchanged){if(st.dirty)schedule(0);return}
    if(d.offline){status('warn','Offline · changes stay in this browser and sync when the server is back');return}
    if(!d.env||!d.data){
      // Nothing on the server yet: upload what this browser has, unless it is an untouched new
      // workspace (that would only plant a sample chart; the first real edit uploads it).
      if(blank){st.env=d.env||null;persist();return}
      st.env=d.env||store.db.environment.id;st.rev=0;st.base=null;st.dirty=true;persist();
      if(store.db.environment.id!==st.env)store.db.environment={...store.db.environment,id:st.env};
      schedule(0);return;
    }
    const local=store.db,fresh=blank;
    if(d.env!==local.environment?.id&&!fresh&&size(local)>14&&!st.env){
      // This browser holds a different, non-trivial workspace: keep it as its own environment.
      st.env=local.environment.id;st.rev=0;st.dirty=true;persist();schedule(0);return;
    }
    if(fresh||(!st.dirty&&st.env===d.env)){take(d.data,d.rev,d.env,d.shared,d.conflicts);status('ok',`Up to date with ${via||'the server'} · rev ${d.rev} · ${time()}`);return}
    // Both sides have changes: merge, keep both copies (server history + disk backup), upload.
    const merged=merge3(st.env===d.env?st.base??undefined:undefined,local,d.data);
    if(st.env===d.env)hold(st.base,local,d.data);
    keepConflicts(d.conflicts);adoptRemote(merged);st={env:d.env,rev:d.rev,base:d.data,dirty:!same(merged,d.data),shared:d.shared||'',held:st.env===d.env?st.held:null};persist();
    if(st.dirty)schedule(0);else status('ok',`Up to date with ${via||'the server'} · rev ${d.rev} · ${time()}`);
  }finally{busy=false;if(again){again=false;schedule(0)}}
}
async function push(){
  if(stopped||!st.dirty)return;
  if(busy){again=true;return}
  busy=true;let retry=0;
  try{
    for(let loop=0;loop<4;loop++){
      if(!st.env)st.env=store.db.environment.id;
      // Never plant the untouched sample chart on the server as a workspace.
      if(isSeed(store.db)&&!st.base){st.dirty=false;persist();return}
      const sent=JSON.parse(JSON.stringify(store.db)),e0=edits;
      // What this copy held before each field it changed (shared records: docs/sharing.md).
      const base=st.base?withHeld(fieldBase(st.base,sent),st.held):null;
      status('saving','Saving to the server…');
      let r;
      try{r=await fetch(`/api/workspace?env=${encodeURIComponent(st.env)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRev:st.rev,data:sent,...(base?{fieldBase:base}:{}),...(allowShrink?{allowShrink:true}:{})})});}
      catch{r=null}
      const d=r?await r.json().catch(()=>({})):{};
      if(r?.status===200){if(d.via)via=d.via;allowShrink=false;backoff=0;st.rev=d.rev;st.base=sent;st.held=null;st.dirty=edits!==e0;
        // Shared cards: the server re-projects them (refused edits come back), so read the result.
        if(d.shared){st.shared='';setTimeout(pull,400)}
        // The server kept runners as they reported themselves (this copy was missing some), or a higher
        // next card number than this copy had: read them back.
        if(d.runnersKept||d.countersKept){st.shared='\u0000';setTimeout(pull,400)}
        persist();status('ok',`Saved to ${via||'the server'} · rev ${d.rev} · ${time()}`);if(st.dirty)retry=1;return}
      if(r?.status===409&&d.data){
        const merged=merge3(st.base??undefined,store.db,d.data);
        hold(st.base,store.db,d.data);
        adoptRemote(merged);st.rev=d.rev;st.base=d.data;st.dirty=true;persist();continue;
      }
      if(r?.status===422){status('warn',d.error||'The server refused a save that would remove most of the workspace');return}
      if(r&&r.status>=400&&r.status<500){status('warn',d.error||'The server refused the save');if(r.status!==401)stopped=true;return}
      // Offline or server error: keep the changes and try again later.
      backoff=Math.min(60000,(backoff||2500)*2);status('warn','Saved in this browser · server unreachable, retrying');retry=backoff;return;
    }
  }finally{busy=false;if(retry)schedule(retry);else if(again){again=false;schedule(0)}}
}

// Environments: list the user's own, switch, create, rename, archive.
export const currentEnv=()=>st.env||store.db.environment?.id;
export async function listEnvironments(){try{const r=await fetch('/api/environments',{cache:'no-store'});return r.ok?(await r.json()).environments:[]}catch{return []}}
export async function switchEnvironment(id){
  if(st.dirty){clearTimeout(timer);await push()}
  if(st.dirty)throw Error('Your latest changes are not saved to the server yet. Try again in a moment.');
  const r=await get(id,0);
  if(r.status!==200||!r.data.data)throw Error(r.data.error||'Could not open that environment');
  take(r.data.data,r.data.rev,r.data.env,r.data.shared,r.data.conflicts);stopped=false;
}
// Re-read the current environment now (e.g. after adding or removing a share).
export async function refresh(){st.shared='\u0000';persist();for(let i=0;i<20&&busy;i++)await new Promise(r=>setTimeout(r,100));await pull()}
async function call(method,path,body){
  const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d;
}
export const createEnvironment=name=>call('POST','/api/environments',{name}).then(d=>d.id);
export async function renameEnvironment(id,name){await call('PATCH','/api/environments/'+encodeURIComponent(id),{name});if(id===currentEnv()){await pull()}}
export const archiveEnvironment=id=>call('DELETE','/api/environments/'+encodeURIComponent(id));
