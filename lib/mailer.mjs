// Outgoing email (invites) through Resend's HTTP API.
// Env: RESEND_API_KEY and a verified FLOW_EMAIL_FROM sender.
// Without a key nothing is sent and callers report "email not configured". Tests use
// FLOW_EMAIL_TRANSPORT=file:<path>, which appends each message as a JSON line instead of sending;
// under verify (ORG_CHART_VERIFY) Resend is never called.
import {appendFileSync} from 'node:fs';
import {render} from '@aribradshaw/onemail';
import {flowBrand} from './email-brand.mjs';

export function createMailer(env=process.env){
  const key=env.RESEND_API_KEY||'',from=env.FLOW_EMAIL_FROM||'',file=/^file:(.+)$/.exec(env.FLOW_EMAIL_TRANSPORT||'')?.[1];
  const verify=!!env.ORG_CHART_VERIFY;
  return {
    configured:!!file||(!!key&&!!from&&!verify),
    async send({to,subject,html,text}){
      if(file){appendFileSync(file,JSON.stringify({at:new Date().toISOString(),from,to,subject,html,text})+'\n');return {ok:true,id:'file'}}
      if(!key||verify)return {ok:false,notConfigured:true,error:'Email is not configured'};
      try{
        const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({from,to:[to],subject,html,text}),signal:AbortSignal.timeout(10000)});
        const d=await r.json().catch(()=>({}));
        return r.ok?{ok:true,id:d.id||''}:{ok:false,error:String(d.message||d.error||`Resend answered ${r.status}`).slice(0,200)};
      }catch{return {ok:false,error:'The email service could not be reached'}}
    },
  };
}

// The inviter as the email names them: their OneProfileID display name, as plain text. Anything that
// could pass for a link or an address (or is not a short name) is replaced, so an invite can never
// carry a sender-chosen link in Flow's branded email. Sending limits are in server.mjs (persistent).
export function inviterLabel(name){
  const v=String(name||'').replace(/[\u0000-\u001f\u007f<>]/g,'').replace(/\s+/g,' ').trim();
  if(!v||v.length>60||/[@\/\\]|:\/\/|www\.|\.[a-z]{2,}(?:\s|$)/i.test(v))return '';
  return v;
}

// "You're invited to Flygon Flow", rendered by OneMail with Flow's brand (lib/email-brand.mjs):
// logo, preheader and the Flygon LC footer. The plain text is written here, unchanged. Transactional.
export function inviteEmail({to,appUrl,inviter}){
  const who=inviterLabel(inviter)||'A Flygon Flow member';
  const subject="You're invited to Flygon Flow";
  const text=`${who} invited you to Flygon Flow: org charts, timelines and a DevOps board in one place.

Sign in to Flow: ${appUrl}

Use "Continue with OneProfileID" with this email address (${to}). If you already have a OneProfileID account, sign in as usual; you will start in your own private workspace.

If you were not expecting this, you can ignore this email.`;
  const {html}=render({brand:flowBrand(appUrl),subject,preheader:`${who} invited you to Flygon Flow. Sign in with OneProfileID to start.`,blocks:[
    {type:'heading',text:"You're invited to Flygon Flow"},
    {type:'paragraph',text:`${who} invited you to Flygon Flow: org charts, timelines and a DevOps board in one place. You will start in your own private workspace.`},
    {type:'button',text:'Sign in to Flow',href:appUrl},
    {type:'small',text:['Use ',{text:'Continue with OneProfileID',bold:true},` with this email address (${to}). If you already have a OneProfileID account, sign in as usual.`]},
    {type:'small',text:'If you were not expecting this, you can ignore this email.'},
  ]});
  return {subject,text,html};
}
