// Tidy up for the mind map: a layered layout (owners above what they own) that keeps lines short
// and few crossings, keeps every project area's cards together and resizes the area around them.
// Pure: takes the chart and a card size function, returns Map id -> {x,y[,w,h]} (w/h for areas).
//
// 1. Rows. Ownership points down. A grouping line (no direction of its own) only places a card
//    when one end is a loose card that owns nothing (it hangs under the other end) or both ends
//    are top-level (drawn direction). Cards that only own things sit just above their highest
//    child, so a co-owner stays next to what it co-owns instead of up beside the chart's root.
//    A project area hangs under its anchor (the outside card most of its members link to), all its
//    members starting in the row below that card, so the area is one compact block under it.
// 2. Order. Lines spanning several rows get a placeholder in each row between, then rows are
//    reordered by the average position of their neighbours (sweeping down and up) and the order
//    with the fewest crossings wins. A project area is one block per row it spans.
// 3. Position. Each row is placed as close as possible to its neighbours (least squares, keeping
//    order and spacing); an area keeps one x across all its rows. A line that skips rows keeps a
//    narrow lane open in each row it crosses, on the straight line between its ends; edgeGeometry
//    threads the line through it.
// 4. Finish. A card with several owners slides toward the middle of them, an area centres under
//    the cards its anchor owns in it, rows open up to give every owner's lines their own lane, and
//    an area's rows are only as tall as its own cards.
// edgeGeometry (below) draws the lines for the canvas, tidied or not.
// An area's top padding leaves room for its title above the % labels of the lines into it.
const HGAP=24,VGAP=96,DUMMY=48,PAD={x:16,top:64,bottom:24},GRID=16;
// Stacks: a card's simple children (only that owner, nothing under them, no other lines) sit in two
// columns under it once there are STACK_MIN of them, with its lines running down the spine between.
// The spine sits far enough from the cards for a % label between it and each card.
const STACK_MIN=3,STACK_COL=3,SPINE=112,SPINE1=72,SGAP=16;
const ITER=24;

// Least-squares placement of a row keeping order and minimum gaps (pool adjacent violators).
// items: [{w, want (desired left), weight}] in order. Returns lefts.
export function placeRow(items,gap=HGAP){
  const off=[];let o=0;
  for(const it of items){off.push(o);o+=it.w+gap}
  const blocks=[];
  items.forEach((it,i)=>{
    let b={sum:(it.want-off[i])*it.weight,wt:it.weight,n:1};
    while(blocks.length&&blocks.at(-1).sum/blocks.at(-1).wt>=b.sum/b.wt){const p=blocks.pop();b={sum:p.sum+b.sum,wt:p.wt+b.wt,n:p.n+b.n}}
    blocks.push(b);
  });
  const out=[];let i=0;
  for(const b of blocks){const y=b.sum/b.wt;for(let k=0;k<b.n;k++,i++)out.push(y+off[i])}
  return out;
}

// Number of crossings between two consecutive rows (pos: item -> index).
function crossings(edges,pos){
  const es=edges.map(([a,b])=>[pos.get(a),pos.get(b)]).sort((p,q)=>p[0]-q[0]||p[1]-q[1]);
  let c=0;
  for(let i=0;i<es.length;i++)for(let j=i+1;j<es.length;j++)if(es[j][0]>es[i][0]&&es[j][1]<es[i][1])c++;
  return c;
}

