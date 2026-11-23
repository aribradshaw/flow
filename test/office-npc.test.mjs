// The 3D office's characters (public/office-nav.js, public/office-brain.js): paths around furniture and through
// doors, pulled tight, with graceful ends for targets nobody can reach; and each character's seeded state
// machine, which must decide the same way for the same id and server state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildNav,navBounds,follow,separation,sidestep} from '../public/office-nav.js';
import {createBrain,pairUp,hashOf,DWELL_MIN,DWELL_MAX,TAKE,CHEER,STAND,WAVE,FADE} from '../public/office-brain.js';

const box=(x,z,w,d,yaw=0)=>({x,z,c:Math.cos(yaw),s:Math.sin(yaw),halfX:w/2,halfZ:d/2,height:1});
const pairs=pts=>{const o=[];for(let i=0;i<pts.length;i+=2)o.push([pts[i],pts[i+1]]);return o};
// Every segment of a path stays on open floor.
function walkable(nav,pts){for(let i=2;i<pts.length;i+=2)if(!nav.clear(pts[i-2],pts[i-1],pts[i],pts[i+1]))return false;return true}
const length=pts=>{let l=0;for(let i=2;i<pts.length;i+=2)l+=Math.hypot(pts[i]-pts[i-2],pts[i+1]-pts[i-1]);return l};

// A room as office.js builds it: 12 x 9, walls 0.2 thick, a 3 wide door in the middle of the front (+z) wall.
function room(cx=0,cz=0){
  const W=12,D=9,side=(W-3)/2;
  return [box(cx,cz-D/2,W,0.2),box(cx-W/2,cz,0.2,D),box(cx+W/2,cz,0.2,D),box(cx-(1.5+side/2),cz+D/2,side,0.2),box(cx+1.5+side/2,cz+D/2,side,0.2)];
}

test('nav: straight across open floor, around a box, and pulled tight',()=>{
  const nav=buildNav({bounds:{minX:-10,maxX:10,minZ:-10,maxZ:10},boxes:[box(0,0,4,1)]});
  let p=nav.path(-6,-6,6,-6);
  assert.deepEqual(p.points,[-6,-6,6,-6],'nothing in the way: one straight line');assert.ok(p.reached);
  p=nav.path(0,-3,0,3);
  assert.ok(p.reached);assert.ok(walkable(nav,p.points),'every leg is on open floor');
  assert.ok(p.points.length<=10,'smoothed to a few corners: '+JSON.stringify(pairs(p.points)));
  // Around the end of the box (2 + radius), not a staircase: close to the shortest way.
  const best=2*Math.hypot(2.32,3);
  assert.ok(length(p.points)<best+1.2,`length ${length(p.points).toFixed(2)} vs ${best.toFixed(2)}`);
  assert.deepEqual(p.points.slice(0,2),[0,-3]);assert.deepEqual(p.points.slice(-2),[0,3]);
});

test('nav: a rotated box blocks along its own axes',()=>{
  const nav=buildNav({bounds:{minX:-8,maxX:8,minZ:-8,maxZ:8},boxes:[box(0,0,8,0.4,Math.PI/4)],radius:0.3});
  // The box runs from (-2.8, 2.8) to (2.8, -2.8) (officeBox's frame): a straight line across it is closed.
  assert.equal(nav.open(0,0),false);assert.equal(nav.open(2,-2),false);assert.equal(nav.open(2,2),true);
  assert.equal(nav.clear(-2,-2,2,2),false);
  const p=nav.path(-2,-2,2,2);assert.ok(p.reached);assert.ok(walkable(nav,p.points));
});

test('nav: in and out of a room only through its door',()=>{
  const nav=buildNav({bounds:navBounds(room(),[],4),boxes:room()});
  const inside={x:-3,z:-2},outside={x:-3,z:9};
  const p=nav.path(inside.x,inside.z,outside.x,outside.z);
  assert.ok(p.reached);assert.ok(walkable(nav,p.points));
  // It crosses the front wall's line (z = 4.5) inside the door (|x| < 1.5 − radius).
  let crossed=false;
  for(let i=2;i<p.points.length;i+=2){
    const [ax,az,bx,bz]=[p.points[i-2],p.points[i-1],p.points[i],p.points[i+1]];
    if((az-4.5)*(bz-4.5)<=0&&az!==bz){const x=ax+(bx-ax)*(4.5-az)/(bz-az);assert.ok(Math.abs(x)<1.5,'through the door at x='+x.toFixed(2));crossed=true}
  }
  assert.ok(crossed);
  // Walls are never crossed elsewhere: no leg of the path goes through the left or back wall.
  assert.ok(!nav.clear(-3,-2,-8,-2),'the side wall is closed');
});

