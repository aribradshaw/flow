// "Sign in with your phone": OAuth 2.0 device authorization (RFC 8628) against OneProfileID, for
// screens that cannot use passkeys (kiosk web views, TVs). OneProfileID docs/passkeys-sso.md,
// "Screens without passkeys".
//
//   1. POST /api/auth/device/start: this server asks OneProfileID for a device code with the app's
//      OAuth client credentials (never sent to the browser), keeps the device code in memory and gives
//      the browser an httpOnly cookie naming the pending sign-in, plus the user code, the
//      verification URL and a QR code of it (SVG, drawn here).
//   2. The person scans it, signs in on their phone and approves with a passkey (OneProfileID requires
//      a fresh passkey or authenticator proof for this).
//   3. POST /api/auth/device/poll: only the browser holding the cookie can poll. This server polls
//      OneProfileID's token endpoint no faster than the interval it set (slower after slow_down),
//      and once approved sends the token to the native gateway (/sso/device-exchange), which opens a
//      OneProfileID session for this screen. complete() then runs the same membership checks as every
//      other sign-in and opens Flow's session. Each pending sign-in completes at most once.
// Nothing here logs codes, tokens or cookies.
import {randomBytes} from 'node:crypto';
import {renderSVG} from 'uqr';

const COOKIE='flow_device',SCOPE='openid profile email opid:session',MAX_PENDING=500;
const DEVICE_GRANT='urn:ietf:params:oauth:grant-type:device_code';

// A sliding-window counter per key.
function limiter(max,windowMs){
  const hits=new Map();
  return key=>{
    const now=Date.now(),list=(hits.get(key)||[]).filter(t=>now-t<windowMs);
    if(list.length>=max){hits.set(key,list);return false}
    list.push(now);hits.set(key,list);
    if(hits.size>5000)for(const [k,v] of hits)if(!v.some(t=>now-t<windowMs))hits.delete(k);
    return true;
  };
}

