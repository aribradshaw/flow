// Agent inbox: patches that agents (Claude, Codex, T3...) drop on the server and the open app merges
// into the workspace. Pure functions (no DOM, no storage) so the server, the CLI and verify.mjs can
// use them too. Format (documented in the README):
//   {id, createdAt, source, env?, ops:[...]}
//   upsertProject {name, color?, entity?}            match by name
//   upsertLabel   {id, name, section?, color?}       match by id
//   upsertItem    {id?, title, project?, ...}        match by id, else exact title + project
//   upsertCard    {id?, title, project?, ...}        match by id, else exact title + project
//   patchCard     {number? | id?, ...fields}         partial update of an existing card
// References are names: project, assignees [{name, role}], timeline item and release by title,
// labels by id or name, project entity by chart card name.
// Rules: upsert and patch only, never delete. Lists (labels, assignees, checklist, links, projects)
// only grow. A field Owner changed after the patch was written is kept and noted, never overwritten:
// cards compare `updated` with the patch's createdAt (and with the last inbox write); timeline items
// keep a signature of what the inbox last wrote and only an untouched item is updated. Applying the
// same patch twice changes nothing.
import {COLUMNS,ROLES,LINK_KINDS,SECTIONS,COLORS,newCard,moveCard} from './devops-core.js';

export const OPS=['upsertProject','upsertLabel','upsertItem','upsertCard','patchCard'];
const ID=/^[A-Za-z0-9_-]{1,80}$/,DATE=/^\d{4}-\d{2}-\d{2}$/;
const ITEM_KINDS=['feature','milestone','release','deadline','project','phase','event'],ITEM_STATUS=['planned','active','risk','blocked','done','cancelled'],PRIORITY=['high','medium','low'];
const str=v=>typeof v==='string',norm=s=>String(s??'').trim().toLowerCase();

// Returns a list of problems; empty means valid.
export function validatePatch(p){
  const e=[];
  if(!p||typeof p!=='object'||Array.isArray(p))return ['patch must be an object'];
  if(!str(p.id)||!ID.test(p.id))e.push('id: 1-80 letters, digits, - or _');
  if(!str(p.createdAt)||Number.isNaN(Date.parse(p.createdAt)))e.push('createdAt: an ISO timestamp');
  if(!str(p.source)||!p.source.trim()||p.source.length>120)e.push('source: who wrote it, e.g. "Claude"');
  if(p.env!==undefined&&(!str(p.env)||!/^[A-Za-z0-9-]{1,64}$/.test(p.env)))e.push('env: an environment id');
  if(!Array.isArray(p.ops)||!p.ops.length||p.ops.length>5000)return [...e,'ops: 1-5000 operations'];
  p.ops.forEach((o,i)=>{
    const at=`ops[${i}]`;
    if(!o||!OPS.includes(o.op))return e.push(`${at}.op: one of ${OPS.join(', ')}`);
    const need=(k,ok)=>{if(!ok(o[k]))e.push(`${at}.${k} is required`)};
    if(o.op==='upsertProject')need('name',v=>str(v)&&v.trim());
    if(o.op==='upsertLabel'){need('id',v=>str(v)&&ID.test(v));need('name',v=>str(v)&&v.trim())}
    if(o.op==='upsertItem'||o.op==='upsertCard')need('title',v=>str(v)&&v.trim());
    if(o.op==='patchCard'&&!(Number.isInteger(o.number)||str(o.id)))e.push(`${at}: number or id is required`);
    if(o.id!==undefined&&o.op!=='upsertLabel'&&(!str(o.id)||!ID.test(o.id)))e.push(`${at}.id: 1-80 letters, digits, - or _`);
    for(const k of ['start','end','due'])if(o[k]!==undefined&&o[k]!==''&&!(str(o[k])&&DATE.test(o[k])))e.push(`${at}.${k}: YYYY-MM-DD`);
    if(o.column!==undefined&&!COLUMNS.some(([c])=>c===o.column))e.push(`${at}.column: one of ${COLUMNS.map(([c])=>c).join(', ')}`);
    if(JSON.stringify(o).length>20000)e.push(`${at} is too large`);
  });
  return e;
}

