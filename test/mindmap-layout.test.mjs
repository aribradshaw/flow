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
    card('a1',undefined,0,300),card('a2',undefined,200,300),card('a3',undefined,400,300),card('a4',undefined,600,300),card('a5',undefined,800,300),
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
});

test('no line is drawn through a card, and lines between rows run bottom to top', ()=>{
  const c=apply(sample()),geo=edgeGeometry(c,rect),cards=c.nodes.filter(n=>n.type!=='area');
  for(const e of c.edges){
    const d=geo.get(e.id).d,nums=d.match(/-?[\d.]+/g).map(Number),[x0,y0,x1,y1,x2,y2,x3,y3]=nums;
    const a=rect(c.nodes.find(n=>n.id===e.from)),b=rect(c.nodes.find(n=>n.id===e.to));
    if(b.y>=a.y+a.h+32){assert.equal(y0,a.y+a.h);assert.equal(y3,b.y)}
    for(let i=1;i<40;i++){
      const t=i/40,u=1-t,x=u*u*u*x0+3*u*u*t*x1+3*u*t*t*x2+t*t*t*x3,y=u*u*u*y0+3*u*u*t*y1+3*u*t*t*y2+t*t*t*y3;
      for(const n of cards)if(n.id!==e.from&&n.id!==e.to){const r=rect(n);assert.ok(!(x>r.x+2&&x<r.x+r.w-2&&y>r.y+2&&y<r.y+r.h-2),`${e.from}→${e.to} crosses ${n.id}`)}
    }
  }
});

test('tidying a tidy chart changes nothing; loose cards and empty areas go in a row underneath', ()=>{
  const c=apply(sample()),again=tidyLayout(c,size);
  for(const n of c.nodes){const p=again.get(n.id);assert.equal(p.x,n.x,n.id);assert.equal(p.y,n.y,n.id)}
  const linked=c.nodes.filter(n=>!['loose','empty'].includes(n.id)).map(rect),bottom=Math.max(...linked.map(r=>r.y+r.h));
  for(const id of ['loose','empty'])assert.ok(c.nodes.find(n=>n.id===id).y>bottom);
});

test('a loop of ownership, an empty chart and a single card still lay out', ()=>{
  const loop={nodes:[card('x'),card('y',undefined,300),card('z',undefined,600)],edges:[own('x','y'),own('y','z'),own('z','x')]};
  const p=tidyLayout(loop,size);assert.equal(p.size,3);
  assert.equal(new Set([...p.values()].map(q=>q.y)).size,3);
  assert.equal(tidyLayout({nodes:[],edges:[]},size).size,0);
  assert.deepEqual([...tidyLayout({nodes:[card('solo',undefined,32,48)],edges:[]},size).values()],[{x:32,y:48}]);
});
