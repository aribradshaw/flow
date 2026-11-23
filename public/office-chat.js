// Office chat channels. Register an extension before or while the office is open:
//   officeChat.registerChannel({id, label, color, prefix, icon, send, placeholder})
// id is a lowercase slug, prefix is a unique slash command (e.g. "/example"),
// color is a CSS color, and icon is an optional Flow icon name. Returns an unregister function.
// send(text, ctx) returns a Promise. ctx has env, me ({key, name}), and post(reply).
// ctx.post and officeChat.post({channel, from, text, bubbleOn}) show a local reply in
// the active chat log. from is a display name. bubbleOn is an office member key or a
// scene Object3D (e.g. an NPC). Call ctx.post for async replies tied to the originating
// office. Extensions provide their own server transport, authorization and rate limits.
import {icon} from './icons.js';

const channels=new Map([
  ['nearby',{id:'nearby',label:'Nearby',color:'#fff',placeholder:'People within 6 m'}],
  ['office',{id:'office',label:'Office',color:'#b9ddff',prefix:'/o',placeholder:'Everyone in this office'}],
  ['direct',{id:'direct',label:'Direct',color:'#e5d1ff',placeholder:'Message one person'}],
  ['agent',{id:'agent',label:'Agent',color:'#ffdbba',placeholder:'Message your agent'}],
]);
let active;

export const officeChat={
  registerChannel(channel){
    const {id,label,color,prefix,send}=channel;
    if(typeof id!=='string'||!/^[a-z][a-z0-9-]*$/.test(id)||channels.has(id)||
       typeof prefix!=='string'||!/^\/[a-z][a-z0-9-]*$/.test(prefix)||[...channels.values()].some(c=>c.prefix===prefix)||
       !label||!color||typeof send!=='function')throw new TypeError('Expected a unique office chat channel and slash command');
    const entry={...channel};
    channels.set(id,entry);
    active?.refresh();
    return ()=>{if(channels.get(id)===entry){channels.delete(id);active?.refresh()}};
  },
  post(reply){active?.post(reply)},
};

export const chatChannel=id=>channels.get(id);

export function chatPrefix(value,selected='nearby'){
  const draft=value.trimStart(),command=/^(\/[^\s]+)(?:\s+|$)/.exec(draft);
  const channel=command&&[...channels.values()].find(c=>c.prefix===command[1].toLowerCase());
  return channel?{channel:channel.id,text:draft.slice(command[0].length)}:{channel:selected,text:draft};
}

const privateChannel=id=>id==='direct'||id==='agent';
// Direct messages are saved in Flow chat (and OneProfileID) only between OneProfileID friends.
export const DIRECT_HINT='Saved in Flow chat for OneProfileID friends. Others get an office DM: not saved.';
export const directHint=saved=>saved===false?'Not OPID friends: messages here aren’t saved.':saved===true?'Saved in Flow chat and OneProfileID.':DIRECT_HINT;
const norm=value=>value.trim().toLowerCase();
const agentId=a=>JSON.stringify([a.source,a.id]);

// Aliases at an AgentFlow desk keep the identity of the actual steerable session.
export function chatTargets({people,live,agentflow,meKey}){
  const targets=people.filter(p=>p.key!==meKey).map(p=>({id:p.key,name:p.name,channel:'direct',detail:'Person in this office'}));
  const desks=new Map(agentflow.map(a=>[a.id,a.name]));
  for(const a of live){
    if(!a.mine||!a.can?.includes('message'))continue;
    const id=agentId(a),name=a.title||'Agent',detail=['Your agent',a.host].filter(Boolean).join(' · ');
    targets.push({id,name,detail,source:a.source,agentId:a.id,channel:'agent'});
    const desk=desks.get(a.seat?.agent);
    if(desk&&norm(desk)!==norm(name))targets.push({id,name:desk,detail:`${detail} · ${name}`,source:a.source,agentId:a.id,channel:'agent'});
  }
  return targets;
}

