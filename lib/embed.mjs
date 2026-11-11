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
// Everything is decided per request: decide(req) runs once at the start of each request (server.mjs)
// and its answer, kept on req.flowEmbed, drives both the frame headers and the cookies of that response.
// The env var sets the default. Extension point: useEmbedPolicy(fn) lets a host change the decision per
// request, for example a hosted instance allowing a signed-in account's own embed origins on its own
// embed URLs, or partitioned cookies. Nothing uses it yet.

const ORIGIN=/^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

// Parses the FLOW_FRAME_ANCESTORS value into a list of origins. Throws on an invalid entry.
export function parseAncestors(value=''){
  const list=String(value).split(/[\s,]+/).map(s=>s.trim().replace(/\/$/,'')).filter(Boolean);
  for(const o of list){
    let u=null;try{u=ORIGIN.test(o)&&new URL(o)}catch{}
    if(!u||u.origin!==o.toLowerCase())throw Error(`FLOW_FRAME_ANCESTORS: "${o.slice(0,80)}" is not a bare origin like https://dashboard.example.com`);
  }
  return [...new Set(list.map(o=>new URL(o).origin))];
}

// fn(req, base) returns (or resolves to) a change to the default decision for this request:
//   {origins: [...]}        extra origins allowed to frame this response (invalid ones are ignored)
//   {framedCookies: bool}   send this response's sign-in cookies as SameSite=None; Secure (https only)
//   {partitioned: bool}     add Partitioned (CHIPS) to those cookies
// An array is shorthand for {origins}. base is the env-var default: {origins, framedCookies, partitioned}.
let policy=null;
export const useEmbedPolicy=fn=>{policy=fn};

export function embedding(value=process.env.FLOW_FRAME_ANCESTORS){
  const origins=parseAncestors(value);
  const base={origins,framedCookies:origins.length>0,partitioned:false};
  const self={
    origins,on:origins.length>0,
    // The decision for one request. A failing or invalid policy falls back to the default.
    async decide(req){
      if(!policy)return base;
      let p;try{p=await policy(req,base)}catch{return base}
      if(!p)return base;
      if(Array.isArray(p))p={origins:p};
      let extra=[];try{extra=parseAncestors((Array.isArray(p.origins)?p.origins:[]).join(' '))}catch{}
      return {origins:[...new Set([...origins,...extra])],
        framedCookies:typeof p.framedCookies==='boolean'?p.framedCookies:base.framedCookies||extra.length>0,
        partitioned:p.partitioned===true};
    },
    // Frame headers for a decision.
    headers(d=base){
      const h={'Content-Security-Policy':`frame-ancestors 'self'${d.origins.length?' '+d.origins.join(' '):''}`};
      if(!d.origins.length)h['X-Frame-Options']='SAMEORIGIN';
      return h;
    },
    // A Set-Cookie value for a decision: SameSite=None; Secure (and Partitioned when asked) on https when
    // framed cookies are on; otherwise unchanged.
    cookie(value,secure,d=base){
      if(!d?.framedCookies||!secure)return value;
      const parts=String(value).split(';').map(s=>s.trim()).filter(p=>p&&!/^(samesite=.*|secure|partitioned)$/i.test(p));
      return [...parts,'SameSite=None','Secure',...(d.partitioned?['Partitioned']:[])].join('; ');
    },
  };
  return self;
}
