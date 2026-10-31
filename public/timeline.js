import {icon} from './icons.js';
import {$,esc,ib,uid,clone,download,pickerButton,openPicker} from './ui.js';
import {store,change,checkpoint,commit,save,PALETTE} from './store.js';
import {cardsForItem,isOpen} from './devops-core.js';
import {matches,keyLabel} from './shortcuts.js';
import {detailModal,ask} from './modal.js';
import {panel} from './motion.js';

// Timeline items: {id,title,kind,status,priority,release,start,end?,projects[],owner,link,notes}; dates are YYYY-MM-DD.
// start may be '' (unscheduled backlog): those items only appear on the Board and List.
// Projects: {id,name,color,entity} where entity is the id of the chart card the project sits under.
const KINDS={
  feature:{icon:'box',label:'Feature'},milestone:{icon:'diamond',label:'Milestone'},release:{icon:'rocket',label:'Release'},deadline:{icon:'flag',label:'Deadline'},
  project:{icon:'bar',label:'Project',range:true},phase:{icon:'phase',label:'Phase / sprint',range:true},event:{icon:'dot',label:'Event'},
};
const STATUS={
  planned:{icon:'planned',label:'Planned'},active:{icon:'active',label:'In progress'},risk:{icon:'alert',label:'At risk'},
  blocked:{icon:'blocked',label:'Blocked'},done:{icon:'check',label:'Done'},cancelled:{icon:'ban',label:'Cancelled'},
};
const statusInfo=id=>({...STATUS[id],label:store.db.workflow?.statuses?.[id]||STATUS[id].label});
const statusEntries=()=>Object.keys(STATUS).map(id=>[id,statusInfo(id)]);
const PRIORITY={high:{icon:'pHigh',label:'High priority'},medium:{icon:'pMed',label:'Medium priority'},low:{icon:'pLow',label:'Low priority'}};
const SCALES={week:{ppd:32,label:'Week'},month:{ppd:9,label:'Month'},quarter:{ppd:3,label:'Quarter'}};
const VIEWS=['gantt','calendar','list','board'];
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY=864e5,LANE=168,ROW=26,UIKEY='org-chart-studio-timeline-ui';

