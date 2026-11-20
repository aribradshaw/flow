// Mind map Tidy up (public/mindmap-layout.js): rows by ownership, areas kept together, no card on
// top of another and no line drawn through a card.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tidyLayout,edgeGeometry,placeRow} from '../public/mindmap-layout.js';

const K={entity:[176,48],person:[160,48],area:[192,48],note:[160,64]};
const size=n=>[n.w||K[n.type][0],n.h||K[n.type][1]];
const rect=n=>{const [w,h]=size(n);return {x:n.x,y:n.y,w,h}};
const card=(id,type='entity',x=0,y=0,extra={})=>({id,name:id,type,x,y,notes:'',...extra});
let k=0;const own=(from,to,percent='100')=>({id:'e'+k++,from,to,type:'ownership',percent});
const group=(from,to)=>({id:'e'+k++,from,to,type:'group',percent:''});

// A founder with two companies; a second company co-owned with a partner; a child co-owned across
// the two (one row apart, so its line skips a row); two project areas; grouping lines both ways.
function sample(){
  const nodes=[
    card('root','person',600,0),card('a',undefined,200,150),card('b',undefined,1000,150),card('partner','person',700,120),
    card('a1',undefined,0,300),card('a2',undefined,200,300),card('a3',undefined,640,360),card('a4',undefined,600,300),card('a5',undefined,800,300),
    card('ab',undefined,700,300),card('cross',undefined,500,450),card('cross2',undefined,500,550),
    card('b1',undefined,900,300),card('b2',undefined,1100,300),card('b2x',undefined,1100,400),
    card('m1',undefined,40,440),card('m2',undefined,240,440),card('note','note',1300,300),card('loose',undefined,1500,0),
    card('areaA','area',-20,280,{w:640,h:240}),card('areaB','area',880,280,{w:400,h:200}),card('empty','area',1600,600),
  ];
  const edges=[own('root','a'),own('root','b'),own('a','a1'),own('a','a2'),own('a','a3'),own('a','a4'),own('a','a5'),
    own('a','ab','50'),own('partner','ab','50'),own('ab','cross','50'),own('a','cross','50'),group('cross','cross2'),
    own('b','b1'),own('b','b2'),group('b2x','b2'),group('m1','a1'),group('m2','a2'),own('b','note'),group('note','ab'),group('root','partner')];
  return {id:'c',name:'Sample',nodes,edges};
}
function apply(c){const pos=tidyLayout(c,size);for(const n of c.nodes){const p=pos.get(n.id);if(p)Object.assign(n,p)}return c}
const inside=(r,a)=>r.x>=a.x&&r.y>=a.y&&r.x+r.w<=a.x+a.w&&r.y+r.h<=a.y+a.h;
const overlap=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;

test('placeRow keeps order and spacing and lands as near as it can to where items want to be', ()=>{
  assert.deepEqual(placeRow([{w:10,want:0,weight:1},{w:10,want:100,weight:1}],5),[0,100]);
  // Both want 0: they split the difference around it.
  const xs=placeRow([{w:10,want:0,weight:1},{w:10,want:0,weight:1}],10);
  assert.equal(xs[1]-xs[0],20);assert.equal(xs[0]+xs[1],0);
  // A heavy item barely moves.
  const h=placeRow([{w:10,want:0,weight:100},{w:10,want:0,weight:1}],10);
  assert.ok(Math.abs(h[0])<1);
});

