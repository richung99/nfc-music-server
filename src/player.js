// ── Remote debug logger ────────────────────────────────────────────────────────
// Debug logging disabled — re-enable by restoring dbg() body
function dbg(){}
function dbgAudio(){}

// ── Utilities ──────────────────────────────────────────────────────────────────
function formatTime(secs){
  if(!secs||isNaN(secs)) return '0:00';
  const m=Math.floor(secs/60), s=Math.floor(secs%60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}
function getAlbumId(){
  const parts=window.location.pathname.split('/').filter(Boolean);
  return parts[parts.length-1]||null;
}

// ── State ──────────────────────────────────────────────────────────────────────
let album=null, currentTrack=0, isPlaying=false;

// ── DOM refs ───────────────────────────────────────────────────────────────────
const audio           = document.getElementById('audio');
const playerEl        = document.getElementById('player');
const coverImg        = document.getElementById('coverImg');
const coverWrap       = document.getElementById('coverWrap');
const statusBadge     = document.getElementById('statusBadge');
const albumTitle      = document.getElementById('albumTitle');
const albumArtist     = document.getElementById('albumArtist');
const progressFill    = document.getElementById('progressFill');
const progressHandle  = document.getElementById('progressHandle');
const progressTrack   = document.getElementById('progressTrack');
const timeElapsed     = document.getElementById('timeElapsed');
const timeTotal       = document.getElementById('timeTotal');
const btnPlay         = document.getElementById('btnPlay');
const btnPrev         = document.getElementById('btnPrev');
const btnNext         = document.getElementById('btnNext');
const iconPlay        = document.getElementById('iconPlay');
const iconPause       = document.getElementById('iconPause');
const tracklistBody   = document.getElementById('tracklistBody');
const nowPlayingTitle = document.getElementById('nowPlayingTitle');
const statusDot       = document.getElementById('statusDot');
const statusText      = document.getElementById('statusText');
const boot            = document.getElementById('boot');
const btnShuffle      = document.getElementById('btnShuffle');
const iconShuffle     = document.getElementById('iconShuffle');
const btnLoop         = document.getElementById('btnLoop');
const iconLoopOff     = document.getElementById('iconLoopOff');
const iconLoopAll     = document.getElementById('iconLoopAll');
const iconLoopOne     = document.getElementById('iconLoopOne');

// ── Boot sound ─────────────────────────────────────────────────────────────────
const VOICE_DURATION = 1500;
const _voiceEl = new Audio(`${window.location.origin}/retrochung_final_v4.wav`);
_voiceEl.preload='auto'; _voiceEl.load();

function playHarpAccompaniment(ac){
  const t=ac.currentTime;
  [[2093,0.650],[1318,0.740],[2637,0.830],[1760,0.930],[2093,1.070],[1568,1.200],[1046,1.350]].forEach(([freq,start])=>{
    const osc=ac.createOscillator(), gain=ac.createGain();
    osc.connect(gain); gain.connect(ac.destination); osc.type='sine'; osc.frequency.value=freq;
    gain.gain.setValueAtTime(0,t+start); gain.gain.linearRampToValueAtTime(0.09,t+start+0.02); gain.gain.exponentialRampToValueAtTime(0.001,t+start+0.7);
    osc.start(t+start); osc.stop(t+start+0.75);
  });
}

function playStartupSound(){
  return new Promise(resolve=>{
    try{
      const ac=new(window.AudioContext||window.webkitAudioContext)();
      const voiceEl=_voiceEl; voiceEl.currentTime=0;
      const playPromise=voiceEl.play();
      const fireWebAudio=()=>{
        const t=ac.currentTime;
        const bufSize=ac.sampleRate*0.07, noiseBuf=ac.createBuffer(1,bufSize,ac.sampleRate), data=noiseBuf.getChannelData(0);
        for(let i=0;i<bufSize;i++) data[i]=(Math.random()*2-1)*0.07;
        const noise=ac.createBufferSource(), noiseGain=ac.createGain();
        noise.buffer=noiseBuf; noise.connect(noiseGain); noiseGain.connect(ac.destination);
        noiseGain.gain.setValueAtTime(1,t); noiseGain.gain.exponentialRampToValueAtTime(0.001,t+0.07); noise.start(t);
        playHarpAccompaniment(ac);
      };
      if(playPromise!==undefined){ playPromise.then(()=>fireWebAudio()).catch(()=>fireWebAudio()); }
      else fireWebAudio();
      voiceEl.onended=()=>{ setTimeout(resolve,1600); };
      setTimeout(resolve,VOICE_DURATION+3000);
    } catch(e){ dbg(`playStartupSound error: ${e.message}`, 'error'); resolve(); }
  });
}

// ── Boot sequence ──────────────────────────────────────────────────────────────
async function runBootSequence(){
  dbg('runBootSequence start', 'event');
  boot.style.display='flex';
  await playStartupSound();
  dbg('startup sound done', 'event');
  if(playerEl.dataset.ready==='true') playerEl.style.display='flex';
  setTimeout(()=>{
    boot.classList.add('hidden');
    setTimeout(()=>{
      boot.remove();
      dbg('boot removed, calling startMusicPlayback', 'event');
      startMusicPlayback();
    },500);
  },300);
}

window._runBootSequence=function(){
  loadAlbum().then(()=>runBootSequence());
};

// ── Album loading ──────────────────────────────────────────────────────────────
async function loadAlbum(){
  // Check for a gacha playlist stored by gacha.html's PLAY button first.
  const gachaRaw = sessionStorage.getItem('gachaPlaylist');
  if(gachaRaw){
    // Don't remove yet — only consume after successful parse
    try{
      const playlist = JSON.parse(gachaRaw);
          sessionStorage.removeItem('gachaPlaylist'); // consume only after successful parse
      album = {
        title: playlist.name,
        artist: [playlist.mood, playlist.speed, playlist.setting]
          .map(s => s.charAt(0).toUpperCase() + s.slice(1))
          .join(' · '),
        year: null,
        cover: null,
        mood: playlist.mood || '',
        setting: playlist.setting || '',
        tracks: playlist.tracks.map(t => ({
          title: t.title,
          url: t.url,
          duration: t.duration || 0,
          artist: t.artist,
          albumTitle: t.albumTitle,
        })),
        _gacha: true,
        _covers: playlist.covers || [],
      };
          dbg(`gacha playlist loaded: "${album.title}" (${album.tracks.length} tracks)`, 'event');
      document.title = `${album.title} - RETROCHUNG`;
      albumTitle.textContent = album.title;
      albumArtist.textContent = album.artist;
          // Show mosaic cover for gacha playlists
      const collage = document.getElementById('coverCollage');
      const img = document.getElementById('coverImg');
      if(collage && album._covers.length){
        img.style.display = 'none';
        collage.style.display = 'block';
        collage.innerHTML = '';
        try {
          buildMosaic(album._covers, 280, playlist.id || 'default').then(canvas => {
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.display = 'block';
            collage.appendChild(canvas);
          }).catch(e => { dbg(`buildMosaic error: ${e.message}`, 'error'); });
        } catch(e) {
          dbg(`buildMosaic sync error: ${e.message}`, 'error');
        }
      }
          renderTracklist();
          playerEl.style.display = 'none';
      playerEl.dataset.ready = 'true';
      loadTrack(0, false);
          return;
    } catch(e){
      dbg(`gacha playlist parse error: ${e.message}`, 'error');
      // fall through to normal album loading
    }
  }

  const id=getAlbumId();
  dbg(`loadAlbum id=${id}`, 'info');
  if(!id){ showError('No album specified.'); return; }
  try{
    const res=await fetch(`${window.location.origin}/api/album/${id}`);
    if(!res.ok) throw new Error(`Album "${id}" not found.`);
    album=await res.json();
    dbg(`album loaded: ${album.title} (${album.tracks.length} tracks)`, 'event');
  } catch(e){ showError(e.message); dbg(`loadAlbum error: ${e.message}`, 'error'); return; }
  document.title=`${album.title} - NFC Player`;
  albumTitle.textContent=album.title;
  albumArtist.textContent=[album.artist,album.year].filter(Boolean).join(' \xB7 ');
  coverImg.src=`${window.location.origin}${album.cover}`;
  coverImg.onerror=()=>{ coverImg.style.display='none'; };
  renderTracklist();
  playerEl.style.display='none';
  playerEl.dataset.ready='true';
  loadTrack(0, false);
}

// ── Tracklist ──────────────────────────────────────────────────────────────────

function renderTracklist(){
  tracklistBody.innerHTML='';
  album.tracks.forEach((t,i)=>{
    const row=document.createElement('div');
    row.className='track-row'+(album._gacha?' gacha-track':'');
    const subtitle = album._gacha && t.artist ? `<span class="track-artist">${t.artist}${t.albumTitle ? ` · <span class="track-album">${t.albumTitle}</span>` : ''}</span>` : '';
    const editBtn  = album._gacha ? `<button class="track-edit-btn" aria-label="Edit track" data-idx="${i}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>` : '';
    row.innerHTML=`<span class="track-num">${i+1}</span><span class="track-bars"><span class="bar"></span><span class="bar"></span><span class="bar"></span></span><span class="track-title-wrap"><span class="track-title">${t.title}</span>${subtitle}</span><span class="track-dur">${t.duration?formatTime(t.duration):''}</span>${editBtn}`;
    row.addEventListener('click', e => {
      if(e.target.closest('.track-edit-btn')) return;
      dbg(`tracklist click track ${i}`, 'event');
      loadTrack(i, true);
    });
    tracklistBody.appendChild(row);
    if(album._gacha){
      const editor = buildTrackEditor(t, i);
      tracklistBody.appendChild(editor);
      row.querySelector('.track-edit-btn').addEventListener('click', e => {
        e.stopPropagation();
        const isOpen = editor.classList.contains('open');
        editor.classList.toggle('open', !isOpen);
        e.currentTarget.classList.toggle('open', !isOpen);
      });
    }
  });
}

const MOOD_TOOLTIPS = {
  sunny:  "carefree and genuinely happy. song of the summer energy. romantic and hopeful.",
  rainy:  "interior and quiet, nostalgic and wanting. the world got smaller and your feelings got bigger.",
  stormy: "massive and unsubtle. heavy, dramatic, demanding. something is at stake.",
  windy:  "restless, brisk, evanescent. moving toward something, light on your feet but not lightweight.",
  snowy:  "the world is white and muffled and everything slowed down. the cold is always there.",
  cloudy: "hazy and unhurried. not sad, not happy, just floating. not trying to get anywhere.",
};
const SETTING_TOOLTIPS = {
  bedroom: "private. just for you, in the room where you're most yourself.",
  cafe:    "semi-public, low stakes. present but not performing.",
  drive:   "the road and the music are the same thing for a while.",
  travel:  "displacement. airports, trains, your normal life is on pause.",
  gym:     "physical, focused, a little aggressive. no room for anything soft.",
  work:    "you need to be productive but also not lose your mind.",
}; 
const STAR_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.2691 4.41115C11.5006 3.89177 11.6164 3.63208 11.7776 3.55211C11.9176 3.48263 12.082 3.48263 12.222 3.55211C12.3832 3.63208 12.499 3.89177 12.7305 4.41115L14.5745 8.54808C14.643 8.70162 14.6772 8.77839 14.7302 8.83718C14.777 8.8892 14.8343 8.93081 14.8982 8.95929C14.9705 8.99149 15.0541 9.00031 15.2213 9.01795L19.7256 9.49336C20.2911 9.55304 20.5738 9.58288 20.6997 9.71147C20.809 9.82316 20.8598 9.97956 20.837 10.1342C20.8108 10.3122 20.5996 10.5025 20.1772 10.8832L16.8125 13.9154C16.6877 14.0279 16.6252 14.0842 16.5857 14.1527C16.5507 14.2134 16.5288 14.2807 16.5215 14.3503C16.5132 14.429 16.5306 14.5112 16.5655 14.6757L17.5053 19.1064C17.6233 19.6627 17.6823 19.9408 17.5989 20.1002C17.5264 20.2388 17.3934 20.3354 17.2393 20.3615C17.0619 20.3915 16.8156 20.2495 16.323 19.9654L12.3995 17.7024C12.2539 17.6184 12.1811 17.5765 12.1037 17.56C12.0352 17.5455 11.9644 17.5455 11.8959 17.56C11.8185 17.5765 11.7457 17.6184 11.6001 17.7024L7.67662 19.9654C7.18404 20.2495 6.93775 20.3915 6.76034 20.3615C6.60623 20.3354 6.47319 20.2388 6.40075 20.1002C6.31736 19.9408 6.37635 19.6627 6.49434 19.1064L7.4341 14.6757C7.46898 14.5112 7.48642 14.429 7.47814 14.3503C7.47081 14.2807 7.44894 14.2134 7.41394 14.1527C7.37439 14.0842 7.31195 14.0279 7.18708 13.9154L3.82246 10.8832C3.40005 10.5025 3.18884 10.3122 3.16258 10.1342C3.13978 9.97956 3.19059 9.82316 3.29993 9.71147C3.42581 9.58288 3.70856 9.55304 4.27406 9.49336L8.77835 9.01795C8.94553 9.00031 9.02911 8.99149 9.10139 8.95929C9.16534 8.93081 9.2226 8.8892 9.26946 8.83718C9.32241 8.77839 9.35663 8.70162 9.42508 8.54808L11.2691 4.41115Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function buildTrackEditor(track, idx){
  const editor = document.createElement('div');
  editor.className = 'track-editor';
  editor.dataset.idx = idx;

  const mood    = album?.mood    || '';
  const setting = album?.setting || '';

  // ── localStorage keys ────────────────────────────────────────────────────
  const urlParts = track.url.split('/');
  const albumId  = urlParts[urlParts.length - 2];
  const file     = urlParts[urlParts.length - 1];
  const pendingKey = `pending:${albumId}:${file}:${mood}:${setting}`;

  // Load existing pending rating if any
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(pendingKey)); } catch(e) {}

  // Baseline: pending rating if exists, otherwise 3 (neutral)
  const baseMood    = pending?.mood_rating    ?? 3;
  const baseSetting = pending?.setting_rating ?? 3;

  editor.innerHTML = `
    <div class="editor-question">
      <div class="editor-question-text">Does this fit <span class="editor-combo-label" title="${MOOD_TOOLTIPS[mood] || ''}">${mood}</span>?</div>
      <div class="editor-question-sub">1 = wrong vibe &nbsp;&middot;&nbsp; 3 = neutral &nbsp;&middot;&nbsp; 5 = perfect vibe</div>
      <div class="star-row" data-question="mood" data-selected="${baseMood}" data-baseline="${baseMood}"></div>
    </div>
    <div class="editor-question">
      <div class="editor-question-text">Does this fit <span class="editor-combo-label" title="${SETTING_TOOLTIPS[setting] || ''}">${setting}</span>?</div>
      <div class="editor-question-sub">1 = wrong fit &nbsp;&middot;&nbsp; 3 = neutral &nbsp;&middot;&nbsp; 5 = perfect fit</div>
      <div class="star-row" data-question="setting" data-selected="${baseSetting}" data-baseline="${baseSetting}"></div>
    </div>
    <div class="editor-actions">
      <button class="editor-reset">RESET</button>
      <button class="editor-save">${pending ? 'UPDATE' : 'SAVE'}</button>
    </div>
    ${pending ? '<div class="editor-pending-note">pending until next batch</div>' : ''}
  `;

  // ── Render stars ──────────────────────────────────────────────────────────
  function renderStars(row, selected, baseline) {
    row.querySelectorAll('.star-btn').forEach(b => {
      const val = parseInt(b.dataset.val);
      b.disabled = false;
      b.classList.remove('filled', 'star-baseline', 'star-selected');
      if(selected === baseline) {
        // No change from baseline — all dim
        if(val <= baseline) b.classList.add('filled', 'star-baseline');
      } else if(val <= selected) {
        // Within new selection — bright
        b.classList.add('filled', 'star-selected');
      } else if(val <= baseline) {
        // Above selection, within baseline — dim
        b.classList.add('filled', 'star-baseline');
      }
      // Above both — empty
    });
  }

  editor.querySelectorAll('.star-row').forEach(row => {
    for(let n = 1; n <= 5; n++){
      const btn = document.createElement('button');
      btn.className = 'star-btn';
      btn.dataset.val = n;
      btn.setAttribute('aria-label', n + ' star');
      btn.innerHTML = STAR_SVG;
      row.appendChild(btn);
    }
    const baseline = parseInt(row.dataset.baseline);
    const selected = parseInt(row.dataset.selected);
    renderStars(row, selected, baseline);
  });

  // ── Star click ────────────────────────────────────────────────────────────
  editor.querySelectorAll('.star-row').forEach(row => {
    row.querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if(btn.disabled) return;
        const val      = parseInt(btn.dataset.val);
        const baseline = parseInt(row.dataset.baseline);
        row.dataset.selected = val;
        renderStars(row, val, baseline);
        // Update save button state
        updateSaveBtn();
      });
    });
  });

  // ── Save button state ─────────────────────────────────────────────────────
  function updateSaveBtn() {
    const saveBtn       = editor.querySelector('.editor-save');
    const moodRow       = editor.querySelector('[data-question="mood"]');
    const settingRow    = editor.querySelector('[data-question="setting"]');
    const moodSelected    = parseInt(moodRow.dataset.selected);
    const settingSelected = parseInt(settingRow.dataset.selected);
    const moodBase        = parseInt(moodRow.dataset.baseline);
    const settingBase     = parseInt(settingRow.dataset.baseline);
    const noChange = moodSelected === moodBase && settingSelected === settingBase;
    saveBtn.disabled = noChange;
    if(noChange) saveBtn.title = 'No change from current rating';
    else saveBtn.title = '';
  }
  updateSaveBtn();

  // ── Reset ─────────────────────────────────────────────────────────────────
  editor.querySelector('.editor-reset').addEventListener('click', () => {
    editor.querySelectorAll('.star-row').forEach(row => {
      const baseline = parseInt(row.dataset.baseline);
      row.dataset.selected = baseline;
      renderStars(row, baseline, baseline);
    });
    updateSaveBtn();
  });

  // ── Save (localStorage only — flushes on next batch) ─────────────────────
  editor.querySelector('.editor-save').addEventListener('click', () => {
    const saveBtn       = editor.querySelector('.editor-save');
    const moodRating    = parseInt(editor.querySelector('[data-question="mood"]').dataset.selected);
    const settingRating = parseInt(editor.querySelector('[data-question="setting"]').dataset.selected);

    const newPending = { mood_rating: moodRating, setting_rating: settingRating, mood, setting, albumId, file };
    localStorage.setItem(pendingKey, JSON.stringify(newPending));

    // Update baseline to new saved value so save button disables again
    const moodRow    = editor.querySelector('[data-question="mood"]');
    const settingRow = editor.querySelector('[data-question="setting"]');
    moodRow.dataset.baseline    = moodRating;
    settingRow.dataset.baseline = settingRating;
    renderStars(moodRow,    moodRating,    moodRating);
    renderStars(settingRow, settingRating, settingRating);

    saveBtn.textContent = 'UPDATE';
    // Show pending note if not already shown
    if(!editor.querySelector('.editor-pending-note')){
      const note = document.createElement('div');
      note.className = 'editor-pending-note';
      note.textContent = 'pending until next batch';
      editor.querySelector('.editor-actions').after(note);
    }
    updateSaveBtn();
  });

  return editor;
}


