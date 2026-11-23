// Replay is separate from live office storage. Only the projections below reach the event log.
import {appendFileSync,mkdirSync,readdirSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {VENDORS,STATUSES,ACTIVITY_KINDS,projectsForRepo,viewAgent,EMOTES} from './office.mjs';
import {seatIndex,resolveSeat,seatFor,canSeeAgent,canSeeCard} from './office-seats.mjs';
import {COLUMNS} from '../public/devops-core.js';

const HOUR=36e5,DAY=24*HOUR,LEASE=150_000,CHECKPOINT=60_000,PAGE=4000;
export const HISTORY_RETENTION=14*DAY;
const columns=new Set(COLUMNS.map(([id])=>id));
const envPattern=/^[A-Za-z0-9-]{1,64}$/;
const fine=n=>Math.round(n*100)/100;
const group=e=>e.type==='pose'||e.checkpoint?1:0;

export function historyDay(day,tz,now=Date.now()){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!tz||tz.length>100||!/^[A-Za-z]/.test(tz))throw RangeError('Provide a day and IANA time zone');
  const utc=Date.parse(day+'T00:00:00Z');
  if(!Number.isFinite(utc)||new Date(utc).toISOString().slice(0,10)!==day)throw RangeError('Invalid day');
  const local=new Intl.DateTimeFormat('en',{timeZone:tz,calendar:'iso8601',year:'numeric',month:'2-digit',day:'2-digit'});
  const date=at=>{const p=Object.fromEntries(local.formatToParts(at).map(({type,value})=>[type,value]));return `${p.year}-${p.month}-${p.day}`};
  const crossing=target=>{
    let low=utc-2*DAY,high=utc+3*DAY;
    while(low<high){const mid=Math.floor((low+high)/2);if(date(mid)<target)low=mid+1;else high=mid}
    return low;
  };
  const start=crossing(day),end=crossing(new Date(utc+DAY).toISOString().slice(0,10));
  // Include the oldest local calendar day even when part of it precedes the rolling retention cutoff.
  const today=Date.parse(date(now)+'T00:00:00Z');
  if(utc>today||utc<today-13*DAY||start===end)throw RangeError('Choose a day within the last 14 days');
  return {start,end,through:Math.min(now,end),from:Math.max(start-LEASE,now-HISTORY_RETENTION)};
}

