// Animated Flygon Flow mark for the top-left of the header.
//
//   logoMark(size)  Returns the SVG markup. Three nested diamonds breathe on a shared loop, with a
//                   wave that runs from the core outward, each diamond shifting opacity and shade.
//   Hover           The diamonds lean toward the pointer (parallax), the middle and outer diamonds
//                   counter-rotate a quarter turn, and the mark glows.
//   Click           A spring "punch" ripples outward through the diamonds, a ring diamond
//                   shockwaves out, and the core steps to the next brand shade.
//
// The header is re-rendered with innerHTML often, so the loop phase is pinned to a page clock
// (negative animation-delay) and the core shade lives in module state: re-renders never make the
// mark jump. Listeners are delegated on document for the same reason. Styles are in
// logo-mark.css, which this module links once on import. prefers-reduced-motion stops all motion.

const PERIOD=3200;
const SHADES=['var(--flygon-green)','var(--flygon-mint)','var(--flygon-light)','var(--flygon-olive)','var(--flygon-rose)'];
const SPRING='cubic-bezier(.34,1.56,.64,1)';
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
let shade=0;

if(!document.querySelector('link[data-logo-mark]')){
  const l=document.createElement('link');
  l.rel='stylesheet';l.href='/logo-mark.css';l.dataset.logoMark='';
  document.head.append(l);
}

const D=r=>`${12},${12-r} ${12+r},${12} ${12},${12+r} ${12-r},${12}`;

export function logoMark(size=20){
  const t=-(performance.now()%PERIOD);
  return `<svg class="lm" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="--lm-t:${t}ms;--lm-core:${SHADES[shade]}">
    <g class="lm-p lm-p3"><g class="lm-spin lm-spin-out"><polygon class="lm-d lm-outer" points="${D(10)}"/></g></g>
    <g class="lm-p lm-p2"><g class="lm-spin lm-spin-mid"><polygon class="lm-d lm-mid" points="${D(6)}"/></g></g>
    <g class="lm-p lm-p1"><polygon class="lm-d lm-core" points="${D(2.8)}"/></g>
  </svg>`;
}

const markOf=e=>e.target instanceof Element?e.target.closest('.logo')?.querySelector('.lm'):null;

document.addEventListener('pointermove',e=>{
  const svg=markOf(e);if(!svg||reduced())return;
  const r=svg.getBoundingClientRect();
  const x=Math.max(-1,Math.min(1,(e.clientX-r.left)/r.width*2-1));
  const y=Math.max(-1,Math.min(1,(e.clientY-r.top)/r.height*2-1));
  svg.style.setProperty('--px',x.toFixed(3));
  svg.style.setProperty('--py',y.toFixed(3));
});

document.addEventListener('pointerout',e=>{
  const svg=markOf(e);if(!svg)return;
  if(e.relatedTarget instanceof Node&&svg.closest('.logo').contains(e.relatedTarget))return;
  svg.style.setProperty('--px',0);svg.style.setProperty('--py',0);
});

document.addEventListener('click',e=>{
  const svg=markOf(e);if(!svg)return;
  shade=(shade+1)%SHADES.length;
  svg.style.setProperty('--lm-core',SHADES[shade]);
  if(reduced())return;
  const punch=(sel,peak,delay)=>svg.querySelector(sel).animate(
    [{transform:'scale(1)'},{transform:`scale(${peak})`,offset:.35},{transform:'scale(1)'}],
    {duration:620,delay,easing:SPRING,composite:'add'});
  punch('.lm-core',1.9,0);punch('.lm-mid',1.22,70);punch('.lm-outer',1.12,140);
  svg.animate([{transform:'rotate(0) scale(1)'},{transform:'rotate(-8deg) scale(.9)',offset:.25},{transform:'rotate(0) scale(1)'}],
    {duration:520,easing:SPRING,composite:'add'});
  const ring=document.createElementNS('http://www.w3.org/2000/svg','polygon');
  ring.setAttribute('points',D(6));ring.setAttribute('class','lm-ring');
  svg.append(ring);
  ring.animate([{transform:'scale(.6)',opacity:.9,strokeWidth:2.4},{transform:'scale(2.1)',opacity:0,strokeWidth:.4}],
    {duration:700,easing:'cubic-bezier(.2,.7,.2,1)'}).finished.finally(()=>ring.remove());
});