test('nav: a target inside furniture or unreachable ends at the closest open place',()=>{
  const boxes=[...room(),box(0,-3,1.7,0.8)];
  const nav=buildNav({bounds:navBounds(boxes,[],4),boxes});
  // A seat right in front of the desk (in its grown outline): reached, the last step onto the seat itself.
  let p=nav.path(4,2,0,-2.35);
  assert.ok(p.reached);assert.deepEqual(p.points.slice(-2),[0,-2.35]);
  // Inside the desk itself: as close as it gets, and the walker is never sent through it.
  p=nav.path(4,2,0,-3);assert.ok(walkable(nav,p.points.slice(0,-2)));
  // Shut away: a box closed on all sides. The path ends on open floor, as near as it can get.
  const shut=[box(10,0,4,0.2),box(10,4,4,0.2),box(8,2,0.2,4),box(12,2,0.2,4)];
  const nav2=buildNav({bounds:{minX:0,maxX:16,minZ:-6,maxZ:8},boxes:shut});
  p=nav2.path(2,2,10,2);
  assert.equal(p.reached,false);
  const [ex,ez]=p.points.slice(-2);assert.ok(nav2.open(ex,ez));assert.ok(Math.hypot(ex-10,ez-2)<3,'ends beside the closed box');
  assert.ok(walkable(nav2,p.points));
  // A start shut in (inside a wall): it stays put rather than walking through.
  const nav3=buildNav({bounds:{minX:-5,maxX:5,minZ:-5,maxZ:5},boxes:[box(0,0,6,6)]});
  p=nav3.path(0,0,4.8,4.8);assert.deepEqual(p.points,[0,0]);assert.equal(p.reached,false);
});

test('nav: floors with holes and heights (a deck): no floor and steep steps are closed',()=>{
  // Water for z > 4; a step of 1 between x < 0 and x >= 0 except on a ramp for |z| < 1.
  const ground=(x,z)=>z>4?null:x<0?0:Math.abs(z)<1?Math.min(1,x/4):1;
  const nav=buildNav({bounds:{minX:-6,maxX:6,minZ:-6,maxZ:6},ground,radius:0});
  assert.equal(nav.open(0,5),false);
  const p=nav.path(-3,-4,3,-4);
  assert.ok(p.reached);assert.ok(walkable(nav,p.points));
  // It goes by the ramp.
  assert.ok(pairs(p.points).some(([,z])=>Math.abs(z)<1.2),JSON.stringify(pairs(p.points)));
  assert.ok(nav.height(5,0)>0.9);
});

test('nav: following a path eases in and never overshoots; separation pushes neighbours apart',()=>{
  const st={x:0,z:0,vx:0,vz:0,i:0},pts=[0,0,5,0];
  let left=Infinity,steps=0,maxV=0;
  while(left>0.01&&steps<600){left=follow(st,pts,2,1/60);maxV=Math.max(maxV,Math.hypot(st.vx,st.vz));steps++}
  assert.ok(Math.abs(st.x-5)<0.02&&Math.abs(st.z)<1e-9,'arrives at the end');assert.ok(st.x<=5+1e-9,'no overshoot');
  assert.ok(maxV<=2.001&&maxV>1.8,'walks at about its speed');
  assert.ok(steps/60>2.4&&steps/60<5,'in a sensible time: '+(steps/60).toFixed(2)+' s');
  const others=new Float32Array([0.3,0,0.3, 5,5,0.3]),out={x:0,z:0};
  separation(0,0,0.3,others,2,out);
  assert.ok(out.x<0&&Math.abs(out.z)<1e-9,'pushed away from the close one only');
  // Someone dead ahead: the push turns sideways instead of straight back; from the side it stays as it was.
  const ahead=sidestep({x:-1,z:0},2,0);assert.ok(Math.abs(ahead.x)<1e-9&&Math.abs(Math.abs(ahead.z)-1)<1e-9,JSON.stringify(ahead));
  const side=sidestep({x:0,z:1},2,0);assert.deepEqual(side,{x:0,z:1});
});

test('nav: 60 walkers find their way across a ring of rooms quickly',()=>{
  const boxes=[];for(let k=0;k<8;k++){const a=k/8*Math.PI*2;boxes.push(...room(Math.cos(a)*22,Math.sin(a)*22))}
  const nav=buildNav({bounds:navBounds(boxes,[],4),boxes});
  const t0=performance.now();let reached=0;
  for(let i=0;i<60;i++){const a=i/60*Math.PI*2,b=a+Math.PI*0.7;const p=nav.path(Math.cos(a)*22,Math.sin(a)*22,Math.cos(b)*8,Math.sin(b)*8);if(p.reached)reached++}
  const ms=performance.now()-t0;
  assert.ok(reached>=56,'most room centres reach the common area: '+reached);
  assert.ok(ms<600,`60 paths in ${ms.toFixed(1)} ms`);
});

