#!/usr/bin/env node
// Onboarding eval: how far new people get, from the link they were sent to a chart with a card they made.
//
// Runs Flow in OneProfileID mode (SSO on) against a loopback mock of OneProfileID: its internal API,
// an OIDC issuer and small hosted sign-in / create-account pages that behave like the real ones. A
// headless Chromium (as verify.mjs finds it) walks each persona through the real Flow UI. Synthetic
// users and temp folders only; nothing talks to the real OneProfileID or any database.
//
//   node tools/onboarding-eval.mjs [--label <name>] [--out <dir>] [--opid-invites on|off] [--opid-self-enroll on|off]
//   npm run eval:onboarding -- --label baseline
//
// Each run appends one JSON row ({at, label, commit, flags, personas:[...], total}) to <out>/runs.jsonl
// (default ./onboarding-evals, or FLOW_EVAL_OUT) and prints a table. Temp files go under TMPDIR.
//
// Per persona:
//   reach       ended with a chart that holds at least one card they made (checked on the server)
//   steps       clicks + submits from opening the link to that first card (typing is free)
//   deadEnds    error screens with no control that changes the outcome; an identical-result retry counts
//   falseDoors  sign-in options on screen that cannot work for this persona's account
//               (phone needs a passkey, the password form needs a password)
//   copy        firstScreen: the first screen names the product and who can use it
//               errors: every error names the signed-in email and a next step (passes if none shown)
//               firstRun: the first run shows a starter or a canvas hint
//               distinct: denied, expired and failed read differently
//   guard       the persona's browser gets no data from the owner's Default workspace (404/401)
// score = 50×reach + 3×max(0, 8−steps) + 10 per zero metric (dead ends, false doors) + 5 per copy check.
// A persona that fails the guard is rejected (score null) and the run is marked rejected.
import {spawn,execFileSync} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,appendFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,generateKeyPairSync,createSign} from 'node:crypto';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:d};
const LABEL=arg('label','run'),OUT=resolve(arg('out',process.env.FLOW_EVAL_OUT||join(ROOT,'onboarding-evals')));
const FLAGS={selfEnroll:arg('opid-self-enroll','on')==='on',invites:arg('opid-invites','on')==='on'};
const MOCK=Number(process.env.FLOW_EVAL_MOCK_PORT||4486),APP=MOCK+1,CDP=MOCK+2;
const BASE=`http://127.0.0.1:${APP}`,ISSUER=`http://localhost:${MOCK}/api/auth`,HOSTED=`http://localhost:${MOCK}`;
const APP_ID='flygon-flow-eval',SECRET='synthetic-eval-secret-0123456789abcdef',SSO_ID='flow-sso-eval',SSO_SECRET='synthetic-eval-sso-secret-0123456789abcdef';
const OWNER='owner@example.test',TOKEN='synthetic-eval-owner-token-0123456789abcdef';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// The fake clock: Flow's server and the mock both move ahead together (see the slow signer).
let clockOffset=0;const now=()=>Date.now()+clockOffset;

