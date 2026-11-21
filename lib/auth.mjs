// OneProfileID native sign-in for Flygon Flow (OneProfileID docs/native-auth.md).
//
// Off unless all OPID_* variables are set; then the app runs in local single-user mode exactly as
// before, as FLOW_LOCAL_EMAIL (default: the owner). With them set:
//   - the browser posts email/password to this server, which calls OneProfileID's internal API with
//     the app's id + secret (never sent to the browser) and forwards OneProfileID's Set-Cookie headers;
//   - two-factor challenges are completed with a TOTP or recovery code before any session exists;
//   - after verification the server fetches /get-session, requires a membership for this app and
//     creates its own httpOnly SameSite=Lax session cookie (Secure on https; SameSite=None when
//     FLOW_FRAME_ANCESTORS allows embedding, see lib/embed.mjs);
//   - every protected request revalidates the central session and that it is still the same person
//     with a membership; the local session alone never authenticates.
// Env: OPID_BASE_URL, OPID_APP_ID, OPID_APP_SECRET, OPID_APP_ORIGIN (see README).
//
// Passkeys and biometrics (OneProfileID docs/passkeys-sso.md): passkeys belong to OneProfileID's own
// origin, so "Continue with OneProfileID" redirects there (GET /api/auth/sso/start) and comes back to
// GET /api/auth/sso/callback with an app-bound code (PKCE, state, nonce). The callback exchanges it
// through the native gateway and then runs the same membership checks as the password form. An
// existing OneProfileID browser session finishes without any prompt.
// Env (optional, all three together): OPID_SSO_CLIENT_ID, OPID_SSO_CLIENT_SECRET, OPID_SSO_ISSUER
// (default https://auth.oneprofileid.com/api/auth).
//
// Sign in with your phone (lib/device-signin.mjs): for screens without passkeys, the OAuth device flow
// with the same SSO client. On whenever SSO is configured; OPID_DEVICE_SIGN_IN=off turns it off.
import {randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createNativeClient,filterCookies}=require('./opid-client.cjs');
const {createSsoClient}=require('./opid-sso-client.cjs');
import {sessionStore} from './sessions.mjs';
import {embedding} from './embed.mjs';
import {createDeviceSignIn} from './device-signin.mjs';
import {clientIp} from './apikeys.mjs';
import {caps as readCaps,memoryLimiter,requestIp} from './limits.mjs';

const env=process.env,SID='flow_sid',IDLE=12*3600e3,MAX=7*24*3600e3;
const configured=['OPID_BASE_URL','OPID_APP_ID','OPID_APP_SECRET','OPID_APP_ORIGIN'].filter(k=>env[k]);
if(configured.length&&configured.length<4)throw Error('OneProfileID is partly configured: set OPID_BASE_URL, OPID_APP_ID, OPID_APP_SECRET and OPID_APP_ORIGIN together, or none of them');
const origin=env.OPID_APP_ORIGIN||'';
export const mode=configured.length?'opid':'local';
export const appOrigin=origin;
const secure=origin.startsWith('https:');
// A public deploy (OneProfileID on https) must name its owner: the default placeholder would leave
// Default workspace and the owner's larger limits to whoever signs in as that address.
if(mode==='opid'&&secure&&!String(env.OWNER_EMAIL||'').trim())throw Error('Set OWNER_EMAIL: a public Flow (OneProfileID on https) needs to know its owner');
// The owner: owns Default workspace and may bootstrap their own membership on first sign-in.
export const OWNER_EMAIL=(env.OWNER_EMAIL||'owner@example.test').trim().toLowerCase();
export const CAPS=readCaps(env);
// Open sign-up: any verified OneProfileID account may join (its own private workspace). FLOW_OPEN_SIGNUP=off
// keeps Flow invite-only.
export const OPEN_SIGNUP=env.FLOW_OPEN_SIGNUP!=='off';
// /api/auth/* limits (lib/limits.mjs): per client address and per person, in this process.
const ipLimit=memoryLimiter({max:CAPS.authPerIpPerMinute,ms:60e3}),pollLimit=memoryLimiter({max:Math.max(60,CAPS.authPerIpPerMinute*4),ms:60e3});
const sessionLimit=memoryLimiter({max:600,ms:60e3}),userLimit=memoryLimiter({max:CAPS.authPerUserPerMinute,ms:60e3});
// FLOW_FRAME_ANCESTORS (lib/embed.mjs): who may frame Flow; on https it also makes the sign-in cookies SameSite=None.
export const embed=embedding();
// The request's own decision (server.mjs puts it on req.flowEmbed); the env-var default without one.
const cookieOut=(list,res)=>list.map(c=>embed.cookie(c,secure,res?.req?.flowEmbed));
// Fails at startup (without echoing values) if the configuration is unusable.
const client=mode==='opid'?createNativeClient({baseURL:env.OPID_BASE_URL,appId:env.OPID_APP_ID,secret:env.OPID_APP_SECRET,origin,production:secure}):null;
const sso=mode==='opid'&&env.OPID_SSO_CLIENT_ID&&env.OPID_SSO_CLIENT_SECRET?createSsoClient({
  issuer:env.OPID_SSO_ISSUER||'https://auth.oneprofileid.com/api/auth',clientId:env.OPID_SSO_CLIENT_ID,clientSecret:env.OPID_SSO_CLIENT_SECRET,
  redirectUri:`${origin}/api/auth/sso/callback`,nativeBaseURL:env.OPID_BASE_URL,appId:env.OPID_APP_ID,nativeSecret:env.OPID_APP_SECRET,origin,production:secure}):null;