// ---------- the brain ----------
const run=(b,from,to,inp,dt=0.25)=>{let it;for(let t=from;t<=to+1e-9;t+=dt)it=b.update(t,typeof inp==='function'?inp(t):inp);return it};
const base={status:'running',kind:'edit',card:null,ownerHere:false,gone:false,arrived:true,partner:'',wander:true};

test('brain: a new session walks in and sits down; a working one stays at its desk',()=>{
  const b=createBrain('ann\nt3:1',{now:0,entering:true});
  let it=b.update(0,{...base,arrived:false});
  assert.equal(it.state,'enter');assert.equal(it.goal,'home');assert.equal(it.pose,'stand');
  it=b.update(3,{...base,arrived:true});
  assert.equal(it.state,'work');assert.equal(it.pose,'sit');
  it=run(b,3,60,base);assert.equal(it.state,'work');
});

test('brain: waiting goes to the owner when here, hops at the desk otherwise, and comes back after',()=>{
  const b=createBrain('ann\nt3:2',{now:0});b.update(0,base);
  let it=b.update(1,{...base,status:'waiting',ownerHere:true,arrived:false});
  assert.equal(it.state,'summon');assert.equal(it.goal,'owner');assert.equal(it.pace,'jog');
  it=b.update(4,{...base,status:'waiting',ownerHere:true,arrived:true});assert.equal(it.pose,'hop');
  // The owner leaves (or turns on Do not disturb): hops at its desk instead.
  it=b.update(5,{...base,status:'waiting',ownerHere:false});assert.equal(it.state,'waitDesk');assert.equal(it.goal,'home');assert.equal(it.pose,'hop');
  it=b.update(6,{...base,status:'waiting',ownerHere:true,arrived:false});assert.equal(it.state,'summon');
  // Answered: back to the desk to work.
  it=b.update(9,{...base,status:'running',arrived:false});assert.equal(it.state,'work');assert.equal(it.goal,'home');
});

test('brain: idle is calm (10–40 s at each place) and seeded: the same id and state plan the same day',()=>{
  // One entry per new place (intent.rev changes with the goal or the spot in it).
  const trace=id=>{const b=createBrain(id,{now:0}),out=[];let rev=-1;
    for(let t=0;t<600;t+=0.5){const it=b.update(t,{...base,status:'idle',kind:'idle'});if(it.rev!==rev){out.push([t,it.goal]);rev=it.rev}}return out};
  const a=trace('bo\nagent-7'),again=trace('bo\nagent-7'),other=trace('cy\nagent-9');
  assert.deepEqual(a,again,'deterministic');
  assert.notDeepEqual(a.map(x=>x[1]),other.map(x=>x[1]),'another agent has another plan');
  assert.equal(a[0][1],'home','starts by staying at its desk');
  const gaps=a.slice(1).map((x,i)=>x[0]-a[i][0]);
  for(const g of gaps)assert.ok(g>=DWELL_MIN&&g<=DWELL_MAX+0.5,'dwell '+g);
  assert.ok(new Set(a.map(x=>x[1])).size>=3,'it goes to several places: '+a.map(x=>x[1]).join(','));
  // A server change (another kind of work, a card) replans; the same change replans the same way.
  const withCard=id=>{const b=createBrain(id,{now:0});const out=[];for(let t=0;t<300;t+=0.5)out.push(b.update(t,{...base,status:'idle',kind:'idle',card:t>50?{number:3,column:'doing'}:null}).goal);return out.join()};
  assert.equal(withCard('bo\nagent-7'),withCard('bo\nagent-7'));
});

test('brain: idle ones chat with a partner and go on afterwards; one kept at its desk never leaves it',()=>{
  const b=createBrain('x',{now:0});
  run(b,0,5,{...base,status:'idle'});
  let it=b.update(5.5,{...base,status:'idle',partner:'y',arrived:false});
  assert.equal(it.state,'chat');assert.equal(it.goal,'partner');
  it=b.update(8,{...base,status:'idle',partner:'y',arrived:true});assert.equal(it.say,'…');assert.equal(it.pose,'talk');
  it=b.update(20,{...base,status:'idle',partner:''});assert.equal(it.state,'idle');assert.equal(it.say,'');
  const desk=createBrain('z',{now:0});
  const goals=new Set();for(let t=0;t<900;t+=0.5)goals.add(desk.update(t,{...base,status:'idle',wander:false,board:false,partner:'q'}).goal);
  assert.ok(!goals.has('lounge')&&!goals.has('partner'),[...goals].join());
  const still=createBrain('r',{now:0});const s=new Set();for(let t=0;t<600;t+=1)s.add(still.update(t,{...base,status:'idle',still:true}).goal);
  assert.deepEqual([...s],['home'],'a paused one stays put');
});

