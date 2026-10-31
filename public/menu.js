import {icon} from './icons.js';
import {esc} from './ui.js';
import {popIn,popOut} from './motion.js';

// Right-click (context) menus, shared by every canvas.
//   openMenu(at, items, {label})
//     at: the contextmenu event (opens at the pointer; a keyboard-opened menu, from the menu key or
//         Shift+F10, opens under the focused element), an Element (opens under it) or {x, y}.
//     items: [{label, icon, key, danger, disabled, checked, run(), items:[…]}] and '-' for a separator.
//       key: a shortcut label to show (keyLabel(id)); checked: true/false adds a check column;
//       items: a submenu (one level), opened by hover, click, Enter or →.
//   closeMenu(); menuOpen()
// Keys: ↑/↓ (skipping disabled items), Home/End, Enter/Space, → opens a submenu, ← or Esc closes it,
// Esc closes the menu, typing a letter jumps to the next item starting with it. Focus goes back to
// where it was unless the chosen action moved it.
let menu=null;
export const menuOpen=()=>!!menu;

const usable=it=>it&&it!=='-'&&!it.disabled;
function panelHtml(items,label){
  const checks=items.some(it=>it!=='-'&&typeof it.checked==='boolean');
  // The icon column only when some item in this panel has an icon (submenus are often text only).
  const icons=items.some(it=>it!=='-'&&it.icon);
  return `<div class="cm-panel" role="menu" aria-label="${esc(label||'Menu')}">${items.map((it,i)=>it==='-'?'<div class="cm-sep" role="separator"></div>'
    :`<div class="cm-item${it.danger?' danger':''}" role="${checks&&typeof it.checked==='boolean'?'menuitemcheckbox':'menuitem'}" data-i="${i}" tabindex="-1"${it.disabled?' aria-disabled="true"':''}${it.items?' aria-haspopup="menu" aria-expanded="false"':''}${typeof it.checked==='boolean'?` aria-checked="${it.checked}"`:''}>
      ${checks?`<span class="cm-chk">${it.checked?icon('check',12):''}</span>`:''}${icons?`<span class="cm-ic">${it.icon?icon(it.icon,14):''}</span>`:''}<span class="cm-l">${esc(it.label)}</span>${it.key?`<kbd>${esc(it.key)}</kbd>`:''}${it.items?`<span class="cm-sub">${icon('chevR',12)}</span>`:''}</div>`).join('')}</div>`;
}
function place(el,x,y,flipFrom){
  const W=el.offsetWidth,H=el.offsetHeight;
  let left=x,top=y;
  if(left+W>innerWidth-6)left=flipFrom!=null?flipFrom-W:innerWidth-W-6;
  if(top+H>innerHeight-6)top=Math.max(6,innerHeight-H-6);
  el.style.left=Math.max(6,left)+'px';el.style.top=Math.max(6,top)+'px';
}

export function closeMenu(refocus=true){
  if(!menu)return;const m=menu;menu=null;
  document.removeEventListener('pointerdown',m.out,true);removeEventListener('resize',m.close);removeEventListener('blur',m.close);document.removeEventListener('wheel',m.out,true);
  m.sub?.el.remove();popOut(m.el);
  if(refocus&&m.back?.isConnected&&(document.activeElement===document.body||m.el.contains(document.activeElement)))m.back.focus({preventScroll:true});
}