// Tidy up settles in one press: the layout runs again from its own result until nothing moves
// (at most a few times), so pressing Tidy up on a tidy chart changes nothing.
export function tidyLayout(chart,size){
  let c=chart,res=null;
  for(let i=0;i<4;i++){
    res=tidyOnce(c,size);
    if(c.nodes.every(n=>{const p=res.get(n.id);return !p||(p.x===n.x&&p.y===n.y&&(p.w==null||p.w===n.w)&&(p.h==null||p.h===n.h))}))break;
    c={...c,nodes:c.nodes.map(n=>res.has(n.id)?{...n,...res.get(n.id)}:n)};
  }
  return res;
}
function tidyOnce(chart,size){
  const all=chart.nodes,byId=new Map(all.map(n=>[n.id,n]));
  const rect=n=>{const [w,h]=size(n);return {x:n.x,y:n.y,w,h}};
  const inside=(r,a)=>r.x>=a.x&&r.y>=a.y&&r.x+r.w<=a.x+a.w&&r.y+r.h<=a.y+a.h;
  const areas=all.filter(n=>n.type==='area'),cards=all.filter(n=>n.type!=='area');
  // Each card belongs to the largest area it sits fully inside (nested areas fold into the outer one).
  const areaOf=new Map();
  for(const n of cards){
    const r=rect(n),hits=areas.filter(a=>inside(r,rect(a)));
    if(hits.length){const a=hits.reduce((p,q)=>rect(p).w*rect(p).h>=rect(q).w*rect(q).h?p:q);areaOf.set(n.id,a.id)}
  }
  const edges=chart.edges.filter(e=>byId.has(e.from)&&byId.has(e.to)&&e.from!==e.to&&byId.get(e.from).type!=='area'&&byId.get(e.to).type!=='area');
  const linked=new Set(edges.flatMap(e=>[e.from,e.to]));
  const graphCards=cards.filter(n=>linked.has(n.id)),loose=cards.filter(n=>!linked.has(n.id));

  // ---- 1. rows ----
  const ownIn=new Set(),ownOut=new Set();
  for(const e of edges)if(e.type==='ownership'){ownIn.add(e.to);ownOut.add(e.from)}
  const top=id=>!ownIn.has(id),dir=[];
  for(const e of edges){
    if(e.type==='ownership'){dir.push([e.from,e.to]);continue}
    const a=e.from,b=e.to;
    if(top(a)&&top(b))dir.push([a,b]);
    else if(top(a)&&!ownOut.has(a))dir.push([b,a]);
    else if(top(b)&&!ownOut.has(b))dir.push([a,b]);
  }
  // Drop lines that close a loop (depth-first, in the chart's order).
  const out=new Map(graphCards.map(n=>[n.id,[]]));
  for(const [a,b] of dir)if(!out.get(a).includes(b))out.get(a).push(b);
  const state=new Map(),keep=[];
  const visit=v=>{state.set(v,1);for(const w of out.get(v)){if(state.get(w)===1)continue;keep.push([v,w]);if(!state.has(w))visit(w)}state.set(v,2)};
  const xOf=id=>byId.get(id).x;
  const ins=new Map(graphCards.map(n=>[n.id,0]));for(const [,b] of dir)ins.set(b,ins.get(b)+1);
  for(const n of [...graphCards].sort((p,q)=>ins.get(p.id)-ins.get(q.id)||p.y-q.y||p.x-q.x))if(!state.has(n.id))visit(n.id);
  const kids=new Map(graphCards.map(n=>[n.id,[]])),parents=new Map(graphCards.map(n=>[n.id,[]]));
  for(const [a,b] of keep){kids.get(a).push(b);parents.get(b).push(a)}
  const layer=new Map(),longest=id=>{if(layer.has(id))return layer.get(id);layer.set(id,0);const l=Math.max(0,...parents.get(id).map(p=>longest(p)+1));layer.set(id,l);return l};
  for(const n of graphCards)longest(n.id);
  // Cards that only own things move down to just above their highest co-owned child (a child with
  // another parent stays put; one only they own moves down with them), deepest first.
  const sources=graphCards.filter(n=>!parents.get(n.id).length&&kids.get(n.id).length).sort((p,q)=>layer.get(q.id)-layer.get(p.id));
  for(const n of sources){
    const ks=kids.get(n.id),shared=ks.filter(k=>parents.get(k).length>1);
    layer.set(n.id,Math.min(...(shared.length?shared:ks).map(k=>layer.get(k)))-1);
    // Push its own children (and theirs) down to stay below it.
    const down=id=>{for(const k of kids.get(id))if(layer.get(k)<=layer.get(id)){layer.set(k,layer.get(id)+1);down(k)}};
    down(n.id);
  }
  // A project area hangs under its anchor: the card outside it with lines to most of its members
  // (at least half of those with lines out), the nearest one on a tie. Its members start in the row
  // under the anchor (the anchor's grouping lines to them now count as links), so the area is one
  // compact block right below that card, whoever owns its members.
  const reach=(from,to)=>{const seen=new Set(),st=[from];while(st.length){const v=st.pop();if(v===to)return true;if(seen.has(v))continue;seen.add(v);st.push(...kids.get(v))}return false};
  const anchorOf=new Map(),ownKids=new Map();
  for(const a of areas){
    const mem=graphCards.filter(n=>areaOf.get(n.id)===a.id).map(n=>n.id),inA=new Set(mem);
    if(!mem.length)continue;
    const by=new Map(),out=new Set();
    for(const e of edges){
      if(inA.has(e.from)===inA.has(e.to))continue;
      const [m,o]=inA.has(e.from)?[e.from,e.to]:[e.to,e.from];
      out.add(m);if(!by.has(o))by.set(o,new Set());by.get(o).add(m);
    }
    let anchor=null;
    for(const [o,s] of by){
      if(mem.some(m=>reach(m,o)))continue; // something in the area owns it: it can't sit above
      const b=anchor&&by.get(anchor).size;
      if(!anchor||s.size>b||(s.size===b&&layer.get(o)>layer.get(anchor)))anchor=o;
    }
    if(!anchor||by.get(anchor).size*2<out.size)continue;
    anchorOf.set(a.id,anchor);ownKids.set(a.id,kids.get(anchor).filter(k=>inA.has(k)));
    for(const m of by.get(anchor))if(!kids.get(anchor).includes(m)&&!reach(m,anchor)){kids.get(anchor).push(m);parents.get(m).push(anchor);keep.push([anchor,m])}
    // Members in order of their links inside the area, each just below everything that owns it.
    const depth=new Map(),din=m=>{if(depth.has(m))return depth.get(m);depth.set(m,0);const d=Math.max(0,...parents.get(m).filter(p=>inA.has(p)).map(p=>din(p)+1));depth.set(m,d);return d};
    for(const m of [...mem].sort((p,q)=>din(p)-din(q))){
      layer.set(m,Math.max(layer.get(anchor)+1,...parents.get(m).map(p=>layer.get(p)+1)));
      const down=id=>{for(const k of kids.get(id))if(layer.get(k)<=layer.get(id)){layer.set(k,layer.get(id)+1);down(k)}};
      down(m);
    }
  }
  const base=Math.min(...graphCards.map(n=>layer.get(n.id)));for(const n of graphCards)layer.set(n.id,layer.get(n.id)-base);
  const depth=graphCards.length?Math.max(...graphCards.map(n=>layer.get(n.id)))+1:0;

  // ---- 2. order ----
  // Items: cards, placeholders for long lines, and per area one block per row ('A:<area>:<row>').
  // An area's rows run from its first card's row to its last; links between consecutive rows
  // (both ends) are what ordering and placement pull on.
  const item=new Map(); // id -> {id,kind,w,h,layer,area,x0[,members]}
  const rows=Array.from({length:depth},()=>[]);
  const add=it=>{item.set(it.id,it);rows[it.layer].push(it.id);return it};
  // Stacks first: which children fold into one two-column block under their owner.
  const touching=new Map(graphCards.map(n=>[n.id,new Set()]));
  for(const e of edges){touching.get(e.from)?.add(e.to);touching.get(e.to)?.add(e.from)}
  const stackOf=new Map(),groups=new Map();
  for(const n of graphCards){
    const ps=parents.get(n.id);
    if(ps.length!==1||kids.get(n.id).length||layer.get(n.id)!==layer.get(ps[0])+1||touching.get(n.id).size!==1)continue;
    const k=`S:${ps[0]}:${areaOf.get(n.id)||''}`;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);
  }
  for(const [k,list] of groups){
    if(list.length<STACK_MIN)continue;
    // Their order: columns left to right (cards that overlap across are one column), each top to
    // bottom, so a row reads left to right and an existing stack keeps its order.
    const colsNow=[];
    for(const n of [...list].sort((p,q)=>p.x-q.x||p.y-q.y)){
      const w=size(n)[0],c=colsNow.find(c=>Math.min(c.x1,n.x+w)-Math.max(c.x0,n.x)>Math.min(w,c.x1-c.x0)/2);
      if(c){c.cards.push(n);c.x0=Math.min(c.x0,n.x);c.x1=Math.max(c.x1,n.x+w)}else colsNow.push({x0:n.x,x1:n.x+w,cards:[n]});
    }
    list.splice(0,list.length,...colsNow.flatMap(c=>c.cards.sort((p,q)=>p.y-q.y)));
    // Up to STACK_COL cards: one column with the spine down its left. More: two columns either
    // side of the spine.
    const one=list.length<=STACK_COL,rowsN=one?list.length:Math.ceil(list.length/2),cols=one?[[],list]:[list.slice(0,rowsN),list.slice(rowsN)];
    const wL=one?0:Math.max(...cols[0].map(n=>size(n)[0])),gap=one?SPINE1:SPINE,members=[];
    const rowHs=Array.from({length:rowsN},(_,i)=>Math.max(...cols.map(c=>c[i]?size(c[i])[1]:0)));
    // Two columns are staggered by half a card, so the lines off the spine alternate sides instead
    // of meeting across it (which would read as a line between the two cards).
    const stagger=one?0:Math.round((rowHs[0]+SGAP)/2/GRID)*GRID;
    cols.forEach((c,ci)=>c.forEach((n,i)=>{
      const dy=rowHs.slice(0,i).reduce((s,h)=>s+h+SGAP,0)+(ci?stagger:0);
      members.push({id:n.id,dx:ci?wL+gap:wL-size(n)[0],dy});stackOf.set(n.id,k);
    }));
    const w=wL+gap+Math.max(...cols[1].map(n=>size(n)[0]));
    add({id:k,kind:'stack',w,anchor:one?gap-56:wL+gap/2,h:Math.max(...members.map(m=>m.dy+size(byId.get(m.id))[1])),layer:layer.get(list[0].id),area:areaOf.get(list[0].id)||null,x0:list.reduce((s,n)=>s+n.x,0)/list.length,members});
  }
  for(const n of graphCards)if(!stackOf.has(n.id))add({id:n.id,kind:'card',w:size(n)[0],h:size(n)[1],layer:layer.get(n.id),area:areaOf.get(n.id)||null,x0:n.x});
  const links=[]; // [upper item, lower item, line id]
  const lines=[]; // long lines: [chain of item ids]
  const seen=new Set();
  for(const [a0,b0] of keep){
    const a=stackOf.get(a0)||a0,b=stackOf.get(b0)||b0;
    if(seen.has(a+'>'+b))continue;seen.add(a+'>'+b);
    const la=item.get(a).layer,lb=item.get(b).layer;
    const [u,v]=la<=lb?[a,b]:[b,a];const lu=Math.min(la,lb),lv=Math.max(la,lb);
    if(lu===lv)continue; // same row: drawn side to side, nothing to order
    const chain=[u];
    const shared=areaOf.get(u)&&areaOf.get(u)===areaOf.get(v)?areaOf.get(u):null;
    for(let l=lu+1;l<lv;l++)chain.push(add({id:`D:${u}:${v}:${l}`,kind:'dummy',w:DUMMY,layer:l,area:shared,x0:(item.get(u).x0+item.get(v).x0)/2}).id);
    chain.push(v);
    for(let i=0;i+1<chain.length;i++)links.push([chain[i],chain[i+1]]);
    if(chain.length>2)lines.push(chain);
  }
  // Area spans and their per-row blocks.
  const clusters=new Map();
  for(const it of item.values())if(it.area){
    const c=clusters.get(it.area)||{id:it.area,lo:Infinity,hi:-Infinity,members:[]};
    c.lo=Math.min(c.lo,it.layer);c.hi=Math.max(c.hi,it.layer);c.members.push(it.id);clusters.set(it.area,c);
  }
  const unitOf=id=>{const it=item.get(id);return it.area?`A:${it.area}:${it.layer}`:id};
  // Outer rows: free items plus one block per area row.
  const outer=rows.map((r,l)=>{
    const list=r.filter(id=>!item.get(id).area);
    for(const c of clusters.values())if(l>=c.lo&&l<=c.hi)list.push(`A:${c.id}:${l}`);
    return list;
  });
  const inner=new Map([...clusters.keys()].map(a=>[a,rows.map(r=>r.filter(id=>item.get(id).area===a))]));
  const x0=id=>{if(id.startsWith('A:')){const a=id.split(':')[1];return byId.get(a).x+rect(byId.get(a)).w/2}return item.get(id).x0+item.get(id).w/2};
  for(const r of outer)r.sort((p,q)=>x0(p)-x0(q));
  for(const rs of inner.values())for(const r of rs)r.sort((p,q)=>x0(p)-x0(q));
  // Where every item would sit if each row were packed and centred: barycentres on real widths, so
  // a wide row of siblings doesn't squeeze its neighbours' children into the wrong place.
  const areaW=new Map([...inner].map(([a,rs])=>[a,Math.max(...rs.map(r=>r.reduce((s,id)=>s+item.get(id).w+HGAP,-HGAP)))+PAD.x*2]));
  const posMap=()=>{
    const p=new Map();
    outer.forEach((r,l)=>{
      const w=u=>u.startsWith('A:')?areaW.get(u.split(':')[1]):item.get(u).w;
      let x=-(r.reduce((s,u)=>s+w(u)+HGAP,-HGAP))/2;
      for(const u of r){
        p.set(u,x+w(u)/2);
        if(u.startsWith('A:')){
          const list=inner.get(u.split(':')[1])[l],rw=list.reduce((s,id)=>s+item.get(id).w+HGAP,-HGAP);
          let ix=x+(w(u)-rw)/2;for(const id of list){p.set(id,ix+item.get(id).w/2);ix+=item.get(id).w+HGAP}
        }
        x+=w(u)+HGAP;
      }
    });
    return p;
  };
  const nbr=new Map([...item.keys()].map(id=>[id,{up:[],down:[]}]));
  for(const [u,v] of links){nbr.get(u).down.push(v);nbr.get(v).up.push(u)}
  // Crossings first; among orders with as many, the one with the shortest lines.
  const total=()=>{
    const p=posMap();let c=0,len=0;
    for(let l=0;l+1<depth;l++){
      const es=links.filter(([u])=>item.get(u).layer===l);
      c+=crossings(es,p);for(const [u,v] of es)len+=Math.abs(p.get(u)-p.get(v));
    }
    return c*1e7+len;
  };
  const snapshotOrder=()=>({outer:outer.map(r=>[...r]),inner:new Map([...inner].map(([a,rs])=>[a,rs.map(r=>[...r])]))});
  let best=snapshotOrder(),bestC=total();
  for(let it=0;it<ITER;it++){
    const down=it%2===0,order=down?[...rows.keys()].slice(1):[...rows.keys()].reverse().slice(1);
    for(const l of order){
      const p=posMap(),side=down?'up':'down',other=down?'down':'up';
      const bary=(id,sd=side)=>{const ns=nbr.get(id)[sd];return ns.length?ns.reduce((s,n)=>s+p.get(n),0)/ns.length:null};
      // Ties (siblings under one parent) go by where they lead on the other side, so a line
      // heading right sits to the right of its siblings.
      // A stack goes in the middle of its siblings, so its owner can sit right above it.
      const tie0=id=>bary(id,other)??p.get(id);
      const tieIn=row=>id=>{
        if(item.get(id)?.kind!=='stack')return tie0(id);
        const par=nbr.get(id).up[0],sib=row.filter(v=>v!==id&&!v.startsWith('A:')&&nbr.get(v).up.includes(par)).map(tie0);
        return sib.length?sib.reduce((a,b)=>a+b,0)/sib.length:p.get(id);
      };
      // Inner rows first, then blocks by the average of their cards.
      const avg=new Map();
      for(const [a,rs] of inner){
        const r=rs[l];if(!r.length)continue;
        const b=new Map(r.map(id=>[id,bary(id)]));
        sortBy(r,id=>b.get(id),tieIn(r));
        const known=r.map(id=>b.get(id)).filter(v=>v!==null);
        if(known.length)avg.set(`A:${a}:${l}`,known.reduce((s,v)=>s+v,0)/known.length);
      }
      sortBy(outer[l],u=>u.startsWith('A:')?(avg.has(u)?avg.get(u):null):bary(u),u=>u.startsWith('A:')?p.get(u):tieIn(outer[l])(u));
    }
    const c=total();if(c<bestC){bestC=c;best=snapshotOrder()}
  }
  outer.splice(0,outer.length,...best.outer);for(const [a,rs] of best.inner)inner.set(a,rs);

  // ---- 3. position ----
  function position(){
    const X=new Map(); // item -> left (cards in areas: offset inside the area until the end)
    const center=id=>X.get(id)+(item.get(id).anchor??item.get(id).w/2);
    // Areas first: lay out their cards on their own (inner lines only), then the area is a block.
    const box=new Map(); // area -> {w, x}
    for(const [a,rs] of inner){
      const c=clusters.get(a);
      for(let l=c.lo;l<=c.hi;l++){let x=0;for(const id of rs[l]){X.set(id,x);x+=item.get(id).w+HGAP}}
      const innerN=id=>({up:nbr.get(id).up.filter(n=>item.get(n).area===a),down:nbr.get(id).down.filter(n=>item.get(n).area===a)});
      for(let it=0;it<8;it++){
        const order=it%2?[...Array(c.hi-c.lo+1).keys()].map(k=>c.hi-k):[...Array(c.hi-c.lo+1).keys()].map(k=>c.lo+k);
        for(const l of order){
          const r=rs[l];if(!r.length)continue;
          const xs=placeRow(r.map(id=>{
            const it=item.get(id),st=innerN(id).down.find(m=>item.get(m).kind==='stack'),ns=st?[st]:[...innerN(id).up,...innerN(id).down];
            return {w:it.w,want:ns.length?ns.reduce((s,n)=>s+center(n),0)/ns.length-(it.anchor??it.w/2):X.get(id),weight:ns.length?(st||it.kind==='stack'?8:1):.1};
          }));
          r.forEach((id,i)=>X.set(id,xs[i]));
        }
      }
      const ids=c.members,lo=Math.min(...ids.map(id=>X.get(id))),hi=Math.max(...ids.map(id=>X.get(id)+item.get(id).w));
      for(const id of ids)X.set(id,X.get(id)-lo+PAD.x);
      box.set(a,{w:hi-lo+PAD.x*2,x:0});
    }
    const W=u=>u.startsWith('A:')?box.get(u.split(':')[1]).w:item.get(u).w;
    const left=new Map(); // outer unit -> left
    outer.forEach(r=>{let x=0;for(const u of r){left.set(u,x);x+=W(u)+HGAP}});
    for(const a of box.keys()){const us=[...left].filter(([u])=>u.startsWith(`A:${a}:`)).map(([,x])=>x);box.get(a).x=Math.max(...us)}
    // An item's centre line: a stack's is its spine.
    const mid=id=>{const it=item.get(id);return it.anchor??it.w/2};
    const at=id=>{const it=item.get(id);return (it.area?box.get(it.area).x+X.get(id):left.get(id))+mid(id)};
    // Where a long line's placeholder wants to be: on the straight line between its ends.
    const straight=new Map();
    const wantOf=(u,l,side)=>{
      // The centre an outer unit would like, from its neighbours on one or both sides.
      const ids=u.startsWith('A:')?inner.get(u.split(':')[1])[l]:[u];
      let sum=0,n=0;
      for(const id of ids){
        const off=u.startsWith('A:')?X.get(id)+mid(id):0;
        if(straight.has(id)){sum+=straight.get(id)-off;n++;continue}
        // A card with a stack sits right over its spine (whatever its other children want).
        const st=nbr.get(id).down.find(m=>item.get(m).kind==='stack');
        if(st&&side!=='up'){sum+=(at(st)-off)*8;n+=8;continue}
        const ns=side?nbr.get(id)[side]:[...nbr.get(id).up,...nbr.get(id).down];
        for(const m of ns){sum+=at(m)-off;n++}
      }
      return n?{c:sum/n,n}:null;
    };
    const solveRow=(l,side,areaWeight)=>{
      const r=outer[l];
      const xs=placeRow(r.map(u=>{
        const w=W(u),wt=wantOf(u,l,side);
        if(u.startsWith('A:')){const b=box.get(u.split(':')[1]);const want=wt?(wt.c*wt.n+b.x*areaWeight)/(wt.n+areaWeight):b.x;return {w,want,weight:(wt?wt.n:0)+areaWeight}}
        // A line's placeholder holds firm (cards make way for the line, not the other way round).
      return {w,want:wt?wt.c-mid(u):left.get(u),weight:wt?wt.n*(['dummy','stack'].includes(item.get(u).kind)?4:1):.05};
      }));
      r.forEach((u,i)=>left.set(u,xs[i]));
      for(const u of r)if(u.startsWith('A:')){const a=u.split(':')[1],c=clusters.get(a),n=c.hi-c.lo+1;box.get(a).x+=(left.get(u)-box.get(a).x)/n}
    };
    for(let it=0;it<18;it++){
      straight.clear();
      for(const ch of lines){const a=at(ch[0]),b=at(ch.at(-1)),n=ch.length-1;ch.forEach((id,i)=>{if(i&&i<n)straight.set(id,a+(b-a)*i/n)})}
      const order=it%3===2?[...rows.keys()]:it%2?[...rows.keys()].reverse():[...rows.keys()];
      for(const l of order)solveRow(l,it%3===2?null:it%2?'down':'up',2);
    }
    // Areas take one x across their rows: pin them and push everything else clear of them.
    for(let guard=0;guard<500;guard++){
      let bumped=false;
      for(const r of outer){
        for(const u of r)if(u.startsWith('A:'))left.set(u,box.get(u.split(':')[1]).x);
        // Free cards follow the previous card; a pinned block pulls the free cards before it left,
        // back to the previous pin, and moves its whole area right when they can't make room.
        const pin=u=>u.startsWith('A:');
        for(let i=1;i<r.length&&!bumped;i++){
          const p=r[i-1],u=r[i],min=left.get(p)+W(p)+HGAP;
          if(left.get(u)>=min-.01)continue;
          if(!pin(u)){left.set(u,min);continue}
          let j=i-1;while(j>=0&&!pin(r[j]))j--;
          let edge=left.get(u);for(let k=i-1;k>j;k--){const x=Math.min(left.get(r[k]),edge-HGAP-W(r[k]));left.set(r[k],x);edge=x}
          const deficit=j<0?0:left.get(r[j])+W(r[j])+HGAP-(j+1<i?left.get(r[j+1]):left.get(u));
          if(deficit>.01){box.get(u.split(':')[1]).x+=deficit;bumped=true}
        }
        if(bumped)break;
      }
      if(!bumped)break;
    }
    // Last, every stack sits right under its owner's spine: slide the stack (or else the owner)
    // as far as its neighbours in the row allow.
    const slide=(u,want)=>{
      const r=outer[item.get(u).layer],i=r.indexOf(u);
      const lo=i>0?left.get(r[i-1])+W(r[i-1])+HGAP:-Infinity,hi=i+1<r.length?left.get(r[i+1])-HGAP-W(u):Infinity;
      if(lo<=hi)left.set(u,Math.max(lo,Math.min(hi,want)));
    };
    const under=()=>{for(let it=0;it<3;it++)for(const st of item.values()){
      if(st.kind!=='stack'||st.area)continue;
      const par=nbr.get(st.id).up[0];if(!par||item.get(par).area)continue;
      slide(st.id,at(par)-mid(st.id));
      if(Math.abs(at(par)-at(st.id))>1)slide(par,at(st.id)-mid(par));
    }};
    under();
    // A card with several owners slides toward the middle of them, and an area hangs centred under
    // its anchor, as far as the cards beside them allow (line placeholders don't count any more).
    const real=u=>!u.startsWith('D:');
    const room=(r,i,w)=>{
      let lo=-Infinity,hi=Infinity;
      for(let j=i-1;j>=0;j--)if(real(r[j])){lo=left.get(r[j])+W(r[j])+HGAP;break}
      for(let j=i+1;j<r.length;j++)if(real(r[j])){hi=left.get(r[j])-HGAP-w;break}
      return [lo,hi];
    };
    for(const it of item.values()){
      if(it.kind!=='card'||it.area)continue;
      const ps=nbr.get(it.id).up.map(u=>u.startsWith('D:')?u.split(':')[1]:u).filter(u=>item.has(u));
      if(new Set(ps).size<2)continue;
      const r=outer[it.layer],[lo,hi]=room(r,r.indexOf(it.id),it.w),want=ps.reduce((s,u)=>s+at(u),0)/ps.length-it.w/2;
      if(lo<=hi)left.set(it.id,Math.max(lo,Math.min(hi,want)));
    }
    for(const [a,anc] of anchorOf){
      const b=box.get(a),c=clusters.get(a);if(!b||!c||!item.has(anc)||item.get(anc).area)continue;
      let lo=-Infinity,hi=Infinity;
      for(let l=c.lo;l<=c.hi;l++){const r=outer[l],[l0,h0]=room(r,r.indexOf(`A:${a}:${l}`),b.w);lo=Math.max(lo,l0);hi=Math.min(hi,h0)}
      // Centred on the cards the anchor owns, if it owns some of them (the rest sit to the side).
      const own=(ownKids.get(a)||[]).filter(id=>X.has(id)),off=own.length?own.reduce((s,id)=>s+X.get(id)+mid(id),0)/own.length:b.w/2;
      if(lo<=hi){b.x=Math.max(lo,Math.min(hi,at(anc)-off));for(let l=c.lo;l<=c.hi;l++)left.set(`A:${a}:${l}`,b.x)}
    }
    under();
    return {X,box,left,at};
  }
  const P=position();
  const {X,box,left}=P;
  // Row heights and tops. The gap under a row grows with the number of owners whose buses would
  // overlap in it, so each owner's lines get a lane of their own.
  const rowH=rows.map(r=>Math.max(0,...r.map(id=>item.get(id).h||0)));
  const lanes=rows.map(()=>new Map());
  for(const e of edges){
    const u=stackOf.get(e.from)||e.from,v=stackOf.get(e.to)||e.to;if(!item.has(u)||!item.has(v))continue;
    const lu=item.get(u).layer,lv=item.get(v).layer;if(lu===lv)continue;
    const k=(lu<lv?u:v)+':'+e.type,xs=[P.at(u),P.at(v)];
    for(let l=Math.min(lu,lv);l<Math.max(lu,lv);l++){const m=lanes[l],o=m.get(k);m.set(k,o?[Math.min(o[0],...xs),Math.max(o[1],...xs)]:[Math.min(...xs),Math.max(...xs)])}
  }
  const depthOf=m=>{const iv=[...m.values()];let best=0;for(const [a] of iv){const n=iv.filter(([p,q])=>p<=a&&q>=a).length;if(n>best)best=n}return best};
  const ys=[];let y=0;
  for(let l=0;l<depth;l++){
    // Leave room for an area's title above its first row and its padding below its last.
    const opens=[...clusters.values()].some(c=>c.lo===l),closes=l>0&&[...clusters.values()].some(c=>c.hi===l-1);
    if(l)y+=Math.max(VGAP,Math.min(280,48+depthOf(lanes[l-1])*20))+(opens&&closes?PAD.top+PAD.bottom-VGAP/2:0);
    ys.push(y);y+=rowH[l];
  }
  const res=new Map();
  // Cards line up along the top of their row (a stack hangs down from there).
  // Inside an area, rows are only as tall as the area's own cards (a tall stack elsewhere in the
  // row doesn't leave a gap in the box).
  const ya=new Map();
  for(const [a,c] of clusters){
    const m=new Map();let y=ys[c.lo];
    for(let l=c.lo;l<=c.hi;l++){m.set(l,Math.min(ys[l],y));const h=Math.max(0,...c.members.filter(id=>item.get(id).layer===l).map(id=>item.get(id).h||0));y=m.get(l)+h+VGAP}
    ya.set(a,m);
  }
  const yOf=it=>it.area?ya.get(it.area).get(it.layer):ys[it.layer];
  for(const it of item.values()){
    const x=it.area?box.get(it.area).x+X.get(it.id):left.get(it.id),y=yOf(it);
    if(it.kind==='card')res.set(it.id,{x,y});
    else if(it.kind==='stack')for(const m of it.members)res.set(m.id,{x:x+m.dx,y:y+m.dy});
  }
  for(const [a,b] of box){
    const c=clusters.get(a),bottom=Math.max(...c.members.map(id=>yOf(item.get(id))+(item.get(id).h||0)));
    res.set(a,{x:b.x,y:ys[c.lo]-PAD.top,w:b.w,h:bottom+PAD.bottom-(ys[c.lo]-PAD.top)});
  }
  // Loose cards and empty areas: a row underneath, in their current order.
  let bottom=Math.max(0,...[...res.values()].map(p=>p.y+(p.h||0)+48)),lx=0;
  const rest=[...loose,...areas.filter(a=>!box.has(a.id))].sort((p,q)=>p.x-q.x);
  if(rest.length&&res.size)bottom+=VGAP;
  for(const n of rest){res.set(n.id,{x:lx,y:bottom});lx+=size(n)[0]+HGAP}
  // Keep the chart where it was (top left of everything) and on the grid.
  if(!res.size)return res;
  const minX=Math.min(...[...res.values()].map(p=>p.x)),minY=Math.min(...[...res.values()].map(p=>p.y));
  const ox=Math.min(...all.map(n=>n.x)),oy=Math.min(...all.map(n=>n.y));
  const g=v=>Math.round(v/GRID)*GRID||0;
  for(const p of res.values()){p.x=g(p.x-minX)+g(ox);p.y=g(p.y-minY)+g(oy);if(p.w){p.w=Math.min(5000,g(p.w));p.h=Math.min(5000,g(p.h))}}
  return res;
}

