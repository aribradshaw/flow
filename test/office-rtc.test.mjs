// Voice signalling in the 3D office (lib/office-rtc.mjs) on the SSE hub over a loopback server: who may signal
// whom (only open connections of the same office, never across environments), rate limits, size caps, one
// screen per room, and the ICE servers (TURN only when configured, and no server secret ever in a response).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {officeState,officeHub} from '../lib/office.mjs';
import {officeRtc,iceConfig,cleanVoiceState,mayCall,RTC_MAX,DEFAULT_STUN} from '../lib/office-rtc.mjs';

function sse(url){
  const events=[];let buf='',res;
  const ready=new Promise((ok,no)=>{const req=http.get(url,r=>{res=r;r.setEncoding('utf8');r.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,i);buf=buf.slice(i+2);
    const type=/^event: (.+)$/m.exec(block)?.[1],data=/^data: (.+)$/m.exec(block)?.[1];if(type)events.push({type,data:JSON.parse(data)})}});ok(r)});req.on('error',no)});
  // rtc events, optionally of one rtc type.
  const next=async(type,ms=2000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=events.findIndex(e=>e.type==='rtc'&&(!type||e.data.type===type));if(i>=0)return events.splice(i,1)[0].data;await new Promise(r=>setTimeout(r,10))}throw Error('no rtc '+type+' event')};
  const none=async(type,ms=120)=>{await new Promise(r=>setTimeout(r,ms));return !events.some(e=>e.type==='rtc'&&(!type||e.data.type===type))};
  return {ready,events,next,none,close:()=>res?.destroy()};
}

async function office(){
  let time=0;
  const st=officeState();
  const users={ann:{email:'ann@example.test',name:'Ann'},bo:{email:'bo@example.test',name:'Bo'},cy:{email:'cy@example.test',name:'Cy'},zed:{email:'zed@example.test',name:'Zed'}};
  const ctx=id=>({id,name:id,ownerEmail:users.ann.email,members:Object.values(users).map(u=>({email:u.email,name:u.name})),projects:[],agents:[]});
  const hub=officeHub({state:st,context:{env:async id=>ctx(id)},heartbeatMs:60e3});
  const rtc=officeRtc({hub,now:()=>time});
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://x');
    if(u.pathname==='/events'){await hub.connect(u.searchParams.get('env'),users[u.searchParams.get('as')],{ok:true,all:true,projectIds:new Set()},req,res);return}
    res.writeHead(404);res.end();
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const open=async(who,env='env1')=>{const s=sse(`http://127.0.0.1:${server.address().port}/events?as=${who}&env=${env}`);await s.ready;s.welcome=await s.next('welcome');s.peer=s.welcome.peer;return s};
  return {users,hub,rtc,open,tick:ms=>{time+=ms},close(){rtc.close();hub.close();st.close();server.close()}};
}

test('signalling reaches only the one peer it is for, in the same office; never another environment',async()=>{
  const o=await office(),{users,rtc}=o;
  try{
    const ann=await o.open('ann'),bo=await o.open('bo'),cy=await o.open('cy'),other=await o.open('zed','env2');
    assert.notEqual(ann.peer,bo.peer);
    // Into the meeting room: everyone in the office hears each state, the sender too; the other environment does not.
    rtc.signal('env1',users.ann,{from:ann.peer,type:'state',data:{room:'meeting'}});
    for(const s of [ann,bo,cy])assert.deepEqual(await s.next('state'),{type:'state',peer:ann.peer,key:o.hub.memberKey(users.ann.email),room:'meeting',near:false,dnd:false,muted:false,share:false});
    assert.ok(await other.none('state'),'another office hears nothing');
    rtc.signal('env1',users.bo,{from:bo.peer,type:'state',data:{room:'meeting'}});
    for(const s of [ann,bo,cy])await s.next('state');
    // A new connection is welcomed with the voice states already there.
    const late=await o.open('cy');
    assert.deepEqual(late.welcome.peers.map(p=>[p.peer,p.room]).sort(),[[ann.peer,'meeting'],[bo.peer,'meeting']].sort());
    assert.ok(!JSON.stringify(late.welcome).includes('@example.test'),'no emails reach the browser');
    // An offer goes to Bo alone, from Ann's peer id.
    rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'offer',data:{type:'offer',sdp:'v=0'}});
    assert.deepEqual(await bo.next('offer'),{type:'offer',from:ann.peer,data:{type:'offer',sdp:'v=0'}});
    assert.ok(await cy.none('offer'),'not to Cy');assert.ok(await ann.none('offer'),'not echoed');
    rtc.signal('env1',users.bo,{from:bo.peer,to:ann.peer,type:'answer',data:{type:'answer',sdp:'v=0'}});
    assert.equal((await ann.next('answer')).from,bo.peer);
    rtc.signal('env1',users.bo,{from:bo.peer,to:ann.peer,type:'ice',data:{candidate:'candidate:1'}});
    assert.deepEqual((await ann.next('ice')).data,{candidate:'candidate:1'});
    // Nobody speaks as someone else's connection, or reaches a connection of another office.
    assert.throws(()=>rtc.signal('env1',users.cy,{from:ann.peer,to:bo.peer,type:'ice',data:{}}),{status:409},'Cy cannot use Ann\'s peer id');
    assert.throws(()=>rtc.signal('env2',users.ann,{from:ann.peer,to:other.peer,type:'ice',data:{}}),{status:409},'Ann is not connected to env2');
    assert.throws(()=>rtc.signal('env1',users.ann,{from:ann.peer,to:other.peer,type:'ice',data:{}}),{status:404},'env2\'s peer is not in env1');
    assert.throws(()=>rtc.signal('env1',users.ann,{from:ann.peer,to:ann.peer,type:'ice',data:{}}),{status:404},'not to yourself');
    assert.throws(()=>rtc.signal('env1',users.zed,{from:other.peer,to:ann.peer,type:'ice',data:{}}),{status:409},'Zed\'s connection is in env2');
    assert.throws(()=>rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'hack',data:{}}),{status:400});
    assert.throws(()=>rtc.signal('env1',users.ann,null),{status:400});
    // An offer needs a call: Cy is not in the room.
    assert.throws(()=>rtc.signal('env1',users.ann,{from:ann.peer,to:cy.peer,type:'offer',data:{}}),{status:409,code:'not_in_call'});
    // Leaving: everyone hears the peer is gone, and its id stops working.
    bo.close();assert.equal((await ann.next('gone')).peer,bo.peer);
    assert.throws(()=>rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'ice',data:{}}),{status:404});
    assert.deepEqual(rtc.peers('env1').map(p=>p.peer),[ann.peer]);
    for(const s of [ann,cy,late,other])s.close();
  }finally{o.close()}
});

