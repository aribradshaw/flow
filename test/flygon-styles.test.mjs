// Flygon's brand colors come from the @flygon/styles package, served as installed at /flygon-styles.css.
// Flow keeps no copy of them, so a package bump is the only way they change.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const pkgCss=readFileSync(fileURLToPath(import.meta.resolve('@flygon/styles/themes.css')),'utf8');
const BRAND={'flygon-green':'#7cb980','flygon-dark':'#324b34','flygon-light':'#d1ecb0','flygon-tint':'#eef7e6','flygon-brick':'#a8524c','flygon-brick-hover':'#974a44'};
const brandIn=css=>{const root=/:root\s*\{([^}]*)\}/.exec(css)?.[1]||'';return Object.fromEntries([...root.matchAll(/--(flygon-[\w-]+)\s*:\s*(#[0-9a-f]{6})/gi)].map(([,k,v])=>[k,v.toLowerCase()]))};

test('the installed package puts the brand colors Flow uses on :root',()=>{
  assert.deepEqual(brandIn(pkgCss),BRAND);
});

test('Flow keeps no copy of the package brand colors and links the package before its own CSS',()=>{
  const style=readFileSync(join(ROOT,'public/style.css'),'utf8');
  for(const k of Object.keys(BRAND))assert.doesNotMatch(style,new RegExp(`--${k}\\s*:`),`public/style.css still defines --${k}`);
  const html=readFileSync(join(ROOT,'public/index.html'),'utf8');
  const a=html.indexOf('<link rel="stylesheet" href="/flygon-styles.css">'),b=html.indexOf('<link rel="stylesheet" href="/style.css">');
  assert.ok(a>=0&&a<b,'index.html links /flygon-styles.css before /style.css');
});

test('the server serves the package CSS as installed, and no accent override by default',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-styles-'));after(()=>rmSync(dir,{recursive:true,force:true}));
  const port=47395;
  const app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',ORG_CHART_VERIFY:'1',PORT:String(port),
    OPID_BASE_URL:'',OPID_APP_ID:'',OPID_APP_SECRET:'',OPID_APP_ORIGIN:'',FLOW_ACCENT_COLOR:'',BACKUP_DIR:join(dir,'b'),SAVES_DIR:join(dir,'s'),INBOX_DIR:join(dir,'i')}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  try{
    const r=await fetch(`http://127.0.0.1:${port}/flygon-styles.css`);
    assert.equal(r.status,200);
    assert.equal(r.headers.get('content-type'),'text/css; charset=utf-8');
    assert.equal(await r.text(),pkgCss);
    const head=await fetch(`http://127.0.0.1:${port}/flygon-styles.css`,{method:'HEAD'});
    assert.equal(head.status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/instance`).then(r=>r.json())).accent,'');
  }finally{app.kill()}
});