// Stable sort by a key; items with no key keep their place relative to their current position.
function sortBy(list,key,cur){
  const k=list.map((id,i)=>({id,k:key(id),c:cur(id),i}));
  const fixed=k.filter(e=>e.k===null),moving=k.filter(e=>e.k!==null).sort((p,q)=>p.k-q.k||p.c-q.c);
  // Items without neighbours stay at their index; the rest fill the other slots in order.
  const out=new Array(list.length);for(const f of fixed)out[f.i]=f.id;
  let m=0;for(let i=0;i<out.length;i++)if(out[i]===undefined)out[i]=moving[m++].id;
  list.splice(0,list.length,...out);
}

// ---------- lines ----------
// Smart lines: every edge is drawn as an orthogonal (elbow) connector with rounded corners that
// leaves and enters its cards square to their sides and never runs through another card.
// 1. Sides. Each edge attaches to the facing sides of its two cards (a card clearly a row above or
//    below joins bottom to top). Side by side with cards in between, it dips under the row; down into
//    a stack it runs down the stack's spine and turns into the card's side.
// 2. Ports. Lines out of the same side of a card share one port when they are of one kind and the
//    card is their owner (or the line is a grouping line), so a fan-out reads as one trunk with a bus,
//    like an org chart. Other ports on a side are spread along it, ordered by where the far end sits.
// 3. Routes. Each line first tries the simple shapes, straight, one elbow pair (Z) or a U under or
//    over a row, placing its bend in the free band nearest the card it points to. When those would
//    meet a card, a small grid search (fewest bends, then shortest) threads it through the gaps.
// 4. Lanes. Middle segments of different trunks that would run on top of each other are moved apart.
// 5. Labels. A % sits on the line just before the card it points to, moved along the line to stay
//    clear of cards and other labels.
const NORMAL={t:[0,-1],b:[0,1],l:[-1,0],r:[1,0]},ROW_GAP=32;
const STUB=14,RADIUS=10,M=10,LANE=18,BEND=140;
// A card clearly above or below the other (a row apart) joins top to bottom however far across it
// sits, so lines between rows never cut sideways through the cards of a row.
function sides(a,b){
  const dx=b.x+b.w/2-a.x-a.w/2,dy=b.y+b.h/2-a.y-a.h/2;
  if(b.y-(a.y+a.h)>=ROW_GAP)return ['b','t'];
  if(a.y-(b.y+b.h)>=ROW_GAP)return ['t','b'];
  return Math.abs(dy)-(a.h+b.h)/2>=Math.abs(dx)-(a.w+b.w)/2?(dy>=0?['b','t']:['t','b']):(dx>=0?['r','l']:['l','r']);
}
// Canonical frames: every route is worked out as if it left its first card downwards. tf maps a
// point into the frame for a side, un maps it back.
const TF={b:[(x,y)=>[x,y],(x,y)=>[x,y]],t:[(x,y)=>[x,-y],(x,y)=>[x,-y]],r:[(x,y)=>[y,x],(x,y)=>[y,x]],l:[(x,y)=>[y,-x],(x,y)=>[-y,x]]};
const tfRect=(f,q)=>{const [x1,y1]=f(q.x,q.y),[x2,y2]=f(q.x+q.w,q.y+q.h);return {id:q.id,x:Math.min(x1,x2),y:Math.min(y1,y2),w:Math.abs(x2-x1),h:Math.abs(y2-y1)}};
const tfSide=(f,s)=>{const [nx,ny]=f(...NORMAL[s]);return ny<-.5?'t':ny>.5?'b':nx<-.5?'l':'r'};