const people=db=>{const m=new Map();for(const c of db.charts||[])for(const n of c.nodes)if(n.type==='person'&&!m.has(norm(n.name)))m.set(norm(n.name),n);return m};
const chartCard=(db,name)=>{for(const c of db.charts||[])for(const n of c.nodes)if((n.type==='entity'||n.type==='area')&&norm(n.name)===norm(name))return n;return null};
const sigOf=i=>JSON.stringify([i.title,i.kind,i.status,i.priority,i.start,i.end,i.owner,i.link,i.notes,i.release,[...i.projects].sort()]);

export function applyPatch(db,patch,{now=new Date().toISOString(),palette=['#7cb980','#a8524c','#3d6fb6','#b0662f','#8a4fb3']}={}){
  const out={changed:false,counts:{},notes:[]},created=Date.parse(patch.createdAt),src=patch.source;
  const count=(kind,what)=>{const c=out.counts[kind]||={added:0,updated:0};c[what]++;out.changed=true};
  const note=t=>out.notes.push(t);
  db.projects||=[];db.timeline||=[];
  const dv=db.devops,ppl=people(db);
  const project=(name,create=true)=>{
    if(!str(name)||!name.trim())return null;
    let p=db.projects.find(x=>norm(x.name)===norm(name));
    if(!p&&create){p={id:crypto.randomUUID(),name:name.trim().slice(0,80),color:palette[db.projects.length%palette.length],entity:''};db.projects.push(p);count('projects','added')}
    return p;
  };
  const item=title=>db.timeline.find(i=>norm(i.title)===norm(title));
  const label=ref=>dv.labels.find(l=>l.id===ref)||dv.labels.find(l=>norm(l.name)===norm(ref));
  // Set a scalar only if allowed; otherwise keep Owner's value and say so.
  const set=(obj,k,v,may,what)=>{if(v===undefined||obj[k]===v)return false;if(!may){note(`Kept your ${k} on ${what}`);return false}obj[k]=v;return true};

  for(const o of patch.ops){
    if(o.op==='upsertProject'){
      const had=db.projects.find(x=>norm(x.name)===norm(o.name)),p=project(o.name);
      if(o.entity){const n=chartCard(db,o.entity);if(!n)note(`No chart card named "${o.entity}" for project ${p.name}`);else if(!p.entity){p.entity=n.id;if(had)count('projects','updated')}else if(p.entity!==n.id)note(`Kept the entity of project ${p.name}`)}
      if(!had&&/^#[0-9a-f]{6}$/i.test(o.color||''))p.color=o.color;
    }
    else if(o.op==='upsertLabel'){
      if(!label(o.id)){dv.labels.push({id:o.id,name:o.name.slice(0,40),section:SECTIONS.some(([s])=>s===o.section)?o.section:'other',color:COLORS[o.color]?o.color:'black'});count('labels','added')}
    }
    else if(o.op==='upsertItem'){
      const p=o.project!==undefined?project(o.project):null,ps=[...(o.projects||[]).map(n=>project(n)),p].filter(Boolean).map(x=>x.id);
      let i=o.id?db.timeline.find(x=>x.id===o.id):db.timeline.find(x=>norm(x.title)===norm(o.title)&&(p?x.projects.includes(p.id):!x.projects.length));
      const rel=o.release?item(o.release):null;if(o.release&&!rel)note(`No release titled "${o.release}"`);
      const fields={title:o.title.trim().slice(0,200),kind:ITEM_KINDS.includes(o.kind)?o.kind:undefined,status:ITEM_STATUS.includes(o.status)?o.status:undefined,priority:PRIORITY.includes(o.priority)?o.priority:undefined,
        start:o.start,end:o.end,owner:str(o.owner)?o.owner.slice(0,120):undefined,link:str(o.link)?o.link.slice(0,500):undefined,notes:str(o.notes)?o.notes.slice(0,4000):undefined,release:rel?.id};
      if(!i){
        const start=fields.start||'';
        i={id:o.id||crypto.randomUUID(),title:fields.title,kind:fields.kind||(start?'milestone':'feature'),status:fields.status||'planned',priority:fields.priority||'',release:fields.release||'',start,end:start&&fields.end&&fields.end>start?fields.end:'',projects:[...new Set(ps)],owner:fields.owner||'',link:fields.link||'',notes:fields.notes||''};
        i.inbox={at:now,sig:sigOf(i)};db.timeline.push(i);count('items','added');continue;
      }
      // Only an item the inbox wrote and nobody changed since may be overwritten; otherwise fill blanks.
      const ours=i.inbox?.sig===sigOf(i);let changed=false;
      for(const [k,v] of Object.entries(fields)){if(v===undefined)continue;changed=set(i,k,v,ours||i[k]===''||i[k]===undefined,`"${i.title}"`)||changed}
      for(const id of ps)if(!i.projects.includes(id)){i.projects.push(id);changed=true}
      if(changed){if(ours)i.inbox={at:now,sig:sigOf(i)};count('items','updated')}
    }
    else if(o.op==='upsertCard'||o.op==='patchCard'){
      const p=o.project!==undefined?project(o.project):null;
      let c=o.op==='patchCard'?dv.cards.find(x=>o.id?x.id===o.id:x.number===o.number)
        :o.id?dv.cards.find(x=>x.id===o.id):dv.cards.find(x=>norm(x.title)===norm(o.title)&&x.project===(p?.id||''));
      if(!c&&o.op==='patchCard'){note(`No card ${o.id||'#'+o.number} to patch`);continue}
      const it=o.item!==undefined?(o.item?item(o.item):null):undefined;if(o.item&&!it)note(`No timeline item titled "${o.item}"`);
      const isNew=!c;
      if(isNew){c=newCard(dv,{id:o.id||crypto.randomUUID(),title:o.title.trim().slice(0,200)});c.created=c.updated=c.moved=now}
      // Owner's edits win: a card changed after the patch was written (other than by the inbox) keeps its values.
      const may=isNew||Date.parse(c.updated)<=created||c.updated===c.inbox?.at,what=`#${c.number}`;
      const before=JSON.stringify(c);
      if(!isNew)set(c,'title',str(o.title)&&o.title.trim()?o.title.trim().slice(0,200):undefined,may,what);
      set(c,'description',str(o.description)?o.description.slice(0,8000):undefined,may||!c.description,what);
      set(c,'points',Number.isFinite(o.points)&&o.points>=0&&o.points<=1000?o.points:undefined,may||c.points==null,what);
      set(c,'due',o.due,may||!c.due,what);
      if(p)set(c,'project',p.id,may||!c.project,what);
      if(it)set(c,'item',it.id,may||!c.item,what);
      if(o.column&&o.column!==c.column){if(may){moveCard(dv,c.id,o.column);if(isNew)c.moved=now}else note(`Kept the column of ${what}`)}
      for(const ref of o.labels||[]){const l=label(ref);if(!l)note(`No label "${ref}"`);else if(!c.labels.includes(l.id))c.labels.push(l.id)}
      for(const a of o.assignees||[]){const n=ppl.get(norm(a?.name)),role=ROLES.includes(a?.role)?a.role:'developer';if(!n)note(`No person named "${a?.name}" on the chart`);else if(!c.assignees.some(x=>x.node===n.id&&x.role===role))c.assignees.push({node:n.id,role})}
      for(const x of o.checklist||[]){
        const text=String(x?.text??x).trim().slice(0,300);if(!text)continue;
        const have=c.checklist.find(y=>norm(y.text)===norm(text));
        if(!have)c.checklist.push({id:crypto.randomUUID(),text,done:!!x?.done});
        else if(typeof x?.done==='boolean'&&have.done!==x.done){if(may)have.done=x.done;else note(`Kept your checklist tick on ${what}`)}
      }
      for(const l of o.links||[]){const url=String(l?.url??l).trim().slice(0,500);if(url&&!c.links.some(y=>y.url===url))c.links.push({id:crypto.randomUUID(),kind:LINK_KINDS[l?.kind]?l.kind:'url',url})}
      if(isNew){c.inbox={at:now};count('cards','added')}
      else if(JSON.stringify(c)!==before){c.updated=now;c.inbox={at:now};count('cards','updated')}
    }
  }
  if(out.changed)out.summary=summarize(out.counts,src);
  return out;
}
const NOUN={cards:['card','cards'],items:['timeline item','timeline items'],projects:['project','projects'],labels:['label','labels']};
export function summarize(counts,src){
  const parts=[];
  for(const what of ['added','updated'])for(const k of ['cards','items','projects','labels']){const n=counts[k]?.[what];if(n)parts.push(`${n} ${NOUN[k][n===1?0:1]}`)}
  const added=Object.values(counts).reduce((s,c)=>s+c.added,0),updated=Object.values(counts).reduce((s,c)=>s+c.updated,0);
  return `${added&&updated?'Added / updated':added?'Added':'Updated'} ${parts.join(', ')} from ${src}`;
}
