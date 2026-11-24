// Combined view in the browser (rules: combined-core.js; docs/combined.md). The environments to show
// with the open one are a per-user preference (prefs.js `combinedEnvs`, kept on the server with the
// other prefs); the server does the combining when sync.js asks for the workspace with ?combine=.
//
//   combinedIds()            the environments combined with the open one, in order.
//   setCombined(id,on)       add or remove one (the workspace is read again).
//   pruneCombined(list)      drop ids that are not among the user's environments any more.
//   combinedLegend()         "Combined: N environments" and a chip per environment (× removes it), for the
//                            DevOps and Timeline toolbars. Empty when nothing is combined.
//   envBadge(x)              a small chip naming the environment a combined record comes from.
import {store} from './store.js';
import {esc} from './ui.js';
import {icon} from './icons.js';
import {getPref,setPref,onPrefs} from './prefs.js';
import {currentEnv,refresh} from './sync.js';
import {cleanCombine,envOf} from './combined-core.js';

export const combinedIds=()=>cleanCombine(getPref('combinedEnvs'),currentEnv()||'');
const all=()=>cleanCombine(getPref('combinedEnvs'));
export function setCombined(id,on){
  const now=all().filter(x=>x!==id);
  setPref('combinedEnvs',on?[...now,id]:now);
}
export function pruneCombined(list){
  if(!Array.isArray(list)||!list.length)return;
  const ids=new Set(list.map(e=>e.id)),now=all(),keep=now.filter(x=>ids.has(x));
  if(keep.length!==now.length)setPref('combinedEnvs',keep);
}
// What the server combined (db.combined), in the order chosen.
export const combinedMeta=()=>store.db?.combined||[];
export const envName=env=>combinedMeta().find(m=>m.env===env)?.name||'';
// Re-read the workspace when the choice changes (here, in Settings, or from another device's prefs).
let last=combinedIds().join(',');
onPrefs((p,k)=>{
  if(k!=='*'&&k!=='combinedEnvs')return;
  const now=combinedIds().join(',');
  if(now!==last){last=now;refresh()}
});

// A stable hue per environment, so its chip and its cards' badges match.
function hue(env){let h=0;for(const ch of String(env))h=(h*31+ch.charCodeAt(0))%360;return h}
const chipStyle=env=>`--cx:hsl(${hue(env)} 45% 42%)`;
// tip: the tooltip ('' for none, as inside rows that carry their own); shared: it is a share placed there.
export function envBadge(x,{inline=false,tip,shared=false}={}){
  const env=envOf(x);if(!env)return '';
  const name=envName(env)||'Another environment',t=tip===undefined?`From ${name}\nEdits go back to ${name}`:tip;
  return `<span class="cx-badge${inline?' in':''}" style="${chipStyle(env)}"${t?` data-tip="${esc(t)}"`:''} role="img" aria-label="${esc(`From ${name}${shared?', shared with you there':''}`)}">${shared?icon('link',9):''}${esc(name)}</span>`;
}
export function combinedLegend(){
  const m=combinedMeta();if(!m.length)return '';
  const home=store.db.environment?.name||'This environment',n=m.length+1;
  return `<div class="cx-legend" role="group" aria-label="Combined: ${n} environments"><span class="cx-k">${icon('layers',13)}Combined: ${n} environments</span>
    <span class="cx-chip home" data-tip="The open environment: new cards and projects go here">${esc(home)}</span>
    ${m.map(e=>`<span class="cx-chip" style="${chipStyle(e.env)}"><span>${esc(e.name)}</span><button type="button" class="cx-x" data-cx-hide="${esc(e.env)}" aria-label="${esc(`Stop showing ${e.name}`)}" data-tip="Stop showing ${esc(e.name)} here">${icon('x',10)}</button></span>`).join('')}</div>`;
}
document.addEventListener('click',e=>{
  const b=e.target instanceof Element&&e.target.closest('[data-cx-hide]');if(!b)return;
  e.preventDefault();setCombined(b.dataset.cxHide,false);
});