// Rounded orthogonal path through points (corners of RADIUS, smaller on short segments).
function pathD(pts){
  const f=n=>Math.round(n*10)/10;
  let d=`M${f(pts[0].x)} ${f(pts[0].y)}`;
  for(let i=1;i<pts.length-1;i++){
    const A=pts[i-1],B=pts[i],C=pts[i+1],l1=Math.abs(B.x-A.x)+Math.abs(B.y-A.y),l2=Math.abs(C.x-B.x)+Math.abs(C.y-B.y);
    const r=Math.max(0,Math.min(RADIUS,i===1?l1:l1/2,i===pts.length-2?l2-8:l2/2));
    const ux=Math.sign(B.x-A.x),uy=Math.sign(B.y-A.y),vx=Math.sign(C.x-B.x),vy=Math.sign(C.y-B.y);
    d+=`L${f(B.x-ux*r)} ${f(B.y-uy*r)}`+(r>0?`Q${f(B.x)} ${f(B.y)} ${f(B.x+vx*r)} ${f(B.y+vy*r)}`:'');
  }
  const Z=pts.at(-1);return d+`L${f(Z.x)} ${f(Z.y)}`;
}
const segsOf=pts=>pts.slice(1).map((q,i)=>[pts[i],q]);
// Drop repeated and collinear points.
function simplify(pts){
  const out=[];
  for(const p of pts){
    const q=out.at(-1);if(q&&Math.abs(q.x-p.x)<.5&&Math.abs(q.y-p.y)<.5)continue;
    const o=out.at(-2);
    if(o&&q&&((Math.abs(o.x-q.x)<.5&&Math.abs(q.x-p.x)<.5)||(Math.abs(o.y-q.y)<.5&&Math.abs(q.y-p.y)<.5)))out.pop();
    out.push({x:p.x,y:p.y});
  }
  return out;
}

