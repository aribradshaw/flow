// Durable office data. Postgres coordinates claims across overlapping deployments. The file
// implementation is for one process and replaces its state atomically before acknowledging writes.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

const SCHEMA=[
  `create table if not exists flygon_flow_office_reports (
    email text not null, source text not null, received bigint not null, data jsonb not null, primary key(email,source))`,
  `create table if not exists flygon_flow_office_actions (
    id text primary key, email text not null, source text not null, agent_id text not null, request_id text,
    at bigint not null, delivered_at bigint, data jsonb not null, unique(email,source,agent_id,request_id))`,
  `create table if not exists flygon_flow_office_chat (env text primary key, lines jsonb not null)`,
  `create table if not exists flygon_flow_office_status (
    env text not null, member text not null, data jsonb not null, primary key(env,member))`,
  `create table if not exists flygon_flow_office_decor (
    env text not null, member text not null, data jsonb not null, primary key(env,member))`,
  `create table if not exists flygon_flow_office_meta (key text primary key, value text not null)`,
  // One look per person (lib/office-look.mjs), under their office member key: it follows them into every office.
  `create table if not exists flygon_flow_office_looks (member text primary key, data jsonb not null, updated bigint not null)`,
];

export async function officeStorage({db,dir,secret}){
  if(!db)return fileStorage(dir,secret);
  async function transaction(run){
    const client=await db.connect();
    try{
      await client.query('begin');
      const result=await run(client);
      await client.query('commit');
      return result;
    }catch(e){await client.query('rollback').catch(()=>{});throw e}
    finally{client.release()}
  }
  // Serializes first startup DDL if two deployments initialize the tables together.
  await transaction(async client=>{
    await client.query('select pg_advisory_xact_lock(17701532, 1)');
    for(const sql of SCHEMA)await client.query(sql);
    await client.query(`insert into flygon_flow_office_meta values ('secret',$1) on conflict do nothing`,[secret]);
  });
  const rows=async(sql,params)=>(await db.query(sql,params)).rows;
  return {
    shared:true,
    secret:(await rows(`select value from flygon_flow_office_meta where key='secret'`))[0].value,
    reports:async(since,emails)=>(await rows(`select email,data from flygon_flow_office_reports
      where received >= $1 and ($2::text[] is null or email=any($2)) order by received, source`,[since,emails??null])),
    async saveReport(email,r){
      const saved=await rows(`insert into flygon_flow_office_reports values ($1,$2,$3,$4)
        on conflict (email,source) do update set received=excluded.received,data=excluded.data
        where flygon_flow_office_reports.received<=excluded.received returning source`,[email,r.source,r.received,r]);
      return !!saved.length;
    },
    actions:async(email,since)=>(await rows(`select data from flygon_flow_office_actions where email=$1 and at >= $2 order by at,id`,[email,since])).map(row=>row.data),
    async queue(a,since){
      const agent=[a.email,a.source,a.agentId],at=Date.parse(a.at);
      const key=[...agent,a.requestId??null];
      const insert=async client=>!!(await client.query(`insert into flygon_flow_office_actions (id,email,source,agent_id,request_id,at,data)
        values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning id`,[a.id,...key,at,a])).rowCount;
      if(a.kind==='answer'){
        await db.query(`delete from flygon_flow_office_actions where email=$1 and source=$2 and agent_id=$3 and request_id=$4 and at < $5`,[...key,since]);
      }
      if(a.kind!=='stop')return insert(db);
      return transaction(async client=>{
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 1))',[JSON.stringify(agent)]);
        const pending=await client.query(`select 1 from flygon_flow_office_actions where email=$1 and source=$2 and agent_id=$3
          and data->>'kind'='stop' and data->>'result' is null and at > $4 limit 1`,[...agent,at-60000]);
        return !pending.rowCount&&await insert(client);
      });
    },
    async claim(email,source,at,since){
      // A competing UPDATE rechecks delivered_at after acquiring the row lock.
      return (await rows(`update flygon_flow_office_actions set delivered_at=$3
        where email=$1 and source=$2 and delivered_at is null and at >= $4 returning data`,[email,source,at,since]))
        .map(row=>row.data).sort(byTime);
    },
    async result(email,id,result){
      return (await rows(`update flygon_flow_office_actions set data=data || jsonb_build_object('result',$3::jsonb)
        where email=$1 and id=$2 returning data`,[email,id,JSON.stringify(result)]))[0]?.data;
    },
    async room(env){
      const [chat,status,decor]=await Promise.all([
        rows('select lines from flygon_flow_office_chat where env=$1',[env]),
        rows('select member,data from flygon_flow_office_status where env=$1',[env]),
        rows('select member,data from flygon_flow_office_decor where env=$1',[env]),
      ]);
      return {chat:chat[0]?.lines||[],status,decor};
    },
    async say(env,line){
      return (await rows(`insert into flygon_flow_office_chat values ($1,$2)
        on conflict (env) do update set lines=(case when jsonb_array_length(flygon_flow_office_chat.lines)>=50
          then flygon_flow_office_chat.lines - 0 else flygon_flow_office_chat.lines end) || excluded.lines
        returning lines`,[env,JSON.stringify([line])]))[0].lines;
    },
    async status(env,member,data){
      await db.query(`insert into flygon_flow_office_status values ($1,$2,$3)
        on conflict (env,member) do update set data=flygon_flow_office_status.data || excluded.data`,[env,member,data]);
    },
    async decor(env,member,data){
      await db.query(`insert into flygon_flow_office_decor values ($1,$2,$3)
        on conflict (env,member) do update set data=flygon_flow_office_decor.data || excluded.data`,[env,member,data]);
    },
    looks:async members=>members.length?rows('select member,data from flygon_flow_office_looks where member=any($1)',[members]):[],
    // Looks saved before accounts had avatars (lib/avatars.mjs migrates the newest): the per-person look, and
    // any look kept with a room's decor. -> [{data, updated}]
    legacyLooks:async member=>(await rows(`select data,updated from flygon_flow_office_looks where member=$1
      union all select data->'look' as data,case when data->>'lookUpdated' ~ '^[0-9]{1,15}$' then (data->>'lookUpdated')::bigint else 0 end as updated
      from flygon_flow_office_decor where member=$1 and jsonb_typeof(data->'look')='object'`,[member])).map(r=>({data:r.data,updated:Number(r.updated)||0})),
    async look(member,data){
      if(!data)await db.query('delete from flygon_flow_office_looks where member=$1',[member]);
      else await db.query(`insert into flygon_flow_office_looks values ($1,$2,$3)
        on conflict (member) do update set data=excluded.data,updated=excluded.updated`,[member,data,Date.now()]);
    },
    async prune(reportsSince,actionsSince){
      await db.query('delete from flygon_flow_office_reports where received < $1',[reportsSince]);
      await db.query('delete from flygon_flow_office_actions where at < $1',[actionsSince]);
    },
  };
}

