// ============================================
// SoundForge AI — P3R Faithful UI
// ============================================
(function(){
  'use strict';

  let currentScene='menu', focusIdx=-1, playIdx=-1, isPlaying=false, ws=null, activeGenre='all';

  const barList=document.getElementById('barList');
  const detailEmpty=document.getElementById('detailEmpty');
  const detailFilled=document.getElementById('detailFilled');
  const mp=document.getElementById('mp');

  // ── シーン切替 ──
  function go(id){
    if(id===currentScene)return;
    const t=document.getElementById('trans');
    t.classList.remove('out');t.classList.add('in');
    setTimeout(()=>{
      document.querySelectorAll('.sc').forEach(s=>s.classList.remove('active'));
      document.getElementById('sc-'+id).classList.add('active');
      currentScene=id;
      // ブラウザ履歴に追加
      history.pushState({scene:id},'','#'+id);
      t.classList.remove('in');t.classList.add('out');
      setTimeout(()=>t.classList.remove('out'),400);
    },300);
  }
  window.goScene=go;

  // ── ブラウザ戻る/進む対応 ──
  window.addEventListener('popstate',e=>{
    const id=e.state?.scene||(location.hash?location.hash.slice(1):'menu');
    if(id===currentScene)return;
    document.querySelectorAll('.sc').forEach(s=>s.classList.remove('active'));
    document.getElementById('sc-'+id).classList.add('active');
    currentScene=id;
  });

  // ── Wavesurfer ──
  function initWS(){
    ws=WaveSurfer.create({
      container:'#mpWave',
      waveColor:'rgba(77,232,244,.08)',
      progressColor:'#e8232a',
      cursorColor:'#4de8f4',
      cursorWidth:2,barWidth:2,barGap:1,barRadius:1,
      height:36,responsive:true,normalize:true
    });
    ws.on('timeupdate',t=>{
      document.getElementById('mpCur').textContent=fmt(t);
      const d=ws.getDuration();
      if(d>0)document.getElementById('mpProg').style.width=(t/d*100)+'%';
    });
    ws.on('ready',()=>{document.getElementById('mpDur').textContent=fmt(ws.getDuration())});
    ws.on('finish',()=>adj(1));
    ws.on('play',()=>{isPlaying=true;syncUI()});
    ws.on('pause',()=>{isPlaying=false;syncUI()});
  }

  const GENRE_JP={'jazz':'ジャズ','horror':'ホラー','rpg-battle':'バトル','rpg-town':'タウン','chillhop':'Lo-Fi','dungeon':'ダンジョン'};

  function filt(){return TRACKS.filter(t=>activeGenre==='all'||t.genre===activeGenre)}

  // ── バーリスト描画 ──
  function render(){
    const list=filt();
    const rc=list.filter(t=>t.status==='ready').length;
    document.getElementById('browseCount').textContent=
      '全'+list.length+'曲（'+rc+'曲公開中）';

    const hn=document.getElementById('heroCount');
    if(hn)hn.textContent=TRACKS.length;

    barList.innerHTML=list.map((t,i)=>{
      const gi=TRACKS.indexOf(t);
      const sel=gi===focusIdx;
      const soon=t.status==='soon';
      const gl=GENRE_JP[t.genre]||t.genre;
      return `
        <div class="p3r-bar${sel?' bar-selected':''}${soon?' bar-soon':''}" data-gi="${gi}">
          <div class="bar-label">${gl}</div>
          <span class="bar-name">${t.title}${soon?'<span class="bar-soon-tag">準備中</span>':''}</span>
          <span class="bar-meta">${fmt(t.duration)}</span>
        </div>`;
    }).join('');

    barList.querySelectorAll('.p3r-bar').forEach(b=>{
      b.addEventListener('click',()=>{
        const gi=+b.dataset.gi;
        if(TRACKS[gi].status==='soon'){
          // 準備中の曲 → 一瞬揺れるフィードバック
          b.style.animation='none';
          b.offsetHeight; // reflow
          b.style.animation='barShake .3s ease';
          return;
        }
        focus(gi);
      });
    });
  }

  // ── フォーカス ──
  function focus(gi){
    focusIdx=gi;
    const t=TRACKS[gi];
    const list=filt();
    const di=list.indexOf(t);

    // バーのフォーカス
    barList.querySelectorAll('.p3r-bar').forEach(b=>b.classList.remove('bar-selected'));
    const row=barList.querySelector(`.p3r-bar[data-gi="${gi}"]`);
    if(row){row.classList.add('bar-selected');row.scrollIntoView({block:'nearest',behavior:'smooth'})}

    // 詳細
    detailEmpty.style.display='none';
    detailFilled.style.display='';
    document.getElementById('dfNum').textContent='#'+String(di+1).padStart(2,'0');
    document.getElementById('dfTitle').textContent=t.title;
    document.getElementById('dfDesc').textContent=t.description;
    document.getElementById('dfBpm').textContent=t.bpm;
    document.getElementById('dfKey').textContent=t.key;
    document.getElementById('dfTime').textContent=fmt(t.duration);
    document.getElementById('dfTags').innerHTML=
      `<span class="dtag">${t.genreLabel}</span><span class="dtag">${t.moodLabel}</span>`;

    const dl=document.getElementById('dfDl');
    dl.style.display=t.file_mp3?'':'none';
    if(t.file_mp3){dl.href=t.file_mp3;dl.download=t.title+'.mp3'}

    syncDetailBtn();
  }

  // ── 再生 ──
  function play(gi){
    const t=TRACKS[gi];
    if(!t||t.status==='soon')return;
    if(playIdx===gi&&isPlaying){ws.pause();return}
    if(playIdx===gi&&!isPlaying){ws.play();return}
    playIdx=gi;
    document.getElementById('mpTitle').textContent=t.title;
    mp.classList.add('visible');
    document.getElementById('mpProg').style.width='0%';
    // ミニプレイヤー表示時、各シーンの下部にパディング追加
    document.body.classList.add('mp-active');
    ws.load(t.file_mp3);
    ws.once('ready',()=>ws.play());
  }

  function adj(dir){
    const p=filt().filter(t=>t.status==='ready');
    if(!p.length)return;
    const c=p.findIndex(t=>TRACKS.indexOf(t)===playIdx);
    const n=(c+dir+p.length)%p.length;
    const gi=TRACKS.indexOf(p[n]);
    focus(gi);play(gi);
  }

  function syncUI(){
    const pp=document.getElementById('mpPlay');
    pp.querySelector('.icon-play').style.display=isPlaying?'none':'';
    pp.querySelector('.icon-pause').style.display=isPlaying?'':'none';
    syncDetailBtn();
  }

  function syncDetailBtn(){
    const btn=document.getElementById('dfPlay');
    if(!btn)return;
    const cur=focusIdx===playIdx&&isPlaying;
    btn.querySelector('.icon-play').style.display=cur?'none':'';
    btn.querySelector('.icon-pause').style.display=cur?'':'none';
    document.getElementById('dfPlayLabel').textContent=cur?'一時停止':'再生';
  }

  function fmt(s){const m=Math.floor(s/60);return m+':'+Math.floor(s%60).toString().padStart(2,'0')}

  // ── イベント ──
  function bind(){
    // メニュー項目クリック
    document.querySelectorAll('.menu-item').forEach(mi=>{
      mi.addEventListener('click',()=>{
        const target=mi.dataset.target;
        document.querySelectorAll('.menu-item').forEach(m=>m.classList.remove('mi-active'));
        mi.classList.add('mi-active');
        go(target.replace('sc-',''));
      });
      mi.addEventListener('mouseenter',()=>{
        document.querySelectorAll('.menu-item').forEach(m=>m.classList.remove('mi-active'));
        mi.classList.add('mi-active');
      });
    });

    // シーン内ナビリンク（楽曲↔案内の相互移動）
    document.querySelectorAll('.nav-link[data-nav]').forEach(link=>{
      link.addEventListener('click',()=>go(link.dataset.nav));
    });

    // ジャンルタブ
    document.querySelectorAll('#genreFilter .genre-tab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        document.querySelectorAll('#genreFilter .genre-tab').forEach(t=>t.classList.remove('gt-active'));
        tab.classList.add('gt-active');
        activeGenre=tab.dataset.genre;
        focusIdx=-1;
        detailEmpty.style.display='';detailFilled.style.display='none';
        render();
      });
    });

    // 詳細の再生
    document.getElementById('dfPlay').addEventListener('click',()=>{
      if(focusIdx>=0)play(focusIdx);
    });

    // ミニプレイヤー
    document.getElementById('mpPlay').addEventListener('click',()=>{if(playIdx>=0)ws.playPause()});
    document.getElementById('mpPrev').addEventListener('click',()=>adj(-1));
    document.getElementById('mpNext').addEventListener('click',()=>adj(1));

    // ミニプレイヤーの曲名クリック → 楽曲一覧でフォーカス
    document.getElementById('mpTitle').addEventListener('click',()=>{
      if(playIdx>=0){
        if(currentScene!=='browse')go('browse');
        setTimeout(()=>focus(playIdx),currentScene!=='browse'?400:0);
      }
    });

    // キーボード
    document.addEventListener('keydown',e=>{
      // Escapeはどのシーンでもメニューに戻る
      if(e.key==='Escape'&&currentScene!=='menu'){e.preventDefault();go('menu');return}

      if(currentScene==='menu'){
        // メニューでのキーボード操作
        const items=[...document.querySelectorAll('.menu-item')];
        const ci=items.findIndex(m=>m.classList.contains('mi-active'));
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){
          e.preventDefault();
          const ni=e.key==='ArrowDown'?(ci+1)%items.length:(ci-1+items.length)%items.length;
          items.forEach(m=>m.classList.remove('mi-active'));
          items[ni].classList.add('mi-active');
        }
        if(e.key==='Enter'){
          e.preventDefault();
          const active=items.find(m=>m.classList.contains('mi-active'));
          if(active)active.click();
        }
        return;
      }

      if(currentScene!=='browse')return;
      const list=filt().filter(t=>t.status==='ready');
      if(!list.length)return;
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){
        e.preventDefault();
        const c=list.findIndex(t=>TRACKS.indexOf(t)===focusIdx);
        let n;
        if(e.key==='ArrowDown')n=c<0?0:(c+1)%list.length;
        else n=c<=0?list.length-1:c-1;
        focus(TRACKS.indexOf(list[n]));
      }
      if(e.key==='Enter'&&focusIdx>=0){e.preventDefault();play(focusIdx)}
    });
  }

  function init(){
    initWS();render();bind();

    // URL ハッシュから初期シーン復元
    const hash=location.hash.slice(1);
    if(hash&&document.getElementById('sc-'+hash)){
      document.querySelectorAll('.sc').forEach(s=>s.classList.remove('active'));
      document.getElementById('sc-'+hash).classList.add('active');
      currentScene=hash;
    }
    history.replaceState({scene:currentScene},'','#'+currentScene);

    // エントリートランジション
    const t=document.getElementById('trans');
    t.classList.add('in');
    setTimeout(()=>{t.classList.remove('in');t.classList.add('out');
      setTimeout(()=>t.classList.remove('out'),400);
    },200);
  }

  document.addEventListener('DOMContentLoaded',init);
})();
