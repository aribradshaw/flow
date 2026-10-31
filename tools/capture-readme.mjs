// Capture README media from the fictional demo workspace, never from a signed-in account.
// Run: node tools/capture-readme.mjs. Requires Chromium (or BROWSER=/path/to/chrome).
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {demoWorkspace} from '../public/demo-seed.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const media=join(root,'docs/media'),frames=join(media,'frames');
const work=mkdtempSync(join(tmpdir(),'flow-readme-'));
const cache=join(homedir(),'.cache/ms-playwright');
const cached=existsSync(cache)?readdirSync(cache).filter(x=>/^chromium-\d+$/.test(x)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]))
  .map(x=>join(cache,x,'chrome-linux64/chrome')).find(existsSync):null;
const browser=process.env.BROWSER||cached||'/usr/bin/chromium';
if(!existsSync(browser))throw Error('Set BROWSER to a Chromium binary');
const appPort=4398,base=`http://127.0.0.1:${appPort}/`,profile=join(work,'profile');
const env={...process.env,PORT:String(appPort),ORG_CHART_VERIFY:'1',BACKUP_DIR:join(work,'backups'),SAVES_DIR:join(work,'saves'),INBOX_DIR:join(work,'inbox'),
  HOST:'127.0.0.1',OPID_BASE_URL:'',OPID_APP_ID:'',OPID_APP_SECRET:'',OPID_APP_ORIGIN:'',DATABASE_URL:'',FLOW_SYNC_URL:'',FLOW_SYNC_TOKEN:'',
  FLOW_INSTANCE_NAME:'Flow',FLOW_ACCENT_COLOR:'',FLOW_LOGO_PATH:'',FLOW_PUBLIC_URL:'',FLOW_LOCAL_NAME:'Demo user',FLOW_LOCAL_EMAIL:'owner@example.test'};
let server,chrome,ws,seq=0,cleanupPromise;
const pending=new Map();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function stopChild(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();
  await Promise.race([exited,wait(3000)]);
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}
}
function cleanup(){return cleanupPromise??=(async()=>{
  ws?.close();await Promise.all([stopChild(chrome),stopChild(server)]);
  if(chrome?.pid)try{process.kill(-chrome.pid,'SIGKILL')}catch{}
  for(let attempt=0;attempt<12;attempt++){
    try{rmSync(work,{recursive:true,force:true});return}catch(e){if(e.code!=='ENOTEMPTY'||attempt===11)throw e;await wait(250)}
  }
})();}
for(const [signal,code] of [['SIGINT',130],['SIGTERM',143]])process.once(signal,()=>{cleanup().finally(()=>process.exit(code))});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,r=>r.error?reject(Error(`${method}: ${JSON.stringify(r.error)}`)):resolve(r.result));ws.send(JSON.stringify({id,method,params}))});
const js=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value};
const ready=async expression=>{for(let i=0;i<80;i++){if(await js(expression))return;await wait(100)}throw Error(`Timed out waiting for ${expression}`)};
const shot=async(path,height)=>writeFileSync(path,Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,...(height?{clip:{x:0,y:0,width:1440,height,scale:1}}:{})})).data,'base64'));
const click=async selector=>{const ok=await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b)return false;b.click();return true})()`);if(!ok)throw Error(`Missing ${selector}`);await wait(450)};
const tap=async selector=>{const p=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r&&{x:r.x+r.width/2,y:r.y+r.height/2}})()`);if(!p)throw Error(`Missing ${selector}`);await call('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:1});await wait(450)};

try{
  mkdirSync(frames,{recursive:true});
  server=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',()=>reject(Error('Demo server exited')))});
  chrome=spawn(browser,['--headless=new','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','about:blank'],{stdio:'ignore',detached:true});
  const portFile=join(profile,'DevToolsActivePort');
  let debugPort;for(let i=0;i<60&&!debugPort;i++){if(existsSync(portFile))debugPort=Number(readFileSync(portFile,'utf8').split('\n')[0]);else await wait(100)}
  if(!debugPort)throw Error('Chromium did not expose its debug port');
  let page;for(let i=0;i<60&&!page;i++){try{page=(await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(p=>p.type==='page')}catch{}await wait(150)}
  if(!page)throw Error('Chromium did not open a debug page');
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.id){pending.get(r.id)?.(r);pending.delete(r.id)}};
  await call('Page.enable');await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const demo=JSON.stringify(demoWorkspace());
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('org-chart-studio-v1',${JSON.stringify(demo)});`});
  await call('Page.navigate',{url:base});
  await ready(`document.querySelector('#top [data-tab=timeline]') && !document.body.hasAttribute('aria-busy')`);
  await wait(700);
  await ready(`document.querySelector('#status')?.classList.contains('ok')`);
  await click('#top [data-tab=timeline]');
  await ready(`document.querySelector('#timelineView .tl-scroll')`);
  await shot(join(media,'timeline.png'),380);
  await shot(join(frames,'timeline-01.png'));
  await click('#timelineView [data-set="view:calendar"]');
  await click('#timelineView [data-tl="next"]');
  await shot(join(frames,'timeline-02.png'));
  await click('#timelineView [data-set="view:board"]');
  await shot(join(frames,'timeline-03.png'));
  await click('#timelineView [data-set="view:list"]');
  await shot(join(frames,'timeline-04.png'));
  await click('#top [data-tab=devops]');
  await ready(`document.querySelector('#devopsView [data-card="c-form"]')`);
  await shot(join(media,'devops.png'),660);
  await shot(join(frames,'devops-01.png'));
  await tap('#devopsView [data-card="c-form"]');
  await ready(`document.querySelector('dialog.card-modal[open]')`);
  await shot(join(frames,'devops-02.png'));
  await click('dialog.card-modal[open] [data-dc="close"]');
  await shot(join(frames,'devops-03.png'));
  console.log('Captured fictional Flow screenshots and animation frames in docs/media/');
}finally{
  await cleanup();
}
