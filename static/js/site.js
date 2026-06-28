(function(){
  var sb=document.querySelector('.sidebar'),bd=document.querySelector('.backdrop');
  function toggle(o){ if(!sb)return; sb.classList.toggle('open',o); if(bd) bd.classList.toggle('show',o); document.body.style.overflow=o?'hidden':''; }
  document.querySelectorAll('.burger').forEach(function(bg){ bg.addEventListener('click',function(){ toggle(!sb.classList.contains('open')); }); });
  if(bd) bd.addEventListener('click',function(){ toggle(false); });
  document.querySelectorAll('.sidebar a').forEach(function(a){ a.addEventListener('click',function(){ toggle(false); }); });
  // report iframe auto-resize
  window.addEventListener('message',function(e){
    if(e && e.data && e.data.__rh){
      document.querySelectorAll('.report-embed iframe').forEach(function(f){ f.style.height=(e.data.__rh+12)+'px'; });
    }
  });

  // adaptive contrast: pick light/dark text for elements floating on the sky
  var onsky=[].slice.call(document.querySelectorAll('.js-onsky'));
  if(onsky.length){
    var root=document.documentElement;
    function darkBg(el){
      var r=el.getBoundingClientRect(), pageY=r.top+r.height/2+window.scrollY, skyH=window.innerHeight;
      if(pageY>=skyH-2) return true;                                    // below horizon -> deep sea (dark)
      if(root.classList.contains('night')) return true;
      if(root.classList.contains('twilight')) return (pageY/skyH)<0.72; // dawn/dusk: dark up high, light near horizon
      return false;                                                     // bright day sky -> light backdrop
    }
    function paint(){ for(var i=0;i<onsky.length;i++){ var d=darkBg(onsky[i]); onsky[i].classList.toggle('on-dark',d); onsky[i].classList.toggle('on-light',!d); } }
    var q=false; function sched(){ if(q)return; q=true; requestAnimationFrame(function(){q=false;paint();}); }
    window.addEventListener('scroll',sched,{passive:true});
    window.addEventListener('resize',sched);
    document.addEventListener('visibilitychange',paint);
    new MutationObserver(paint).observe(root,{attributes:true,attributeFilter:['class']}); // repaint synchronously on day/twilight/night change
    paint(); setTimeout(paint,450);
  }
})();
