import {esc} from './ui.js';
import {enter} from './motion.js';

// DevLog (Bradshaw-versioned release registry). The server serves it a page at a time
// (GET /api/devlog?page=N&q=text, 10 per page); the first page also carries the current version
// for the account menu. Settings › DevLog renders it with search and compact pagination.
const REPO='https://github.com/aribradshaw/devlog';
let first=null,loading=null;
const get=(page=1,q='')=>fetch(`/api/devlog?page=${page}${q?`&q=${encodeURIComponent(q)}`:''}`,{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null);
export const loadDevlog=()=>loading||=get().then(d=>first=d);
export const currentVersion=()=>first?.current||'';
const COMPAT={compatible:'',['action-required']:'Action required',breaking:'Breaking'};
const day=s=>new Date(s+'T12:00:00').toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});
// Compact page list: 1 … 4 5 6 … 12
export function pageItems(page,pages){
  if(pages<=7)return Array.from({length:pages},(_,i)=>i+1);
  const set=[1,pages,page-1,page,page+1].filter(p=>p>=1&&p<=pages),out=[];
  for(const p of [...new Set(set)].sort((a,b)=>a-b)){if(out.length&&p-out.at(-1)>1)out.push('…');out.push(p)}
  return out;
}
function listHtml(d){
  if(!d)return '<div class="hp-empty">DevLog unavailable</div>';
  if(!d.entries.length)return '<div class="hp-empty">No releases match</div>';
  return `<ol class="hp-list">${d.entries.map(e=>`<li><div class="hp-row"><span class="hp-v">${esc(e.version)}</span><span class="hp-t">${esc(e.title)}</span>${COMPAT[e.compatibility]?`<span class="hp-c ${esc(e.compatibility)}"${e.action?` data-tip="${esc(e.action)}" tabindex="0"`:''}>${COMPAT[e.compatibility]}</span>`:''}</div>
      <div class="hp-meta">${esc(day(e.date))}${e.commit&&d.repository?` · <a href="${esc(d.repository)}/commit/${esc(e.commit)}" target="_blank" rel="noopener">${esc(e.commit.slice(0,7))}</a>`:''}</div>
      ${e.notes?.length?`<ul class="hp-notes">${e.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`:''}</li>`).join('')}</ol>
    ${d.pages>1?`<nav class="hp-pager" aria-label="DevLog pages"><button type="button" class="ib" data-dl-page="${d.page-1}"${d.page<=1?' disabled':''} aria-label="Previous page">‹</button>${pageItems(d.page,d.pages).map(p=>p==='…'?'<span class="hp-gap">…</span>':`<button type="button" class="hp-p${p===d.page?' on':''}" data-dl-page="${p}"${p===d.page?' aria-current="page"':''}>${p}</button>`).join('')}<button type="button" class="ib" data-dl-page="${d.page+1}"${d.page>=d.pages?' disabled':''} aria-label="Next page">›</button></nav>`:''}`;
}
// Mounts the DevLog view into an element (Settings tab).
export async function mountDevlog(el){
  const d=await loadDevlog();
  el.innerHTML=`<div class="hp-ver"><span>Flygon Flow <b>${esc(d?.current||'')}</b></span><a class="hp-by" href="${REPO}" target="_blank" rel="noopener">Powered by DevLog ↗</a></div>
    <input class="hp-q" type="search" placeholder="Search releases" aria-label="Search releases"><div class="hp-body" aria-live="polite">${listHtml(d)}</div>`;
  const body=el.querySelector('.hp-body');let q='',seq=0;
  const show=async page=>{const n=++seq,data=await get(page,q);if(n!==seq)return;body.innerHTML=listHtml(data);enter(body,['.hp-list>li','.hp-pager'])};
  el.addEventListener('click',e=>{const b=e.target.closest('[data-dl-page]');if(b&&!b.disabled)show(+b.dataset.dlPage)});
  let t=0;el.querySelector('.hp-q').addEventListener('input',e=>{q=e.target.value.trim();clearTimeout(t);t=setTimeout(()=>show(1),180)});
}
