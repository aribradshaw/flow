// Day replay. The stream stays open so the office can keep receiving alerts and restore its live scene.
const ANIMATION_RATES={1:1,10:3,60:8,300:17};
const pad=n=>String(n).padStart(2,'0');
const localDay=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const personEvents=new Set(['join','pose','leave']);
const actorEvents=new Set(['agent','agent-leave']);
const angle=(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));
function upper(rows,at){
  let low=0,high=rows.length;
  while(low<high){const mid=(low+high)>>>1;if(rows[mid].at<=at)low=mid+1;else high=mid}
  return low;
}
const add=(map,key,value)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(value)};

export function replayTracks(events,lease){
  const people=new Map(),agents=new Map(),markers=[];
  for(const e of events){
    if(personEvents.has(e.type))add(people,e.member,e);
    else if(actorEvents.has(e.type)){
      const {type,at,member,agent,vendor,status,activityKind,private:isPrivate,seat}=e;
      const track=JSON.stringify([member,agent]);
      const previous=agents.get(track)?.at(-1)?.state;
      let state=type==='agent'?{id:agent,vendor,status,activityKind,private:isPrivate,seat}:null;
      if(state&&previous&&JSON.stringify(state)===JSON.stringify(previous))state=previous;
      add(agents,track,{at,member,state});
    }else if(e.type==='answer'||e.type==='emote')markers.push(e);
  }
  return {
    sample(at){
      const roster=new Map(),poses=new Map();
      for(const rows of agents.values()){
        const e=rows[upper(rows,at)-1];
        if(e?.state&&at-e.at<lease)add(roster,e.member,e.state);
      }
      for(const [key,rows] of people){
        const i=upper(rows,at),a=rows[i-1],b=rows[i];
        if(!a||a.type==='leave'||at-a.at>=lease)continue;
        // Checkpoints and a new join can't extend a path across a gap or a disconnect.
        const interpolate=b?.type==='pose'&&b.at-a.at<=30_000&&!b.checkpoint;
        const mix=interpolate?(at-a.at)/(b.at-a.at):0;
        const lerp=k=>a[k]+(interpolate?(b[k]-a[k])*mix:0);
        const speed=interpolate?Math.min(7,1000*Math.hypot(b.x-a.x,b.z-a.z)/(b.at-a.at)):0;
        poses.set(key,{x:lerp('x'),y:lerp('y'),z:lerp('z'),heading:a.heading+(interpolate?angle(a.heading,b.heading)*mix:0),
          speed,grounded:!a.jump,jumping:a.jump,sprinting:a.sprint});
      }
      return {roster,poses};
    },
    between:(before,after)=>markers.slice(upper(markers,before),upper(markers,after)),
  };
}

