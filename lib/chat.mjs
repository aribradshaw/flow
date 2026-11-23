// Chat with OneProfileID friends from inside Flow (docs/concepts/11-chat.md). Session-only routes for
// the app's own page, never the public API:
//   GET  /api/chat/status                    -> {available, unread}  (available:false hides the chat)
//   GET  /api/chat/conversations             -> {unread, conversations:[{username,name,photo,unread,lastMessage}]}
//   GET  /api/chat/friends                   -> {friends:[{username,name,photo}]}
//   POST /api/chat/thread {username, before?} -> {person, messages, more}
//   POST /api/chat/send   {username, body}    -> 201 {message}
//   POST /api/chat/send   {office: {env, target}, body} -> 200 {ok, saved} (3D office only)
//   POST /api/chat/read   {username, through?} -> {ok:true}
//   POST /api/chat/cards  {links:[{env,kind,id}]} -> {cards:[{access, card?, open?}]}  (same order)
// Messages go through OneProfileID's native gateway with the browser's own OneProfileID cookie, so
// OneProfileID always acts as the person signed in here. The office route resolves its recipient from
// a live member key to a verified handle. OneProfileID checks the friendship when it sends.
// In local mode or when OneProfileID messages are disabled, Flow chat is hidden. Office DMs can still
// relay locally. /api/chat/cards works in local mode too, using the viewer's own access to linked cards.
import {USERNAME,MESSAGE_ID,ENV_ID,validBody,validRef} from '../public/chat-core.js';

const MAX_LINKS=25;
const send=(res,code,body,cookies=[],out=l=>l)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store',...(cookies.length?{'Set-Cookie':out(cookies,res)}:{})});res.end(JSON.stringify(body))};
export const UNAVAILABLE={available:false,code:'chat_unavailable',error:'Chat is not available here.'};
// OneProfileID refusing the app (messages not enabled, no membership, email not verified): the chat
// is unavailable for this person, not broken.
export function unavailable(r){
  if(!r||r.status!==403)return false;
  const p=r.payload||{};
  return p.code!=='not_friends';
}