function updateTracklistActive(){
  document.querySelectorAll('.track-row').forEach((row,i)=>{
    row.classList.toggle('active',i===currentTrack);
    row.classList.toggle('playing',i===currentTrack&&isPlaying);
  });
}

// ── Playback ───────────────────────────────────────────────────────────────────
function startMusicPlayback(){
  dbg('startMusicPlayback', 'event');
  if(!album) return;
  audio.volume = 0.6;
  dbgAudio('before startMusicPlayback play()');
  audio.play()
    .then(()=>{ dbg('startMusicPlayback play() OK', 'event'); setPlaying(true); })
    .catch(e=>{ dbg(`startMusicPlayback play() FAILED: ${e.name} ${e.message}`, 'error'); setPlaying(false); });
}

function loadTrack(index, autoPlay=false){
  if(!album||index<0||index>=album.tracks.length){
    dbg(`loadTrack(${index}) OOB or no album`, 'warn');
    return;
  }
  const trackName=album.tracks[index].title;
  dbg(`loadTrack(${index}, autoPlay=${autoPlay}) "${trackName}"`, 'info');
  currentTrack=index;
  _nextTrackPreloaded = false;
  if(_advanceTimer)   { clearTimeout(_advanceTimer);   _advanceTimer=null; }
  if(_heartbeatTimer) { clearTimeout(_heartbeatTimer); _heartbeatTimer=null; }
  nowPlayingTitle.textContent=trackName;
  audio.oncanplay=null;
  audio.src=`${window.location.origin}${album.tracks[index].url}`;
  audio.volume = 0.6;
  audio.load();
  dbgAudio('after load()');

  if(autoPlay){
    let started=false;
    const tryPlay=(source)=>{
      if(started){ dbg(`tryPlay(${source}) skipped — already started`, 'warn'); return; }
      started=true;
      audio.oncanplay=null;
      dbg(`tryPlay(${source}) calling play()`, 'info');
      dbgAudio(`tryPlay(${source}) before play()`);
      audio.play()
        .then(()=>{ dbg(`play() OK via ${source}`, 'event'); setPlaying(true); })
        .catch(e=>{ dbg(`play() REJECTED via ${source}: ${e.name} — ${e.message}`, 'error'); markStalled(); });
    };
    audio.oncanplay=()=>tryPlay('canplay');
    setTimeout(()=>tryPlay('timeout-1500'), 1500);
  }

  const activeRow=tracklistBody.children[index];
  if(activeRow) activeRow.scrollIntoView({behavior:'smooth',block:'nearest'});
  updateMediaSession();
}