test('proximity calls: both on, outside rooms, and never anyone in Do not disturb',async()=>{
  const o=await office(),{users,rtc}=o;
  try{
    const ann=await o.open('ann'),bo=await o.open('bo');
    const state=(u,s,data)=>rtc.signal('env1',u,{from:s.peer,type:'state',data});
    state(users.ann,ann,{near:true});
    assert.throws(()=>rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'offer',data:{}}),{code:'not_in_call'},'Bo has it off');
    state(users.bo,bo,{near:true,dnd:true});
    assert.throws(()=>rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'offer',data:{}}),{code:'not_in_call'},'Bo is in Do not disturb');
    state(users.bo,bo,{near:true});
    assert.deepEqual(rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'offer',data:{}}),{ok:true});
    state(users.bo,bo,{room:'meeting',near:true});
    assert.throws(()=>rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'offer',data:{}}),{code:'not_in_call'},'a room call is not proximity');
    // A bye always gets through, so either side can hang up.
    assert.deepEqual(rtc.signal('env1',users.bo,{from:bo.peer,to:ann.peer,type:'bye',data:null}),{ok:true});
    ann.close();bo.close();
  }finally{o.close()}
  assert.deepEqual(cleanVoiceState({room:'meeting',near:true,share:true,dnd:'yes'}),{room:'meeting',near:false,dnd:false,muted:false,share:true});
  assert.deepEqual(cleanVoiceState({room:'../x',share:true}),{room:'',near:false,dnd:false,muted:false,share:false},'odd room ids and sharing outside a room are dropped');
  assert.ok(!mayCall({room:'a'},{room:'b'}));assert.ok(mayCall({room:'a'},{room:'a',dnd:true}),'a room call ignores Do not disturb: you walked in');
});

test('size caps and rate limits per connection',async()=>{
  const o=await office(),{users,rtc}=o;
  try{
    const ann=await o.open('ann'),bo=await o.open('bo');
    assert.throws(()=>rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'ice',data:{sdp:'x'.repeat(RTC_MAX)}}),{status:413});
    assert.deepEqual(rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'ice',data:{sdp:'x'.repeat(RTC_MAX-20)}}),{ok:true});
    let sent=1;try{for(;sent<1000;sent++)rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'ice',data:{c:sent}})}catch(e){assert.equal(e.status,429)}
    assert.ok(sent>=150&&sent<=210,'a burst of ICE candidates is fine, a flood is not: '+sent);
    assert.deepEqual(rtc.signal('env1',users.bo,{from:bo.peer,to:ann.peer,type:'ice',data:{}}),{ok:true},'per connection: Bo is not limited by Ann');
    o.tick(1000);
    assert.deepEqual(rtc.signal('env1',users.ann,{from:ann.peer,to:bo.peer,type:'ice',data:{}}),{ok:true},'it refills');
    let states=0;try{for(;states<100;states++)rtc.signal('env1',users.ann,{from:ann.peer,type:'state',data:{near:states%2===0}})}catch(e){assert.equal(e.status,429)}
    assert.ok(states>=10&&states<=14,'voice states: '+states);
    ann.close();bo.close();
  }finally{o.close()}
});

