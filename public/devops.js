import {icon} from './icons.js';
import {$,esc,ib,uid,pickerButton,openPicker} from './ui.js';
import {busy,skeletonAppend,panel,flipList} from './motion.js';
import {createSortable,settle,bump} from './drag.js';
import {matches,keyLabel} from './shortcuts.js';
import {detailModal,ask} from './modal.js';
import {store,change,checkpoint,commit,save} from './store.js';
import {agentsForCard,delegate} from './agentflow-core.js';
import {NEW_COLUMN,BACKLOG,COLUMN_INFO,ROLES,LINK_KINDS,SECTIONS,colorOf,newCard,moveCard,gateFor,filterCards,entityProjects,dueTone,isOpen,initials,memberColor} from './devops-core.js';

// DevOps tab: a card board. Data rules live in devops-core.js; this module draws the
// board, its filters and the card panel (in the shared #inspector), and handles drag and gates.
const UIKEY='flygon-flow-devops-ui',MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ITEM_KINDS={feature:'Feature',milestone:'Milestone',release:'Release',deadline:'Deadline',project:'Project',phase:'Phase',event:'Event'};
const LINK_ICONS={pr:'pr',commit:'commit',url:'link'};
const FILTERS=()=>({projects:[],entity:'',assignees:[],agents:[],labels:[],q:'',hideDone:false});
let ui=FILTERS();
try{const saved=JSON.parse(localStorage.getItem(UIKEY))||{};
  // Earlier versions stored a single assignee / label.
  if(saved.assignee&&!saved.assignees)saved.assignees=[saved.assignee];if(saved.label&&!saved.labels)saved.labels=[saved.label];delete saved.assignee;delete saved.label;
  Object.assign(ui,saved)}catch{}
for(const k of ['projects','assignees','agents','labels'])if(!Array.isArray(ui[k]))ui[k]=[];
// Paging: each column renders its first 20 cards, "Load more" adds 20. Reset whenever filters change.
const PAGE=20,shown=new Map();
const keepUi=()=>{shown.clear();try{localStorage.setItem(UIKEY,JSON.stringify(ui))}catch{}};
let selected=null,sortable=null,pop=null,pending=null,reveal=false,painted=false,rerender=()=>{},openItem=()=>{},openAgent=()=>{},toast=()=>{};
const edited=new WeakSet();