test('brain: a new card is fetched from the board and carried; UAT or Done is put up and celebrated',()=>{
  const b=createBrain('ann\ns1',{now:0});
  b.update(0,{...base,card:{number:4,column:'doing'}});
  assert.equal(b.state,'work','the card it already had is no news');
  let it=b.update(1,{...base,card:{number:5,column:'doing'},arrived:false});
  assert.equal(it.state,'fetch');assert.equal(it.goal,'board');assert.equal(it.carry,false);
  it=b.update(4,{...base,card:{number:5,column:'doing'},arrived:true});assert.equal(it.state,'take');assert.equal(it.pose,'look');
  it=b.update(4+TAKE*0.6,{...base,card:{number:5,column:'doing'},arrived:true});assert.equal(it.carry,true,'it has taken it');
  it=b.update(4+TAKE+0.1,{...base,card:{number:5,column:'doing'},arrived:false});assert.equal(it.state,'carry');assert.equal(it.goal,'home');assert.ok(it.carry);
  it=b.update(9,{...base,card:{number:5,column:'doing'},arrived:true});assert.equal(it.state,'work');assert.equal(it.carry,false);
  it=b.update(10,{...base,card:{number:5,column:'uat'},arrived:false});
  assert.equal(it.state,'deliver');assert.equal(it.goal,'board');assert.ok(it.carry,'carries it to the board');
  it=b.update(13,{...base,card:{number:5,column:'uat'},arrived:true});assert.equal(it.state,'putup');
  it=b.update(13+TAKE+0.01,{...base,card:{number:5,column:'uat'},arrived:true});assert.equal(it.state,'cheer');assert.equal(it.pose,'cheer');assert.equal(it.carry,false);
  it=b.update(13+TAKE+CHEER+0.1,{...base,card:{number:5,column:'uat'},arrived:false});assert.equal(it.state,'work');
});

test('brain: a gone one stands, waves, walks out and fades; coming back mid-way walks it in again',()=>{
  const b=createBrain('s',{now:0});b.update(0,base);
  let it=b.update(1,{...base,gone:true,arrived:true});assert.equal(it.state,'leave');assert.equal(it.goal,'here');
  it=b.update(1+STAND+0.1,{...base,gone:true,arrived:true});assert.equal(it.pose,'wave');
  it=b.update(1+STAND+WAVE+0.01,{...base,gone:true,arrived:false});assert.equal(it.state,'exit');assert.equal(it.goal,'door');
  it=b.update(6,{...base,gone:true,arrived:true});assert.equal(it.state,'fade');
  it=b.update(6+FADE/2,{...base,gone:true,arrived:true});assert.ok(it.fade>0.4&&it.fade<0.6);
  it=b.update(6+FADE+0.01,{...base,gone:true,arrived:true});assert.equal(it.state,'gone');assert.equal(it.fade,1);
  const c=createBrain('t',{now:0});c.update(0,base);c.update(1,{...base,gone:true});
  it=c.update(2,{...base,gone:false,arrived:false});assert.equal(it.state,'enter');assert.equal(it.goal,'home');
});

test('brain: chat pairs are the same for everyone in a time slot, and only within an area',()=>{
  const cands=[];for(let i=0;i<40;i++)cands.push({id:'n'+i,area:i%2?'room-a':'common'});
  const p=pairUp(cands,1234),again=pairUp(cands,1234),next=pairUp(cands,1235);
  assert.deepEqual([...p],[...again]);assert.notDeepEqual([...p],[...next]);
  assert.ok(p.size>=4,'some pairs: '+p.size);
  for(const [a,b] of p){assert.equal(p.get(b),a);assert.equal(cands.find(c=>c.id===a).area,cands.find(c=>c.id===b).area)}
  assert.equal(hashOf('a'),hashOf('a'));
});

test('nav: walkers outside the grid come back in from its nearest edge',()=>{
  const nav=buildNav({bounds:{minX:-5,maxX:5,minZ:-5,maxZ:5},boxes:[box(0,0,2,6)]});
  const p=nav.path(-3,9,3,0);
  assert.ok(p.reached);assert.ok(p.points.length>=4);assert.deepEqual(p.points.slice(-2),[3,0]);
});
