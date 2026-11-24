import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replayTracks} from '../public/office-replay.js';

test('rebuilds actors across seeks, joins, leaves and checkpoint gaps',()=>{
  const person=(type,at,x,heading=0)=>({type,at,member:'person',x,y:0,z:0,heading});
  const agent=(at,status)=>({type:'agent',at,member:'person',agent:'a',status,vendor:'codex',activityKind:'edit',private:true});
  const tracks=replayTracks([
    person('join',1000,0,3),agent(1000,'running'),person('pose',3000,4,-3),agent(3000,'waiting'),
    {type:'answer',at:3100,member:'person',agent:'a',decision:'allow'},
    {...agent(3500,'waiting'),checkpoint:true},{type:'leave',member:'person',at:5000},
    person('join',6000,20),{type:'agent-leave',member:'person',agent:'a',at:8000},
  ],150000);
  const first=tracks.sample(2000),motion=first.poses.get('person');
  assert.equal(motion.x,2);assert.ok(Math.abs(motion.heading-Math.PI)<.0001);assert.equal(motion.speed,2);
  assert.equal(first.roster.get('person')[0].status,'running');
  assert.equal(tracks.sample(3100).roster.get('person')[0].status,'waiting');
  assert.equal(tracks.sample(3600).roster.get('person')[0],tracks.sample(3200).roster.get('person')[0]);
  assert.equal(tracks.sample(4900).poses.get('person').x,4);
  assert.ok(!tracks.sample(5100).poses.size);
  assert.equal(tracks.sample(6100).poses.get('person').x,20);
  assert.ok(!tracks.sample(8100).roster.size);
  assert.ok(!tracks.sample(157000).poses.size);
  assert.equal(tracks.sample(2000).poses.get('person').x,2,'seeking backward does not mutate tracks');
  assert.deepEqual(tracks.between(3000,3200).map(e=>e.decision),['allow']);
});
