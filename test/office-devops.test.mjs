// The 3D office's main board is the DevOps tab's own #devopsView (docs/concepts/12-office.md): lent to the office
// and given back where it was (view-loan.js), and sized and faced so a focused board is 1:1 (office-devops-core.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLoan} from '../public/view-loan.js';
import {boardFit,focusPose,stepBlend,ease,FOCUS_INSET,FOCUS_MIN_ASPECT,FOCUS_MIN_WIDTH} from '../public/office-devops-core.js';

// Just enough DOM for the loan: element and comment nodes, insertBefore / removeChild, and scroll offsets that a
// move resets (as a browser drops a moved box's scroll position).
class FakeNode{
  constructor(doc,name,cls=''){this.ownerDocument=doc;this.name=name;this.cls=cls;this.childNodes=[];this.parentNode=null;this.scrollLeft=0;this.scrollTop=0}
  get nextSibling(){const p=this.parentNode;return p?p.childNodes[p.childNodes.indexOf(this)+1]||null:null}
  get lastChild(){return this.childNodes.at(-1)||null}
  insertBefore(node,ref){
    if(node===ref)return node;
    node.parentNode?.removeChild(node);
    const i=ref?this.childNodes.indexOf(ref):this.childNodes.length;
    if(i<0)throw Error('the reference node is not a child');
    this.childNodes.splice(i,0,node);node.parentNode=this;
    for(const x of [node,...node.querySelectorAll('*')]){x.scrollLeft=0;x.scrollTop=0}
    return node;
  }
  appendChild(node){return this.insertBefore(node,null)}
  removeChild(node){const i=this.childNodes.indexOf(node);if(i<0)throw Error('not a child');this.childNodes.splice(i,1);node.parentNode=null;return node}
  querySelectorAll(sel){
    const want=sel.split(',').map(s=>s.trim()),out=[];
    const walk=n=>{for(const c of n.childNodes){if(sel==='*'||want.includes('.'+c.cls))out.push(c);walk(c)}};
    walk(this);return out;
  }
}
function page(){
  const doc={createComment:text=>new FakeNode(doc,'#comment:'+text)};
  const el=name=>new FakeNode(doc,name);
  const main=el('main'),before=el('chart'),view=el('devopsView'),after=el('agentflow'),host=el('office');
  view.id='devopsView';
  const scroller=new FakeNode(doc,'scroll','dv-scroll');view.appendChild(scroller);
  main.appendChild(before);main.appendChild(view);main.appendChild(after);
  return {doc,main,before,view,after,host,scroller,names:n=>n.childNodes.map(c=>c.name)};
}

test('lending a view moves the same element into the host and leaves a placeholder in its place',()=>{
  const {main,view,host,names}=page();
  const loan=createLoan(view);
  assert.equal(loan.lent(),false);
  loan.lend(host);
  assert.equal(view.parentNode,host);
  assert.deepEqual(names(main),['chart','#comment:lent: devopsView','agentflow']);
  assert.equal(loan.lent(),true);
  // Lending again stays lent; nothing new is left behind.
  host.appendChild(new FakeNode(view.ownerDocument,'other'));
  loan.lend(host);
  assert.deepEqual(names(host),['other','devopsView']);
  assert.deepEqual(names(main),['chart','#comment:lent: devopsView','agentflow']);
});

test('giving it back restores the exact position, once, and is a no-op after',()=>{
  const {main,view,host,names}=page();
  const loan=createLoan(view);
  loan.lend(host);
  assert.equal(loan.giveBack(),true);
  assert.deepEqual(names(main),['chart','devopsView','agentflow']);
  assert.equal(view.parentNode,main);
  assert.deepEqual(names(host),[]);
  assert.equal(loan.lent(),false);
  assert.equal(loan.giveBack(),false);
  assert.deepEqual(names(main),['chart','devopsView','agentflow']);
  // A second loan works the same way.
  loan.lend(host);loan.giveBack();
  assert.deepEqual(names(main),['chart','devopsView','agentflow']);
});

test('a layout that moves the view while it is lent moves its placeholder, so it comes back there',()=>{
  const {doc,main,view,host,names}=page();
  const loan=createLoan(view),pane=new FakeNode(doc,'pane');main.appendChild(pane);
  assert.equal(loan.standIn(view),view,'not lent: the view itself');
  loan.lend(host);
  const stand=loan.standIn(view);
  assert.notEqual(stand,view);
  assert.equal(loan.standIn(main),main,'other nodes are their own stand-ins');
  pane.insertBefore(stand,null);
  loan.giveBack();
  assert.deepEqual(names(pane),['devopsView']);
  assert.deepEqual(names(main),['chart','agentflow','pane']);
});