export function openMenu(at,items,{label='Menu'}={}){
  closeMenu(false);
  items=items.filter((it,i,a)=>it!=='-'||(i>0&&i<a.length-1&&a[i-1]!=='-'));
  if(!items.some(usable))return;
  let x,y;const back=document.activeElement;
  if(at instanceof Element||(at?.type&&at.clientX===0&&at.clientY===0&&at.target instanceof Element)){
    const r=(at instanceof Element?at:at.target).getBoundingClientRect();x=r.left+Math.min(24,r.width/2);y=r.bottom+2;
  }else if(at?.type){x=at.clientX;y=at.clientY}else{x=at.x;y=at.y}
  at?.preventDefault?.();
  const el=document.createElement('div');el.className='cm';el.innerHTML=panelHtml(items,label);
  (document.querySelector('dialog[open]')||document.body).append(el);place(el,x,y);popIn(el);
  const m={el,items,back,sub:null,active:-1};
  const rows=p=>[...p.querySelectorAll(':scope > .cm-item')];
  const listOf=p=>p===el.firstChild?items:m.sub?.items||[];
  function focusRow(p,i){const r=rows(p);if(!r.length)return;const list=listOf(p),idx=list.map((it,k)=>k).filter(k=>usable(list[k]));if(!idx.length)return;
    const k=i<0?idx[0]:i;r.forEach(n=>n.classList.toggle('active',+n.dataset.i===k));r.find(n=>+n.dataset.i===k)?.focus({preventScroll:true});p.dataset.active=k}
  function step(p,dir){const list=listOf(p),idx=list.map((it,k)=>k).filter(k=>usable(list[k]));if(!idx.length)return;
    const cur=+(p.dataset.active??-1),pos=idx.indexOf(cur),next=pos<0?(dir>0?idx[0]:idx.at(-1)):idx[(pos+dir+idx.length)%idx.length];focusRow(p,next)}
  function openSub(row){
    const it=items[+row.dataset.i];if(!it?.items||it.disabled)return null;
    if(m.sub?.row===row)return m.sub;
    m.sub?.el.remove();m.sub?.row.setAttribute('aria-expanded','false');
    const s=document.createElement('div');s.className='cm cm-child';s.innerHTML=panelHtml(it.items,it.label);
    el.after(s);const r=row.getBoundingClientRect();place(s,r.right-2,r.top-5,r.left+2);
    row.setAttribute('aria-expanded','true');m.sub={el:s,row,items:it.items};
    s.addEventListener('click',e=>{const c=e.target.closest('.cm-item');if(c)choose(it.items[+c.dataset.i])});
    s.addEventListener('pointermove',e=>{const c=e.target.closest('.cm-item');if(c&&usable(it.items[+c.dataset.i]))focusRow(s.firstChild,+c.dataset.i)});
    s.addEventListener('keydown',keys);
    return m.sub;
  }
  function closeSub(){if(!m.sub)return;const row=m.sub.row;m.sub.el.remove();row.setAttribute('aria-expanded','false');m.sub=null;row.focus({preventScroll:true})}
  function choose(it){
    if(!usable(it))return;
    if(it.items)return;
    closeMenu();
    // After the menu is gone, so an action that opens a dialog or focuses a field keeps that focus.
    it.run?.();
  }
  let typed='',typedAt=0;
  function keys(e){
    e.stopPropagation();
    const inSub=!!m.sub&&m.sub.el.contains(e.target),p=inSub?m.sub.el.firstChild:el.firstChild,list=listOf(p);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();step(p,e.key==='ArrowDown'?1:-1)}
    else if(e.key==='Home'||e.key==='End'){e.preventDefault();const idx=list.map((it,k)=>k).filter(k=>usable(list[k]));focusRow(p,e.key==='Home'?idx[0]:idx.at(-1))}
    else if(e.key==='ArrowRight'&&!inSub){const row=e.target.closest('.cm-item'),s=row&&openSub(row);if(s){e.preventDefault();step(s.el.firstChild,1)}}
    else if(e.key==='ArrowLeft'&&inSub){e.preventDefault();closeSub()}
    else if(e.key==='Escape'){e.preventDefault();if(inSub)closeSub();else closeMenu()}
    else if(e.key==='Tab'){e.preventDefault();closeMenu()}
    else if(e.key==='Enter'||e.key===' '){e.preventDefault();const row=e.target.closest('.cm-item');if(!row)return;const it=list[+row.dataset.i];
      if(it?.items&&!inSub){const s=openSub(row);if(s)step(s.el.firstChild,1)}else choose(it)}
    else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
      typed=(Date.now()-typedAt<700?typed:'')+e.key.toLowerCase();typedAt=Date.now();
      const cur=+(p.dataset.active??-1),order=list.map((it,k)=>k).filter(k=>usable(list[k]));
      const hit=[...order.filter(k=>k>cur),...order.filter(k=>k<=cur)].find(k=>list[k].label.toLowerCase().startsWith(typed));
      if(hit!==undefined)focusRow(p,hit);
    }
  }
  el.addEventListener('keydown',keys);
  el.addEventListener('click',e=>{const row=e.target.closest('.cm-item');if(!row)return;const it=items[+row.dataset.i];if(it?.items){const s=openSub(row);if(s)step(s.el.firstChild,1)}else choose(it)});
  el.addEventListener('pointermove',e=>{const row=e.target.closest('.cm-item');if(!row)return;const it=items[+row.dataset.i];
    if(usable(it))focusRow(el.firstChild,+row.dataset.i);if(it?.items&&!it.disabled)openSub(row);else if(m.sub&&m.sub.row!==row){m.sub.el.remove();m.sub.row.setAttribute('aria-expanded','false');m.sub=null}});
  el.addEventListener('contextmenu',e=>e.preventDefault());
  m.out=e=>{if(!el.contains(e.target)&&!m.sub?.el.contains(e.target))closeMenu(false)};
  m.close=()=>closeMenu(false);
  menu=m;
  document.addEventListener('pointerdown',m.out,true);addEventListener('resize',m.close);addEventListener('blur',m.close);document.addEventListener('wheel',m.out,true);
  focusRow(el.firstChild,-1);
}