export function createDeviceSignIn({issuer,clientId,clientSecret,native,complete,secure=true,fetchImpl=fetch,now=()=>Date.now(),
  startLimit=limiter(10,10*60e3),pollLimit=limiter(120,60e3)}){
  const base=new URL(issuer);
  if(base.username||base.password||base.search||base.hash||(secure&&base.protocol!=='https:')||!clientId||typeof clientSecret!=='string'||clientSecret.length<32)throw new Error('Invalid OneProfileID device sign-in configuration');
  const endpoint=path=>new URL(base.pathname.replace(/\/+$/,'')+path,base.origin);
  const basic='Basic '+Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
  const pending=new Map();
  const cookie=(value,age)=>`${COOKIE}=${value}; Path=/api/auth/device; HttpOnly; SameSite=Lax${secure?'; Secure':''}; Max-Age=${age}`;
  const clear=cookie('',0);
  const idFrom=req=>{const m=/(?:^|;\s*)flow_device=([A-Za-z0-9_-]{43})(?:;|$)/.exec(String(req.headers.cookie||''));return m?.[1]||null};
  const sweep=()=>{const t=now();for(const [k,v] of pending)if(v.expires<=t||v.done)pending.delete(k)};
  async function form(path,fields){
    const r=await fetchImpl(endpoint(path),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json',authorization:basic},
      body:new URLSearchParams(fields),signal:AbortSignal.timeout(8000),redirect:'error'});
    let body={};try{body=await r.json()}catch{}
    return {status:r.status,ok:r.ok,body:body&&typeof body==='object'?body:{}};
  }
  const verificationOk=value=>{try{const u=new URL(value);return u.protocol==='https:'||(!secure&&u.protocol==='http:')}catch{return false}};

  return {
    COOKIE,
    // -> {status, body, set}
    async start(req,{ip=''}={}){
      sweep();
      if(!startLimit(ip||'unknown')||pending.size>=MAX_PENDING)return {status:429,body:{error:'Too many sign-in attempts. Wait a few minutes and try again.'},set:[]};
      let r;try{r=await form('/device/code',{client_id:clientId,scope:SCOPE})}catch{r={status:503,body:{}}}
      const b=r.body;
      if(!r.ok||typeof b.device_code!=='string'||typeof b.user_code!=='string'||!verificationOk(b.verification_uri)||!(b.expires_in>0))
        return {status:503,body:{error:'Sign in with your phone is unavailable right now. Try again shortly.'},set:[]};
      const link=verificationOk(b.verification_uri_complete)?b.verification_uri_complete:`${b.verification_uri}?user_code=${encodeURIComponent(b.user_code)}`;
      const expiresIn=Math.min(Math.floor(b.expires_in),1800),interval=Math.max(5,Math.min(Math.floor(b.interval)||5,60));
      // Replace this browser's earlier pending sign-in, if any.
      const old=idFrom(req);if(old)pending.delete(old);
      const id=randomBytes(32).toString('base64url');
      pending.set(id,{deviceCode:b.device_code,expires:now()+expiresIn*1000,interval,next:now()+interval*1000,busy:false,done:false});
      return {status:200,set:[cookie(id,expiresIn)],body:{userCode:b.user_code,verificationUri:b.verification_uri,verificationUriComplete:link,
        expiresIn,interval,qr:renderSVG(link,{ecc:'M',border:2,pixelSize:8,whiteColor:'#ffffff',blackColor:'#1b2a1c'})}};
    },
    async poll(req,{ip='',userAgent=''}={}){
      const id=idFrom(req),p=id&&pending.get(id),t=now();
      if(!p||p.done)return {status:404,body:{status:'missing',error:'This sign-in is no longer active. Start again.'},set:id?[clear]:[]};
      if(p.expires<=t){pending.delete(id);return {status:410,body:{status:'expired',error:'The code expired. Get a new one.'},set:[clear]}}
      if(!pollLimit(ip||'unknown'))return {status:429,body:{status:'pending',interval:p.interval,error:'Too many requests.'},set:[]};
      // Never poll OneProfileID faster than it allows; the browser just hears "still waiting".
      if(p.busy||t<p.next)return {status:200,body:{status:'pending',interval:p.interval,retryIn:Math.max(1,Math.ceil((p.next-t)/1000))},set:[]};
      p.busy=true;
      try{
        let r;try{r=await form('/oauth2/token',{grant_type:DEVICE_GRANT,device_code:p.deviceCode,client_id:clientId})}catch{r={status:503,body:{}}}
        p.next=now()+p.interval*1000;
        const error=r.body.error;
        if(!r.ok){
          if(error==='authorization_pending')return {status:200,body:{status:'pending',interval:p.interval},set:[]};
          if(error==='slow_down'){p.interval=Math.min(p.interval+5,60);p.next=now()+p.interval*1000;return {status:200,body:{status:'pending',interval:p.interval},set:[]}}
          if(error==='access_denied'){pending.delete(id);return {status:403,body:{status:'denied',error:'The sign-in was declined on the phone.'},set:[clear]}}
          if(error==='expired_token'){pending.delete(id);return {status:410,body:{status:'expired',error:'The code expired. Get a new one.'},set:[clear]}}
          if(r.status>=500||!error)return {status:200,body:{status:'pending',interval:p.interval},set:[]};
          pending.delete(id);return {status:400,body:{status:'failed',error:'Sign-in did not complete. Start again.'},set:[clear]};
        }
        // Approved. The device code is spent either way; this pending sign-in ends here.
        p.done=true;pending.delete(id);
        if(typeof r.body.access_token!=='string')return {status:400,body:{status:'failed',error:'Sign-in did not complete. Start again.'},set:[clear]};
        const x=await native.request('/sso/device-exchange',{body:{clientId,accessToken:r.body.access_token},ip,userAgent});
        if(!x.ok||!x.payload?.user?.id)return {status:x.status===503?503:400,body:{status:'failed',error:'Sign-in did not complete. Start again.'},set:[clear,...x.cookies]};
        const o=await complete(req,x.cookies);
        if(!o.user)return {status:o.status,body:{status:o.status===403?'refused':'failed',error:o.error},set:[clear,...o.set]};
        return {status:200,body:{status:'done',user:o.user},set:[clear,...o.set]};
      }finally{p.busy=false}
    },
    cancel(req){const id=idFrom(req);if(id)pending.delete(id);return {status:200,body:{cancelled:true},set:[clear]}},
    get size(){sweep();return pending.size},
  };
}
