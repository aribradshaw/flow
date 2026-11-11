// Embedding Flow in another site (an iframe on a dashboard or home screen).
//
// Off by default: every response says only this origin may frame Flow
// (Content-Security-Policy: frame-ancestors 'self', plus X-Frame-Options: SAMEORIGIN for old browsers).
// FLOW_FRAME_ANCESTORS lists the extra origins that may embed it, separated by spaces or commas,
// for example "http://127.0.0.1:8770 https://dashboard.example.com". Each entry must be a bare
// origin (scheme, host, optional port). Anything else stops the server at startup.
//
// With embedding on, X-Frame-Options is left out (it cannot name several origins, and browsers that
// understand frame-ancestors ignore it anyway), and on https the sign-in cookies are sent with
// SameSite=None; Secure so a framed Flow on another site can stay signed in. Without embedding the
// cookies stay SameSite=Lax.
//
// Extension point: useEmbedPolicy(fn) adds origins per request. A hosted instance could look up the
// signed-in account's own embed origins there (for example as a plan feature). Nothing uses it yet.

const ORIGIN=/^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

// Parses the FLOW_FRAME_ANCESTORS value into a list of origins. Throws on an invalid entry.
export function parseAncestors(value=''){
  const list=String(value).split(/[\s,]+/).map(s=>s.trim().replace(/\/$/,'')).filter(Boolean);
  for(const o of list){
    if(!ORIGIN.test(o))throw Error(`FLOW_FRAME_ANCESTORS: "${o.slice(0,80)}" is not an origin like https://dashboard.example.com`);
    let u;try{u=new URL(o)}catch{throw Error(`FLOW_FRAME_ANCESTORS: "${o.slice(0,80)}" is not a valid origin`)}
    if(u.origin!==o.toLowerCase()&&u.origin!==o)throw Error(`FLOW_FRAME_ANCESTORS: "${o.slice(0,80)}" is not a bare origin`);
  }
  return [...new Set(list.map(o=>new URL(o).origin))];
}

let policy=null;
// fn(req) returns extra origins (an array, or a promise of one) allowed to frame this response.
export const useEmbedPolicy=fn=>{policy=fn};

export function embedding(value=process.env.FLOW_FRAME_ANCESTORS){
  const origins=parseAncestors(value);
  const on=origins.length>0;
  return {
    origins,on,
    // Headers for one response. Extra per-request origins come from the policy, when one is set.
    async headers(req){
      let extra=[];
      if(policy){try{extra=parseAncestors((await policy(req)||[]).join(' '))}catch{extra=[]}}
      const all=[...new Set([...origins,...extra])];
      const h={'Content-Security-Policy':`frame-ancestors 'self'${all.length?' '+all.join(' '):''}`};
      if(!all.length)h['X-Frame-Options']='SAMEORIGIN';
      return h;
    },
    // Rewrites a Set-Cookie value for framed use: SameSite=None; Secure. Only on https and only
    // when embedding is on; otherwise the cookie is returned unchanged.
    cookie(value,secure){
      if(!on||!secure)return value;
      const parts=String(value).split(';').map(s=>s.trim()).filter(p=>p&&!/^samesite=/i.test(p)&&!/^secure$/i.test(p));
      return [...parts,'SameSite=None','Secure'].join('; ');
    },
  };
}