// ── Glow animation ─────────────────────────────────────────────────────────────
let glowIntensity=0, glowTarget=0, glowRAF=null;
function animateGlow(){
  const LERP=0.035, BREATH=3000;
  glowIntensity+=(glowTarget-glowIntensity)*LERP;
  const breathe=0.5+0.5*Math.sin((Date.now()/BREATH)*Math.PI*2);
  const spread=(20+breathe*35)*glowIntensity, opacity=(0.20+breathe*0.35)*glowIntensity;
  coverWrap.style.boxShadow=`0 0 0 1px var(--bg),0 0 0 2px var(--gold),0 0 ${spread.toFixed(1)}px rgba(200,168,75,${opacity.toFixed(3)}),inset 0 0 30px rgba(0,0,0,0.3)`;
  const btnSpread=(8+breathe*20)*glowIntensity, btnOpacity=(0.25+breathe*0.45)*glowIntensity;
  btnPlay.style.boxShadow=`0 0 ${btnSpread.toFixed(1)}px rgba(200,168,75,${btnOpacity.toFixed(3)})`;
  if(glowIntensity>0.005||glowTarget>0){ glowRAF=requestAnimationFrame(animateGlow); }
  else{ glowIntensity=0; coverWrap.style.boxShadow=''; btnPlay.style.boxShadow=''; glowRAF=null; }
}
function setGlowTarget(state){ glowTarget=state?1:0; if(!glowRAF) glowRAF=requestAnimationFrame(animateGlow); }