test('one screen per room: a second sharer takes over',async()=>{
  const o=await office(),{users,rtc}=o;
  try{
    const ann=await o.open('ann'),bo=await o.open('bo');
    rtc.signal('env1',users.ann,{from:ann.peer,type:'state',data:{room:'meeting',share:true}});
    rtc.signal('env1',users.bo,{from:bo.peer,type:'state',data:{room:'meeting'}});
    for(let i=0;i<2;i++)await ann.next('state');
    rtc.signal('env1',users.bo,{from:bo.peer,type:'state',data:{room:'meeting',share:true}});
    const taken=await ann.next('state');assert.deepEqual([taken.peer,taken.share],[ann.peer,false],'Ann hears her share ended');
    assert.deepEqual(rtc.peers('env1').map(p=>[p.peer===bo.peer?'bo':'ann',p.share]).sort(),[['ann',false],['bo',true]]);
    ann.close();bo.close();
  }finally{o.close()}
});

test('ICE servers: STUN by default, TURN only when configured, and no server secret in any response',async()=>{
  const none=await iceConfig({env:{}}).get({email:'a@example.test'});
  assert.deepEqual(none,{iceServers:[{urls:DEFAULT_STUN}],ttl:21600,turn:false});
  assert.ok(!JSON.stringify(none).includes('credential'));
  assert.equal(iceConfig({env:{}}).configured,false);
  assert.deepEqual((await iceConfig({env:{OFFICE_STUN_URLS:'none'}}).get({})).iceServers,[]);
  const own=await iceConfig({env:{OFFICE_TURN_URLS:'turn:turn.example.test:3478, turns:turn.example.test:5349,javascript:alert(1)',OFFICE_TURN_USERNAME:'office',OFFICE_TURN_CREDENTIAL:'pw'}}).get({});
  assert.deepEqual(own.iceServers[1],{urls:['turn:turn.example.test:3478','turns:turn.example.test:5349'],username:'office',credential:'pw'});assert.equal(own.turn,true);
  // Cloudflare: the key id and API token stay on the server; port 53 URLs are dropped; one fetch per person per half TTL.
  const calls=[];let time=0;
  const fakeFetch=async(url,init)=>{
    calls.push({url,init});
    if(!String(url).startsWith('https://rtc.live.cloudflare.com/v1/turn/keys/KEY-ID/credentials/generate-ice-servers'))return new Response('no',{status:404});
    return new Response(JSON.stringify({iceServers:[{urls:['stun:stun.cloudflare.com:3478','stun:stun.cloudflare.com:53']},
      {urls:['turn:turn.cloudflare.com:3478?transport=udp','turn:turn.cloudflare.com:53?transport=udp','turns:turn.cloudflare.com:443?transport=tcp'],username:'short-user',credential:'short-pass'}]}),{status:201});
  };
  const env={CLOUDFLARE_TURN_KEY_ID:'KEY-ID',CLOUDFLARE_TURN_KEY_API_TOKEN:'SECRET-API-TOKEN'};
  const cf=iceConfig({env,fetch:fakeFetch,now:()=>time});
  const got=await cf.get({email:'Ann@example.test'});
  assert.equal(calls.length,1);assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.headers.Authorization,'Bearer SECRET-API-TOKEN');
  assert.deepEqual(JSON.parse(calls[0].init.body),{ttl:21600});
  assert.deepEqual(got.iceServers,[{urls:DEFAULT_STUN},{urls:['stun:stun.cloudflare.com:3478']},
    {urls:['turn:turn.cloudflare.com:3478?transport=udp','turns:turn.cloudflare.com:443?transport=tcp'],username:'short-user',credential:'short-pass'}]);
  assert.equal(got.turn,true);
  for(const secret of ['SECRET-API-TOKEN','KEY-ID'])assert.ok(!JSON.stringify(got).includes(secret),secret);
  await cf.get({email:'ann@example.test'});assert.equal(calls.length,1,'cached per person');
  await cf.get({email:'bo@example.test'});assert.equal(calls.length,2);
  time=4*3600e3;await cf.get({email:'ann@example.test'});assert.equal(calls.length,3,'refreshed after half the TTL');
  // Cloudflare down: STUN only, logged once without the token.
  const logged=[];
  const down=iceConfig({env,fetch:async()=>new Response('{}',{status:500}),log:{error:(...a)=>logged.push(a.join(' '))}});
  assert.deepEqual(await down.get({email:'a@example.test'}),{iceServers:[{urls:DEFAULT_STUN}],ttl:21600,turn:false});
  await down.get({email:'b@example.test'});
  assert.equal(logged.length,1);assert.ok(!logged[0].includes('SECRET'));
});
