// OneProfileID native sign-in for Flygon Flow (OneProfileID docs/native-auth.md).
//
// Off unless all OPID_* variables are set; then the app runs in local single-user mode exactly as
// before, as FLOW_LOCAL_EMAIL (default: the owner). With them set:
//   - the browser posts email/password to this server, which calls OneProfileID's internal API with
//     the app's id + secret (never sent to the browser) and forwards OneProfileID's Set-Cookie headers;
//   - two-factor challenges are completed with a TOTP or recovery code before any session exists;
//   - after verification the server fetches /get-session, requires a membership for this app and
//     creates its own httpOnly SameSite=Lax session cookie (Secure on https);
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
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createNativeClient,filterCookies}=require('./opid-client.cjs');
const {createSsoClient}=require('./opid-sso-client.cjs');
import {sessionStore} from './sessions.mjs';

// The owner: owns Default workspace and may bootstrap their own membership on first sign-in.
export const OWNER_EMAIL=(process.env.OWNER_EMAIL||'owner@example.test').trim().toLowerCase();
const env=process.env,SID='flow_sid',IDLE=12*3600e3,MAX=7*24*3600e3;
const configured=['OPID_BASE_URL','OPID_APP_ID','OPID_APP_SECRET','OPID_APP_ORIGIN'].filter(k=>env[k]);
if(configured.length&&configured.length<4)throw Error('OneProfileID is partly configured: set OPID_BASE_URL, OPID_APP_ID, OPID_APP_SECRET and OPID_APP_ORIGIN together, or none of them');
const origin=env.OPID_APP_ORIGIN||'';
export const mode=configured.length?'opid':'local';
export const appOrigin=origin;
const secure=origin.startsWith('https:');
// Fails at startup (without echoing values) if the configuration is unusable.
const client=mode==='opid'?createNativeClient({baseURL:env.OPID_BASE_URL,appId:env.OPID_APP_ID,secret:env.OPID_APP_SECRET,origin,production:secure}):null;
const sso=mode==='opid'&&env.OPID_SSO_CLIENT_ID&&env.OPID_SSO_CLIENT_SECRET?createSsoClient({
  issuer:env.OPID_SSO_ISSUER||'https://auth.oneprofileid.com/api/auth',clientId:env.OPID_SSO_CLIENT_ID,clientSecret:env.OPID_SSO_CLIENT_SECRET,
  redirectUri:`${origin}/api/auth/sso/callback`,nativeBaseURL:env.OPID_BASE_URL,appId:env.OPID_APP_ID,nativeSecret:env.OPID_APP_SECRET,origin,production:secure}):null;
export const localUser={id:'local',email:(env.FLOW_LOCAL_EMAIL||OWNER_EMAIL).toLowerCase(),name:env.FLOW_LOCAL_NAME||'Example Owner',image:'',local:true};

// Sessions: memory by default; server.mjs plugs in the Postgres-backed store (lib/sessions.mjs).
let sessions=sessionStore({max:MAX});
export const useSessionStore=s=>{sessions=s};
// App invites (lib/invites.mjs), plugged in by server.mjs; none without it.
let invites={find:async()=>null,claimed:async()=>{}};
export const useInvites=i=>{invites=i};
export const SESSION_MAX=MAX;
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(p=>p.trim()).filter(Boolean).map(p=>[p.slice(0,p.indexOf('=')),p.slice(p.indexOf('=')+1)]));
const sidCookie=(v,age)=>`${SID}=${v}; Path=/; HttpOnly; SameSite=Lax${secure?'; Secure':''}; Max-Age=${age}`;
const json=(res,code,body,setCookie=[])=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store',...(setCookie.length?{'Set-Cookie':setCookie}:{})});res.end(JSON.stringify(body))};
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
// After OneProfileID verified the person (password + 2FA, or passkey via SSO): confirm the central
// session and this app's membership, then open the app session. Returns {status, error} or
// {status:200, user}, plus every cookie to send.
async function complete(req,set){
  let r=await client.request('/get-session',{cookie:merged(req,set),...meta(req)});
  // Owner bootstrap: the owner's first verified sign-in claims the app's "owner" membership.
  // Anyone else without a membership is refused below.
  // Invited people claim their own membership (the invite's localId) the same way.
  const email=String(r.payload?.user?.email||'').toLowerCase();
  if(r.ok&&r.payload?.user?.id&&!r.payload.memberships?.length&&!r.payload.twoFactorRedirect&&!r.payload.enrollmentRequired){
    const claim=async(localId,claimedEmail)=>{const c=await client.request('/membership/claim',{body:{localId,claimedEmail},cookie:merged(req,set),...meta(req)});set=[...set,...c.cookies];return c.ok};
    let ok=false;
    if(email===OWNER_EMAIL)ok=await claim('owner',email);
    else{
      // An invite may name the verified login email or one of its aliases. OneProfileID resolves
      // claimedEmail to the signed-in identity and refuses any address that is not theirs, so
      // trying the open invites one by one can only ever match this person's own.
      const own=await invites.find(email),open=own&&!own.revokedAt&&!own.claimedAt?[own]:[];
      for(const i of open.length?open:(await invites.listOpen()).slice(0,25)){if(await claim(i.localId,i.email)){ok=true;await invites.claimed(i.email);break}}
    }
    if(ok)r=await client.request('/get-session',{cookie:merged(req,set),...meta(req)});
  }
  if(!r.ok||!r.payload?.user?.id)return {status:401,error:'Sign-in could not be confirmed. Try again.',set};
  if(r.payload.twoFactorRedirect||r.payload.enrollmentRequired)return {status:401,error:'Finish two-factor verification first.',set};
  if(!r.payload.memberships?.length)return {status:403,error:'This OneProfileID account does not have access to Flygon Flow.',set};
  const sid=randomBytes(32).toString('base64url'),user=person(r.payload.user);
  await sessions.set(sid,{user,created:Date.now(),last:Date.now()});
  return {status:200,user,set:[...set,sidCookie(sid,MAX/1000)]};
}
async function finish(req,res,set){
  const o=await complete(req,set);
  json(res,o.status,o.user?{mode,user:o.user}:{error:o.error},o.set);
}
const redirect=(res,to,setCookie=[])=>{res.writeHead(303,{Location:to,'Cache-Control':'no-store',...(setCookie.length?{'Set-Cookie':setCookie}:{})});res.end()};
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
  if(req.method==='GET'&&url==='/api/auth/session'){const user=await userFor(req,{touch:new URL(req.url,'http://local').searchParams.get('refresh')!=='1'});json(res,200,{mode,user,sso:!!sso});return true}
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
      else redirect(res,`/?signin=${o.status===403?'denied':'failed'}`,[...clear,...o.set]);
    }catch{redirect(res,'/?signin=expired',clear)}
    return true;
  }
  if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true}
  if(mode==='local'){json(res,400,{error:'Sign-in is not configured; this app runs in local mode.'});return true}
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
