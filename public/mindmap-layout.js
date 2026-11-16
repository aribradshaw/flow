// Tidy up for the mind map: a layered layout (owners above what they own) that keeps lines short
// and few crossings, keeps every project area's cards together and resizes the area around them.
// Pure: takes the chart and a card size function, returns Map id -> {x,y[,w,h]} (w/h for areas).
//
// 1. Rows. Ownership points down. A grouping line (no direction of its own) only places a card
//    when one end is a loose card that owns nothing (it hangs under the other end) or both ends
//    are top-level (drawn direction). Cards that only own things sit just above their highest
//    child, so a co-owner stays next to what it co-owns instead of up beside the chart's root.
// 2. Order. Lines spanning several rows get a placeholder in each row between, then rows are
//    reordered by the average position of their neighbours (sweeping down and up) and the order
//    with the fewest crossings wins. A project area is one block per row it spans.
// 3. Position. Each row is placed as close as possible to its neighbours (least squares, keeping
//    order and spacing); an area keeps one x across all its rows. A line that skips rows gets a
//    lane in each row it crosses, as wide as its curve's sweep there, so it never cuts a card.
// edgeGeometry (below) draws the lines for the canvas, tidied or not.
const HGAP=32,VGAP=96,DUMMY=16,PAD={x:24,top:40,bottom:24},GRID=16;
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

