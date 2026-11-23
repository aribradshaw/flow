// What each character in the 3D office decides to do next (office-npc.js moves them). One small state machine
// per character, with no Three.js and no clock of its own, so node can test it.
//
// Choices are seeded from the character's id and what the server says about it (status, kind of work, card),
// never from Math.random, so two people looking at the same office see much the same scene: the same agent
// goes for coffee, then looks at the board, at about the same time. Exact sync is not the point.
//
//   work      at its desk, seated (office-activity.js acts out the work there)
//   idle      a calm round of: sit at the desk, the lounge or coffee corner, the nearest board, a short wander;
//             10 to 40 seconds at each. Two idle ones nearby sometimes meet and chat (pairUp).
//   summon    waiting on its person, who is in the office and not in Do not disturb: jogs over and hops there
//   follow    a Chief of Staff whose person is in the office (not in a meeting): walks 1.5–2 m behind them, jogging
//             when they get far ahead; back to its desk when they leave or go into a meeting
//   waitDesk  waiting, but its person is away or busy: hops at its desk
//   fetch     it picked up a new card: walks to the board, takes the card (take), carries it to its desk (carry)
//   deliver   its card went to UAT or Done: carries it to the board, puts it up (putup), celebrates (cheer)
//   enter     new: walks in from the door to its desk
//   leave     gone: stands up, waves, walks out the door (exit) and fades (fade), then gone
//
// brain.update(now, input) -> intent (the same object every time; intent.rev changes when the goal does)
//   input: {status:'running'|'waiting'|'idle', kind, card:{number, column}|null, ownerHere, gone, arrived,
//           partner (id of a chat partner, or ''), wander (false: stays at its desk when idle), still (true:
//           never moves, e.g. a paused agent), follow (true: keep up with its person, see follow), far (they are a
//           long way ahead: jog)}
//   intent: {state, goal:'home'|'here'|'door'|'owner'|'board'|'lounge'|'wander'|'partner'|'follow', pace:'walk'|'jog',
//            pose:'sit'|'stand'|'hop'|'wave'|'cheer'|'look'|'talk', carry, say, fade (0..1), spot (0..1), rev}

export const DWELL_MIN=10,DWELL_MAX=40,CHAT_SLOT=25,TAKE=1.2,CHEER=1.6,WAVE=1.4,STAND=0.4,FADE=0.8;
const DONE=new Set(['uat','done']);
// What a follower drops to keep up with its person: its everyday states, not leaving, entering or a card in hand.
const FOLLOWS=new Set(['work','idle','chat','waitDesk']);

// FNV-1a, then a final mix so ids that differ only at the end land far apart.
export function hashOf(s){let h=2166136261;s=String(s);for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);
  h^=h>>>16;h=Math.imul(h,0x85ebca6b);h^=h>>>13;h=Math.imul(h,0xc2b2ae35);h^=h>>>16;return h>>>0}
// mulberry32: a small, good, seeded generator.
export function rngFrom(seed){let a=seed>>>0;return ()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296}}
export const unit=s=>hashOf(s)/4294967296;

// Who chats with whom in this time slot (wall-clock, so every viewer gets the same pairs). candidates: [{id,
// area}] of idle characters free to wander; only ones in the same area pair up, about four in ten of them.
// -> Map(id -> partner id)
export function pairUp(candidates,slot,{share=0.45}={}){
  const by=new Map(),out=new Map();
  for(const c of candidates){const h=unit(c.id+'|'+slot);if(h>=share)continue;(by.get(c.area)||by.set(c.area,[]).get(c.area)).push({id:c.id,h})}
  for(const list of by.values()){list.sort((a,b)=>a.h-b.h);for(let i=0;i+1<list.length;i+=2){out.set(list[i].id,list[i+1].id);out.set(list[i+1].id,list[i].id)}}
  return out;
}

