// Account avatars on Postgres (a throwaway embedded instance): flygon_flow_avatars, and the migration of looks
// saved before accounts had avatars from flygon_flow_office_looks and room decor (the newest wins, once).
// The file store is covered by test/avatars.test.mjs.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer as createNetServer} from 'node:net';
import {avatarStore,SCHEMA} from '../lib/avatars.mjs';
import {officeStorage} from '../lib/office-storage.mjs';
import {defaultAvatar} from '../public/avatar-spec.js';
import {defaultLook} from '../public/office-look-core.js';

const freePort=()=>new Promise((ok,no)=>{const s=createNetServer().once('error',no);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p))})});
let pg,pool,dir;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-avatars-pg-'));
  const port=await freePort(),{default:EmbeddedPostgres}=await import('embedded-postgres');
  pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user:'flow',password:'flow-avatars',port,persistent:false,onLog:()=>{},onError:()=>{}});
  await pg.initialise();await pg.start();await pg.createDatabase('flow');
  const {default:Pg}=await import('pg');
  pool=new Pg.Pool({connectionString:`postgres://flow:flow-avatars@127.0.0.1:${port}/flow`,max:3});
  for(const q of [...SCHEMA,...SCHEMA])await pool.query(q);
});
after(async()=>{await pool?.end().catch(()=>{});await pg?.stop().catch(()=>{});rmSync(dir,{recursive:true,force:true})});

test('one row per email: a spec with unknown fields, the portrait choice, and reset to the default',async()=>{
  const seedOf=e=>'m'+e.length,s=avatarStore({dir,db:async()=>pool,seedOf});
  const mine={...defaultAvatar('z'),top:{style:'hoodie',color:'#2f8f8a',pattern:'stripes',accent:'#e2b53f',hem:'long'},glow:[1,2]};
  let v=await s.save('Ann@Example.test',mine);
  assert.deepEqual([v.email,v.custom,v.avatar.top.hem,v.avatar.glow],['ann@example.test',true,'long',[1,2]]);
  await s.setUsePortrait('ann@example.test',true);
  v=await avatarStore({dir,db:async()=>pool,seedOf}).get('ann@example.test');
  assert.deepEqual([v.custom,v.usePortrait,v.avatar.top.style,v.avatar.glow],[true,true,'hoodie',[1,2]]);
  v=await s.save('ann@example.test',null);
  assert.deepEqual([v.custom,v.usePortrait,v.avatar],[false,true,defaultAvatar(seedOf('ann@example.test'))]);
  assert.equal((await pool.query('select count(*)::int n from flygon_flow_avatars')).rows[0].n,1);
});

test('looks from the office tables migrate once, the most recently saved first',async()=>{
  const office=await officeStorage({db:pool,dir,secret:'s'.repeat(40)});
  const key='mCyCyCyCyCyCy',email='cy@example.test',seedOf=()=>key;
  const older={...defaultLook(key),hair:'bun'},newer={...defaultLook(key),hair:'mohawk',hat:'captain'};
  await pool.query('insert into flygon_flow_office_looks values ($1,$2,$3)',[key,older,1000]);
  await pool.query('insert into flygon_flow_office_decor values ($1,$2,$3)',['env-b',key,{theme:null,props:[],look:newer,lookUpdated:2000}]);
  await pool.query('insert into flygon_flow_office_decor values ($1,$2,$3)',['env-c',key,{theme:null,props:[]}]);
  await pool.query('insert into flygon_flow_office_decor values ($1,$2,$3)',['env-d','mOther',{look:older,lookUpdated:'not a number'}]);
  const rows=await office.legacyLooks(key);
  assert.deepEqual(rows.map(r=>r.updated).sort(),[1000,2000]);
  assert.deepEqual(await office.legacyLooks('mOther'),[{data:older,updated:0}],'an odd timestamp counts as the oldest');
  let asked=0;const legacy=async e=>{asked++;return office.legacyLooks(seedOf(e))};
  const v=await avatarStore({dir,db:async()=>pool,seedOf,legacy}).get(email);
  assert.deepEqual([v.custom,v.avatar.hair.style,v.avatar.hat.style],[true,'mohawk','captain']);
  await avatarStore({dir,db:async()=>pool,seedOf,legacy}).get(email);
  assert.equal(asked,1,'once: the account row is there now');
});