function setPlaying(state){
  dbg(`setPlaying(${state})`, 'state');
  isPlaying=state;
  iconPlay.style.display=state?'none':'block'; iconPause.style.display=state?'block':'none';
  coverWrap.classList.toggle('playing',state); btnPlay.classList.toggle('playing',state);
  statusBadge.classList.toggle('visible',state); statusDot.classList.toggle('active',state);
  statusText.textContent=state?'PLAYING':'PAUSED'; setGlowTarget(state); updateTracklistActive();
  if('mediaSession' in navigator) navigator.mediaSession.playbackState=state?'playing':'paused';
}

function togglePlay(){
  if(!album) return;
  dbg(`togglePlay isPlaying=${isPlaying}`, 'event');
  _startKeepalive();
  if(isPlaying){ audio.pause(); setPlaying(false); }
  else{ audio.play().then(()=>setPlaying(true)).catch(e=>dbg(`togglePlay play() failed: ${e.name}`, 'error')); }
}

// ── Stall recovery ─────────────────────────────────────────────────────────────
let pendingResume=false;
function markStalled(){
  dbg('markStalled', 'warn');
  dbgAudio('at stall');
  pendingResume=true;
  setPlaying(false);
  statusText.textContent='TAP TO RESUME';
}
function attemptResume(){
  if(!pendingResume) return;
  dbg('attemptResume via tap', 'event');
  pendingResume=false;
  dbgAudio('before attemptResume play()');
  audio.play()
    .then(()=>{ dbg('attemptResume play() OK', 'event'); setPlaying(true); })
    .catch(e=>{ dbg(`attemptResume play() FAILED: ${e.name} ${e.message}`, 'error'); markStalled(); });
}
coverWrap.addEventListener('click', attemptResume);
btnPlay.addEventListener('click', attemptResume);

