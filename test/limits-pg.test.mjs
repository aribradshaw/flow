// The guardrail stores on Postgres (a throwaway embedded instance): persistent rate windows
// (flygon_flow_rate_events), people who signed in (flygon_flow_users) and requests to join
// (flygon_flow_access_requests). The file fallbacks are covered by test/guardrails.test.mjs.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rateStore,SCHEMA as RATE_SCHEMA} from '../lib/limits.mjs';
import {userStore,accessRequestStore,SCHEMA as USER_SCHEMA,REQUEST_SCHEMA} from '../lib/users.mjs';

let pg,pool,dir;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-limits-pg-'));
  const {default:EmbeddedPostgres}=await import('embedded-postgres');
  pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user:'flow',password:'flow-limits',port:54357,persistent:false,onLog:()=>{},onError:()=>{}});
  await pg.initialise();await pg.start();await pg.createDatabase('flow');
  const {default:Pg}=await import('pg');
  pool=new Pg.Pool({connectionString:'postgres://flow:flow-limits@127.0.0.1:54357/flow',max:3});
  for(const q of [...RATE_SCHEMA,...USER_SCHEMA,...REQUEST_SCHEMA,...RATE_SCHEMA])await pool.query(q);
});
after(async()=>{await pool?.end().catch(()=>{});await pg?.stop().catch(()=>{});rmSync(dir,{recursive:true,force:true})});

test('rate windows: concurrent takes never pass the limit, and counts read back',async()=>{
  const r=rateStore({dir,db:async()=>pool});
  const got=await Promise.all(Array.from({length:8},()=>r.take('k1',5,60e3)));
  assert.equal(got.filter(Boolean).length,5);
  assert.equal(await r.count('k1',60e3),5);
  assert.equal(await r.take('k2',1,60e3),true,'keys are separate');
  // A second store (another server process, or the next deploy) sees the same windows.
  assert.equal(await rateStore({dir,db:async()=>pool}).take('k1',5,60e3),false);
});

test('people: first sign-in is recorded once, existing people keep full rights, names stay plain text',async()=>{
  const u=userStore({dir,db:async()=>pool});
  const a=await u.seen({id:'u-1',email:'A@Example.test',name:'Ana <b>'});
  assert.equal(a.email,'a@example.test');assert.equal(a.name,'Ana b');
  const again=await u.seen({id:'u-1',email:'a@example.test',name:''});
  assert.equal(again.firstSeen,a.firstSeen);assert.equal(again.name,'Ana b','an empty name keeps the old one');
  assert.equal((await u.seen({id:'u-2',email:'old@example.test',name:'Old'},{existing:true})).firstSeen,'1970-01-01T00:00:00.000Z');
  assert.equal(await u.count(),2);
});

test('requests to join: one per email, listed, removed when answered',async()=>{
  const q=accessRequestStore({dir,db:async()=>pool});
  await q.add({email:'Cat@example.test',name:'Cat',reason:'full'});await q.add({email:'cat@example.test',name:'Cat',reason:'closed'});
  const l=await q.list();assert.equal(l.length,1);assert.equal(l[0].reason,'full');
  await q.remove('cat@example.test');assert.equal((await q.list()).length,0);
});