const db=()=>store.db,dv=()=>store.db.devops,card=id=>dv().cards.find(c=>c.id===id);
const project=id=>db().projects.find(p=>p.id===id),label=id=>dv().labels.find(l=>l.id===id);
const colName=id=>dv().columns.find(c=>c.id===id)?.name||id;
const touch=c=>c.updated=new Date().toISOString();
// Assignees are the org chart's person cards, across every chart.
function nodesOf(types){const m=new Map();for(const c of db().charts)for(const n of c.nodes)if(types.includes(n.type)&&!m.has(n.id))m.set(n.id,n);return [...m.values()].sort((a,b)=>a.name.localeCompare(b.name))}
const people=()=>nodesOf(['person']);
const nodeById=id=>{for(const c of db().charts){const n=c.nodes.find(x=>x.id===id);if(n)return n}return null};
const today=()=>{const t=new Date();return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`};
const fmt=s=>`${MONTHS[+s.slice(5,7)-1]} ${+s.slice(8)}${s.slice(0,4)!==today().slice(0,4)?`, ${s.slice(0,4)}`:''}`;
const when=iso=>new Date(iso).toLocaleString([],{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
const pill=l=>{const [bg,fg]=colorOf(l.color);return `<span class="pill" style="background:${bg};color:${fg}"${l.name.length>12?` data-tip="${esc(l.name)}"`:''}>${esc(l.name)}</span>`};
const bubble=(id,roles)=>{const n=nodeById(id);if(!n)return '';const [bg,fg]=memberColor(id);return `<span class="bub" style="background:${bg};color:${fg}" data-tip="${esc(n.name)} · ${esc(roles.join(', '))}">${esc(initials(n.name))}</span>`};
const byPerson=c=>[...c.assignees.reduce((m,a)=>{if(nodeById(a.node))m.set(a.node,[...(m.get(a.node)||[]),a.role]);return m},new Map())];

export function mount(opts){rerender=opts.rerender;openItem=opts.openItem||openItem;openAgent=opts.openAgent||openAgent;toast=opts.toast||toast;
  const el=$('#devopsView');
  el.addEventListener('click',e=>{
    const pick=e.target.closest('[data-pick]');if(pick){finishPick(pick.dataset.pick);return}
    if(e.target.classList.contains('dv-modal')){finishPick('');return}
    const pk=e.target.closest('[data-picker]');if(pk){openFilter(pk);return}
    const b=e.target.closest('[data-dv]');if(b)action(b.dataset.dv,b);
  });
  el.addEventListener('change',e=>{
    const t=e.target;
    if(t.dataset.dsel){ui[t.dataset.dsel]=t.value;keepUi();render()}
  });
  el.addEventListener('input',e=>{
    if(e.target.id!=='dv-q')return;
    ui.q=e.target.value;keepUi();const pos=e.target.selectionStart;render();const q=$('#dv-q');q.focus();q.setSelectionRange(pos,pos);
  });
  el.addEventListener('dblclick',e=>{const h=e.target.closest('.dcol-h .nm');if(h)rename(h.closest('[data-dcol]').dataset.dcol)});
  // Enter opens a card; Space picks it up (drag.js).
  el.addEventListener('keydown',e=>{const c=e.target.closest('[data-card]');if(c&&e.key==='Enter'){e.preventDefault();select(c.dataset.card)}});
  sortable=createSortable(el,{
    item:'[data-card]',list:'.dcol-b',listOf:x=>x.closest('[data-dcol]'),keyOf:z=>z.dataset.dcol,idOf:x=>x.dataset.card,
    ignore:'button,a,input,select,.dv-more',scroller:()=>el.querySelector('.dv-scroll'),
    describe(id,col,pos,total){const c=card(id);return `#${c?.number} ${c?.title||''}, ${colName(col)}, position ${pos} of ${total}`},
    onTap:select,
    onDrop:dropCard,
    afterDrop(id,moved){
      if(deferred){deferred=false;render()}
      const c=el.querySelector(`[data-card="${CSS.escape(id)}"]`);
      if(moved){settle(c);for(const col of [lastMove?.from,lastMove?.to])bump(el.querySelector(`[data-dcol="${col}"] .dcol-h em`))}
      if(c&&document.activeElement===document.body)c.focus({preventScroll:true});
    },
  });
}
// A drop from drag.js: work out the position among the column's cards, run the gates, commit.
// Resolves false when a gate is declined, so the card flies back home.
let lastMove=null,deferred=false;
async function dropCard({id,from,to,beforeId,afterId},ctx){
  const c=card(id);if(!c)return false;
  const peers=dv().cards.filter(x=>x.column===to&&x.id!==id),at=x=>peers.findIndex(p=>p.id===x);
  const index=beforeId&&at(beforeId)>=0?at(beforeId):afterId&&at(afterId)>=0?at(afterId)+1:afterId||!beforeId?Infinity:0;
  lastMove={from,to};
  return requestMove(id,to,index,ctx);
}
export function leave(){selected=null;pop=null;pending=null;if(modal&&!modal.closing)modal.close()}
function select(id){selected=id;rerender()}

// ---------- moves and gates ----------
// Same-column moves just reorder. Moving into Done asks first (Approve on UAT is the normal path),
// leaving Done asks first, and an unassigned card moving into Doing asks who is developing it.
// Returns (a promise of) whether the move happened. From a drag (ctx), a declined gate leaves the
// DOM to drag.js, which flies the card home; from the panel's column select it re-renders.
async function requestMove(id,col,index=Infinity,ctx=null){
  const c=card(id);if(!c)return false;
  const no=()=>{if(!ctx)rerender();return false};
  if(c.column===col){
    const all=dv().cards.filter(x=>x.column===col);
    if(Math.min(index,all.length-1)===all.indexOf(c))return no();
    change(()=>moveCard(dv(),id,col,index));return true;
  }
  const g=gateFor(c,col);
  if(g==='confirm-done'&&!await ask(`Move #${c.number} straight to Done?\nDone means completed. Cards normally go through UAT first, where they are tested and then approved.`,{ok:'Move to Done'}))return no();
  if(g==='confirm-reopen'&&!await ask(`Move #${c.number} out of Done and back to ${colName(col)}?\nDone means completed; moving it reopens the work.`,{ok:'Reopen'}))return no();
  if(g==='pick-dev'&&people().length){
    ctx?.hideClone();
    return new Promise(done=>{pending={id,col,index,done};pop={type:'pick'};rerender()});
  }
  change(()=>moveCard(dv(),id,col,index));return true;
}
// Picking nobody (or cancelling) still moves the card, just unassigned.
function finishPick(nodeId){
  const p=pending;pending=null;pop=null;
  if(!p||!card(p.id)){render();p?.done?.(false);return}
  change(()=>{moveCard(dv(),p.id,p.col,p.index);if(nodeId)card(p.id).assignees.push({node:nodeId,role:'developer'})});
  p.done?.(true);
}
function approve(id){const c=card(id);if(c?.column==='uat')change(()=>moveCard(dv(),id,'done'))}