// ── Shuffle / loop ─────────────────────────────────────────────────────────────
let shuffleOn=false, shuffleQueue=[], shufflePos=0;
let loopMode=0;

function updateLoopIcon(){
  iconLoopOff.style.display=loopMode===0?'block':'none';
  iconLoopAll.style.display=loopMode===1?'block':'none';
  iconLoopOne.style.display=loopMode===2?'block':'none';
  const color=loopMode===0?'#8a8070':'#c8a84b';
  iconLoopOff.setAttribute('fill',color);
  iconLoopAll.setAttribute('fill',color);
  iconLoopOne.setAttribute('fill',color);
}
function buildShuffleQueue(s){
  const a=Array.from({length:album.tracks.length},(_,i)=>i);
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  const si=a.indexOf(s); if(si>0){ a.splice(si,1); a.unshift(s); }
  shuffleQueue=a; shufflePos=0;
}
function nextShuffleTrack(){ shufflePos=(shufflePos+1)%shuffleQueue.length; return shuffleQueue[shufflePos]; }
function prevShuffleTrack(){ shufflePos=(shufflePos-1+shuffleQueue.length)%shuffleQueue.length; return shuffleQueue[shufflePos]; }

// ── Android Chrome keepalive ───────────────────────────────────────────────────
// Chrome on Android keeps JS alive in background only when an HTMLAudioElement
// is actively playing. We serve a real silent MP3 and loop it.
let _keepaliveEl = null;