export async function openOfficeHistoryStore({db,dir,hourLimits=[1100,900]}){
  if(db){
    const client=await db.connect();
    try{
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(17701532, 2)');
      await client.query(`create table if not exists flygon_flow_office_history(
        env text not null, id bigserial, at bigint not null, bucket smallint not null, event jsonb not null,
        primary key(env,at,id))`);
      await client.query('create index if not exists flygon_flow_office_history_at on flygon_flow_office_history(at)');
      await client.query('commit');
    }catch(e){await client.query('rollback').catch(()=>{});throw e}
    finally{client.release()}
    return {
      async append(env,hour,bucket,events){
        const c=await db.connect();
        try{
          await c.query('begin');
          await c.query('select pg_advisory_xact_lock(hashtextextended($1, 2))',[JSON.stringify([env,hour,bucket])]);
          const {rows:[{n}]}=await c.query(`select count(*)::int n from flygon_flow_office_history
            where env=$1 and at >= $2 and at < $3 and bucket=$4`,[env,hour,hour+HOUR,bucket]);
          const keep=events.slice(0,Math.max(0,hourLimits[bucket]-n));
          if(keep.length)await c.query(`insert into flygon_flow_office_history(env,at,bucket,event)
            select $1,(e->>'at')::bigint,$2,e-'at' from jsonb_array_elements($3::jsonb) e`,[env,bucket,JSON.stringify(keep)]);
          await c.query('commit');
          return keep.length;
        }catch(e){await c.query('rollback').catch(()=>{});throw e}
        finally{c.release()}
      },
      async read(env,from,to,[at,id],limit){
        const {rows}=await db.query(`select id,at,event from flygon_flow_office_history
          where env=$1 and at >= $2 and at < $3 and (at,id)>($4,$5) order by at,id limit $6`,
        [env,from,to,at,id,limit]);
        return rows.map(r=>({...r.event,at:Number(r.at),id:String(r.id)}));
      },
      prune:before=>db.query('delete from flygon_flow_office_history where at < $1',[before]),
    };
  }
  const root=join(dir,'_office-history'),counts=new Map();
  const path=(env,hour)=>join(root,`${env}.${hour}.jsonl`);
  const load=file=>{
    try{return readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))}
    catch(e){if(e.code!=='ENOENT')throw e;return []}
  };
  return {
    append(env,hour,bucket,events){
      const file=path(env,hour);
      let count=counts.get(file);
      if(!count){
        count=[0,0];
        for(const e of load(file))count[group(e)]++;
        counts.set(file,count);
      }
      const keep=events.slice(0,Math.max(0,hourLimits[bucket]-count[bucket]));
      if(keep.length){
        mkdirSync(root,{recursive:true,mode:0o700});
        appendFileSync(file,keep.map(e=>JSON.stringify(e)+'\n').join(''),{mode:0o600});
        count[bucket]+=keep.length;
      }
      return keep.length;
    },
    read(env,from,to,[at,id],limit){
      const rows=[];
      for(let hour=Math.floor(Math.max(from,at)/HOUR)*HOUR;hour<to;hour+=HOUR){
        const batch=load(path(env,hour)).flatMap((e,i)=>e.at>=from&&e.at<to&&(e.at>at||e.at===at&&i+1>Number(id))?[{...e,id:String(i+1)}]:[]);
        batch.sort((a,b)=>a.at-b.at||Number(a.id)-Number(b.id));
        rows.push(...batch.slice(0,limit-rows.length));
        if(rows.length===limit)break;
      }
      return rows;
    },
    prune(before){
      let files;
      try{files=readdirSync(root)}catch(e){if(e.code!=='ENOENT')throw e;return}
      for(const file of files){
        const m=/^[A-Za-z0-9-]+\.(\d+)\.jsonl$/.exec(file);
        if(m&&Number(m[1])+HOUR<=before){const p=join(root,file);unlinkSync(p);counts.delete(p)}
      }
    },
  };
}

function agentState(ctx,member,id,a){
  const ix=seatIndex(ctx),seat=resolveSeat(ix,a);
  const card=ix.cards.get(seat?.card);
  return {type:'agent',member,agent:id,vendor:VENDORS.includes(a.vendor)?a.vendor:'other',
    status:STATUSES.includes(a.status)?a.status:'idle',activityKind:ACTIVITY_KINDS.includes(a.activityKind)?a.activityKind:'idle',
    projects:projectsForRepo(ctx.projects,a.repo),seat:seat?{agent:seat.agent,card:seat.card}:null,
    number:Number.isSafeInteger(card?.number)?card.number:null,column:columns.has(card?.column)?card.column:null};
}

function project(e,ctx,access,mine){
  const {id,projects,seat,number,column,card,member,agent,vendor,status,activityKind,...rest}=e;
  if(e.type==='card'){
    if(!canSeeCard(access,seatIndex(ctx).cards.get(card)))return null;
    return {...rest,number,column};
  }
  if(e.type==='message')return {type:e.type,at:e.at,member,...(e.channel?{channel:e.channel}:{})};
  if(e.type!=='agent')return {...rest,...(member?{member}:{}),...(agent?{agent}:{})};
  const owner=member===mine,ix=seatIndex(ctx);
  const desk=ix.agents.get(seat?.agent),work=ix.cards.get(seat?.card);
  const seen=projects.some(p=>ix.projects.has(p)&&(access.all||access.projectIds?.has(p)));
  const full=seen&&(!seat?.agent||canSeeAgent(access,desk)||canSeeCard(access,work));
  const visible=owner||full?seatFor(ix,seat,access,{owner}):null;
  // Supply only the replay fields to the live redactor. Its text and interaction fields never enter the log or response.
  const a=viewAgent({id:agent,vendor,status,activityKind,children:[]},{owner,full});
  return {...rest,member,agent,vendor:a.vendor,status:a.status,activityKind:a.activityKind,private:a.private,
    ...(visible?{seat:{agent:visible.agent,card:visible.card&&number!==null?{number,column}:null}}:{})};
}