export function chatDraft(raw,selected,targets){
  const parsed=chatPrefix(raw,selected.channel),{channel,text}=parsed;
  const mentionAllowed=channel==='nearby'||channel==='office'||privateChannel(channel);
  if(mentionAllowed&&text.startsWith('@')){
    const candidates=targets.filter(t=>!privateChannel(channel)||t.channel===channel);
    const wanted=norm(text.slice(1));
    const matches=candidates.filter(t=>wanted.startsWith(norm(t.name)+' ')||
      text.slice(1).toLowerCase().startsWith(norm(t.name)+' '));
    const length=Math.max(0,...matches.map(t=>t.name.length));
    const eligible=t=>channel!=='office'||t.channel==='agent';
    const exact=matches.filter(t=>t.name.length===length&&eligible(t));
    const suggestions=candidates.filter(t=>eligible(t)&&norm(t.name).startsWith(wanted));
    if(exact.length===1&&!suggestions.some(t=>norm(t.name)!==norm(exact[0].name))){
      const target=exact[0];
      return {channel:target.channel,both:channel==='office',target,text:text.slice(length+1).trimStart()};
    }
    return {channel,both:channel==='office',text:length?text.slice(length+1).trimStart():'',choices:exact.length>1?exact:suggestions};
  }
  const target=targets.find(t=>t.channel===channel&&t.id===selected.target?.id&&t.name===selected.target.name);
  return {...parsed,target,both:!!target&&!!selected.both};
}

export async function sendOfficeChat(draft,api,sendDirect){
  const {channel,both,target,text}=draft,body=text.trim();
  if(channel==='direct')return sendDirect(target.id,body);
  if(channel!=='agent')return api('say',{channel,text:body});
  const agent=()=>api('steer',{kind:'message',source:target.source,agentId:target.agentId,text:body,officeChat:true});
  if(!both)return agent();
  // Each path returns its own outcome, so a partial delivery never invites a retry of both.
  const results=await Promise.allSettled([api('say',{channel:'office',text:body}),agent()]);
  const [office,steer]=results;
  if(office.status==='fulfilled'&&steer.status==='fulfilled')return {ok:true};
  if(office.status==='rejected'&&steer.status==='rejected')throw new Error(`Office: ${office.reason.message}. Agent: ${steer.reason.message}.`);
  return {warning:office.status==='fulfilled'
    ? `Posted to Office. Agent send failed: ${steer.reason.message}`
    : `Sent to agent. Office post failed: ${office.reason.message}`};
}

