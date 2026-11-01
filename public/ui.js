import {icon} from './icons.js';
import {popIn,popOut} from './motion.js';
import {initials,memberColor} from './devops-core.js';
export const $=(s,r=document)=>r.querySelector(s);
export const uid=()=>crypto.randomUUID();
export const clone=x=>structuredClone(x);
export const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const fileName=s=>s.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'export';

// Icon-only button. The tooltip text doubles as its accessible name.
export function ib(name,tip,{key='',cls='',attrs='',label=tip}={}){
  return `<button type="button" class="ib ${cls}" data-tip="${esc(tip)}"${key?` data-key="${esc(key)}"`:''} aria-label="${esc(label)}" ${attrs}>${icon(name)}</button>`;
}

export function download(name,text,type){
  const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// Tooltips: one themed floating element driven by [data-tip], optional data-key (shortcut),
// data-tip-pos ("right" | "top") and data-tip-delay (ms). Use data-tip instead of title=: it shows
// on hover and keyboard focus, stays inside the viewport, animates in (not under reduced motion)
// and is linked to its element with aria-describedby while visible.
const tip=document.createElement('div');tip.className='tip';tip.id='flow-tip';tip.setAttribute('role','tooltip');
let tipFor=null,tipTimer=0,hiddenAt=0;
function place(el){
  if(!el.isConnected||!el.dataset.tip)return;
  tip.innerHTML=esc(el.dataset.tip)+(el.dataset.key?`<kbd>${esc(el.dataset.key)}</kbd>`:'');
  const host=el.closest('dialog[open]')||document.body;if(tip.parentElement!==host)host.append(tip);
  tip.classList.add('on');tipFor=el;
  const descriptions=new Set((el.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));descriptions.add(tip.id);el.setAttribute('aria-describedby',[...descriptions].join(' '));
  // Measure independently of the previous anchor's position. Otherwise a tip
  // near the right edge can shrink to its remaining available width.
  tip.style.left='0px';tip.style.top='0px';
  const r=el.getBoundingClientRect(),t={width:tip.offsetWidth,height:tip.offsetHeight},pos=el.dataset.tipPos;
  let left,top;
  if(pos==='right'){left=r.right+8;if(left+t.width>innerWidth-8)left=r.left-t.width-8;top=r.top+r.height/2-t.height/2}
  else{left=r.left+r.width/2-t.width/2;const above=r.top-t.height-6,below=r.bottom+6;top=(pos==='top'&&above>=8)||below+t.height>innerHeight-8?above:below}
  tip.style.left=Math.max(8,Math.min(innerWidth-t.width-8,left))+'px';
  tip.style.top=Math.max(8,Math.min(innerHeight-t.height-8,top))+'px';
}
export function hideTip(){clearTimeout(tipTimer);if(tip.classList.contains('on'))hiddenAt=Date.now();tip.classList.remove('on');if(tipFor){const ids=(tipFor.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==tip.id);if(ids.length)tipFor.setAttribute('aria-describedby',ids.join(' '));else tipFor.removeAttribute('aria-describedby')}tipFor=null}
export function initTooltips(){
  document.body.append(tip);
  // pointermove (not pointerover) so a tip recovers after re-renders or scroll-hides under a still pointer.
  document.addEventListener('pointermove',e=>{
    if(e.pointerType==='touch')return;
    const el=e.target.closest?.('[data-tip]');if(el===tipFor&&el?.isConnected)return;
    const warm=tip.classList.contains('on')||Date.now()-hiddenAt<300;
    hideTip();if(!el||e.buttons)return;
    tipFor=el;tipTimer=setTimeout(()=>place(el),warm?0:Number(el.dataset.tipDelay||350));
  });
  document.addEventListener('focusin',e=>{const el=e.target.closest?.('[data-tip]');hideTip();if(el?.matches(':focus-visible')){tipFor=el;place(el)}});
  document.addEventListener('focusout',hideTip);
  document.addEventListener('pointerout',e=>{if(!e.relatedTarget)hideTip()});
  const repositionOrHide=()=>{if(tipFor?.matches(':focus-visible'))place(tipFor);else hideTip()};
  document.addEventListener('scroll',repositionOrHide,{capture:true,passive:true});
  window.addEventListener('resize',repositionOrHide);
  window.addEventListener('blur',hideTip);
  for(const ev of ['pointerdown','wheel','keydown'])document.addEventListener(ev,hideTip,{capture:true,passive:true});
}

// ---------- person photos ----------
// personAvatar(node, {size, cls, tip}) is the one way to draw a person: a round bubble with their photo
// (node.image, or the signed-in user's own photo when node.email is theirs; display only, never saved),
// otherwise their initials in their memberColor. A photo that fails to load falls back to the initials.
// account.js reports the session user through setSessionUser().
let me=null;
export const setSessionUser=u=>{me=u?{email:String(u.email||'').trim().toLowerCase(),image:typeof u.image==='string'?u.image:''}:null};
export function personPhoto(n){
  if(!n)return '';if(typeof n.image==='string'&&n.image)return n.image;
  const e=String(n.email||'').trim().toLowerCase();
  return e&&me?.image&&e===me.email?me.image:'';
}
export const photoImg=src=>`<img class="pa-img" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false">`;
export function personAvatar(n,{size=0,cls='',tip=''}={}){
  const [bg,fg]=memberColor(n?.id||''),src=personPhoto(n);
  const st=`background:${bg};color:${fg}`+(size?`;width:${size}px;height:${size}px;font-size:${Math.max(7,Math.round(size*.4))}px`:'');
  return `<span class="bub${src?' has-photo':''}${cls?' '+cls:''}" style="${st}"${tip?` data-tip="${esc(tip)}"`:''}><span class="pa-txt">${esc(initials(n?.name))}</span>${src?photoImg(src):''}</span>`;
}
// A broken photo (expired link, offline) is removed so the initials underneath show.
document.addEventListener('error',e=>{const t=e.target;if(t?.classList?.contains('pa-img')){t.parentElement?.classList.remove('has-photo');t.remove()}},true);

// ---------- picker: a popover listbox for multi-select (default) or single-select ----------
// pickerButton(key, label, items, selected) renders the trigger ("Projects · 2" plus colour dots);
// openPicker(trigger, {items, selected, onChange, multi, placeholder}) opens the list under it.
// items: [{value, label, group?, sub?, color? | avatar:{text,bg,fg,img?} | icon | pill:{bg,fg}}].
// avatar.img (an http(s) or data:image URL) shows a photo over the initials; icon names an icons.js icon.
// onChange(values) fires on every change (live); the caller re-renders and the picker stays open,
// re-anchoring to the element with the same data-picker key. Keyboard: arrows, Enter/Space,
// Esc, Tab; typing filters. Click outside closes.
let picker=null;
export const safeImg=u=>typeof u==='string'&&/^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,])/i.test(u.trim())?u.trim():'';
const av=(a,cls)=>{const img=safeImg(a.img);return `<span class="bub ${cls}${img?' has-photo':''}" style="background:${a.bg};color:${a.fg}"><span class="pa-txt">${esc(a.text)}</span>${img?photoImg(img):''}</span>`};
const swatch=it=>it.avatar?av(it.avatar,'pk-av')
  :it.icon?`<span class="pk-ic">${icon(it.icon,13)}</span>`
  :it.color?`<i class="pk-sw" style="background:${it.color}"></i>`:'';
