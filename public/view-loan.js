// Lending a live view to another host and giving it back exactly where it was (docs/concepts/12-office.md:
// the 3D office's main board is the DevOps tab's own #devopsView, moved into the office while it is open).
// It is the same element, so its listeners and state come along; nothing is copied or re-created.
//
//   const loan=createLoan(el)
//   loan.lend(host)    moves el to the end of host, leaving a placeholder where it was (again: stays lent)
//   loan.giveBack()    puts el back in the placeholder's place, scroll positions kept; true if it was lent
//   loan.lent()        whether el is away
//   loan.standIn(el)   what a layout that moves el should move instead: the placeholder while lent, else el
//
// Scrolled boxes inside el (scrollers: a selector) keep their scroll positions across both moves.
export function createLoan(el,{scrollers=''}={}){
  let mark=null;
  function move(parent,before=null){
    const keep=scrollers&&el.querySelectorAll?[...el.querySelectorAll(scrollers)].map(x=>[x,x.scrollLeft,x.scrollTop]):[];
    parent.insertBefore(el,before);
    for(const [x,l,t] of keep){x.scrollLeft=l;x.scrollTop=t}
  }
  return {
    lend(host){
      if(!host)return;
      if(!mark){
        mark=el.ownerDocument.createComment('lent: '+(el.id||'view'));
        if(el.parentNode)el.parentNode.insertBefore(mark,el);
      }
      if(el.parentNode!==host||host.lastChild!==el)move(host);
    },
    giveBack(){
      if(!mark)return false;
      const m=mark;mark=null;
      if(m.parentNode){move(m.parentNode,m);m.parentNode.removeChild(m)}
      else el.parentNode?.removeChild(el);
      return true;
    },
    lent:()=>!!mark,
    standIn:node=>mark&&node===el?mark:node,
  };
}