function _startKeepalive(){
  if(_keepaliveEl) return;
  try {
    _keepaliveEl        = new Audio('/silent.mp3');
    _keepaliveEl.loop   = true;
    _keepaliveEl.volume = 0.001;
    const p = _keepaliveEl.play();
    if(p) p
      .then(()=>dbg('keepalive playing', 'info'))
      .catch(e=>{ dbg(`keepalive failed: ${e.message}`, 'error'); _keepaliveEl=null; });
  } catch(e) {
    dbg(`keepalive init failed: ${e.message}`, 'error');
  }
}


let _nextTrackPreloaded  = false;

function _getNextIndex(){
  if(loopMode===2) return currentTrack;
  if(shuffleOn) return nextShuffleTrack();
  if(currentTrack < album.tracks.length-1) return currentTrack+1;
  if(loopMode===1) return 0;
  return -1;
}

function _advanceTrack(){
  const next = _getNextIndex();
  if(next === -1){
    setPlaying(false);
    audio.currentTime=0;
    progressFill.style.width='0%';
    progressHandle.style.left='0%';
    return;
  }
  _nextTrackPreloaded = false;
  loadTrack(next, true);
}

let _advanceTimer    = null;
let _heartbeatTimer  = null;
const MAX_HEARTBEAT_MS = 8000; // never wait more than 8s between checks

function _scheduleAdvance(remaining){
  if(_advanceTimer)   { clearTimeout(_advanceTimer);   _advanceTimer   = null; }
  if(_heartbeatTimer) { clearTimeout(_heartbeatTimer); _heartbeatTimer = null; }
  if(!remaining || !isFinite(remaining) || remaining < 0) return;

  dbg(`scheduleAdvance: ${remaining.toFixed(1)}s remaining`, 'info');

  if(remaining <= 0.5){
    // At or past end — fire immediately
    const next = _getNextIndex();
    if(next === -1) return;
    dbg(`immediate advance → loadTrack(${next})`, 'warn');
    _nextTrackPreloaded = true;
    loadTrack(next, true);
  } else if(remaining <= 8.5){
    // Within 8.5s — set precise final timer
    const delay = Math.max(0, (remaining - 0.5) * 1000);
    dbg(`final advance timer in ${(delay/1000).toFixed(1)}s`, 'info');
    _advanceTimer = setTimeout(()=>{
      if(!isPlaying) return;
      const next = _getNextIndex();
      if(next === -1) return;
      dbg(`advance timer fired → loadTrack(${next})`, 'warn');
      _nextTrackPreloaded = true;
      loadTrack(next, true);
    }, delay);
  } else {
    // Use heartbeat — interval is 1/3 of remaining time, capped at 8s
    const hbMs = Math.min(MAX_HEARTBEAT_MS, Math.floor(remaining / 3 * 1000));
    dbg(`heartbeat in ${(hbMs/1000).toFixed(1)}s (${remaining.toFixed(1)}s remaining)`, 'info');
    _heartbeatTimer = setTimeout(()=>{
      if(!isPlaying || !audio.duration) return;
      const newRemaining = audio.duration - audio.currentTime;
      dbg(`heartbeat tick — ${newRemaining.toFixed(1)}s remaining`, 'info');
      _scheduleAdvance(newRemaining);
    }, hbMs);
  }
}

