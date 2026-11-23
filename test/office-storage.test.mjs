import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {officeStorage} from '../lib/office-storage.mjs';
import {officeState,STALE_MS} from '../lib/office.mjs';

const email='member@example.test',source='fixture',env='workspace',member='member';
const payload={source,at:'2026-01-01T00:00:00.000Z',agents:[
  {id:'waiting',status:'waiting',can:['message','stop'],pending:{requestId:'request',can:['allow']}},
]};
const answer={by:email,owner:email,source,agentId:'waiting',requestId:'request',decision:'allow'};

async function verify(open,{overlap=false}={}){
  const secret='office fixture';
  let time=Date.parse('2026-01-02T00:00:00.000Z');
  const state=storage=>officeState({now:()=>time,storage});
  const first=await open(secret),original=state(first);
  await original.report(email,payload);
  const action=await original.answer(answer);
  for(let i=0;i<51;i++)await first.say(env,{id:String(i),text:'Hello'});
  await first.status(env,member,{status:'Available'});
  await first.status(env,member,{lastSeen:'2026-01-02T00:00:00.000Z'});
  original.close();

  time+=STALE_MS-1;
  const second=await open(overlap?'different seed':secret),restarted=state(second);
  assert.equal(second.secret,secret);
  await restarted.refresh();
  assert.equal(restarted.live(email)[0].id,'waiting');
  assert.equal(restarted.sources(email)[0].at,payload.at);
  const room=await second.room(env);
  assert.equal(room.chat.length,50);
  assert.equal(room.chat[0].id,'1');
  assert.deepEqual(room.status[0].data,{status:'Available',lastSeen:'2026-01-02T00:00:00.000Z'});
  assert.equal((await restarted.recent(email))[0].id,action.id);
  await assert.rejects(async()=>restarted.answer(answer),{code:'already_answered'});

  const other=overlap?state(await open(secret)):restarted;
  const claims=await Promise.all([restarted.wait(email,source,0),other.wait(email,source,0)]);
  assert.deepEqual(claims.flat().map(a=>a.id),[action.id]);
  await other.result(email,action.id,{ok:true,message:'Approved'});
  if(overlap){
    const stop={...answer,kind:'stop'};
    const stops=await Promise.allSettled([restarted.steer(stop),other.steer(stop)]);
    assert.equal(stops.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(stops.find(r=>r.status==='rejected').reason.code,'already_stopping');
    const received=await other.wait(email,source,0);
    assert.deepEqual(received.map(a=>a.kind),['stop']);
    await other.result(email,received[0].id,{ok:true});
    assert.equal((await restarted.steer(stop)).kind,'stop');
    await restarted.wait(email,source,0);
  }
  restarted.close();other.close();

  time+=2;
  const third=state(await open(secret));await third.refresh();
  assert.deepEqual(third.live(email),[]);
  assert.equal((await third.recent(email)).find(a=>a.id===action.id).result.message,'Approved');
  assert.deepEqual(await third.wait(email,source,0),[]);
  third.close();
}

test('file storage survives restart with its office state and one-time action claim',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-office-file-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await verify(secret=>officeStorage({dir,secret}));
});

test('Postgres keeps office state and arbitrates overlapping action claims',{timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-office-pg-'));
  const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve)});
  const {port}=probe.address();await new Promise(resolve=>probe.close(resolve));
  const user='office_fixture',password='test-only-password';
  const postgres=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user,password,port,persistent:false,onLog:()=>{},onError:()=>{}});
  const db=new pg.Pool({host:'127.0.0.1',port,user,password,database:'postgres',max:2});
  t.after(async()=>{await db.end();await postgres.stop().catch(()=>{});await rm(dir,{recursive:true,force:true})});
  await postgres.initialise();await postgres.start();
  await verify(secret=>officeStorage({db,secret}),{overlap:true});
});
