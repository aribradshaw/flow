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
]);
let active;

export const officeChat={
  registerChannel(channel){
    const {id,label,color,prefix,send}=channel;
    if(typeof id!=='string'||!/^[a-z][a-z0-9-]*$/.test(id)||channels.has(id)||
       typeof prefix!=='string'||!/^\/[a-z][a-z0-9-]*$/.test(prefix)||[...channels.values()].some(c=>c.prefix===prefix)||
       !label||!color||typeof send!=='function')throw new TypeError('Expected a unique office chat channel and slash command');
    channels.set(id,{...channel});
    active?.refresh();
    return ()=>{channels.delete(id);active?.refresh()};
  },
  post(reply){active?.post(reply)},
};

export const chatChannel=id=>channels.get(id);

export function chatPrefix(value,selected='nearby'){
  const draft=value.trimStart(),command=/^(\/[^\s]+)(?:\s+|$)/.exec(draft);
  const channel=command&&[...channels.values()].find(c=>c.prefix===command[1].toLowerCase());
  return channel?{channel:channel.id,text:draft.slice(command[0].length)}:{channel:selected,text:draft};
}

export function attachOfficeChat({form,env,me,api,show,toast,canSend}){
  const input=form.querySelector('input'),submit=form.querySelector('[type=submit]');
  form.insertAdjacentHTML('afterbegin','<button type="button" class="of-channel" aria-haspopup="true" aria-expanded="false"></button><div class="of-channel-menu" hidden></div>');
  const chip=form.querySelector('.of-channel'),menu=form.querySelector('.of-channel-menu');
  let selected='nearby',sending=false;
  const post=({channel,from,text,bubbleOn})=>{
    if(active!==instance||!channels.has(channel)||typeof text!=='string'||!text.trim())return;
    const key=me()?.key;
    show({id:crypto.randomUUID(),channel,name:from||channels.get(channel).label,text,bubbleOn,key,at:new Date().toISOString()});
  };
  function refresh(){
    if(!channels.has(selected))selected='nearby';
    const {channel,text}=chatPrefix(input.value,selected),c=channels.get(channel);
    chip.replaceChildren();
    if(c.icon)chip.insertAdjacentHTML('beforeend',icon(c.icon,13)||'');
    chip.append(c.label);
    chip.style.setProperty('--of-chat-color',c.color);
    input.placeholder=c.placeholder||`Message ${c.label}`;
    input.title=input.placeholder;
    submit.disabled=sending||!text.trim();
    if(!menu.hidden)paintMenu();
  }
  function paintMenu(){
    menu.replaceChildren();
    for(const c of channels.values()){
      const button=document.createElement('button');
      button.type='button';
      button.textContent=c.prefix?`${c.label} · ${c.prefix}`:c.label;
      button.style.setProperty('--of-chat-color',c.color);
      button.onclick=()=>{selected=c.id;hideMenu();refresh();input.focus()};
      menu.append(button);
    }
  }
  function hideMenu(){menu.hidden=true;chip.setAttribute('aria-expanded','false')}
  chip.addEventListener('click',()=>{
    if(!menu.hidden){hideMenu();return}
    menu.hidden=false;chip.setAttribute('aria-expanded','true');paintMenu();
  });
  input.addEventListener('input',refresh);
  form.addEventListener('focusout',e=>{if(!form.contains(e.relatedTarget))hideMenu()});
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const raw=input.value,{channel,text}=chatPrefix(raw,selected),body=text.trim();
    if(!body||sending||!canSend())return;
    const c=channels.get(channel);
    sending=true;refresh();
    try{
      if(c.send)await c.send(body,{env,me:me(),post});
      else await api('say',{channel,text:body});
      if(input.value===raw)input.value='';
    }catch(error){if(active===instance)toast?.(error.message,true)}
    finally{sending=false;refresh()}
  });
  const instance={post,refresh,escape(target){
    if(menu.hidden&&!form.contains(target)&&selected==='nearby'&&chatPrefix(input.value).channel==='nearby')return false;
    const {text}=chatPrefix(input.value);input.value=text;selected='nearby';hideMenu();refresh();return true;
  },dispose(){if(active===instance)active=null}};
  active=instance;refresh();
  return instance;
}