// Binary min-heap of states by cost (pop returns the state; .cost is its cost).
function heap(){
  const k=[],v=[];
  return {
    cost:0,get size(){return k.length},
    push(c,s){let i=k.length;k.push(c);v.push(s);while(i){const p=(i-1)>>1;if(k[p]<=c)break;k[i]=k[p];v[i]=v[p];i=p}k[i]=c;v[i]=s},
    pop(){
      const c=k[0],s=v[0],lc=k.pop(),ls=v.pop(),n=k.length;
      if(n){let i=0;for(;;){const l=2*i+1,r=l+1;let m=-1,mc=lc;if(l<n&&k[l]<mc){m=l;mc=k[l]}if(r<n&&k[r]<mc){m=r}if(m<0)break;k[i]=k[m];v[i]=v[m];i=m}k[i]=lc;v[i]=ls}
      this.cost=c;return s;
    }
  };
}
// Index range of sorted values strictly between lo and hi.
const range=(c,lo,hi)=>{let a=0,b=c.length;while(a<b){const m=(a+b)>>1;if(c[m]<=lo)a=m+1;else b=m}let e=a;while(e<c.length&&c[e]<hi)e++;return [a,e]};
// Grid search from S (leaving in direction ds) to T (arriving in direction dt) around obstacles
// (cards grown by M). Grid lines: the obstacles' grown edges, the middles between them and S/T.
// Cost: length plus BEND per corner; lines along a card's edge cost a little more than ones down
// the middle of a gap. A* with the straight-line (Manhattan) distance. Returns the points, or null.
const DIRS=[[1,0],[-1,0],[0,1],[0,-1]];
function gridRoute(S,T,ds,dt,obs,pad,areas=[],ctl=null){
  const x0=Math.min(S.x,T.x)-pad,x1=Math.max(S.x,T.x)+pad,y0=Math.min(S.y,T.y)-pad,y1=Math.max(S.y,T.y)+pad;
  // A card right by an end only keeps the line off itself (2px), not the usual margin, so a line
  // can always leave its port.
  const by=(p,q)=>p.x>q.x-M&&p.x<q.x+q.w+M&&p.y>q.y-M&&p.y<q.y+q.h+M;
  const os=obs.filter(q=>q.x-M<x1&&q.x+q.w+M>x0&&q.y-M<y1&&q.y+q.h+M>y0).map(q=>({x:q.x,y:q.y,w:q.w,h:q.h,m:by(S,q)||by(T,q)?2:M}));
  // The same search (same ends, same cards around) gives the same answer: while a card is dragged
  // only the lines near it search again.
  const key=`${S.x},${S.y},${T.x},${T.y},${ds},${dt},${pad}|`+os.map(q=>`${q.x},${q.y},${q.w},${q.h}`).join(';')+'|'+areas.map(q=>`${q.x},${q.y},${q.w},${q.h}`).join(';');
  if(ROUTES.has(key)){const r=ROUTES.get(key);ROUTES.delete(key);ROUTES.set(key,r);return r}
  // Out of time for this call: undefined (not cached), and the caller draws a simple elbow.
  if(ctl&&performance.now()>ctl.end)return undefined;
  const as=areas.filter(q=>q.x<x1&&q.x+q.w>x0&&q.y<y1&&q.y+q.h>y0);
  const r=search(S,T,ds,dt,os,x0,x1,y0,y1,as,ctl);
  if(r!==undefined){ROUTES.set(key,r);if(ROUTES.size>4000)ROUTES.delete(ROUTES.keys().next().value)}
  return r;
}
const ROUTES=new Map(); // least recently used first
function search(S,T,ds,dt,os,x0,x1,y0,y1,as,ctl){
  const axis=(a,b,lo,hi,get)=>{
    const edge=new Set([lo,hi]);for(const q of os){const [s,w]=get(q);edge.add(s-q.m);edge.add(s+w+q.m)}
    const v=[...edge].filter(c=>c>=lo&&c<=hi).sort((p,q)=>p-q),mid=new Set();
    // Middles of gaps (lines run down the centre of a gap); a big search keeps only the wide gaps.
    const wide=os.length>24?3*M:2;
    for(let i=0;i+1<v.length;i++)if(v[i+1]-v[i]>wide)mid.add((v[i]+v[i+1])/2);
    const all=[...new Set([...v,...mid,a,b])].sort((p,q)=>p-q);
    // Lines along an area's border cost more; so do lines hugging a card.
    const near=c=>as.some(q=>{const [s,w]=get(q);return Math.abs(c-s)<14||Math.abs(c-s-w)<14});
    return {c:all,w:all.map(c=>(c===a||c===b||mid.has(c)?1:1.15)*(near(c)?1.6:1))};
  };
  const X=axis(S.x,T.x,x0,x1,q=>[q.x,q.w]),Y=axis(S.y,T.y,y0,y1,q=>[q.y,q.h]),nx=X.c.length,ny=Y.c.length;
  // Blocked nodes and segments (a segment is blocked when its middle is inside an obstacle).
  const XM=X.c.slice(0,-1).map((c,i)=>(c+X.c[i+1])/2),YM=Y.c.slice(0,-1).map((c,j)=>(c+Y.c[j+1])/2);
  const bn=new Uint8Array(nx*ny),bh=new Uint8Array(nx*ny),bv=new Uint8Array(nx*ny);
  for(const q of os){
    const lx=q.x-q.m+.5,hx=q.x+q.w+q.m-.5,ly=q.y-q.m+.5,hy=q.y+q.h+q.m-.5;
    const [i0,i1]=range(X.c,lx,hx),[j0,j1]=range(Y.c,ly,hy),[m0,m1]=range(XM,lx,hx),[n0,n1]=range(YM,ly,hy);
    for(let j=j0;j<j1;j++){for(let i=i0;i<i1;i++)bn[j*nx+i]=1;for(let i=m0;i<m1;i++)bh[j*nx+i]=1}
    for(let j=n0;j<n1;j++)for(let i=i0;i<i1;i++)bv[j*nx+i]=1;
  }
  const si=X.c.indexOf(S.x),sj=Y.c.indexOf(S.y),ti=X.c.indexOf(T.x),tj=Y.c.indexOf(T.y);
  bn[sj*nx+si]=0;bn[tj*nx+ti]=0;
  const N=nx*ny*4,dist=new Float64Array(N).fill(Infinity),prev=new Int32Array(N).fill(-1),h=heap();
  // Remaining length, plus a corner when T isn't straight ahead (keeps A* from flooding the grid).
  const hr=(i,j,d)=>{const dx=T.x-X.c[i],dy=T.y-Y.c[j],ax=Math.abs(dx)>.5,ay=Math.abs(dy)>.5;
    const ahead=!ax&&!ay?true:!ax?(dy>0?d===2:d===3):!ay?(dx>0?d===0:d===1):false;
    return Math.abs(dx)+Math.abs(dy)+(ahead?0:BEND)};
  const st=(sj*nx+si)*4+ds;dist[st]=0;h.push(hr(si,sj,ds),st);
  const goal=tj*nx+ti;let best=-1,pops=0;
  while(h.size){
    // Out of time: undefined (not "no route", just not now). A huge search ends as no route.
    if(ctl&&(++pops&127)===0&&performance.now()>ctl.end)return undefined;
    if(pops>60000)break;
    const s=h.pop(),node=s>>2,d=s&3,i=node%nx,j=(node-i)/nx,c=dist[s];
    if(h.cost>c+hr(i,j,d)+.001)continue;
    if(node===goal){if(d===dt){best=s;break}continue}
    for(let nd=0;nd<4;nd++){
      if((nd^1)===d)continue;
      const ii=i+DIRS[nd][0],jj=j+DIRS[nd][1];if(ii<0||jj<0||ii>=nx||jj>=ny)continue;
      const nn=jj*nx+ii;if(bn[nn])continue;
      if(nd<2?bh[j*nx+Math.min(i,ii)]:bv[Math.min(j,jj)*nx+i])continue;
      const len=nd<2?Math.abs(X.c[ii]-X.c[i])*Y.w[j]:Math.abs(Y.c[jj]-Y.c[j])*X.w[i];
      const ncost=c+len+(nd!==d?BEND:0)+(nn===goal&&nd!==dt?BEND:0),ns=nn*4+nd;
      if(ncost<dist[ns]){dist[ns]=ncost;prev[ns]=s;h.push(ncost+hr(ii,jj,nd),ns)}
    }
  }
  if(best<0)return null;
  const pts=[];for(let s=best;s>=0;s=prev[s]){const node=s>>2,i=node%nx;pts.push({x:X.c[i],y:Y.c[(node-i)/nx]})}
  pts.reverse();pts.cost=dist[best];return pts;
}
const dirOf=(nx,ny)=>nx>.5?0:nx<-.5?1:ny>.5?2:3;

