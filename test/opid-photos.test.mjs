// OneProfileID photos on person cards (docs/concepts/10-opid-photos.md): the claim guard every save goes
// through, what a share recipient sees of links, which linked cards a viewer sees (scope), and the
// membership filter. Pure functions and file-backed stores in temp folders only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keepOpidLinks,maskOpidLinks,photoTargets,eligibleTargets,memberStore} from '../lib/opid-photos.mjs';
import {workspaceStore} from '../lib/workspaces.mjs';
import {cleanNode,normalize} from '../lib/cleaners.mjs';
import {projectForRecipient,applyRecipientEdit,extractRecipientChanges,linkedId} from '../lib/sharing-core.mjs';

const P=(id,name,extra={})=>({id,name,type:'person',x:0,y:0,email:`${id}@example.test`,...extra});
const E=(id,name)=>({id,name,type:'entity',x:0,y:0});
const db=(nodes,edges=[])=>({active:'c1',charts:[{id:'c1',name:'C',nodes,edges}],projects:[],timeline:[]});
const node=(d,id)=>d.charts.flatMap(c=>c.nodes).find(n=>n.id===id);
const tmp=()=>mkdtempSync(join(tmpdir(),'ff-opid-'));

test('claim guard: only the saving person can add their own link; anyone can remove one',()=>{
  const before=db([P('ana','Ana',{opidUser:'u-ana'}),P('bo','Bo'),P('cy','Cy',{opidUser:'u-cy'})]);
  // Bo links his own card: kept.
  let r=keepOpidLinks(before,db([P('ana','Ana',{opidUser:'u-ana'}),P('bo','Bo',{opidUser:'u-bo'}),P('cy','Cy',{opidUser:'u-cy'})]),{as:'u-bo',email:'bo@example.test'});
  assert.equal(node(r.data,'bo').opidUser,'u-bo');assert.deepEqual(r.refused,[]);
  // Someone else's id on a new link is refused, even when the saver has an account of their own.
  r=keepOpidLinks(before,db([P('ana','Ana',{opidUser:'u-ana'}),P('bo','Bo',{opidUser:'u-bo'})]),{as:'u-ana',email:'ana@example.test'});
  assert.equal('opidUser' in node(r.data,'bo'),false);assert.deepEqual(r.refused,['bo']);
  // Changing an existing link to another account is refused: the stored link stays.
  // Nobody can move a link to themselves on a card that carries someone else's email.
  r=keepOpidLinks(before,db([P('ana','Ana',{opidUser:'u-bo'})]),{as:'u-bo',email:'bo@example.test'});
  assert.equal(node(r.data,'ana').opidUser,'u-ana');assert.deepEqual(r.refused,['ana']);
  // Nor link a card without their email, even their own id with no account email given.
  r=keepOpidLinks(before,db([P('bo','Bo',{opidUser:'u-bo',email:''})]),{as:'u-bo',email:'bo@example.test'});
  assert.equal('opidUser' in node(r.data,'bo'),false);
  r=keepOpidLinks(before,db([P('bo','Bo',{opidUser:'u-bo'})]),{as:'u-bo'});
  assert.equal('opidUser' in node(r.data,'bo'),false);
  // Changing or removing a linked card's email drops its link, from any writer.
  r=keepOpidLinks(before,db([P('ana','Ana',{opidUser:'u-ana',email:'someone@example.test'})]),{as:null});
  assert.equal('opidUser' in node(r.data,'ana'),false);assert.deepEqual(r.refused,[]);
  r=keepOpidLinks(before,db([P('ana','Ana',{opidUser:'u-ana',email:''})]),{as:'u-ana',email:'ana@example.test'});
  assert.equal('opidUser' in node(r.data,'ana'),false);
  r=keepOpidLinks(before,db([P('ana','Ana',{opidUser:'u-cy'})]),{as:'u-bo',email:'bo@example.test'});
  assert.equal(node(r.data,'ana').opidUser,'u-ana');assert.deepEqual(r.refused,['ana']);
  // Unchanged links survive any writer, including ones without an account (API keys, MCP, the owner token).
  r=keepOpidLinks(before,structuredClone(before),{as:null});
  assert.equal(node(r.data,'ana').opidUser,'u-ana');assert.equal(node(r.data,'cy').opidUser,'u-cy');assert.deepEqual(r.refused,[]);
  // Writers without an account can never add one, not even "their own".
  r=keepOpidLinks(before,db([P('bo','Bo',{opidUser:'local'})]),{as:null});
  assert.equal('opidUser' in node(r.data,'bo'),false);assert.deepEqual(r.refused,['bo']);
  // Unlinking: removing the field or emptying it.
  r=keepOpidLinks(before,db([P('ana','Ana'),P('cy','Cy',{opidUser:''})]),{as:'u-bo'});
  assert.equal('opidUser' in node(r.data,'ana'),false);assert.equal('opidUser' in node(r.data,'cy'),false);assert.deepEqual(r.refused,[]);
});