const byTime=(a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id);
function fileStorage(dir,secret){
  const path=join(dir,'_office-state.json');
  let data={reports:[],actions:[],chat:[],status:[],decor:[],looks:[]};
  try{data={...data,...JSON.parse(readFileSync(path,'utf8'))}}catch(e){if(e.code!=='ENOENT')throw e}
  if(!Array.isArray(data.decor))data.decor=[];
  if(!Array.isArray(data.looks))data.looks=[];
  function save(key,value){
    const next={...data,[key]:value};
    mkdirSync(dir,{recursive:true});
    writeFileSync(path+'.tmp',JSON.stringify(next),{mode:0o600});
    renameSync(path+'.tmp',path);
    data=next;
  }
  return {
    secret,
    reports:(since,emails)=>data.reports.filter(r=>r.data.received>=since&&(!emails||emails.includes(r.email))),
    saveReport(email,r){
      const other=row=>row.email!==email||row.data.source!==r.source;
      const old=data.reports.find(row=>!other(row));
      if(old?.data.received>r.received)return false;
      save('reports',[...data.reports.filter(other),{email,data:r}]);return true;
    },
    actions:(email,since)=>data.actions.filter(a=>a.email===email&&Date.parse(a.at)>=since).sort(byTime),
    queue(a,since){
      const recent=data.actions.filter(x=>Date.parse(x.at)>=since);
      const matches=x=>x.email===a.email&&x.source===a.source&&x.agentId===a.agentId;
      if(a.kind==='answer'&&recent.some(x=>matches(x)&&x.requestId===a.requestId))return false;
      if(a.kind==='stop'&&recent.some(x=>matches(x)&&x.kind==='stop'&&!x.result&&Date.parse(a.at)-Date.parse(x.at)<60000))return false;
      save('actions',[...recent,a]);return true;
    },
    claim(email,source,at,since){
      const claimed=[];
      const next=data.actions.map(a=>{
        if(a.email!==email||a.source!==source||a.deliveredAt||Date.parse(a.at)<since)return a;
        const row={...a,deliveredAt:new Date(at).toISOString()};claimed.push(row);return row;
      });
      if(claimed.length)save('actions',next);
      return claimed.sort(byTime);
    },
    result(email,id,result){
      let saved;
      const next=data.actions.map(a=>a.email===email&&a.id===id?(saved={...a,result}):a);
      if(saved)save('actions',next);
      return saved;
    },
    room:env=>({chat:data.chat.find(row=>row.env===env)?.lines||[],status:data.status.filter(row=>row.env===env),decor:(data.decor||[]).filter(row=>row.env===env)}),
    say(env,line){
      const lines=[...(data.chat.find(row=>row.env===env)?.lines||[]),line].slice(-50);
      save('chat',[...data.chat.filter(row=>row.env!==env),{env,lines}]);return lines;
    },
    status(env,member,value){
      const other=row=>row.env!==env||row.member!==member,old=data.status.find(row=>!other(row));
      save('status',[...data.status.filter(other),{env,member,data:{...old?.data,...value}}]);
    },
    decor(env,member,value){
      const other=row=>row.env!==env||row.member!==member,old=(data.decor||[]).find(row=>!other(row));
      save('decor',[...(data.decor||[]).filter(other),{env,member,data:{...old?.data,...value}}]);
    },
    looks:members=>data.looks.filter(row=>members.includes(row.member)),
    legacyLooks:member=>[...data.looks.filter(row=>row.member===member).map(row=>({data:row.data,updated:Number(row.updated)||0})),
      ...(data.decor||[]).filter(row=>row.member===member&&row.data?.look&&typeof row.data.look==='object').map(row=>({data:row.data.look,updated:Number(row.data.lookUpdated)||0}))],
    look(member,value){
      const rest=data.looks.filter(row=>row.member!==member);
      save('looks',value?[...rest,{member,data:value,updated:Date.now()}]:rest);
    },
    prune(reportsSince,actionsSince){
      const reports=data.reports.filter(row=>row.data.received>=reportsSince),actions=data.actions.filter(a=>Date.parse(a.at)>=actionsSince);
      if(reports.length!==data.reports.length)save('reports',reports);
      if(actions.length!==data.actions.length)save('actions',actions);
    },
  };
}