const n2d=n=>new Date(n*DAY).toISOString().slice(0,10);
const d2n=s=>Math.round(Date.parse(s+'T00:00:00Z')/DAY);
const today=()=>{const t=new Date();return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`};
const monthTitle=ym=>`${MONTHS[+ym.slice(5,7)-1]} ${ym.slice(0,4)}`;
const fmt=s=>`${MONTHS[+s.slice(5,7)-1].slice(0,3)} ${+s.slice(8)}${s.slice(0,4)!==today().slice(0,4)?`, ${s.slice(0,4)}`:''}`;
const dated=i=>!!i.start;
const isRange=i=>dated(i)&&!!i.end&&i.end>i.start;
const span=i=>[d2n(i.start),isRange(i)?d2n(i.end):d2n(i.start)];
const dateLabel=i=>!dated(i)?'Unscheduled':isRange(i)?`${fmt(i.start)} – ${fmt(i.end)}`:fmt(i.start);
const closed=i=>i.status==='done'||i.status==='cancelled';
const late=i=>dated(i)&&!closed(i)&&(i.end||i.start)<today();
const PRANK={high:0,medium:1,low:2,'':3};

let ui={view:'gantt',scale:'month',month:today().slice(0,7),groupBy:'project',projects:[],hideDone:false,showCards:false};
try{Object.assign(ui,JSON.parse(localStorage.getItem(UIKEY))||{})}catch{}
if(!VIEWS.includes(ui.view))ui.view='gantt';
const keepUi=()=>{try{localStorage.setItem(UIKEY,JSON.stringify(ui))}catch{}};
let selected=null,drag=null,jump=true,G=null,rerender=()=>{},openCard=()=>{};
const edited=new WeakSet();

const db=()=>store.db,item=id=>db().timeline.find(i=>i.id===id),project=id=>db().projects.find(p=>p.id===id);
const color=i=>project(i.projects[0])?.color||'#6b7773';
const visible=()=>db().timeline.filter(i=>(!ui.hideDone||!closed(i))&&(!ui.projects.length||ui.projects.some(p=>p==='none'?!i.projects.length:i.projects.includes(p))));
const scheduled=()=>visible().filter(dated);
// DevOps cards with a due date and a project, shown read-only on the Gantt when toggled on.
const devCards=()=>!ui.showCards?[]:db().devops.cards.filter(c=>c.due&&c.project&&project(c.project)&&(!ui.hideDone||isOpen(c))&&(!ui.projects.length||ui.projects.includes(c.project)))
  .map(c=>({card:c,id:c.id,title:`#${c.number} ${c.title}`,start:c.due,end:'',kind:'card',status:isOpen(c)?'planned':'done',projects:[c.project]}));
const colName=id=>db().devops.columns.find(c=>c.id===id)?.name||id;
const tag=p=>p?`<span class="tag" style="--c:${p.color}">${esc(p.name)}</span>`:'';
const releaseOf=i=>i.kind!=='release'&&i.release?item(i.release):null;
function itemTip(i){
  const names=i.projects.map(p=>project(p)?.name).filter(Boolean),days=dated(i)?span(i)[1]-span(i)[0]+1:0,rel=releaseOf(i);
  return [i.title,`${KINDS[i.kind].label} · ${dateLabel(i)}${days>1?` · ${days} days`:''}`,statusInfo(i.status).label+(late(i)?' · overdue':'')+(i.priority?` · ${PRIORITY[i.priority].label}`:''),
    rel&&`Target: ${rel.title}${dated(rel)?` (${fmt(rel.start)})`:''}`,names.join(', '),i.owner&&`Owner: ${i.owner}`].filter(Boolean).join('\n');
}
const statusMark=i=>['risk','blocked','done'].includes(i.status)?`<span class="smark ${i.status}">${icon(STATUS[i.status].icon,11)}</span>`:'';
// Chart cards that can own projects: entities and areas, across every chart.
const cards=()=>{const seen=new Map();for(const c of db().charts)for(const n of c.nodes)if((n.type==='entity'||n.type==='area')&&!seen.has(n.id))seen.set(n.id,n);return [...seen.values()]};
const cardName=id=>cards().find(n=>n.id===id)?.name||'';
// Names that could become projects: chart entity/area names not already used.
const chartNames=type=>[...new Set(db().charts.flatMap(c=>c.nodes.filter(n=>type.includes(n.type)).map(n=>n.name.trim())))].filter(Boolean);

export function mount(opts){rerender=opts.rerender;openCard=opts.openCard||openCard;
  const el=$('#timelineView');
  el.addEventListener('click',e=>{
    const dc=e.target.closest('[data-card]');if(dc){openCard(dc.dataset.card);return}
    const pk=e.target.closest('[data-picker="tl-projects"]');
    if(pk){openPicker(pk,{items:projectItems(),selected:ui.projects,label:'Projects',placeholder:'Search projects',onChange(v){ui.projects=v;keepUi();renderView()}});return}
    const b=e.target.closest('[data-tl],[data-set]');if(!b)return;
    if(b.dataset.set){const [k,v]=b.dataset.set.split(':');ui[k]=v;jump=true;keepUi();render();return}
    action(b.dataset.tl,b);
  });
  el.addEventListener('change',e=>{
    if(e.target.dataset.setSelect){ui[e.target.dataset.setSelect]=e.target.value;keepUi();render()}
  });
  el.addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('button'))return;
    const it=e.target.closest('[data-item]'),i=it&&item(it.dataset.item);if(!i)return;
    if(ui.view==='list'){select(i.id);return}
    drag={id:i.id,end:!!e.target.closest('[data-end]'),sx:e.clientX,sy:e.clientY,s0:i.start,e0:i.end,before:clone(db()),moved:false};
    el.setPointerCapture(e.pointerId);
  });
  // Calendar drops on a day, the Board drops on a status column.
  const target=e=>document.elementFromPoint(e.clientX,e.clientY)?.closest(ui.view==='board'?'[data-col]':'[data-date]');
  el.addEventListener('pointermove',e=>{
    if(!drag)return;
    if(!drag.moved&&Math.abs(e.clientX-drag.sx)+Math.abs(e.clientY-drag.sy)<5)return;
    drag.moved=true;const i=item(drag.id);
    if(ui.view==='gantt'){
      const dd=Math.round((e.clientX-drag.sx)/G.ppd);
      if(drag.end)i.end=n2d(Math.max(d2n(drag.s0),d2n(drag.e0||drag.s0)+dd));
      else{i.start=n2d(d2n(drag.s0)+dd);if(drag.e0)i.end=n2d(d2n(drag.e0)+dd)}
      if(i.end===i.start)i.end='';
      renderView();
    }else{
      const over=target(e);
      for(const c of el.querySelectorAll('.drop'))if(c!==over)c.classList.remove('drop');
      over?.classList.add('drop');
      el.querySelector(`[data-item="${CSS.escape(drag.id)}"]`)?.classList.add('dragging');
    }
  });
  const end=e=>{
    if(!drag)return;const d=drag;drag=null;
    if(!d.moved){select(d.id);return}
    const i=item(d.id);
    if(ui.view==='calendar'){
      const c=target(e);
      if(c&&c.dataset.date!==i.start){const dd=d2n(c.dataset.date)-d2n(i.start);change(()=>{i.start=c.dataset.date;if(i.end)i.end=n2d(d2n(i.end)+dd)})}else renderView();
      return;
    }
    if(ui.view==='board'){
      const c=target(e);
      if(c&&c.dataset.col!==i.status)change(()=>i.status=c.dataset.col);else renderView();
      return;
    }
    commit(d.before);rerender();
  };
  el.addEventListener('pointerup',end);el.addEventListener('pointercancel',end);
  el.addEventListener('dblclick',e=>{
    if(e.target.closest('[data-item],[data-card],button'))return;
    const lane=e.target.closest('[data-lane]'),cell=e.target.closest('[data-date]'),col=e.target.closest('[data-col]');
    if(lane&&G){
      const r=lane.getBoundingClientRect(),key=lane.dataset.lane,start=n2d(G.lo+Math.floor((e.clientX-r.left)/G.ppd));
      add({start,projects:ui.groupBy==='project'&&project(key)?[key]:undefined,kind:ui.groupBy==='kind'&&KINDS[key]?key:undefined,status:ui.groupBy==='status'&&STATUS[key]?key:undefined});
    }else if(cell)add({start:cell.dataset.date});
    else if(col)add({status:col.dataset.col});
  });
  el.addEventListener('keydown',e=>{const r=e.target.closest('.lr,.card');if(r&&(e.key==='Enter'||e.key===' ')){e.preventDefault();select(r.dataset.item)}});
}
export function leave(){selected=null;drag=null;if(modal&&!modal.closing)modal.close()}
function select(id){selected=id;rerender()}