// ---------- mock OneProfileID ----------
// Accounts by primary email: {id, name, email, aliases, password, passkey, members:{localId}}.
function mockOpid(){
  const users=new Map(),sessions=new Map(),hosted=new Map(),requests=new Map(),codes=new Map(),tokens=new Map(),invites=new Map();
  const stats={claims:0,invites:0};let n=0;
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'k1',alg:'RS256',use:'sig'};
  const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt=claims=>{const h=b64({alg:'RS256',typ:'JWT',kid:'k1'}),p=b64(claims),s=createSign('RSA-SHA256').update(h+'.'+p).sign(privateKey).toString('base64url');return `${h}.${p}.${s}`};
  const add=u=>{users.set(u.email,{aliases:[],password:'',passkey:false,member:null,...u,id:u.id||'u-'+(++n)});return users.get(u.email)};
  const resolveEmail=e=>{e=String(e||'').toLowerCase();for(const u of users.values())if(u.email===e||u.aliases.includes(e))return u;return null};
  const identity=u=>({user:{id:u.id,email:u.email,name:u.name,image:null},session:{id:'s-'+u.id},memberships:u.member?[{localId:u.member}]:[]});
  const cookieOf=(req,name)=>(String(req.headers.cookie||'').match(new RegExp(`(?:^|; )${name.replace('.','\\.')}=([^;]+)`))||[])[1];
  const page=(res,title,body,set=[])=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8',...(set.length?{'set-cookie':set}:{})});
    res.end(`<!doctype html><title>OneProfileID</title><main data-page="${title}"><h1>${title}</h1>${body}</main>`)};
  const go=(res,to,set=[])=>{res.writeHead(303,{location:to,...(set.length?{'set-cookie':set}:{})});res.end()};
  const backToApp=(res,reqId,u)=>{
    const r=requests.get(reqId);
    if(!r)return page(res,"You're signed in",'<p>This sign-in request has ended. Return to your app to start a fresh request.</p>');
    const code='c-'+randomUUID();codes.set(code,{u,r});requests.delete(reqId);
    const to=new URL(r.redirect_uri);to.searchParams.set('code',code);to.searchParams.set('state',r.state);to.searchParams.set('iss',ISSUER);
    page(res,'Returning to Flygon Flow',`<script>location.assign(${JSON.stringify(to.href)})</script>`);
  };
  const signedIn=(res,reqId,u)=>{const t='h-'+randomUUID();hosted.set(t,u);const set=[`opid_hosted=${t}; Path=/; HttpOnly; SameSite=Lax`];
    const r=requests.get(reqId);if(!r)return page(res,"You're signed in",'<p>Return to your app.</p>',set);
    const code='c-'+randomUUID();codes.set(code,{u,r});requests.delete(reqId);
    const to=new URL(r.redirect_uri);to.searchParams.set('code',code);to.searchParams.set('state',r.state);to.searchParams.set('iss',ISSUER);
    page(res,'Returning to Flygon Flow',`<script>location.assign(${JSON.stringify(to.href)})</script>`,set)};
  const srv=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const u=new URL(req.url,HOSTED),path=u.pathname,form=Object.fromEntries(new URLSearchParams(body));
    // OIDC issuer
    if(path==='/api/auth/.well-known/openid-configuration')return send(200,{issuer:ISSUER,authorization_endpoint:ISSUER+'/oauth2/authorize',token_endpoint:ISSUER+'/oauth2/token',jwks_uri:ISSUER+'/jwks',
      device_authorization_endpoint:ISSUER+'/device/code',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']});
    if(path==='/api/auth/jwks')return send(200,{keys:[jwk]});
    if(path==='/api/auth/oauth2/authorize'){
      const r=Object.fromEntries(u.searchParams),id='r-'+randomUUID();requests.set(id,r);
      const h=hosted.get(cookieOf(req,'opid_hosted'));
      // An existing OneProfileID browser session returns straight to the app, with no prompt.
      if(h)return backToApp(res,id,h);
      return go(res,`/sign-in?req=${id}`);
    }
    if(path==='/api/auth/oauth2/token'){
      const basic=Buffer.from(String(req.headers.authorization||'').replace(/^Basic /,''),'base64').toString().split(':').map(decodeURIComponent);
      if(basic[0]!==SSO_ID||basic[1]!==SSO_SECRET){if(process.env.FLOW_EVAL_LOG)console.error('token: bad client',req.headers.authorization);return send(401,{error:'invalid_client'})}
      const c=codes.get(form.code);if(!c){if(process.env.FLOW_EVAL_LOG)console.error('token: unknown code',form);return send(400,{error:'invalid_grant'})}codes.delete(form.code);
      const at='at-'+randomUUID();tokens.set(at,c.u);const t=Math.floor(now()/1000);
      return send(200,{access_token:at,token_type:'Bearer',expires_in:300,id_token:jwt({iss:ISSUER,sub:c.u.id,aud:SSO_ID,iat:t,exp:t+300,nonce:c.r.nonce,email:c.u.email})});
    }
    if(path==='/api/auth/device/code')return send(503,{error:'unavailable'});
    // Hosted pages (like auth.oneprofileid.com): Welcome Back, Make an account, emailed code.
    const reqId=u.searchParams.get('req')||form.req||'';
    const hid=`<input type="hidden" name="req" value="${reqId}">`;
    if(path==='/sign-in'&&req.method==='GET')return page(res,'Welcome Back',`<form method="post" action="/sign-in" data-form="email">${hid}<label>Email <input name="email" type="email"></label><button type="submit">Continue</button></form>
      <p>New to OneProfileID? <a href="/create-account?req=${reqId}" data-link="create">Make an account</a></p>`);
    if(path==='/sign-in'&&req.method==='POST'){
      const acct=resolveEmail(form.email);
      if(!acct||!acct.password)return page(res,'Welcome Back',`<p class="err">No password for that account.</p><a href="/create-account?req=${reqId}" data-link="create">Make an account</a>`);
      return page(res,'Enter your password',`<form method="post" action="/sign-in/password" data-form="password">${hid}<input type="hidden" name="email" value="${acct.email}"><label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>`);
    }
    if(path==='/sign-in/password'&&req.method==='POST'){
      const acct=users.get(form.email);if(!acct||acct.password!==form.password)return page(res,'Enter your password','<p class="err">Incorrect password</p>');
      return signedIn(res,reqId,acct);
    }
    if(path==='/create-account'&&req.method==='GET')return page(res,'Create your account',`<form method="post" action="/create-account/age" data-form="age">${hid}<label>Date of birth <input name="dob" type="date" value="1990-01-01"></label><button type="submit">Continue</button></form>`);
    if(path==='/create-account/age')return page(res,'Create your account',`<form method="post" action="/create-account/details" data-form="details">${hid}<label>Name <input name="name"></label><label>Email <input name="email" type="email"></label><button type="submit">Email me a code</button></form>`);
    if(path==='/create-account/details')return page(res,'Check your email',`<form method="post" action="/create-account/code" data-form="code">${hid}<input type="hidden" name="name" value="${String(form.name||'').replace(/"/g,'')}"><input type="hidden" name="email" value="${String(form.email||'').replace(/"/g,'')}"><label>Code <input name="code"></label><button type="submit">Verify</button></form>`);
    if(path==='/create-account/code'){
      const email=String(form.email||'').toLowerCase();if(resolveEmail(email))return page(res,'Check your email','<p class="err">That email already has an account.</p>');
      // A new account: verified email, no password, no passkey (MFA is not forced at sign-up).
      return signedIn(res,reqId,add({email,name:form.name||email}));
    }
    if(path==='/dashboard')return page(res,'Your account',`<form method="post" action="/log-out" data-form="logout"><button type="submit">Log out</button></form>`);
    if(path==='/log-out'){hosted.delete(cookieOf(req,'opid_hosted'));return go(res,'/sign-in',['opid_hosted=; Path=/; Max-Age=0'])}
    // Internal API (what Flow's server calls).
    if(!path.startsWith('/internal/v1/auth/'))return send(404,{error:'Not found'});
    if(req.headers['x-opid-app']!==APP_ID||req.headers['x-opid-client-secret']!==SECRET)return send(401,{error:'Unauthorized application'});
    if(req.headers.origin!==BASE)return send(403,{error:'Invalid application origin'});
    const route=path.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{},me=sessions.get(cookieOf(req,'oneprofileid.session_token'));
    const newSession=acct=>{const t='s-'+randomUUID();sessions.set(t,acct);return [`oneprofileid.session_token=${t}; Path=/; HttpOnly; SameSite=Lax`]};
    if(route==='/sso/exchange'){const acct=tokens.get(b.accessToken);if(!acct||acct.id!==b.subject||b.clientId!==SSO_ID)return send(401,{error:'Invalid exchange'});tokens.delete(b.accessToken);return send(200,identity(acct),newSession(acct))}
    if(route==='/sign-in/email'){const acct=users.get(String(b.email||'').toLowerCase());if(!acct||!acct.password||acct.password!==b.password)return send(401,{error:'Invalid email or password'});return send(200,identity(acct),newSession(acct))}
    if(route==='/get-session')return me?send(200,identity(me)):send(401,{error:'No session'});
    if(route==='/sign-out'){sessions.delete(cookieOf(req,'oneprofileid.session_token'));return send(200,{success:true},['oneprofileid.session_token=; Path=/; Max-Age=0'])}
    if(route==='/membership/claim'){
      stats.claims++;
      if(!me)return send(401,{error:'Complete sign-in first'});
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(b.localId||''))return send(400,{error:'Invalid membership'});
      if(!FLAGS.selfEnroll&&typeof b.inviteToken!=='string')return send(403,{error:'Invitation required'});
      if('claimedEmail' in b&&resolveEmail(b.claimedEmail)!==me)return send(403,{error:'Sign in with the email used for this registration'});
      for(const x of users.values())if(x!==me&&x.member===b.localId)return send(409,{error:'Membership already belongs to another identity'});
      if(b.inviteToken){const i=invites.get(b.inviteToken);if(!i||i.localId!==b.localId||i.used||(i.used&&i.used!==me)||resolveEmail(i.email)!==me)return send(409,{error:'Membership already belongs to another identity'});i.used=me}
      me.member=b.localId;return send(200,{membership:{localId:b.localId}});
    }
    if(route==='/membership/invite'){
      stats.invites++;
      if(!FLAGS.invites)return send(403,{error:'Membership provisioning is unavailable'});
      if(req.headers.cookie&&!me)return send(401,{error:'Complete sign-in first'});
      if(me&&!me.member)return send(403,{error:'Invitation unavailable'});
      if(typeof b.email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))return send(403,{error:'Invitation unavailable'});
      for(const x of users.values())if(x.member===b.localId)return send(409,{error:'This membership already has an identity'});
      for(const [t,i] of invites)if(i.localId===b.localId&&!i.used)invites.delete(t);
      const token=randomUUID().replace(/-/g,'')+randomUUID().replace(/-/g,'');invites.set(token,{localId:b.localId,email:b.email.toLowerCase(),used:null});
      return send(200,{token,expiresAt:new Date(Date.now()+72*3600e3).toISOString()});
    }
    if(route==='/profile/member-images')return send(200,{images:{}});
    send(404,{error:'Not found'});
  })});
  return {srv,add,users,stats};
}