test('claim guard: copies, other card kinds, bad ids and display-only flags',()=>{
  const before=db([P('ana','Ana',{opidUser:'u-ana'})]);
  // A duplicated card is a new card: it cannot carry Ana's link unless Ana saves it.
  let r=keepOpidLinks(before,db([P('ana','Ana',{opidUser:'u-ana'}),P('copy','Ana',{opidUser:'u-ana'})]),{as:'u-bo'});
  assert.equal('opidUser' in node(r.data,'copy'),false);assert.deepEqual(r.refused,['copy']);
  r=keepOpidLinks(before,db([P('ana','Ana',{opidUser:'u-ana'}),P('copy','Ana',{opidUser:'u-ana',email:'ana@example.test'})]),{as:'u-ana',email:'ana@example.test'});
  assert.equal(node(r.data,'copy').opidUser,'u-ana','Ana may link a copy that carries her email');
  // A card that stops being a person loses its link.
  r=keepOpidLinks(before,db([{...E('ana','Ana'),opidUser:'u-ana'}]),{as:'u-ana'});
  assert.equal('opidUser' in node(r.data,'ana'),false);
  // Ids that are not account ids are never stored.
  for(const v of ['u ana','<x>','a'.repeat(129),42,{}])assert.equal('opidUser' in node(keepOpidLinks(null,db([P('x','X',{opidUser:v})]),{as:v}).data,'x'),false,String(v));
  // opidLinked only describes someone else's link to a viewer; it is never stored.
  r=keepOpidLinks(before,db([P('ana','Ana',{opidUser:'u-ana',opidLinked:true}),P('bo','Bo',{opidLinked:true})]),{as:null});
  assert.equal('opidLinked' in node(r.data,'ana'),false);assert.equal('opidLinked' in node(r.data,'bo'),false);
  // Masked data written back (opidLinked, no id) keeps the stored link; it is not an unlink.
  r=keepOpidLinks(before,db([P('ana','Ana R',{opidLinked:true})]),{as:null});
  assert.equal(node(r.data,'ana').opidUser,'u-ana');assert.equal('opidLinked' in node(r.data,'ana'),false);
  // A relay mirror (a copy of the authoritative server's data) keeps links as they are.
  r=keepOpidLinks(null,db([P('bo','Bo',{opidUser:'u-bo'})]),{mirror:true});
  assert.equal(node(r.data,'bo').opidUser,'u-bo');
});