// ---------- header + toolbar ----------
export function headerHtml(){
  const t=db().timeline.length,p=db().projects.length;
  return ib('ics','Export calendar (.ics)\nImports into Google, Outlook or Apple Calendar\nUses the current filters',{label:'Export calendar',attrs:'data-tl="ics"'})
    +`<span class="meta" data-tip="${t} item${t===1?'':'s'} · ${p} project${p===1?'':'s'}">${t} · ${p}</span>`;
}
function toolbar(){
  const seg=(v,ic,tip,key)=>`<button type="button" class="ib${ui.view===v?' on':''}" data-set="view:${v}" data-tip="${tip}" data-key="${key}" aria-label="${tip}" aria-pressed="${ui.view===v}">${icon(ic)}</button>`;
  const todayBtn=`<button type="button" class="txt" data-tl="today" data-tip="Jump to today" data-key="${keyLabel('timeline.today')}">Today</button>`;
  const nav=ui.view==='calendar'?`${ib('chevL','Previous month',{attrs:'data-tl="prev"'})}${todayBtn}${ib('chevR','Next month',{attrs:'data-tl="next"'})}<span class="range">${monthTitle(ui.month)}</span>`
    :ui.view==='gantt'?`${todayBtn}<div class="seg txt">${Object.entries(SCALES).map(([k,s])=>`<button type="button" class="${ui.scale===k?'on':''}" data-set="scale:${k}" data-tip="${s.label} detail">${s.label[0]}</button>`).join('')}</div>
      <select data-set-select="groupBy" data-tip="Group rows" aria-label="Group rows">${[['project','By project'],['kind','By type'],['status','By status'],['none','No grouping']].map(([v,l])=>`<option value="${v}"${ui.groupBy===v?' selected':''}>${l}</option>`).join('')}</select>`:'';
  const f=ui.projects.length;
  return `<div class="tl-bar"><div class="seg">${seg('gantt','gantt','Timeline',keyLabel('timeline.view1'))}${seg('calendar','calendar','Calendar',keyLabel('timeline.view2'))}${seg('list','list','List',keyLabel('timeline.view3'))}${seg('board','board','Board · drag cards between statuses',keyLabel('timeline.view4'))}</div><i class="sep"></i>${nav}<span class="sp"></span>
    ${pickerButton('tl-projects','Projects',projectItems(),ui.projects,{tip:f?`Showing ${f} project${f>1?'s':''}`:'Filter by project'})}
    ${ib('check',ui.hideDone?'Show done & cancelled':'Hide done & cancelled',{cls:ui.hideDone?'on':'',attrs:'data-tl="hideDone"'})}
    ${ui.view==='gantt'?ib('branch',ui.showCards?'Hide DevOps cards':'Show DevOps cards\nCards with a due date and a project',{cls:ui.showCards?'on':'',attrs:'data-tl="showCards"'}):''}
    ${ib('tag','Projects',{cls:selected==='projects'?'on':'',attrs:'data-tl="projects"'})}
    ${ib('plus',ui.view==='board'?'Add feature':'Add item',{key:keyLabel('timeline.add'),cls:'primary',attrs:'data-tl="add"'})}</div>`;
}
// Project filter items: each project (with the chart card it sits under) plus Untagged.
const projectItems=()=>[...projectOrder(db().projects).map(p=>({value:p.id,label:p.name,color:p.color,sub:cardName(p.entity)})),{value:'none',label:'Untagged',color:'#c4cbc8'}];
export function action(name,b){
  ({
    add:()=>add(),
    today:goToday,
    prev:()=>shiftMonth(-1),next:()=>shiftMonth(1),
    hideDone(){ui.hideDone=!ui.hideDone;keepUi();renderView()},
    showCards(){ui.showCards=!ui.showCards;keepUi();renderView()},
    projects(){selected=selected==='projects'?null:'projects';rerender()},
    ics(){download('release-calendar.ics',ics(),'text/calendar')},
    colAdd(){add({status:b.dataset.status})},
  })[name]?.();
}
function goToday(){if(ui.view==='calendar'){ui.month=today().slice(0,7);keepUi()}jump=true;renderView()}
function shiftMonth(d){const [y,m]=ui.month.split('-').map(Number),t=new Date(Date.UTC(y,m-1+d,1));ui.month=t.toISOString().slice(0,7);keepUi();renderView()}

// ---------- views ----------
export function render(){renderView()}
function renderView(){
  ui.projects=ui.projects.filter(p=>p==='none'||project(p));
  const el=$('#timelineView'),old=el.querySelector('.tl-scroll'),keep=old&&old.dataset.view===ui.view?[old.scrollLeft,old.scrollTop]:null;
  const body={gantt,calendar,list,board}[ui.view]();
  el.innerHTML=toolbar()+`<div class="tl-scroll" data-view="${ui.view}">${body}</div>`;
  const sc=el.querySelector('.tl-scroll');
  // jump: true = today, a day number = that date, false = keep the scroll position.
  if(ui.view==='gantt'&&jump!==false){const n=jump===true?d2n(today()):jump;jump=false;sc.scrollLeft=Math.max(0,G.x(n)-(sc.clientWidth-LANE)/3)}
  else if(ui.view==='list'&&jump){jump=false;sc.querySelector('.lh.now,.lh.next')?.scrollIntoView({block:'start'})}
  else{jump=false;if(keep){sc.scrollLeft=keep[0];sc.scrollTop=keep[1]}}
}

