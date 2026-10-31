// Loading splash: "flow" writes itself stroke by stroke on white, then fades out into the app.
//
// When it shows (standard practice: never make a fast load slower to show off a brand moment):
//   - First load in a browser session: always plays once.
//   - Any other load: only if startup is still running after 300ms. Fast loads never see it.
//   - Once visible it finishes writing the word (about 1.4s) before fading, so it never flashes.
//     If the app still isn't ready by then, the word breathes until it is.
// "Ready" is the app removing aria-busy from <body> at the end of startup (app.js). A 12s fallback
// clears it so an error underneath can never stay hidden.
//
// For slow in-app work (loading a big save, switching environments):
//   flowSplash.during(promise)  shows the splash only if the work takes longer than 300ms.
//
// Classic (non-module) script, loaded right after the #splash markup so it runs before first paint.
(()=>{
  const el=document.getElementById('splash');if(!el)return;
  const DELAY=300,DRAW=1400,HOLD=150,FADE=550,FALLBACK=12000;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let first=true;
  try{first=!sessionStorage.getItem('flow.splash');sessionStorage.setItem('flow.splash','1')}catch{}

  let shownAt=0,ready=false,timer=0,outTimer=0;
  const drawn=()=>reduced?400:DRAW+HOLD;

  function show(late=true){
    clearTimeout(outTimer);
    if(!el.isConnected)document.body.prepend(el);
    el.classList.remove('out','wait','draw');
    void el.offsetWidth;                    // restart the stroke animation
    el.classList.add('on','draw');el.classList.toggle('late',late);
    el.setAttribute('aria-hidden','false');
    shownAt=performance.now();
    timer=setTimeout(()=>{if(!ready)el.classList.add('wait')},drawn());
  }
  function hide(){
    clearTimeout(timer);
    if(!shownAt){el.remove();return}
    const wait=Math.max(0,shownAt+drawn()-performance.now());
    outTimer=setTimeout(()=>{
      el.classList.remove('wait');el.classList.add('out');
      el.setAttribute('aria-hidden','true');
      outTimer=setTimeout(()=>{el.classList.remove('on','draw','out');el.remove();shownAt=0},reduced?150:FADE);
    },wait);
  }
  function done(){if(ready)return;ready=true;hide()}

  if(first)show(false);
  else setTimeout(()=>{if(!ready)show()},DELAY);

  const watch=()=>{
    if(!document.body.hasAttribute('aria-busy'))return done();
    new MutationObserver((_,o)=>{if(!document.body.hasAttribute('aria-busy')){o.disconnect();done()}})
      .observe(document.body,{attributes:true,attributeFilter:['aria-busy']});
  };
  document.body?watch():addEventListener('DOMContentLoaded',watch);
  setTimeout(done,FALLBACK);

  window.flowSplash={
    async during(work){
      ready=false;
      const t=setTimeout(show,DELAY);
      try{return await work}
      finally{clearTimeout(t);ready=true;hide()}
    },
  };
})();
