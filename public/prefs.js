// User preferences: {shortcuts:{id:[combos]}, settingsTab, ...} (room for reducedMotion, defaultTab…).
// Kept in localStorage (flygon-flow-prefs) as the offline cache and on the server per user
// (GET/PUT /api/prefs). On start the server copy wins; every change is written to both.
const KEY='flygon-flow-prefs',MAX=32000;
let prefs={shortcuts:{},settingsTab:'account'};
const listeners=new Set();
try{Object.assign(prefs,JSON.parse(localStorage.getItem(KEY))||{})}catch{}
if(!prefs.shortcuts||typeof prefs.shortcuts!=='object')prefs.shortcuts={};
const cache=()=>{try{localStorage.setItem(KEY,JSON.stringify(prefs))}catch{}};
let timer=0;
function push(){
  clearTimeout(timer);
  timer=setTimeout(()=>{const body=JSON.stringify(prefs);if(body.length<=MAX)fetch('/api/prefs',{method:'PUT',headers:{'Content-Type':'application/json'},body}).catch(()=>{})},300);
}
export const getPref=k=>prefs[k];
export function setPref(k,v){prefs={...prefs,[k]:v};cache();push();for(const f of listeners)f(prefs,k)}
export const onPrefs=f=>{listeners.add(f);return ()=>listeners.delete(f)};
export async function syncPrefs(){
  try{
    const r=await fetch('/api/prefs',{cache:'no-store'});if(!r.ok)return;
    const {prefs:server}=await r.json();
    if(server&&typeof server==='object'&&Object.keys(server).length){prefs={...prefs,...server,shortcuts:{...(server.shortcuts||{})}};cache();for(const f of listeners)f(prefs,'*')}
    else if(Object.keys(prefs.shortcuts).length||prefs.settingsTab!=='account')push();
  }catch{}
}