audio.addEventListener('timeupdate',()=>{
  if(!audio.duration) return;
  const pct=(audio.currentTime/audio.duration)*100;
  progressFill.style.width=pct+'%'; progressHandle.style.left=pct+'%';
  timeElapsed.textContent=formatTime(audio.currentTime);
});
audio.addEventListener('loadedmetadata',()=>{
  dbg(`loadedmetadata dur=${audio.duration?.toFixed(1)}`, 'event');
  timeTotal.textContent=formatTime(audio.duration);
  // Don't schedule advance here — wait for 'playing' which gives us accurate currentTime
});
audio.addEventListener('canplay',()=>dbg('canplay fired', 'event'));
audio.addEventListener('playing',()=>{
  dbg('playing fired', 'event');
  setPlaying(true);
  // Schedule advance based on remaining time
  if(audio.duration) {
    const remaining = audio.duration - audio.currentTime;
    dbg(`playing: ${remaining.toFixed(1)}s remaining`, 'info');
    _scheduleAdvance(remaining);
  }
});
audio.addEventListener('pause',()=>{
  // Ignore OS-forced pauses while screen is locked
  if(document.visibilityState !== 'visible'){
    dbg('pause fired while hidden — ignoring (OS suspend)', 'warn');
    return;
  }
  dbg('pause fired', 'event');
  if(_advanceTimer)   { clearTimeout(_advanceTimer);   _advanceTimer=null; }
  if(_heartbeatTimer) { clearTimeout(_heartbeatTimer); _heartbeatTimer=null; dbg('heartbeat cleared on pause','info'); }
  if(!pendingResume) setPlaying(false);
});
audio.addEventListener('stalled',()=>{ dbg('STALLED', 'warn'); dbgAudio('stall'); markStalled(); });
audio.addEventListener('error',()=>{ dbg(`ERROR code=${audio.error?.code} msg=${audio.error?.message}`, 'error'); dbgAudio('error'); markStalled(); });
audio.addEventListener('waiting',()=>{
  dbg('waiting fired', 'warn');
  setTimeout(()=>{ if(audio.readyState<3 && !audio.paused) markStalled(); }, 4000);
});
audio.addEventListener('ended',()=>{
  dbg(`ended — loopMode=${loopMode} shuffle=${shuffleOn} track=${currentTrack}/${album?.tracks.length-1}`, 'event');
  _advanceTrack();
});

// ── Controls ───────────────────────────────────────────────────────────────────
function seekTo(e){
  if(!audio.duration) return;
  const rect=progressTrack.getBoundingClientRect();
  const x=(e.touches?e.touches[0].clientX:e.clientX)-rect.left;
  audio.currentTime=Math.max(0,Math.min(1,x/rect.width))*audio.duration;
}
progressTrack.addEventListener('click',seekTo);
progressTrack.addEventListener('touchstart',seekTo,{passive:true});
btnPlay.addEventListener('click',togglePlay);
btnLoop.addEventListener('click',()=>{
  loopMode=(loopMode+1)%3;
  audio.loop=loopMode===2;
  dbg(`loopMode → ${loopMode}`, 'event');
  updateLoopIcon();
});
btnShuffle.addEventListener('click',()=>{
  shuffleOn=!shuffleOn;
  iconShuffle.setAttribute('fill',shuffleOn?'#c8a84b':'#8a8070');
  if(shuffleOn) buildShuffleQueue(currentTrack);
  dbg(`shuffle → ${shuffleOn}`, 'event');
});
btnPrev.addEventListener('click',()=>{
  dbg('btnPrev click', 'event');
  if(audio.currentTime>3){ audio.currentTime=0; }
  else if(shuffleOn){ loadTrack(prevShuffleTrack(),isPlaying); }
  else{ loadTrack(currentTrack-1,isPlaying); }
});
btnNext.addEventListener('click',()=>{
  dbg('btnNext click', 'event');
  if(shuffleOn){ loadTrack(nextShuffleTrack(),isPlaying); }
  else if(currentTrack<album.tracks.length-1){ loadTrack(currentTrack+1,isPlaying); }
  else if(loopMode===1){ loadTrack(0,isPlaying); }
});
document.addEventListener('keydown',(e)=>{
  if(e.code==='Space'){ e.preventDefault(); togglePlay(); }
  if(e.code==='ArrowRight') loadTrack(currentTrack+1,isPlaying);
  if(e.code==='ArrowLeft')  loadTrack(currentTrack-1,isPlaying);
});

// ── Screen lock recovery ────────────────────────────────────────────────────────
document.addEventListener('visibilitychange',()=>{
  const vis=document.visibilityState;
  dbg(`visibilitychange → ${vis}`, 'event');
  dbgAudio('on visibility');
  if(vis !== 'visible') return;

  // If we were playing but OS suspended audio, resume
  if(isPlaying && audio.paused){
    dbg('screen woke — was playing but paused, resuming', 'warn');
    audio.play()
      .then(()=>{
        dbg('resume after visibilitychange OK', 'event');
        setPlaying(true);
        // Reschedule advance timer based on remaining time
        if(audio.duration){
          const remaining = audio.duration - audio.currentTime;
          dbg(`rescheduling advance: ${remaining.toFixed(1)}s remaining`, 'info');
          _scheduleAdvance(remaining);
        }
      })
      .catch(e=>{ dbg(`resume after visibilitychange FAILED: ${e.name}`, 'error'); markStalled(); });
  } else if(isPlaying && !audio.paused && audio.duration){
    // Playing fine — just reschedule timer in case it was killed while hidden
    const remaining = audio.duration - audio.currentTime;
    dbg(`screen wake — reschedule advance: ${remaining.toFixed(1)}s remaining`, 'info');
    _scheduleAdvance(remaining);
  }
});

// ── MediaSession ───────────────────────────────────────────────────────────────
let _msLastAction = 0;
function _msDebounce(fn){
  return ()=>{
    const now = Date.now();
    if(now - _msLastAction < 300){ dbg('MediaSession action debounced', 'info'); return; }
    _msLastAction = now;
    fn();
  };
}

