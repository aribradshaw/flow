// Chat end to end (docs/concepts/11-chat.md): a real server in OneProfileID mode against a loopback mock
// of OneProfileID's native gateway. Messages go out with each browser's own session (the mock sees who is
// signed in, never a user chosen by the page), "not enabled" hides the chat, and Flow card links resolve
// with the viewer's own access: the owner, a share recipient (their linked copy) and someone with no
// access, who learns nothing about the card. Temp folders only; DATABASE_URL and FLOW_SYNC_URL blanked.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4396,APP=4397,BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-chat-fixture',SECRET='synthetic-chat-secret-0123456789abcdef',TOKEN='chat-e2e-token-0123456789abcdefghijklmnop';
const OWNER='owner@example.test',BO='bo@example.test',KIM='kim@example.test';
const USERS={[OWNER]:{id:'u-owner',handle:'owner-example',name:'Example Owner',pw:'pw-owner',localId:'owner'},[BO]:{id:'u-bo',handle:'bo-example',name:'Bo Marsh',pw:'pw-bo',localId:'u-bo'},[KIM]:{id:'u-kim',handle:'kim-example',name:'Kim',pw:'pw-kim',localId:'u-kim'}};
// Friends: owner and bo follow each other; kim is nobody's friend.
const FRIENDS=new Set(['u-owner|u-bo','u-bo|u-owner']);
let enabled=true;const seen=[],messages=[];
function mockOpid(){
  const sessions=new Map();
  const cookie=req=>(String(req.headers.cookie||'').match(/(?:^|; )oneprofileid\.session_token=([^;]+)/)||[])[1];
  const identity=u=>({user:{id:u.id,email:Object.keys(USERS).find(k=>USERS[k]===u),name:u.name},session:{id:randomUUID()},memberships:[{localId:u.localId}]});
  const byHandle=h=>Object.values(USERS).find(u=>u.handle===h);
  const who=u=>({username:u.handle,name:u.name,photo:null});
  return http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{};
    if(path==='/sign-in/email'){const u=USERS[b.email];if(!u||u.pw!==b.password)return send(401,{error:'Invalid'});const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly`])}
    if(path==='/get-session'){const u=sessions.get(cookie(req));return u?send(200,identity(u)):send(401,{error:'No session'})}
    if(path.startsWith('/messages/')){
      if(req.headers['x-opid-app']!==APP_ID||req.headers['x-opid-client-secret']!==SECRET)return send(401,{error:'Unknown app'});
      if(!enabled)return send(403,{error:'Messages are not enabled for this application'});
      const me=sessions.get(cookie(req));if(!me)return send(401,{error:'Complete sign-in first'});
      seen.push({path,as:me.id,method:req.method,body:b});
      const other=b.username&&byHandle(b.username),friend=other&&FRIENDS.has(`${me.id}|${other.id}`);
      const mine=m=>({id:m.id,body:m.body,createdAt:m.createdAt,mine:m.from===me.id,read:m.read});
      if(path==='/messages/conversations')return send(200,{unread:0,conversations:Object.values(USERS).filter(u=>FRIENDS.has(`${me.id}|${u.id}`)).map(u=>({...who(u),unread:0,lastMessage:null}))});
      if(path==='/messages/friends')return send(200,{friends:Object.values(USERS).filter(u=>FRIENDS.has(`${me.id}|${u.id}`)).map(who)});
      if(!friend)return send(403,{error:'You can only message friends who follow you back',code:'not_friends'});
      const thread=messages.filter(m=>(m.from===me.id&&m.to===other.id)||(m.from===other.id&&m.to===me.id));
      if(path==='/messages/thread')return send(200,{person:who(other),messages:thread.map(mine),more:false});
      if(path==='/messages/read')return send(200,{ok:true});
      if(path==='/messages/send'){const m={id:randomUUID(),from:me.id,to:other.id,body:b.body,createdAt:new Date().toISOString(),read:false};messages.push(m);return send(201,{message:mine(m)})}
    }
    send(404,{error:'Not found'});
  })});
}
function agent(){
  const jar=new Map();
  return async(method,path,body,headers={})=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null,text='';try{text=await r.text();data=JSON.parse(text)}catch{}
    return {status:r.status,data,text};
  };
}
const N=(id,name,type='entity',extra={})=>({id,name,type,x:0,y:0,...extra});
const ENV='default-workspace';
const fixture=()=>({active:'c1',environment:{id:ENV,name:'Default workspace',ownerEmail:OWNER,visibility:'private',members:[]},
  charts:[{id:'c1',name:'Team',nodes:[{...N('me','Example Owner','person'),email:OWNER},{...N('bo','Bo Marsh','person'),email:BO},N('co','Marsh Holdings LLC')],
    edges:[{id:'e1',from:'bo',to:'co',type:'ownership',percent:''}]}],
  projects:[{id:'p1',name:'Gatehouse',color:'#3b7dd8',entity:'co'},{id:'p2',name:'Quiet project',color:'#aa3355',entity:''}],timeline:[],
  devops:{cards:[{id:'c-shared',number:1,title:'Wire the gate',column:'doing',project:'p1',labels:[],assignees:[{node:'bo',role:'developer'}]},
    {id:'c-private',number:2,title:'Secret plan',column:'must',project:'p2',labels:[],assignees:[{node:'me',role:'developer'}]}],nextNumber:3}});

let dir,mock,app,owner,bo,kim,boEnv,shareId;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-chat-e2e-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',OWNER_EMAIL:OWNER,
    BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  owner=agent();bo=agent();kim=agent();
  for(const [a,e,pw] of [[owner,OWNER,'pw-owner'],[bo,BO,'pw-bo'],[kim,KIM,'pw-kim']])assert.equal((await a('POST','/api/auth/sign-in',{email:e,password:pw})).status,200);
  assert.equal((await owner('PUT','/api/workspace?env='+ENV,{baseRev:0,data:fixture()})).status,200);
  boEnv=(await bo('GET','/api/workspace')).data.env;assert.ok(boEnv&&boEnv!==ENV);
  await kim('GET','/api/workspace');
  const s=await owner('POST','/api/shares',{env:ENV,recipientEmail:BO,scope:{kind:'person',nodeId:'bo'},permission:'view'});
  assert.equal(s.status,200);shareId=s.data.share.id;
  assert.equal((await bo('POST',`/api/shares/${shareId}/attach`,{env:boEnv})).status,200);
});
after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('signed out is 401; the chat is available once OneProfileID allows it',async()=>{
  assert.equal((await agent()('GET','/api/chat/status')).status,401);
  assert.deepEqual((await bo('GET','/api/chat/status')).data,{available:true,unread:0});
  enabled=false;
  try{
    assert.equal((await bo('GET','/api/chat/status')).data.available,false);
    const r=await bo('POST','/api/chat/send',{username:'owner-example',body:'hi'});
    assert.equal(r.status,403);assert.equal(r.data.code,'chat_unavailable');
  }finally{enabled=true}
});

test('messages go out as the signed-in person, to friends only',async()=>{
  seen.length=0;
  const f=await bo('GET','/api/chat/friends');assert.deepEqual(f.data.friends.map(x=>x.username),['owner-example']);
  const s=await bo('POST','/api/chat/send',{username:'owner-example',body:'Hello from Bo'});
  assert.equal(s.status,201);assert.equal(s.data.message.mine,true);
  const t=await owner('POST','/api/chat/thread',{username:'bo-example'});
  assert.equal(t.status,200);assert.deepEqual(t.data.messages.map(m=>[m.body,m.mine]),[['Hello from Bo',false]]);
  assert.equal((await owner('POST','/api/chat/read',{username:'bo-example',through:t.data.messages[0].id})).status,200);
  // Kim is nobody's friend; a page cannot pick who sends.
  const k=await kim('POST','/api/chat/send',{username:'owner-example',body:'hi'});assert.equal(k.status,403);assert.equal(k.data.code,'not_friends');
  assert.equal((await kim('POST','/api/chat/send',{username:'owner-example',body:'hi',from:'u-bo'})).status,400);
  assert.deepEqual(seen.map(x=>[x.path,x.as]),[['/messages/friends','u-bo'],['/messages/send','u-bo'],['/messages/thread','u-owner'],['/messages/read','u-owner'],['/messages/send','u-kim']]);
  // Another site cannot use someone's session.
  assert.equal((await bo('POST','/api/chat/send',{username:'owner-example',body:'x'},{origin:'https://evil.example.test'})).status,403);
});

const look=(a,links)=>a('POST','/api/chat/cards',{links});
test('card links resolve with the viewer\'s own access',async()=>{
  const shared={env:ENV,kind:'card',id:'c-shared'},secret={env:ENV,kind:'card',id:'c-private'};
  // The owner sees both, and opens them in their own environment.
  let r=await look(owner,[shared,secret]);
  assert.deepEqual(r.data.cards.map(c=>[c.access,c.card?.title,c.open?.env]),[[true,'Wire the gate',ENV],[true,'Secret plan',ENV]]);
  assert.equal(r.data.cards[0].card.column.name,'Doing');assert.equal(r.data.cards[0].card.project.name,'Gatehouse');
  // The recipient of a share sees the shared card as the share shows it, and opens their linked copy.
  r=await look(bo,[shared,secret,{env:ENV,kind:'node',id:'co'},{env:ENV,kind:'node',id:'me'}]);
  assert.deepEqual(r.data.cards.map(c=>c.access),[true,false,true,false]);
  assert.equal(r.data.cards[0].card.title,'Wire the gate');
  assert.deepEqual(r.data.cards[0].open,{env:boEnv,id:`sh.${shareId}.c-shared`});
  assert.deepEqual(r.data.cards[2].open,{env:boEnv,id:`sh.${shareId}.co`});
  assert.doesNotMatch(r.text,/Secret plan|Quiet project|Example Owner/);
  // Someone with no access learns nothing, not even whether the card exists.
  r=await look(kim,[shared,secret,{env:ENV,kind:'card',id:'no-such-card'},{env:'no-such-env',kind:'card',id:'x'}]);
  assert.deepEqual(r.data.cards,[{access:false},{access:false},{access:false},{access:false}]);
  assert.doesNotMatch(r.text,/Wire the gate|Secret plan|Gatehouse/);
  // A revoked share closes it again.
  assert.equal((await owner('DELETE','/api/shares/'+shareId)).status,200);
  assert.deepEqual((await look(bo,[shared])).data.cards,[{access:false}]);
  assert.equal((await look(bo,[{env:'bad env',kind:'card',id:'x'}])).status,400);
});
