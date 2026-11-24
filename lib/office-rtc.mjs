// Voice and screen sharing in the 3D office (docs/concepts/12-office.md): WebRTC signalling relayed over the
// office's event stream, and the ICE servers browsers use to reach each other.
//
//   officeRtc({hub, now})            signalling for one officeHub (lib/office.mjs)
//     .signal(envId, user, body)     POST /api/office/{env}/rtc {from, to, type, data}
//     .peers(envId)                  the voice states in an office (tests, the docs)
//   iceConfig({env, fetch, now})     GET /api/office/{env}/rtc: {iceServers, ttl, turn}
//
// Audio and video go browser to browser (a mesh: fine for about 8 people). The server only passes on
// offers, answers and ICE candidates between two open connections (tabs) of the same office, and keeps
// each connection's voice state (which room's call it is in, proximity voice on or off, Do not disturb,
// muted, sharing its screen) in memory. Nothing is recorded or stored, and payloads are never logged.
//
// Each open office connection gets an opaque peer id (rtc {type:'welcome', peer, peers}); the browser sends
// it as `from`, and the server checks it is one of the caller's own connections in that office.
// Events, all `event: rtc` on the office stream:
//   {type:'welcome', peer, peers:[state]}                   to a new connection
//   {type:'state', peer, key, room, near, dnd, muted, share} to everyone in the office, the sender included
//   {type:'gone', peer}                                      a connection closed
//   {type:'offer'|'answer'|'ice'|'bye', from, data}          to the one peer it is for
// An offer needs both sides in the same room's call, or both with proximity voice on, outside rooms and
// neither in Do not disturb. Answers, candidates and byes only need both in the same office.
// One screen per room: a share replaces the room's last one (its sharer's state turns share:false, with taken:true).
export const RTC_TYPES=['state','offer','answer','ice','bye'];
export const RTC_MAX=24000;               // bytes of JSON per payload (an SDP offer with video is ~6-12 KB)
export const RTC_RATE=[200,40];           // per connection: burst, refill per second (ICE comes in bursts)
export const STATE_RATE=[12,3];
export const DEFAULT_STUN=['stun:stun.l.google.com:19302'];
const ROOM_ID=/^[a-z0-9][a-z0-9-]{0,39}$/;
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
const same=(a,b)=>String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();

export function cleanVoiceState(d={}){
  const room=typeof d.room==='string'&&ROOM_ID.test(d.room)?d.room:'';
  return {room,near:!room&&d.near===true,dnd:d.dnd===true,muted:d.muted===true,share:!!room&&d.share===true};
}
// May `a` open a call to `b`? (voice states)
export function mayCall(a,b){
  if(!a||!b)return false;
  if(a.room||b.room)return !!a.room&&a.room===b.room;
  return a.near&&b.near&&!a.dnd&&!b.dnd;
}

export function officeRtc({hub,now=()=>Date.now()}){
  const states=new Map(),limits=new Map(); // peer (connection id) -> voice state
  const view=(cl,s)=>({peer:cl.id,key:cl.key,...s});
  const take=(key,[burst,rate])=>{
    const t=now(),b=limits.get(key)||{tokens:burst,at:t};b.tokens=Math.min(burst,b.tokens+(t-b.at)/1000*rate);b.at=t;limits.set(key,b);
    if(limits.size>20000)limits.clear();
    if(b.tokens<1)return false;b.tokens-=1;return true;
  };
  const broadcast=(envId,data)=>{for(const c of hub.clientsOf(envId))hub.send(c,'rtc',data)};
  const off=hub.onClient((what,cl)=>{
    if(what==='connect'){
      const peers=hub.clientsOf(cl.envId).filter(c=>c!==cl&&states.has(c.id)).map(c=>view(c,states.get(c.id)));
      hub.send(cl,'rtc',{type:'welcome',peer:cl.id,peers});
    }
    if(what==='leave'){
      limits.delete(cl.id);
      if(states.delete(cl.id))broadcast(cl.envId,{type:'gone',peer:cl.id});
    }
  });
  return {
    signal(envId,user,b){
      if(!b||typeof b!=='object')fail(400,'invalid_input','Expected {from, to, type, data}');
      const type=b.type;if(!RTC_TYPES.includes(type))fail(400,'invalid_input','type must be one of '+RTC_TYPES.join(', '));
      const list=hub.clientsOf(envId),from=list.find(c=>c.id===b.from);
      // Only one of the caller's own open connections to this office may speak.
      if(!from||!same(from.user.email,user.email))fail(409,'not_connected','Open the office first');
      let size=0;try{size=Buffer.byteLength(JSON.stringify(b.data??null))}catch{fail(400,'invalid_input','data must be JSON')}
      if(size>RTC_MAX)fail(413,'too_large',`data is over ${RTC_MAX} bytes`);
      if(type==='state'){
        if(!take('state\n'+from.id,STATE_RATE))fail(429,'rate_limited','Too many voice changes');
        const s=cleanVoiceState(b.data||{});
        if(s.share)for(const c of list){
          const o=states.get(c.id);
          if(c!==from&&o?.share&&o.room===s.room){o.share=false;broadcast(envId,{type:'state',...view(c,o),taken:true})}
        }
        states.set(from.id,s);broadcast(envId,{type:'state',...view(from,s)});
        return {ok:true,peer:from.id};
      }
      if(!take('sig\n'+from.id,RTC_RATE))fail(429,'rate_limited','Too many signalling messages');
      const to=list.find(c=>c.id===b.to);
      if(!to||to===from)fail(404,'not_found','That person is not in this office');
      if(type==='offer'&&!mayCall(states.get(from.id),states.get(to.id)))fail(409,'not_in_call','You are not in a call with them');
      hub.send(to,'rtc',{type,from:from.id,data:b.data??null});
      return {ok:true};
    },
    peers:envId=>hub.clientsOf(envId).filter(c=>states.has(c.id)).map(c=>view(c,states.get(c.id))),
    close(){off();states.clear();limits.clear()},
  };
}

