// Masking for text that leaves a machine for the 3D office (docs/concepts/12-office.md): transcript lines
// and the like. Reporters mask before they send (tools/office-bridge.mjs); the server masks again on
// the way in (lib/office.mjs), so a reporter that forgets does not leak a key into someone's browser.
//
//   maskSecrets(text)   tokens, keys, passwords, Authorization headers, credentials in URLs, private
//                       key blocks and .env-looking lines (NAME=value) masked as "•••" (names kept)
//   transcriptText(text, n)  multi-line text cleaned (control characters dropped, blank runs folded),
//                       masked, then cut to n characters
const MASK='•••';
const WORDS='(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|cookie|credential|private[_-]?key|client[_-]?secret|session[_-]?key|access[_-]?key)';
const RULES=[
  // -----BEGIN … PRIVATE KEY----- … -----END … PRIVATE KEY----- (or to the end when cut)
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,()=>'[private key '+MASK+']'],
  // .env lines: NAME=value, export NAME="value" (upper-case names, one per line)
  [/^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{1,}[ \t]*=[ \t]*)(?=\S).*$/gm,(_,k)=>k+MASK],
  // Authorization: Bearer xyz / Authorization: xyz / "authorization": "xyz"
  [/(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]{4,}/gi,(_,k)=>k+MASK],
  [/(\b(?:bearer|basic)\s+)[\w.~+/=-]{8,}/gi,(_,k)=>k+MASK],
  // FOO_TOKEN=xyz, "apiKey": "xyz", password: xyz (the name kept)
  [new RegExp(`(\\b[\\w-]*${WORDS}[\\w-]*["']?\\s*[:=]\\s*["']?)[^\\s"'&,;]{3,}`,'gi'),(_,k)=>k+MASK],
  // --password xyz, --auth-token xyz
  [new RegExp(`((?:^|\\s)--?[\\w-]*(?:${WORDS.slice(3,-1)}|auth)[\\w-]*[ =])[^\\s-]\\S{2,}`,'gi'),(_,k)=>k+MASK],
  // curl -u user:pass, https://user:pass@host
  [/((?:^|\s)-u\s+)\S+:\S+/g,(_,k)=>k+MASK],
  [/(:\/\/[^/\s:@]+:)[^/\s@]+(?=@)/g,(_,k)=>k+MASK],
  // well-known key shapes
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/g,()=>MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{16,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|flow_[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,})\b/g,()=>MASK],
  // JWTs
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,()=>MASK],
  // long opaque strings that mix letters and digits (not paths; a 40 or 64 character hex commit id stays)
  [/(?<![\w/.-])[A-Za-z0-9+_-]{40,}={0,2}(?![\w/.])/g,m=>/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(m)||!/\d/.test(m)||!/[A-Za-z]/.test(m)?m:MASK],
];
export function maskSecrets(text){
  let t=String(text??'');
  for(const [re,f] of RULES)t=t.replace(re,f);
  return t;
}
// Many lines kept as lines: control characters (except newlines) become spaces, spaces folded, at most
// one blank line in a row. Masked before it is cut, so a cut never leaves half a key unmasked.
export function transcriptText(text,n=400){
  if(typeof text!=='string')return '';
  const t=maskSecrets(text.slice(0,n*10).replace(/\r\n?/g,'\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g,' ')
    .replace(/[ \t]+/g,' ').replace(/ ?\n ?/g,'\n').replace(/\n{3,}/g,'\n\n').trim());
  return t.length<=n?t:t.slice(0,n-1).replace(/[\uD800-\uDBFF]$/,'').trimEnd()+'…';
}