// ---------- header, toolbar and board ----------
export function headerHtml(){
  const all=dv().cards.length,open=dv().cards.filter(isOpen).length;
  return `<span class="meta" data-tip="${all} card${all===1?'':'s'} · ${open} open">${open} open · ${all}</span>`;
}
function sanitize(){
  ui.projects=ui.projects.filter(p=>p==='none'||project(p));
  if(ui.entity&&!nodeById(ui.entity))ui.entity='';
  ui.assignees=ui.assignees.filter(nodeById);ui.labels=ui.labels.filter(label);
  ui.agents=ui.agents.filter(id=>db().agentflow?.agents.some(a=>a.id===id));
}
const opt=(v,l,cur)=>`<option value="${esc(v)}"${v===cur?' selected':''}>${esc(l)}</option>`;
// Picker items shared by the filters and the card panel.
const projectItems=()=>[...db().projects.map(p=>({value:p.id,label:p.name,color:p.color,sub:p.entity&&nodeById(p.entity)?.name!==p.name?nodeById(p.entity)?.name:''})),{value:'none',label:'No project',color:'#c4cbc8'}];
const personItems=()=>people().map(p=>{const [bg,fg]=memberColor(p.id);return {value:p.id,label:p.name,avatar:{text:initials(p.name),bg,fg}}});
const labelItems=()=>SECTIONS.flatMap(([s,name])=>dv().labels.filter(l=>l.section===s).map(l=>{const [bg,fg]=colorOf(l.color);return {value:l.id,label:l.name,group:name,pill:{bg,fg}}}));
const FILTER_PICKERS={'dv-projects':['projects',projectItems,'Projects'],'dv-assignees':['assignees',personItems,'Assignees'],'dv-agents':['agents',()=>agentItems(),'Agents'],'dv-labels':['labels',labelItems,'Labels']};
function openFilter(b){
  const [k,items,label]=FILTER_PICKERS[b.dataset.picker]||[];if(!k)return;
  openPicker(b,{items:items(),selected:ui[k],label,placeholder:`Search ${label.toLowerCase()}`,onChange(v){ui[k]=v;keepUi();render()}});
}
function toolbar(n){
  const active=ui.projects.length||ui.entity||ui.assignees.length||ui.agents.length||ui.labels.length||ui.q||ui.hideDone;
  const ents=nodesOf(['entity','area']).filter(e=>e.id===ui.entity||entityProjects(db(),e.id).length);
  return `<div class="tl-bar dv-bar">
    ${pickerButton('dv-projects','Projects',projectItems(),ui.projects,{tip:'Filter by project'})}
    <select data-dsel="entity" data-tip="Entity · cards in the projects under it" aria-label="Filter by entity">${opt('','All entities',ui.entity)}${ents.map(e=>opt(e.id,e.name,ui.entity)).join('')}</select>
    ${pickerButton('dv-assignees','Assignees',personItems(),ui.assignees,{tip:'Filter by assignee'})}
    ${db().agentflow?.agents.length?pickerButton('dv-agents','Agents',agentItems(),ui.agents,{tip:'Filter by AgentFlow agent: cards delegated to it'}):''}
    ${pickerButton('dv-labels','Labels',labelItems(),ui.labels,{tip:'Filter by label'})}
    <input id="dv-q" type="search" placeholder="Search # or title" value="${esc(ui.q)}" aria-label="Search cards by number or title">
    ${ib('check',ui.hideDone?'Show Done':'Hide Done',{cls:ui.hideDone?'on':'',attrs:'data-dv="hideDone"'})}
    <span class="dv-count">${n} card${n===1?'':'s'}</span>
    ${active?`<button type="button" class="txt" data-dv="clear">Clear</button>`:''}<span class="sp"></span>
    ${ib('plus','Add a card to Requests / Sprinted',{key:keyLabel('devops.add'),cls:'primary',attrs:'data-dv="add"'})}</div>`;
}
// Agents a card is delegated to, built once per board render (cardAgents).
let cardAgents=new Map();
const agentBub=a=>{const [bg,fg]=memberColor(a.id);return `<span class="bub agent" style="background:${bg};color:${fg}" data-tip="Agent: ${esc(a.name)}${a.title?` · ${esc(a.title)}`:''}">${icon('bot',11)}</span>`};
function cardHtml(c){
  const ags=cardAgents.get(c.id)||[],ls=c.labels.map(label).filter(Boolean),p=project(c.project),tone=dueTone(c,today()),done=c.checklist.filter(x=>x.done).length,ppl=byPerson(c);
  return `<div class="dcard${selected===c.id?' sel':''}${c.column==='done'?' is-done':''}" data-card="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(`#${c.number} ${c.title}`)}"${p?` style="--pc:${p.color}"`:''}>
    ${ls.length?`<div class="dc-labels">${ls.slice(0,3).map(pill).join('')}${ls.length>3?`<span class="dc-more" data-tip="${esc(ls.slice(3).map(l=>l.name).join(', '))}">+${ls.length-3}</span>`:''}</div>`:''}
    <div class="dc-title" data-tip="${c.title.length>90?esc(c.title):''}" data-tip-delay="700">${esc(c.title)}</div>
    <div class="dc-foot"><span class="dc-l"><span class="dc-num">#${c.number}</span>${c.points!=null?`<span class="dc-pts">${c.points} pts</span>`:''}
      ${c.due?`<span class="dc-due ${tone}" data-tip="${tone==='overdue'?'Overdue':tone==='soon'?'Due soon':'Due'} · ${esc(fmt(c.due))}">${icon('calendar',12)}${esc(fmt(c.due))}</span>`:''}
      ${c.checklist.length?`<span class="dc-chk${done===c.checklist.length?' all':''}" data-tip="Checklist">${icon('checkSq',12)}${done}/${c.checklist.length}</span>`:''}
      ${c.links.length?`<span class="dc-ico" data-tip="${esc(c.links.map(l=>`${LINK_KINDS[l.kind]}: ${l.url}`).join('\n'))}">${icon('link',12)}</span>`:''}
      ${c.item?`<span class="dc-ico" data-tip="Linked to a timeline item">${icon('gantt',12)}</span>`:''}</span>
      <span class="dc-r">${p?`<i class="dc-proj" style="background:${p.color}" data-tip="${esc(p.name)}"></i>`:''}${ags.length?`<span class="bubs">${ags.slice(0,2).map(agentBub).join('')}${ags.length>2?`<span class="bub extra" data-tip="${esc(ags.slice(2).map(a=>a.name).join('\n'))}">+${ags.length-2}</span>`:''}</span>`:''}${ppl.length?`<span class="bubs">${ppl.slice(0,2).map(([id,roles])=>bubble(id,roles)).join('')}${ppl.length>2?`<span class="bub extra" data-tip="${esc(ppl.slice(2).map(([id])=>nodeById(id).name).join('\n'))}">+${ppl.length-2}</span>`:''}</span>`:''}</span></div></div>`;
}
// Six slots: four working columns, Done, then the two backlogs stacked in one slot.
// Done lists the most recently moved cards first so paging hides the old ones.
function colHtml(col,cards){
  let list=cards.filter(c=>c.column===col.id);
  if(col.id==='done')list=list.sort((a,b)=>b.moved.localeCompare(a.moved));
  let n=shown.get(col.id)||PAGE;
  const at=list.findIndex(c=>c.id===selected);
  if(reveal&&at>=n){n=Math.ceil((at+1)/PAGE)*PAGE;shown.set(col.id,n)}
  const left=list.length-n;
  return `<section class="dcol${BACKLOG.includes(col.id)?' backlog':''}" data-dcol="${col.id}"><div class="dcol-h"><span class="nm" data-tip="${esc(COLUMN_INFO[col.id]||'')}\nDouble-click to rename" data-tip-delay="400">${esc(col.name)}</span><em>${list.length}</em><span class="sp"></span>${ib('plus',`Add a card to ${col.name}`,{attrs:`data-dv="colAdd" data-col="${col.id}"`})}</div>
    <div class="dcol-b">${list.slice(0,n).map(cardHtml).join('')}${left>0?`<button type="button" class="txt dv-more" data-dv="more" data-col="${col.id}">Load more (${left} left)</button>`:''}</div></section>`;
}
function boardHtml(cards){
  const cols=dv().columns,main=cols.filter(c=>!BACKLOG.includes(c.id)&&(!ui.hideDone||c.id!=='done')),stack=cols.filter(c=>BACKLOG.includes(c.id));
  return `<div class="dv-board${ui.hideDone?' no-done':''}">${main.map(c=>colHtml(c,cards)).join('')}<div class="dstack">${stack.map(c=>colHtml(c,cards)).join('')}</div></div>`;
}
function popHtml(){
  if(pop.type==='pick'){
    const c=card(pending?.id);if(!c)return '';
    return `<div class="dv-modal"><div class="pop dv-pick" role="dialog" aria-label="Pick a developer"><strong>Who is developing #${c.number}?</strong><p>Cards in Doing usually have a developer.</p>
      <div class="dv-people">${people().map(p=>`<button type="button" data-pick="${esc(p.id)}">${bubble(p.id,['developer'])}<span>${esc(p.name)}</span></button>`).join('')}</div>
      <button type="button" class="txt" data-pick="">Leave unassigned</button></div></div>`;
  }
  return '';
}
export function render(){
  // Never rebuild the board under a lifted card; render once it lands.
  if(sortable?.active()){deferred=true;return}
  sanitize();
  const el=$('#devopsView'),old=el.querySelector('.dv-scroll'),keep=old&&[old.scrollLeft,old.scrollTop,new Map([...el.querySelectorAll('[data-dcol]')].map(c=>[c.dataset.dcol,c.querySelector('.dcol-b')?.scrollTop||0]))];
  const cards=filterCards(db(),ui);
  cardAgents=new Map();for(const a of db().agentflow?.agents||[])for(const id of a.cards)cardAgents.set(id,[...(cardAgents.get(id)||[]),a]);
  // Cards that stay glide to their new place; added ones fade in, removed ones fade out.
  flipList(el,'.dcard',c=>c.dataset.card,()=>{el.innerHTML=toolbar(cards.length)+`<div class="dv-scroll">${boardHtml(cards)}</div>`+(pop?popHtml():'')});
  const sc=el.querySelector('.dv-scroll');
  if(keep){[sc.scrollLeft,sc.scrollTop]=keep;for(const c of el.querySelectorAll('[data-dcol]'))c.querySelector('.dcol-b').scrollTop=keep[2].get(c.dataset.dcol)||0}
  if(reveal){reveal=false;el.querySelector('.dcard.sel')?.scrollIntoView({block:'nearest',inline:'center'})}
  if(pop?.type==='pick')el.querySelector('[data-pick]')?.focus();
  // First paint this session: a brief skeleton fitted to the real board, then the board.
  if(!painted&&sc.clientWidth){painted=true;requestAnimationFrame(()=>{if(sc.isConnected)busy(sc,160)})}
}
function action(name,b){
  ({
    add:()=>addCard(NEW_COLUMN),
    colAdd:()=>addCard(b.dataset.col),
    hideDone(){ui.hideDone=!ui.hideDone;keepUi();render()},
    more(){const col=b.dataset.col,list=b.closest('.dcol-b');b.disabled=true;skeletonAppend(list,3);setTimeout(()=>{shown.set(col,(shown.get(col)||PAGE)+PAGE);render()},180)},
    clear(){ui=FILTERS();keepUi();render()},
  })[name]?.();
}
// A new card inherits the active filters so it stays visible.
function addCard(column){
  const proj=ui.projects.find(p=>p!=='none')||(ui.entity&&entityProjects(db(),ui.entity)[0]?.id)||'';
  ui.q='';keepUi();
  change(()=>{const c=newCard(dv(),{column,project:proj,labels:[...ui.labels],assignees:ui.assignees.map(node=>({node,role:'requester'}))});selected=c.id;
    if(ui.agents.length&&delegate(db().agentflow,c.id,ui.agents)){ui.agents=[];keepUi()}});
  const t=$('#dc-title');t?.focus();t?.select();
}
function rename(colId){
  const v=prompt('Column name',colName(colId))?.trim();
  if(v&&v!==colName(colId))change(()=>{dv().columns.find(c=>c.id===colId).name=v.slice(0,80);dv().namesCustomized=true});
}
function remove(id){change(()=>{dv().cards=dv().cards.filter(c=>c.id!==id);selected=null})}

// Opened from the chart (a person or entity) or the timeline (a linked card).
// agent: that agent's work queue (open cards delegated to it), from AgentFlow.
export function focus({person,entity,agent,cardId}={}){
  if(person||entity){ui={...FILTERS(),entity:entity||'',assignees:person?[person]:[],hideDone:true};keepUi()}
  else if(agent){ui={...FILTERS(),agents:[agent],hideDone:true};keepUi()}
  if(cardId&&card(cardId)){
    selected=cardId;reveal=true;
    if(!filterCards(db(),ui).some(c=>c.id===cardId)){ui=FILTERS();keepUi()}
  }
}

// ---------- card panel (shared #inspector) ----------
// The card detail opens as a modal that grows out of the card (modal.js); the shared side panel
// stays empty on this tab. #devops/card/<number> deep-links to it; Back closes it.
let modal=null,modalFor=null,pushed=false;
const cardEl=id=>document.querySelector(`#devopsView [data-card="${CSS.escape(id)}"]`);
const cardHash=c=>`#devops/card/${c.number}`;
export function renderInspector(pane){
  panel(pane,false);
  const c=card(selected);
  if(!c){if(modal&&!modal.closing)modal.close();return}
  if(!modal||modal.closing){
    const m=detailModal({cls:'card-modal',label:`Card #${c.number}`,from:cardEl(c.id),
      events:{click:inspectorClick,input:inspectorInput,change:inspectorChange,keydown:modalKey},
      onClose(){
        // This modal's own card (modalFor may already point at a newer modal's card).
        const id=m.forId,current=modal===m;if(current)modal=null;
        // Only the current modal owns the URL; an older one closing behind a newer one leaves it alone.
        if(current&&location.hash.startsWith('#devops/card/')){if(pushed){pushed=false;history.back()}else history.replaceState(null,'','#devops')}
        if(selected===id){selected=null;rerender()}
        requestAnimationFrame(()=>cardEl(id)?.focus({preventScroll:true}));
      }});
    modal=m;
  }
  modalFor=modal.forId=c.id;modal.from(cardEl(c.id));
  if(location.hash!==cardHash(c)){if(location.hash.startsWith('#devops/card/'))history.replaceState(null,'',cardHash(c));else{history.pushState(null,'',cardHash(c));pushed=true}}
  // Keep focus and caret in place when the body is re-rendered after an edit.
  const a=document.activeElement,keep=modal.el.contains(a)&&a.id?{id:a.id,s:a.selectionStart,e:a.selectionEnd}:null;
  modal.body.innerHTML=cardDetailHtml(c);
  const f=keep&&document.getElementById(keep.id);
  if(f){f.focus({preventScroll:true});try{if(keep.s!=null)f.setSelectionRange(keep.s,keep.e)}catch{}}
  else if(!modal.el.contains(document.activeElement))modal.el.querySelector('#dc-title')?.focus({preventScroll:true});
}
// Hash changes (Back/Forward, a pasted link): open or close the card it names.
export function syncHash(){
  const m=/^#devops\/card\/(\d+)$/.exec(location.hash),c=m&&dv().cards.find(x=>x.number===+m[1]);
  if(c&&selected!==c.id){pushed=false;focus({cardId:c.id});rerender()}
  else if(!c&&selected){pushed=false;selected=null;rerender()}
}
// Previous / next card in the same column (as shown), while the modal is open.
function modalKey(e){
  inspectorKey(e);
  if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable)return;
  const dir=matches(e,'devops.prevCard')?-1:matches(e,'devops.nextCard')?1:0;if(!dir)return;
  const c=card(selected);if(!c)return;
  let list=filterCards(db(),ui).filter(x=>x.column===c.column);if(c.column==='done')list=list.sort((a,b)=>b.moved.localeCompare(a.moved));
  const next=list[list.findIndex(x=>x.id===c.id)+dir];if(!next)return;
  e.preventDefault();selected=next.id;reveal=true;rerender();
}
function cardDetailHtml(c){
  const ppl=people(),items=[...db().timeline].sort((a,b)=>Object.keys(ITEM_KINDS).indexOf(a.kind)-Object.keys(ITEM_KINDS).indexOf(b.kind)||a.title.localeCompare(b.title));
  const projectOpts=db().projects.map(p=>{const under=p.entity&&nodeById(p.entity)?.name;return opt(p.id,p.name+(under&&under!==p.name?` · ${under}`:''),c.project)}).join('');
  const done=c.checklist.filter(x=>x.done).length;
  return `<div class="ihead cd-h"><span class="k dv-k">${icon('branch')}</span><strong>#${c.number}</strong><span class="cd-col">${esc(colName(c.column))}</span><span class="sp"></span>
    ${c.column==='uat'?`<button type="button" class="txt approve" data-dc="approve" data-tip="Testing passed: approve and move to Done (completed)">${icon('check',13)}Approve</button>`:''}
    ${ib('trash','Delete card',{key:keyLabel('devops.delete'),cls:'danger',attrs:'data-dc="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-dc="close"'})}</div>
    <form id="dedit" class="cd-grid" autocomplete="off"><div class="cd-main ibody">
    <label for="dc-title">Title</label><input id="dc-title" class="cd-title" maxlength="200" required value="${esc(c.title)}">
    <label for="dc-desc">Description</label><textarea id="dc-desc" rows="9" maxlength="8000" placeholder="Why this card exists, what should be delivered">${esc(c.description)}</textarea>
    <label>Checklist${c.checklist.length?` <em>${done}/${c.checklist.length}</em>`:''}</label><ul class="dc-list">${c.checklist.map(x=>`<li><input type="checkbox" data-chk="${esc(x.id)}"${x.done?' checked':''} aria-label="Done"><span class="nm${x.done?' done':''}">${esc(x.text)}</span>${ib('x','Remove',{attrs:`data-chkdel="${esc(x.id)}"`})}</li>`).join('')}</ul>
    <div class="dc-row"><input id="dc-chk" maxlength="300" placeholder="Add an item and press Enter" aria-label="New checklist item">${ib('plus','Add item',{attrs:'data-dc="chkAdd"'})}</div>
    <label>Links <em>pull request, commit or URL</em></label><ul class="dc-list">${c.links.map(l=>`<li><span class="dc-lk" data-tip="${LINK_KINDS[l.kind]}">${icon(LINK_ICONS[l.kind],13)}</span>${/^https?:\/\//i.test(l.url)?`<a class="nm" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a>`:`<span class="nm">${esc(l.url)}</span>`}${ib('x','Remove',{attrs:`data-ldel="${esc(l.id)}"`})}</li>`).join('')}</ul>
    <div class="dc-row"><select id="dc-lkind" aria-label="Link type">${Object.entries(LINK_KINDS).map(([k,n])=>opt(k,n,'pr')).join('')}</select><input id="dc-lurl" maxlength="500" placeholder="https:// or a commit SHA" aria-label="Link">${ib('plus','Add link',{attrs:'data-dc="linkAdd"'})}</div>
    </div><aside class="cd-side ibody">
    <div class="two"><div><label for="dc-col">Column</label><select id="dc-col">${dv().columns.map(x=>opt(x.id,x.name,c.column)).join('')}</select></div>
      <div><label for="dc-proj">Project</label><select id="dc-proj">${opt('','No project',c.project)}${projectOpts}</select></div></div>
    <label>Labels</label><div class="dc-ls"><div class="dc-sel">${c.labels.map(label).filter(Boolean).map(pill).join('')}${pickerButton('dc-labels',c.labels.length?'Edit':'Add labels',labelItems(),[],{cls:'mini'})}</div>
      <div class="dc-row"><input id="dc-newlabel" maxlength="40" placeholder="New label" aria-label="New label name"><select id="dc-newsec" aria-label="Label section">${SECTIONS.map(([s,n])=>opt(s,n,'area')).join('')}</select>${ib('plus','Add label',{attrs:'data-dc="labelAdd"'})}</div></div>
    <div class="two"><div><label for="dc-pts">Points</label><input id="dc-pts" type="number" min="0" max="1000" step="any" placeholder="–" value="${c.points??''}"></div>
      <div><label for="dc-due">Due date</label><input id="dc-due" type="date" value="${c.due}"></div></div>
    <label>Assignees</label>${ppl.length?`<div class="dc-roles">${ROLES.map(role=>{const ids=c.assignees.filter(a=>a.role===role).map(a=>a.node);
      return `<div class="dc-role"><small>${role[0].toUpperCase()+role.slice(1)}</small>${pickerButton('dc-role-'+role,ids.length?ids.map(id=>nodeById(id)?.name).filter(Boolean).join(', '):'None',personItems(),ids,{cls:'mini wide'})}</div>`}).join('')}</div>`
      :`<div class="dc-hint">Add people to a mind map to assign them.</div>`}
    <label for="dc-item">Timeline item</label><div class="linkrow"><select id="dc-item">${opt('','None',c.item)}${items.map(i=>opt(i.id,`${ITEM_KINDS[i.kind]||i.kind}: ${i.title}`,c.item)).join('')}</select>${c.item?ib('arrowR','Open in the Timeline',{attrs:'data-dc="goItem"'}):''}</div>
    ${agentRow(c)}
    <div class="dc-meta">Created ${esc(when(c.created))}<br>Updated ${esc(when(c.updated))}</div></aside></form>`;
}
// AgentFlow agents working this card (the link is stored on the agent, agentflow-core.js).
const agentItems=()=>[...(db().agentflow?.agents||[])].sort((a,b)=>a.name.localeCompare(b.name)).map(a=>{const [bg,fg]=memberColor(a.id);return {value:a.id,label:a.name,sub:a.title,avatar:{text:initials(a.name),bg,fg}}});
function agentRow(c){
  if(!db().agentflow?.agents.length)return '';
  const on=agentsForCard(db().agentflow,c.id);
  return `<label>Delegated to <em>AgentFlow agents · their work queue</em></label>${pickerButton('dc-agents',on.length?on.map(a=>a.name).join(', '):'None',agentItems(),on.map(a=>a.id),{cls:'mini wide'})}
    ${on.length?`<ul class="links">${on.map(a=>`<li><button type="button" data-dc-agent="${esc(a.id)}" data-tip="Open in AgentFlow">${icon('bot',12)}<span>${esc(a.name)}</span><em>${esc(a.title)}</em></button></li>`).join('')}</ul>`:''}`;
}
function addLabel(){
  const i=$('#dc-newlabel'),name=i?.value.trim(),c=card(selected);if(!name||!c)return;
  const keys=['blue','green','purple','orange','teal','pink','indigo','amber','sky','rose','lime','brown'];
  change(()=>{
    let l=dv().labels.find(x=>x.name.toLowerCase()===name.toLowerCase());
    if(!l){l={id:uid(),name:name.slice(0,40),section:$('#dc-newsec').value,color:keys[dv().labels.length%keys.length]};dv().labels.push(l)}
    if(!c.labels.includes(l.id))c.labels.push(l.id);touch(c);
  });
  $('#dc-newlabel')?.focus();
}
function addCheck(){const i=$('#dc-chk'),t=i?.value.trim(),c=card(selected);if(!t||!c)return;change(()=>{c.checklist.push({id:uid(),text:t.slice(0,300),done:false});touch(c)});$('#dc-chk')?.focus()}
function addLink(){const i=$('#dc-lurl'),u=i?.value.trim(),c=card(selected);if(!u||!c)return;const kind=$('#dc-lkind').value;change(()=>{c.links.push({id:uid(),kind,url:u.slice(0,500)});touch(c)});$('#dc-lurl')?.focus()}
export function inspectorClick(e){
  const b=e.target.closest('button');if(!b)return;
  const c=card(selected);if(!c)return;
  if(b.dataset.picker==='dc-labels'){openPicker(b,{items:labelItems(),selected:c.labels,label:'Labels',placeholder:'Search labels',onChange(v){change(()=>{c.labels=v;touch(c)})}});return}
  if(b.dataset.picker?.startsWith('dc-role-')){const role=b.dataset.picker.slice(8);
    openPicker(b,{items:personItems(),selected:c.assignees.filter(a=>a.role===role).map(a=>a.node),label:role,placeholder:'Search people',
      onChange(v){change(()=>{c.assignees=[...c.assignees.filter(a=>a.role!==role),...v.map(node=>({node,role}))];touch(c)})}});return}
  if(b.dataset.picker==='dc-agents'){openPicker(b,{items:agentItems(),selected:agentsForCard(db().agentflow,c.id).map(a=>a.id),label:'Agents',placeholder:'Search agents',
    onChange(v){
      // Check room before recording an undo step: delegate() changes nothing when an agent is full.
      const before=structuredClone(store.db),over=delegate(db().agentflow,c.id,v);
      if(over){toast(`${over.name}'s queue is full (100 cards). Remove some first.`,true);rerender();return}
      touch(c);commit(before);rerender()}});return}
  if(b.dataset.dcAgent){openAgent(b.dataset.dcAgent);return}
  if(b.dataset.chkdel){change(()=>{c.checklist=c.checklist.filter(x=>x.id!==b.dataset.chkdel);touch(c)});return}
  if(b.dataset.ldel){change(()=>{c.links=c.links.filter(x=>x.id!==b.dataset.ldel);touch(c)});return}
  ({approve:()=>approve(c.id),delete:()=>remove(c.id),close:()=>select(null),labelAdd:addLabel,chkAdd:addCheck,linkAdd:addLink,goItem:()=>openItem(c.item),
  })[b.dataset.dc]?.();
}
// Text fields autosave as you type: one undo step per open form.
export function inspectorInput(e){
  const t=e.target,c=card(selected),form=$('#dedit');
  if(!c||!form||!['dc-title','dc-pts','dc-due','dc-desc'].includes(t.id))return;
  const title=$('#dc-title').value.trim(),pts=$('#dc-pts').value;if(!title)return;
  if(!edited.has(form)){checkpoint();edited.add(form)}
  Object.assign(c,{title,points:pts===''||!Number.isFinite(+pts)?null:Math.max(0,Math.min(1000,+pts)),due:$('#dc-due').value,description:$('#dc-desc').value});touch(c);
  save();render();
}
export function inspectorChange(e){
  const t=e.target,c=card(selected);if(!c)return;
  if(t.id==='dc-col')requestMove(c.id,t.value);
  else if(t.id==='dc-proj')change(()=>{c.project=t.value;touch(c)});
  else if(t.id==='dc-item')change(()=>{c.item=t.value;touch(c)});
  else if(t.dataset.chk)change(()=>{const x=c.checklist.find(y=>y.id===t.dataset.chk);if(x)x.done=t.checked;touch(c)});
}
export function inspectorKey(e){
  if(e.key!=='Enter')return;
  const f={'dc-chk':addCheck,'dc-lurl':addLink,'dc-newlabel':addLabel}[e.target.id];
  if(f){e.preventDefault();f()}else if(e.target.tagName==='INPUT')e.preventDefault();
}
export function key(e){
  if(e.key==='Escape'){if(pop?.type==='pick')finishPick('');else if(selected)select(null);return}
  if(matches(e,'devops.delete')&&card(selected)){e.preventDefault();remove(selected);return}
  if(matches(e,'devops.add')){e.preventDefault();addCard(NEW_COLUMN)}
  else if(matches(e,'devops.search')){e.preventDefault();$('#dv-q')?.focus()}
}