// ---------- ICE servers ----------
// STUN finds a browser's public address; TURN relays when two networks cannot reach each other directly
// (common behind carrier-grade NAT, strict corporate firewalls and some home routers).
//   OFFICE_STUN_URLS                  comma-separated STUN URLs (default Google's public STUN; "none": no STUN)
//   OFFICE_TURN_URLS                  comma-separated TURN URLs of your own server, with
//   OFFICE_TURN_USERNAME, OFFICE_TURN_CREDENTIAL (sent to members of the office: use a TURN-only account)
//   CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_KEY_API_TOKEN
//                                     Cloudflare Realtime TURN: short-lived credentials, fetched here per person;
//                                     the key id and API token never leave the server.
// -> get(user) resolves {iceServers, ttl, turn:boolean}
const list=v=>String(v||'').split(',').map(s=>s.trim()).filter(Boolean);
const iceUrl=u=>typeof u==='string'&&/^(stun|stuns|turn|turns):[^\s]{1,250}$/.test(u);
export function iceConfig({env=process.env,fetch:doFetch=globalThis.fetch,now=()=>Date.now(),ttl=6*3600,log=console}={}){
  const stunEnv=list(env.OFFICE_STUN_URLS),stun=stunEnv.length===1&&stunEnv[0]==='none'?[]:(stunEnv.length?stunEnv:DEFAULT_STUN).filter(iceUrl);
  const turnUrls=list(env.OFFICE_TURN_URLS).filter(iceUrl);
  const own=turnUrls.length?[{urls:turnUrls,...(env.OFFICE_TURN_USERNAME?{username:String(env.OFFICE_TURN_USERNAME)}:{}),...(env.OFFICE_TURN_CREDENTIAL?{credential:String(env.OFFICE_TURN_CREDENTIAL)}:{})}]:[];
  const cfId=String(env.CLOUDFLARE_TURN_KEY_ID||'').trim(),cfToken=String(env.CLOUDFLARE_TURN_KEY_API_TOKEN||'').trim();
  const cf=cfId&&cfToken&&/^[A-Za-z0-9_-]{1,128}$/.test(cfId);
  const cache=new Map();let warned=false;
  async function cloudflare(){
    const r=await doFetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfId)}/credentials/generate-ice-servers`,{
      method:'POST',headers:{Authorization:'Bearer '+cfToken,'Content-Type':'application/json'},body:JSON.stringify({ttl}),signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw Error('Cloudflare TURN answered '+r.status);
    const d=await r.json(),servers=Array.isArray(d?.iceServers)?d.iceServers:d?.iceServers?[d.iceServers]:[];
    // Browsers block port 53: those URLs only time out.
    return servers.map(s=>({urls:[].concat(s?.urls||[]).filter(u=>iceUrl(u)&&!/:53(\?|$)/.test(u)),
      ...(typeof s?.username==='string'?{username:s.username}:{}),...(typeof s?.credential==='string'?{credential:s.credential}:{})}))
      .filter(s=>s.urls.length&&(s.urls.every(u=>u.startsWith('stun'))||s.username&&s.credential));
  }
  return {
    configured:!!(own.length||cf),
    async get(user){
      const base=[...(stun.length?[{urls:stun}]:[]),...own];
      if(!cf)return {iceServers:base,ttl,turn:own.length>0};
      const k=String(user?.email||'').toLowerCase(),hit=cache.get(k);
      if(hit&&hit.until>now())return hit.value;
      try{
        const got=await cloudflare(),value={iceServers:[...base,...got],ttl,turn:got.some(s=>s.username)||own.length>0};
        cache.set(k,{until:now()+ttl*1000/2,value});if(cache.size>5000)cache.clear();
        return value;
      }catch(e){
        if(!warned){warned=true;log.error?.('office: Cloudflare TURN credentials unavailable:',String(e?.message||e).slice(0,120))}
        return {iceServers:base,ttl,turn:own.length>0};
      }
    },
  };
}