export function createBrain(id,{now=0,entering=false}={}){
  const intent={state:'',goal:'home',pace:'walk',pose:'sit',carry:false,say:'',fade:0,spot:0,rev:0};
  let state='',since=now,rng=rngFrom(hashOf(id)),act='desk',until=Infinity,arrivedAt=-1,pending=[],partner='',carried=false;
  // The last input seen, as plain values (no objects made per frame). seenCard: false before the first look.
  let mStatus=null,mKind=null,mNum=null,seenCard=false,cNum=null,cCol=null,far=false;
  const set=(s,t)=>{if(s!==state){state=s;since=t;arrivedAt=-1}};
  const aim=(goal,spot=intent.spot)=>{if(goal!==intent.goal||spot!==intent.spot){intent.goal=goal;intent.spot=spot;intent.rev++}};
  // Change the plan when the server's view of it changes; the same view always plans the same way.
  function remode(inp){
    const num=inp.card?.number??null,kind=inp.kind||'';
    if(inp.status===mStatus&&kind===mKind&&num===mNum)return false;
    mStatus=inp.status;mKind=kind;mNum=num;rng=rngFrom(hashOf(id+'|'+inp.status+'|'+kind+'|'+(num??'')));
    // A newly idle one first stays at its desk a while.
    act='desk';until=Infinity;intent.spot=rng();return true;
  }
  function nextAct(inp,t){
    const r=rng();
    act=inp.wander===false?(r<0.6?'desk':r<0.8?'board':'wander'):(r<0.32?'desk':r<0.62?'lounge':r<0.8?'board':'wander');
    if(inp.board===false&&act==='board')act='desk';
    until=Infinity;arrivedAt=-1;aim(act==='desk'?'home':act,rng());since=t;
  }
  function cardEvents(inp){
    const num=inp.card?.number??null,col=inp.card?.column??null;
    if(seenCard&&num===cNum&&col===cCol)return;
    const first=!seenCard,pNum=cNum,pCol=cCol;seenCard=true;cNum=num;cCol=col;
    if(first||num===null)return; // the first look at it is how things are, not news
    if(pNum!==num){if(!DONE.has(col))pending.push('fetch')}
    else if(!DONE.has(pCol)&&DONE.has(col))pending.push('deliver');
    if(pending.length>2)pending.splice(0,pending.length-2);
  }
  // What it does when nothing special is going on.
  function settle(inp,t){
    if(inp.status==='waiting'){set(inp.ownerHere?'summon':'waitDesk',t);return}
    if(inp.follow&&!inp.still){pending.length=0;set('follow',t);return}
    if(pending.length&&!inp.still){const e=pending.shift();set(e,t);carried=e==='deliver';return}
    if(inp.status==='idle'&&!inp.still){if(state!=='idle'&&state!=='chat'){set('idle',t);act='desk';until=Infinity}return}
    set('work',t);
  }

  function update(t,inp){
    remode(inp);cardEvents(inp);far=!!inp.far;
    if(inp.follow&&!inp.still&&inp.status!=='waiting')pending.length=0; // board trips while it follows are old news
    const leaving=state==='leave'||state==='exit'||state==='fade'||state==='gone';
    if(inp.gone&&!leaving)set('leave',t);
    else if(!inp.gone&&leaving&&state!=='gone')set('enter',t);
    if(!state)set(entering?'enter':'',t);
    if(!state)settle(inp,t);
    if(inp.follow&&!inp.still&&FOLLOWS.has(state)&&!(state==='waitDesk'&&inp.status==='waiting'))settle(inp,t);
    const el=t-since;
    switch(state){
      case 'leave':if(el>=STAND+WAVE)set('exit',t);break;
      case 'exit':if(inp.arrived)set('fade',t);break;
      case 'fade':if(el>=FADE)set('gone',t);break;
      case 'gone':break;
      case 'enter':if(inp.arrived)settle(inp,t);break;
      case 'take':if(el>=TAKE){set('carry',t)}break;
      case 'carry':if(inp.status==='waiting')settle(inp,t);else if(inp.arrived){carried=false;settle(inp,t)}break;
      case 'fetch':case 'deliver':
        if(inp.status==='waiting'){settle(inp,t);break}
        if(inp.arrived)set(state==='fetch'?'take':'putup',t);break;
      case 'putup':if(el>=TAKE)set('cheer',t);break;
      case 'cheer':if(el>=CHEER)settle(inp,t);break;
      case 'summon':
        if(inp.status!=='waiting'||!inp.ownerHere)settle(inp,t);break;
      case 'waitDesk':
        if(inp.status!=='waiting'||inp.ownerHere)settle(inp,t);break;
      case 'follow':
        if(!inp.follow||inp.still||inp.status==='waiting')settle(inp,t);break;
      case 'chat':
        if(inp.status!=='idle'||!inp.partner||inp.partner!==partner){partner='';set('idle',t);nextAct(inp,t)}break;
      case 'idle':
        if(inp.status!=='idle'||inp.still||pending.length){settle(inp,t);break}
        if(inp.partner&&inp.wander!==false){partner=inp.partner;set('chat',t);break}
        if(inp.arrived&&arrivedAt<0){arrivedAt=t;until=t+DWELL_MIN+rng()*(DWELL_MAX-DWELL_MIN)}
        if(t>=until)nextAct(inp,t);
        break;
      case 'work':if(inp.status!=='running'||pending.length)settle(inp,t);break;
    }
    // Carrying: from taking the card (half way) to its desk; from the start of a delivery to putting it up.
    if(state==='take'&&t-since>=TAKE/2)carried=true;
    if(state==='putup'&&t-since>=TAKE/2)carried=false;
    if(state==='fetch')carried=false;
    return write(t);
  }
  function write(t){
    const el=t-since;
    intent.state=state;intent.pace='walk';intent.say='';intent.fade=0;intent.carry=carried&&(state==='take'||state==='carry'||state==='deliver'||state==='putup');
    switch(state){
      case 'enter':aim('home');intent.pose='stand';break;
      case 'work':aim('home');intent.pose='sit';break;
      case 'waitDesk':aim('home');intent.pose='hop';break;
      case 'summon':aim('owner');intent.pace='jog';intent.pose='hop';break;
      case 'follow':aim('follow');intent.pace=far?'jog':'walk';intent.pose='stand';break;
      case 'fetch':case 'deliver':aim('board');intent.pose='stand';break;
      case 'take':case 'putup':aim('board');intent.pose='look';break;
      case 'cheer':aim('board');intent.pose='cheer';break;
      case 'carry':aim('home');intent.pose='stand';break;
      case 'chat':aim('partner');intent.pose='talk';intent.say='…';break;
      case 'idle':aim(act==='desk'?'home':act);intent.pose=act==='desk'?'sit':act==='board'?'look':'stand';break;
      case 'leave':aim('here');intent.pose=el<STAND?'stand':'wave';break;
      case 'exit':aim('door');intent.pose='stand';break;
      case 'fade':aim('door');intent.pose='stand';intent.fade=Math.min(1,el/FADE);break;
      case 'gone':intent.fade=1;break;
    }
    return intent;
  }
  return {update,intent,get state(){return state},get act(){return act},get partner(){return partner}};
}