export function attachOfficeReplay(root,{env,scene,live,clear,react,names}){
  const button=root.querySelector('[data-of-replay]');
  const bar=document.createElement('section');
  bar.className='of-replay';
  bar.setAttribute('aria-label','Day replay');
  bar.hidden=true;
  bar.innerHTML=`<div class="of-replay-controls">
      <label>Day <select data-native aria-label="Replay day" data-replay-day></select></label>
      <button type="button" data-replay-play>Play</button>
      <label>Speed <select data-native aria-label="Replay speed" data-replay-speed><option value="1">1×</option><option value="10">10×</option><option value="60" selected>60×</option><option value="300">300×</option></select></label>
      <span class="of-replay-info" role="status"></span>
      <button type="button" data-replay-live>Live</button>
    </div>
    <div class="of-replay-plot"><canvas aria-hidden="true"></canvas><input type="range" min="0" max="1" step="1" value="0" aria-label="Replay time"></div>
    <div class="of-replay-meta"><span class="of-replay-people"></span><span><i class="of-replay-wait"></i> Waiting <i class="of-replay-ship"></i> Shipped</span></div>`;
  root.append(bar);
  const select=bar.querySelector('[data-replay-day]'),speed=bar.querySelector('[data-replay-speed]');
  const play=bar.querySelector('[data-replay-play]'),back=bar.querySelector('[data-replay-live]');
  const slider=bar.querySelector('input'),canvas=bar.querySelector('canvas'),info=bar.querySelector('.of-replay-info'),present=bar.querySelector('.of-replay-people');
  const badge=document.createElement('span');badge.className='of-replay-badge';badge.hidden=true;button.after(badge);
  const tz=new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateLabel=new Intl.DateTimeFormat(undefined,{timeZone:tz,month:'short',day:'numeric'});
  const clock=new Intl.DateTimeFormat(undefined,{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const optionLabel=new Intl.DateTimeFormat(undefined,{timeZone:tz,weekday:'short',month:'short',day:'numeric'});
  let active=false,playing=false,loading,tracks,range,rows=[],at=0,animation=0;
  const resize=new ResizeObserver(()=>draw());
  resize.observe(canvas);

  function draw(){
    if(!range||bar.hidden)return;
    const bounds=canvas.getBoundingClientRect(),ratio=Math.min(2,devicePixelRatio||1);
    const w=canvas.width=Math.max(1,Math.round(bounds.width*ratio)),h=canvas.height=Math.max(1,Math.round(bounds.height*ratio));
    const g=canvas.getContext('2d'),bins=new Uint32Array(Math.max(12,Math.floor(w/(4*ratio))));
    const scale=(range.through-range.start)||1;
    const x=e=>Math.min(w-1,Math.max(0,(e.at-range.start)/scale*w));
    const plotted=rows.filter(e=>e.at>=range.start&&!e.checkpoint);
    for(const e of plotted)bins[Math.floor(x(e)/w*bins.length)]++;
    const max=Math.max(1,...bins),bw=w/bins.length;
    g.clearRect(0,0,w,h);
    g.fillStyle='#739287';
    bins.forEach((n,i)=>{if(n){const height=Math.max(2,h*.8*Math.log1p(n)/Math.log1p(max));g.fillRect(i*bw,h-height,Math.max(1,bw-ratio),height)}});
    for(const e of plotted){
      const ship=e.type==='card'&&(e.column==='uat'||e.column==='done');
      if(e.wait!=='start'&&!ship)continue;
      g.fillStyle=ship?'#3c9b66':'#d58224';
      g.fillRect(x(e),ship?h*.28:0,2*ratio,h*.72);
    }
  }
  function setPlaying(value){
    playing=value;
    play.textContent=value?'Pause':'Play';
  }
  function render(seek=false){
    if(!tracks)return;
    const {roster,poses}=tracks.sample(at);
    scene({roster,poses},seek);
    const text=`${dateLabel.format(at)} · ${clock.format(at)}`;
    const label='Replaying '+text;
    if(badge.textContent!==label){badge.textContent=label;slider.setAttribute('aria-valuetext',text)}
    slider.value=String(Math.floor((at-range.start)/1000));
    const people=[...poses.keys()].map(names);
    const here=people.length?`${people.length} here · ${people.join(', ')}`:'Nobody here';
    if(present.textContent!==here)present.textContent=here;
  }
  async function load({keep=false}={}){
    loading?.abort();
    const before=keep&&range?at:null,resume=keep&&playing;
    const abort=new AbortController();loading=abort;
    setPlaying(false);tracks=null;range=null;rows=[];animation=0;
    canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
    clear();present.textContent='';badge.textContent='Replaying';info.textContent='Loading history…';
    slider.disabled=play.disabled=true;slider.value='0';
    const query=new URLSearchParams({day:select.value,tz});
    try{
      let next,data;
      const events=[];
      do{
        if(next)query.set('cursor',next);
        const response=await fetch(`/api/office/${encodeURIComponent(env)}/history?${query}`,{signal:abort.signal,cache:'no-store'});
        if(!response.ok)throw Error(response.status===404?'History is unavailable for this office.':'Could not load office history.');
        data=await response.json();next=data.next;events.push(...data.events);
      }while(next&&!abort.signal.aborted);
      if(abort.signal.aborted)return;
      range=data;rows=events;
      slider.max=String(Math.floor((range.through-range.start)/1000));
      tracks=replayTracks(rows,data.lease);
      at=Math.min(range.through,Math.max(range.start,before??rows[0]?.at??range.start));
      slider.disabled=play.disabled=!rows.length;
      info.textContent=rows.length?'':'No recorded activity';
      draw();render(true);
      if(resume&&at<range.through&&rows.length)setPlaying(true);
    }catch(e){
      if(!abort.signal.aborted)info.textContent=e.message;
    }
  }
  function open(){
    if(active||button.disabled)return;
    const today=new Date();select.replaceChildren();
    for(let i=0;i<14;i++){
      const d=new Date(today);d.setHours(12,0,0,0);d.setDate(d.getDate()-i);
      select.add(new Option(i===0?'Today':optionLabel.format(d),localDay(d)));
    }
    active=true;
    root.classList.add('of-replaying');
    button.hidden=true;bar.hidden=badge.hidden=false;
    void load();
    select.focus();
  }
  function finish(restore=true){
    if(!active)return;
    loading?.abort();loading=null;tracks=null;range=null;rows=[];
    active=false;setPlaying(false);clear();
    root.classList.remove('of-replaying');
    bar.hidden=badge.hidden=true;button.hidden=false;
    if(restore){live();button.focus({preventScroll:true})}
  }
  button.addEventListener('click',open);
  back.addEventListener('click',()=>finish());
  select.addEventListener('change',()=>load());
  play.addEventListener('click',()=>{
    if(!tracks)return;
    if(!playing&&at>=range.through){at=range.start;render(true)}
    setPlaying(!playing);
  });
  slider.addEventListener('input',()=>{
    if(!tracks)return;
    setPlaying(false);
    at=range.start+Number(slider.value)*1000;
    render(true);
  });
  return {
    get active(){return active},
    tick(dt){
      if(!playing||!tracks)return {dt:0,t:animation};
      const before=at;
      at=Math.min(range.through,at+dt*1000*Number(speed.value));
      const elapsed=dt*ANIMATION_RATES[speed.value];
      animation+=elapsed;
      render();
      for(const e of tracks.between(before,at))react(e);
      if(at>=range.through)setPlaying(false);
      return {dt:elapsed,t:animation};
    },
    reload(){if(active)void load({keep:true})},
    finish,
    destroy(){finish(false);resize.disconnect()},
  };
}
