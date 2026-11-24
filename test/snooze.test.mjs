// Card snooze (public/devops-core.js): snoozedUntil on a card hides it from the board until then. It is the
// card's (shared with everyone on the board), survives cleaning, moves and sync, and ends by itself.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seedDevops,cleanDevops,newCard,moveCard,filterCards,snoozeIso,isSnoozed,nextWake,snoozePresets,wakeText} from '../public/devops-core.js';
import {merge3,SHARED_FIELDS} from '../public/sync-core.js';
import {FIELDS} from '../lib/sharing-core.mjs';
import {getOperation} from '../lib/registry.mjs';
import {toolFor} from '../lib/mcp.mjs';
import {check} from '../lib/json-schema.mjs';

const HOUR=36e5,later=()=>new Date(Date.now()+HOUR).toISOString(),earlier=()=>new Date(Date.now()-HOUR).toISOString();

test('snoozeIso keeps real times (canonical ISO) and refuses the rest',()=>{
  assert.equal(snoozeIso('2026-11-23T16:00:00Z'),'2026-11-23T16:00:00.000Z');
  assert.equal(snoozeIso('2026-11-23T09:00:00-07:00'),'2026-11-23T16:00:00.000Z');
  for(const v of [null,undefined,'','soon','2026-13-45T99:00',42,{},'x'.repeat(41)])assert.equal(snoozeIso(v),'',String(v));
});

test('isSnoozed and nextWake follow the clock',()=>{
  const now=Date.parse('2026-11-21T12:00:00Z');
  const a={snoozedUntil:'2026-11-21T13:00:00.000Z'},b={snoozedUntil:'2026-11-21T15:00:00.000Z'},gone={snoozedUntil:'2026-11-21T11:00:00.000Z'},plain={};
  assert.equal(isSnoozed(a,now),true);assert.equal(isSnoozed(gone,now),false);assert.equal(isSnoozed(plain,now),false);
  assert.equal(isSnoozed(a,Date.parse(a.snoozedUntil)),false,'awake the moment the snooze ends');
  assert.equal(nextWake([plain,b,gone,a],now),Date.parse(a.snoozedUntil));
  assert.equal(nextWake([plain,gone],now),null);
});

test('the presets: 1 hour, 3 hours, tomorrow 9:00, the coming Monday 9:00',()=>{
  const sat=new Date(2026,10,21,20,27);   // Saturday 8:27 PM local
  const [[k1,,h1],[k3,,h3],[kt,,tom],[kw,,week]]=snoozePresets(sat);
  assert.deepEqual([k1,k3,kt,kw],['hour','3hours','tomorrow','week']);
  assert.equal(h1-sat,HOUR);assert.equal(h3-sat,3*HOUR);
  assert.deepEqual([tom.getDate(),tom.getHours(),tom.getMinutes()],[22,9,0]);
  assert.deepEqual([week.getDay(),week.getDate(),week.getHours()],[1,23,9]);
  const mon=new Date(2026,10,23,8,0),wk=snoozePresets(mon)[3][2];
  assert.deepEqual([wk.getDay(),wk.getDate()],[1,30],'on a Monday, next week is a week on');
});

test('wakeText: time today, weekday this week, date later',()=>{
  const now=new Date(2026,10,21,20,27);
  assert.match(wakeText(new Date(2026,10,21,23,27),now),/^11:27\s?PM$/i);
  assert.match(wakeText(new Date(2026,10,23,9,0),now),/^Mon 9:00\s?AM$/i);
  assert.match(wakeText(new Date(2026,11,2,9,0),now),/^Dec 2, 9:00\s?AM$/i);
  assert.match(wakeText(new Date(2027,0,4,9,0),now),/2027/);
});

test('cleaning keeps a valid snooze, normalises it and drops a broken one',()=>{
  const dv=seedDevops(),a=newCard(dv,{title:'A',snoozedUntil:'2026-11-23T09:00:00-07:00'}),b=newCard(dv,{title:'B',snoozedUntil:'whenever'}),c=newCard(dv,{title:'C',snoozedUntil:null});
  const out=cleanDevops(JSON.parse(JSON.stringify(dv)));
  const by=id=>out.cards.find(x=>x.id===id);
  assert.equal(by(a.id).snoozedUntil,'2026-11-23T16:00:00.000Z');
  assert.equal(by(b.id).snoozedUntil,undefined);assert.equal(by(c.id).snoozedUntil,undefined);
  assert.ok(!('snoozedUntil' in JSON.parse(JSON.stringify(by(c.id)))),'left out of storage when not snoozed');
  assert.deepEqual(cleanDevops(JSON.parse(JSON.stringify(out))),out,'stable');
});

test('moving a card keeps its snooze; filterCards can keep or leave out snoozed cards',()=>{
  const dv=seedDevops(),until=later(),a=newCard(dv,{title:'A',snoozedUntil:until}),b=newCard(dv,{title:'B'}),old=newCard(dv,{title:'Old',snoozedUntil:earlier()});
  moveCard(dv,a.id,'doing');
  assert.equal(dv.cards.find(c=>c.id===a.id).snoozedUntil,until);
  const db={devops:dv,projects:[],timeline:[],charts:[]},ids=f=>filterCards(db,f).map(c=>c.title).sort().join();
  assert.equal(ids({}),'A,B,Old');
  assert.equal(ids({snoozed:true}),'A');
  assert.equal(ids({snoozed:false}),'B,Old','a snooze that ended counts as awake');
});

test('sync carries snooze and unsnooze; shares may change it',()=>{
  assert.ok(SHARED_FIELDS.card.includes('snoozedUntil'));
  const base={id:'k',title:'A',snoozedUntil:'2026-11-23T16:00:00.000Z'};
  assert.deepEqual(merge3(base,{id:'k',title:'A'},{...base,title:'B'}),{id:'k',title:'B'},'unsnoozed locally, retitled remotely');
  assert.deepEqual(merge3({id:'k',title:'A'},{id:'k',title:'A'},base),base,'snoozed remotely');
  const ok=FIELDS.card.snoozedUntil;
  for(const v of [null,'','2026-11-23T16:00:00.000Z'])assert.equal(ok(v),true,String(v));
  for(const v of ['soon',5,{},'x'.repeat(41)])assert.equal(ok(v),false,String(v));
});

test('API and MCP: cards take snoozedUntil and return it (null when awake); cards.list can filter',()=>{
  for(const id of ['cards.create','cards.update']){
    const {inputSchema}=toolFor(getOperation(id));
    assert.deepEqual(inputSchema.properties.snoozedUntil.type,['string','null'],id);
    assert.deepEqual(check(getOperation(id).input,{env:'e',...(id==='cards.update'?{card:1}:{}),title:'x',snoozedUntil:null},'input'),[]);
  }
  assert.ok(toolFor(getOperation('cards.get')).outputSchema.properties.card.properties.snoozedUntil);
  assert.equal(toolFor(getOperation('cards.list')).inputSchema.properties.snoozed.type,'boolean');
});
