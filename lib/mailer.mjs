// Outgoing email (invites) through Resend's HTTP API.
// Env: RESEND_API_KEY and a verified FLOW_EMAIL_FROM sender.
// Without a key nothing is sent and callers report "email not configured". Tests use
// FLOW_EMAIL_TRANSPORT=file:<path>, which appends each message as a JSON line instead of sending;
// under verify (ORG_CHART_VERIFY) Resend is never called.
import {appendFileSync} from 'node:fs';

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

// Per-sender (and per-recipient) limits so a slip cannot spam anyone.
export function rateLimit({perSender=20,perRecipient=3,windowMs=3600e3}={}){
  const hits=new Map();
  const take=(k,max)=>{const now=Date.now(),a=(hits.get(k)||[]).filter(t=>now-t<windowMs);if(a.length>=max){hits.set(k,a);return false}a.push(now);hits.set(k,a);return true};
  return (sender,recipient)=>{
    if(!take('s:'+sender.toLowerCase(),perSender))return 'You have sent a lot of invites in the last hour. Try again later.';
    if(!take('r:'+recipient.toLowerCase(),perRecipient))return 'This person was emailed several times in the last hour. Try again later.';
    return '';
  };
}

const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// "You're invited to Flygon Flow": HTML (inline styles, Flygon colours) and plain text.
export function inviteEmail({to,appUrl,inviter}){
  const who=inviter?esc(inviter):'Flygon';
  const subject="You're invited to Flygon Flow";
  const text=`${inviter||'Flygon'} invited you to Flygon Flow: org charts, timelines and a DevOps board in one place.

Sign in to Flow: ${appUrl}

Use "Continue with OneProfileID" with this email address (${to}). If you already have a OneProfileID account, sign in as usual; you will start in your own private workspace.

If you were not expecting this, you can ignore this email.`;
  const html=`<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f6;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1d2725">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f6;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e7e5;border-radius:12px;overflow:hidden">
<tr><td style="height:6px;background:#7cb980;line-height:6px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 8px">
  <div style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#324b34">Flygon Flow</div>
  <h1 style="margin:10px 0 0;font-size:22px;line-height:1.3;color:#1d2725">You're invited to Flygon Flow</h1>
  <p style="margin:14px 0 0;font-size:15px;line-height:1.55;color:#3a4643">${who} invited you to Flygon Flow: org charts, timelines and a DevOps board in one place. You will start in your own private workspace.</p>
</td></tr>
<tr><td style="padding:22px 32px 6px"><a href="${esc(appUrl)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#a8524c;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">Sign in to Flow</a></td></tr>
<tr><td style="padding:14px 32px 28px">
  <p style="margin:0;font-size:13px;line-height:1.55;color:#66726e">Use <strong>Continue with OneProfileID</strong> with this email address (<span style="color:#324b34">${esc(to)}</span>). If you already have a OneProfileID account, sign in as usual.</p>
  <p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#98a39f">If you were not expecting this, you can ignore this email.</p>
</td></tr></table>
<p style="margin:14px 0 0;font-size:11px;color:#98a39f">Flygon LC · <a href="${esc(appUrl)}" style="color:#98a39f">${esc(appUrl.replace(/^https?:\/\//,''))}</a></p>
</td></tr></table></body></html>`;
  return {subject,text,html};
}