const dot=it=>it.avatar?av(it.avatar,'mini')
  :`<i class="pk-sw" style="background:${it.color||it.pill?.bg||'var(--line2)'}"></i>`;
export const pickerOpen=key=>picker?.key===key;
export function pickerButton(key,label,items,selected,{cls='',tip=''}={}){
  const sel=items.filter(i=>selected.includes(i.value)),n=sel.length;
  return `<button type="button" class="pk-btn${n?' on':''} ${cls}" data-picker="${esc(key)}" aria-haspopup="listbox" aria-expanded="${pickerOpen(key)}"${tip?` data-tip="${esc(tip)}"`:''}>${n?`<span class="pk-dots">${sel.slice(0,3).map(dot).join('')}</span>`:''}<span class="pk-t">${esc(label)}${n?` · ${n}`:''}</span>${icon('chevD',12)}</button>`;
}
export function closePicker(refocus=false){
  if(!picker)return;const p=picker;picker=null;p.el.classList.remove('picker');p.el.classList.add('picker','leaving');popOut(p.el);document.removeEventListener('pointerdown',p.out,true);removeEventListener('resize',p.place);
  p.anchor()?.setAttribute('aria-expanded','false');
  // The trigger may be re-rendered by the change; focus whichever element now carries its key.
  if(refocus)setTimeout(()=>p.anchor()?.focus());
}
export function openPicker(trigger,o){
  const key=trigger.dataset.picker;
  if(picker?.key===key){closePicker();return}
  closePicker();
  const multi=o.multi!==false,sel=new Set(o.selected||[]),id='pk-'+uid().slice(0,8),anchor=()=>document.querySelector(`[data-picker="${CSS.escape(key)}"]`);
  const el=document.createElement('div');el.className='picker';
  const search=o.search!==false;
  el.innerHTML=`<input class="pk-q" type="search" placeholder="${esc(o.placeholder||'Search')}" aria-label="Filter options" aria-controls="${id}" autocomplete="off" role="combobox" aria-expanded="true">
    <div class="pk-list" role="listbox" id="${id}" aria-multiselectable="${multi}" aria-label="${esc(o.label||'Options')}" tabindex="${search?-1:0}"></div>
    ${multi?`<div class="pk-foot"><button type="button" class="txt" data-pk="all">Select all</button><button type="button" class="txt" data-pk="clear">Clear</button></div>`:''}`;
  // Inside a modal dialog the popover must live in it (the top layer covers everything else).
  (trigger.closest('dialog[open]')||document.body).append(el);
  const list=el.querySelector('.pk-list'),input=el.querySelector('.pk-q');if(!search)input.hidden=true;
  const focusEl=search?input:list;let typed='',typedAt=0;
  let active=Math.max(0,o.items.findIndex(i=>sel.has(i.value))),q='';
  const vis=()=>o.items.filter(i=>!q||i.label.toLowerCase().includes(q)||String(i.sub||'').toLowerCase().includes(q));
  function draw(){
    const v=vis();active=Math.max(0,Math.min(active,v.length-1));let g;
    list.innerHTML=v.length?v.map((it,k)=>{const on=sel.has(it.value),head=it.group&&it.group!==g?(g=it.group,`<div class="pk-group" role="presentation">${esc(it.group)}</div>`):'';
      return head+`<div class="pk-opt${k===active?' active':''}" role="option" id="${id}-${k}" data-k="${k}" aria-selected="${on}">${multi?`<span class="pk-chk">${on?icon('check',11):''}</span>`:''}${swatch(it)}${it.pill?`<span class="pill" style="background:${it.pill.bg};color:${it.pill.fg}">${esc(it.label)}</span>`:`<span class="pk-l">${esc(it.label)}</span>`}${it.sub?`<small>${esc(it.sub)}</small>`:''}${!multi&&on?`<span class="pk-cur">${icon('check',13)}</span>`:''}</div>`}).join('')
      :`<div class="pk-empty">${esc(o.empty||'No matches')}</div>`;
    focusEl.setAttribute('aria-activedescendant',v.length?`${id}-${active}`:'');
    list.querySelector('.active')?.scrollIntoView({block:'nearest'});
  }
  const emit=()=>o.onChange?.(o.items.map(i=>i.value).filter(v=>sel.has(v)));
  function toggle(k){
    const it=vis()[k];if(!it)return;
    if(!multi){sel.clear();sel.add(it.value);emit();closePicker(true);return}
    if(sel.has(it.value))sel.delete(it.value);else sel.add(it.value);active=k;draw();emit();place();
  }
  function place(){
    const a=anchor()||trigger,r=a.getBoundingClientRect();el.style.minWidth=Math.max(220,r.width)+'px';
    const W=el.offsetWidth,H=el.offsetHeight;let top=r.bottom+4;if(top+H>innerHeight-6)top=Math.max(6,r.top-H-4);
    el.style.left=Math.max(6,Math.min(r.left,innerWidth-W-6))+'px';el.style.top=top+'px';
  }
  el.addEventListener('keydown',e=>{
    e.stopPropagation();const n=vis().length;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();active=(active+(e.key==='ArrowDown'?1:-1)+n)%Math.max(1,n);draw()}
    else if(e.key==='Enter'||(e.key===' '&&!input.value)){e.preventDefault();toggle(active)}
    else if(e.key==='Escape'){e.preventDefault();closePicker(true)}
    else if(e.key==='Tab')closePicker();
    else if(e.key==='Home'||e.key==='End'){e.preventDefault();active=e.key==='Home'?0:n-1;draw()}
    else if(!search&&e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
      // Type-ahead when there is no search box: jump to the next option starting with the typed text.
      typed=(Date.now()-typedAt<700?typed:'')+e.key.toLowerCase();typedAt=Date.now();
      const v=vis(),k=v.findIndex((it,i)=>i>=(typed.length>1?active:active+1)&&it.label.toLowerCase().startsWith(typed));
      const at=k>=0?k:v.findIndex(it=>it.label.toLowerCase().startsWith(typed));if(at>=0){active=at;draw()}
    }
  });
  input.addEventListener('input',()=>{q=input.value.trim().toLowerCase();active=0;draw()});
  el.addEventListener('click',e=>{
    const opt=e.target.closest('.pk-opt');if(opt){toggle(+opt.dataset.k);if(picker)focusEl.focus();return}
    const b=e.target.closest('[data-pk]');if(!b)return;
    if(b.dataset.pk==='all')for(const it of vis())sel.add(it.value);else sel.clear();
    draw();emit();place();
  });
  const out=e=>{if(!el.contains(e.target)&&!e.target.closest?.(`[data-picker="${CSS.escape(key)}"]`))closePicker()};
  picker={key,el,out,place,anchor};
  document.addEventListener('pointerdown',out,true);addEventListener('resize',place);
  trigger.setAttribute('aria-expanded','true');
  draw();place();popIn(el);focusEl.focus();
}