// ---------- Chromium over CDP (one browser, one context per persona) ----------
function findBrowser(){
  const home=process.env.HOME||'',pw=join(home,'.cache','ms-playwright');
  const fromPw=()=>{try{return readdirSync(pw).filter(d=>/^chromium-\d+$/.test(d)).sort((a,b)=>parseInt(b.split('-')[1])-parseInt(a.split('-')[1])).flatMap(d=>[join(pw,d,'chrome-linux64','chrome'),join(pw,d,'chrome-linux','chrome')])}catch{return []}};
  return [process.env.BROWSER,'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',...fromPw()].filter(Boolean).find(f=>existsSync(f));
}
async function browser(profile){
  const exe=findBrowser();if(!exe)throw Error('No Chromium found (set BROWSER=<path>)');
  const proc=spawn(exe,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--remote-debugging-port=${CDP}`,`--user-data-dir=${profile}`,'--no-first-run','about:blank'],{stdio:'ignore'});
  let ver;for(let i=0;i<80&&!ver;i++){try{ver=await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()}catch{}if(!ver)await sleep(150)}
  if(!ver)throw Error('Chromium did not start');
  const ws=new WebSocket(ver.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  let seq=0;const pending=new Map();
  ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.id&&pending.has(d.id)){pending.get(d.id)(d);pending.delete(d.id)}};
  const call=(method,params={},sessionId)=>new Promise((res,rej)=>{const id=++seq;pending.set(id,r=>r.error?rej(Error(method+' '+JSON.stringify(r.error))):res(r.result));ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))});
  return {call,close(){try{ws.close()}catch{}proc.kill()}};
}
async function newPage(b){
  const {browserContextId}=await b.call('Target.createBrowserContext',{disposeOnDetach:true});
  const {targetId}=await b.call('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId}=await b.call('Target.attachToTarget',{targetId,flatten:true});
  const call=(m,p)=>b.call(m,p,sessionId);
  await call('Runtime.enable');await call('Network.enable');
  // The shared OneProfileID button module comes from the internet: block it, so the page uses its
  // built-in button (the same action) and the eval stays offline and repeatable.
  await call('Network.setBlockedURLs',{urls:['*oneprofileid.flygonlc.com*']});
  const js=async x=>{try{const r=await call('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});return r.exceptionDetails?undefined:r.result.value}catch{return undefined}};
  return {js,goto:url=>call('Page.navigate',{url}),close:()=>b.call('Target.closeTarget',{targetId}).catch(()=>{}).then(()=>b.call('Target.disposeBrowserContext',{browserContextId}).catch(()=>{}))};
}

// ---------- the walk ----------
// What is on screen, read the same way for every version of the UI.
const SNAPSHOT=`(()=>{
  const vis=el=>!!el&&!el.closest('[hidden]')&&el.getClientRects().length>0;
  const txt=el=>(el?.innerText||'').trim();
  const loc={host:location.host,path:location.pathname,href:location.href};
  if(location.host===${JSON.stringify(`localhost:${MOCK}`)}){
    const pg=document.querySelector('main')?.dataset.page||'';
    return {...loc,where:'opid',page:pg,forms:[...document.querySelectorAll('form[data-form]')].map(f=>f.dataset.form),create:!!document.querySelector('[data-link=create]'),text:txt(document.body).slice(0,400)};
  }
  const gate=document.querySelector('.acct-gate');
  if(gate){
    const errs=[...gate.querySelectorAll('.acct-err,[data-gate-error]')].filter(vis).map(txt).filter(Boolean);
    const buttons=[...gate.querySelectorAll('button,a[href]')].filter(vis).map(b=>({text:txt(b)||b.getAttribute('aria-label')||'',sel:b.dataset.sso!==undefined?'[data-sso]':b.dataset.gateAction?'[data-gate-action="'+b.dataset.gateAction+'"]':''}));
    return {...loc,where:'gate',text:txt(gate.querySelector('.acct-gate-card')||gate).slice(0,1200),errors:errs,buttons,
      phone:vis(gate.querySelector('[data-phone]')),password:vis(gate.querySelector('[data-pw]'))||vis(gate.querySelector('#flow-login #acctPass')),
      sso:vis(gate.querySelector('[data-sso]'))||vis(gate.querySelector('opid-sign-in#acctSso'))};
  }
  const join=document.querySelector('[data-join]');
  if(join&&vis(join))return {...loc,where:'join',text:txt(join).slice(0,800)};
  const pick=document.querySelector('[data-firstrun]');
  const add=document.querySelector('#tools [data-add="entity"]');
  if(pick&&vis(pick))return {...loc,where:'firstrun',text:txt(pick).slice(0,600)};
  if(add&&vis(add)){const hint=document.querySelector('[data-canvas-hint]');return {...loc,where:'app',hint:vis(hint)?txt(hint):'',nodes:window.orgChartStudio?.getChart?.()?.nodes?.length??-1}}
  return {...loc,where:'loading',text:txt(document.body).slice(0,200)};
})()`;
const firstScreenOk=t=>/Flygon Flow/.test(t)&&/(free|anyone|invite|who can)/i.test(t);
const errorOk=(t,email)=>t.toLowerCase().includes(email.toLowerCase())&&/(different account|ask|request|leave your email|sign in with|try again|create)/i.test(t);

async function walk(page,persona,ctx){
  const out={persona:persona.key,reach:false,steps:0,deadEnds:0,falseDoors:0,errors:[],trail:[],copy:{firstScreen:false,errors:true,firstRun:false,distinct:ctx.distinct},firstScreenText:''};
  const step=(what)=>{out.steps++;out.trail.push(what)};
  // Actions that leave the page wait until the next document is there.
  const settle=async()=>{for(let k=0;k<40;k++){await sleep(150);if(await page.js('!window.__evalOld')===true)return}};
  const click=async(sel,nav=false)=>{step('click '+sel);const ok=await page.js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;window.__evalOld=true;el.click();return true})()`);if(ok&&nav)await settle();return ok};
  const submit=async(form,values={})=>{step('submit '+form);const ok=await page.js(`(()=>{window.__evalOld=true;const f=document.querySelector('form[data-form=${JSON.stringify(form)}]')||document.querySelector(${JSON.stringify(form)});if(!f)return false;for(const [k,v] of Object.entries(${JSON.stringify(values)})){const i=f.querySelector('[name='+JSON.stringify(k)+']')||f.querySelector(k);if(i)i.value=v}f.requestSubmit?f.requestSubmit():f.submit();return true})()`);if(ok)await settle();return ok};
  let snap=null,lastError='',firstGate=true,stuck=0,lastHref='',lastWhere='';
  await page.goto(persona.start);
  for(let i=0;i<60;i++){
    await sleep(350);
    snap=await page.js(SNAPSHOT);if(!snap){continue}
    const sig=snap.where+snap.href+(snap.errors||[]).join()+(snap.page||'');
    if(sig===lastHref&&snap.where!=='app'){if(++stuck>25){out.trail.push('stuck at '+snap.where);break}}else stuck=0;
    lastHref=sig;
    if(snap.where==='loading')continue;
    if(snap.where==='gate'){
      if(firstGate){firstGate=false;out.firstScreenText=snap.text;out.copy.firstScreen=firstScreenOk(snap.text);
        out.falseDoors=(snap.phone&&!persona.passkey?1:0)+(snap.password&&!persona.password?1:0)}
      if(snap.errors.length){
        const e=snap.errors.join(' ');
        if(e!==lastError||lastWhere!=='gate-error')out.errors.push(e);
        if(!errorOk(snap.text,persona.loginEmail||persona.email||''))out.copy.errors=false;
        if(e===lastError){out.deadEnds++;out.trail.push('same error again');if(out.deadEnds>=2)break}
        lastError=e;lastWhere='gate-error';
        // An error screen: take the first control that offers a way forward other than the same retry,
        // if the persona can use it; otherwise retry once with the primary button.
        const fwd=snap.buttons.find(b=>b.sel&&b.sel.startsWith('[data-gate-action="retry'));
        if(!(await click(fwd?.sel||'[data-sso]',true)))break;
        await sleep(400);continue;
      }
      lastWhere='gate';
      if(!(await click('[data-sso]',true))){out.trail.push('no primary sign-in button');break}
      await sleep(500);continue;
    }
    lastWhere=snap.where;
    if(snap.where==='join'){if(!(await click('[data-join] [data-sso], [data-join] [data-join-continue]',true))){out.trail.push('join without continue');break}await sleep(500);continue}
    if(snap.where==='opid'){
      if(snap.page==='Welcome Back'&&snap.forms.includes('email')){
        if(persona.password){await submit('email',{email:persona.loginEmail});continue}
        await click('[data-link=create]',true);continue;
      }
      if(snap.page==='Welcome Back'&&snap.create){await click('[data-link=create]',true);continue}
      if(snap.forms.includes('password')){await submit('password',{password:persona.password});continue}
      if(snap.forms.includes('age')){await submit('age',{dob:'1990-01-01'});continue}
      if(snap.forms.includes('details')){await submit('details',{name:persona.name,email:persona.loginEmail});continue}
      if(snap.forms.includes('code')){
        // The slow signer: six minutes pass on Flow's clock while they wait for the code.
        if(persona.slow){process.kill(ctx.app.pid,'SIGUSR2');clockOffset+=360000;await sleep(200);out.trail.push('six minutes pass')}
        await submit('code',{code:'123456'});continue;
      }
      if(snap.page==='Returning to Flygon Flow')continue;
      out.trail.push('opid page: '+snap.page);break;
    }
    if(snap.where==='firstrun'){
      out.copy.firstRun=true;
      if(!(await click('[data-firstrun] [data-firstrun-choice="blank"]'))){out.trail.push('first run without a blank choice');break}
      continue;
    }
    if(snap.where==='app'){
      if(snap.hint)out.copy.firstRun=true;
      if(persona.inviteFriend&&!persona.invited){
        persona.invited=true;
        // The member invites a friend from Settings › Account.
        await click('#acctBtn');await sleep(300);await click('[data-acct="settings"]');await sleep(600);
        await page.js(`document.querySelector('[data-tab="account"]')?.click()`);
        let form=false;for(let k=0;k<20&&!form;k++){await sleep(250);form=await page.js(`!!document.querySelector('[data-invite-form]')`)}
        if(!form){out.deadEnds++;out.trail.push('no invite form for members');break}
        await page.js(`document.querySelector('#inviteEmail').value=${JSON.stringify(persona.friend.loginEmail)}`);
        step('submit invite');await page.js(`document.querySelector('[data-invite-form]').requestSubmit()`);
        let sent='';for(let k=0;k<20&&!sent;k++){await sleep(300);sent=await page.js(`(()=>{const m=document.querySelector('[data-invite-msg]:not([hidden]),[data-invite-err]:not([hidden])');return m?m.innerText:''})()`)}
        out.trail.push('invite: '+sent);
        const link=ctx.mailLink(persona.friend.loginEmail);
        if(!link){out.trail.push('no invite email');break}
        // The friend opens the email in their own browser.
        const friendPage=await ctx.newPage();
        const f=await walk(friendPage,{...persona.friend,start:link},ctx);
        await friendPage.close();
        out.friend=f;out.reach=f.reach;out.steps+=f.steps;out.deadEnds+=f.deadEnds;out.falseDoors+=f.falseDoors;out.errors.push(...f.errors);
        out.copy={firstScreen:f.copy.firstScreen,errors:f.copy.errors,firstRun:f.copy.firstRun,distinct:ctx.distinct};out.guard=f.guard;
        return out;
      }
      // The first card: Add entity on the toolbar.
      if(!(await click('#tools [data-add="entity"]')))break;
      let saved=false;
      for(let k=0;k<40&&!saved;k++){await sleep(300);saved=await page.js(`(async()=>{const r=await fetch('/api/workspace',{cache:'no-store'});if(!r.ok)return false;const d=await r.json();return !!d.data&&d.owner&&d.data.charts.some(c=>c.nodes.length>0)})()`)}
      out.reach=!!saved;if(!saved)out.trail.push('card not saved on the server');
      break;
    }
  }
  out.guard=out.guard||await guard(page);
  return out;
}
async function guard(page){
  const r=await page.js(`(async()=>{const r=await fetch('/api/workspace?env=default-workspace',{cache:'no-store'});let d=null;try{d=await r.json()}catch{}return {status:r.status,data:!!d?.data}})()`);
  return {status:r?.status??0,pass:!!r&&r.status!==200&&!r.data};
}
const score=p=>p.guard?.pass?50*(p.reach?1:0)+(p.reach?3*Math.max(0,8-p.steps):0)+(p.deadEnds===0?10:0)+(p.falseDoors===0?10:0)+5*Object.values(p.copy).filter(Boolean).length:null;