test('every workspace write is guarded: a save, the API and MCP (no account) cannot add links',async()=>{
  const dir=tmp();
  try{
    const ws=workspaceStore({dir,db:async()=>null});
    let out=await ws.put('env-1',{baseRev:0,data:db([P('ana','Ana',{opidUser:'u-ana'}),P('bo','Bo',{opidUser:'u-bo'})]),by:'ana@example.test',owner:'ana@example.test',opidUser:'u-ana'});
    assert.deepEqual(out.opidRefused,['bo']);
    let w=await ws.get('env-1');
    assert.equal(node(w.data,'ana').opidUser,'u-ana');assert.equal('opidUser' in node(w.data,'bo'),false);
    // The API and MCP write through the same put() without an account id (lib/registry.mjs).
    const api=normalize(structuredClone(w.data));node(api,'bo').opidUser='u-bo';node(api,'ana').name='Ana R';
    out=await ws.put('env-1',{baseRev:w.rev,data:api,by:'ana@example.test',owner:'ana@example.test',source:{via:'api'}});
    assert.deepEqual(out.opidRefused,['bo']);
    w=await ws.get('env-1');
    assert.equal(node(w.data,'ana').opidUser,'u-ana','an unchanged link stays');assert.equal(node(w.data,'ana').name,'Ana R','the rest of the save goes through');
    assert.equal('opidUser' in node(w.data,'bo'),false);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('cleaners keep a valid link on person cards only',()=>{
  const p=x=>cleanNode(P('p','P',x));
  assert.equal(p({opidUser:'u_1-A'}).opidUser,'u_1-A');
  for(const v of ['','a b','x'.repeat(129),7,null])assert.equal('opidUser' in p({opidUser:v}),false,String(v));
  assert.equal(p({opidLinked:true}).opidLinked,true);assert.equal('opidLinked' in p({opidLinked:'yes'}),false);
  assert.deepEqual(cleanNode({...E('e','E'),opidUser:'u-1',opidLinked:true}),E('e','E'));
});

test('a share recipient sees their own link, and only that some other card is linked',()=>{
  const owner=db([P('bo','Bo',{opidUser:'u-bo'}),P('cy','Cy',{opidUser:'u-cy'}),E('co','Co')],
    [{id:'e1',from:'bo',to:'co',type:'ownership',percent:''},{id:'e2',from:'bo',to:'cy',type:'ownership',percent:''}]);
  const share={id:'s1',ownerEnv:'env-o',ownerEmail:'owner@example.test',recipientEmail:'bo@example.test',permission:'view',scope:{kind:'person',nodeId:'bo'}};
  const p=projectForRecipient(owner,share,[],{viewer:'u-bo'}),by=id=>p.nodes.find(n=>n.id===linkedId('s1',id));
  assert.equal(by('bo').opidUser,'u-bo');
  assert.equal(by('cy').opidUser,undefined,"another person's account id never crosses");assert.equal(by('cy').opidLinked,true);
  assert.ok(!JSON.stringify(projectForRecipient(owner,share,[])).includes('u-cy'));
  // Recipients cannot change links through a share's field edits; only POST /api/opid/link does that.
  const r=applyRecipientEdit(owner,{...share,permission:'edit'},{kind:'node',id:'bo',fields:{opidUser:'u-kim'}},{email:'bo@example.test',id:'u-kim'});
  assert.equal(r.ok,false);
  const sent=structuredClone(applyProjectionLike(p));sent.charts[0].nodes.find(n=>n.id===linkedId('s1','cy')).opidUser='u-bo';
  assert.equal(extractRecipientChanges(p,sent).edits.length,0);
  // Other readers (a public environment) see the same masking.
  const d=maskOpidLinks(structuredClone(owner),'u-cy');
  assert.equal(node(d,'cy').opidUser,'u-cy');assert.equal(node(d,'bo').opidUser,undefined);assert.equal(node(d,'bo').opidLinked,true);
});
const applyProjectionLike=p=>({charts:[{id:p.chart.id,name:p.chart.name,nodes:p.nodes.map(({chartId,...n})=>n),edges:p.edges}]});

test('photo targets: own cards, and shared cards within the share scope only',()=>{
  const home={data:db([P('bo','Bo',{opidUser:'u-bo'}),P('boss','Boss',{opidUser:'u-boss'}),P('out','Outside',{opidUser:'u-out'}),P('kid','Kid',{opidUser:'u-kid'}),E('co','Co')],
    [{id:'e1',from:'boss',to:'bo',type:'ownership',percent:''},{id:'e2',from:'bo',to:'kid',type:'ownership',percent:''},{id:'e3',from:'out',to:'co',type:'ownership',percent:''}])};
  const share={id:'s1',ownerEnv:'env-o',permission:'view',scope:{kind:'person',nodeId:'bo'}};
  const own=db([P('me','Me',{opidUser:'u-me'}),P('plain','Plain'),{...E('ent','Ent'),opidUser:'u-x'},P(linkedId('s9','zz'),'Stale',{opidUser:'u-zz'})]);
  const t=photoTargets({envId:'env-r',own,shared:[{share,home}]});
  assert.deepEqual(t.map(x=>[x.nodeId,x.env,x.opidUser]).sort(),[
    ['me','env-r','u-me'],[linkedId('s1','bo'),'env-o','u-bo'],[linkedId('s1','boss'),'env-o','u-boss'],[linkedId('s1','kid'),'env-o','u-kid']].sort(),
    'the stub above Bo comes along; Outside is not in the scope; linked copies in own data are not trusted');
  assert.deepEqual(photoTargets({envId:'env-r',own,shared:[{share:{...share,revokedAt:'2026-01-01T00:00:00Z'},home}]}).map(x=>x.nodeId),['me'],'a revoked share brings nothing');
  // Another chart scope leaves the share's cards out.
  assert.deepEqual(photoTargets({envId:'env-r',own:db([]),shared:[{share:{...share,scope:{kind:'person',nodeId:'bo',chartId:'other'}},home}]}),[]);
});

test('photo targets: a share member whose card is outside the share, as @email',()=>{
  const home={data:db([
    P('bo','Bo',{opidUser:'u-bo'}),P('own','Owner',{opidUser:'u-own',email:'own@example.test'}),
    P('out','Outside',{opidUser:'u-out',email:'out@example.test'}),P('later','Later',{opidUser:'u-later',email:'own@example.test'}),
    E('co','Co'),
  ],[{id:'e1',from:'bo',to:'co',type:'ownership',percent:''}])};
  const share={id:'s1',ownerEnv:'env-o',ownerEmail:'own@example.test',recipientEmail:'bo@example.test',permission:'view',scope:{kind:'person',nodeId:'bo'}};
  const ids=list=>photoTargets({envId:'env-r',own:db([]),shared:[{share,home,...(list?{members:list}:{})}]}).map(t=>[t.nodeId,t.env,t.opidUser]);
  assert.deepEqual(ids(['own@example.test','bo@example.test','kim@example.test']).sort(),[
    [linkedId('s1','bo'),'env-o','u-bo'],['@own@example.test','env-o','u-own'],
  ].sort(),'Bo stays his linked card; the owner is @email; Outside is not a member; the first card with the email wins');
  assert.deepEqual(ids().sort(),[[linkedId('s1','bo'),'env-o','u-bo'],['@own@example.test','env-o','u-own']].sort(),'without a member list, the owner and recipient still count');
});

test('membership filter: only recorded members of the environment the link lives in',async()=>{
  const dir=tmp();
  try{
    const m=memberStore({dir});
    await m.record('env-o',{id:'u-bo',email:'Bo@Example.TEST'});
    await m.record('env-o',{id:'u-boss',email:'boss@example.test'});
    await m.record('env-r',{id:'u-out',email:'out@example.test'});
    await m.record('env-o',{id:'bad id',email:'x@example.test'});
    await m.record('env-o',{id:'u-noemail'});
    assert.deepEqual((await m.list('env-o',['u-bo','u-boss','u-out','bad id','u-noemail'])).sort((a,b)=>a.opidUser.localeCompare(b.opidUser)),
      [{opidUser:'u-bo',email:'bo@example.test'},{opidUser:'u-boss',email:'boss@example.test'}]);
    // Recording again is cheap and does not duplicate.
    await m.record('env-o',{id:'u-bo',email:'bo@example.test'});
    assert.equal((await m.list('env-o',['u-bo'])).length,1);
    assert.equal((await memberStore({dir}).list('env-o',['u-bo'])).length,1,'kept on disk');
    const targets=[{nodeId:'a',env:'env-o',opidUser:'u-bo'},{nodeId:'b',env:'env-o',opidUser:'u-out'},{nodeId:'c',env:'env-r',opidUser:'u-out'},{nodeId:'d',env:'env-r',opidUser:'u-bo'}];
    const members=new Map([['env-o',new Set(['u-bo','u-boss'])],['env-r',new Set(['u-out'])]]);
    assert.deepEqual(eligibleTargets(targets,members).map(t=>t.nodeId),['a','c'],'a member of one environment is not eligible in another');
    assert.deepEqual(eligibleTargets(targets,new Map()),[]);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
