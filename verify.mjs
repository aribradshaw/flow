// End-to-end checks in headless Edge. Starts its own server on :4399 with a throwaway browser
// profile and temp save/backup folders, so it never touches the live :4317 instance, its running.json, or your saved charts.
// Run: node verify.mjs
import {spawn} from 'node:child_process';
import http from 'node:http';
import {authChecks} from './verify-auth.mjs';
import {syncChecks} from './verify-sync.mjs';
import {starterChart} from './public/demo-seed.js';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
// Edge on Windows; elsewhere Chrome/Chromium, or Playwright's Chromium in ~/.cache/ms-playwright
// (npx playwright install chromium). BROWSER=<path> picks one explicitly.
const EDGE=(()=>{
  const home=process.env.HOME||process.env.USERPROFILE||'',pw=join(home,'.cache','ms-playwright');
  const fromPw=()=>{try{return readdirSync(pw).filter(d=>/^chromium-\d+$/.test(d)).sort((a,b)=>parseInt(b.split('-')[1])-parseInt(a.split('-')[1])).flatMap(d=>[join(pw,d,'chrome-linux64','chrome'),join(pw,d,'chrome-linux','chrome'),join(pw,d,'chrome-mac','Chromium.app','Contents','MacOS','Chromium')])}catch{return []}};
  const list=[process.env.BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/microsoft-edge','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',...fromPw()].filter(Boolean);
  return list.find(f=>existsSync(f))||list[1];
})(),PORT=4399,DEBUG=9447,BASE=`http://127.0.0.1:${PORT}/`;
const savesDir=mkdtempSync(join(tmpdir(),'ocs-saves-'));
const server=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),env:{...process.env,PORT:String(PORT),ORG_CHART_VERIFY:'1',SAVES_DIR:savesDir,BACKUP_DIR:savesDir+'/backups',INBOX_DIR:savesDir+'/inbox',OPID_BASE_URL:'',OPID_APP_ID:'',OPID_APP_SECRET:'',OPID_APP_ORIGIN:'',FLOW_SYNC_URL:'',FLOW_SYNC_TOKEN:'',DATABASE_URL:''}});
await new Promise((res,rej)=>{server.stdout.once('data',res);server.once('exit',()=>rej(Error(`Server could not start on ${PORT}`)))});
const profile=mkdtempSync(join(tmpdir(),'ocs-verify-'));
// Linux hosts without unprivileged user namespaces need --no-sandbox (a throwaway profile on a loopback test server).
const edge=spawn(EDGE,['--headless=new',...(process.platform==='linux'?['--no-sandbox']:[]),`--remote-debugging-port=${DEBUG}`,`--user-data-dir=${profile}`,'--no-first-run','about:blank']);
let page;for(let i=0;i<50&&!page;i++){try{page=(await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t=>t.type==='page')}catch{}await new Promise(r=>setTimeout(r,200))}
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let seq=0;const pending=new Map(),errors=[];
ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.id){pending.get(d.id)?.(d);pending.delete(d.id)}if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.exception?.description)};
const call=(method,params={})=>new Promise((res,rej)=>{const id=++seq;pending.set(id,r=>r.error?rej(Error(method+' '+JSON.stringify(r.error))):res(r.result));ws.send(JSON.stringify({id,method,params}))});
const js=async x=>{const r=await call('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Gates and confirmations are small dialogs (modal.js ask): answer them.
const answer=async ok=>{await sleep(80);await js(`document.querySelector('dialog.ask-dlg[open] [data-ask=${ok?'ok':'cancel'}]')?.click()`);await sleep(150)};
const mouse=(type,x,y,o={})=>call('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,...o});
const drag=async(x,y,X,Y)=>{await mouse('mousePressed',x,y);for(let i=1;i<=8;i++)await mouse('mouseMoved',x+(X-x)*i/8,y+(Y-y)*i/8);await mouse('mouseReleased',X,Y)};
const key=async(k,vk,mods=0,text)=>{await call('Input.dispatchKeyEvent',{type:text?'keyDown':'rawKeyDown',key:k,modifiers:mods,windowsVirtualKeyCode:vk,text});await call('Input.dispatchKeyEvent',{type:'keyUp',key:k,modifiers:mods,windowsVirtualKeyCode:vk})};
const center=sel=>js(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
const node=id=>js(`window.orgChartStudio.getChart().nodes.find(n=>n.id===${JSON.stringify(id)})`);
const saved=()=>js(`JSON.parse(localStorage.getItem('org-chart-studio-v1'))`);
let failed=0,db;function assert(ok,msg){console.log((ok?'PASS ':'FAIL ')+msg);if(!ok)failed++}
try{
  // DevOps board data rules, checked directly in Node (no browser needed).
  {const c=await import('./public/devops-core.js');
    const base={charts:[{id:'ch',name:'x',nodes:[{id:'p1',name:'Pat',type:'person',x:0,y:0},{id:'e1',name:'Acme',type:'entity',x:0,y:0}],edges:[]}],
      projects:[{id:'pa',name:'Alpha',color:'#7cb980',entity:'e1'},{id:'pb',name:'Acme',color:'#a8524c',entity:''}],timeline:[{id:'t1'}]};
    const d=c.cleanDevops(undefined,base),db0={...base,devops:d};
    assert(d.columns.map(x=>x.id).join()==='requests,doing,blocked,uat,done,must,nice'&&d.nextNumber===1&&d.labels.some(l=>l.name==='Urgent'),'core: a database without a board gets the default columns and labels');
    const a=c.newCard(d,{title:'Fix login',project:'pa',assignees:[{node:'p1',role:'developer'}],item:'t1',due:'2026-01-02'}),b=c.newCard(d,{title:'Ship site',project:'pb'}),e=c.newCard(d,{title:'Loose'});
    assert(a.number===1&&b.number===2&&e.number===3&&d.nextNumber===4&&a.column==='requests','core: new cards land in Requests / Sprinted with increasing display numbers');
    const old=c.cleanDevops({columns:[{id:'requests',name:'Backlog: Requests'},{id:'sprinted',name:'Sprinted'},{id:'doing',name:'In flight'}],cards:[{id:'s',title:'S',number:1,column:'sprinted'},{id:'r',title:'R',number:2,column:'requests'},{id:'z',title:'Z',number:3,column:'gone'}],nextNumber:4},base);
    assert(old.cards.every(x=>x.column==='requests')&&old.columns[0].name==='Requests / Sprinted'&&old.columns[1].name==='In flight'&&!old.columns.some(x=>x.id==='sprinted'),'core: old Requests and Sprinted cards (and unknown columns) merge into Requests / Sprinted; custom names stay');
    assert(JSON.stringify(c.cleanDevops(JSON.parse(JSON.stringify(d)),base))===JSON.stringify(d),'core: cards round-trip through validation unchanged');
    const bad=c.cleanDevops({cards:[{id:'x',title:'X',number:2,project:'gone',labels:['nope'],column:'??',item:'gone'},{id:'y',title:'Y',number:2}],nextNumber:1},base);
    assert(bad.cards[0].project===''&&!bad.cards[0].labels.length&&bad.cards[0].column==='requests'&&bad.cards[0].item===''&&bad.cards[1].number!==2&&bad.nextNumber>bad.cards[1].number,'core: dangling references and duplicate numbers are repaired');
    c.moveCard(d,e.id,'requests',0);
    assert(d.cards.filter(x=>x.column==='requests').map(x=>x.title).join()==='Loose,Fix login,Ship site','core: moveCard reorders within a column');
    assert(c.gateFor(a,'doing')===null&&c.gateFor(b,'doing')==='pick-dev'&&c.gateFor(b,'done')==='confirm-done'&&c.gateFor({...b,column:'done'},'uat')==='confirm-reopen'&&c.gateFor(a,'requests')===null,'core: gates for Done, leaving Done and unassigned Doing');
    c.moveCard(d,b.id,'done');
    const f=x=>c.filterCards(db0,x).map(y=>y.title).sort().join();
    assert(f({q:'#1'})==='Fix login'&&f({q:'1'})==='Fix login'&&f({q:'ship'})==='Ship site'&&f({hideDone:true})==='Fix login,Loose'&&f({projects:['none']})==='Loose'&&f({projects:['pa','pb']})==='Fix login,Ship site'
      &&f({assignee:'p1'})==='Fix login'&&f({entity:'e1'})==='Fix login,Ship site'&&f({label:'l-urgent'})==='','core: filters (search, hide Done, projects, no project, assignee, entity, label)');
    assert(c.dueTone({due:'2026-01-01',column:'doing'},'2026-01-02')==='overdue'&&c.dueTone({due:'2026-01-04',column:'doing'},'2026-01-02')==='soon'&&c.dueTone({due:'2026-02-03',column:'doing'},'2026-01-02')===''&&c.dueTone({due:'2026-01-01',column:'done'},'2026-01-02')==='','core: due dates are overdue or due soon (two days)');
    assert(c.openCardsFor(db0,{person:'p1'}).length===1&&c.openCardsFor(db0,{entity:'e1'}).length===1,'core: open-card counts for a person and an entity');
  }
  // DevLog registry: valid DevLog entries numbered by Bradshaw Versioning in admission order.
  {const {validateDevLogEntries}=await import('@aribradshaw/devlog');
    const reg=JSON.parse(readFileSync(new URL('./public/devlog.json',import.meta.url),'utf8')),S=reg.scheme,rel=[...reg.releases].reverse();
    assert(!!validateDevLogEntries(reg.releases,{requireCommit:true,rejectAuthorEmail:true}),'devlog: the registry passes @aribradshaw/devlog validation');
    const repo=fileURLToPath(new URL('.',import.meta.url));
    let baselineInHistory=true;try{execFileSync('git',['merge-base','--is-ancestor',S.baselineCommit,'HEAD'],{cwd:repo,stdio:'ignore'})}catch{baselineInHistory=false}
    const main=baselineInHistory?execFileSync('git',['rev-list','--reverse','--first-parent',`${S.baselineCommit}..HEAD`],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(Boolean):[];
    const historical=S.historicalReleaseCount||0;
    let ok=baselineInHistory&&rel.length>=historical&&S.yearMode==='zero-based'&&S.revisions?.length>=1&&S.originYear===2026&&S.timeZone==='America/Phoenix'&&S.productionBranch==='main',last='0.0.0';
    rel.forEach((e,i)=>{
      const parts=new Intl.DateTimeFormat('en-US',{timeZone:S.timeZone,year:'numeric',month:'numeric'}).formatToParts(new Date(e.admittedAt)),y=+parts.find(p=>p.type==='year').value-S.originYear,m=+parts.find(p=>p.type==='month').value;
      const [ly,lm,lu]=last.split('.').map(Number),want=`${y}.${m}.${ly===y&&lm===m?lu+1:1}`;
      ok&&=e.version===want&&e.sequence===i+1&&(i<historical||e.commit===main[i-historical])&&(i===0||Date.parse(e.admittedAt)>=Date.parse(rel[i-1].admittedAt))&&['compatible','action-required','breaking'].includes(e.compatibility)&&(e.compatibility==='compatible'||!!e.action)&&Array.isArray(e.deployments);
      last=e.version;
    });
    assert(ok&&rel[0].version==='0.10.1','devlog: historical releases have ordered YEAR.MONTH.UPDATE versions and public commits match main');
  }
  // Agent inbox rules, checked directly in Node.
  {const c=await import('./public/devops-core.js'),ib=await import('./public/inbox-core.js');
    const db={charts:[{id:'ch',name:'x',nodes:[{id:'p1',name:'Pat Lee',type:'person',x:0,y:0},{id:'e1',name:'Acme',type:'entity',x:0,y:0}],edges:[]}],projects:[],timeline:[{id:'t0',title:'Owner item',kind:'milestone',status:'planned',priority:'',release:'',start:'2026-11-01',end:'',projects:[],owner:'',link:'',notes:'mine',}]};
    db.devops=c.cleanDevops(undefined,db);
    const t0='2026-10-29T10:00:00.000Z',p1={id:'p1',createdAt:t0,source:'Claude',ops:[
      {op:'upsertProject',name:'Alpha',entity:'Acme'},
      {op:'upsertItem',title:'Beta release',project:'Alpha',kind:'release',start:'2026-12-01'},
      {op:'upsertItem',title:'Sign-up',project:'Alpha',kind:'feature',release:'Beta release'},
      {op:'upsertItem',title:'Owner item',notes:'agent notes'},
      {op:'upsertCard',title:'Build form',project:'Alpha',labels:['Urgent','Frontend'],assignees:[{name:'pat lee',role:'developer'},{name:'Nobody',role:'tester'}],item:'Sign-up',due:'2026-11-15',points:3,checklist:[{text:'Email'},{text:'Validate',done:true}],links:[{kind:'pr',url:'https://example.test/pr/1'}]}]};
    assert(!ib.validatePatch(p1).length&&ib.validatePatch({id:'x y',ops:[{op:'drop'}]}).length>=3,'inbox: patches are validated');
    const r1=ib.applyPatch(db,p1,{now:'2026-10-29T10:05:00.000Z'}),proj=db.projects.find(p=>p.name==='Alpha'),card=db.devops.cards.find(x=>x.title==='Build form'),feat=db.timeline.find(i=>i.title==='Sign-up');
    assert(r1.changed&&proj.entity==='e1'&&card.project===proj.id&&card.assignees.length===1&&card.assignees[0].node==='p1'&&card.labels.join()==='l-urgent,l-frontend'
      &&card.item===feat.id&&feat.release===db.timeline.find(i=>i.title==='Beta release').id&&feat.projects[0]===proj.id&&card.checklist.length===2,'inbox: names resolve to projects, entities, people, labels, items and releases');
    assert(db.timeline.find(i=>i.id==='t0').notes==='mine'&&r1.notes.some(n=>/Nobody/.test(n))&&r1.notes.some(n=>/Owner item/.test(n)),"inbox: an item Owner wrote keeps its values; unknown names are noted");
    const snap=JSON.stringify(db),r2=ib.applyPatch(db,p1,{now:'2026-10-29T11:00:00.000Z'});
    assert(!r2.changed&&JSON.stringify(db)===snap,'inbox: applying the same patch twice changes nothing');
    card.title='Owner renamed it';card.updated='2026-10-29T12:00:00.000Z';
    const r3=ib.applyPatch(db,{id:'p3',createdAt:'2026-10-29T11:30:00.000Z',source:'Claude',ops:[{op:'upsertCard',id:card.id,title:'Agent title',points:8,checklist:[{text:'Email',done:true},{text:'New step'}]}]},{now:'2026-10-29T12:30:00.000Z'});
    assert(card.title==='Owner renamed it'&&card.points===3&&!card.checklist[0].done&&card.checklist.length===3&&r3.notes.length>=3,"inbox: a card Owner edited after the patch was written keeps his values; lists still grow");
    ib.applyPatch(db,{id:'p4',createdAt:'2026-10-29T13:00:00.000Z',source:'Claude',ops:[{op:'patchCard',number:card.number,column:'doing',points:5}]},{now:'2026-10-29T13:01:00.000Z'});
    ib.applyPatch(db,{id:'p5',createdAt:'2026-10-29T12:59:00.000Z',source:'Claude',ops:[{op:'patchCard',number:card.number,points:13},{op:'upsertItem',title:'Sign-up',project:'Alpha',priority:'high'}]},{now:'2026-10-29T13:02:00.000Z'});
    assert(card.column==='doing'&&card.points===13&&feat.priority==='high','inbox: later patches update what the inbox wrote (patchCard by number moves and edits)');
    assert(JSON.stringify(c.cleanDevops(JSON.parse(JSON.stringify(db.devops)),db))===JSON.stringify(db.devops),'inbox: stamped cards survive validation unchanged');
  }
  await call('Runtime.enable');await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  // Reduced motion keeps DOM updates synchronous for the checks; motion itself is checked near the end.
  const motion=on=>call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:on?'no-preference':'reduce'}]});await motion(false);
  await call('Page.navigate',{url:BASE});
  // Wait for the app to be ready (a cold browser can take a moment).
  for(let i=0;i<100&&!await js('!!window.flygonFlow&&document.querySelectorAll(".node").length>0').catch(()=>false);i++)await sleep(100);await sleep(200);
  assert(await js('document.querySelectorAll(".node").length')===7,'seed renders seven cards');
  assert((await js('window.orgChartStudio.getChart().edges')).filter(e=>e.percent==='50').length===3,'only dictated percentages are seeded');
  assert((await saved()).environment?.id==='default-workspace',"in local mode a fresh browser's workspace is Default workspace");
  await sleep(1500);
  {const w=await (await fetch(BASE+'api/workspace?env=default-workspace')).json();
    assert(w.rev===0&&!w.data,'sync: an untouched new workspace is not uploaded (no sample chart lands on the server)');}
  writeFileSync(new URL('./seed-canvas.png',import.meta.url),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));

  let [x,y]=await center('[data-node=flygon] .nm');const before=await node('flygon');
  await drag(x,y,x+53,y+21);let after=await node('flygon');
  assert(after.x%16===0&&after.y%16===0&&after.x!==before.x,'dragging snaps to the 16px grid');
  [x,y]=await center('[data-node=flygon] [data-grip]');await drag(x,y,x+40,y+20);
  after=await node('flygon');assert(after.w>176&&after.w%16===0&&after.h>48,'corner grip resizes a card');
  await key('z',90,2);await key('z',90,2);after=await node('flygon');
  assert(after.x===before.x&&after.w===undefined,'undo reverts resize and move');

  const edges=await js('window.orgChartStudio.getChart().edges.length');
  [x,y]=await center('[data-node=flygon] [data-port]');const [X,Y]=await center('[data-node=campaign]');
  await drag(x,y,X,Y);
  assert(await js('window.orgChartStudio.getChart().edges.length')===edges+1,'dragging a card port onto another card connects them');
  await js(`(()=>{const p=document.querySelector('#percent');p.value='37.5';p.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
  assert((await js('window.orgChartStudio.getChart().edges')).some(e=>e.from==='flygon'&&e.to==='campaign'&&e.percent==='37.5'),'inspector autosaves ownership percentage');
  await key('Escape',27);

  await key('e',69,0,'e');
  assert(await js('document.activeElement.id')==='name','E adds an entity and focuses its name');
  await call('Input.insertText',{text:'QA Alpha'});
  assert((await js('window.orgChartStudio.getChart().nodes')).some(n=>n.name==='QA Alpha'),'name edits autosave');
  await key('Escape',27);await key('Escape',27);

  // Project strip: selecting an entity shows its timeline slice; + adds a tagged item.
  [x,y]=await center('[data-node=flygon] .nm');await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);
  assert(await js(`!document.querySelector('#strip').hidden&&document.querySelector('#chartView').classList.contains('has-strip')`),'selecting an entity opens its project timeline strip');
  const flygonName=(await node('flygon')).name;
  await js(`document.querySelector('[data-strip=add]').click()`);await sleep(150);
  db=await saved();
  assert(await js('location.hash')==='#timeline'&&db.timeline.some(i=>i.projects.some(p=>db.projects.find(q=>q.id===p)?.name===flygonName)),'strip + adds an item tagged with that project in the Timeline');
  assert(await js(`document.querySelectorAll('.g-top span').length`)>=16,'timeline plans at least 15 months ahead');
  await key('Escape',27);await key('Escape',27);
  await js(`document.querySelector('[data-tab=chart]').click()`);await sleep(100);
  [x,y]=await center('[data-node=flygon] .nm');await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);
  assert(await js(`document.querySelectorAll('#strip [data-item]').length`)===1,'strip shows the project items');
  await js(`document.querySelector('[data-strip=newProject]').click()`);
  assert(await js('document.activeElement.id')==='stripNew','strip offers an inline new-project field');
  await call('Input.insertText',{text:'Flygon App'});await key('Enter',13);
  db=await saved();
  assert(db.projects.some(p=>p.name==='Flygon App'&&p.entity==='flygon')&&await js(`document.querySelectorAll('#strip [data-strip-proj]').length`)===2,'new project sits under the selected entity and shows in its strip');
  await key('Escape',27);

  // Right-click menus on the MindMap canvas (menu.js).
  {const rclick=async(x,y)=>{await mouse('mousePressed',x,y,{button:'right',buttons:2});await mouse('mouseReleased',x,y,{button:'right',buttons:0});await sleep(80)};
    const labels=()=>js(`[...document.querySelectorAll('.cm:not(.cm-child) .cm-l')].map(l=>l.textContent)`);
    const pick=l=>js(`(()=>{const r=[...document.querySelectorAll('.cm .cm-item')].find(r=>r.querySelector('.cm-l').textContent===${JSON.stringify(l)});r?.click();return !!r})()`);
    const count=()=>js('window.orgChartStudio.getChart().nodes.length');
    await key('Escape',27);[x,y]=await center('[data-node=campaign] .nm');await rclick(x,y);
    let ls=await labels();
    assert(ls.includes('Rename')&&ls.includes('Delete card')&&ls.includes('Duplicate')&&await js(`document.querySelector('[data-node=campaign]').classList.contains('selected')`),'right-clicking a card selects it and opens its menu (Rename … Delete card)');
    await key('Escape',27);
    assert(!await js(`document.querySelector('.cm')`)&&await js(`!!document.querySelector('[data-node=campaign].selected')`),'Esc closes the menu without deselecting the card');
    const n0=await count();await rclick(x,y);await pick('Duplicate');
    assert(await count()===n0+1,'the card menu duplicates the card');
    await key('Escape',27);
    // An empty spot on the canvas (no card, connection or floating toolbar under it).
    const [ex,ey]=await js(`(()=>{const r=document.querySelector('#canvas').getBoundingClientRect();for(let y=r.top+60;y<r.bottom-60;y+=24)for(let x=r.left+80;x<r.right-80;x+=24){const el=document.elementFromPoint(x,y);if(el&&el.closest('#canvas')&&!el.closest('[data-node],[data-edge]'))return [x,y]}})()`);
    await rclick(ex,ey);ls=await labels();
    assert(ls.includes('Add person here')&&ls.includes('Fit to window')&&ls.includes('Undo'),'right-clicking empty canvas offers Add … here, Fit and Undo');
    await pick('Add person here');await sleep(80);
    const added=await js(`(()=>{const c=window.orgChartStudio.getChart(),n=c.nodes.at(-1),r=document.querySelector('[data-node="'+n.id+'"]').getBoundingClientRect();return {type:n.type,dx:r.x+r.width/2-${ex},dy:r.y+r.height/2-${ey}}})()`);
    assert(added.type==='person'&&Math.abs(added.dx)<=20&&Math.abs(added.dy)<=20,'Add person here puts a person card centred under the pointer');
    await key('Escape',27);await key('Escape',27);
    const eid=await js(`window.orgChartStudio.getChart().edges.find(e=>e.from==='flygon'&&e.to==='campaign').id`);
    const [gx,gy]=await js(`(()=>{const p=document.querySelector('[data-edge="${eid}"] .hit'),q=p.getPointAtLength(p.getTotalLength()*.3),m=p.getScreenCTM();return [q.x*m.a+q.y*m.c+m.e,q.x*m.b+q.y*m.d+m.f]})()`);
    await rclick(gx,gy);ls=await labels();
    assert(ls.includes('Reverse direction')&&ls.includes('Delete connection'),'right-clicking a connection opens its menu');
    await pick('Reverse direction');
    assert((await js('window.orgChartStudio.getChart().edges')).some(e=>e.id===eid&&e.from==='campaign'&&e.to==='flygon'),'Reverse direction flips the connection');
    await key('z',90,2);await key('Escape',27);
    // A keyboard-opened menu (menu key / Shift+F10: no pointer position) opens under the focused card.
    const below=await js(`(()=>{const el=document.querySelector('[data-node=flygon]');el.focus();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));const a=document.querySelector('[data-node=flygon]').getBoundingClientRect(),m=document.querySelector('.cm')?.getBoundingClientRect();return !!m&&Math.abs(m.top-a.bottom)<8})()`);
    assert(below,'a keyboard-opened card menu opens under the card');
    await key('Escape',27);await key('Escape',27);}

  // Timeline
  await js(`document.querySelector('[data-tab=timeline]').click()`);await sleep(150);
  await key('n',78,0,'n');await call('Input.insertText',{text:'QA Release'});
  await js(`document.querySelector('[data-tset="kind:release"]').click()`);
  await js(`document.querySelector('#ti-proj').focus()`);await call('Input.insertText',{text:'QA Project'});await key('Enter',13);
  db=await saved();
  const item=db.timeline.find(i=>i.title==='QA Release');
  assert(item&&item.kind==='release'&&db.projects.some(p=>p.name==='QA Project'&&item.projects.includes(p.id)),'timeline item created with kind and new project tag');
  await key('Escape',27);await sleep(100);
  [x,y]=await center('.ti.k-release .mk');await drag(x,y,x+9*7,y);
  db=await saved();const moved=db.timeline.find(i=>i.title==='QA Release');
  assert(Date.parse(moved.start)-Date.parse(item.start)===7*864e5,'dragging a milestone in month view reschedules it by days');
  for(const [k,vk,cls] of [['2',50,'.cal'],['3',51,'.lst'],['1',49,'.g']]){await key(k,vk,0,k);assert(await js(`!!document.querySelector('${cls}')`),`view ${k} renders`)}
  // Styled tooltip: hover shows it after a short delay, inside the viewport, linked by aria-describedby.
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:500,buttons:0});
  [x,y]=await center('[data-tl=today]');await call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,buttons:0});
  let tooltipReady=false;
  for(let attempt=0;attempt<20&&!tooltipReady;attempt++){
    await sleep(100);
    tooltipReady=await js(`(()=>{const t=document.querySelector('.tip.on'),b=document.querySelector('[data-tl=today]'),r=t?.getBoundingClientRect();return !!t&&t.textContent.startsWith('Jump to today')&&b.getAttribute('aria-describedby')===t.id&&r.left>=0&&r.right<=innerWidth})()`);
  }
  assert(tooltipReady,'hovering shows the styled tooltip, linked with aria-describedby');
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:500,buttons:0});await sleep(50);
  // Single selects: the native select is replaced by a styled listbox but keeps its value and change event.
  assert(await js(`(()=>{const s=document.querySelector('[data-set-select=groupBy]'),b=s?.nextElementSibling;return s.classList.contains('sel-native')&&b?.classList.contains('sel-btn')&&b.textContent.includes('By project')&&b.getAttribute('aria-haspopup')==='listbox'})()`),'selects render as a styled trigger with the native select kept');
  await js(`document.querySelector('[data-set-select=groupBy]').nextElementSibling.focus()`);await key('ArrowDown',40);
  assert(await js(`document.querySelector('.picker [role=listbox]')?.getAttribute('aria-multiselectable')==='false'&&document.querySelector('.picker .pk-q').hidden&&!!document.querySelector('.picker .pk-opt[aria-selected=true]')`),'ArrowDown opens the single-select listbox with the current value selected');
  await key('ArrowDown',40);await key('Enter',13);await sleep(50);
  assert(await js(`document.querySelector('[data-set-select=groupBy]').value`)==='kind'&&!await js(`document.querySelector('.picker')`)&&/By type/.test(await js(`document.querySelector('[data-set-select=groupBy]').nextElementSibling.textContent`))&&await js(`document.activeElement.classList.contains('sel-btn')`),'choosing an option sets the select, fires change, closes and returns focus');
  await js(`document.querySelector('[data-set-select=groupBy]').nextElementSibling.click()`);await key('n',78,0,'n');await key('Enter',13);
  assert(await js(`document.querySelector('[data-set-select=groupBy]').value`)==='none','type-ahead picks an option');
  await js(`(()=>{const s=document.querySelector('[data-set-select=groupBy]');s.value='project';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);

  // Board: unscheduled features, priority, target release, drag between status columns.
  await key('4',52,0,'4');
  assert(await js(`document.querySelectorAll('.board .col').length`)===6,'board shows one column per status');
  await js(`document.querySelector('[data-col=planned] [data-tl=colAdd]').click()`);await call('Input.insertText',{text:'QA Feature'});
  await js(`document.querySelector('[data-tset="priority:high"]').click()`);
  await js(`(()=>{const s=document.querySelector('#ti-release');s.value=[...s.options].find(o=>o.text.startsWith('QA Release')).value;s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
  db=await saved();let f=db.timeline.find(i=>i.title==='QA Feature');
  assert(f&&f.kind==='feature'&&f.start===''&&f.priority==='high'&&f.release===moved.id,'board + adds an unscheduled feature with priority and target release');
  await key('Escape',27);await key('Escape',27);
  [x,y]=await center(`.card[data-item="${f.id}"]`);const [cx,cy]=await center('[data-col=active] .col-b');await drag(x,y,cx,cy);
  db=await saved();
  assert(db.timeline.find(i=>i.id===f.id).status==='active','dragging a card to another column changes its status');
  [x,y]=await center(`.card[data-item="${f.id}"]`);await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);await sleep(250);
  await js(`document.querySelector('[data-ti=complete]').click()`);await sleep(150);
  db=await saved();
  assert(db.timeline.find(i=>i.id===f.id).status==='done','the item panel marks an item done in one click');
  await key('Escape',27);await sleep(250);await mouse('mouseMoved',5,5);await sleep(250);
  assert(await js(`getComputedStyle(document.querySelector('.card[data-item="${f.id}"]')).filter.includes('grayscale')`),'a done item stays grey right after its panel closes');
  await js(`document.activeElement?.blur()`);await sleep(100);
  assert(await js(`(()=>{const s=getComputedStyle(document.querySelector('.card[data-item="${f.id}"]'));return Number(s.opacity)<.6&&s.filter.includes('grayscale')})()`),'a done item is greyed and faded');
  [x,y]=await center(`.card[data-item="${f.id}"]`);await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);await sleep(250);
  await js(`document.querySelector('[data-ti=complete]').click()`);await sleep(150);
  db=await saved();
  assert(db.timeline.find(i=>i.id===f.id).status==='planned','the same button reopens it');
  await key('Escape',27);await sleep(200);
  [x,y]=await center(`.card[data-item="${f.id}"]`);const [ax,ay]=await center('[data-col=active] .col-b');await drag(x,y,ax,ay);
  await js(`document.querySelector('.card[data-item="${moved.id}"]')?.click()`);
  [x,y]=await center(`.card[data-item="${moved.id}"]`);await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);
  assert(await js(`[...document.querySelectorAll('dialog[open] [data-goto-item]')].some(b=>b.textContent.includes('QA Feature'))`),'a release lists the features targeting it');
  await key('Escape',27);await key('1',49,0,'1');

  // DevOps board: add cards, gates, panel, search, chart and timeline links.
  assert(await js('window.flygonFlow===window.orgChartStudio&&!!window.flygonFlow.getChart'),'window.flygonFlow is exposed, with window.orgChartStudio as an alias');
  await js(`document.querySelector('[data-tab=devops]').click()`);await sleep(150);
  assert(await js('location.hash')==='#devops'&&await js(`[...document.querySelectorAll('.dcol')].map(c=>c.dataset.dcol).join()`)==='requests,doing,blocked,uat,done,must,nice','DevOps tab shows the working columns, then Done, then the backlogs');
  assert((await saved()).devops?.columns.length===7,'the saved database carries the DevOps board');
  assert(await js(`/needs testing/i.test(document.querySelector('[data-dcol=uat] .dcol-h .nm').dataset.tip)&&/completed/i.test(document.querySelector('[data-dcol=done] .dcol-h .nm').dataset.tip)`),'column headers explain UAT (needs testing) and Done (completed)');
  assert(await js(`document.querySelector('[data-dcol=done]').getBoundingClientRect().right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth`),'the five working columns fit a 1440px window and the page never scrolls sideways');
  assert(await js(`(()=>{const m=document.querySelector('[data-dcol=must]').getBoundingClientRect(),n=document.querySelector('[data-dcol=nice]').getBoundingClientRect(),b=document.querySelector('.dv-board').getBoundingClientRect();return m.left===n.left&&m.bottom<=n.top&&Math.abs(b.width-document.querySelector('.dv-scroll').clientWidth)<2})()`),'the two backlogs share one slot (Must Have above Nice to Have) and the board fills the width');
  for(const t of ['QA Card A','QA Card B']){
    await key('n',78,0,'n');
    let focused=false;for(let attempt=0;attempt<20&&!focused;attempt++){focused=await js(`document.activeElement?.id==='dc-title'`);if(!focused)await sleep(50)}
    assert(focused,'new card title receives focus');
    await call('Input.insertText',{text:t});await key('Escape',27);
    for(let attempt=0;attempt<20&&await js(`!!document.querySelector('dialog.card-modal[open]')`);attempt++)await sleep(50);
    assert(!(await js(`!!document.querySelector('dialog.card-modal[open]')`)),'card modal closes after saving');
  }
  db=await saved();
  const A=db.devops.cards.find(c=>c.title==='QA Card A'),B=db.devops.cards.find(c=>c.title==='QA Card B');
  assert(A&&B&&A.column==='requests'&&B.number===A.number+1&&await js(`document.querySelectorAll('[data-dcol=requests] .dcard').length`)===2,'N adds cards to Requests / Sprinted with increasing numbers');
  [x,y]=await center(`[data-card="${A.id}"]`);const [dx,dy]=await center('[data-dcol=doing] .dcol-b');await drag(x,y,dx,dy);await sleep(300);
  assert(await js(`!!document.querySelector('.dv-pick')`),'dragging an unassigned card into Doing asks for a developer');
  await js(`document.querySelector('.dv-pick [data-pick]:not([data-pick=""])').click()`);
  const cardA=async()=>(await saved()).devops.cards.find(c=>c.id===A.id);
  let ca=await cardA();const dev=ca.assignees[0]?.node;
  assert(ca.column==='doing'&&ca.assignees.some(a=>a.role==='developer'),'picking a developer moves the card into Doing and assigns them');
  [x,y]=await center(`[data-card="${A.id}"]`);await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);
  assert(await js(`(()=>{const d=document.querySelector('dialog.card-modal[open]');return !!d&&d.getAttribute('aria-modal')==='true'&&d.getAnimations().length>0&&d.contains(document.querySelector('#dc-title'))})()`)&&await js(`document.querySelector('#dc-title')?.value`)==='QA Card A','clicking a card opens its detail modal (aria-modal), with an opening animation');
  assert(await js('location.hash')===`#devops/card/${A.number}`,'the open card is deep-linked in the URL hash');
  await key('Escape',27);await sleep(400);
    assert(await js(`!document.querySelector('dialog.card-modal')&&document.activeElement?.dataset.card===${JSON.stringify(A.id)}&&location.hash==='#devops'`),'Esc closes the modal, returns focus to the card and clears the hash');
  await js(`history.pushState(null,'','#devops/card/${A.number}');dispatchEvent(new PopStateEvent('popstate'))`);await sleep(250);
  assert(await js(`document.querySelector('dialog.card-modal[open] #dc-title')?.value`)==='QA Card A','a #devops/card/<n> link opens that card');
  const setCol=v=>js(`(()=>{const s=document.querySelector('#dc-col');s.value='${v}';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
  await setCol('done');await answer(false);
  assert((await cardA()).column==='doing','moving straight to Done asks first (declined keeps the card)');
  await setCol('uat');
  assert(await js(`!!document.querySelector('[data-dc=approve]')`),'UAT cards offer Approve');
  await js(`document.querySelector('[data-dc=approve]').click()`);
  assert((await cardA()).column==='done','Approve moves a UAT card to Done');
  await setCol('doing');await answer(false);
  assert((await cardA()).column==='done','leaving Done asks first (declined keeps the card)');
  await setCol('doing');await answer(true);
  assert((await cardA()).column==='doing','confirming moves a card out of Done');
  const qaProj=(await saved()).projects.find(p=>p.name==='QA Project').id;
  await js(`(()=>{for(const [id,v] of [['dc-item',${JSON.stringify(moved.id)}],['dc-proj',${JSON.stringify(qaProj)}]]){const s=document.querySelector('#'+id);s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}))}
    const d=document.querySelector('#dc-due');d.value=${JSON.stringify(moved.start)};d.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
  ca=await cardA();
  assert(ca.item===moved.id&&ca.project===qaProj&&ca.due===moved.start,'the panel links a timeline item, project and due date');
  await js(`document.querySelector('dialog.card-modal [data-dc=close]')?.click()`);await sleep(250);
  await js(`document.querySelector('#dv-q').focus()`);await call('Input.insertText',{text:'#'+B.number});await sleep(150);
  assert(await js(`[...document.querySelectorAll('.dcard')].map(c=>c.dataset.card).join()`)===B.id,'search finds a card by #number');
  await js(`document.querySelector('[data-dv=clear]').click()`);
  assert(await js(`document.querySelectorAll('.dcard').length`)===2,'Clear resets the filters');
  // Multi-select picker: listbox semantics, keyboard toggling, Esc to close.
  await js(`document.querySelector('[data-picker=dv-assignees]').click()`);
  assert(await js(`document.querySelector('.picker [role=listbox]')?.getAttribute('aria-multiselectable')==='true'&&document.querySelector('[data-picker=dv-assignees]').getAttribute('aria-expanded')==='true'&&document.activeElement.classList.contains('pk-q')`),'filter picker opens as a listbox with its search focused');
  await call('Input.insertText',{text:(await node(dev)).name.slice(0,3)});
  assert(await js(`document.querySelectorAll('.picker .pk-opt').length`)===1,'typing filters the picker options');
  await key('Enter',13);
  assert(await js(`document.querySelectorAll('.dcard').length`)===1&&await js(`document.querySelector('.picker .pk-opt').getAttribute('aria-selected')`)==='true','Enter toggles an option and filters the board live');
  await key('Escape',27);
  assert(!await js(`document.querySelector('.picker')`)&&/· 1/.test(await js(`document.querySelector('[data-picker=dv-assignees]').textContent`)),'Esc closes the picker; the button shows the selection count');
  await js(`document.querySelector('[data-dv=clear]').click()`);
  // Card labels through the same picker.
  [x,y]=await center(`[data-card="${B.id}"]`);await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);
  await js(`document.querySelector('dialog[open] [data-picker=dc-labels]').click()`);
  await js(`[...document.querySelectorAll('.picker .pk-opt')].find(o=>o.textContent.includes('Urgent')).click()`);await key('Escape',27);
  assert((await saved()).devops.cards.find(c=>c.id===B.id).labels.includes('l-urgent')&&await js(`!!document.querySelector('[data-card="${B.id}"] .pill')`),'card labels are picked with the shared picker');
  await key('Escape',27);await key('Escape',27);
  await key('Escape',27);await sleep(300);
  // Chart: a person's open cards, and click-through to the filtered board.
  await js(`document.querySelector('[data-tab=chart]').click()`);await sleep(100);
  [x,y]=await center(`[data-node=${dev}] .nm`);await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);
  assert(/1 open card\b/.test(await js(`document.querySelector('#inspector [data-i=devops]')?.textContent||''`)),'a selected person shows their open DevOps cards');
  await js(`document.querySelector('#inspector [data-i=devops]').click()`);await sleep(100);
  assert(await js('location.hash')==='#devops'&&await js(`[...document.querySelectorAll('.dcard')].map(c=>c.dataset.card).join()`)===A.id,'the chart link opens the board filtered to that person');
  await js(`document.querySelector('[data-dv=clear]').click()`);
  // Timeline: linked cards in the item panel, and optional read-only card markers.
  await js(`document.querySelector('[data-tab=timeline]').click()`);await sleep(100);await key('1',49,0,'1');
  await js(`document.querySelector('[data-picker=tl-projects]').click()`);await js(`document.querySelector('.picker [data-pk=clear]').click()`);await key('Escape',27);
  await js(`document.querySelector('[data-tl=showCards]').click()`);
  assert(await js(`!!document.querySelector('.ti.dvc[data-card="${A.id}"]')`),'Show DevOps cards draws dated cards on the timeline');
  await js(`document.querySelector('[data-tl=showCards]').click()`);
  [x,y]=await center('.ti.k-release .mk');await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);
  assert(await js(`[...document.querySelectorAll('dialog[open] [data-goto-card]')].some(b=>b.textContent.includes('QA Card A'))`),'a timeline item lists its linked DevOps cards');
  await js(`document.querySelector('dialog[open] [data-goto-card]').click()`);await sleep(100);
  await sleep(200);assert((await js('location.hash')).startsWith('#devops')&&await js(`document.querySelector('#dc-title')?.value`)==='QA Card A','a linked card opens from the timeline');
  await key('Escape',27);
  await js(`document.querySelector('[data-tab=timeline]').click()`);await sleep(100);await key('Escape',27);

  // A fresh browser (no local data) gets the server's copy, never an empty or seed chart.
  await sleep(1500);
  {const w=await (await fetch(BASE+'api/workspace?env=default-workspace')).json();
    assert(w.rev>=1&&w.data.charts.some(c=>c.nodes.some(n=>n.name==='QA Alpha')),'sync: edits are saved to the server');
    await js(`(()=>{const keep=localStorage.getItem('org-chart-studio-timeline-ui');localStorage.clear();if(keep)localStorage.setItem('org-chart-studio-timeline-ui',keep);return 1})()`);
    await call('Page.reload');await sleep(1800);
    const names=(await js('window.orgChartStudio.getChart().nodes')).map(n=>n.name);
    assert(names.includes('QA Alpha')&&(await saved()).devops.cards.length===w.data.devops.cards.length,'sync: a fresh browser loads the workspace from the server');}
  // A browser holding a stale sample chart (with its own leftover environment) still opens the user's workspace.
  {const seedDb={active:'s1',charts:[starterChart('s1')],environment:{id:'stale-env',name:'My workspace',ownerEmail:'owner@example.test',visibility:'private',members:[]}};
    await js(`(()=>{localStorage.setItem('org-chart-studio-v1',${JSON.stringify(JSON.stringify(seedDb))});localStorage.setItem('flygon-flow-sync-v1',JSON.stringify({env:'stale-env',rev:1,base:null,dirty:false}));return 1})()`);
    await call('Page.reload');await sleep(1800);
    const names=(await js('window.orgChartStudio.getChart().nodes')).map(n=>n.name),st=JSON.parse(await js(`localStorage.getItem('flygon-flow-sync-v1')`));
    assert(names.includes('QA Alpha')&&st.env==='default-workspace'&&(await (await fetch(BASE+'api/workspace?env=stale-env')).json()).data===null,'sync: a browser with a stale sample chart opens the server workspace and never uploads the sample');}
  await call('Page.reload');await sleep(800);
  assert(await js('location.hash')==='#timeline'&&await js('document.querySelectorAll("[data-item]").length')>0,'reload restores the timeline tab and items');
  await js(`document.querySelector('[data-tab=chart]').click()`);
  assert((await js('window.orgChartStudio.getChart().nodes')).some(n=>n.name==='QA Alpha'),'chart edits survive reload');
  const id=await js(`localStorage.getItem('org-chart-studio-v1-backup-id')`);
  await sleep(600);
  assert(await fetch(`${BASE}api/backups/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(await saved())}).then(r=>r.ok),'disk backup accepts the database with timeline fields');
  // Top bar chart actions
  await js(`document.querySelector('[data-act=new]').click()`);
  assert((await js('window.orgChartStudio.getChart()')).name==='Untitled mind map','New mind map button creates a mind map');
  await key('z',90,2);

  // Save / load: Ctrl+S snapshots the workspace; loading a save restores it (and is undoable).
  await key('s',83,2);await sleep(400);
  let list=await (await fetch(BASE+'api/saves')).json();
  assert(list.saves.length===1&&list.saves[0].local,'Ctrl+S saves a snapshot');
  await key('e',69,0,'e');await call('Input.insertText',{text:'After save'});await key('Escape',27);await key('Escape',27);
  await js(`document.querySelector('[data-act=load]').click()`);await sleep(400);
  await js(`document.querySelector('#loadPop [data-load]').click()`);await sleep(400);
  let names=(await js('window.orgChartStudio.getChart().nodes')).map(n=>n.name);
  assert(!names.includes('After save')&&names.includes('QA Alpha'),'loading a save restores that workspace');
  await key('z',90,2);names=(await js('window.orgChartStudio.getChart().nodes')).map(n=>n.name);
  assert(names.includes('After save'),'undo reverts a load');
  assert(await fetch(BASE+'api/saves',{headers:{Origin:'http://evil.example'}}).then(r=>r.status)===403,'save API rejects other origins');
  await js(`document.querySelector('[data-tab=devops]').click()`);await sleep(150);
  // Card shape: square left corners with the pixel bar (pseudo-elements), rounded right corners.
  assert(await js(`(()=>{const c=document.querySelector('.dcard'),s=getComputedStyle(c),b=getComputedStyle(c,'::before'),a=getComputedStyle(c,'::after');return s.borderTopLeftRadius==='0px'&&s.borderBottomLeftRadius==='0px'&&parseFloat(s.borderTopRightRadius)>0&&b.width==='6px'&&a.width==='6px'&&a.height==='6px'&&a.left===b.left&&a.backgroundColor!==b.backgroundColor})()`),'cards have square left corners and a 6px bar: a 6x6 pixel in the full colour over a tinted strip');
  // No card overflows (footer, avatars, pills) at narrow, medium and wide card widths; the header avatar fits.
  {const fits=()=>js(`[...document.querySelectorAll('.dcard')].every(c=>{const r=c.getBoundingClientRect();return c.scrollWidth<=c.clientWidth+1&&[...c.querySelectorAll('*')].every(x=>{const q=x.getBoundingClientRect();return !q.width||q.right<=r.right+0.5})})&&(()=>{const a=document.querySelector('.acct-btn'),t=document.querySelector('#top').getBoundingClientRect();if(!a)return true;const q=a.getBoundingClientRect();return q.right<=t.right&&q.top>=t.top&&q.bottom<=t.bottom})()`);
    const sizes=[];for(const w of [1024,1280,1920]){await call('Emulation.setDeviceMetricsOverride',{width:w,height:900,deviceScaleFactor:1,mobile:false});await sleep(250);sizes.push(await fits())}
    await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await sleep(200);
    await js(`document.querySelectorAll('.dcard').forEach(c=>c.style.width='180px')`);const narrow=await fits();await js(`document.querySelectorAll('.dcard').forEach(c=>c.style.width='')`);
    assert(sizes.every(Boolean)&&narrow,'cards never overflow (1024, 1280, 1920 and a 180px card) and the header avatar fits');}
  // Drag and drop (drag.js): reorder, cancel, a declined gate flies home, keyboard, one undo step per move.
  await js(`document.querySelector('[data-tab=devops]').click()`);await sleep(150);
  await key('n',78,0,'n');await call('Input.insertText',{text:'QA Card C'});await key('Escape',27);await key('Escape',27);
  const order=()=>js(`JSON.parse(localStorage.getItem('org-chart-studio-v1')).devops.cards.filter(c=>c.column==='requests').map(c=>c.title).join()`);
  const clean=()=>js(`!document.querySelector('.drag-clone,.drag-gap,.drag-src,.kb-lifted,.drag-over')`);
  assert(await order()==='QA Card B,QA Card C','drag: setup has B above C');
  let C=(await saved()).devops.cards.find(c=>c.title==='QA Card C');
  [x,y]=await center(`[data-card="${C.id}"]`);let [bx,by]=await center(`[data-card="${B.id}"]`);
  await mouse('mousePressed',x,y);for(let i=1;i<=10;i++)await mouse('mouseMoved',x,y+(by-12-y)*i/10);
  assert(await js(`!!document.querySelector('.drag-clone')&&!!document.querySelector('[data-dcol=requests].drag-over .drag-gap')`),'drag: a lifted card floats as a clone and a gap opens in the column');
  await mouse('mouseReleased',x,by-12);await sleep(300);
  assert(await order()==='QA Card C,QA Card B'&&await clean(),'drag: dropping above a card reorders within the column');
  await key('z',90,2);
  assert(await order()==='QA Card B,QA Card C','drag: one Ctrl+Z undoes the move');
  [x,y]=await center(`[data-card="${B.id}"]`);let [ex]=await center('[data-dcol=doing] .dcol-b');
  await mouse('mousePressed',x,y);for(let i=1;i<=8;i++)await mouse('mouseMoved',x+(dx-x)*i/8,y);
  await key('Escape',27);await sleep(300);await mouse('mouseReleased',dx,y);
  assert((await saved()).devops.cards.find(c=>c.id===B.id).column==='requests'&&await clean()&&await js(`!!document.querySelector('[data-dcol=requests] [data-card="${B.id}"]')`),'drag: Esc flies the card home');
  [x,y]=await center(`[data-card="${B.id}"]`);let [fx,fy]=await center('[data-dcol=done] .dcol-b');await drag(x,y,fx,fy);await answer(false);await sleep(300);
  assert((await saved()).devops.cards.find(c=>c.id===B.id).column==='requests'&&await clean()&&await js(`!!document.querySelector('[data-dcol=requests] [data-card="${B.id}"]')`),'drag: a declined Done gate flies the card back to its slot');
  [x,y]=await center(`[data-card="${B.id}"]`);await drag(x,y,x,y+200>860?y-200:y+400);await sleep(300);
  await js(`document.querySelector('[data-card="${C.id}"]').focus()`);await key(' ',32,0,' ');await sleep(120);
  assert(await js(`document.querySelector('[data-card="${C.id}"]').classList.contains('kb-lifted')&&(t=>t.startsWith('Picked up #')&&t.includes('QA Card C, Requests / Sprinted, position 2 of 2'))(document.querySelector('[data-drag-live]').textContent)`),'drag: Space picks up a focused card and announces it');
  await key('ArrowUp',38);await key(' ',32,0,' ');await sleep(200);
  assert(await order()==='QA Card C,QA Card B'&&await clean(),'drag: arrows move it and Space drops it');
  await key('z',90,2);
  // Paging: a column renders 20 cards, then "Load more".
  await js(`document.querySelector('[data-tab=devops]').click()`);await sleep(100);
  for(let i=0;i<21;i++)await js(`document.querySelector('[data-dv=colAdd][data-col=nice]').click()`);
  await key('Escape',27);await key('Escape',27);
  assert(await js(`document.querySelectorAll('[data-dcol=nice] .dcard').length`)===20&&/1 left/.test(await js(`document.querySelector('[data-dcol=nice] .dv-more')?.textContent||''`))&&await js(`document.querySelector('[data-dcol=nice] .dcol-h em').textContent`)==='21','columns page at 20 cards with a Load more button; the header shows the total');
  await js(`document.querySelector('[data-dcol=nice] .dv-more').click()`);await sleep(400);
  assert(await js(`document.querySelectorAll('[data-dcol=nice] .dcard').length`)===21&&!await js(`document.querySelector('[data-dcol=nice] .dv-more')`),'Load more shows the rest');
  // Account menu: version next to Settings (no ? button); it opens Settings on What's new.
  const latest=JSON.parse(readFileSync(new URL('./public/devlog.json',import.meta.url),'utf8')).releases[0].version;
  assert(!await js(`document.querySelector('[data-act=help],.help-pop')`),'the ? help button is gone');
  await js(`document.querySelector('#acctBtn').click()`);await sleep(150);
  assert(await js(`document.querySelector('.acct-menu .acct-row [data-acct=settings]')&&document.querySelector('.acct-menu .acct-ver')?.textContent`)===latest,'the account menu shows the version next to Settings');
  await js(`document.querySelector('.acct-menu .acct-ver').click()`);await sleep(400);
  assert(await js(`(()=>{const d=document.querySelector('dialog.acct-dlg[open]'),t=d?.querySelector('[role=tab][aria-selected=true]'),a=d?.querySelector('.hp-list .hp-meta a'),by=d?.querySelector('a.hp-by');return t?.dataset.tab==='devlog'&&t.textContent==='DevLog'&&d.querySelector('.hp-v')?.textContent==='${latest}'&&!a&&by?.href==='https://github.com/aribradshaw/devlog'&&by.rel==='noopener'&&!/Bradshaw/.test(d.querySelector('.hp-ver').textContent)})()`),'clicking the version opens Settings on the DevLog tab, with a link to the DevLog repo');
  assert(await js(`document.querySelectorAll('dialog.acct-dlg[open] .hp-list>li').length`)===10&&await js(`!!document.querySelector('dialog.acct-dlg[open] .hp-pager [aria-current=page]')`),'the DevLog shows 10 releases per page with pagination');
  await js(`document.querySelector('dialog.acct-dlg[open] .hp-pager [data-dl-page="2"]').click()`);await sleep(300);
  assert(await js(`document.querySelector('dialog.acct-dlg[open] .hp-pager [aria-current=page]')?.textContent==='2'&&document.querySelector('dialog.acct-dlg[open] .hp-list .hp-v')?.textContent==='${JSON.parse(readFileSync(new URL('./public/devlog.json',import.meta.url),'utf8')).releases[10].version}'`),'the next page loads the next releases');
  // Shortcuts: rebinding, reserved keys, conflicts with swap, reset; persisted locally and on the server.
  await js(`document.querySelector('[role=tab][data-tab=shortcuts]').click()`);await sleep(150);
  assert(await js(`document.querySelectorAll('.sc-scope').length===5&&!!document.querySelector('[data-sc="chart.addEntity"]')`),'the Shortcuts tab lists every scope');
  const rec=async(id,k,vk,mods=0,text)=>{await js(`document.querySelector('[data-sc="${id}"]').click()`);await sleep(80);await key(k,vk,mods,text);await sleep(120)};
  await rec('chart.addEntity','w',87,2);
  assert(await js(`document.querySelector('[data-row="chart.addEntity"] .sc-msg.err')?.textContent.includes('reserved')`),'browser-reserved combos are refused');
  await rec('chart.addEntity','p',80,0,'p');
  assert(await js(`!!document.querySelector('[data-row="chart.addEntity"] .sc-msg.warn [data-sc-swap]')`),'a conflict in the same scope is detected and offers a swap');
  await js(`document.querySelector('[data-sc-swap]').click()`);await sleep(120);
  let sc=JSON.parse(await js(`localStorage.getItem('flygon-flow-prefs')`)).shortcuts;
  assert(sc['chart.addEntity'][0]==='P'&&sc['chart.addPerson'][0]==='E','swapping exchanges the two bindings');
  await rec('chart.addEntity','k',75,0,'k');
  await js(`document.querySelector('dialog.acct-dlg[open]').close()`);await sleep(100);
  await js(`document.querySelector('[data-tab=chart]').click()`);await sleep(200);
  assert(await js(`document.querySelector('[data-add=entity]').dataset.key`)==='K','tooltips show the new binding');
  const nodesBefore=(await js('window.orgChartStudio.getChart()')).nodes.length;
  await key('k',75,0,'k');await key('Escape',27);await key('Escape',27);
  assert((await js('window.orgChartStudio.getChart()')).nodes.length===nodesBefore+1,'the rebound key adds an entity');
  await sleep(500);
  assert((await (await fetch(BASE+'api/prefs')).json()).prefs?.shortcuts?.['chart.addEntity']?.[0]==='K','preferences are saved on the server');
  await js(`localStorage.removeItem('flygon-flow-prefs')`);await call('Page.reload');await sleep(1200);
  assert(await js(`document.querySelector('[data-add=entity]')?.dataset.key`)==='K','the binding survives a reload (loaded from the server)');
  await js(`window.flowSettings.open()`);await sleep(250);
  assert(await js(`document.querySelector('dialog.acct-dlg[open] [role=tab][aria-selected=true]')?.dataset.tab`)==='shortcuts','Settings reopens on the last tab');
  await js(`document.querySelector('[data-sc-reset-all]').click()`);await sleep(100);
  assert(await js(`document.querySelector('[data-sc="chart.addEntity"]').textContent.trim()==='E'&&document.querySelector('[data-sc="chart.addPerson"]').textContent.trim()==='P'`),'Reset all restores the defaults');
  // Settings › Environment and API keys: long blocks open on demand, and that state outlives a redraw.
  await js(`document.querySelector('#acctTab-environment').click()`);await sleep(350);
  assert(await js(`(()=>{const p=document.querySelector('#acctPanel'),b=document.querySelector('#workflowToggle'),c=document.querySelector('[data-env-list] .cur');return p.scrollHeight<=p.clientHeight&&b.getAttribute('aria-expanded')==='false'&&document.getElementById(b.getAttribute('aria-controls')).hidden&&/Delivery · 6 statuses · 7 columns/.test(b.textContent)&&/Private/.test(c.textContent)&&/Owner: You/.test(c.textContent)&&!document.querySelector('#acctPanel dl')})()`),'Settings › Environment fits without scrolling: details are badges on the current row and Workflow is collapsed with a summary');
  await js(`document.querySelector('#workflowToggle').click()`);await sleep(50);
  assert(await js(`(()=>{const i=document.querySelector('#wf-status-planned'),c=document.querySelector('#wf-column-requests');return !document.querySelector('#workflowBody').hidden&&i.offsetHeight>0&&i.placeholder==='Planned'&&i.getAttribute('aria-label')==='Status: Planned'&&c.getAttribute('aria-label')==='Column: Requests / Sprinted'&&i.closest('label').dataset.tip==='Planned'&&!i.closest('label').textContent.trim()})()`),'the Workflow disclosure opens to one compact row per status and column');
  await js(`document.querySelector('#acctTab-apikeys').click()`);await sleep(350);
  assert(await js(`(()=>{const f=document.querySelector('#akForm'),u=document.querySelector('#akUse'),seq=[...document.querySelector('.ak').children];return f.hidden&&u.hidden&&seq.indexOf(document.querySelector('[data-ak-list]'))<seq.indexOf(u)&&/curl/.test(document.querySelector('#akUseBtn').textContent)})()`),'Settings › API keys starts with the key list, the form and the how-to folded away');
  await js(`document.querySelector('#akNewBtn').focus();document.querySelector('#akNewBtn').click()`);await sleep(250);
  assert(await js(`document.activeElement.id==='akName'&&document.querySelector('#akNewBtn').getAttribute('aria-expanded')==='true'&&/like a password/.test(document.querySelector('#akForm').textContent)&&document.querySelector('#akScope-write').scrollHeight<=document.querySelector('#akScope-write').clientHeight`),'New key opens the form, focuses its name and shows the password warning, with Read & write on one line');
  await js(`document.querySelector('#acctTab-environment').click()`);await sleep(350);
  assert(await js(`!document.querySelector('#workflowBody').hidden`),'the Workflow disclosure stays open after a redraw');
  await js(`document.querySelector('#workflowToggle').click();document.querySelector('#acctTab-apikeys').click()`);await sleep(350);
  assert(await js(`!document.querySelector('#akForm').hidden`),'the New key form stays open after a redraw');
  await js(`document.querySelector('#akNewBtn').click();document.querySelector('#acctTab-shortcuts').click()`);await sleep(200);
  await js(`document.querySelector('dialog.acct-dlg[open]').close()`);await sleep(100);
  // Agent inbox end to end: the CLI queues a patch, the open app merges it as one undoable step.
  const patchFile=join(savesDir,'patch.json');
  writeFileSync(patchFile,JSON.stringify({source:'Claude',ops:[{op:'upsertProject',name:'Inbox Project'},{op:'upsertItem',title:'Inbox milestone',project:'Inbox Project',start:'2026-12-01'},
    {op:'upsertCard',title:'Inbox card one',project:'Inbox Project',column:'doing',item:'Inbox milestone'},{op:'upsertCard',title:'Inbox card two',project:'Inbox Project'}]}));
  const cli=execFileSync(process.execPath,['tools/inbox.mjs','add',patchFile],{cwd:fileURLToPath(new URL('.',import.meta.url)),env:{...process.env,INBOX_DIR:savesDir+'/inbox'}}).toString();
  assert(/Queued/.test(cli),'inbox: the CLI validates and queues a patch');
  const undoBefore=await js('JSON.parse(localStorage.getItem("org-chart-studio-v1")).devops.cards.length');
  await call('Page.reload');await sleep(2200);
  db=await saved();
  assert(db.devops.cards.filter(c=>c.title.startsWith('Inbox card')).length===2&&db.timeline.some(i=>i.title==='Inbox milestone')&&db.devops.cards.find(c=>c.title==='Inbox card one').column==='doing','inbox: the open app merges the patch and saves it');
  assert(/Added 2 cards, 1 timeline item, 1 project from Claude/.test(await js(`document.querySelector('#inboxToast')?.textContent||''`)),'inbox: a toast says what was added, with Undo');
  assert((await (await fetch(BASE+'api/inbox')).json()).patches.length===0,'inbox: the applied patch is claimed (moved to applied/)');
  await js(`document.querySelector('#inboxToast [data-undo]').click()`);
  db=await saved();
  assert(!db.devops.cards.some(c=>c.title.startsWith('Inbox card'))&&db.devops.cards.length===undoBefore,'inbox: Undo reverts the whole patch in one step');
  // Motion: rapid tab switching with motion on ends on the last tab, fully visible, with nothing left animating.
  await motion(true);
  for(const t of ['timeline','devops','chart','timeline','devops'])await js(`document.querySelector('[data-tab=${t}]').click()`);
  await sleep(700);
  assert(await js(`document.body.dataset.tab==='devops'&&getComputedStyle(document.querySelector('#devopsView')).display==='flex'&&!document.querySelector('.sk-layer,.sk-clone')&&document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).length===0&&[...document.querySelectorAll('#devopsView .dcol,#devopsView .dv-bar')].every(e=>getComputedStyle(e).opacity==='1')`),'rapid tab switching with motion leaves the last view fully visible and no skeletons');
  // No snapping: panels and menus animate in and out, and rapid toggling leaves no ghosts.
  await js(`document.querySelector('[data-tab=chart]').click()`);await sleep(500);
  [x,y]=await center('[data-node=flygon] .nm');await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);
  const slid=await js(`document.querySelector('#inspector').getAnimations().length>0`);
  await sleep(300);await key('Escape',27);
  const leaving=await js(`!document.querySelector('#inspector').hidden&&document.querySelector('#inspector').getAnimations().length>0`);
  await sleep(400);
  assert(slid&&leaving&&await js(`document.querySelector('#inspector').hidden`),'the side panel slides in and out (and is hidden afterwards)');
  for(let i=0;i<6;i++)await js(`document.querySelector('#acctBtn').click()`);
  await sleep(400);
  assert(await js(`document.querySelectorAll('.acct-menu').length===0&&document.querySelectorAll('.picker,.ghost-out').length===0`),'rapid menu toggling leaves no ghost elements');
  await motion(false);
  // AgentFlow: an org of agents and workflows, linked to DevOps cards.
  await js(`document.activeElement?.blur();document.querySelector('[data-tab=agentflow]').click()`);await sleep(150);
  assert(await js('location.hash')==='#agentflow'&&await js(`!!document.querySelector('#agentflowView .af-empty [data-af=starter]')`),'AgentFlow starts empty with a template offer');
  await js(`document.querySelector('[data-af=starter]').click()`);await sleep(150);
  db=await saved();const lead=db.agentflow.agents[0];
  assert(db.agentflow.agents.length===4&&db.agentflow.workflows.length===1&&await js(`document.querySelectorAll('.af-node').length`)===4,'the template adds a small org and a workflow');
  assert(await js(`!document.querySelector('#inspector').hidden&&document.querySelector('#af-name')?.value`)==='Chief of staff','the new org lead opens in the side panel');
  const afTab=async k=>{await js(`document.querySelector('#af-tab-${k}').click()`);await sleep(50)};
  assert(await js(`document.querySelector('#af-tab-run').getAttribute('aria-selected')==='true'&&!document.querySelector('#af-pane-run').hidden&&document.querySelector('#af-pane-job').hidden&&!!document.querySelector('#af-new-inputs')`),'an AI agent still being set up opens on Run, with the other tabs in the DOM');
  assert(await js(`[...document.querySelectorAll('.af-setup [data-af-setup]')].map(b=>b.textContent).join()`)==='Runner,Model,Cards','the setup strip offers each missing step');
  await js(`document.querySelector('#af-setup-cards').click()`);await sleep(50);
  assert(await js(`document.querySelector('#af-tab-links').getAttribute('aria-selected')==='true'&&document.activeElement.dataset.picker`)==='af-cards','a setup chip jumps to its tab and field');
  await js(`document.querySelector('#af-tab-links').focus()`);await key('Home',36);await sleep(50);
  assert(await js(`document.activeElement.id`)==='af-tab-job'&&!await js(`document.querySelector('#af-pane-job').hidden`),'Home in the tab bar selects the first tab');
  await key('ArrowRight',39);await key('ArrowRight',39);await sleep(50);
  assert(await js(`document.activeElement.id`)==='af-tab-org'&&await js(`document.querySelector('#af-pane-org').hidden`)===false&&await js(`document.querySelectorAll('#inspector [role=tab][tabindex="0"]').length`)===1,'arrow keys move along the tab bar with one tab stop');
  await afTab('org');
  assert(await js(`(()=>{const b=document.querySelector('#af-reports');b.click();const l=[...document.querySelectorAll('.picker:not(.leaving) .pk-opt .pk-l')].map(o=>o.textContent);b.click();return l.join()})()`)==='Nobody (top level)','an agent cannot report to its own reports');
  await js(`(()=>{const i=document.querySelector('#af-name');i.focus();i.select();return 1})()`);await call('Input.insertText',{text:'Ops lead'});
  await afTab('job');
  await js(`document.querySelector('#af-new-inputs').focus()`);await call('Input.insertText',{text:'Customer email'});await key('Enter',13);
  db=await saved();
  assert(db.agentflow.agents[0].name==='Ops lead'&&db.agentflow.agents[0].inputs.includes('Customer email')&&await js(`document.activeElement.id`)==='af-new-inputs','agent fields autosave and list inputs add on Enter');
  assert(db.agentflow.agents.every(a=>a.live===false)&&await js(`document.querySelector('#af-live')?.checked`)===false&&await js(`document.querySelectorAll('.af-node.live').length`)===0,'agents start not live');
  await js(`document.querySelector('#af-live').click()`);await sleep(100);
  assert((await saved()).agentflow.agents[0].live===true&&await js(`document.querySelector('.af-node.live .af-n-run.warn b')?.textContent`)==='Live','the Live switch saves, and a live agent with no runner shows an amber badge');
  if(process.env.VERIFY_SHOTS)writeFileSync(process.env.VERIFY_SHOTS+'/agentflow-live.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await js(`document.querySelector('#af-live').click()`);await sleep(100);
  assert((await saved()).agentflow.agents[0].live===false,'and switches back off');
  await js(`document.activeElement.blur()`);await key('n',78,0,'n');await sleep(100);
  db=await saved();
  assert(db.agentflow.agents.length===5&&db.agentflow.agents[4].reportsTo===lead.id&&await js('document.activeElement.id')==='af-name','N adds an agent under the selected one');
  await js(`document.activeElement.blur()`);await key('Delete',46);await answer(true);
  assert((await saved()).agentflow.agents.length===4,'Delete removes the selected agent after a confirmation');
  await key('z',90,2);
  assert((await saved()).agentflow.agents.length===5,'undo brings the agent back');
  // The org is a canvas: drag cards, drag the dot under a card to change who reports to whom, tidy back into a tree.
  {const ag=n=>saved().then(d=>d.agentflow.agents.find(x=>x.name===n)),build=await ag('Builder'),qa=await ag('Reviewer'),res=await ag('Researcher');
    let [x,y]=await center(`[data-agent="${build.id}"] .nm`);await drag(x,y,x+120,y+150);await sleep(100);
    db=await saved();const b2=db.agentflow.agents.find(a=>a.id===build.id);
    assert(Number.isFinite(b2.x)&&db.agentflow.agents.every(a=>Number.isFinite(a.x)&&Number.isFinite(a.y))&&b2.x%16===0,'dragging an agent moves it on the grid and pins the rest in place');
    [x,y]=await center(`[data-agent="${qa.id}"] [data-port]`);const [X,Y]=await center(`[data-agent="${res.id}"] .nm`);await drag(x,y,X,Y);await sleep(100);
    assert((await ag('Researcher')).reportsTo===qa.id,'dragging the dot under a card onto another agent makes that agent report to it');
    [x,y]=await center(`[data-agent="${res.id}"] [data-port]`);const [RX,RY]=await center(`[data-agent="${qa.id}"] .nm`);await drag(x,y,RX,RY);await sleep(100);
    assert((await ag('Reviewer')).reportsTo!==res.id&&/cannot report/.test(await js(`document.querySelector('#toast')?.textContent||''`)),'a reporting loop is refused with a message');
    const n0=(await saved()).agentflow.agents.length;[x,y]=await center(`[data-agent="${qa.id}"] [data-port]`);await drag(x,y,x+40,y+260);await sleep(100);
    db=await saved();assert(db.agentflow.agents.length===n0+1&&db.agentflow.agents.at(-1).reportsTo===qa.id,'dropping the dot on empty space adds a new report there');
    const n1=(await saved()).agentflow.agents.length;[x,y]=await center(`[data-agent="${qa.id}"] [data-port]`);const [SX,SY]=await center(`[data-agent="${qa.id}"] .nm`);await drag(x,y,SX,SY);await sleep(100);
    assert((await saved()).agentflow.agents.length===n1,'dropping the dot back on its own card changes nothing');
    [x,y]=await center(`[data-agent="${qa.id}"] [data-port]`);await mouse('mousePressed',x,y);for(let i=1;i<=4;i++)await mouse('mouseMoved',x+20*i,y+60*i);
    await js(`document.querySelector('#afCanvas').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))`);await mouse('mouseReleased',x+80,y+240);await sleep(100);
    assert((await saved()).agentflow.agents.length===n1,'a cancelled port drag adds nothing');
    await js(`document.activeElement?.blur()`);await key('z',90,2);await key('z',90,2);
    assert((await ag('Researcher')).reportsTo!==qa.id&&(await saved()).agentflow.agents.length===n0,'canvas changes undo one step at a time');
    const z0=await js(`document.querySelector('.af-world').style.transform`);await js(`document.querySelector('[data-afz=in]').click()`);
    assert(await js(`document.querySelector('.af-world').style.transform`)!==z0,'the zoom buttons zoom the canvas');
    await js(`document.querySelector('[data-afz=tidy]').click()`);await sleep(100);
    assert(!(await saved()).agentflow.agents.some(a=>'x' in a),'Tidy up returns to the automatic tree');
    await js(`document.querySelector('[data-agent="${build.id}"]').click()`);await sleep(50);await js(`document.activeElement?.blur()`);await key('ArrowRight',39);
    assert(Number.isFinite((await ag('Builder')).x),'arrow keys nudge the selected agent');}
  // Right-click menus on the canvas: an agent, then empty space. Each change is one undo step.
  const rclick=async(x,y)=>{await mouse('mousePressed',x,y,{button:'right',buttons:2});await mouse('mouseReleased',x,y,{button:'right',buttons:0});await sleep(120)};
  const menuPick=async(...path)=>{for(const t of path){await js(`[...document.querySelectorAll('.cm .cm-item')].find(i=>i.querySelector('.cm-l').textContent===${JSON.stringify(t)})?.click()`);await sleep(120)}};
  {const ag=n=>saved().then(d=>d.agentflow.agents.find(x=>x.name===n)),res=await ag('Researcher'),at=async id=>rclick(...await center(`[data-agent="${id}"] .nm`));
    await at(res.id);
    assert(await js(`!!document.querySelector('.cm')&&document.querySelector('#af-name')?.value`)==='Researcher'&&!await js(`document.querySelector('#afCanvas').classList.contains('panning')`),'right-clicking an agent selects it and opens its menu, without panning');
    await menuPick('Status','Active');
    assert((await ag('Researcher')).status==='active'&&!await js(`!!document.querySelector('.cm')`),'the agent menu sets the status from a submenu');
    await at(lead.id);await key('Escape',27);await sleep(100);
    assert(!await js(`!!document.querySelector('.cm')`)&&await js(`document.querySelector('#af-name')?.value`)==='Ops lead','Escape closes the menu and keeps the selection');
    let n=(await saved()).agentflow.agents.length;await at(lead.id);await menuPick('Add direct report');
    db=await saved();assert(db.agentflow.agents.length===n+1&&db.agentflow.agents.at(-1).reportsTo===lead.id,'Add direct report adds an agent under it');
    await js(`document.activeElement.blur()`);await key('z',90,2);
    const [ex,ey]=await js(`(()=>{const r=document.querySelector('#afCanvas').getBoundingClientRect();return [r.x+40,r.bottom-40]})()`);
    assert(await js(`document.elementFromPoint(${ex},${ey})?.id`)==='afCanvas','(empty canvas spot)');
    await rclick(ex,ey);await menuPick('Add agent here');
    db=await saved();assert(db.agentflow.agents.length===n+1&&!db.agentflow.agents.at(-1).reportsTo&&Number.isFinite(db.agentflow.agents.at(-1).x),'right-clicking empty canvas adds an agent there');
    await js(`document.activeElement.blur()`);await key('z',90,2);
    assert((await saved()).agentflow.agents.length===n,'menu changes undo');
    await at(lead.id);await menuPick('Open work queue');await sleep(200);
    assert(await js('location.hash')==='#devops'&&await js(`JSON.parse(localStorage.getItem('flygon-flow-devops-ui')).agents.join()`)===lead.id&&/Agents · 1/.test(await js(`document.querySelector('[data-picker=dv-agents]')?.textContent||''`)),'Open work queue shows the DevOps board filtered to that agent');
    await js(`document.querySelector('[data-dv=clear]').click()`);await sleep(100);await js(`document.querySelector('[data-tab=agentflow]').click()`);await sleep(150);}
  // Scheduled jobs: a runner reports jobs; the tray lists them by group, and a job is promoted into the org.
  {await js(`(async()=>{const s=await import('/store.js'),c=await import('/agentflow-core.js');s.change(()=>{s.store.db.agentflow.runners=[c.reportRunner(null,'Home server',{models:[],jobs:[
      {id:'systemd:backup.timer',name:'Nightly backup',source:'systemd',group:'Home server',schedule:'Daily 22:30',command:'restic backup',lastStatus:'ok',timezone:'UTC',
        triggers:[{kind:'calendar',expr:'*-*-* 22:30:00',text:'Daily 22:30'},{kind:'boot',expr:'OnBootSec=5min',text:'5 min after boot'}],origin:'machine',drift:'Runs late after a reboot',note:'Skips the run when the disk is unmounted.'},
      {id:'claude:triage',name:'Morning triage',source:'claude',group:'Agents',schedule:'Weekdays 08:00',ai:true},
      ...Array.from({length:12},(_,i)=>({id:'vercel:app:'+i,name:'Cron '+(i+1),source:'vercel',group:'Vercel · app',schedule:'Hourly',lastStatus:i===3?'failed':'ok'}))]}).runner]});return 1})()`);await sleep(150);
    const n0=(await saved()).agentflow.agents.length;
    await js(`document.activeElement?.blur();document.querySelector('[data-af=tray]').click()`);await sleep(150);
    assert(await js(`!document.querySelector('.af-tray').hidden&&document.querySelectorAll('.af-tray .af-jg').length===3&&document.querySelectorAll('.af-tray [data-jid]').length===2&&!!document.querySelector('.af-tray .af-jg-chip')`),'the Scheduled tray lists job groups, a big group collapsed to a chip');
    assert(await js(`JSON.parse(localStorage.getItem('flygon-flow-agentflow-ui')).tray`)===true,'the tray being open is remembered');
    await js(`document.querySelector('.af-tray .af-jg-chip').click()`);await sleep(100);
    assert(await js(`document.querySelectorAll('.af-tray [data-jid]').length`)===14&&await js(`!!document.querySelector('.af-tray .af-jdot.s-failed')`),'a big group expands; a failed job shows a red dot');
    // A job's details: every trigger with its raw expression, and the zone, always explicit.
    assert(await js(`document.querySelector('[data-jid="systemd:backup.timer"] .af-tz')?.textContent==='UTC'&&!!document.querySelector('[data-jid="systemd:backup.timer"] .af-jdrift')`),'a UTC job shows a zone tag and a drift dot on its row');
    await js(`document.querySelector('[data-jid="systemd:backup.timer"] [data-af=jinfo]').click()`);await sleep(150);
    assert(await js(`(()=>{const p=document.querySelector('#agentflowView .af-jpop');if(!p||p.hidden)return false;const codes=[...p.querySelectorAll('.af-trigs code')].map(c=>c.textContent);
      return codes.join('|')==='*-*-* 22:30:00|OnBootSec=5min'&&/Time zone\\s*UTC/.test(p.querySelector('dl').innerText)&&!!p.querySelector('.af-drift')&&/Skips the run/.test(p.textContent)&&!!p.querySelector('.af-orig.o-machine')})()`),'a job\'s details show each trigger\'s raw expression, the time zone, drift, note and origin');
    await key('Escape',27);await sleep(100);
    assert(await js(`document.querySelector('#agentflowView .af-jpop').hidden`),'Escape closes the job details');
    await js(`document.querySelector('[data-jid="systemd:backup.timer"] [data-af=promote]').click()`);await sleep(150);
    db=await saved();const auto=db.agentflow.agents.at(-1);
    assert(db.agentflow.agents.length===n0+1&&auto.kind==='automation'&&auto.job?.id==='systemd:backup.timer'&&auto.schedule==='Daily 22:30'&&auto.live===false,'Promote adds the job to the org as an automation');
    assert(await js(`!!document.querySelector('#afCanvas .af-node.k-automation.sel')&&document.querySelector('#af-name')?.value==='Nightly backup'&&!document.querySelector('#af-live')&&!!document.querySelector('#af-schedule')&&!!document.querySelector('#inspector .af-jobinfo .af-trigs code')`),'the new automation is selected: a short card, and a side panel with its schedule and job, without Live');
    assert(await js(`!!document.querySelector('[data-jid="systemd:backup.timer"] [data-af=goAgent]')`),'the tray marks the job promoted');
    await js(`document.querySelector('[data-afz=fit]').click()`);await sleep(100);
    const [jx,jy]=await center('[data-jid="claude:triage"] .af-job-m'),[lx,ly]=await center(`[data-agent="${lead.id}"] .nm`);await drag(jx,jy,lx,ly);await sleep(150);
    db=await saved();const ai=db.agentflow.agents.at(-1);
    assert(db.agentflow.agents.length===n0+2&&ai.kind==='agent'&&ai.reportsTo===lead.id&&ai.runtime==='Home server'&&ai.job?.id==='claude:triage'&&!await js(`!!document.querySelector('.af-jghost')`),'dragging a job onto an agent promotes it as that agent\'s report (an AI agent for an AI job)');
    await js(`document.activeElement?.blur()`);await key('z',90,2);await key('z',90,2);await sleep(100);
    assert((await saved()).agentflow.agents.length===n0&&await js(`document.querySelectorAll('#afCanvas .k-automation').length`)===0&&!await js(`!!document.querySelector('.af-tray [data-af=goAgent]')`),'promoting undoes one step at a time');
    await key('z',90,2);await js(`document.querySelector('[data-af=tray]').click()`);await sleep(100);
    assert(!(await saved()).agentflow.runners.length&&await js(`document.querySelector('.af-tray').hidden`),'(seeded report undone, tray closed)');}
  // Alt+J and Alt+K step through the org from inside a field and keep it focused.
  {await js(`document.querySelector('[data-agent="${lead.id}"]').click()`);await sleep(100);await afTab('job');
  await js(`document.querySelector('#af-purpose').focus()`);await call('Input.dispatchKeyEvent',{type:'keyDown',key:'j',code:'KeyJ',modifiers:1,windowsVirtualKeyCode:74});await sleep(100);
  const nm=await js(`document.querySelector('#af-name').value`);
  assert(nm!=='Ops lead'&&await js(`document.activeElement.id`)==='af-purpose'&&await js(`document.querySelector('#af-tab-job').getAttribute('aria-selected')`)==='true','Alt+J selects the next agent and keeps the same field and tab');
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',modifiers:1,windowsVirtualKeyCode:75});await sleep(100);
  assert(await js(`document.querySelector('#af-name').value`)==='Ops lead'&&await js(`document.activeElement.id`)==='af-purpose','Alt+K goes back');
  await js(`document.activeElement.blur()`);}
  // Link a card from the agent, then follow the link back from the card.
  await js(`document.querySelector('[data-agent="${lead.id}"]').click()`);await sleep(100);
  await afTab('links');
  await js(`document.querySelector('#inspector [data-picker=af-cards]').click()`);await sleep(100);
  await js(`[...document.querySelectorAll('.picker .pk-opt')].find(o=>o.textContent.includes('QA Card A'))?.click()`);await key('Escape',27);await sleep(100);
  const afCard=(await saved()).devops.cards.find(c=>c.title==='QA Card A');
  assert((await saved()).agentflow.agents[0].cards.includes(afCard.id)&&await js(`[...document.querySelectorAll('#inspector [data-af-card]')].some(b=>b.textContent.includes('QA Card A'))`),'an agent links to a DevOps card from the picker');
  await key('2',50,0,'2');await sleep(100);
  assert(await js(`document.querySelectorAll('.af-flow').length===1&&document.querySelectorAll('.af-flow .af-step-chip').length===4`),'2 shows the workflow as a pipeline of steps');
  await js(`document.querySelector('[data-flow]').click()`);await sleep(100);
  await js(`document.querySelector('#inspector [data-afi=addStep]').click()`);await sleep(100);
  assert((await saved()).agentflow.workflows[0].steps.length===5&&/^af-act-/.test(await js('document.activeElement.id')),'a step can be added to a workflow');
  {const open=()=>js(`document.querySelectorAll('.af-rail [aria-expanded=true]').length`),rows=`document.querySelectorAll('.af-rail .af-sr')`;
  assert(await open()===1&&await js(`${rows}[4].getAttribute('aria-expanded')`)==='true','a new step opens in place');
  await js(`${rows}[0].click()`);await sleep(50);
  assert(await open()===1&&await js(`${rows}[0].getAttribute('aria-expanded')`)==='true'&&!!await js(`document.querySelector('#af-act-'+document.querySelector('.af-rail li').dataset.step)`),'one step is open at a time, and collapsed editors stay in the DOM');
  const sec=`document.querySelectorAll('.af-rail li')[1]`;await js(`${rows}[1].click()`);await sleep(50);
  await js(`${sec}.querySelector('[data-step-up]').focus();${sec}.querySelector('[data-step-up]').click()`);await sleep(80);
  assert(await js(`document.activeElement.dataset.stepDown||''`)&&await js(`document.activeElement.dataset.stepDown===document.querySelectorAll('.af-rail li')[0].dataset.step`),'moving a step to the top keeps focus on it');
  await key('z',90,2);await sleep(50);await js(`document.activeElement.blur()`);}
  await js(`document.activeElement.blur()`);await rclick(...await center('[data-flow] strong'));await menuPick('Duplicate workflow');
  db=await saved();assert(db.agentflow.workflows.length===2&&db.agentflow.workflows[1].steps.length===5&&db.agentflow.workflows[1].steps.every((s,i)=>s.id!==db.agentflow.workflows[0].steps[i].id),'a workflow card\'s menu duplicates it with new ids');
  await js(`document.activeElement.blur()`);await key('z',90,2);await sleep(100);
  await js(`document.activeElement.blur()`);await key('Escape',27);
  await js(`document.querySelector('[data-tab=devops]').click()`);await sleep(200);
  assert(await js(`!!document.querySelector('[data-card="${afCard.id}"] .bub.agent')`),'a delegated card shows its agent badge on the board');
  await js(`document.querySelector('[data-picker=dv-agents]').click()`);await sleep(100);
  await js(`[...document.querySelectorAll('.picker .pk-opt')].find(o=>o.textContent.includes('Ops lead'))?.click()`);await key('Escape',27);await sleep(150);
  assert(await js(`[...document.querySelectorAll('.dcard')].map(c=>c.dataset.card).join()`)===afCard.id,'the Agents filter shows the cards delegated to that agent');
  await js(`document.querySelector('[data-dv=clear]').click()`);await sleep(100);
  await js(`history.pushState(null,'','#devops/card/${afCard.number}');dispatchEvent(new PopStateEvent('popstate'))`);await sleep(300);
  assert(/Ops lead/.test(await js(`document.querySelector('dialog.card-modal[open] [data-picker=dc-agents]')?.textContent||''`)),'the card shows the agents linked to it');
  await js(`document.querySelector('dialog.card-modal[open] [data-dc-agent]').click()`);await sleep(400);
  assert(await js('location.hash')==='#agentflow'&&await js(`document.querySelector('#af-name')?.value`)==='Ops lead'&&!await js(`!!document.querySelector('dialog.card-modal[open]')`),'a card opens its agent in AgentFlow');
  await key('Escape',27);await js(`document.querySelector('[data-tab=chart]').click()`);await sleep(100);
  // Split view: two tabs side by side, focus decides where keys and the side panel go.
  {const hover=async sel=>{const [hx,hy]=await center(sel);await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:hx,y:hy,button:'none',buttons:0});await sleep(200)};
    const click=async(x,y)=>{await call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none',buttons:0});await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);await sleep(150)};
    const op=sel=>js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).opacity`);
    const panes=()=>js(`[...document.querySelectorAll('main>.pane')].map(p=>p.dataset.paneTab+(p.classList.contains('focus')?'*':'')).join('|')`);
    await js(`document.querySelector('[data-tab=devops]').click()`);await sleep(200);
    await hover('.tab[data-tab=agentflow]');
    assert(await op('[data-split-open=agentflow]')==='1'&&await op('[data-split-open=timeline]')==='0'&&!await js(`!!document.querySelector('[data-split-open=devops]')`),'split: hovering another tab reveals its split notch; the current tab has none');
    await click(...await center('[data-split-open=agentflow]'));await sleep(150);
    assert(await panes()==='devops|agentflow*'&&await js('location.hash')==='#devops|agentflow'&&await js(`[...document.querySelectorAll('.tab[aria-selected=true]')].map(t=>t.dataset.tab).join()`)==='devops,agentflow'
      &&await js(`(()=>{const [a,b]=document.querySelectorAll('main>.pane');return a.querySelectorAll('#devopsView .dcol').length===7&&!!b.querySelector('#agentflowView #afCanvas [data-agent]')&&a.getBoundingClientRect().width>400&&b.getBoundingClientRect().width>400})()`),'split: the notch shows the current view on the left and the new one on the right, both rendered and both tabs selected');
    const agentId=await js(`document.querySelector('#afCanvas [data-agent]').dataset.agent`);
    await click(...await center(`#afCanvas [data-agent="${agentId}"] .nm`));
    assert(await js(`document.querySelector('.pane[data-pane="1"] #inspector:not([hidden]) #af-name')?.value.length>0`),'split: the side panel opens inside the focused pane');
    await click(...await center('[data-dcol=doing] .dcol-h em'));
    assert(await panes()==='devops*|agentflow'&&await js(`document.body.dataset.tab==='devops'&&document.querySelector('#inspector').hidden&&!!document.querySelector('#afCanvas .af-node.sel')`),'split: pressing in the other pane moves focus there; the first pane keeps its selection');
    await key('Escape',27);await key('/',191,0,'/');
    assert(await js(`document.activeElement?.id`)==='dv-q'&&await js(`!!document.querySelector('#afCanvas .af-node.sel')`),'split: Escape and shortcuts go to the focused pane only (/ searches DevOps, the agent stays selected)');
    await js(`document.activeElement.blur()`);
    await click(...await js(`(()=>{const r=document.querySelector('#agentflowView .af-bar').getBoundingClientRect();return [r.left+3,r.top+3]})()`));
    await key('/',191,0,'/');
    assert(await panes()==='devops|agentflow*'&&await js(`document.activeElement?.id`)==='af-q'&&await js(`document.querySelector('.pane[data-pane="1"] #inspector:not([hidden]) #af-name')?.value.length>0`),'split: focusing the AgentFlow pane brings its side panel back and / searches agents');
    await js(`document.activeElement.blur()`);
    assert(await js(`(()=>{const p=document.querySelector('.pane[data-pane="1"]').getBoundingClientRect(),c=document.querySelector('#afCanvas').getBoundingClientRect();return c.width>0&&c.left>=p.left-1&&c.right<=p.right+1})()`),'split: the org canvas sizes to its pane');
    const [dx,dy]=await center('.split-div'),w0=await js(`document.querySelector('.pane[data-pane="0"]').getBoundingClientRect().width`);
    await drag(dx,dy,dx-180,dy);await sleep(100);
    const ratio=await js(`JSON.parse(localStorage.getItem('flygon-flow-split')).ratio`);
    assert(ratio<.45&&await js(`document.querySelector('.pane[data-pane="0"]').getBoundingClientRect().width`)<w0-150,'split: dragging the divider changes the ratio, which is saved');
    await drag(dx-180,dy,5,dy);await sleep(100);
    assert(Math.round(await js(`document.querySelector('.pane[data-pane="0"]').getBoundingClientRect().width`))>=360,'split: each pane keeps a minimum width');
    await js(`document.querySelector('.split-div').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await sleep(50);
    assert(await js(`JSON.parse(localStorage.getItem('flygon-flow-split')).ratio`)===.5,'split: double-clicking the divider resets it to 50/50');
    await js(`document.querySelector('[data-tab=chart]').click()`);await sleep(200);
    assert(await panes()==='devops|chart*'&&await js('location.hash')==='#devops|chart'&&await js(`document.querySelectorAll('.pane[data-pane="1"] #chartView .node').length>0`),'split: clicking a third tab replaces the focused pane');
    await js(`history.back()`);await sleep(300);
    assert(await panes()==='devops|agentflow*'&&await js('location.hash')==='#devops|agentflow','split: Back restores the previous split');
    await hover('.tab[data-tab=devops]');
    assert(await op('[data-split-close=devops]')==='1','split: hovering a shown tab reveals its ×');
    await click(...await center('[data-split-close=devops]'));
    assert(!await js(`!!document.querySelector('main>.pane')`)&&await js('location.hash')==='#agentflow'&&await js(`document.body.dataset.tab==='agentflow'&&getComputedStyle(document.querySelector('#agentflowView')).display==='flex'&&getComputedStyle(document.querySelector('#devopsView')).display==='none'&&JSON.parse(localStorage.getItem('flygon-flow-split')).tabs===null`),'split: the × closes that pane and the other view fills the window');
    await hover('.tab[data-tab=timeline]');await click(...await center('[data-split-open=timeline]'));
    await call('Emulation.setDeviceMetricsOverride',{width:820,height:900,deviceScaleFactor:1,mobile:false});await sleep(300);
    assert(!await js(`!!document.querySelector('main>.pane,[data-split-open],[data-split-close]')`)&&await js(`document.body.dataset.tab==='timeline'&&getComputedStyle(document.querySelector('#timelineView')).display==='flex'`),'split: narrow windows hide the notch and show the focused pane alone');
    await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await sleep(300);
    assert(await panes()==='agentflow|timeline*','split: the split comes back when the window is wide again');
    await hover('.tab[data-tab=timeline]');await click(...await center('[data-split-close=timeline]'));await key('Escape',27);
    await js(`document.querySelector('[data-tab=chart]').click()`);await sleep(150);
  }
  // Static files: anything under public/, nothing outside it.
  const raw=p=>new Promise(res=>http.get({host:'127.0.0.1',port:PORT,path:p},r=>{r.resume();res(r.statusCode)}).on('error',()=>res(0)));
  assert(await raw('/motion.js')===200&&await raw('/favicon.svg')===200&&(await Promise.all(['/../server.mjs','/%2e%2e/server.mjs','/..%5cserver.mjs','/.env','/%2e%2e%2fverify.mjs'].map(raw))).every(c=>c===404),'static serving covers public/ and refuses paths outside it');
  // Load-time overflow: reloading #devops must never show a horizontal scrollbar at desktop widths.
  await motion(true);
  const {identifier}=await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__ovf=[];const t0=performance.now();(function f(){for(const el of document.querySelectorAll('.dv-scroll,.dcol-b'))if(getComputedStyle(el).overflowX!=='hidden'&&el.scrollWidth>el.clientWidth+1)window.__ovf.push(el.className+' '+el.scrollWidth+'>'+el.clientWidth);if(document.querySelector('.dv-scroll')&&document.querySelector('.dv-scroll').scrollWidth>document.querySelector('.dv-scroll').clientWidth+1)window.__ovf.push('dv-scroll content wider '+document.querySelector('.dv-scroll').scrollWidth);if(performance.now()-t0<2000)requestAnimationFrame(f)})()`});
  for(const w of [1024,1280,1920]){
    await call('Emulation.setDeviceMetricsOverride',{width:w,height:900,deviceScaleFactor:1,mobile:false});
    await js(`history.replaceState(null,'','#devops')`);await call('Page.reload');await sleep(2300);
    const o=await js('window.__ovf');assert(Array.isArray(o)&&!o.length,`no horizontal overflow on the DevOps board while loading at ${w}px`+(o?.length?': '+o.slice(0,3).join(' | '):''));
  }
  await call('Page.removeScriptToEvaluateOnNewDocument',{identifier});
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await motion(false);
  // Migration: a database saved before the DevOps board existed still loads, with a seeded board.
  await js(`localStorage.setItem('org-chart-studio-v1',JSON.stringify({active:'old',charts:[{id:'old',name:'Old chart',nodes:[{id:'n1',name:'Someone',type:'person',x:0,y:0}],edges:[]}]}))`);
  await call('Page.reload');await sleep(800);
  db=await saved();
  assert((await js('window.orgChartStudio.getChart()')).name==='Old chart'&&db.devops?.columns.length===7&&db.devops.cards.length===0&&db.devops.nextNumber===1&&db.devops.labels.length>0,'an old database without a DevOps board loads and gets the default board');
  // Sign-in and environments: a second server in OneProfileID mode against a loopback mock.
  await authChecks(assert);
  // Server as the source of truth: merge rules, workspace API on files and Postgres, import CLI, relay.
  await syncChecks(assert);
  assert((await (await fetch(BASE+'api/auth/session')).json()).mode==='local','without OPID_* the app stays in local single-user mode');
  assert(!errors.length,'no uncaught page errors'+(errors.length?': '+errors.join(' | '):''));
}catch(e){failed++;console.log('FAIL '+e.message)}
finally{ws.close();edge.kill();server.kill();setTimeout(()=>{for(const d of [profile,savesDir])try{rmSync(d,{recursive:true,force:true})}catch{}},500)}
process.exitCode=failed?1:0;