test('owners sit above what they own, cards never overlap and areas keep (only) their cards', ()=>{
  const before=sample(),members=new Map();
  for(const a of before.nodes.filter(n=>n.type==='area'))members.set(a.id,before.nodes.filter(n=>n.type!=='area'&&inside(rect(n),rect(a))).map(n=>n.id));
  const c=apply(sample()),byId=new Map(c.nodes.map(n=>[n.id,n]));
  for(const e of c.edges.filter(e=>e.type==='ownership'))assert.ok(byId.get(e.from).y<byId.get(e.to).y,`${e.from} above ${e.to}`);
  // A loose card that only groups under another hangs below it.
  assert.ok(byId.get('m1').y>byId.get('a1').y);assert.ok(byId.get('b2x').y>byId.get('b2').y);
  // A co-owner sits in the row just above what it co-owns, not up beside the root.
  assert.ok(byId.get('partner').y>byId.get('root').y);
  const cards=c.nodes.filter(n=>n.type!=='area');
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++)assert.ok(!overlap(rect(cards[i]),rect(cards[j])),`${cards[i].id} / ${cards[j].id}`);
  for(const [a,ids] of members){
    const r=rect(byId.get(a));
    for(const n of cards)assert.equal(inside(rect(n),r),ids.includes(n.id),`${n.id} in ${a}`);
    if(ids.length)for(const n of cards.filter(n=>!ids.includes(n.id)))assert.ok(!overlap(rect(n),r),`${n.id} clear of ${a}`);
  }
  for(const n of c.nodes)assert.ok(n.x%16===0&&n.y%16===0,n.id);
  // Three simple children of one owner (a3–a5: no other lines) stack in a column under it.
  const st=['a3','a4','a5'].map(id=>byId.get(id));
  assert.equal(new Set(st.map(n=>n.x)).size,1);assert.equal(new Set(st.map(n=>n.y)).size,3);
  assert.ok(byId.get('a').x<st[0].x&&byId.get('a').x+size(byId.get('a'))[0]>st[0].x,'the owner sits over the stack');
});

// Smart lines: orthogonal, square to the cards at both ends, never through a card.
const segsOf=pts=>pts.slice(1).map((q,i)=>[pts[i],q]);
const through=(p,q,r)=>Math.max(p.x,q.x)>r.x+1&&Math.min(p.x,q.x)<r.x+r.w-1&&Math.max(p.y,q.y)>r.y+1&&Math.min(p.y,q.y)<r.y+r.h-1;
const onSide=(p,r)=>(Math.abs(p.y-r.y)<.01||Math.abs(p.y-r.y-r.h)<.01)&&p.x>=r.x-.01&&p.x<=r.x+r.w+.01||(Math.abs(p.x-r.x)<.01||Math.abs(p.x-r.x-r.w)<.01)&&p.y>=r.y-.01&&p.y<=r.y+r.h+.01;
function checkLines(c,tidy=true){
  const geo=edgeGeometry(c,rect),cards=c.nodes.filter(n=>n.type!=='area'),byId=new Map(c.nodes.map(n=>[n.id,n]));
  for(const e of c.edges){
    const g=geo.get(e.id),pts=g.pts,a=rect(byId.get(e.from)),b=rect(byId.get(e.to)),name=`${e.from}→${e.to}`;
    assert.match(g.d,/^M[\d.\- ]+(L[\d.\- ]+(Q[\d.\- ]+)?)+$/,name);
    for(const [p,q] of segsOf(pts))assert.ok(Math.abs(p.x-q.x)<.01||Math.abs(p.y-q.y)<.01,`${name} is orthogonal`);
    // A grouping line to several cards of an area ends on the area's border instead.
    const box=r=>c.nodes.find(n=>n.type==='area'&&inside(r,rect(n))&&onSide(pts.at(-1),rect(n)));
    assert.ok(onSide(pts[0],a)&&(onSide(pts.at(-1),b)||e.type==='group'&&box(b)),`${name} starts and ends on its cards`);
    const end=onSide(pts.at(-1),b)?b:rect(box(b));
    // Square to the side it leaves and enters: the first and last segments point out of the card.
    for(const [p,q,r] of [[pts[0],pts[1],a],[pts.at(-1),pts.at(-2),end]]){
      const out=Math.abs(p.y-r.y)<.01?q.y<p.y:Math.abs(p.y-r.y-r.h)<.01?q.y>p.y:Math.abs(p.x-r.x)<.01?q.x<p.x:q.x>p.x;
      assert.ok(out&&(Math.abs(p.x-q.x)<.01||Math.abs(p.y-q.y)<.01),`${name} meets its card square`);
    }
    if(tidy&&b.y>=a.y+a.h+32)assert.equal(pts[0].y,a.y+a.h,`${name} leaves the bottom`);
    for(const n of cards)if(n.id!==e.from&&n.id!==e.to)for(const [p,q] of segsOf(pts))assert.ok(!through(p,q,rect(n)),`${name} crosses ${n.id}`);
  }
  return geo;
}
test('smart lines: orthogonal, square to their cards, never through a card, before and after tidying', ()=>{
  // Untidied, a card jammed right under another may send a line out of another side.
  checkLines(sample(),false);checkLines(apply(sample()));
});