// ---------- run ----------
async function main(){
  const scratch=mkdtempSync(join(tmpdir(),'flow-onboarding-eval-'));
  const mailLog=join(scratch,'mail.jsonl');
  const m=mockOpid();await new Promise(r=>m.srv.listen(MOCK,'127.0.0.1',r));
  // The hosted pages answer on localhost (a different site from Flow on 127.0.0.1), like a real IdP.
  const hostedSrv=http.createServer((q,s)=>m.srv.emit('request',q,s));await new Promise(r=>hostedSrv.listen(MOCK,'::1',r)).catch(()=>{});
  // Fake clock for Flow's server: each SIGUSR2 moves Date.now() six minutes ahead.
  const clock=`let o=0;const n=Date.now;Date.now=()=>n()+o;process.on('SIGUSR2',()=>{o+=360000});`;
  const env={...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',PORT:String(APP),HOST:'127.0.0.1',ORG_CHART_VERIFY:'1',FLOW_SYNC_TOKEN:TOKEN,
    SAVES_DIR:join(scratch,'saves'),BACKUP_DIR:join(scratch,'backups'),INBOX_DIR:join(scratch,'inbox'),OWNER_EMAIL:OWNER,
    FLOW_EMAIL_TRANSPORT:'file:'+mailLog,FLOW_EMAIL_FROM:'Flow <noreply@example.test>',
    OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE,
    OPID_SSO_CLIENT_ID:SSO_ID,OPID_SSO_CLIENT_SECRET:SSO_SECRET,OPID_SSO_ISSUER:ISSUER,OPID_ACCOUNT_URL:HOSTED+'/dashboard'};
  const app=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(clock),'server.mjs'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
  let log='';app.stdout.on('data',d=>log+=d);app.stderr.on('data',d=>log+=d);
  let b=null;
  try{
    for(let i=0;i<60;i++){try{if((await fetch(BASE+'/api/auth/session')).ok)break}catch{}await sleep(200)}
    const owner=(method,path,body)=>fetch(BASE+path,{method,headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},body:body&&JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json().catch(()=>null)}));
    // The owner already uses Flow: a member account, Default workspace with a card in it.
    m.add({email:OWNER,name:'Example Owner',password:'synthetic-owner-pw',member:'owner'});
    await owner('PUT','/api/workspace?env=default-workspace',{baseRev:0,data:{active:'c1',charts:[{id:'c1',name:'Owner chart',nodes:[{id:'n1',name:'Owner secret',type:'entity',x:0,y:0}],edges:[]}],projects:[],timeline:[],environment:{id:'default-workspace',name:'Default workspace',ownerEmail:OWNER,visibility:'private',members:[]}}});
    const P={
      cold:{key:'cold-visitor',name:'Cora Cold',loginEmail:'cora@example.test',start:BASE+'/'},
      noinvite:{key:'opid-no-invite',name:'Nell Noinvite',loginEmail:'nell@example.test',password:'synthetic-nell-pw',start:BASE+'/'},
      same:{key:'invited-same-email',name:'Ivy Invited',loginEmail:'ivy@example.test',password:'synthetic-ivy-pw',invite:'ivy@example.test'},
      alias:{key:'invited-alias',name:'Alex Alias',loginEmail:'alex@example.test',password:'synthetic-alex-pw',aliases:['alex.alias@example.test'],invite:'alex.alias@example.test'},
      other:{key:'invited-other-email',name:'Dana Diff',loginEmail:'dana@example.test',password:'synthetic-dana-pw',invite:'dana.work@example.test'},
      slow:{key:'slow-signup',name:'Sam Slow',loginEmail:'sam@example.test',invite:'sam@example.test',slow:true},
      member:{key:'member-invites-friend',name:'Mia Member',loginEmail:'mia@example.test',password:'synthetic-mia-pw',member:'u-mia',start:BASE+'/',inviteFriend:true,
        friend:{key:'friend',name:'Finn Friend',loginEmail:'finn@example.test'}},
    };
    for(const p of Object.values(P))if(p.password)m.add({email:p.loginEmail,name:p.name,password:p.password,aliases:p.aliases||[],member:p.member||null});
    const mails=()=>{try{return readFileSync(mailLog,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l))}catch{return []}};
    const mailLink=to=>{const msg=mails().filter(x=>x.to===to).at(-1);if(!msg)return '';const urls=String(msg.text).match(/https?:\/\/[^\s)"]+/g)||[];return urls.find(x=>x.startsWith(BASE+'/join'))||urls.find(x=>x.startsWith(BASE))||''};
    for(const p of Object.values(P))if(p.invite){const r=await owner('POST','/api/invites',{email:p.invite});p.start=mailLink(p.invite)||BASE+'/';p.inviteStatus=r.status}
    b=await browser(join(scratch,'profile'));
    const ctx={app,mailLink,newPage:()=>newPage(b)};
    // Denied, expired and failed must read differently.
    {const pg=await newPage(b),seen=[];for(const why of ['denied','expired','failed']){await pg.goto(BASE+'/?signin='+why);let t='';for(let k=0;k<30&&!t;k++){await sleep(200);t=(await pg.js(SNAPSHOT))?.errors?.join(' ')||''}seen.push(t)}await pg.close();ctx.distinct=seen.every(Boolean)&&new Set(seen).size===3}
    const rows=[];
    for(const p of Object.values(P)){
      const pg=await newPage(b);let r;
      try{r=await walk(pg,p,ctx)}catch(e){r={persona:p.key,reach:false,steps:0,deadEnds:0,falseDoors:0,errors:[String(e?.message||e)],trail:['crashed'],copy:{firstScreen:false,errors:false,firstRun:false,distinct:ctx.distinct},guard:{status:0,pass:false}}}
      await pg.close();r.score=score(r);rows.push(r);
      console.log(`${r.persona.padEnd(22)} reach=${r.reach?1:0} steps=${String(r.steps).padStart(2)} dead=${r.deadEnds} false=${r.falseDoors} copy=${Object.entries(r.copy).filter(([,v])=>v).map(([k])=>k).join(',')||'-'} guard=${r.guard.pass?'ok':'FAIL '+r.guard.status} score=${r.score}`);
    }
    // A denied sign-in (if any) is one OneProfileID claim call at most: report the total for the run.
    let commit='';try{commit=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:ROOT}).toString().trim()}catch{}
    const total=rows.reduce((s,r)=>s+(r.score??0),0),rejected=rows.some(r=>!r.guard.pass);
    const row={at:new Date().toISOString(),label:LABEL,commit,flags:FLAGS,claimCalls:m.stats.claims,inviteCalls:m.stats.invites,personas:rows.map(({trail,firstScreenText,...r})=>({...r,trail,firstScreenText:firstScreenText.slice(0,300)})),total,rejected};
    mkdirSync(OUT,{recursive:true});appendFileSync(join(OUT,'runs.jsonl'),JSON.stringify(row)+'\n');
    console.log(`total=${total}${rejected?' REJECTED (guard failed)':''} -> ${join(OUT,'runs.jsonl')}`);
  }finally{
    b?.close();app.kill();m.srv.close();hostedSrv.close();
    if(process.env.FLOW_EVAL_LOG)console.log(log);
    await sleep(300);try{rmSync(scratch,{recursive:true,force:true})}catch{}
  }
}
await main();
