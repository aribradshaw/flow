// API keys (lib/apikeys.mjs, lib/apikeys-routes.mjs): create, authenticate, scopes, expiry, revoke,
// hashes-only at rest, rate limit and the HTTP routes, on JSON files and on a throwaway embedded
// Postgres (migrations run twice). Everything is loopback and temp folders; no real database.
//   node --test test/
import {test,describe,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {apiKeyStore,authenticateApiKey,requireApiKey,allows,normScopes,migrate,SCHEMA,configureRateLimit,resetRateLimits,useRateLimiter,rateLimit,AUDIT_DAYS} from '../lib/apikeys.mjs';
import {apiKeyRoutes} from '../lib/apikeys-routes.mjs';

const OWNER='owner@example.test',CLEO='cleo@example.test';
const reqWith=(key,ip='10.0.0.1')=>({headers:key===undefined?{}:{authorization:'Bearer '+key},socket:{remoteAddress:ip}});
const sha=k=>createHash('sha256').update(k).digest('hex');
const tmp=()=>mkdtempSync(join(tmpdir(),'flow-keys-'));

// The same behaviour on both backends.
function suite(label,makeStore){
  describe(label,()=>{
    let store,clock,cleanup;
    beforeEach(async()=>{clock={t:Date.parse('2026-10-29T12:00:00Z')};({store,cleanup}=await makeStore(()=>clock.t));useRateLimiter(null);configureRateLimit({capacity:60,refill:2,now:()=>clock.t})});
    afterEach(()=>cleanup?.());

    test('create returns the full key once, in the flow_<mode>_ format, with a display prefix',async()=>{
      const {key,apiKey}=await store.create({owner:OWNER,name:'CI',env:'default-workspace',scopes:['read']});
      assert.match(key,/^flow_test_[A-Za-z0-9]{40}$/);
      assert.equal(apiKey.prefix,key.slice(0,18));
      assert.equal(apiKey.hash,undefined);
      assert.deepEqual(apiKey.scopes,['read']);
      const listed=await store.list(OWNER);
      assert.equal(listed.length,1);
      assert.ok(!JSON.stringify(listed).includes(key)&&!JSON.stringify(listed).includes(sha(key)),'list never carries the key or its hash');
    });

    test('authenticates a valid key; rejects unknown, malformed and missing ones',async()=>{
      const {key,apiKey}=await store.create({owner:OWNER,name:'CLI',env:'default-workspace',scopes:['write']});
      const a=await authenticateApiKey(reqWith(key),store);
      assert.deepEqual(a.user,{email:OWNER});
      assert.deepEqual(a.envs,['default-workspace']);
      assert.deepEqual(a.scopes,['read','write']);
      assert.equal(a.keyId,apiKey.id);
      const wrong=key.slice(0,-1)+(key.at(-1)==='a'?'b':'a');
      assert.equal(await authenticateApiKey(reqWith(wrong),store),null,'same prefix, wrong secret');
      assert.equal(await authenticateApiKey(reqWith('flow_test_short'),store),null);
      assert.equal(await authenticateApiKey(reqWith(),store),null);
      assert.equal(await authenticateApiKey({headers:{authorization:'Basic '+key}},store),null);
    });

    test('scopes: admin ⊃ write ⊃ read, and keys are limited to their environment',async()=>{
      assert.deepEqual(normScopes(['admin']),['read','write','admin']);
      assert.deepEqual(normScopes(['bogus']),[]);
      const r=await store.create({owner:OWNER,name:'r',env:'default-workspace',scopes:['read']});
      const w=await store.create({owner:OWNER,name:'all',env:'*',scopes:['admin']});
      const ar=await authenticateApiKey(reqWith(r.key),store),aw=await authenticateApiKey(reqWith(w.key),store);
      assert.ok(allows(ar,'read','default-workspace'));
      assert.ok(!allows(ar,'write','default-workspace'));
      assert.ok(!allows(ar,'read','other-env'));
      assert.ok(allows(aw,'admin','other-env')&&allows(aw,'write')&&allows(aw,'read','x'));
      assert.ok(!allows(null,'read'));
    });

    test('expired keys are refused',async()=>{
      const {key}=await store.create({owner:OWNER,name:'short',env:'*',scopes:['read'],expiresAt:new Date(clock.t+3600e3)});
      assert.ok(await authenticateApiKey(reqWith(key),store));
      clock.t+=3600e3+1;
      assert.equal(await authenticateApiKey(reqWith(key),store),null);
      assert.ok((await store.auditLog()).some(e=>e.op==='denied-expired'));
    });

    test('revoked keys are refused; only the owner can revoke',async()=>{
      const {key,apiKey}=await store.create({owner:OWNER,name:'gone',env:'*',scopes:['read']});
      assert.equal(await store.revoke(apiKey.id,CLEO),false,'another user cannot revoke it');
      assert.ok(await authenticateApiKey(reqWith(key),store));
      assert.equal(await store.revoke(apiKey.id,OWNER,'10.0.0.9'),true);
      assert.equal(await store.revoke(apiKey.id,OWNER),false,'already revoked');
      assert.equal(await authenticateApiKey(reqWith(key),store),null);
      const k=(await store.list(OWNER))[0];
      assert.ok(k.revokedAt,'the record is kept and marked');
      const log=await store.auditLog(apiKey.id);
      assert.ok(log.some(e=>e.op==='revoke'&&e.ip==='10.0.0.9')&&log.some(e=>e.op==='denied-revoked'));
    });

    test('last use is recorded, at most once a minute',async()=>{
      const {key,apiKey}=await store.create({owner:OWNER,name:'t',env:'*',scopes:['read']});
      await authenticateApiKey(reqWith(key,'192.0.2.1'),store);
      let k=await store.get(apiKey.id);
      assert.equal(k.lastUsedIp,'192.0.2.1');
      const first=k.lastUsedAt;
      clock.t+=10e3;await authenticateApiKey(reqWith(key,'192.0.2.2'),store);
      assert.equal((await store.get(apiKey.id)).lastUsedAt,first,'throttled');
      clock.t+=61e3;await authenticateApiKey(reqWith(key,'192.0.2.3'),store);
      k=await store.get(apiKey.id);
      assert.ok(k.lastUsedAt>first&&k.lastUsedIp==='192.0.2.3');
      assert.equal((await store.auditLog(apiKey.id)).filter(e=>e.op==='use').length,2);
    });

    test('rate limit: a token bucket per key, with a replaceable limiter',async()=>{
      configureRateLimit({capacity:3,refill:1,now:()=>clock.t});
      const {key}=await store.create({owner:OWNER,name:'busy',env:'*',scopes:['read']});
      for(let i=0;i<3;i++)assert.ok((await authenticateApiKey(reqWith(key),store)).user);
      const lim=await authenticateApiKey(reqWith(key),store);
      assert.equal(lim.limited,true);assert.equal(lim.user,undefined);assert.ok(lim.retryAfter>=1);
      clock.t+=1000;
      assert.ok((await authenticateApiKey(reqWith(key),store)).user,'refilled after a second');
      let seen=0;useRateLimiter(()=>{seen++;return {ok:false,retryAfter:7,remaining:0}});
      assert.equal((await authenticateApiKey(reqWith(key),store)).retryAfter,7);
      assert.equal(seen,1);useRateLimiter(null);
      resetRateLimits();assert.ok(rateLimit('x').ok);
    });

    test('requireApiKey answers 401, 403 and 429 itself',async()=>{
      const {key}=await store.create({owner:OWNER,name:'r',env:'default-workspace',scopes:['read']});
      const res=()=>({code:0,headers:{},body:'',writeHead(c,h){this.code=c;this.headers=h},end(b){this.body=b}});
      let r=res();assert.equal(await requireApiKey(reqWith('flow_test_'+'x'.repeat(40)),r,store),null);assert.equal(r.code,401);
      r=res();assert.equal(await requireApiKey(reqWith(key),r,store,{scope:'write'}),null);assert.equal(r.code,403);
      r=res();assert.equal(await requireApiKey(reqWith(key),r,store,{scope:'read',env:'elsewhere'}),null);assert.equal(r.code,403);
      r=res();assert.ok(await requireApiKey(reqWith(key),r,store,{scope:'read',env:'default-workspace'}));assert.equal(r.code,0);
      configureRateLimit({capacity:0,refill:0.5,now:()=>clock.t});
      r=res();assert.equal(await requireApiKey(reqWith(key),r,store),null);assert.equal(r.code,429);assert.ok(r.headers['Retry-After']);
    });
  });
}

// ---------- JSON files ----------
suite('files',async now=>{const dir=tmp();return {store:apiKeyStore({dir,now}),cleanup:()=>rmSync(dir,{recursive:true,force:true})}});
test('a database error fails closed (503), never falls back to files',async()=>{
  const dir=tmp(),store=apiKeyStore({dir,db:async()=>{throw Error('down')}});
  await assert.rejects(store.create({owner:OWNER,name:'x',env:'*',scopes:['read']}));
  const r={writeHead(c){this.code=c},end(){}};
  assert.equal(await requireApiKey(reqWith('flow_test_'+'a'.repeat(40)),r,store),null);
  assert.equal(r.code,503);
  assert.deepEqual(readdirSync(dir),[]);
  rmSync(dir,{recursive:true,force:true});
});
test('files: only a hash and the prefix are at rest; audit keeps AUDIT_DAYS',async()=>{
  let t=Date.parse('2026-01-01T00:00:00Z');
  const dir=tmp(),store=apiKeyStore({dir,mode:'live',now:()=>t});
  const {key}=await store.create({owner:OWNER,name:'live',env:'*',scopes:['read']});
  assert.match(key,/^flow_live_/);
  const raw=readdirSync(dir).map(f=>readFileSync(join(dir,f),'utf8')).join('\n');
  assert.ok(!raw.includes(key),'the full key is not stored');
  assert.ok(raw.includes(sha(key)),'its SHA-256 hash is');
  await store.audit('key_old','use','');
  t+=(AUDIT_DAYS+1)*864e5;
  await store.audit('key_new','use','');
  const log=await store.auditLog();
  assert.ok(log.some(e=>e.keyId==='key_new')&&!log.some(e=>e.keyId==='key_old'),'old audit entries are dropped');
  rmSync(dir,{recursive:true,force:true});
});

// ---------- HTTP routes ----------
describe('routes',()=>{
  let srv,base,store,dir;
  const readJson=(req,res,done)=>{if(!String(req.headers['content-type']||'').startsWith('application/json')){res.writeHead(415,{'Content-Type':'application/json'});res.end('{"error":"Expected JSON"}');return}let b='';req.on('data',c=>b+=c);req.on('end',()=>{let v;try{v=JSON.parse(b)}catch{res.writeHead(400);res.end('{}');return}done(v)})};
  const userFor=async req=>req.headers['x-user']?{email:req.headers['x-user']}:null;
  const call=async(method,path,{user=OWNER,body,headers={}}={})=>{
    const r=await fetch(base+path,{method,headers:{...(user?{'x-user':user}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined});
    const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}
    return {status:r.status,data,headers:r.headers};
  };
  before(async()=>{
    dir=tmp();store=apiKeyStore({dir});useRateLimiter(null);configureRateLimit({capacity:60,refill:2,now:()=>Date.now()});
    const handle=apiKeyRoutes({userFor,store,readJson,envsFor:async u=>u.email===OWNER?['default-workspace','work']:['cleo-env']});
    srv=http.createServer(async(req,res)=>{if(!(await handle(req,res))){res.writeHead(404);res.end()}});
    await new Promise(r=>srv.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${srv.address().port}`;
  });
  after(()=>{srv?.close();rmSync(dir,{recursive:true,force:true})});

  test('create, list and revoke over HTTP; hashes never returned',async()=>{
    let r=await call('POST','/api/keys',{body:{name:'MCP',env:'work',scopes:['write'],expiresInDays:30}});
    assert.equal(r.status,201);
    assert.match(r.data.key,/^flow_test_/);assert.match(r.data.warning,/not see it again/);
    assert.deepEqual(r.data.apiKey.scopes,['read','write']);
    assert.ok(Date.parse(r.data.apiKey.expiresAt)>Date.now()+29*864e5);
    const {key,apiKey}=r.data;
    r=await call('GET','/api/keys');
    assert.equal(r.status,200);assert.equal(r.data.keys.length,1);
    const text=JSON.stringify(r.data);
    assert.ok(!text.includes(key)&&!text.includes(sha(key))&&!/"hash"/.test(text));
    assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal((await call('GET','/api/keys',{user:CLEO})).data.keys.length,0,'users see only their own keys');
    assert.equal((await call('DELETE','/api/keys/'+apiKey.id,{user:CLEO})).status,404,'nor revoke others’');
    assert.equal((await call('DELETE','/api/keys/'+apiKey.id)).status,200);
    assert.equal(await authenticateApiKey(reqWith(key),store),null);
    assert.equal((await call('DELETE','/api/keys/'+apiKey.id)).status,404);
    assert.equal((await call('DELETE','/api/keys/nope')).status,404);
  });
  test('validation: name, environment the user may use, scopes, expiry, JSON',async()=>{
    assert.equal((await call('POST','/api/keys',{body:{name:'',env:'*',scopes:['read']}})).status,400);
    assert.equal((await call('POST','/api/keys',{body:{name:'x',env:'bad env!',scopes:['read']}})).status,400);
    assert.equal((await call('POST','/api/keys',{body:{name:'x',env:'default-workspace',scopes:['read']},user:CLEO})).status,404,'not their environment');
    assert.equal((await call('POST','/api/keys',{body:{name:'x',env:'*',scopes:['root']}})).status,400);
    assert.equal((await call('POST','/api/keys',{body:{name:'x',env:'*',scopes:[]}})).status,400);
    assert.equal((await call('POST','/api/keys',{body:{name:'x',env:'*',scopes:['read'],expiresInDays:999}})).status,400);
    assert.equal((await call('POST','/api/keys',{body:{name:'x',env:'*',scopes:['read'],expiresInDays:null}})).status,201,'never expires');
    const r=await fetch(base+'/api/keys',{method:'POST',headers:{'x-user':OWNER,'content-type':'text/plain'},body:'{}'});
    assert.equal(r.status,415);
  });
  test('same-origin and sign-in rules',async()=>{
    assert.equal((await call('GET','/api/keys',{user:null})).status,401);
    assert.equal((await call('GET','/api/keys',{headers:{origin:'https://evil.example'}})).status,403,'cross-site');
    const rebound=await new Promise((ok,no)=>http.get(base+'/api/keys',{headers:{host:'flow.evil.example','x-user':OWNER}},r=>{r.resume();ok(r.statusCode)}).on('error',no));
    assert.equal(rebound,403,'DNS rebinding');
    assert.equal((await call('PUT','/api/keys')).status,405);
    const k=(await call('POST','/api/keys',{body:{name:'k',env:'*',scopes:['admin']}})).data.key;
    assert.equal((await call('GET','/api/keys',{user:null,headers:{authorization:'Bearer '+k}})).status,401,'a key cannot manage keys');
  });
});

// ---------- embedded Postgres ----------
let EmbeddedPostgres=null;try{({default:EmbeddedPostgres}=await import('embedded-postgres'))}catch{}
describe('postgres',{skip:!EmbeddedPostgres&&'embedded-postgres is not installed'},()=>{
  let pg,pool,dir;
  const port=55400+Math.floor(Math.random()*500);
  before(async()=>{
    dir=tmp();
    pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user:'flow',password:'flow-test',port,persistent:false,onLog:()=>{},onError:()=>{}});
    await pg.initialise();await pg.start();await pg.createDatabase('flow');
    const {default:pgLib}=await import('pg');
    pool=new pgLib.Pool({connectionString:`postgres://flow:flow-test@127.0.0.1:${port}/flow`,max:2});
  });
  after(async()=>{await pool?.end().catch(()=>{});await pg?.stop().catch(()=>{});rmSync(dir,{recursive:true,force:true})});

  test('migrations run twice without error (idempotent)',async()=>{
    for(let i=0;i<2;i++)for(const q of SCHEMA)await pool.query(q);
    await migrate(pool);await migrate(pool);
    const t=(await pool.query(`select table_name from information_schema.tables where table_name like 'flygon_flow_api_key%' order by 1`)).rows.map(r=>r.table_name);
    assert.deepEqual(t,['flygon_flow_api_key_audit','flygon_flow_api_keys']);
  });
  suite('postgres store',async now=>{
    await pool.query('truncate flygon_flow_api_keys, flygon_flow_api_key_audit').catch(()=>{});
    return {store:apiKeyStore({dir:join(dir,'unused'),db:async()=>pool,now})};
  });
  test('postgres: only a hash and the prefix are at rest; nothing written to files',async()=>{
    const store=apiKeyStore({dir:join(dir,'files'),db:async()=>pool});
    const {key}=await store.create({owner:OWNER,name:'pg',env:'*',scopes:['read']});
    const rows=(await pool.query('select * from flygon_flow_api_keys')).rows;
    assert.ok(!JSON.stringify(rows).includes(key));
    assert.ok(rows.some(r=>r.key_hash===sha(key)&&r.prefix===key.slice(0,18)));
    assert.ok(await authenticateApiKey(reqWith(key),store));
    assert.throws(()=>readdirSync(join(dir,'files')),'no JSON files when Postgres is in use');
  });
});