test('a fan of owned cards shares one trunk; labels sit just above the arrow, clear of cards and each other', ()=>{
  const c={nodes:[card('p',undefined,400,0),...[0,1,2,3].map(i=>card('k'+i,undefined,i*224,160)),card('q',undefined,720,0),card('j',undefined,680,320)],
    edges:[...[0,1,2,3].map(i=>own('p','k'+i,'25')),own('q','j','50'),own('k3','j','50')]};
  const geo=checkLines(c),fan=[0,1,2,3].map(i=>geo.get(c.edges[i].id));
  assert.equal(new Set(fan.map(g=>`${g.pts[0].x},${g.pts[0].y}`)).size,1,'one port');
  assert.equal(new Set(fan.map(g=>g.pts.length>2?g.pts[1].y:0).filter(Boolean)).size,1,'one bus');
  for(const g of fan)assert.ok(g.pts.length<=4,'at most two corners');
  const boxes=[...geo.values()].map(g=>({x:g.mx-17,y:g.my-8,w:34,h:16}));
  for(let i=0;i<boxes.length;i++){
    for(let j=i+1;j<boxes.length;j++)assert.ok(!overlap(boxes[i],boxes[j]),'labels apart');
    for(const n of c.nodes)assert.ok(!overlap(boxes[i],rect(n)),'label clear of '+n.id);
  }
  // Two owners' buses through the same gap don't run on top of each other.
  const two={nodes:[card('x',undefined,0,0),card('y',undefined,600,0),card('x1',undefined,480,200),card('y1',undefined,120,200)],edges:[own('x','x1'),own('y','y1')]};
  const g2=checkLines(two),[h1,h2]=two.edges.map(e=>g2.get(e.id).pts[1].y);
  assert.ok(Math.abs(h1-h2)>=8,'buses offset');
});

test('routing stays fast on a chart of ~80 cards and lines', ()=>{
  const nodes=[],edges=[];
  for(let i=0;i<80;i++)nodes.push(card('n'+i,undefined,(i%16)*208,Math.floor(i/16)*160));
  for(let i=16;i<80;i++){edges.push(own('n'+Math.max(0,i-16-(i%3?1:0)),'n'+i));if(i%5===0)edges.push(group('n'+(i-15),'n'+i))}
  const c={nodes,edges};checkLines(c);
  const t=performance.now();for(let i=0;i<20;i++)edgeGeometry(c,rect);
  assert.ok((performance.now()-t)/20<40,'routes in well under a frame budget');
  // Cards scattered by hand, nothing cached: still well under a second, and a drag frame keeps to
  // its budget (give or take one search).
  let s=7;const r=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648};
  const ov=(a,b)=>a.x-30<b.x+176&&b.x-30<a.x+176&&a.y-30<b.y+48&&b.y-30<a.y+48,sc=[];
  while(sc.length<75){const n=card('s'+sc.length,undefined,Math.round(r()*3000)+5,Math.round(r()*1400)+3);if(!sc.some(o=>ov(o,n)))sc.push(n)}
  const se=[];for(let i=15;i<75;i++)se.push(own('s'+(i-15),'s'+i,'50'));for(let i=0;i<20;i++)se.push(group('s'+(i*3%75),'s'+((i*7+31)%75)));
  const t1=performance.now();edgeGeometry({nodes:sc,edges:se},rect);
  assert.ok(performance.now()-t1<600,'scattered chart routes in well under a second');
  const moved=sc.map(n=>n.id==='s37'?{...n,x:n.x+40,y:n.y+20}:n),t2=performance.now();
  edgeGeometry({nodes:moved,edges:se},rect,{budget:2});
  assert.ok(performance.now()-t2<60,'a drag frame stays near its budget');
});