// Projects are ordered by the chart card they sit under, so related work stays together.
const projectOrder=ps=>[...ps].sort((a,b)=>(cardName(a.entity)||'\uffff').localeCompare(cardName(b.entity)||'\uffff')||a.name.localeCompare(b.name));
function lanes(items,cards=[]){
  if(ui.groupBy==='none')return [{key:'',label:'All items',items:[...items,...cards]}];
  if(ui.groupBy==='project'){
    items=[...items,...cards];
    const out=projectOrder(db().projects.filter(p=>!ui.projects.length||ui.projects.includes(p.id))).map(p=>({key:p.id,label:p.name,sub:(n=>n.toLowerCase()===p.name.toLowerCase()?'':n)(cardName(p.entity)),color:p.color,swatch:`<i class="sw" style="background:${p.color}"></i>`,items:items.filter(i=>i.projects.includes(p.id))}));
    const none=items.filter(i=>!i.projects.length);
    if(none.length||!out.length)out.push({key:'none',label:'Untagged',swatch:'<i class="sw none"></i>',items:none});
    return out;
  }
  const entries=ui.groupBy==='kind'?Object.entries(KINDS):statusEntries();
  return [...entries.map(([k,v])=>({key:k,label:v.label,swatch:icon(v.icon,13),items:items.filter(i=>i[ui.groupBy]===k)})).filter(l=>l.items.length),
    ...(cards.length?[{key:'devops',label:'DevOps cards',swatch:icon('branch',13),items:cards}]:[])];
}
// Greedy row packing so items in a lane never overlap (labels included).
function packed(items,x,ppd,laneColor){
  const ends=[];let html='';
  for(const i of [...items].sort((a,b)=>a.start.localeCompare(b.start)||a.title.localeCompare(b.title))){
    const [s,e]=span(i),range=isRange(i),x0=x(s),w=(e-s+1)*ppd,labelW=i.title.length*6.3+(statusMark(i)?36:22),inside=range&&w>=labelW;
    const L=range?x0:x0+ppd/2-8,R=(range?x0+w:x0+ppd/2+8)+(inside?0:labelW);
    let r=ends.findIndex(end=>end<=L);if(r<0){r=ends.length;ends.push(0)}ends[r]=R+6;
    const c=laneColor||color(i),cls=`s-${i.status}${selected===i.id?' sel':''}${late(i)?' late':''}`;
    if(i.card){html+=`<div class="ti pt dvc ${cls}" data-card="${esc(i.id)}" data-tip="${esc(`DevOps #${i.card.number} · ${colName(i.card.column)}\n${i.card.title}\nDue ${fmt(i.start)} · ${project(i.card.project)?.name||''}\nClick to open the card`)}" data-tip-delay="300" style="left:${L}px;top:${r*ROW+4}px;--c:${c}"><span class="mk">${icon('branch',12)}</span><span class="nm"><span>${esc(i.title)}</span></span></div>`;continue}
    const attrs=`data-item="${esc(i.id)}" data-tip="${esc(itemTip(i))}" data-tip-delay="450"`;
    html+=range
      ?`<div class="ti bar ${cls}${inside?'':' out'}" ${attrs} style="left:${x0}px;top:${r*ROW+4}px;width:${w}px;--c:${c}"><span class="nm">${statusMark(i)}<span>${esc(i.title)}</span></span><span class="end" data-end></span></div>`
      :`<div class="ti pt k-${i.kind} ${cls}" ${attrs} style="left:${L}px;top:${r*ROW+4}px;--c:${c}"><span class="mk">${icon(KINDS[i.kind].icon,13)}</span><span class="nm">${statusMark(i)}<span>${esc(i.title)}</span></span></div>`;
  }
  return {html,rows:Math.max(1,ends.length)};
}
function laneHtml(lane){
  const n=lane.items.length,{html,rows}=packed(lane.items,G.x,G.ppd,lane.color);
  return `<div class="lane"><div class="lane-l" data-tip="${esc(lane.label)}${lane.sub?` · under ${esc(lane.sub)}`:''} · ${n} item${n===1?'':'s'}\nDouble-click the row to add an item" data-tip-delay="600">${lane.swatch||''}<span>${esc(lane.label)}${lane.sub?`<small>${esc(lane.sub)}</small>`:''}</span><em>${n||''}</em></div><div class="lane-t" data-lane="${esc(lane.key)}" style="width:${G.W}px;height:${rows*ROW+8}px">${html}</div></div>`;
}
function gantt(){
  const items=scheduled(),cards=devCards(),ppd=SCALES[ui.scale].ppd,t=d2n(today());
  // Always plan at least ~15 months ahead (Oct 2026 → through Jan 2028).
  let lo=t-45,hi=t+460;
  for(const i of [...items,...cards]){const [s,e]=span(i);lo=Math.min(lo,s-14);hi=Math.max(hi,e+45)}
  const a=new Date(lo*DAY),b=new Date(hi*DAY);
  lo=Date.UTC(a.getUTCFullYear(),a.getUTCMonth(),1)/DAY;hi=Date.UTC(b.getUTCFullYear(),b.getUTCMonth()+1,1)/DAY;
  G={lo,ppd,W:(hi-lo)*ppd,x:n=>(n-lo)*ppd};
  let top='',ticks='',grid='';
  for(let m=new Date(lo*DAY);m.getTime()/DAY<hi;){
    const n=m.getTime()/DAY,y=m.getUTCFullYear(),mo=m.getUTCMonth(),next=new Date(Date.UTC(y,mo+1,1)),x=G.x(n);
    if(ui.scale==='quarter'){ticks+=`<span class="mo" style="left:${x}px">${MONTHS[mo].slice(0,3)}</span>`;if(mo===0||n===lo)top+=`<span style="left:${x}px">${y}</span>`}
    else top+=`<span style="left:${x}px">${MONTHS[mo]} ${y}</span>`;
    grid+=`<i class="gl m" style="left:${x}px"></i>`;m=next;
  }
  if(ui.scale!=='quarter')for(let n=lo;n<hi;n++){
    const d=new Date(n*DAY),dow=d.getUTCDay(),we=dow===0||dow===6;
    if(ui.scale==='week'){ticks+=`<span class="day${we?' we':''}${n===t?' now':''}" style="left:${G.x(n)}px;width:${ppd}px">${d.getUTCDate()}</span>`;if(we)grid+=`<i class="we" style="left:${G.x(n)}px;width:${ppd}px"></i>`}
    else if(dow===1){ticks+=`<span style="left:${G.x(n)}px">${d.getUTCDate()}</span>`;grid+=`<i class="gl" style="left:${G.x(n)}px"></i>`}
  }
  return `<div class="g" style="width:${G.W+LANE}px"><div class="g-head"><div class="g-corner"></div><div class="g-scale" style="width:${G.W}px"><div class="g-top">${top}</div><div class="g-ticks">${ticks}</div></div></div>
    <div class="g-body"><div class="g-grid" style="left:${LANE}px;width:${G.W}px">${grid}<i class="today" style="left:${G.x(t)+ppd/2}px"></i></div>${lanes(items,cards).map(laneHtml).join('')}</div></div>`;
}

// ---------- chart strip: a short, read-only timeline for the selected chart card ----------
export const projectNamed=name=>{const k=name.trim().toLowerCase();return k?db().projects.find(p=>p.name.trim().toLowerCase()===k):null};
// A card's projects: those placed under it, plus a project with the card's own name.
export function projectsFor(node){
  const own=projectNamed(node.name),list=db().projects.filter(p=>p.entity===node.id&&p!==own);
  return own?[own,...projectOrder(list)]:projectOrder(list);
}
export function stripHtml(node,width,adding=false){
  const ps=projectsFor(node),ids=new Set(ps.map(p=>p.id)),all=db().timeline.filter(i=>i.projects.some(p=>ids.has(p)));
  const items=all.filter(dated),backlog=all.length-items.length,t=d2n(today());
  const next=items.filter(i=>!closed(i)&&span(i)[1]>=t).sort((a,b)=>a.start.localeCompare(b.start))[0];
  const open=p=>db().devops.cards.filter(c=>c.project===p.id&&isOpen(c)).length;
  const chips=ps.map(p=>{const n=open(p);return `<button type="button" class="tag" style="--c:${p.color}" data-strip-proj="${esc(p.id)}" data-tip="Open ${esc(p.name)} in the Timeline${n?`\n${n} open DevOps card${n===1?'':'s'}`:''}">${esc(p.name)}${n?`<em class="dvn">${n}</em>`:''}</button>`}).join('');
  const target=ps[0]?.name||node.name;
  const head=`<div class="st-h">${icon('gantt',14)}<strong>${esc(node.name)}</strong>
    ${adding?`<input id="stripNew" maxlength="80" placeholder="New project under ${esc(node.name)}" aria-label="New project name">`:`<span class="st-chips">${chips}</span>`}
    ${next&&!adding?`<span class="st-next" data-tip="Next up · ${esc(dateLabel(next))}">${icon(KINDS[next.kind].icon,12)}<span>${esc(next.title)} · ${esc(fmt(next.start))}</span></span>`:''}<span class="sp"></span>
    ${backlog?`<button type="button" class="txt st-backlog" data-strip="board" data-tip="Unscheduled items · open the Board">${backlog} in backlog</button>`:''}
    ${ib('folderPlus',`New project under ${node.name}`,{attrs:'data-strip="newProject"'})}${ib('plus',`Add an item to ${target}`,{attrs:'data-strip="add"'})}
    ${ps.length?ib('board','Open the Board',{attrs:'data-strip="board"'})+ib('arrowR','Open in Timeline',{attrs:'data-strip="open"'}):''}${ib('x','Hide project timelines',{attrs:'data-strip="close"'})}</div>`;
  if(!items.length)return head+`<div class="st-empty">${ps.length?'Nothing scheduled yet':'No projects yet'}</div>`;
  let lo=t-21,hi=t+120;
  for(const i of items){const [s,e]=span(i);lo=Math.min(lo,s-7);hi=Math.max(hi,e+21)}
  const ppd=Math.max(1,width-24)/(hi-lo),x=n=>(n-lo)*ppd,every=ppd*30<40?3:1;
  let scale='',grid='';
  for(let m=new Date(Date.UTC(new Date(lo*DAY).getUTCFullYear(),new Date(lo*DAY).getUTCMonth()+1,1));m.getTime()/DAY<hi;m=new Date(Date.UTC(m.getUTCFullYear(),m.getUTCMonth()+1,1))){
    const n=m.getTime()/DAY,mo=m.getUTCMonth();grid+=`<i class="gl" style="left:${x(n)}px"></i>`;
    if(mo%every===0)scale+=`<span style="left:${x(n)}px">${MONTHS[mo].slice(0,3)}${mo===0?' '+m.getUTCFullYear():''}</span>`;
  }
  const {html,rows}=packed(items,x,ppd,ps.length===1?ps[0].color:null);
  return head+`<div class="st-b"><div class="st-scale">${scale}</div><div class="st-t" style="height:${rows*ROW+8}px">${grid}<i class="today" style="left:${x(t)+ppd/2}px"></i>${html}</div></div>`;
}
// Create a project under a chart card (or link an existing one with that name).
export function addProject(name,entity){
  name=name.trim();if(!name)return;
  change(()=>{const p=projectByName(name);if(!p.entity)p.entity=entity});
}
// Called after switching to the Timeline tab from the chart.
export function focus({projects,itemId,view='gantt'}={}){
  ui.view=view;jump=true;
  if(projects)ui.projects=projects;
  const i=itemId&&item(itemId);
  if(i){selected=i.id;if(dated(i))jump=d2n(i.start);else ui.view='board';if(!visible().includes(i)){ui.projects=[];ui.hideDone=false}}
  keepUi();
}

// Each week gets stable row slots so a multi-day item reads as one continuous bar.
function calendar(){
  const [y,m]=ui.month.split('-').map(Number),first=Date.UTC(y,m-1,1)/DAY,last=Date.UTC(y,m,1)/DAY,start=first-(new Date(first*DAY).getUTCDay()+6)%7,weeks=Math.ceil((last-start)/7),t=d2n(today()),MAX=4;
  const items=scheduled().map(i=>({i,s:span(i)})).sort((a,b)=>a.s[0]-b.s[0]||(b.s[1]-b.s[0])-(a.s[1]-a.s[0])||a.i.title.localeCompare(b.i.title));
  let cells='';
  for(let w=0;w<weeks;w++){
    const w0=start+w*7,w1=w0+6,slots=[];
    for(const it of items.filter(({s})=>s[0]<=w1&&s[1]>=w0)){
      const a=Math.max(it.s[0],w0),b=Math.min(it.s[1],w1);
      let r=slots.findIndex(row=>row.every(o=>o.b<a||o.a>b));if(r<0){r=slots.length;slots.push([])}
      slots[r].push({...it,a,b});
    }
    for(let n=w0;n<=w1;n++){
      const date=n2d(n),here=slots.map(row=>row.find(o=>o.a<=n&&n<=o.b));
      const shown=here.slice(0,MAX),hidden=here.slice(MAX).filter(Boolean);
      const lastSlot=shown.reduce((k,o,idx)=>o?idx:k,-1);
      const chips=shown.slice(0,lastSlot+1).map(o=>{
        if(!o)return '<div class="chip gap"></div>';
        const {i,s}=o,head=n===o.a,cls=`${isRange(i)?' rng':''}${n>s[0]?' cl':''}${n<s[1]?' cr':''}${head?'':' cont'}`;
        return `<div class="chip s-${i.status}${cls}${selected===i.id?' sel':''}${late(i)?' late':''}" data-item="${esc(i.id)}" data-tip="${esc(itemTip(i))}" data-tip-delay="450" style="--c:${color(i)}">${head?icon(KINDS[i.kind].icon,11):''}<span>${head?esc(i.title):''}</span></div>`;
      }).join('');
      const more=hidden.length?`<div class="more" data-tip="${esc(hidden.map(o=>o.i.title).join('\n'))}">+${hidden.length} more</div>`:'';
      cells+=`<div class="cell${n<first||n>=last?' out':''}${n===t?' today':''}" data-date="${date}"><span class="dn">${+date.slice(8)}</span>${chips}${more}</div>`;
    }
  }
  return `<div class="cal"><div class="cal-h">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<span>${d}</span>`).join('')}</div><div class="cal-g" style="grid-template-rows:repeat(${weeks},minmax(92px,1fr))">${cells}</div></div>`;
}
function list(){
  const all=visible(),items=all.filter(dated).sort((a,b)=>a.start.localeCompare(b.start)||a.title.localeCompare(b.title));
  const backlog=all.filter(i=>!dated(i)).sort((a,b)=>PRANK[a.priority]-PRANK[b.priority]||a.title.localeCompare(b.title));
  if(!all.length)return `<div class="empty">${ib('plus','Add the first item',{key:keyLabel('timeline.add'),cls:'primary',attrs:'data-tl="add"'})}</div>`;
  const row=i=>`<div class="lr s-${i.status}${selected===i.id?' sel':''}${late(i)?' late':''}" data-item="${esc(i.id)}" tabindex="0" role="button">
      <span class="d"${late(i)?' data-tip="Overdue"':''}>${esc(dated(i)?dateLabel(i):releaseOf(i)?'→ '+releaseOf(i).title:'')}</span><span class="k" data-tip="${KINDS[i.kind].label}" style="color:${color(i)}">${icon(KINDS[i.kind].icon,13)}</span>
      <span class="t">${i.priority?`<span class="pr ${i.priority}" data-tip="${PRIORITY[i.priority].label}">${icon(PRIORITY[i.priority].icon,12)}</span>`:''}${esc(i.title)}</span><span class="tags">${i.projects.map(p=>tag(project(p))).join('')}</span><span class="o">${esc(i.owner)}</span><span class="s" data-tip="${esc(statusInfo(i.status).label)}">${icon(STATUS[i.status].icon,13)}</span></div>`;
  const now=today().slice(0,7);let html='',cur='',marked=false;
  for(const i of items){
    const ym=i.start.slice(0,7);
    if(ym!==cur){cur=ym;const cls=ym===now?' now':!marked&&ym>now?' next':'';if(cls)marked=true;html+=`<div class="lh${cls}">${monthTitle(ym)}</div>`}
    html+=row(i);
  }
  if(backlog.length)html+=`<div class="lh">Unscheduled · backlog</div>`+backlog.map(row).join('');
  return `<div class="lst">${html}</div>`;
}
// Kanban: one column per status. Cards sort by priority, then date.
function board(){
  const items=visible(),cols=statusEntries().filter(([k])=>!ui.hideDone||(k!=='done'&&k!=='cancelled'));
  const sort=(a,b)=>PRANK[a.priority]-PRANK[b.priority]||(a.start||'9999').localeCompare(b.start||'9999')||a.title.localeCompare(b.title);
  const card=i=>{
    const rel=releaseOf(i),when=dated(i)?dateLabel(i):rel?`→ ${rel.title}${dated(rel)?' · '+fmt(rel.start):''}`:'';
    return `<div class="card s-${i.status}${selected===i.id?' sel':''}${late(i)?' late':''}" data-item="${esc(i.id)}" tabindex="0" role="button" data-tip="${esc(itemTip(i))}" data-tip-delay="700" style="--c:${color(i)}">
      <div class="ct">${icon(KINDS[i.kind].icon,13)}<span>${esc(i.title)}</span>${i.priority?`<span class="pr ${i.priority}">${icon(PRIORITY[i.priority].icon,12)}</span>`:''}</div>
      <div class="cm">${i.projects.slice(0,2).map(p=>tag(project(p))).join('')}${when?`<span class="cd">${esc(when)}</span>`:''}${i.owner?`<span class="ow">${esc(i.owner)}</span>`:''}</div></div>`;
  };
  return `<div class="board">${cols.map(([k,s])=>{const list=items.filter(i=>i.status===k).sort(sort);
    return `<section class="col" data-col="${k}"><div class="col-h">${icon(s.icon,13)}<span>${esc(s.label)}</span><em>${list.length||''}</em><span class="sp"></span>${ib('plus',`Add to ${s.label}`,{attrs:`data-tl="colAdd" data-status="${k}"`})}</div>
      <div class="col-b">${list.map(card).join('')}</div></section>`}).join('')}</div>`;
}

// ---------- editing ----------
export function add(over={}){
  const board=ui.view==='board'&&over.start===undefined;
  const kind=over.kind||(board?'feature':'milestone'),start=over.start!==undefined?over.start:board?'':(ui.view==='calendar'&&ui.month!==today().slice(0,7)?ui.month+'-01':today());
  let it;
  change(()=>{
    it={id:uid(),title:`New ${KINDS[kind].label.split(' ')[0].toLowerCase()}`,kind,status:over.status||'planned',priority:'',release:'',start,end:KINDS[kind].range&&start?n2d(d2n(start)+13):'',
      projects:over.projects||ui.projects.filter(p=>p!=='none').slice(0,1),owner:'',link:'',notes:''};
    db().timeline.push(it);selected=it.id;
  });
  const t=$('#ti-title');t?.focus();t?.select();
}
function remove(id){change(()=>{db().timeline=db().timeline.filter(i=>i.id!==id);for(const i of db().timeline)if(i.release===id)i.release='';for(const c of db().devops.cards)if(c.item===id)c.item='';selected=null})}
function duplicate(id){const i=item(id);if(i)change(()=>{const c={...clone(i),id:uid(),title:i.title+' (copy)'};db().timeline.push(c);selected=c.id})}
export function projectByName(name){
  const found=db().projects.find(p=>p.name.toLowerCase()===name.toLowerCase());if(found)return found;
  const p={id:uid(),name:name.slice(0,80),color:PALETTE[db().projects.length%PALETTE.length],entity:''};db().projects.push(p);return p;
}
function addTag(input){
  const name=input.value.trim(),i=item(selected);if(!name||!i)return;
  change(()=>{const p=projectByName(name);if(!i.projects.includes(p.id))i.projects.push(p.id)});
  $('#ti-proj')?.focus();
}

const segBtn=(field,v,x,on)=>`<button type="button" class="ib${on?' on':''}" data-tset="${field}:${v}" data-tip="${esc(x.label)}" aria-label="${esc(x.label)}" aria-pressed="${on}">${icon(x.icon)}</button>`;
// An item opens as a modal growing from its bar or card (modal.js); the Projects panel stays a side panel.
let modal=null,modalFor=null;
const itemEl=id=>document.querySelector(`#timelineView [data-item="${CSS.escape(id)}"]`);
export function renderInspector(pane){
  panel(pane,selected==='projects');
  if(selected==='projects')pane.innerHTML=projectsHtml();
  const i=item(selected);
  if(!i){if(modal&&!modal.closing)modal.close();return}
  if(!modal||modal.closing){
    const m=detailModal({cls:'item-modal',label:'Timeline item',from:itemEl(i.id),
      events:{click:inspectorClick,input:inspectorInput,change:inspectorChange,keydown:inspectorKey},
      onClose(){const id=m.forId;if(modal===m)modal=null;if(selected===id){selected=null;rerender()}itemEl(id)?.focus({preventScroll:true})}});
    modal=m;
  }
  modalFor=modal.forId=i.id;modal.from(itemEl(i.id));
  const a=document.activeElement,keep=modal.el.contains(a)&&a.id?{id:a.id,s:a.selectionStart,e:a.selectionEnd}:null;
  modal.body.innerHTML=itemHtml(i);
  const f=keep&&document.getElementById(keep.id);
  if(f){f.focus({preventScroll:true});try{if(keep.s!=null)f.setSelectionRange(keep.s,keep.e)}catch{}}
  else if(!modal.el.contains(document.activeElement))modal.el.querySelector('#ti-title')?.focus({preventScroll:true});
}
function itemHtml(i){
  const k=KINDS[i.kind],people=chartNames(['person']);
  const sugg=[...db().projects.filter(p=>!i.projects.includes(p.id)).map(p=>p.name),...chartNames(['entity','area']).filter(n=>!db().projects.some(p=>p.name.toLowerCase()===n.toLowerCase()))];
  const link=/^https?:\/\//i.test(i.link)?`<a class="ib" href="${esc(i.link)}" target="_blank" rel="noopener" data-tip="Open link" aria-label="Open link">${icon('external')}</a>`:'';
  // Releases sharing a project come first in the target-release picker.
  const releases=db().timeline.filter(r=>r.kind==='release'&&r.id!==i.id).sort((a,b)=>(b.projects.some(p=>i.projects.includes(p))-a.projects.some(p=>i.projects.includes(p)))||(a.start||'9999').localeCompare(b.start||'9999'));
  const inRelease=i.kind==='release'?db().timeline.filter(x=>x.release===i.id):[],linked=cardsForItem(db(),i.id);
  return `<div class="ihead cd-h"><span class="k" style="color:${color(i)}">${icon(k.icon)}</span><strong>${k.label}</strong><span class="sp"></span>
    ${ib('copy','Duplicate',{key:keyLabel('timeline.duplicate'),attrs:'data-ti="dup"'})}${ib('trash','Delete item',{key:keyLabel('timeline.delete'),cls:'danger',attrs:'data-ti="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-ti="close"'})}</div>
    <form id="tedit" class="ibody ti-body" autocomplete="off">
    <label for="ti-title">Title</label><input id="ti-title" maxlength="200" required value="${esc(i.title)}">
    <label>Type</label><div class="seg">${Object.entries(KINDS).map(([v,x])=>segBtn('kind',v,x,i.kind===v)).join('')}</div>
    <label>Status</label><div class="seg">${statusEntries().map(([v,x])=>segBtn('status',v,x,i.status===v)).join('')}</div>
    <label>Priority</label><div class="seg">${Object.entries(PRIORITY).map(([v,x])=>segBtn('priority',v,x,i.priority===v)).join('')}</div>
    <div class="two"><div><label for="ti-start">${k.range?'Start':'Date'} <em>${dated(i)?'':'unscheduled'}</em></label><input id="ti-start" type="date" value="${i.start}"></div>
    <div><label for="ti-end">End <em>optional</em></label><input id="ti-end" type="date" min="${i.start}" value="${i.end}"${dated(i)?'':' disabled'}></div></div>
    ${i.kind!=='release'?`<label for="ti-release">Target release</label><select id="ti-release"><option value="">None</option>${releases.map(r=>`<option value="${esc(r.id)}"${i.release===r.id?' selected':''}>${esc(r.title)}${dated(r)?' · '+esc(fmt(r.start)):''}</option>`).join('')}</select>`:''}
    <label for="ti-proj">Projects</label><div class="tags-edit">${i.projects.map(id=>{const p=project(id);return p?`<span class="tag" style="--c:${p.color}">${esc(p.name)}<button type="button" data-untag="${esc(id)}" data-tip="Remove" aria-label="Remove ${esc(p.name)}">${icon('x',10)}</button></span>`:''}).join('')}
      <input id="ti-proj" list="ti-proj-list" placeholder="${i.projects.length?'':'Add project…'}" aria-label="Add project"></div>
    <datalist id="ti-proj-list">${sugg.map(s=>`<option value="${esc(s)}">`).join('')}</datalist>
    ${inRelease.length?`<label>In this release · ${inRelease.filter(closed).length}/${inRelease.length} done</label><ul class="links">${inRelease.map(x=>`<li><button type="button" data-goto-item="${esc(x.id)}" data-tip="${esc(statusInfo(x.status).label)}">${icon(STATUS[x.status].icon,12)}<span>${esc(x.title)}</span><em>${x.priority?icon(PRIORITY[x.priority].icon,11):''}</em></button></li>`).join('')}</ul>`:''}
    ${linked.length?`<label>DevOps cards · ${linked.filter(c=>!isOpen(c)).length}/${linked.length} done</label><ul class="links">${linked.map(c=>`<li><button type="button" data-goto-card="${esc(c.id)}" data-tip="Open card in DevOps">${icon('branch',12)}<span>#${c.number} ${esc(c.title)}</span><em>${esc(colName(c.column))}</em></button></li>`).join('')}</ul>`:''}
    <label for="ti-owner">Owner</label><input id="ti-owner" list="ti-people" maxlength="120" value="${esc(i.owner)}"><datalist id="ti-people">${people.map(s=>`<option value="${esc(s)}">`).join('')}</datalist>
    <label for="ti-link">Link</label><div class="linkrow"><input id="ti-link" type="url" maxlength="500" placeholder="https://" value="${esc(i.link)}">${link}</div>
    <label for="ti-notes">Notes</label><textarea id="ti-notes" rows="4" maxlength="4000">${esc(i.notes)}</textarea></form>`;
}
function projectsHtml(){
  const sugg=chartNames(['entity','area']).filter(n=>!db().projects.some(p=>p.name.toLowerCase()===n.toLowerCase())).slice(0,30),cs=cards();
  return `<div class="ihead"><span class="k">${icon('tag')}</span><strong>Projects</strong><span class="sp"></span>${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-ti="close"'})}</div>
    <div class="ibody" id="pedit">${projectOrder(db().projects).map(p=>{const n=db().timeline.filter(i=>i.projects.includes(p.id)).length;
      return `<div class="prow"><input type="color" value="${p.color}" data-pcolor="${esc(p.id)}" data-tip="Color" aria-label="Color for ${esc(p.name)}"><input value="${esc(p.name)}" maxlength="80" data-pname="${esc(p.id)}" aria-label="Project name"><em data-tip="${n} item${n===1?'':'s'}">${n}</em>${ib('trash','Delete project',{cls:'danger',attrs:`data-pdel="${esc(p.id)}"`})}
        <select class="under" data-punder="${esc(p.id)}" data-tip="The chart entity this project sits under" aria-label="Under entity"><option value="">Not under an entity</option>${cs.map(c=>`<option value="${esc(c.id)}"${p.entity===c.id?' selected':''}>Under ${esc(c.name)}</option>`).join('')}</select></div>`}).join('')}
    <div class="prow"><input id="pnew" maxlength="80" placeholder="New project" aria-label="New project name">${ib('plus','Add project',{attrs:'data-ti="padd"'})}</div>
    ${sugg.length?`<label>From your charts</label><div class="sugg">${sugg.map(s=>`<button type="button" class="tag ghost" data-padd="${esc(s)}" data-tip="Add as a project">${icon('plus',10)}${esc(s)}</button>`).join('')}</div>`:''}</div>`;
}
export function inspectorClick(e){
  const b=e.target.closest('button');if(!b)return;
  const i=item(selected);
  if(b.dataset.tset&&i){
    const [f,v]=b.dataset.tset.split(':');
    change(()=>{i[f]=f==='priority'&&i.priority===v?'':v;if(f==='kind'&&KINDS[v].range&&dated(i)&&!isRange(i))i.end=n2d(d2n(i.start)+13);if(f==='kind'&&v==='release')i.release=''});return;
  }
  if(b.dataset.untag&&i){change(()=>i.projects=i.projects.filter(p=>p!==b.dataset.untag));return}
  if(b.dataset.gotoItem){select(b.dataset.gotoItem);return}
  if(b.dataset.gotoCard){openCard(b.dataset.gotoCard);return}
  if(b.dataset.padd){change(()=>projectByName(b.dataset.padd));return}
  if(b.dataset.pdel){
    const p=project(b.dataset.pdel),n=db().timeline.filter(x=>x.projects.includes(p.id)).length;
    const drop=()=>change(()=>{db().projects=db().projects.filter(x=>x.id!==p.id);for(const x of db().timeline)x.projects=x.projects.filter(id=>id!==p.id);for(const c of db().devops.cards)if(c.project===p.id)c.project=''});
    if(!n){drop();return}
    ask(`Delete project "${p.name}"?
It will be removed from ${n} item${n===1?'':'s'}. You can undo this.`,{ok:'Delete',danger:true}).then(ok=>{if(ok)drop()});return;
  }
  ({dup:()=>duplicate(selected),delete:()=>remove(selected),close:()=>select(null),
    padd(){const v=$('#pnew').value.trim();if(v){change(()=>projectByName(v));$('#pnew')?.focus()}}})[b.dataset.ti]?.();
}
// Fields autosave as you type, one undo step per open form.
export function inspectorInput(e){
  const t=e.target;
  if(t.id==='ti-proj'){if(e.inputType==='insertReplacementText'||!e.inputType)addTag(t);return}
  if(t.id==='pnew'||t.dataset.punder||t.id==='ti-release')return;
  if(t.dataset.pname||t.dataset.pcolor){
    const p=project(t.dataset.pname||t.dataset.pcolor),form=$('#pedit');if(!p)return;
    if(t.dataset.pname&&!t.value.trim())return;
    if(!edited.has(form)){checkpoint();edited.add(form)}
    if(t.dataset.pname)p.name=t.value.trim();else p.color=t.value;
    save();renderView();return;
  }
  const form=$('#tedit'),i=item(selected);if(!form||!i)return;
  const title=$('#ti-title').value.trim(),start=$('#ti-start').value,end=$('#ti-end').value;
  if(!title)return;
  if(!edited.has(form)){checkpoint();edited.add(form)}
  const wasDated=dated(i);
  Object.assign(i,{title,start,end:start&&end&&end>start?end:'',owner:$('#ti-owner').value.trim(),link:$('#ti-link').value.trim(),notes:$('#ti-notes').value});
  $('#ti-end').min=start;$('#ti-end').disabled=!start;
  save();if(wasDated!==dated(i))rerender();else renderView();
}
export function inspectorChange(e){
  const t=e.target;
  if(t.id==='ti-proj')addTag(t);
  if(t.id==='ti-release'){const i=item(selected);if(i)change(()=>i.release=t.value)}
  if(t.dataset.punder){const p=project(t.dataset.punder);if(p)change(()=>p.entity=t.value)}
}
export function inspectorKey(e){
  if(e.key!=='Enter')return;
  if(e.target.id==='ti-proj'){e.preventDefault();addTag(e.target)}
  if(e.target.id==='pnew'){e.preventDefault();const v=e.target.value.trim();if(v){change(()=>projectByName(v));$('#pnew')?.focus()}}
}
export function key(e){
  if(e.key==='Escape'){selected=null;rerender();return}
  if(matches(e,'timeline.delete')&&item(selected)){e.preventDefault();remove(selected);return}
  if(matches(e,'timeline.duplicate')&&item(selected)){e.preventDefault();duplicate(selected);return}
  if(matches(e,'timeline.add')){e.preventDefault();add()}
  else if(matches(e,'timeline.today'))goToday();
  else{const v=[1,2,3,4].find(n=>matches(e,'timeline.view'+n));if(v){ui.view=VIEWS[v-1];jump=true;keepUi();renderView()}}
}