// opt.budget: milliseconds of grid search allowed in this call (while a card is dragged); lines
// that would need more are drawn roughly until the next full render.
export function edgeGeometry(c,rect,opt={}){
  // While a card is dragged, grid searches stop after opt.budget ms; other renders route in full.
  const ctl={end:opt.budget==null?Infinity:performance.now()+opt.budget};
  const rects=new Map(c.nodes.map(n=>[n.id,{id:n.id,...rect(n)}])),out=new Map();
  const solid=c.nodes.filter(n=>n.type!=='area').map(n=>rects.get(n.id));
  const frames={};const framed=s=>frames[s]||(frames[s]=solid.map(q=>tfRect(TF[s][0],q)));
  // Area boxes: lines may cross their borders but keep off running along them.
  const areaRs=c.nodes.filter(n=>n.type==='area').map(n=>rects.get(n.id)),aframes={};
  const areaTitleW=c.nodes.filter(n=>n.type==='area').map(n=>Math.min(rects.get(n.id).w,30+String(n.name||'').length*7.6));
  const aframed=s=>aframes[s]||(aframes[s]=areaRs.map(q=>tfRect(TF[s][0],q)));
  // Side by side with another card in between: the line dips under the row instead of through it.
  const blocked=(e,a,b)=>{
    const [l,r]=a.x<b.x?[a,b]:[b,a],x0=l.x+l.w,x1=r.x,y0=Math.min(l.y+l.h/2,r.y+r.h/2)-4,y1=Math.max(l.y+l.h/2,r.y+r.h/2)+4;
    return solid.some(q=>q.id!==e.from&&q.id!==e.to&&q.x<x1&&q.x+q.w>x0&&q.y<y1&&q.y+q.h>y0);
  };
  // A row apart, but another card sits right above the lower one (a stack): the line comes down
  // beside it and enters its side, leaving the upper card at a fixed x (the stack's spine): the
  // middle of the gap to the next card along, or a little way out from the card.
  // The top card of such a column joins the same way when the card under it is also linked to u.
  const nb=new Map();for(const e of c.edges){for(const [x,y] of [[e.from,e.to],[e.to,e.from]]){if(!nb.has(x))nb.set(x,new Set());nb.get(x).add(y)}}
  const covered=(e,u,l)=>solid.some(q=>q.id!==e.from&&q.id!==e.to&&q.x<l.x+l.w-8&&q.x+q.w>l.x+8&&((q.y+q.h<=l.y&&q.y+q.h>l.y-40&&q.y+q.h>u.y+u.h)||(q.y>=l.y+l.h&&q.y<l.y+l.h+40&&nb.get(u.id)?.has(q.id))));
  // Where the spine would run: the middle of the gap to the next card along (good: true), or far
  // enough out from the card for its % to fit between.
  const spine=(e,u,l,right)=>{
    const ys=q=>q.y<l.y+l.h&&q.y+q.h>l.y;
    let gap=Infinity;
    for(const q of solid)if(q.id!==e.from&&q.id!==e.to&&ys(q)){const g=right?q.x-(l.x+l.w):l.x-(q.x+q.w);if(g>0&&g<gap)gap=g}
    const off=gap<=128?gap/2:56;
    return {x:right?l.x+l.w+off:l.x-off,good:gap<=120};
  };
  const gs=[],ports=new Map(),sideList=new Map();
  const port=(key,r,side,along,fixed,merge)=>{
    let p=ports.get(key);
    if(!p){p={key,r,side,along:[],fixed,merge,n:0};ports.set(key,p);if(fixed==null){const k=r.id+':'+side;if(!sideList.has(k))sideList.set(k,[]);sideList.get(k).push(p)}}
    p.along.push(along);p.n++;return p;
  };
  // Grouping lines from one card to several cards of an area it is outside of end at the area's
  // border: the box already shows who is in it.
  const areaOfCard=new Map();
  for(const n of c.nodes)if(n.type!=='area'){const r=rects.get(n.id),as=areaRs.filter(a=>r.x>=a.x&&r.y>=a.y&&r.x+r.w<=a.x+a.w&&r.y+r.h<=a.y+a.h);if(as.length)areaOfCard.set(n.id,as.reduce((p,q)=>p.w*p.h<=q.w*q.h?p:q))}
  const toArea=new Map(),cnt=new Map();
  for(const e of c.edges)if(e.type==='group'){
    for(const [s0,t0] of [[e.from,e.to],[e.to,e.from]]){const A=areaOfCard.get(t0);if(A&&areaOfCard.get(s0)!==A&&!(rects.get(s0)&&rects.get(s0).x>=A.x&&rects.get(s0).x+rects.get(s0).w<=A.x+A.w&&rects.get(s0).y>=A.y&&rects.get(s0).y+rects.get(s0).h<=A.y+A.h)){const k=s0+'>'+A.id;cnt.set(k,(cnt.get(k)||0)+1);toArea.set(e.id,[s0,t0,A,k])}}
  }
  for(const e of c.edges){
    let a=rects.get(e.from),b=rects.get(e.to);if(!a||!b||e.from===e.to)continue;
    const ta=toArea.get(e.id);
    let mem=null,memEnd=-1;
    if(ta&&cnt.get(ta[3])>=2){mem=rects.get(ta[1]);memEnd=ta[1]===e.to?1:0;if(memEnd)b=ta[2];else a=ta[2]}
    let [sa,sb]=sides(a,b),fix=null;
    if('lr'.includes(sa)&&blocked(e,a,b))sa=sb='b';
    else if(sa!==sb&&'tb'.includes(sa)){
      const down=sa==='b',[u,l]=down?[a,b]:[b,a];
      if(covered(e,u,l)){
        // The side nearer the owner, unless only the other has room to come down beside the stack.
        let top=l;for(let k=0;k<12;k++){const t=top,q=solid.find(q=>q.id!==e.from&&q.id!==e.to&&q!==t&&q.x<t.x+t.w-8&&q.x+q.w>t.x+8&&q.y+q.h<=t.y&&q.y+q.h>t.y-40&&q.y+q.h>u.y+u.h);if(!q)break;top=q}
        const pref=u.x+u.w/2>l.x+l.w/2,room=right=>{const x=spine(e,u,l,right).x;return !solid.some(q=>q.id!==e.from&&q.id!==e.to&&x>q.x-6&&x<q.x+q.w+6&&q.y<l.y+l.h/2&&q.y+q.h>top.y-48)};
        // A gap between two columns (a two-column stack's spine) wins over the nearer side.
        const good=r=>spine(e,u,l,r).good&&room(r);
        const right=good(pref)?pref:good(!pref)?!pref:room(pref)||!room(!pref)?pref:!pref,side=right?'r':'l';
        if(down)sb=side;else sa=side;
        fix={end:down?0:1,u,l,...spine(e,u,l,right),grp:`${u.id}:${down?'b':'t'}:${e.type}`};
      }
    }
    gs.push({e,a,b,sa,sb,fix,mem,memEnd});
  }
  // One spine per stack: spines of one owner's lines that nearly line up take the gap's middle.
  const fixes=gs.filter(g=>g.fix);
  for(const g of fixes){
    if(g.fix.good)continue;
    const m=fixes.find(h=>h.fix.good&&h.fix.grp===g.fix.grp&&Math.abs(h.fix.x-g.fix.x)<=40);
    if(m)g.fix.x=m.fix.x;
  }
  // A column of cards entered from the same side shares the spine furthest out.
  for(const g of fixes){
    const side=g.fix.end?g.sa:g.sb,col=fixes.filter(h=>h.fix.grp===g.fix.grp&&(h.fix.end?h.sa:h.sb)===side&&h.fix.l.x<g.fix.l.x+g.fix.l.w&&h.fix.l.x+h.fix.l.w>g.fix.l.x);
    const xs=col.map(h=>h.fix.x);g.fix.x2=side==='r'?Math.max(...xs):Math.min(...xs);
  }
  for(const g of fixes)g.fix.x=g.fix.x2;
  // A spine must start under its owner and run down clear of the cards beside it; otherwise the
  // line still enters the side, but from the owner's shared port.
  for(const g of fixes){
    const {u,l,x}=g.fix,y0=g.fix.end?u.y:u.y+u.h,y1=l.y+l.h/2;
    const ok=x>=u.x+8&&x<=u.x+u.w-8&&!solid.some(q=>q.id!==g.e.from&&q.id!==g.e.to&&x>q.x-6&&x<q.x+q.w+6&&q.y<Math.max(y0,y1)&&q.y+q.h>Math.min(y0,y1));
    if(!ok)g.fix=null;
  }
  // Ports: shared by the lines of one kind out of a card's side when the card is their owner
  // (grouping lines share at either end).
  for(const g of gs){
    const {e,fix}=g;
    const end=(i,r,side,other)=>{
      const along='tb'.includes(side)?other.x+other.w/2:other.y+other.h/2;
      const merge=e.type==='group'||i===0;
      if(fix&&fix.end===i)return port(`${r.id}:${side}:${e.type}:x${Math.round(fix.x)}`,r,side,along,fix.x,true);
      // Into an area's border: above (or below) the card it is for, so each line stays its own.
      if(g.memEnd===i&&'tb'.includes(side))return port(`${r.id}:${side}:#${e.id}`,r,side,along,Math.max(r.x+12,Math.min(r.x+r.w-12,g.mem.x+g.mem.w/2)),false);
      return port(merge?`${r.id}:${side}:${e.type}`:`${r.id}:${side}:#${e.id}`,r,side,along,null,merge);
    };
    g.p0=end(0,g.a,g.sa,g.b);g.p1=end(1,g.b,g.sb,g.a);
  }
  // Spread the ports of each side, ordered by where their lines go.
  const avg=v=>v.reduce((s,x)=>s+x,0)/v.length;
  for(const list of sideList.values()){
    list.sort((p,q)=>avg(p.along)-avg(q.along));
    list.forEach((p,i)=>p.t=list.length<2?.5:.15+.7*(i+.5)/list.length);
  }
  const at=(r,side,t)=>side==='t'?{x:r.x+r.w*t,y:r.y}:side==='b'?{x:r.x+r.w*t,y:r.y+r.h}:side==='l'?{x:r.x,y:r.y+r.h*t}:{x:r.x+r.w,y:r.y+r.h*t};
  for(const p of ports.values()){
    if(p.fixed!=null){p.pos={x:p.fixed,y:p.side==='t'?p.r.y:p.r.y+p.r.h};continue}
    p.pos=at(p.r,p.side,p.t);
  }
  // A shared trunk joins the spine of a stack on the same side, so a stack and its row are one tree.
  for(const p of ports.values())if(p.merge&&p.fixed==null){
    const f=[...ports.values()].find(q=>q.fixed!=null&&q.r===p.r&&q.side===p.side&&q.key.startsWith(p.key+':'));
    if(f)p.pos={...f.pos};
  }
  // A shared trunk with a card right under it (its own stack, say) moves along the side to where it
  // can run down clear.
  for(const p of ports.values())if(p.merge&&p.fixed==null&&p.n>=3&&p.side==='b'){
    const r=p.r,depth=x=>Math.min(Infinity,...solid.filter(q=>q.id!==r.id&&q.y>=r.y+r.h&&x>q.x-M&&x<q.x+q.w+M).map(q=>q.y-(r.y+r.h)));
    const d0=depth(p.pos.x);if(d0>=240)continue;
    let best=p.pos.x,bd=d0;
    for(let d=8;d<r.w/2;d+=8)for(const x of [p.pos.x-d,p.pos.x+d]){if(x<r.x+12||x>r.x+r.w-12)continue;const v=depth(x);if(v>bd&&v>=d0+96&&(bd===d0||v>=240&&bd<240)){best=x;bd=v}}
    p.pos.x=best;
  }
  // A port on top of a card just under an area's title moves out from under the title.
  const titleRs=c.nodes.filter(n=>n.type==='area').map(n=>{const r=rects.get(n.id);return {x:r.x,y:r.y,w:Math.min(r.w,30+String(n.name||'').length*7.6),h:22}});
  for(const p of ports.values())if(p.side==='t'&&p.fixed==null){
    const t=titleRs.find(t=>t.y+t.h<=p.r.y+1&&t.y+t.h>p.r.y-56&&p.pos.x>t.x-8&&p.pos.x<t.x+t.w+8);
    if(t&&t.x+t.w+12<=p.r.x+p.r.w-12&&sideList.get(p.r.id+':t').length===1)p.pos.x=t.x+t.w+12;
  }
  // Lines off one spine into cards on both sides at the same height enter a little apart, so they
  // don't read as one line from card to card.
  const ins=new Map();
  for(const g of gs)if(g.fix){const p=g.fix.end?g.p0:g.p1;if(p.n!==1||sideList.get(p.r.id+':'+p.side)?.length!==1)continue;const k=Math.round(g.fix.x)+':'+Math.round(p.pos.y);if(!ins.has(k))ins.set(k,[]);ins.get(k).push(p)}
  for(const list of ins.values())if(new Set(list.map(p=>p.side)).size>1)for(const p of list)p.pos.y+=p.side==='l'?-14:14;
  // A lone port facing a card it overlaps moves level with the other end, so the line runs straight.
  for(const g of gs){
    if(g.fix||!((g.sa==='b'&&g.sb==='t')||(g.sa==='t'&&g.sb==='b')||(g.sa==='r'&&g.sb==='l')||(g.sa==='l'&&g.sb==='r')))continue;
    const v='tb'.includes(g.sa),k=v?'x':'y',span=(r)=>v?[r.x+12,r.x+r.w-12]:[r.y+12,r.y+r.h-12];
    const alone=p=>sideList.get(p.r.id+':'+p.side)?.length===1&&(p.n===1||gs.every(h=>(h.p0!==p&&h.p1!==p)||(h.p0===p?h.p1:h.p0)===(p===g.p0?g.p1:g.p0)));
    const [lo1,hi1]=span(g.b),[lo0,hi0]=span(g.a);
    const titled=p=>p.side==='t'&&titleRs.some(t=>t.y+t.h<=p.r.y+1&&t.y+t.h>p.r.y-56&&g.p0.pos.x>t.x-8&&g.p0.pos.x<t.x+t.w+8);
    if(alone(g.p1)&&g.p0.pos[k]>=lo1&&g.p0.pos[k]<=hi1&&!titled(g.p1))g.p1.pos[k]=g.p0.pos[k];
    else if(alone(g.p0)&&g.p1.pos[k]>=lo0&&g.p1.pos[k]<=hi0)g.p0.pos[k]=g.p1.pos[k];
  }
  // Is the segment p→q (axis aligned) clear of every card? A line's own cards only stop it where it
  // is not attached to them (and then only their inside).
  const clear=(e,p,q,i,last,m=M)=>{
    const xa=Math.min(p.x,q.x),xb=Math.max(p.x,q.x),ya=Math.min(p.y,q.y),yb=Math.max(p.y,q.y);
    for(const r of solid){
      let mm=m;
      if(r.id===e.from||r.id===e.to){if((r.id===e.from&&i===0)||(r.id===e.to&&i===last))continue;mm=-1}
      if(xb>r.x-mm&&xa<r.x+r.w+mm&&yb>r.y-mm&&ya<r.y+r.h+mm)return false;
    }
    return true;
  };
  const clearAll=(e,pts)=>{for(let i=0;i+1<pts.length;i++)if(!clear(e,pts[i],pts[i+1],i,pts.length-2))return false;return true};
  const busY=new Map();
  // Simple shapes in the frame where the line leaves downwards. P,Q: ends; sq: Q's side in the frame.
  const simple=(g,s,P,Q,sq,cards)=>{
    const e=g.e,ids=[e.from,e.to],ob=cards.filter(r=>!ids.includes(r.id));
    if(sq==='t'){
      if(Q.y-P.y<2*STUB)return null;
      if(Math.abs(P.x-Q.x)<.5)return [[[P,Q]]];
      const xa=Math.min(P.x,Q.x)-M,xb=Math.max(P.x,Q.x)+M,lo=P.y+STUB,hi=Q.y-STUB;
      const bl=ob.filter(r=>r.x<xb&&r.x+r.w>xa&&r.y-M<hi&&r.y+r.h+M>lo).map(r=>[r.y-M,r.y+r.h+M]).sort((p,q)=>p[0]-q[0]);
      const free=[];let y=lo;
      for(const [a,b] of bl){if(a>y)free.push([y,a]);y=Math.max(y,b)}
      if(y<=hi)free.push([y,hi]);
      // The band nearest the card it points to first; in the open, the middle of the gap.
      const cands=[];const key=(g.p1.merge&&g.p1.n>1&&!(g.p0.n>1)?g.p1.key:g.p0.key)+'|'+s+'|'+Math.round(Q.y);
      if(busY.has(key))cands.push(busY.get(key));
      // (a long drop keeps its bus close above the row it feeds).
      free.reverse().forEach(([a,b],i)=>cands.push(Math.round(i===0&&b===hi?Math.max((a+b)/2,hi-42):(a+b)/2)));
      // A bus that would run along an area's top or bottom moves clear of it.
      const xl=Math.min(P.x,Q.x),xr=Math.max(P.x,Q.x),as=aframed(s).filter(r=>r.x<xr&&r.x+r.w>xl);
      const soft=ym=>{for(const r of as)for(const [b,t0,t1] of [[r.y,-14,32],[r.y+r.h,-14,14]])if(ym>b+t0&&ym<b+t1){const u=b+t0-4,d=b+t1+4;return u>=lo&&(u-lo>=hi-d||d>hi)?u:d<=hi?d:ym}return ym};
      return cands.map(soft).filter(ym=>ym>=lo&&ym<=hi).map(ym=>[[P,{x:P.x,y:ym},{x:Q.x,y:ym},Q],key,ym]);
    }
    if(sq==='b'){
      const xa=Math.min(P.x,Q.x)-M,xb=Math.max(P.x,Q.x)+M;let ym=Math.max(P.y,Q.y)+STUB*2;
      const bl=ob.filter(r=>r.x<xb&&r.x+r.w>xa&&r.y+r.h+M>ym).sort((p,q)=>p.y-q.y);
      for(const r of bl)if(r.y-M<ym)ym=r.y+r.h+M+STUB;
      return [[[P,{x:P.x,y:ym},{x:Q.x,y:ym},Q]]];
    }
    // Into a side: down, then across into it.
    const dir=sq==='l'?1:-1;
    if(Q.y-P.y<STUB||(Q.x-P.x)*dir<STUB)return null;
    return [[[P,{x:P.x,y:Q.y},Q]]];
  };
  // Spines first, then the shortest lines: a fan's bus is set by its nearest row of cards.
  const span=g=>Math.abs(g.p0.pos.y-g.p1.pos.y)+Math.abs(g.p0.pos.x-g.p1.pos.x)/4;
  const order=[...gs].sort((p,q)=>(p.fix?0:1)-(q.fix?0:1)||span(p)-span(q));
  for(const g of order){
    const e=g.e,P=g.p0.pos,Q=g.p1.pos,n0=NORMAL[g.sa],n1=NORMAL[g.sb];
    let pts=null;
    const [f,un]=TF[g.sa],sq=tfSide(f,g.sb),[px,py]=f(P.x,P.y),[qx,qy]=f(Q.x,Q.y);
    const tries=simple(g,g.sa,{x:px,y:py},{x:qx,y:qy},sq,framed(g.sa))||[];
    // A bus never runs along under an area's title (it reads as part of the box).
    const underTitle=pts=>{for(let i=1;i+2<pts.length;i++){const A=pts[i],B=pts[i+1];if(Math.abs(A.y-B.y)<.5&&titleRs.some(t=>A.y>t.y-6&&A.y<t.y+t.h+10&&Math.max(A.x,B.x)>t.x&&Math.min(A.x,B.x)<t.x+t.w))return true}return false};
    for(const [cand,key,ym] of tries){
      const back=cand.map(p=>{const [x,y]=un(p.x,p.y);return {x,y}});
      if(clearAll(e,back)&&!underTitle(back)){pts=back;if(key&&!busY.has(key))busY.set(key,ym);break}
    }
    if(!pts){
      const S={x:P.x+n0[0]*STUB,y:P.y+n0[1]*STUB},T={x:Q.x+n1[0]*STUB,y:Q.y+n1[1]*STUB};
      const ds=dirOf(n0[0],n0[1]),dt=dirOf(-n1[0],-n1[1]);
      let r=gridRoute(S,T,ds,dt,solid,160,areaRs,ctl);if(r===null)r=gridRoute(S,T,ds,dt,solid,640,areaRs,ctl);
      if(r)pts=[P,...r,Q];
      // Out of time: a simple elbow for now (the next full render routes it).
      else if(r===undefined)pts=[P,S,{x:S.x,y:T.y},T,Q];
      else{
        // Boxed in (a card right against the port): the cheapest way out of any side into any side.
        let best=null;
        const faces=(r,o,sd)=>{const [nx,ny]=NORMAL[sd];return nx*(o.x+o.w/2-r.x-r.w/2)+ny*(o.y+o.h/2-r.y-r.h/2)>=0};
        for(const pass of [0,1])for(const s0 of 'btlr')for(const s1 of 'btlr'){
          if(best&&pass)break;
          if((faces(g.a,g.b,s0)&&faces(g.b,g.a,s1))===!!pass)continue;
          const A=at(g.a,s0,.5),B=at(g.b,s1,.5),m0=NORMAL[s0],m1=NORMAL[s1];
          const S2={x:A.x+m0[0]*STUB,y:A.y+m0[1]*STUB},T2={x:B.x+m1[0]*STUB,y:B.y+m1[1]*STUB};
          const shut=p=>solid.some(r=>p.x>r.x-M&&p.x<r.x+r.w+M&&p.y>r.y-M&&p.y<r.y+r.h+M);
          if(shut(S2)||shut(T2))continue;
          const q=gridRoute(S2,T2,dirOf(m0[0],m0[1]),dirOf(-m1[0],-m1[1]),solid,320,areaRs,ctl);
          if(q&&(!best||q.cost<best.cost))best={cost:q.cost,pts:[A,...q,B]};
        }
        pts=best?best.pts:[P,S,{x:S.x,y:T.y},T,Q];
      }
    }
    g.pts=simplify(pts);
  }
  // A lone line into a card that would come in right beside another line slides along the card's
  // side, clear of it.
  const keyOf=g=>g.p0.merge&&(g.p0.n>1||!(g.p1.merge&&g.p1.n>1))?g.p0.key:g.p1.merge&&g.p1.n>1?g.p1.key:g.e.id;
  const KEYS=new Map(gs.map(g=>[g,keyOf(g)])),SEGS=new Map(gs.map(g=>[g,segsOf(g.pts)]));
  for(const g of gs){
    const n=g.pts.length,A=g.pts[n-2],B=g.pts[n-1],v=Math.abs(A.x-B.x)<.5;
    if(n<3||g.p1.n!==1||g.p1.fixed!=null||sideList.get(g.p1.r.id+':'+g.p1.side)?.length!==1)continue;
    const k=v?'x':'y',lo=Math.min(A[v?'y':'x'],B[v?'y':'x']),hi=Math.max(A[v?'y':'x'],B[v?'y':'x']),me=KEYS.get(g);
    const near=c=>gs.some(h=>h!==g&&KEYS.get(h)!==me&&SEGS.get(h).some(([p,q])=>Math.abs(p[k]-q[k])<.5&&Math.abs(p[k]-c)<LANE&&Math.min(hi,Math.max(p[v?'y':'x'],q[v?'y':'x']))-Math.max(lo,Math.min(p[v?'y':'x'],q[v?'y':'x']))>-4));
    if(!near(B[k]))continue;
    const r=g.p1.r,[s0,s1]=v?[r.x+12,r.x+r.w-12]:[r.y+12,r.y+r.h-12];
    for(const d of [LANE,-LANE,2*LANE,-2*LANE,3*LANE,-3*LANE]){
      const c2=B[k]+d;if(c2<s0||c2>s1||near(c2))continue;
      const p=g.pts.map(q=>({...q}));p[n-1][k]=c2;p[n-2][k]=c2;
      const C=p[n-3];if(Math.abs(C[k]-p[n-2][k])<1&&n>3)continue;
      if(clearAll(g.e,p)){g.pts=simplify(p);SEGS.set(g,segsOf(g.pts));break}
    }
  }
  // ---- lanes ----
  // Middle segments (not the ends) of different trunks that would share a line move apart.
  const segs=new Map(),byKey=new Map();
  for(const g of gs){
    const key=g.p0.merge&&(g.p0.n>1||!(g.p1.merge&&g.p1.n>1))?g.p0.key:g.p1.merge&&g.p1.n>1?g.p1.key:g.e.id;
    for(let i=1;i+2<g.pts.length;i++){
      let A=g.pts[i],B=g.pts[i+1];const h=Math.abs(A.y-B.y)<.5;
      // One trunk's lines a few pixels apart become one line.
      const near=(byKey.get(key)||[]).find(o=>o.h===h&&Math.abs(o.c-(h?A.y:A.x))<12&&Math.abs(o.c-(h?A.y:A.x))>.5);
      if(near){
        const k2=h?'y':'x',p=g.pts.map(q=>({...q}));p[i][k2]=near.c;p[i+1][k2]=near.c;
        if(clearAll(g.e,p)&&Math.abs(p[i][k2]-p[i-1][k2])>=4&&Math.abs(p[i+2][k2]-p[i+1][k2])>=4){g.pts=p;A=p[i];B=p[i+1]}
      }
      const c=h?A.y:A.x,k=key+'|'+(h?'h':'v')+'|'+Math.round(c);
      const s=segs.get(k)||{key,h,c,lo:Infinity,hi:-Infinity,mem:[],grp:g.e.type==='group'};
      s.lo=Math.min(s.lo,h?A.x:A.y,h?B.x:B.y);s.hi=Math.max(s.hi,h?A.x:A.y,h?B.x:B.y);s.mem.push([g,i]);if(!segs.has(k)){segs.set(k,s);if(!byKey.has(key))byKey.set(key,[]);byKey.get(key).push(s)}
    }
  }
  // The ends of every line stay put but count as taken; trunks too close to another's line
  // (alongside it, or running on from where it stops) move over a lane.
  const placed=[];
  for(const g of gs){
    const key=g.p0.merge&&(g.p0.n>1||!(g.p1.merge&&g.p1.n>1))?g.p0.key:g.p1.merge&&g.p1.n>1?g.p1.key:g.e.id;
    for(const i of [0,g.pts.length-2]){const A=g.pts[i],B=g.pts[i+1],h=Math.abs(A.y-B.y)<.5;placed.push({key,grp:g.e.type==='group',h,c:h?A.y:A.x,lo:Math.min(h?A.x:A.y,h?B.x:B.y),hi:Math.max(h?A.x:A.y,h?B.x:B.y)})}
  }
  for(const [j,r] of areaRs.entries())placed.push({key:'#',area:true,h:true,c:r.y,band:[r.y-12,r.y+30],lo:r.x,hi:r.x+areaTitleW[j]},{key:'#',area:true,h:true,c:r.y,lo:r.x,hi:r.x+r.w},{key:'#',area:true,h:true,c:r.y+r.h,lo:r.x,hi:r.x+r.w},{key:'#',area:true,h:false,c:r.x,lo:r.y,hi:r.y+r.h},{key:'#',area:true,h:false,c:r.x+r.w,lo:r.y,hi:r.y+r.h});
  const placedH=placed.filter(o=>o.h),placedV=placed.filter(o=>!o.h);
  for(const s of [...segs.values()].sort((p,q)=>(q.hi-q.lo)-(p.hi-p.lo))){
    // Lines in line with each other read as one for a long way; area borders only close by.
    const pl=s.h?placedH:placedV;
    const hit=(c,tight)=>pl.some(o=>o.key!==s.key&&(o.band?c>o.band[0]&&c<o.band[1]:Math.abs(o.c-c)<(o.area?12:tight?10:o.grp!==s.grp?LANE*1.6:LANE))&&Math.min(o.hi,s.hi)-Math.max(o.lo,s.lo)>(o.area?0:-(Math.abs(o.c-c)<4?160:LANE)));
    let off=0;
    if(hit(s.c)){
      off=null;
      // Nearest free lane first, but out in the open before one inside an area it would cross.
      const inArea=c=>areaRs.some(r=>(s.h?c>r.y&&c<r.y+r.h&&s.lo<r.x+r.w&&s.hi>r.x:c>r.x&&c<r.x+r.w&&s.lo<r.y+r.h&&s.hi>r.y));
      // No lane at full spacing (a crowded gap): closer lanes still beat running on top of another.
      const wide=[...Array(10).keys()].flatMap(i=>[LANE+i*6,-(LANE+i*6)]).map(d=>[d,false]),tight=[10,-10,20,-20,30,-30,40,-40].map(d=>[d,true]);
      const out=([d])=>!inArea(s.c+d)||inArea(s.c);
      const ds=[...wide.filter(out),...tight.filter(out),...wide.filter(p=>!out(p)),...tight.filter(p=>!out(p))];
      for(const [d,tight] of ds){
        if(hit(s.c+d,tight))continue;
        const ok=s.mem.every(([g,i])=>{
          const p=g.pts.map(q=>({...q})),k=s.h?'y':'x';
          p[i][k]+=d;p[i+1][k]+=d;
          const before=g.pts[i-1][k],after=g.pts[i+2][k],m0=i-1===0?STUB:4,m1=i+2===p.length-1?STUB+4:4;
          if(Math.sign(p[i][k]-before)!==Math.sign(g.pts[i][k]-before)||Math.abs(p[i][k]-before)<m0)return false;
          if(Math.sign(after-p[i+1][k])!==Math.sign(after-g.pts[i+1][k])||Math.abs(after-p[i+1][k])<m1)return false;
          return clear(g.e,p[i-1],p[i],i-1,p.length-2,4)&&clear(g.e,p[i],p[i+1],i,p.length-2,4)&&clear(g.e,p[i+1],p[i+2],i+1,p.length-2,4);
        });
        if(ok){off=d;break}
      }
      if(off===null)off=0;
      if(off)for(const [g,i] of s.mem){const k=s.h?'y':'x';g.pts[i]={...g.pts[i],[k]:g.pts[i][k]+off};g.pts[i+1]={...g.pts[i+1],[k]:g.pts[i+1][k]+off}}
    }
    (s.h?placedH:placedV).push({...s,c:s.c+off});
  }
  // ---- labels ----
  // Just before the arrow, on the line or beside it, clear of cards, area titles, other labels and
  // other lines; failing that, further back along the last segment, then the segments before it.
  const titles=c.nodes.filter(n=>n.type==='area').map(n=>{const r=rects.get(n.id);return {x:r.x,y:r.y,w:Math.min(r.w,30+String(n.name||'').length*7.6),h:22}});
  const boxes=[],lines=gs.map(g=>segsOf(g.pts));
  const meets=(b,o)=>b.x<o.x+o.w+2&&b.x+b.w>o.x-2&&b.y<o.y+o.h+2&&b.y+b.h>o.y-2;
  // Every segment as [x0,y0,x1,y1,line] in one flat array (this runs for every label candidate).
  const SB=[];lines.forEach((ls,j)=>{for(const [p,q] of ls)SB.push(Math.min(p.x,q.x),Math.min(p.y,q.y),Math.max(p.x,q.x),Math.max(p.y,q.y),j)});
  const crosses=(b,gi)=>{const x0=b.x-1,y0=b.y-1,x1=b.x+b.w+1,y1=b.y+b.h+1;for(let i=0;i<SB.length;i+=5)if(SB[i+4]!==gi&&SB[i+2]>x0&&SB[i]<x1&&SB[i+3]>y0&&SB[i+1]<y1)return true;return false};
  const lab=g=>g.e.type==='group'?null:(g.e.percent===''?'?':`${g.e.percent}%`);
  const idx=new Map(gs.map((g,i)=>[g,i]));
  for(const g of [...gs].sort((p,q)=>p.pts.at(-1).x-q.pts.at(-1).x||p.pts.at(-1).y-q.pts.at(-1).y)){
    const pts=g.pts,text=lab(g);
    let best=null;
    if(text){
      const w=text.length*6+10,h=16,cands=[];
      for(let s=pts.length-2,k=0;s>=0&&k<3;s--,k++){
        const A=pts[s+1],B=pts[s],len=Math.abs(A.x-B.x)+Math.abs(A.y-B.y),ux=Math.sign(B.x-A.x),uy=Math.sign(B.y-A.y);
        const half=ux?w/2:h/2,start=(k===0?(ux?16:10):RADIUS)+half+2,end=len-(s===0?STUB:RADIUS)-half;
        for(let d=start;d<=Math.max(start,end);d+=8){cands.push({x:A.x+ux*d,y:A.y+uy*d,k,near:d<=start+16});if(d>end)break}
        if(k===0&&ux)cands.push({x:A.x+ux*start,y:A.y-h/2-3,k,near:true},{x:A.x+ux*start,y:A.y+h/2+3,k,near:true});
        if(k===0&&uy)cands.push({x:A.x+w/2+3,y:A.y+uy*start,k,near:true},{x:A.x-w/2-3,y:A.y+uy*start,k,near:true});
      }
      const box=p=>({x:p.x-w/2,y:p.y-h/2,w,h}),gi=idx.get(g);
      const ok=(p,strict)=>{const b=box(p);return !solid.some(r=>meets(b,r))&&!boxes.some(o=>meets(b,o))&&(!strict||(!titles.some(o=>meets(b,o))&&!crosses(b,gi)))};
      best=cands.find(p=>p.near&&ok(p,true))||cands.find(p=>p.k===0&&ok(p,true))||cands.find(p=>p.k===0&&ok(p,false))||cands.find(p=>ok(p,true))||cands[0]||pts.at(-1);
      boxes.push(box(best));
    }else{
      // Middle of the longest segment (used for hover tips).
      let li=0,ll=-1;for(let i=0;i+1<pts.length;i++){const l=Math.abs(pts[i].x-pts[i+1].x)+Math.abs(pts[i].y-pts[i+1].y);if(l>ll){ll=l;li=i}}
      best={x:(pts[li].x+pts[li+1].x)/2,y:(pts[li].y+pts[li+1].y)/2};
    }
    out.set(g.e.id,{d:pathD(pts),mx:best.x,my:best.y,pts});
  }
  return out;
}