// ---------- single selects: native <select> elements get the same styled listbox ----------
// Every <select> (present or rendered later) gets a trigger button right after it. The native element
// stays in the DOM, hidden, and keeps its value, so code that reads .value or listens for "change"
// is unaffected. Opt out with data-native.
let selKey=0;
const selOf=b=>document.getElementById(b.dataset.for);
const selText=s=>s.selectedOptions[0]?.textContent||'';
function enhance(s){
  if(s.dataset.enhanced!==undefined||s.hasAttribute('data-native')||s.multiple)return;
  s.dataset.enhanced='';s.classList.add('sel-native');s.tabIndex=-1;s.setAttribute('aria-hidden','true');
  if(!s.id)s.id='sel-'+(++selKey);
  const key='sel:'+(s.dataset.dsel||s.dataset.setSelect||s.id);
  const b=document.createElement('button');b.type='button';b.className='sel-btn';b.dataset.picker=key;b.dataset.for=s.id;
  b.setAttribute('aria-haspopup','listbox');b.setAttribute('aria-expanded',String(pickerOpen(key)));
  const lab=s.getAttribute('aria-label')||document.querySelector(`label[for="${CSS.escape(s.id)}"]`)?.textContent.trim()||'';
  if(lab)b.setAttribute('aria-label',`${lab}: ${selText(s)}`);
  if(s.dataset.tip)b.dataset.tip=s.dataset.tip;
  b.disabled=s.disabled;b.innerHTML=`<span class="sel-t">${esc(selText(s))}</span>${icon('chevD',12)}`;
  s.after(b);
}
function sync(s){
  const b=s.nextElementSibling;if(!b?.classList.contains('sel-btn'))return;
  b.querySelector('.sel-t').textContent=selText(s);b.disabled=s.disabled;
  const l=b.getAttribute('aria-label');if(l)b.setAttribute('aria-label',l.replace(/: [^]*$/,': '+selText(s)));
}
export function enhanceSelects(root=document){for(const s of root.querySelectorAll('select'))enhance(s)}
export function initSelects(){
  enhanceSelects();
  let queued=false;
  new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;enhanceSelects()})}).observe(document.body,{childList:true,subtree:true});
  document.addEventListener('change',e=>{if(e.target.matches?.('select.sel-native'))sync(e.target)},true);
  // A <label for> click focuses the hidden select: move focus to its trigger instead.
  document.addEventListener('focusin',e=>{if(e.target.matches?.('select.sel-native'))e.target.nextElementSibling?.focus()});
  document.addEventListener('click',e=>{
    const b=e.target.closest?.('.sel-btn');if(!b)return;
    const s=selOf(b);if(!s||s.disabled)return;
    const items=[...s.options].filter(o=>!o.disabled).map(o=>({value:o.value,label:o.textContent,group:o.parentElement.tagName==='OPTGROUP'?o.parentElement.label:undefined}));
    openPicker(b,{items,selected:[s.value],multi:false,search:items.length>8,label:b.getAttribute('aria-label')?.split(':')[0]||'Options',placeholder:'Search',
      onChange([v]){const cur=selOf(b)||s;if(cur.value===v)return;cur.value=v;cur.dispatchEvent(new Event('change',{bubbles:true}));sync(cur)}});
  });
  document.addEventListener('keydown',e=>{
    const b=e.target.closest?.('.sel-btn');if(!b||!['ArrowDown','ArrowUp','Enter',' '].includes(e.key))return;
    e.preventDefault();e.stopPropagation();b.click();
  },true);
}