export function tidyLayout(chart,size){
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
  const base=Math.min(...graphCards.map(n=>layer.get(n.id)));for(const n of graphCards)layer.set(n.id,layer.get(n.id)-base);
  const depth=graphCards.length?Math.max(...graphCards.map(n=>layer.get(n.id)))+1:0;

  // ---- 2. order ----
  // Items: cards, placeholders for long lines, and per area one block per row ('A:<area>:<row>').
  // An area's rows run from its first card's row to its last; links between consecutive rows
  // (both ends) are what ordering and placement pull on.
  const item=new Map(); // id -> {id,kind,w,layer,area,card}
  const rows=Array.from({length:depth},()=>[]);
  const add=it=>{item.set(it.id,it);rows[it.layer].push(it.id);return it};
  for(const n of graphCards)add({id:n.id,kind:'card',w:size(n)[0],layer:layer.get(n.id),area:areaOf.get(n.id)||null,x0:n.x});
  const links=[]; // [upper item, lower item, line id]
  const lines=[]; // long lines: [chain of item ids]
  for(const [a,b] of keep){
    const la=layer.get(a),lb=layer.get(b);
    const [u,v]=la<=lb?[a,b]:[b,a];const lu=Math.min(la,lb),lv=Math.max(la,lb);
    if(lu===lv)continue; // same row: drawn side to side, nothing to order
    const chain=[u];
    const shared=areaOf.get(u)&&areaOf.get(u)===areaOf.get(v)?areaOf.get(u):null;
    for(let l=lu+1;l<lv;l++)chain.push(add({id:`D:${u}:${v}:${l}`,kind:'dummy',w:DUMMY,layer:l,area:shared,x0:(xOf(u)+xOf(v))/2}).id);
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
      const tie=id=>bary(id,other)??p.get(id);
      // Inner rows first, then blocks by the average of their cards.
      const avg=new Map();
      for(const [a,rs] of inner){
        const r=rs[l];if(!r.length)continue;
        const b=new Map(r.map(id=>[id,bary(id)]));
        sortBy(r,id=>b.get(id),tie);
        const known=r.map(id=>b.get(id)).filter(v=>v!==null);
        if(known.length)avg.set(`A:${a}:${l}`,known.reduce((s,v)=>s+v,0)/known.length);
      }
      sortBy(outer[l],u=>u.startsWith('A:')?(avg.has(u)?avg.get(u):null):bary(u),u=>u.startsWith('A:')?p.get(u):tie(u));
    }
    const c=total();if(c<bestC){bestC=c;best=snapshotOrder()}
  }
  outer.splice(0,outer.length,...best.outer);for(const [a,rs] of best.inner)inner.set(a,rs);

  // ---- 3. position ----
  // Row heights and tops (they do not depend on x).
  const rowH=rows.map(r=>Math.max(0,...r.map(id=>item.get(id).kind==='card'?size(byId.get(id))[1]:0)));
  const ys=[];let y=0;
  for(let l=0;l<depth;l++){
    // Leave room for an area's title above its first row and its padding below its last.
    const opens=[...clusters.values()].some(c=>c.lo===l),closes=l>0&&[...clusters.values()].some(c=>c.hi===l-1);
    if(l)y+=VGAP+(opens&&closes?PAD.top+PAD.bottom-VGAP/2:0);
    ys.push(y);y+=rowH[l];
  }
  // A line that skips rows is drawn as one curve (edgeGeometry). Its placeholder in each row it
  // crosses is centred on where that curve passes the row and as wide as the curve's sweep there,
  // so the lane between the row's cards really holds the line.
  const sweep=(xa,xb,lu,lv,l)=>{
    const y0=ys[lu]+rowH[lu],y3=ys[lv],k=Math.max(20,Math.min(120,(y3-y0)/2,Math.hypot(xb-xa,y3-y0)/2.5));
    const top=ys[l]-16,bot=ys[l]+rowH[l]+16;let lo=Infinity,hi=-Infinity;
    for(let i=0;i<=64;i++){const t=i/64,u=1-t,y=u*u*u*y0+3*u*u*t*(y0+k)+3*u*t*t*(y3-k)+t*t*t*y3;
      if(y<top||y>bot)continue;const x=u*u*u*xa+3*u*u*t*xa+3*u*t*t*xb+t*t*t*xb;lo=Math.min(lo,x);hi=Math.max(hi,x)}
    return lo<=hi?{c:(lo+hi)/2,w:hi-lo}:{c:(xa+xb)/2,w:0};
  };
  function position(){
    const X=new Map(); // item -> left (cards in areas: offset inside the area until the end)
    const center=id=>X.get(id)+item.get(id).w/2;
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
          const xs=placeRow(r.map(id=>{const ns=[...innerN(id).up,...innerN(id).down];return {w:item.get(id).w,want:ns.length?ns.reduce((s,n)=>s+center(n),0)/ns.length-item.get(id).w/2:X.get(id),weight:ns.length?1:.1}}));
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
    const at=id=>{const it=item.get(id);return it.area?box.get(it.area).x+X.get(id)+it.w/2:left.get(id)+it.w/2};
    // Where a long line's placeholder wants to be: where its curve crosses the row.
    const straight=new Map();
    const wantOf=(u,l,side)=>{
      // The centre an outer unit would like, from its neighbours on one or both sides.
      const ids=u.startsWith('A:')?inner.get(u.split(':')[1])[l]:[u];
      let sum=0,n=0;
      for(const id of ids){
        if(straight.has(id)){sum+=straight.get(id)-(u.startsWith('A:')?X.get(id)+item.get(id).w/2:0);n++;continue}
        const ns=side?nbr.get(id)[side]:[...nbr.get(id).up,...nbr.get(id).down];
        for(const m of ns){sum+=at(m)-(u.startsWith('A:')?X.get(id)+item.get(id).w/2:0);n++}
      }
      return n?{c:sum/n,n}:null;
    };
    const solveRow=(l,side,areaWeight)=>{
      const r=outer[l];
      const xs=placeRow(r.map(u=>{
        const w=W(u),wt=wantOf(u,l,side);
        if(u.startsWith('A:')){const b=box.get(u.split(':')[1]);const want=wt?(wt.c*wt.n+b.x*areaWeight)/(wt.n+areaWeight):b.x;return {w,want,weight:(wt?wt.n:0)+areaWeight}}
        // A line's placeholder holds firm (cards make way for the line, not the other way round).
      return {w,want:wt?wt.c-w/2:left.get(u),weight:wt?wt.n*(item.get(u).kind==='dummy'?4:1):.05};
      }));
      r.forEach((u,i)=>left.set(u,xs[i]));
      for(const u of r)if(u.startsWith('A:')){const a=u.split(':')[1],c=clusters.get(a),n=c.hi-c.lo+1;box.get(a).x+=(left.get(u)-box.get(a).x)/n}
    };
    for(let it=0;it<18;it++){
      straight.clear();
      for(const ch of lines){const a=at(ch[0]),b=at(ch.at(-1)),lu=item.get(ch[0]).layer,lv=item.get(ch.at(-1)).layer;ch.forEach((id,i)=>{if(i&&i<ch.length-1)straight.set(id,sweep(a,b,lu,lv,item.get(id).layer).c)})}
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
    return {X,box,left,at};
  }
  let P=position();
  // Widen each placeholder to its curve's sweep and place again (twice settles it).
  for(let pass=0;pass<2&&lines.length;pass++){
    for(const ch of lines){const a=P.at(ch[0]),b=P.at(ch.at(-1)),lu=item.get(ch[0]).layer,lv=item.get(ch.at(-1)).layer;
      ch.forEach((id,i)=>{if(i&&i<ch.length-1)item.get(id).w=Math.max(DUMMY,sweep(a,b,lu,lv,item.get(id).layer).w+DUMMY*2)})}
    P=position();
  }
  const {X,box,left}=P;
  const res=new Map();
  for(const it of item.values())if(it.kind==='card'){
    const h=size(byId.get(it.id))[1];
    res.set(it.id,{x:it.area?box.get(it.area).x+X.get(it.id):left.get(it.id),y:ys[it.layer]+(rowH[it.layer]-h)/2});
  }
  for(const [a,b] of box){
    const c=clusters.get(a);
    res.set(a,{x:b.x,y:ys[c.lo]-PAD.top,w:b.w,h:ys[c.hi]+rowH[c.hi]+PAD.bottom-(ys[c.lo]-PAD.top)});
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
// Each edge attaches to the facing sides of its two cards. Edges sharing a side are spread
// along it (ordered by where the other card sits) so busy cards don't collect a knot of lines.
const NORMAL={t:[0,-1],b:[0,1],l:[-1,0],r:[1,0]},ROW_GAP=32;
// A card clearly above or below the other (a row apart) joins top to bottom however far across it
// sits, so lines between rows never cut sideways through the cards of a row.
function sides(a,b){
  const dx=b.x+b.w/2-a.x-a.w/2,dy=b.y+b.h/2-a.y-a.h/2;
  if(b.y-(a.y+a.h)>=ROW_GAP)return ['b','t'];
  if(a.y-(b.y+b.h)>=ROW_GAP)return ['t','b'];
  return Math.abs(dy)-(a.h+b.h)/2>=Math.abs(dx)-(a.w+b.w)/2?(dy>=0?['b','t']:['t','b']):(dx>=0?['r','l']:['l','r']);
}
export function edgeGeometry(c,rect){
  const rects=new Map(c.nodes.map(n=>[n.id,rect(n)])),slots=new Map(),out=new Map();
  const solid=c.nodes.filter(n=>n.type!=='area').map(n=>[n.id,rects.get(n.id)]);
  // Side by side with another card in between: the line dips under the row instead of through it.
  const blocked=(e,a,b)=>{
    const [l,r]=a.x<b.x?[a,b]:[b,a],x0=l.x+l.w,x1=r.x,y0=Math.min(l.y+l.h/2,r.y+r.h/2)-4,y1=Math.max(l.y+l.h/2,r.y+r.h/2)+4;
    return solid.some(([id,q])=>id!==e.from&&id!==e.to&&q.x<x1&&q.x+q.w>x0&&q.y<y1&&q.y+q.h>y0);
  };
  for(const e of c.edges){
    const a=rects.get(e.from),b=rects.get(e.to);if(!a||!b)continue;
    let [sa,sb]=sides(a,b);
    if('lr'.includes(sa)&&blocked(e,a,b))sa=sb='b';
    for(const [id,side,other] of [[e.from,sa,b],[e.to,sb,a]]){
      const key=id+':'+side,along='tb'.includes(side)?other.x+other.w/2:other.y+other.h/2;
      if(!slots.has(key))slots.set(key,[]);slots.get(key).push({e:e.id,end:id===e.from?0:1,along});
    }
    out.set(e.id,{a,b,sa,sb,t:[.5,.5]});
  }
  for(const list of slots.values()){
    if(list.length<2)continue;
    list.sort((p,q)=>p.along-q.along);
    list.forEach((p,i)=>out.get(p.e).t[p.end]=.15+.7*(i+.5)/list.length);
  }
  for(const [id,g] of out){
    const pt=(r,side,t)=>side==='t'?{x:r.x+r.w*t,y:r.y}:side==='b'?{x:r.x+r.w*t,y:r.y+r.h}:side==='l'?{x:r.x,y:r.y+r.h*t}:{x:r.x+r.w,y:r.y+r.h*t};
    const p0=pt(g.a,g.sa,g.t[0]),p3=pt(g.b,g.sb,g.t[1]),n0=NORMAL[g.sa],n3=NORMAL[g.sb];
    // Handles reach half way across the gap the line crosses (no further), so it never overshoots.
    const across='tb'.includes(g.sa)?Math.abs(p3.y-p0.y):Math.abs(p3.x-p0.x);
    // A dip under the row goes deep enough to clear the cards it passes (they sit level with the ends).
    const k=g.sa===g.sb?Math.max(48,Math.min(72,Math.abs(p3.x-p0.x)/6)):Math.max(20,Math.min(120,across/2,Math.hypot(p3.x-p0.x,p3.y-p0.y)/2.5));
    const p1={x:p0.x+n0[0]*k,y:p0.y+n0[1]*k},p2={x:p3.x+n3[0]*k,y:p3.y+n3[1]*k};
    // The label sits on the curve: a line between rows has it near the card it points to (the
    // % belongs to that card, and labels of a fan don't line up in one crowded row); others mid-way.
    const t='tb'.includes(g.sa)&&g.sa!==g.sb?.7:.5,u=1-t,bz=(a,b,c,d)=>u*u*u*a+3*u*u*t*b+3*u*t*t*c+t*t*t*d;
    out.set(id,{d:`M${p0.x} ${p0.y}C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`,mx:bz(p0.x,p1.x,p2.x,p3.x),my:bz(p0.y,p1.y,p2.y,p3.y)});
  }
  return out;
}