// Created below, once complete() exists.
let device=null;
export const localUser={id:'local',email:(env.FLOW_LOCAL_EMAIL||OWNER_EMAIL).toLowerCase(),name:env.FLOW_LOCAL_NAME||'Example Owner',image:'',local:true};

// Sessions: memory by default; server.mjs plugs in the Postgres-backed store (lib/sessions.mjs).
let sessions=sessionStore({max:MAX});
export const useSessionStore=s=>{sessions=s};
// App invites (lib/invites.mjs), plugged in by server.mjs; none without it.
let invites={find:async()=>null,claimed:async()=>{}};
export const useInvites=i=>{invites=i};
// People who signed in (lib/users.mjs) and whether an email already has data here, plugged in by server.mjs.
let users={seen:async()=>null,count:async()=>0},hasData=async()=>false;
export const useUsers=(u,existing)=>{users=u;if(existing)hasData=existing};
let requests={add:async()=>null};
export const useAccessRequests=r=>{requests=r};
// Where a person signs out of OneProfileID to switch accounts (its hosted account page).
export const ACCOUNT_URL=/^https?:\/\/[^\s]+$/.test(env.OPID_ACCOUNT_URL||'')?env.OPID_ACCOUNT_URL:'https://auth.oneprofileid.com/dashboard';
export const SESSION_MAX=MAX;
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(p=>p.trim()).filter(Boolean).map(p=>[p.slice(0,p.indexOf('=')),p.slice(p.indexOf('=')+1)]));
const sidCookie=(v,age)=>`${SID}=${v}; Path=/; HttpOnly; SameSite=Lax${secure?'; Secure':''}; Max-Age=${age}`;
const json=(res,code,body,setCookie=[])=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store',...(setCookie.length?{'Set-Cookie':cookieOut(setCookie,res)}:{})});res.end(JSON.stringify(body))};
const meta=req=>({ip:req.socket.remoteAddress||'',userAgent:String(req.headers['user-agent']||'').slice(0,300)});
// Cookie name=value pairs from the browser, updated with any the central service just set.
function merged(req,set){
  const jar=new Map(filterCookies(req.headers.cookie||'').split(';').map(p=>p.trim()).filter(Boolean).map(p=>[p.slice(0,p.indexOf('=')),p]));
  for(const c of set){const pair=c.split(';')[0].trim(),name=pair.slice(0,pair.indexOf('='));if(/max-age=0|expires=thu, 01 jan 1970/i.test(c))jar.delete(name);else jar.set(name,pair)}
  return [...jar.values()].join('; ');
}
const safeImage=value=>typeof value==='string'&&value.length<=750000&&(/^https:\/\//.test(value)||/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))?value:'';
const person=u=>({id:u.id,email:String(u.email||'').toLowerCase(),name:u.name||u.email||'',image:safeImage(u.image)});

// The signed-in user for a request, revalidated against OneProfileID; null when signed out.
export async function userFor(req,{touch=true}={}){
  if(mode==='local')return localUser;
  const sid=cookies(req)[SID],s=sid&&await sessions.get(sid),now=Date.now();
  if(!s||now-s.last>IDLE||now-s.created>MAX){if(s)await sessions.delete(sid);return null}
  const r=await client.request('/get-session',{cookie:req.headers.cookie||'',...meta(req)});
  if(!r.ok||r.payload?.user?.id!==s.user.id||r.payload.twoFactorRedirect||r.payload.enrollmentRequired||!r.payload.memberships?.length){await sessions.delete(sid);return null}
  s.user=person(r.payload.user);if(touch){s.last=now;await sessions.touch(sid,s)}return s.user;
}
// Current OneProfileID photos of other members (lib/opid-photos.mjs decides who is eligible first).
// The viewer's own OneProfileID session is sent along; OneProfileID applies its own rules too and
// leaves out anyone it will not show. Never throws: {} in local mode or when OneProfileID refuses
// (for example before this app may read member photos). -> {userId: dataUrl}
export async function memberImages(req,userIds){
  const ids=[...new Set(userIds)].filter(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v));
  if(mode!=='opid'||!ids.length)return {};
  const out={};
  for(let i=0;i<ids.length;i+=200){
    try{
      const r=await client.getMemberImages(ids.slice(i,i+200),{cookie:req.headers.cookie||'',...meta(req)});
      const images=r.ok&&r.payload?.images&&typeof r.payload.images==='object'&&!Array.isArray(r.payload.images)?r.payload.images:{};
      for(const id of ids.slice(i,i+200)){const v=Object.hasOwn(images,id)?safeImage(images[id]):'';if(v)out[id]=v}
    }catch{}
  }
  return out;
}
// OneProfileID direct messages for the signed-in member (lib/chat.mjs). Only this browser's own
// OneProfileID cookie goes along, so OneProfileID always acts as the person who is signed in; the only
// other person ever named is a friend's handle. null in local mode.
// -> {ok, status, payload, cookies} (cookies: to forward with outCookies)
const MESSAGE_CALLS=new Set(['listConversations','listFriends','getThread','sendMessage','markRead']);
export async function opidMessages(req,call,args=[]){
  if(mode!=='opid'||!MESSAGE_CALLS.has(call))return null;
  return client[call](...args,{cookie:req.headers.cookie||'',...meta(req)});
}
export const outCookies=(list,res)=>cookieOut(list,res);
// After OneProfileID verified the person (password + 2FA, or passkey via SSO): confirm the central
// session and this app's membership, then open the app session. Returns {status, error} or
// {status:200, user}, plus every cookie to send.
async function complete(req,set){
  let r=await client.request('/get-session',{cookie:merged(req,set),...meta(req)});
  // Owner bootstrap: the owner's first verified sign-in claims the app's "owner" membership.
  // Invited people claim their own membership (the invite's localId). With open sign-up
  // (FLOW_OPEN_SIGNUP, on by default) anyone else claims a membership of their own, until FLOW_MAX_USERS.
  const email=String(r.payload?.user?.email||'').toLowerCase();
  let refusal=null;
  if(r.ok&&r.payload?.user?.id&&!r.payload.memberships?.length&&!r.payload.twoFactorRedirect&&!r.payload.enrollmentRequired){
    const claim=async(localId,claimedEmail)=>{const c=await client.request('/membership/claim',{body:{localId,...(claimedEmail?{claimedEmail}:{})},cookie:merged(req,set),...meta(req)});set=[...set,...c.cookies];return c};
    let ok=false,tried=false;
    // Repeated sign-ins by one person are limited before anything is asked of OneProfileID.
    if(!userLimit.take('u:'+r.payload.user.id))return {status:429,code:'busy',error:'Too many sign-in attempts. Wait a minute, then try again.',email,set};
    if(email===OWNER_EMAIL){tried=true;ok=(await claim('owner',email)).ok}
    else{
      // At most one claim per sign-in. First the open invite for the verified login email (OneProfileID
      // checks that claimedEmail is the signed-in person's own); owner invites are let in even when full.
      const own=await invites.find(email);
      if(own&&!own.revokedAt&&!own.claimedAt){tried=true;if((await claim(own.localId,own.email)).ok){ok=true;await invites.claimed(own.email)}}
    }
    if(!ok&&!tried&&email!==OWNER_EMAIL&&OPEN_SIGNUP){
      if(CAPS.maxUsers&&await users.count()>=CAPS.maxUsers)refusal={code:'full',error:'Flow is full right now.'};
      else{
        const c=await claim(selfLocalId(r.payload.user.id));
        if(c.ok)ok=true;
        // OneProfileID only lets an app enroll people without an invitation when its registration
        // allows self-enrollment; until then Flow stays invite-only.
        else if(c.status===403)refusal={code:'closed',error:'Flow is invite-only right now.'};
      }
    }
    if(ok)r=await client.request('/get-session',{cookie:merged(req,set),...meta(req)});
  }
  if(!r.ok||!r.payload?.user?.id)return {status:401,error:'Sign-in could not be confirmed. Try again.',set};
  if(r.payload.twoFactorRedirect||r.payload.enrollmentRequired)return {status:401,error:'Finish two-factor verification first.',set};
  if(!r.payload.memberships?.length){
    const why=refusal||(OPEN_SIGNUP?{code:'failed',error:'Sign-in did not complete.'}:{code:'denied',error:'Flow is invite-only right now.'});
    return {status:403,code:why.code,error:`${why.error} You are signed in to OneProfileID as ${email}.`,email,set};
  }
  const sid=randomBytes(32).toString('base64url'),user=person(r.payload.user);
  try{await users.seen(user,{existing:user.email===OWNER_EMAIL||await hasData(user.email)})}catch(e){console.error('users: could not record a sign-in',e?.message)}
  await sessions.set(sid,{user,created:Date.now(),last:Date.now()});
  return {status:200,user,set:[...set,sidCookie(sid,MAX/1000)]};
}
// A person's own membership id under open sign-up: stable per OneProfileID account, never 'owner'.
export const selfLocalId=id=>'s-'+createHash('sha256').update('flow-member\0'+id).digest('base64url').slice(0,22);
device=sso&&env.OPID_DEVICE_SIGN_IN!=='off'?createDeviceSignIn({issuer:env.OPID_SSO_ISSUER||'https://auth.oneprofileid.com/api/auth',clientId:env.OPID_SSO_CLIENT_ID,
  clientSecret:env.OPID_SSO_CLIENT_SECRET,native:client,complete,secure}):null;