function updateMediaSession(){
  if(!('mediaSession' in navigator)||!album) return;
  const track=album.tracks[currentTrack];
  navigator.mediaSession.metadata=new MediaMetadata({
    title:track.title, artist:album.artist||'', album:album.title||'',
    artwork:[{src:window.location.origin+album.cover,sizes:'500x500',type:'image/jpeg'}]
  });
  navigator.mediaSession.setActionHandler('play', _msDebounce(()=>{
    dbg('MediaSession play', 'event');
    pendingResume=false;
    audio.play().then(()=>setPlaying(true)).catch(e=>{ dbg(`MediaSession play failed: ${e.name}`, 'error'); markStalled(); });
  }));
  navigator.mediaSession.setActionHandler('pause', _msDebounce(()=>{
    dbg('MediaSession pause', 'event');
    if(!isPlaying){ dbg('MediaSession pause ignored — already paused', 'info'); return; }
    audio.pause(); setPlaying(false);
  }));
  navigator.mediaSession.setActionHandler('previoustrack', _msDebounce(()=>{
    dbg('MediaSession previoustrack', 'event');
    if(audio.currentTime>3){audio.currentTime=0;}else{loadTrack(currentTrack-1, isPlaying);}
  }));
  navigator.mediaSession.setActionHandler('nexttrack', _msDebounce(()=>{
    dbg('MediaSession nexttrack', 'event');
    loadTrack(currentTrack+1, isPlaying);
  }));
  navigator.mediaSession.setActionHandler('seekto', (d)=>{
    if(d.seekTime!==undefined){ dbg(`MediaSession seekto ${d.seekTime.toFixed(1)}`, 'event'); audio.currentTime=d.seekTime; }
  });
}

// ── Error display ──────────────────────────────────────────────────────────────
function showError(msg){
  document.getElementById('stateError').style.display='flex';
  document.getElementById('errorMsg').textContent=msg;
}

// ── CRT effect ─────────────────────────────────────────────────────────────────
(function(){
  const canvas=document.getElementById('crt');
  const ctx=canvas.getContext('2d');
  let noiseCanvas=document.createElement('canvas'), noiseCtx=noiseCanvas.getContext('2d'), noiseAge=0;
  const NOISE_INTERVAL=3;
  function buildNoise(W,H){
    noiseCanvas.width=W; noiseCanvas.height=H;
    const imageData=noiseCtx.createImageData(W,H), data=imageData.data;
    for(let i=0;i<data.length;i+=4){const v=Math.random()*255|0;data[i]=data[i+1]=data[i+2]=v;data[i+3]=Math.random()<0.35?(Math.random()*18|0):0;}
    noiseCtx.putImageData(imageData,0,0);
  }
  let vigCanvas=document.createElement('canvas'), vigCtx=vigCanvas.getContext('2d');
  function buildVignette(W,H){
    vigCanvas.width=W; vigCanvas.height=H;
    const grad=vigCtx.createRadialGradient(W/2,H/2,H*0.25,W/2,H/2,H*0.85);
    grad.addColorStop(0,'rgba(0,0,0,0)'); grad.addColorStop(0.6,'rgba(0,0,0,0.05)'); grad.addColorStop(1,'rgba(0,0,0,0.28)');
    vigCtx.fillStyle=grad; vigCtx.fillRect(0,0,W,H);
  }
  let shimmerPhases=null;
  function initShimmer(H){ shimmerPhases=new Float32Array(Math.ceil(H/4)); for(let i=0;i<shimmerPhases.length;i++) shimmerPhases[i]=Math.random()*Math.PI*2; }
  function resize(){ const W=canvas.width=window.innerWidth, H=canvas.height=window.innerHeight; buildNoise(W,H); buildVignette(W,H); initShimmer(H); }
  resize(); window.addEventListener('resize',resize);
  let frame=0;
  function draw(){
    requestAnimationFrame(draw); frame++;
    const W=canvas.width, H=canvas.height; ctx.clearRect(0,0,W,H);
    const bleedW=Math.min(W*0.06,30);
    const redGrad=ctx.createLinearGradient(0,0,bleedW,0); redGrad.addColorStop(0,'rgba(255,0,0,0.06)'); redGrad.addColorStop(1,'rgba(255,0,0,0)'); ctx.fillStyle=redGrad; ctx.fillRect(0,0,bleedW,H);
    const blueGrad=ctx.createLinearGradient(W-bleedW,0,W,0); blueGrad.addColorStop(0,'rgba(0,0,255,0)'); blueGrad.addColorStop(1,'rgba(0,0,255,0.06)'); ctx.fillStyle=blueGrad; ctx.fillRect(W-bleedW,0,bleedW,H);
    if(shimmerPhases){ for(let i=0;i<shimmerPhases.length;i++){ shimmerPhases[i]+=0.0004; const shimmer=Math.sin(shimmerPhases[i])*0.025; ctx.fillStyle=`rgba(0,0,0,${Math.max(0,0.07+shimmer).toFixed(3)})`; ctx.fillRect(0,i*4,W,2); } }
    noiseAge++; if(noiseAge>=NOISE_INTERVAL){ buildNoise(W,H); noiseAge=0; }
    ctx.drawImage(noiseCanvas,0,0); ctx.drawImage(vigCanvas,0,0);
  }
  requestAnimationFrame(draw);
})();

// ── Skip arcade mode ───────────────────────────────────────────────────────────
if(window._skipArcade) {
  window._runBootSequence();
}