// Tidy up with a grouping box: a venture co-owned by two studios groups five games, three of them
// owned by one of the studios.
function games(){
  const nodes=[card('hold','person',600,0),card('studio',undefined,200,150),card('labs',undefined,1000,150),card('venture',undefined,700,320),
    ...['g1','g2','g3','g4','g5'].map((id,i)=>card(id,undefined,1200+i*200,600)),card('box','area',1180,560,{w:1040,h:200})];
  const edges=[own('hold','studio'),own('hold','labs'),own('studio','venture','50'),own('labs','venture','50'),
    own('labs','g1'),own('labs','g2'),own('labs','g3'),group('venture','g1'),group('venture','g2'),group('venture','g3'),own('venture','g4'),own('venture','g5')];
  return {nodes,edges};
}
test('a grouping box sits right under the card it groups to, hugs its cards, and a co-owned card sits between its owners', ()=>{
  const once=apply(games()),twice=tidyLayout(once,size);
  for(const n of once.nodes){const p=twice.get(n.id);assert.equal(p.x,n.x,n.id);assert.equal(p.y,n.y,n.id)}
  const c=apply(games()),by=new Map(c.nodes.map(n=>[n.id,rect(n)])),box=by.get('box'),v=by.get('venture');
  const mem=['g1','g2','g3','g4','g5'].map(id=>by.get(id));
  for(const m of mem)assert.ok(inside(m,box),'member inside');
  assert.ok(!overlap(v,box),'the venture is not inside its games box');
  assert.equal(new Set(mem.map(m=>m.y)).size,1,'members in one row');
  assert.ok(box.y>=v.y+v.h&&box.y-(v.y+v.h)<=96,'box right under the venture');
  const mid=r=>r.x+r.w/2;
  assert.ok(mid(v)>=box.x&&mid(v)<=box.x+box.w,'box under the venture');
  const lo=Math.min(...mem.map(m=>m.x)),hi=Math.max(...mem.map(m=>m.x+m.w)),bot=Math.max(...mem.map(m=>m.y+m.h));
  assert.ok(box.w<=hi-lo+2*16+16&&box.h<=bot-box.y+24+16,'box hugs its cards');
  const [s,l]=[by.get('studio'),by.get('labs')];
  assert.ok(mid(v)>=Math.min(mid(s),mid(l))-1&&mid(v)<=Math.max(mid(s),mid(l))+1,'venture between its owners');
  checkLines(c);
});

test('tidying a tidy chart changes nothing; loose cards and empty areas go in a row underneath', ()=>{
  const c=apply(sample()),again=tidyLayout(c,size);
  for(const n of c.nodes){const p=again.get(n.id);assert.equal(p.x,n.x,n.id);assert.equal(p.y,n.y,n.id)}
  const linked=c.nodes.filter(n=>!['loose','empty'].includes(n.id)).map(rect),bottom=Math.max(...linked.map(r=>r.y+r.h));
  for(const id of ['loose','empty'])assert.ok(c.nodes.find(n=>n.id===id).y>bottom);
});

test('Tidy up settles in one press on random charts with an area', ()=>{
  for(let seed=1;seed<=12;seed++){
    let s=seed;const r=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648},ri=n=>Math.floor(r()*n);
    const nodes=Array.from({length:22},(_,i)=>card('n'+i,undefined,ri(1600),ri(900)));
    const edges=[];for(let i=1;i<22;i++)edges.push(own('n'+ri(i),'n'+i));for(let i=0;i<5;i++){const a=ri(22),b=ri(22);if(a!==b)edges.push(group('n'+a,'n'+b))}
    const m=nodes.slice(14,19);for(const [i,n] of m.entries()){n.x=900+i*200;n.y=1000}
    nodes.push(card('box','area',880,960,{w:1040,h:120}));
    const c=apply({nodes,edges}),again=tidyLayout(c,size);
    for(const n of c.nodes){const p=again.get(n.id);assert.ok(p.x===n.x&&p.y===n.y,`seed ${seed}: ${n.id} moved`)}
  }
});

test('a loop of ownership, an empty chart and a single card still lay out', ()=>{
  const loop={nodes:[card('x'),card('y',undefined,300),card('z',undefined,600)],edges:[own('x','y'),own('y','z'),own('z','x')]};
  const p=tidyLayout(loop,size);assert.equal(p.size,3);
  assert.equal(new Set([...p.values()].map(q=>q.y)).size,3);
  assert.equal(tidyLayout({nodes:[],edges:[]},size).size,0);
  assert.deepEqual([...tidyLayout({nodes:[card('solo',undefined,32,48)],edges:[]},size).values()],[{x:32,y:48}]);
});
