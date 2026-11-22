// Removing someone, on Postgres (a throwaway embedded instance): removals and the events cursor
// (flygon_flow_revocations, flygon_flow_state), membership ids on people (flygon_flow_users.local_id),
// ending one person's sessions, turning off their API keys, and re-opening a used invite. The HTTP flow
// and the file fallbacks are covered by test/member-removal.test.mjs.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {revocationStore,membershipControl,SCHEMA as REVOCATION_SCHEMA} from '../lib/revocations.mjs';
import {userStore,SCHEMA as USER_SCHEMA} from '../lib/users.mjs';
import {sessionStore,SCHEMA as SESSION_SCHEMA} from '../lib/sessions.mjs';
import {apiKeyStore} from '../lib/apikeys.mjs';
import {inviteStore,SCHEMA as INVITE_SCHEMA} from '../lib/invites.mjs';

let pg,pool,dir;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-removal-pg-'));
  const {default:EmbeddedPostgres}=await import('embedded-postgres');
  pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user:'flow',password:'flow-removal',port:54367,persistent:false,onLog:()=>{},onError:()=>{}});
  await pg.initialise();await pg.start();await pg.createDatabase('flow');
  const {default:Pg}=await import('pg');
  pool=new Pg.Pool({connectionString:'postgres://flow:flow-removal@127.0.0.1:54367/flow',max:3});
  // An older users table first: the membership id column is added to it.
  await pool.query(`create table flygon_flow_users(email text primary key,opid_id text not null default '',name text not null default '',first_seen timestamptz not null default now(),last_seen timestamptz not null default now())`);
  await pool.query(`insert into flygon_flow_users(email,opid_id,name) values('old@example.test','u-old','Old')`);
  for(const q of [...USER_SCHEMA,...REVOCATION_SCHEMA,...SESSION_SCHEMA,...INVITE_SCHEMA,...REVOCATION_SCHEMA,...USER_SCHEMA])await pool.query(q);
});
after(async()=>{await pool?.end().catch(()=>{});await pg?.stop().catch(()=>{});rmSync(dir,{recursive:true,force:true})});
const db=async()=>pool;

test('people keep their membership id; older rows have none until they sign in',async()=>{
  const u=userStore({dir,db});
  assert.equal((await u.get('old@example.test')).localId,'');
  await u.seen({id:'u-old',email:'old@example.test',name:'Old'},{localId:'s-old'});
  await u.seen({id:'u-old',email:'old@example.test',name:'Old'});
  assert.equal((await u.byLocalId('s-old')).email,'old@example.test','a sign-in without one keeps it');
  assert.equal((await u.list()).length,1);
});

test('removals: recorded, renewed, lifted, and found by person; the cursor persists',async()=>{
  const s=revocationStore({dir,db});
  await s.add({localId:'s-a',email:'A@example.test',opidId:'u-a',by:'owner@example.test'});
  assert.ok((await s.active()).ids.has('s-a'));
  assert.equal((await s.forPerson({email:'a@example.test'})).localId,'s-a');
  assert.equal((await s.forPerson({opidId:'u-a'})).localId,'s-a');
  const first=(await s.get('s-a')).revokedAt;
  await s.add({localId:'s-a',source:'opid',opidRevoked:true});
  const again=await s.get('s-a');
  assert.equal(again.revokedAt,first,'renewing a removal in force keeps its time');assert.equal(again.email,'a@example.test','and its person');assert.equal(again.opidRevoked,true);
  await s.clearPerson({email:'a@example.test'});
  assert.ok((await s.get('s-a')).clearedAt);assert.equal(await s.forPerson({email:'a@example.test'}),null);
  await s.add({localId:'s-a',revokedAt:'2030-01-01T00:00:00.000Z'});
  const back=await s.get('s-a');assert.equal(back.clearedAt,null);assert.equal(back.revokedAt,'2030-01-01T00:00:00.000Z');
  assert.equal(await s.cursor(),'');
  await s.setCursor('41');await s.setCursor('42');
  assert.equal(await revocationStore({dir,db}).cursor(),'42','another process sees the same cursor');
  await assert.rejects(s.add({localId:'bad id'}),/Invalid membership id/);
});