// ---------- calendar export ----------
function ics(){
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+/,''),d=n=>n2d(n).replace(/-/g,'');
  const tx=s=>String(s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
  const fold=l=>l.length<=74?l:l.match(/.{1,73}/g).join('\r\n ');
  const out=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Flygon Flow//Timeline//EN','CALSCALE:GREGORIAN','X-WR-CALNAME:Release calendar'];
  for(const i of scheduled()){
    const [s,e]=span(i),names=i.projects.map(p=>project(p)?.name).filter(Boolean);
    const desc=[`${KINDS[i.kind].label} · ${statusInfo(i.status).label}`,i.owner&&`Owner: ${i.owner}`,i.link,i.notes].filter(Boolean).join('\n');
    out.push('BEGIN:VEVENT',`UID:${i.id}@flygon-flow`,`DTSTAMP:${stamp}`,`DTSTART;VALUE=DATE:${d(s)}`,`DTEND;VALUE=DATE:${d(e+1)}`,
      `SUMMARY:${tx((names.length?`[${names.join(', ')}] `:'')+i.title)}`,`CATEGORIES:${[KINDS[i.kind].label,...names].map(tx).join(',')}`,
      `STATUS:${i.status==='cancelled'?'CANCELLED':'CONFIRMED'}`,`DESCRIPTION:${tx(desc)}`,...(/^https?:\/\//i.test(i.link)?[`URL:${i.link}`]:[]),'END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n')+'\r\n';
}
