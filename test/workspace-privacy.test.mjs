import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveScope,openedProjection,applyRecipientEdit} from '../lib/sharing-core.mjs';
import {privateRecords,withoutPrivateRecords,keepPrivateFlags} from '../lib/workspace-privacy.mjs';
import {canSeeAgent,canSeeCard} from '../lib/office-seats.mjs';

test('Only me overrides whole and scoped shares and hides related records',()=>{
  const db={
    charts:[{id:'chart',name:'Chart',nodes:[{id:'public-node',name:'Public',type:'entity'},{id:'owner-node',name:'Owner card',type:'entity',onlyMe:true}],
      edges:[{id:'edge',from:'owner-node',to:'public-node',type:'group'}]}],
    projects:[{id:'public',name:'Public project'},{id:'private',name:'Owner project',onlyMe:true},{id:'under',name:'Under owner card',entity:'owner-node'}],
    timeline:[{id:'milestone',title:'Owner milestone',projects:['public','private']}],
    devops:{cards:[{id:'public-card',project:'public'},{id:'private-card',project:'under'},{id:'item-card',item:'milestone'}]},
    agentflow:{agents:[{id:'public-agent',projects:['public']},{id:'private-agent',projects:['private'],job:{runner:'Machine',id:'owner-job'}},{id:'delegated-agent',cards:['private-card']}],
      workflows:[{id:'private-workflow',steps:[{agent:'delegated-agent'}]}],runners:[{name:'machine',jobs:[{id:'owner-job'},{id:'shared-job'}]}]},
  };
  const share={id:'whole',ownerEnv:'home',ownerEmail:'owner@example.test',recipientEmail:'guest@example.test',scope:{kind:'environment'},permission:'edit'};
  const projected=openedProjection(db,share);
  assert.deepEqual(projected.nodes.map(n=>n.id),['sh.whole.public-node']);
  assert.deepEqual(projected.projects.map(p=>p.id),['sh.whole.public']);
  assert.deepEqual(projected.edges,[]);
  assert.deepEqual(projected.timeline,[]);
  assert.deepEqual(projected.cards.map(c=>c.id),['sh.whole.public-card']);
  assert.deepEqual(projected.agents.map(a=>a.id),['sh.whole.public-agent']);
  assert.deepEqual(projected.workflows,[]);
  assert.deepEqual(projected.runners[0].jobs.map(j=>j.id),['shared-job']);
  for(const scope of [{kind:'project',projectId:'private'},{kind:'nodes',nodeIds:['owner-node']}])
    assert.deepEqual(resolveScope(db,{...share,scope}).projectIds,[]);
  assert.equal(applyRecipientEdit(db,share,{kind:'project',id:'private',fields:{name:'Changed'}},{email:share.recipientEmail}).ok,false);
  const access={all:true,hidden:privateRecords(db)};
  assert.equal(canSeeAgent(access,db.agentflow.agents[1]),false);
  assert.equal(canSeeCard(access,db.devops.cards[1]),false);
  assert.equal(canSeeAgent(access,db.agentflow.agents[0]),true);
  assert.equal(withoutPrivateRecords(db).projects.length,1);
  assert.equal(db.projects.length,3);
});

test('legacy workspace saves preserve privacy unless they explicitly clear it',()=>{
  const before={projects:[{id:'private',onlyMe:true},{id:'clear',onlyMe:true}],
    charts:[{nodes:[{id:'card',onlyMe:true}]}]};
  const after={projects:[{id:'private'},{id:'clear',onlyMe:false}],charts:[{nodes:[{id:'card'}]}]};
  keepPrivateFlags(before,after);
  assert.deepEqual(after.projects,[{id:'private',onlyMe:true},{id:'clear',onlyMe:false}]);
  assert.equal(after.charts[0].nodes[0].onlyMe,true);
});