test('scroll positions inside the view survive both moves',()=>{
  const {view,host,scroller}=page();
  const loan=createLoan(view,{scrollers:'.dv-scroll,.dcol-b'});
  scroller.scrollLeft=120;scroller.scrollTop=40;
  loan.lend(host);
  assert.deepEqual([scroller.scrollLeft,scroller.scrollTop],[120,40]);
  scroller.scrollTop=75;
  loan.giveBack();
  assert.deepEqual([scroller.scrollLeft,scroller.scrollTop],[120,75]);
});

const MOUNT={width:14,height:3.9};
test('the board takes the shape of the space a focused board gets, within the mount',()=>{
  const fit=boardFit(MOUNT,{width:1440,height:856});
  assert.deepEqual(fit.px,{w:1440-2*FOCUS_INSET,h:856-2*FOCUS_INSET});
  assert.equal(fit.screen,1,'one CSS pixel per screen pixel');
  assert.equal(fit.m.h,MOUNT.height);
  assert.ok(Math.abs(fit.m.w/fit.m.h-fit.px.w/fit.px.h)<0.01,'the same shape on the wall');
  assert.ok(Math.abs(fit.scale*fit.px.w-fit.m.w)<1e-9);
  // An ultrawide screen fills the mount's width at most.
  const wide=boardFit(MOUNT,{width:5000,height:1000});
  assert.ok(Math.abs(wide.m.w-MOUNT.width)<0.05&&wide.m.h<=MOUNT.height+1e-9);
  assert.equal(wide.screen,1);
  assert.ok(wide.px.w<=5000-2*FOCUS_INSET&&wide.px.h<=1000-2*FOCUS_INSET);
  // A portrait or small screen: never narrower than the minimum shape, laid out wide enough and shown smaller.
  const tall=boardFit(MOUNT,{width:500,height:900});
  assert.ok(Math.abs(tall.px.w/tall.px.h-FOCUS_MIN_ASPECT)<0.01);
  assert.equal(tall.px.w,FOCUS_MIN_WIDTH);
  assert.ok(tall.screen<1&&tall.px.w*tall.screen<=500-2*FOCUS_INSET+1e-9);
  for(const f of [fit,wide,tall])assert.ok(f.px.w%2===0&&f.px.h%2===0,'even pixel sizes');
});

test('the focus pose shows the board at 1:1, centred on whole pixels',()=>{
  for(const stage of [{width:1440,height:856},{width:1281,height:719},{width:600,height:400}]){
    const fit=boardFit(MOUNT,stage),fov=45,pose=focusPose(fit,stage,fov);
    // Screen pixels per metre at distance d, times metres per CSS pixel: the board's on-screen scale.
    const pxPerM=stage.height/2/(Math.tan(fov*Math.PI/360)*pose.d);
    assert.ok(Math.abs(pxPerM*fit.scale-fit.screen)<1e-9);
    assert.ok(Number.isInteger(pose.left)&&Number.isInteger(pose.top));
    const w=fit.px.w*fit.screen,h=fit.px.h*fit.screen;
    assert.ok(Math.abs(pose.left-(stage.width-w)/2)<=0.5&&Math.abs(pose.top-(stage.height-h)/2)<=0.5);
    // The camera's shift moves the board's centre to (left + w/2, top + h/2): within half a pixel.
    assert.ok(Math.abs(pose.x)*pxPerM<=0.5+1e-9&&Math.abs(pose.y)*pxPerM<=0.5+1e-9);
  }
});

test('the focus blend eases both ways and stops at its target',()=>{
  let b=0;const seen=[];
  for(let i=0;i<40;i++){b=stepBlend(b,1,1/60);seen.push(b)}
  assert.equal(b,1);
  assert.ok(seen.every((x,i)=>!i||x>=seen[i-1]));
  for(let i=0;i<40;i++)b=stepBlend(b,0,1/60);
  assert.equal(b,0);
  assert.equal(ease(0),0);assert.equal(ease(1),1);assert.ok(ease(.25)<.25&&ease(.75)>.75);
});
