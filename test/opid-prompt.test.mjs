import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {findLinkPrompt} from '../public/opid-prompt-core.js';

const user={id:'example-user',name:'Example Person',email:'person@example.test'};
const person={id:'p1',type:'person',name:user.name,email:'PERSON@example.test'};
const db=(...nodes)=>({charts:[{id:'c1',name:'Team',nodes}]});

test('a single unlinked email match offers to link',()=>{
  assert.deepEqual(findLinkPrompt(db(person),user),{
    kind:'link',cards:[{id:'p1',name:user.name,chart:'Team',shared:false}],
  });
  assert.equal(findLinkPrompt(db(person),null),null);
});

test('cards linked to you or anyone else do not prompt',()=>{
  const nameMatch={...person,id:'p2',email:'other@example.test'};
  for(const link of [{opidUser:user.id},{opidUser:'someone-else'},{opidLinked:true}]){
    assert.equal(findLinkPrompt(db({...person,...link},nameMatch),user),null);
  }
});

test('matching cards across mind maps require a choice',()=>{
  const workspace=db(person);
  workspace.charts.push({id:'c2',name:'Another map',nodes:[{...person,id:'p2'}]});
  const result=findLinkPrompt(workspace,user);
  assert.equal(result.kind,'pick');
  assert.deepEqual(result.cards.map(({id,chart})=>[id,chart]),[['p1','Team'],['p2','Another map']]);
});

test('a name match suggests opening a card with a different email',()=>{
  const hint={...person,name:' example  person ',email:'other@example.test'};
  assert.equal(findLinkPrompt(db(hint),user)?.kind,'mismatch');
  assert.equal(findLinkPrompt(db({...hint,email:''}),user),null);
  assert.equal(findLinkPrompt(db(hint,{...person,id:'p2'}),user)?.kind,'link');
});

test('placed and opened shares use viewer-specific email matches',()=>{
  const shared={...person,id:'sh.share1.p1',email:undefined,linked:{opidEmail:'match',permission:'view'}};
  for(const workspace of [db(shared),{...db(shared),environment:{id:'share-share1'},opened:{shareId:'share1'}}]){
    assert.equal(findLinkPrompt(workspace,user)?.kind,'link');
    assert.equal(findLinkPrompt(workspace,user)?.cards[0].id,shared.id);
  }
  assert.equal(findLinkPrompt(db({...shared,linked:{opidEmail:'different'}}),user)?.kind,'mismatch');
  assert.equal(findLinkPrompt(db({...shared,linked:{...shared.linked,stub:true}}),user),null);
  assert.equal(findLinkPrompt(db({...shared,linked:{...shared.linked,pending:true}}),user),null);
  assert.equal(findLinkPrompt(db({...person,id:'cx.other.p1'}),user),null);
});

test('the prompt and side panel call the same link action with link:true',()=>{
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(app,/opidLink:\(\)=>setOpidLink\(n\.id,true\)/);
  assert.match(app,/action==='link'\)\{\s*await setOpidLink\(card\.id,true\)/);
  assert.match(app,/async function setOpidLink\(id,link\)\{[\s\S]*?await linkCard\(id,link\)/);
  const photos=readFileSync(new URL('../public/opid-photos.js',import.meta.url),'utf8');
  assert.match(photos,/fetch\('\/api\/opid\/link',\{method:'POST'.*body:JSON\.stringify\(\{env:currentEnv\(\),nodeId,link\}\)/);
});