export function createOfficeHistory({store,state,environments,context,memberKey,agentKey,now=Date.now,onError=()=>{}}){
  const pending=new Set(),sources=new Map(),queues=new Map(),writes=new Map(),poses=new Map();
  let closed=false,timer;
  function track(work){
    pending.add(work);
    work.catch(onError).finally(()=>pending.delete(work));
    return work;
  }
  function append(env,events,at=now()){
    if(closed||!envPattern.test(env)||!events.length)return Promise.resolve();
    const hour=Math.floor(at/HOUR)*HOUR;
    const previous=writes.get(env)||Promise.resolve();
    const work=previous.catch(()=>{}).then(async()=>{
      for(const bucket of [0,1]){
        const batch=events.filter(e=>group(e)===bucket).map(e=>({...e,at}));
        if(batch.length)await store.append(env,hour,bucket,batch);
      }
    });
    writes.set(env,work);
    work.finally(()=>{if(writes.get(env)===work)writes.delete(env)}).catch(()=>{});
    return track(work);
  }
  function schedule(email,fn){
    if(closed)return;
    const work=(queues.get(email)||Promise.resolve()).catch(()=>{}).then(fn);
    queues.set(email,work);
    work.finally(()=>{if(queues.get(email)===work)queues.delete(email)}).catch(()=>{});
    return track(work);
  }
  async function sync(email,agents=state.live(email),at=now()){
    const old=sources.get(email),member=memberKey(email);
    if(!agents.length&&!old)return;
    const contexts=agents.length?await environments(email):[];
    const rooms=new Map(contexts.map(ctx=>[ctx.id,ctx]));
    const next=new Map();
    for(const env of new Set([...rooms.keys(),...old?.rooms.keys()||[]])){
      const ctx=rooms.get(env),before=old?.rooms.get(env)||new Map(),after=new Map(),events=[];
      if(ctx)for(const a of agents){
        const id=agentKey(email,a),e=agentState(ctx,member,id,a);
        const was=before.get(id),changed=!isDeepStrictEqual(was?.event,e);
        const waiting=e.status==='waiting';
        const started=waiting&&(!was||was.event.status!=='waiting'||a.pending?.requestId!==was.request);
        const ended=!waiting&&was?.event.status==='waiting';
        if(changed||started||at-was.at>=CHECKPOINT){
          events.push({...e,...(!changed&&!started?{checkpoint:true}:{}),...(started||ended?{wait:started?'start':'end'}:{})});
          after.set(id,{event:e,at,request:a.pending?.requestId});
        }else after.set(id,was);
      }
      for(const [agent,was] of before)if(!after.has(agent))events.push({type:'agent-leave',member,agent,...(was.event.status==='waiting'?{wait:'end'}:{})});
      await append(env,events,at);
      if(after.size)next.set(env,after);
    }
    if(next.size)sources.set(email,{rooms:next});else sources.delete(email);
  }
  const off=state.on(e=>{
    if(e.type==='agents'){
      const agents=state.live(e.email),at=now();
      return schedule(e.email,()=>sync(e.email,agents,at));
    }
    if(e.type==='action'&&(e.action?.decision==='allow'||e.action?.decision==='deny')){
      return schedule(e.email,async()=>{
        for(const ctx of await environments(e.email))await append(ctx.id,[{type:'answer',member:memberKey(e.email),
          agent:agentKey(e.email,{source:e.action.source,id:e.action.agentId}),decision:e.action.decision}],Date.parse(e.action.at));
      });
    }
  });
  const poseOf=p=>({x:fine(p.x),y:fine(p.y),z:fine(p.z),heading:fine(p.heading),moving:p.moving===true,jump:p.jump===true,sprint:p.sprint===true});
  function sample(env,p){
    const at=now(),key=env+'\n'+p.key,old=poses.get(key),pose=poseOf(p);
    const changed=!old||!isDeepStrictEqual(pose,old.pose);
    // Overloaded hours keep samples spread over the hour. Extra poses in a minute are thinned below.
    if(old&&(at-old.at<2000||(!changed&&at-old.at<CHECKPOINT)))return;
    return recordPose(env,p.key,pose,at,old,changed);
  }
  const slots=new Map();
  function recordPose(env,member,pose,at,old,changed){
    const key=env+'\n'+member;
    if(old&&changed){
      const minute=Math.floor(at/60000),slot=slots.get(env);
      const n=slot?.minute===minute?slot.n:0;
      if(n>=15)return;
      slots.set(env,{minute,n:n+1});
    }
    poses.set(key,{at,pose});
    return append(env,[{type:old?'pose':'join',member,...pose,...(!changed?{checkpoint:true}:{})}],at);
  }
  let pruneAt=0;
  async function maintain(){
    if(closed)return;
    const at=now();
    for(const [env,slot] of slots)if(slot.minute<Math.floor(at/60000)-1)slots.delete(env);
    if(!pruneAt||at-pruneAt>=DAY){await store.prune(at-HISTORY_RETENTION);pruneAt=at}
    await Promise.allSettled([...new Set([...sources.keys(),...state.reporters()])].map(email=>{
      const agents=state.live(email),observedAt=now();
      return schedule(email,()=>sync(email,agents,observedAt));
    }));
  }
  return {
    start(){track(maintain());timer=setInterval(()=>track(maintain()),30_000);timer.unref?.()},
    sample,
    leave(env,member){
      if(!poses.delete(env+'\n'+member))return;
      return append(env,[{type:'leave',member}]);
    },
    marker(env,type,member,kind){
      if(type==='message'&&['nearby','office','direct','agent'].includes(kind))return append(env,[{type,member,channel:kind}]);
      if(type==='emote'&&EMOTES.includes(kind))return append(env,[{type,member,emote:kind}]);
    },
    cards(env,before,after){
      if(!Array.isArray(before?.devops?.cards)||!Array.isArray(after?.devops?.cards))return;
      const old=new Map(before.devops.cards.filter(Boolean).map(c=>[c.id,c.column]));
      const events=after.devops.cards.filter(c=>typeof c?.id==='string'&&!c.id.startsWith('sh.')&&
        old.has(c.id)&&old.get(c.id)!==c.column&&columns.has(c.column)&&Number.isSafeInteger(c.number))
        .map(c=>({type:'card',card:c.id,number:c.number,column:c.column}));
      return append(env,events);
    },
    async page(env,user,access,day,tz,cursor){
      const range=historyDay(day,tz,now());
      let after=[range.from-1,'0'];
      if(cursor){
        const m=/^(\d{1,15}):(\d{1,19})$/.exec(cursor);
        if(!m||BigInt(m[2])>9223372036854775807n)throw RangeError('Invalid history cursor');
        after=[Number(m[1]),m[2]];
      }
      const ctx=await context(env),mine=memberKey(user.email);
      if(!access.ok||!ctx.members.some(m=>memberKey(m.email)===mine))return null;
      const rows=await store.read(env,range.from,range.through+Number(range.through<range.end),after,PAGE+1);
      const more=rows.length>PAGE;
      const page=rows.slice(0,PAGE),last=page.at(-1);
      return {...range,lease:LEASE,
        events:page.map(e=>project(e,ctx,access,mine)).filter(Boolean),
        next:more?`${last.at}:${last.id}`:null};
    },
    async close(){
      clearInterval(timer);off();
      while(pending.size)await Promise.allSettled([...pending]);
      closed=true;
    },
  };
}