// What OneProfileID returned, reduced to the fields the page uses, with types checked.
const str=(v,n)=>typeof v==='string'?v.slice(0,n):'';
const photo=v=>typeof v==='string'&&v.length<=750000&&(/^https:\/\//.test(v)||/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v))?v:null;
const count=v=>Number.isInteger(v)&&v>=0?Math.min(v,1e6):0;
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:'';
export const cleanPerson=p=>p&&typeof p==='object'&&USERNAME.test(String(p.username||''))?{username:p.username,name:str(p.name,120)||p.username,photo:photo(p.photo)}:null;
export function cleanMessage(m){
  if(!m||typeof m!=='object'||typeof m.id!=='string'||!m.id||m.id.length>64)return null;
  return {id:m.id,body:str(m.body,4000),createdAt:iso(m.createdAt),mine:m.mine===true,read:m.read===true,...(count(m.photoCount)?{photoCount:count(m.photoCount)}:{})};
}
export function cleanConversations(p){
  const list=(Array.isArray(p?.conversations)?p.conversations:[]).map(c=>{const who=cleanPerson(c);if(!who)return null;const l=c.lastMessage;
    return {...who,unread:count(c.unread),lastMessage:l&&typeof l==='object'?{body:str(l.body,4000),createdAt:iso(l.createdAt),mine:l.mine===true}:null}}).filter(Boolean);
  return {unread:count(p?.unread),conversations:list};
}
export const cleanFriends=p=>({friends:(Array.isArray(p?.friends)?p.friends:[]).map(cleanPerson).filter(Boolean)});
export const cleanThread=p=>({person:cleanPerson(p?.person),messages:(Array.isArray(p?.messages)?p.messages:[]).map(cleanMessage).filter(Boolean),more:p?.more===true});
// Only the named keys, each of the right shape. -> the body, or null.
function strict(b,required,optional={}){
  if(!b||typeof b!=='object'||Array.isArray(b))return null;
  const allowed={...required,...optional};
  if(Object.keys(b).some(k=>!Object.hasOwn(allowed,k)))return null;
  for(const [k,ok] of Object.entries(required))if(!ok(b[k]))return null;
  for(const [k,ok] of Object.entries(optional))if(k in b&&b[k]!==null&&b[k]!==undefined&&!ok(b[k]))return null;
  return b;
}
const isHandle=v=>typeof v==='string'&&USERNAME.test(v),msgId=v=>typeof v==='string'&&MESSAGE_ID.test(v);
const officeTarget=v=>!!strict(v,{
  env:id=>typeof id==='string'&&ENV_ID.test(id),
  target:key=>typeof key==='string'&&/^m[A-Za-z0-9_-]{12}$/.test(key),
});

// deps: mode ('opid'|'local'), userFor(req,{touch}), call(req, method, args) -> {ok,status,payload,cookies}|null
// (auth.opidMessages), out(cookies,res) (auth.outCookies), trusted(req), readJson(req,res,fn),
// resolveCards(req, user, refs) -> [{access, card?, open?}]
// officeDirect(user, office, body, deliver) validates live office membership and relays only to the two people.
export function chatRoutes({mode,userFor,call,out=l=>l,trusted,readJson,resolveCards,officeDirect}){
  const reply=(res,code,body,cookies)=>send(res,code,body,cookies||[],out);
  // OneProfileID's answer as the page should see it.
  function relay(res,r,clean,okCode=200){
    if(!r)return reply(res,200,UNAVAILABLE);
    if(r.ok){const body=clean(r.payload);return body?reply(res,okCode,body,r.cookies):reply(res,502,{error:"OneProfileID's answer could not be read. Refresh to check."},r.cookies)}
    if(unavailable(r))return reply(res,403,UNAVAILABLE,r.cookies);
    const p=r.payload||{};
    if(r.status===403)return reply(res,403,{error:'You can only message friends who follow you back.',code:'not_friends'},r.cookies);
    if(r.status===429){const s=Number.isInteger(p.retryAfter)&&p.retryAfter>0?Math.min(p.retryAfter,3600):60;return reply(res,429,{error:'You are sending messages too quickly. Try again in a minute.',code:'rate_limited',retryAfter:s},r.cookies)}
    if(r.status===401)return reply(res,401,{error:'Sign in again to use chat.'},r.cookies);
    if(r.status===400)return reply(res,400,{error:str(p.error,200)||'That message could not be sent.'},r.cookies);
    return reply(res,503,{error:"Can't reach your messages right now. Try again shortly."},r.cookies);
  }
  async function opid(req,method,args){
    try{return await call(req,method,args)}catch{return {ok:false,status:400,payload:{error:'Invalid request'}}}
  }
  return async function handle(req,res){
    const path=new URL(req.url,'http://x').pathname;
    if(path!=='/api/chat'&&!path.startsWith('/api/chat/'))return false;
    // The app's own page only (no API keys, no other sites).
    if(!trusted(req)||req.headers.authorization){res.writeHead(403);res.end();return true}
    const route=`${req.method} ${path}`;
    const known=['GET /api/chat/status','GET /api/chat/conversations','GET /api/chat/friends','POST /api/chat/thread','POST /api/chat/send','POST /api/chat/read','POST /api/chat/cards'];
    if(!known.includes(route)){reply(res,known.some(k=>k.endsWith(' '+path))?405:404,{error:known.some(k=>k.endsWith(' '+path))?'Method not allowed':'Not found'});return true}
    // Polls and reads do not count as activity for the idle sign-in timeout; sending does.
    const user=await userFor(req,{touch:route==='POST /api/chat/send'});
    if(!user){reply(res,401,{error:'Sign in to use chat.'});return true}
    if(route==='POST /api/chat/cards'){
      readJson(req,res,async b=>{
        try{
          const refs=strict(b,{links:v=>Array.isArray(v)&&v.length>=1&&v.length<=MAX_LINKS&&v.every(r=>validRef(r)&&Object.keys(r).every(k=>['env','kind','id'].includes(k)))});
          if(!refs)return reply(res,400,{error:`Expected {links:[{env, kind, id}]} (1 to ${MAX_LINKS})`});
          const cards=await resolveCards(req,user,refs.links.map(r=>({env:r.env,kind:r.kind,id:r.id})));
          reply(res,200,{cards});
        }catch{reply(res,500,{error:'Could not look up those cards.'})}
      });
      return true;
    }
    if(route!=='POST /api/chat/send'&&(mode!=='opid'||user.local||user.token||user.key)){reply(res,route==='GET /api/chat/status'?200:403,UNAVAILABLE);return true}
    if(req.method==='GET'){
      if(route==='GET /api/chat/status'){
        const r=await opid(req,'listConversations',[]);
        if(r?.ok)return reply(res,200,{available:true,unread:cleanConversations(r.payload).unread},r.cookies),true;
        // Not enabled for this app: hidden. A passing outage keeps the chat, with the badge unknown.
        if(!r||unavailable(r))return reply(res,200,UNAVAILABLE,r?.cookies),true;
        return reply(res,200,{available:true,unread:null,error:"Can't reach your messages right now."},r.cookies),true;
      }
      if(route==='GET /api/chat/conversations'){relay(res,await opid(req,'listConversations',[]),cleanConversations);return true}
      relay(res,await opid(req,'listFriends',[]),cleanFriends);return true;
    }
    readJson(req,res,async b=>{
      try{
        if(route==='POST /api/chat/thread'){
          const v=strict(b,{username:isHandle},{before:msgId});if(!v)return reply(res,400,{error:'Choose a valid conversation.'});
          return relay(res,await opid(req,'getThread',[v.username,v.before?{before:v.before}:{}]),cleanThread);
        }
        if(route==='POST /api/chat/read'){
          const v=strict(b,{username:isHandle},{through:msgId});if(!v)return reply(res,400,{error:'Choose a valid conversation.'});
          return relay(res,await opid(req,'markRead',[v.username,v.through?{through:v.through}:{}]),()=>({ok:true}));
        }
        if(b?.office&&officeDirect){
          const v=strict(b,{office:officeTarget,body:validBody});
          if(!v)return reply(res,400,{error:'Choose a person in your office and write a message.'});
          let cookies=[];
          try{
            const delivery=await officeDirect(user,v.office,v.body.trim(),async (recipient,body)=>{
              if(mode!=='opid'||user.local||!isHandle(recipient.username))return false;
              const r=await opid(req,'sendMessage',[recipient.username,body]);
              cookies=r?.cookies||[];
              if(!r||r.status===403)return false; // Disabled for the app, or the people aren't friends.
              if(!r.ok)throw Object.assign(Error('Could not send via Flow chat'),{opid:r});
              return true;
            });
            return reply(res,200,delivery,cookies);
          }catch(error){
            if(error.opid)return relay(res,error.opid,()=>null);
            const status=Number.isInteger(error.status)?error.status:500;
            return reply(res,status,{error:status===500?'Chat failed. Try again.':error.message,code:error.code},cookies);
          }
        }
        if(mode!=='opid'||user.local||user.token||user.key)return reply(res,403,UNAVAILABLE);
        const v=strict(b,{username:isHandle,body:v=>typeof v==='string'});if(!v)return reply(res,400,{error:'Choose a valid conversation.'});
        if(!validBody(v.body))return reply(res,400,{error:v.body.trim()?'Messages can be up to 2,000 characters.':'Write a message first.'});
        return relay(res,await opid(req,'sendMessage',[v.username,v.body]),p=>{const m=cleanMessage(p?.message);return m?{message:m}:null},201);
      }catch{reply(res,500,{error:'Chat failed. Try again.'})}
    });
    return true;
  };
}