async function finish(req,res,set){
  const o=await complete(req,set);
  json(res,o.status,o.user?{mode,user:o.user}:{error:o.error,...(o.code?{code:o.code}:{}),...(o.email?{email:o.email}:{})},o.set);
}
const redirect=(res,to,setCookie=[])=>{res.writeHead(303,{Location:to,'Cache-Control':'no-store',...(setCookie.length?{'Set-Cookie':cookieOut(setCookie,res)}:{})});res.end()};
function step(res,r){
  const p=r.payload||{};
  if(p.enrollmentRequired)return json(res,200,{step:'enroll',error:'Set up two-factor sign-in for your OneProfileID account first, then sign in here.'},r.cookies),true;
  if(p.twoFactorRedirect||p.verificationRequired)return json(res,200,{step:'verify'},r.cookies),true;
  return false;
}

// /api/auth/* routes. readJson(req,res,fn) parses a small JSON body.
export async function handle(req,res,readJson){
  const url=req.url.split('?')[0];
  if(!url.startsWith('/api/auth/'))return false;
  // Per-address limits: the session check (every page load) and phone polling get roomier buckets.
  const ip=requestIp(req),bucket=url==='/api/auth/session'?sessionLimit:url==='/api/auth/device/poll'?pollLimit:ipLimit;
  if(!bucket.take(ip)){
    if(req.method==='GET'&&url.startsWith('/api/auth/sso/'))redirect(res,'/?signin=busy');
    else{res.setHeader('Retry-After','60');json(res,429,{error:'Too many sign-in attempts. Wait a minute, then try again.',code:'busy'})}
    return true;
  }
  if(req.method==='GET'&&url==='/api/auth/session'){const user=await userFor(req,{touch:new URL(req.url,'http://local').searchParams.get('refresh')!=='1'});json(res,200,{mode,user,sso:!!sso,device:!!device,openSignup:OPEN_SIGNUP,accountUrl:mode==='opid'?ACCOUNT_URL:''});return true}
  // Who is signed in to OneProfileID here without a Flow session (after a refused sign-in): the screen
  // names that email. Only this browser's own cookie is used.
  if(req.method==='GET'&&url==='/api/auth/pending'){
    if(mode!=='opid'){json(res,200,{email:null});return true}
    const r=await client.request('/get-session',{cookie:req.headers.cookie||'',...meta(req)});
    json(res,200,r.ok&&r.payload?.user?.id?{email:String(r.payload.user.email||'').toLowerCase(),name:r.payload.user.name||''}:{email:null});return true;
  }
  if(req.method==='GET'&&url==='/api/auth/sso/start'){
    if(!sso){json(res,404,{error:'Not found'});return true}
    try{
      const resume=new URL(req.url,'http://x').searchParams.get('resume')==='1';
      const {url:to,cookie}=await sso.start({returnTo:'/',cookie:req.headers.cookie||'',resume});
      redirect(res,to,[cookie]);
    }catch{redirect(res,'/?signin=unavailable')}
    return true;
  }
  if(req.method==='GET'&&url==='/api/auth/sso/callback'){
    if(!sso){json(res,404,{error:'Not found'});return true}
    let clear=[];
    try{
      const {result,returnTo,clearCookie}=await sso.callback({url:`${origin}${req.url}`,cookie:req.headers.cookie||'',...meta(req)});
      clear=[clearCookie];
      if(!result.ok){redirect(res,`/?signin=${result.status===403?'denied':'failed'}`,clear);return true}
      const o=await complete(req,result.cookies);
      if(o.user)redirect(res,returnTo||'/',[...clear,...o.set]);
      else redirect(res,`/?signin=${o.code||(o.status===403?'denied':'failed')}`,[...clear,...o.set]);
    }catch{redirect(res,'/?signin=expired',clear)}
    return true;
  }
  if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true}
  if(mode==='local'){json(res,400,{error:'Sign-in is not configured; this app runs in local mode.'});return true}
  if(url.startsWith('/api/auth/device/')){
    if(!device){json(res,404,{error:'Not found'});return true}
    const action={'/api/auth/device/start':'start','/api/auth/device/poll':'poll','/api/auth/device/cancel':'cancel'}[url];
    if(!action){json(res,404,{error:'Not found'});return true}
    try{const o=await device[action](req,{ip:clientIp(req),userAgent:meta(req).userAgent});json(res,o.status,o.body,o.set)}
    catch{json(res,500,{error:'Sign-in failed. Try again.'})}
    return true;
  }
  readJson(req,res,async body=>{
    try{
      if(url==='/api/auth/profile/image'){
        const user=await userFor(req);
        if(!user)return json(res,401,{error:'Sign in to change your account photo.'});
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'image')||(body.image!==null&&!(typeof body.image==='string'&&body.image.length<=750000&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(body.image))))return json(res,400,{error:'Choose a PNG, JPEG or WebP photo.'});
        const r=await client.setAccountImage(body.image,{cookie:req.headers.cookie||'',...meta(req)});
        return json(res,r.status,r.ok?{image:safeImage(r.payload.image)||null}:{error:r.payload?.error||'Could not save your account photo.'},r.cookies);
      }
      if(url==='/api/auth/sign-in'){
        if(typeof body?.email!=='string'||typeof body.password!=='string'||!body.email.trim()||!body.password)return json(res,400,{error:'Enter your email and password.'});
        if(!userLimit.take('e:'+body.email.trim().toLowerCase()))return json(res,429,{error:'Too many sign-in attempts. Wait a minute, then try again.',code:'busy'});
        const r=await client.request('/sign-in/email',{body:{email:body.email.trim().toLowerCase(),password:body.password},cookie:req.headers.cookie||'',...meta(req)});
        if(!r.ok)return json(res,[400,401,403,429].includes(r.status)?r.status:503,{error:r.status===401?'Incorrect email or password.':r.payload?.error||'Sign-in failed. Try again.'},r.cookies);
        if(step(res,r))return;
        return finish(req,res,r.cookies);
      }
      if(url==='/api/auth/two-factor'){
        const code=String(body?.code||'').trim();if(!/^[A-Za-z0-9-]{4,32}$/.test(code))return json(res,400,{error:'Enter the code from your authenticator app.'});
        const route=/^\d{6}$/.test(code)?'/two-factor/verify-totp':'/two-factor/verify-backup-code';
        const r=await client.request(route,{body:{code,trustDevice:!!body.trust},cookie:req.headers.cookie||'',...meta(req)});
        if(!r.ok)return json(res,r.status===503?503:401,{error:r.status===503?r.payload?.error:'That code did not work. Try again.'},r.cookies);
        return finish(req,res,r.cookies);
      }
      // "Tell me when there is room": records the signed-in OneProfileID email (never a typed one).
      if(url==='/api/auth/request-access'){
        const r=await client.request('/get-session',{cookie:req.headers.cookie||'',...meta(req)});
        if(!r.ok||!r.payload?.user?.id)return json(res,401,{error:'Sign in with OneProfileID first.'});
        const email=String(r.payload.user.email||'').toLowerCase();
        await requests.add({email,name:r.payload.user.name,reason:typeof body?.reason==='string'?body.reason:''});
        return json(res,200,{requested:true,email});
      }
      if(url==='/api/auth/sign-out'){
        const sid=cookies(req)[SID];if(sid)await sessions.delete(sid);
        const r=await client.request('/sign-out',{body:{},cookie:req.headers.cookie||'',...meta(req)});
        return json(res,200,{signedOut:true},[...r.cookies,sidCookie('',0)]);
      }
      json(res,404,{error:'Not found'});
    }catch{json(res,500,{error:url==='/api/auth/profile/image'?'Could not save your account photo. Try again.':'Sign-in failed. Try again.'})}
  });
  return true;
}
