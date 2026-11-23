// Alerts outside the 3D office (docs/concepts/12-office.md): while the app is open and "Notify me when
// agents wait" is on (the office's HUD; the officeNotify preference), the app keeps one small stream open,
// GET /api/office/alerts, which carries only the signed-in person's own agents. Each time one of them
// starts waiting, a browser notification says so (clicking it opens the office on that agent), and the
// AgentFlow toolbar's 3D button shows how many wait. Off: no stream at all.
import {getPref,setPref,onPrefs} from './prefs.js';

const PREF='officeNotify';
let es=null,waiting=[],fails=0,timer=0,open=null,started=false;
export const notifyOn=()=>!!getPref(PREF);
export const waitingCount=()=>waiting.length;
// The 3D button's badge, as HTML (agentflow.js renders it into its toolbar).
export const badgeHtml=()=>waiting.length?`<span class="af-badge" aria-label="${waiting.length} waiting">${waiting.length>9?'9+':waiting.length}</span>`:'';

// open({source, id}): opens the office focused on that agent (agentflow.js).
export function startOfficeAlerts(opts={}){
  open=opts.open||open;if(started)return;started=true;
  onPrefs((p,k)=>{if(k===PREF||k==='*')sync()});sync();
}
function sync(){
  if(notifyOn()&&!es)connect();
  else if(!notifyOn()){stop();waiting=[];paint()}
}
function stop(){clearTimeout(timer);timer=0;if(es){es.close();es=null}}
function connect(){
  stop();const s=new EventSource('/api/office/alerts');es=s;
  s.addEventListener('mine',e=>{if(es!==s)return;fails=0;try{waiting=JSON.parse(e.data).waiting||[]}catch{waiting=[]}paint()});
  s.addEventListener('waiting',e=>{if(es!==s)return;try{notify(JSON.parse(e.data))}catch{}});
  // The browser reconnects by itself after a dropped connection; when it gives up (signed out, a
  // server error), try again later, waiting longer each time (up to 5 minutes).
  s.onerror=()=>{if(es!==s||s.readyState!==EventSource.CLOSED)return;es=null;fails++;timer=setTimeout(()=>{timer=0;if(notifyOn()&&!es)connect()},Math.min(300e3,3e3*2**Math.min(fails,7)))};
}
const officeOpenHere=()=>!!document.querySelector('.of');
function notify(a){
  // The office open in this tab shows it itself: the agent walks over and pings.
  if(officeOpenHere()||typeof Notification==='undefined'||Notification.permission!=='granted')return;
  const title=`${a.title||'Your agent'} is waiting`,body=[a.pending?.summary||(a.pending?.kind==='question'?'It has a question for you.':'It needs you.'),a.host].filter(Boolean).join(' · ');
  try{
    // One notification per agent: a tag shared by every tab, so several open tabs show it once.
    const n=new Notification(title,{body,tag:`flow-office:${a.source}:${a.id}`,icon:'/favicon.svg'});
    n.onclick=()=>{try{window.focus()}catch{}n.close();open?.({source:a.source,id:a.id})};
  }catch{}
}
function paint(){
  for(const b of document.querySelectorAll('.af-office')){b.querySelector('.af-badge')?.remove();if(waiting.length)b.insertAdjacentHTML('beforeend',badgeHtml())}
}
// The HUD's toggle. Asks for permission once (only while the browser has not been asked).
// -> 'granted' | 'denied' | 'unsupported' when turned on, false when turned off.
export async function toggleNotify(){
  if(notifyOn()){setPref(PREF,false);return false}
  let p='unsupported';
  if(typeof Notification!=='undefined'){p=Notification.permission;if(p==='default')try{p=await Notification.requestPermission()}catch{p='denied'}}
  setPref(PREF,true);return p==='default'?'denied':p;
}