test('ending access: every session of one person, and every key of theirs',async()=>{
  const sessions=sessionStore({db,max:7*864e5}),now=Date.now();
  await sessions.set('sid-1',{user:{id:'u-b',email:'b@example.test'},created:now,last:now});
  await sessions.set('sid-2',{user:{id:'u-b',email:'b@example.test'},created:now,last:now});
  await sessions.set('sid-3',{user:{id:'u-c',email:'c@example.test'},created:now,last:now});
  assert.equal(await sessions.deleteUser({opidId:'u-b',email:'b@example.test'}),4,'memory and database rows');
  const fresh=sessionStore({db,max:7*864e5});
  assert.equal(await fresh.get('sid-1'),null);assert.ok(await fresh.get('sid-3'));
  const keys=apiKeyStore({dir,db});
  await keys.create({owner:'b@example.test',name:'one',env:'e1',scopes:['read']});
  await keys.create({owner:'B@example.test',name:'two',env:'e1',scopes:['read']});
  await keys.create({owner:'c@example.test',name:'other',env:'e2',scopes:['read']});
  assert.equal(await keys.revokeAll('b@example.test'),2);
  assert.equal(await keys.revokeAll('b@example.test'),0);
  assert.equal(await keys.activeCount('c@example.test'),1);
});

test('a used invite that was revoked can be claimed again once re-opened',async()=>{
  const inv=inviteStore({dir,db});
  const i=await inv.add('d@example.test','owner@example.test');await inv.claimed('d@example.test');
  await inv.add('d@example.test','owner@example.test');
  assert.ok((await inv.find('d@example.test')).claimedAt,'re-adding a live invite changes nothing');
  await inv.revoke('d@example.test');
  const back=await inv.add('d@example.test','owner@example.test');
  assert.equal(back.claimedAt,null);assert.equal(back.revokedAt,null);assert.equal(back.localId,i.localId,'the same membership id');
  assert.equal((await inv.byLocalId(i.localId)).email,'d@example.test');
});

test('the poller: revocations apply once, a later claim lifts them, an old revocation does not return',async()=>{
  const store=revocationStore({dir,db}),ended=[];
  const t=s=>new Date(Date.now()+s*1000).toISOString();
  const events=[{id:'1',localId:'s-e',kind:'revoked',createdAt:t(-30)},{id:'2',localId:'s-e',kind:'claimed',createdAt:t(-20)}];
  const opid={revoke:async()=>({ok:true,status:200}),events:async after=>({ok:true,status:200,payload:(l=>({events:l,cursor:l.at(-1)?.id||after||'0',more:false}))(events.filter(e=>Number(e.id)>Number(after||0)))})};
  const m=membershipControl({store,opid,resolve:async id=>id==='s-e'?{email:'e@example.test',opidId:'u-e'}:null,endAccess:async p=>ended.push(p.email),log:{error(){}}});
  await store.setCursor('0');
  const r=await m.poll();
  assert.equal(r.cursor,'2');assert.deepEqual(ended,['e@example.test']);
  assert.ok((await store.get('s-e')).clearedAt,'the claim came after the revocation');
  // Replaying from the start (a lost cursor) leaves the person in.
  await store.setCursor('0');await m.poll();
  assert.ok((await store.get('s-e')).clearedAt);
  // A failing OneProfileID never throws out of the poller.
  const down=membershipControl({store,opid:{revoke:async()=>{throw Error('down')},events:async()=>{throw Error('down')}},resolve:async()=>null,endAccess:async()=>{},log:{error(){}}});
  assert.equal(await down.poll(),null);
});
