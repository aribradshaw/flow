// Embedding (lib/embed.mjs): FLOW_FRAME_ANCESTORS parsing, frame headers, framed sign-in cookies,
// the per-request policy hook, and the headers a real server sends with and without embedding.
// Loopback only, temp folders, local single-user mode.
import {test,describe,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseAncestors,embedding,useEmbedPolicy} from '../lib/embed.mjs';

const ROOT=fileURLToPath(new URL('..',import.meta.url));

describe('parseAncestors',()=>{
  test('splits on spaces and commas, drops a trailing slash and duplicates',()=>{
    assert.deepEqual(parseAncestors(' http://127.0.0.1:8770, https://dash.example.com/  https://dash.example.com\nhttp://[::1]:9000'),
      ['http://127.0.0.1:8770','https://dash.example.com','http://[::1]:9000']);
  });
  test('empty or unset means no embedding',()=>{
    assert.deepEqual(parseAncestors(''),[]);assert.deepEqual(parseAncestors(undefined),[]);
  });
  for(const bad of ['*','https://*.example.com','dash.example.com','https://dash.example.com/app','ftp://x.example','https://a.example?x=1',"'self'",'https://x.example:443'])
    test(`refuses ${bad}`,()=>assert.throws(()=>parseAncestors(bad),/FLOW_FRAME_ANCESTORS/));
});

describe('headers',()=>{
  test('off: frame-ancestors self and X-Frame-Options SAMEORIGIN',async()=>{
    const e=embedding('');
    assert.deepEqual(e.headers(await e.decide({})),{'Content-Security-Policy':"frame-ancestors 'self'",'X-Frame-Options':'SAMEORIGIN'});
  });
  test('on: lists the origins and leaves out X-Frame-Options',async()=>{
    const e=embedding('http://127.0.0.1:8770 https://dash.example.com');
    assert.equal(e.on,true);
    assert.deepEqual(e.headers(await e.decide({})),{'Content-Security-Policy':"frame-ancestors 'self' http://127.0.0.1:8770 https://dash.example.com"});
  });
});

describe('per-request policy',()=>{
  test('adds origins for one request only; invalid ones are ignored',async()=>{
    try{
      useEmbedPolicy(req=>req.account==='a'?['https://a.example.com']:['not an origin']);
      const e=embedding('');
      const a=await e.decide({account:'a'}),b=await e.decide({account:'b'});
      assert.equal(e.headers(a)['Content-Security-Policy'],"frame-ancestors 'self' https://a.example.com");
      assert.equal(a.framedCookies,true,'a request allowed to be framed gets framed cookies by default');
      assert.deepEqual(e.headers(b),{'Content-Security-Policy':"frame-ancestors 'self'",'X-Frame-Options':'SAMEORIGIN'});
      assert.equal(b.framedCookies,false);
    }finally{useEmbedPolicy(null)}
  });
  test('decides the cookies per request, including Partitioned, over the env-var default',async()=>{
    try{
      useEmbedPolicy(req=>req.embed?{framedCookies:true,partitioned:true}:{framedCookies:false});
      const e=embedding('https://dash.example.com');
      const c='flow_sid=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60';
      assert.equal(e.cookie(c,true,await e.decide({embed:true})),'flow_sid=abc; Path=/; HttpOnly; Max-Age=60; SameSite=None; Secure; Partitioned');
      assert.equal(e.cookie(c,true,await e.decide({})),c);
    }finally{useEmbedPolicy(null)}
  });
  test('a policy that throws falls back to the default',async()=>{
    try{useEmbedPolicy(()=>{throw Error('x')});const e=embedding('https://dash.example.com');assert.deepEqual((await e.decide({})).origins,['https://dash.example.com'])}
    finally{useEmbedPolicy(null)}
  });
});

describe('cookies',()=>{
  const c='flow_sid=abc; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60';
  test('unchanged when embedding is off or the origin is not https',()=>{
    assert.equal(embedding('').cookie(c,true),c);
    assert.equal(embedding('https://dash.example.com').cookie(c,false),c);
  });
  test('SameSite=None; Secure when embedding is on over https',()=>{
    assert.equal(embedding('https://dash.example.com').cookie(c,true),'flow_sid=abc; Path=/; HttpOnly; Max-Age=60; SameSite=None; Secure');
    assert.equal(embedding('https://dash.example.com').cookie('x=1; Path=/',true),'x=1; Path=/; SameSite=None; Secure');
  });
});

describe('server',()=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-embed-'));
  after(()=>rmSync(dir,{recursive:true,force:true}));
  const env=(port,extra)=>({...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',ORG_CHART_VERIFY:'1',PORT:String(port),OPID_BASE_URL:'',OPID_APP_ID:'',OPID_APP_SECRET:'',OPID_APP_ORIGIN:'',
    BACKUP_DIR:join(dir,'b'+port),SAVES_DIR:join(dir,'s'+port),INBOX_DIR:join(dir,'i'+port),...extra});
  async function start(port,extra){
    const app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:env(port,extra)});
    let err='';app.stderr.on('data',d=>err+=d);
    await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
    return app;
  }
  test('without FLOW_FRAME_ANCESTORS only this origin may frame the page and the API',async()=>{
    const app=await start(47391,{FLOW_FRAME_ANCESTORS:''});
    try{
      for(const p of ['/','/api/v1/envs','/api/instance']){
        const r=await fetch(`http://127.0.0.1:47391${p}`);
        assert.equal(r.headers.get('content-security-policy'),"frame-ancestors 'self'",p);
        assert.equal(r.headers.get('x-frame-options'),'SAMEORIGIN',p);
      }
    }finally{app.kill()}
  });
  test('with FLOW_FRAME_ANCESTORS the page lists those origins',async()=>{
    const app=await start(47392,{FLOW_FRAME_ANCESTORS:'http://127.0.0.1:8770,https://saguaro.example.ts.net'});
    try{
      const r=await fetch('http://127.0.0.1:47392/');
      assert.equal(r.status,200);
      assert.equal(r.headers.get('content-security-policy'),"frame-ancestors 'self' http://127.0.0.1:8770 https://saguaro.example.ts.net");
      assert.equal(r.headers.get('x-frame-options'),null);
    }finally{app.kill()}
  });
  test('an invalid FLOW_FRAME_ANCESTORS stops the server at startup',()=>{
    const r=spawnSync(process.execPath,['server.mjs'],{cwd:ROOT,env:env(47393,{FLOW_FRAME_ANCESTORS:'https://*.example.com'}),encoding:'utf8',timeout:15000});
    assert.notEqual(r.status,0);assert.match(r.stderr,/FLOW_FRAME_ANCESTORS/);
  });
});