export function attachOfficeChat({form,env,me,api,show,toast,canSend,targets,sendDirect}){
  const input=form.querySelector('input'),submit=form.querySelector('[type=submit]');
  form.insertAdjacentHTML('afterbegin','<button type="button" class="of-channel" aria-haspopup="true" aria-expanded="false"></button><div class="of-channel-menu" aria-label="Chat channels and recipients" hidden></div>');
  form.insertAdjacentHTML('beforebegin','<div class="of-chat-reply" role="status" hidden></div>');
  form.insertAdjacentHTML('afterend',`<small class="of-chat-privacy" hidden>${DIRECT_HINT}</small>`);
  const chip=form.querySelector('.of-channel'),menu=form.querySelector('.of-channel-menu');
  const notice=form.previousElementSibling,privacy=form.nextElementSibling;
  const draft=()=>chatDraft(input.value,selected,targets());
  // What the last Direct send to each person said: saved in Flow chat, or not (not OneProfileID friends).
  const directSaved=new Map();
  const hintFor=(c,target)=>c.id==='direct'?directHint(target&&directSaved.get(target.id)):c.placeholder||`Message ${c.label}`;
  let selected={channel:'nearby'},sending=false,showChannels=false,noticeTimer;
  const post=({channel,from,text,bubbleOn})=>{
    if(active!==instance||!channels.has(channel)||typeof text!=='string'||!text.trim())return;
    show({id:crypto.randomUUID(),channel,name:from||channels.get(channel).label,text,bubbleOn,at:new Date().toISOString()});
  };
  function receive(line){
    show(line);
    if(line.channel!=='direct'||line.key===me()?.key)return;
    clearTimeout(noticeTimer);
    const reply=document.createElement('button');
    reply.type='button';reply.textContent='Reply';
    reply.onclick=()=>{
      const target=targets().find(t=>t.channel==='direct'&&t.id===line.key);
      if(!target){toast?.('This person has left the office',true);return}
      if(input.value.trim()&&draft().target?.id!==target.id){
        toast?.('Clear your current draft before replying',true);input.focus();return;
      }
      chooseTarget(target,draft().text);notice.hidden=true;
    };
    notice.replaceChildren(`${line.name} · ${line.saved?'Saved in Flow chat':'Office DM: not saved'}`,reply);
    notice.hidden=false;
    noticeTimer=setTimeout(()=>{notice.hidden=true},12000);
  }
  function chooseTarget(target,text,both=false){
    selected={channel:target.channel,target,both};
    input.value=text;showChannels=false;refresh();input.focus();
  }
  function refresh(){
    if(!channels.has(selected.channel))selected={channel:'nearby'};
    const d=draft(),c=channels.get(d.channel);
    chip.replaceChildren();
    if(c.icon)chip.insertAdjacentHTML('beforeend',icon(c.icon,13));
    const label=d.both?`Office + Agent`:c.label;
    const destination=d.target?` → ${d.target.name}`:'';
    chip.append(label+destination);
    chip.title=[label+destination,hintFor(c,d.target)].join(' · ');
    chip.style.setProperty('--of-chat-color',c.color);
    input.placeholder=d.target||!privateChannel(c.id)?c.placeholder||`Message ${c.label}`:'Choose a recipient';
    input.title=hintFor(c,d.target);
    privacy.hidden=c.id!=='direct';
    if(!privacy.hidden)privacy.textContent=hintFor(c,d.target);
    submit.disabled=sending||!d.text.trim()||!!d.choices||(privateChannel(d.channel)&&!d.target);
    paintMenu(d);
  }
  function paintMenu(d){
    const focused=document.activeElement;
    if(menu.contains(focused))return;
    menu.replaceChildren();
    const showTargets=form.contains(focused)&&(!!d.choices||privateChannel(d.channel)&&!d.target);
    const options=d.choices||targets().filter(t=>t.channel===d.channel);
    if(showChannels){
      for(const c of channels.values()){
        addOption(c.prefix?`${c.label} · ${c.prefix}`:c.label,c.color,()=>{
          selected={channel:c.id};input.value=d.text;showChannels=false;refresh();input.focus();
        });
      }
    }else if(showTargets){
      for(const [i,t] of options.entries()){
        const duplicate=options.some(o=>o!==t&&o.name===t.name&&o.detail===t.detail);
        const detail=duplicate?`${t.detail} · ${i+1}`:t.detail;
        addOption(`${t.name} · ${detail}`,channels.get(t.channel).color,()=>chooseTarget(t,d.choices?d.text:input.value,d.both));
      }
      if(!options.length){
        const empty=document.createElement('span');
        empty.textContent='No matching recipients';menu.append(empty);
      }
    }
    menu.hidden=!menu.childElementCount;
    chip.setAttribute('aria-expanded',String(!menu.hidden));
  }
  function addOption(label,color,run){
    const button=document.createElement('button');
    button.type='button';button.textContent=label;
    button.style.setProperty('--of-chat-color',color);
    button.onclick=()=>{input.focus();run()};
    menu.append(button);
  }
  function hideMenu(){showChannels=false;menu.hidden=true;chip.setAttribute('aria-expanded','false')}
  chip.addEventListener('click',()=>{showChannels=!showChannels;refresh()});
  input.addEventListener('input',()=>{showChannels=false;refresh()});
  input.addEventListener('focus',refresh);
  form.addEventListener('focusout',e=>{if(!form.contains(e.relatedTarget))hideMenu()});
  form.addEventListener('keydown',e=>{
    if(menu.hidden||!['ArrowDown','ArrowUp'].includes(e.key))return;
    const buttons=[...menu.querySelectorAll('button')];
    if(!buttons.length)return;
    e.preventDefault();e.stopPropagation();
    const i=buttons.indexOf(document.activeElement),offset=e.key==='ArrowDown'?1:-1;
    buttons[i<0?(offset===1?0:buttons.length-1):(i+offset+buttons.length)%buttons.length].focus();
  });
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const raw=input.value,d=draft(),body=d.text.trim();
    if(sending||d.choices||privateChannel(d.channel)&&!d.target||!canSend()||!body)return;
    const c=channels.get(d.channel);
    sending=true;refresh();
    try{
      const result=c.send?await c.send(body,{env,me:me(),post}):await sendOfficeChat(d,api,sendDirect);
      if(active!==instance)return;
      if(d.channel==='direct'&&typeof result?.saved==='boolean')directSaved.set(d.target.id,result.saved);
      if(input.value===raw){input.value='';selected={channel:'nearby'}}
      if(result?.warning)toast?.(result.warning,true);
    }catch(error){if(active===instance)toast?.(error.message,true)}
    finally{sending=false;if(active===instance)refresh()}
  });
  const instance={post,receive,refresh,directTo(key){
    const target=targets().find(t=>t.channel==='direct'&&t.id===key);
    if(target)chooseTarget(target,draft().text);
  },escape(target){
    const d=draft();
    if(menu.hidden&&!form.contains(target)&&d.channel==='nearby'&&!d.choices)return false;
    input.value=d.text;selected={channel:'nearby'};hideMenu();input.focus();refresh();return true;
  },dispose(){clearTimeout(noticeTimer);if(active===instance)active=null}};
  active=instance;refresh();
  return instance;
}
