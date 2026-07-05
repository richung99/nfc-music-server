import * as THREE from 'three';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';

// ── Shared state ───────────────────────────────────────────────────────────────
const canvas        = document.getElementById('c');
const arcadeLoading = document.getElementById('arcade-loading');
const lbar          = document.getElementById('lbar');
const shutoff       = document.getElementById('shutoff');
const playerLayer   = document.getElementById('player-layer');
const albumId       = (window.location.pathname.split('/').filter(Boolean).pop()) || 'demo';
const isMobile      = window.innerWidth < 768;

// ── Renderer ───────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled   = true;
renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.outputColorSpace    = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050408);

// ── Room geometry ──────────────────────────────────────────────────────────────
(function buildRoom() {
  // Checkerboard floor texture
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = floorCanvas.height = 512;
  const fc = floorCanvas.getContext('2d');
  const sq = 64;
  for(let x = 0; x < 512/sq; x++) {
    for(let y = 0; y < 512/sq; y++) {
      fc.fillStyle = (x+y)%2===0 ? '#0a0a0a' : '#e8e8e8';
      fc.fillRect(x*sq, y*sq, sq, sq);
    }
  }
  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(1, 1);

  // Wall grid texture
  const wallCanvas = document.createElement('canvas');
  wallCanvas.width = wallCanvas.height = 512;
  const wc = wallCanvas.getContext('2d');
  wc.fillStyle = '#0c0b12';
  wc.fillRect(0, 0, 512, 512);
  wc.strokeStyle = 'rgba(180,120,255,0.12)';
  wc.lineWidth = 1;
  const gridSz = 128;
  for(let i = 0; i <= 512; i += gridSz) {
    wc.beginPath(); wc.moveTo(i, 0); wc.lineTo(i, 512); wc.stroke();
    wc.beginPath(); wc.moveTo(0, i); wc.lineTo(512, i); wc.stroke();
  }
  const wallTex = new THREE.CanvasTexture(wallCanvas);
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
  wallTex.repeat.set(2, 1.5);

  const roomSize = 9;
  const roomH    = 6;
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.8, metalness: 0.1 });
  const wallMat  = new THREE.MeshStandardMaterial({ map: wallTex,  roughness: 0.9, metalness: 0.05 });

  // Floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(roomSize, roomSize), floorMat);
  floor.rotation.x = -Math.PI/2;
  floor.position.set(0, -0.01, 0);
  floor.receiveShadow = true;
  scene.add(floor);

  // Back wall
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(roomSize, roomH), wallMat);
  backWall.position.set(0, roomH/2 - 0.01, -roomSize/2);
  backWall.receiveShadow = true;
  scene.add(backWall);

  // Right wall
  const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(roomSize, roomH), wallMat);
  rightWall.rotation.y = -Math.PI/2;
  rightWall.position.set(roomSize/2, roomH/2 - 0.01, 0);
  rightWall.receiveShadow = true;
  scene.add(rightWall);

  // LED strips
  const ledMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(0xdd88ff), emissiveIntensity: 3.0 });
  const ledBack = new THREE.Mesh(new THREE.BoxGeometry(roomSize, 0.06, 0.06), ledMat);
  ledBack.position.set(0, roomH - 0.2, -roomSize/2 + 0.05);
  scene.add(ledBack);
  const ledRight = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, roomSize), ledMat);
  ledRight.position.set(roomSize/2 - 0.05, roomH - 0.2, 0);
  scene.add(ledRight);
  const ledCorner = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), ledMat);
  ledCorner.position.set(roomSize/2 - 0.05, roomH - 0.2, -roomSize/2 + 0.05);
  scene.add(ledCorner);

  // LED point lights
  const ledLight1 = new THREE.PointLight(0xcc66ff, 1.2, 12);
  ledLight1.position.set(2, roomH - 0.5, -roomSize/2 + 0.5);
  scene.add(ledLight1);
  const ledLight2 = new THREE.PointLight(0xcc66ff, 1.2, 12);
  ledLight2.position.set(roomSize/2 - 0.5, roomH - 0.5, -2);
  scene.add(ledLight2);
  const ledLight3 = new THREE.PointLight(0xff44cc, 0.6, 10);
  ledLight3.position.set(roomSize/2 - 0.5, roomH - 0.5, -roomSize/2 + 0.5);
  scene.add(ledLight3);
})();

// ── Camera & controls ──────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(42, window.innerWidth/window.innerHeight, 0.01, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.07;
controls.minDistance = 2.5; controls.maxDistance = isMobile ? 50 : 30;
controls.enabled = false;
controls.update();

// ── Post-processing ────────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.25, 0.4, 0.5));
composer.addPass(new OutputPass());

// ── Lights ─────────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x8855aa, 0.15));
const key = new THREE.DirectionalLight(0xfff0e0, 0.15);
key.position.set(-3,5,4); key.castShadow=false; scene.add(key);
const borderGlow      = new THREE.PointLight(0x9dfcff,1.5,4.0); borderGlow.position.set(0,2.5,1.2); scene.add(borderGlow);
const coinGlow        = new THREE.PointLight(0xff0718,1.0,0.8); coinGlow.decay=2; coinGlow.position.set(0.05,0.790,0.744); scene.add(coinGlow);
const screenGlowLight = new THREE.PointLight(0x5cffd9,1.5,2.5); screenGlowLight.position.set(0.005,3.534,0.625); scene.add(screenGlowLight);
const titleGlow       = new THREE.PointLight(0xffffff,1.5,2.0); titleGlow.position.set(0.005,4.725,1.584); scene.add(titleGlow);

// ── CRT noise canvas ───────────────────────────────────────────────────────────
const noiseCanvas = document.getElementById('crt-noise');
const noiseCtx    = noiseCanvas.getContext('2d');
let noiseFrame    = 0;
function updateNoise() {
  noiseCanvas.width=window.innerWidth; noiseCanvas.height=window.innerHeight;
  const img=noiseCtx.createImageData(noiseCanvas.width,noiseCanvas.height);
  const d=img.data;
  for(let i=0;i<d.length;i+=4){const v=Math.random()*255|0;d[i]=d[i+1]=d[i+2]=v;d[i+3]=Math.random()<0.3?(Math.random()*15|0):0;}
  noiseCtx.putImageData(img,0,0);
}
updateNoise();

// ── Screen canvas ──────────────────────────────────────────────────────────────
const SC_W=512, SC_H=320;
const screenCanvas=document.createElement('canvas'); screenCanvas.width=SC_W; screenCanvas.height=SC_H;
const sctx=screenCanvas.getContext('2d');
const screenTex=new THREE.CanvasTexture(screenCanvas); screenTex.colorSpace=THREE.SRGBColorSpace;

const TI_W=1250, TI_H=200;
const titleCanvas=document.createElement('canvas'); titleCanvas.width=TI_W; titleCanvas.height=TI_H;
const tctx=titleCanvas.getContext('2d');
const titleTex=new THREE.CanvasTexture(titleCanvas); titleTex.colorSpace=THREE.SRGBColorSpace;

let animTime=0, fontReady=false;
document.fonts.load("20px 'Press Start 2P'").then(()=>{ fontReady=true; });

const SIGN_CHARS  = 'RETROCHUNG'.split('');
const charState   = SIGN_CHARS.map(()=>({opacity:0,flickering:false,flickerTimer:0,nextFlicker:2+Math.random()*8,poweredOn:false}));

// ── Screen drawing ─────────────────────────────────────────────────────────────
function drawScreen(dt){
  drawScreenContent(dt);
  screenTex.needsUpdate=true;
}

let tokenTime=0, glitchStartTime=null;

function drawScreenToken() {
  tokenTime+=0.016;
  sctx.fillStyle='#000'; sctx.fillRect(0,0,SC_W,SC_H);
  const bg=sctx.createRadialGradient(SC_W/2,SC_H/2,0,SC_W/2,SC_H/2,SC_W*0.6);
  bg.addColorStop(0,'rgba(200,168,75,0.15)'); bg.addColorStop(1,'rgba(0,0,0,0)');
  sctx.fillStyle=bg; sctx.fillRect(0,0,SC_W,SC_H);
  sctx.fillStyle='rgba(0,0,0,0.22)';
  for(let y=0;y<SC_H;y+=4) sctx.fillRect(0,y,SC_W,2);
  if(!fontReady){screenTex.needsUpdate=true;return;}
  const pulse=1+Math.sin(tokenTime*4)*0.04, cr=52*pulse;
  sctx.beginPath(); sctx.arc(SC_W/2,SC_H*0.38,cr,0,Math.PI*2);
  sctx.strokeStyle='#c8a84b'; sctx.lineWidth=3;
  sctx.shadowColor='rgba(200,168,75,0.8)'; sctx.shadowBlur=18; sctx.stroke(); sctx.shadowBlur=0;
  sctx.beginPath(); sctx.arc(SC_W/2,SC_H*0.38,cr*0.8,0,Math.PI*2);
  sctx.strokeStyle='rgba(200,168,75,0.4)'; sctx.lineWidth=1.5; sctx.stroke();
  sctx.font=`bold ${Math.round(cr*1.1)}px serif`; sctx.fillStyle='#c8a84b';
  sctx.textAlign='center'; sctx.textBaseline='middle';
  sctx.shadowColor='rgba(200,168,75,0.9)'; sctx.shadowBlur=16;
  sctx.fillText('\u266b',SC_W/2,SC_H*0.38+2); sctx.shadowBlur=0;
  sctx.font="12px 'Press Start 2P',monospace"; sctx.fillStyle='#c8a84b';
  sctx.shadowColor='rgba(200,168,75,0.9)'; sctx.shadowBlur=14;
  sctx.fillText('TOKEN',SC_W/2,SC_H*0.65);
  sctx.fillText('ACCEPTED',SC_W/2,SC_H*0.76); sctx.shadowBlur=0;
  screenTex.needsUpdate=true;
}

function drawScreenGlitch(elapsed) {
  const intensity = elapsed;
  tokenTime += 0.016;
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, SC_W, SC_H);
  const bg = sctx.createRadialGradient(SC_W/2,SC_H/2,0,SC_W/2,SC_H/2,SC_W*0.6);
  bg.addColorStop(0,'rgba(200,168,75,0.15)'); bg.addColorStop(1,'rgba(0,0,0,0)');
  sctx.fillStyle = bg; sctx.fillRect(0,0,SC_W,SC_H);
  sctx.fillStyle = 'rgba(0,0,0,0.22)';
  for(let y=0;y<SC_H;y+=4) sctx.fillRect(0,y,SC_W,2);
  if(fontReady) {
    const pulse=1+Math.sin(tokenTime*4)*0.04, cr=52*pulse;
    sctx.beginPath(); sctx.arc(SC_W/2,SC_H*0.38,cr,0,Math.PI*2);
    sctx.strokeStyle='#c8a84b'; sctx.lineWidth=3;
    sctx.shadowColor='rgba(200,168,75,0.8)'; sctx.shadowBlur=18; sctx.stroke(); sctx.shadowBlur=0;
    sctx.beginPath(); sctx.arc(SC_W/2,SC_H*0.38,cr*0.8,0,Math.PI*2);
    sctx.strokeStyle='rgba(200,168,75,0.4)'; sctx.lineWidth=1.5; sctx.stroke();
    sctx.font=`bold ${Math.round(cr*1.1)}px serif`; sctx.fillStyle='#c8a84b';
    sctx.textAlign='center'; sctx.textBaseline='middle';
    sctx.shadowColor='rgba(200,168,75,0.9)'; sctx.shadowBlur=12;
    sctx.fillText('-',SC_W/2,SC_H*0.38+4); sctx.shadowBlur=0;
    sctx.font="12px 'Press Start 2P',monospace"; sctx.fillStyle='#c8a84b';
    sctx.shadowColor='rgba(200,168,75,0.9)'; sctx.shadowBlur=14;
    sctx.fillText('TOKEN',SC_W/2,SC_H*0.65);
    sctx.fillText('ACCEPTED',SC_W/2,SC_H*0.76); sctx.shadowBlur=0;
  }
  // Glitch layers
  const numTears = Math.floor(1 + intensity * 7);
  for(let i=0;i<numTears;i++) {
    const ty=Math.random()*SC_H, th=2+Math.random()*(3+intensity*18), dx=(Math.random()-0.5)*(15+intensity*60);
    try { const strip=sctx.getImageData(0,ty,SC_W,th); sctx.putImageData(strip,dx,ty); } catch(e) {}
  }
  if(intensity > 0.15) {
    const split=Math.round(intensity*10);
    sctx.globalCompositeOperation='screen';
    sctx.fillStyle=`rgba(255,0,0,${intensity*0.12})`; sctx.fillRect(-split,0,SC_W,SC_H);
    sctx.fillStyle=`rgba(0,255,255,${intensity*0.12})`; sctx.fillRect(split,0,SC_W,SC_H);
    sctx.globalCompositeOperation='source-over';
  }
  const numBlocks=Math.floor(intensity*12);
  for(let i=0;i<numBlocks;i++) {
    sctx.fillStyle=Math.random()>0.5?`rgba(255,255,255,${0.3+Math.random()*0.4})`:`rgba(200,168,75,${0.3+Math.random()*0.4})`;
    sctx.fillRect(Math.random()*SC_W,Math.random()*SC_H,1+Math.random()*(8+intensity*20),1+Math.random()*3);
  }
  if(Math.random()<intensity*0.06) { sctx.fillStyle=`rgba(255,255,255,${0.15+Math.random()*0.3})`; sctx.fillRect(0,0,SC_W,SC_H); }
  screenTex.needsUpdate=true;
}

function drawTitle(dt) {
  tctx.fillStyle='#050a0a'; tctx.fillRect(0,0,TI_W,TI_H);
  if(!fontReady){titleTex.needsUpdate=true;return;}
  for(const c of charState){
    if(!c.poweredOn) continue;
    if(c.fadingIn){
      c.opacity=Math.min(c.opacity+dt*3.5,1);
      if(c.opacity>=1){c.opacity=1;c.fadingIn=false;}
      continue;
    }
    if(c.chaosFlicker){
      c.flickerTimer+=dt;
      if(c.flickering){
        c.opacity=Math.random()>0.35?0:Math.random()>0.5?1.0:0.2+Math.random()*0.4;
        if(c.flickerTimer>0.04+Math.random()*0.08){c.flickering=false;c.flickerTimer=0;c.nextFlicker=0.03+Math.random()*0.12;}
      } else {
        if(c.flickerTimer>=c.nextFlicker){c.flickering=true;c.flickerTimer=0;}
      }
      continue;
    }
    if(c.nextFlicker===999){c.flickering=false;c.opacity=1;continue;}
    c.flickerTimer+=dt;
    if(c.flickering){
      c.opacity=Math.random()>0.4?0.05+Math.random()*0.3:1.0;
      if(c.flickerTimer>0.18+Math.random()*0.25){c.flickering=false;c.opacity=1.0;c.flickerTimer=0;c.nextFlicker=2+Math.random()*8;}
    } else { if(c.flickerTimer>=c.nextFlicker){c.flickering=true;c.flickerTimer=0;} }
  }
  const fs=100; tctx.font=`${fs}px 'Press Start 2P',monospace`; tctx.textBaseline='middle'; tctx.textAlign='left';
  const cw=tctx.measureText('A').width*1.02, totw=SIGN_CHARS.length*cw;
  let x=(TI_W-totw)/2, y=TI_H/2;
  for(let i=0;i<SIGN_CHARS.length;i++){
    const c=charState[i];
    if(!c.poweredOn){
      tctx.shadowBlur=0;tctx.globalAlpha=0.25;
      tctx.fillStyle='#2a5560';tctx.fillText(SIGN_CHARS[i],x,y);
      tctx.globalAlpha=1;x+=cw;continue;
    }
    if(c.opacity>0.5){tctx.shadowColor='#9dfcff';tctx.shadowBlur=28*c.opacity;tctx.globalAlpha=0.3*c.opacity;tctx.fillStyle='#9dfcff';tctx.fillText(SIGN_CHARS[i],x,y);}
    tctx.shadowColor='#9dfcff';tctx.shadowBlur=10;tctx.globalAlpha=c.opacity;
    tctx.fillStyle=c.opacity>0.5?'#ffffff':'#2a5560';tctx.fillText(SIGN_CHARS[i],x,y);
    tctx.shadowBlur=0;tctx.globalAlpha=1;x+=cw;
  }
  titleTex.needsUpdate=true;
}

let screenState='off';
let screenPowerT=0;

function drawScreenOff(){
  sctx.fillStyle='#000'; sctx.fillRect(0,0,SC_W,SC_H);
  screenTex.needsUpdate=true;
}

function drawScreenPowerOn(dt){
  if(screenPowerT===0) playScreenOn();
  screenPowerT=Math.min(screenPowerT+dt*2.2,1);
  sctx.fillStyle='#000'; sctx.fillRect(0,0,SC_W,SC_H);
  if(screenPowerT<0.35){
    const p=screenPowerT/0.35, lineW=p*SC_W, lineH=3+p*4;
    sctx.fillStyle=`rgba(255,255,255,${0.6+p*0.4})`;
    sctx.fillRect((SC_W-lineW)/2,SC_H/2-lineH/2,lineW,lineH);
  } else {
    const p=(screenPowerT-0.35)/0.65, ease=1-Math.pow(1-p,3), lineH=ease*SC_H;
    sctx.fillStyle=`rgba(0,40,30,${ease*0.8})`; sctx.fillRect(0,(SC_H-lineH)/2,SC_W,lineH);
    if(ease>0.3){
      sctx.save(); sctx.globalAlpha=(ease-0.3)/0.7;
      sctx.beginPath(); sctx.rect(0,(SC_H-lineH)/2,SC_W,lineH); sctx.clip();
      drawScreenContent(); sctx.restore();
    }
    if(screenPowerT>=1){ screenState='attract'; startIntro(); }
  }
  screenTex.needsUpdate=true;
}

// ── JUKEBOX text effect system ─────────────────────────────────────────────────
const JUKEBOX_WORD     = 'JUKEBOX';
const JUKEBOX_PALETTES = [
  ['#9dfcff','#9dfcff','#9dfcff','#9dfcff','#9dfcff','#9dfcff','#9dfcff'],
  ['#ff4466','#ff6644','#ffcc00','#44ff88','#44ccff','#cc44ff','#ff44cc'],
  ['#ff4466','#ff4466','#ff4466','#ff4466','#ff4466','#ff4466','#ff4466'],
  ['#44ff88','#44ff88','#44ff88','#44ff88','#44ff88','#44ff88','#44ff88'],
  ['#ffcc00','#ffcc00','#ffcc00','#ffcc00','#ffcc00','#ffcc00','#ffcc00'],
  ['#cc44ff','#aa66ff','#8888ff','#66aaff','#44ccff','#22eeff','#00ffee'],
  ['#ff4466','#ff6644','#ffaa00','#ffcc00','#aaff00','#44ff88','#00ffee'],
];
let jkPalette        = JUKEBOX_PALETTES[0];
let jkEffectT        = 0;
let jkPhase          = 'in';
let jkEffectIdx      = -1;
let jkLastIdx        = -1;
let jkLastPaletteIdx = -1;
const JK_HOLD        = 2.2;
const JK_CHARS_POOL  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&';
const JK_DRUM        = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const JK_GLITCH      = '!@#$%^&*<>?/\\|~';
const JK_STATIC      = '\u2592\u2591\u2588\u2593';
let jkLetterState    = [];

function jkInitLetterState() {
  jkLetterState = JUKEBOX_WORD.split('').map((ch,i) => ({
    ch, x:0, y:0, alpha:0, scaleX:1, scaleY:1, rot:0,
    randChar: JK_CHARS_POOL[Math.floor(Math.random()*JK_CHARS_POOL.length)],
    locked: false, stopTime: 0
  }));
}

function jkPickEffect() {
  let idx;
  do { idx = Math.floor(Math.random() * 7); } while(idx === jkLastIdx);
  jkLastIdx = idx;
  return idx;
}

function jkStartEffect() {
  jkEffectIdx = jkPickEffect();
  let palIdx;
  do { palIdx = Math.floor(Math.random() * JUKEBOX_PALETTES.length); } while(palIdx === jkLastPaletteIdx);
  jkLastPaletteIdx = palIdx;
  jkPalette  = JUKEBOX_PALETTES[palIdx];
  jkEffectT  = 0;
  jkPhase    = 'in';
  jkInitLetterState();
  if(jkEffectIdx===2) jkLetterState.forEach((s,i)=>{ s.stopTime=0.8+i*0.25+Math.random()*0.1; s.locked=false; });
  if(jkEffectIdx===5) jkLetterState.forEach(s=>{ s.alpha=0; s.locked=false; s.randChar=JK_STATIC[0]; });
  if(jkEffectIdx===6) jkLetterState.forEach((s,i)=>{ s.locked=false; s.alpha=0; s.startDelay=i*0.12; });
}

function jkDrawLetter(l, x, y, color, alpha, scaleX, scaleY, rot, fs) {
  if(alpha<=0) return;
  sctx.save();
  sctx.globalAlpha=Math.max(0,Math.min(1,alpha));
  sctx.translate(x,y);
  if(rot) sctx.rotate(rot);
  if(scaleX!==1||scaleY!==1) sctx.scale(scaleX,scaleY);
  sctx.shadowColor=color; sctx.shadowBlur=10;
  sctx.fillStyle=color; sctx.fillText(l,0,0);
  sctx.shadowBlur=0; sctx.restore();
}

function drawJukeboxEffect(dt) {
  if(!fontReady) return;
  if(jkEffectIdx<0) jkStartEffect();
  const fs=26, lw=fs*1.18, tw=JUKEBOX_WORD.length*lw;
  const bx=(SC_W-tw)/2+lw*0.5, by=SC_H*0.40;
  sctx.font=`${fs}px 'Press Start 2P',monospace`;
  sctx.textBaseline='middle'; sctx.textAlign='center';
  const t=jkEffectT;
  const IN_DUR  = [0.7,0.7,0.5,0.6,0.7,0.7,0.9];
  const OUT_DUR = [0.6,0.7,0.6,0.6,0.7,0.5,0.7];
  const inDur=IN_DUR[jkEffectIdx], outDur=OUT_DUR[jkEffectIdx];
  if(jkPhase==='in'   && t>=inDur)  { jkPhase='hold'; jkEffectT=0; }
  else if(jkPhase==='hold' && t>=JK_HOLD) { jkPhase='out';  jkEffectT=0; }
  else if(jkPhase==='out'  && t>=outDur) { jkStartEffect(); return; }
  jkEffectT+=dt;
  const tp=Math.max(0,Math.min(1,jkEffectT/(jkPhase==='in'?inDur:outDur)));

  // 0: Tetris fall
  if(jkEffectIdx===0) {
    JUKEBOX_WORD.split('').forEach((l,i)=>{
      const delay=i*0.07/inDur, p=Math.max(0,Math.min(1,(tp-delay)/(1-delay)));
      const ease=p<1?1-Math.pow(1-p,3):1;
      let y=by;
      if(jkPhase==='in') y=by-120*(1-ease);
      else if(jkPhase==='out'){const op=Math.max(0,Math.min(1,(tp-(JUKEBOX_WORD.length-1-i)*0.06/outDur)));y=by+120*op*op;}
      const alpha=jkPhase==='out'?1-Math.pow(Math.max(0,(tp-(JUKEBOX_WORD.length-1-i)*0.06/outDur)),0.5):(jkPhase==='in'?ease:1);
      jkDrawLetter(l,bx+i*lw,y,jkPalette[i%jkPalette.length],alpha,1,1,0,fs);
    });
  }
  // 1: Rotating mirrors
  else if(jkEffectIdx===1) {
    JUKEBOX_WORD.split('').forEach((l,i)=>{
      let sx=1,alpha=1;
      if(jkPhase==='in'){const p=Math.max(0,Math.min(1,(tp-i*0.06/inDur)/(1-i*0.06/inDur)));const ease=1-Math.pow(1-p,3);sx=ease;alpha=ease;}
      else if(jkPhase==='hold'){sx=1;alpha=1;}
      else if(jkPhase==='out'){const p=Math.max(0,Math.min(1,(tp-(JUKEBOX_WORD.length-1-i)*0.04/outDur)/(1-(JUKEBOX_WORD.length-1-i)*0.04/outDur)));const ease=p*p;sx=1-ease;alpha=1-ease;}
      jkDrawLetter(l,bx+i*lw,by,jkPalette[i%jkPalette.length],alpha,sx,1,0,fs);
    });
  }
  // 2: Slot machine
  else if(jkEffectIdx===2) {
    JUKEBOX_WORD.split('').forEach((l,i)=>{
      const s=jkLetterState[i];
      let ch=l,alpha=1,sy=1;
      if(jkPhase==='in'){
        if(t<s.stopTime){ch=JK_DRUM[Math.floor(Math.random()*JK_DRUM.length)];alpha=Math.min(t/0.2,1);sy=1+0.15*Math.sin(t*20+i);}
        else if(!s.locked){s.locked=true;sy=1.3;setTimeout(()=>{if(jkLetterState[i])jkLetterState[i].locked='settled';},100);}
        else if(s.locked==='settled'){sy=1;} else{sy=1.3;}
      } else if(jkPhase==='out'){
        const delay=(JUKEBOX_WORD.length-1-i)*0.06/outDur;
        const p=Math.max(0,Math.min(1,(tp-delay)/(1-delay)));
        sy=1+p*2;alpha=1-p;ch=p>0.3?JK_DRUM[Math.floor(Math.random()*JK_DRUM.length)]:l;
      }
      jkDrawLetter(ch,bx+i*lw,by,jkPalette[i%jkPalette.length],alpha,1,sy,0,fs);
    });
  }
  // 3: Glitch scatter
  else if(jkEffectIdx===3) {
    JUKEBOX_WORD.split('').forEach((l,i)=>{
      let ch=l,alpha=1,dx=0,dy=0;
      if(jkPhase==='in'){const g=1-tp;if(Math.random()<g*0.5){ch=JK_GLITCH[Math.floor(Math.random()*JK_GLITCH.length)];}dx=(Math.random()-0.5)*18*g;dy=(Math.random()-0.5)*14*g;alpha=Math.min(tp*3,1);}
      else if(jkPhase==='hold'){const g=Math.sin(t*3)*0.2;if(Math.random()<g){ch=JK_GLITCH[Math.floor(Math.random()*JK_GLITCH.length)];dx=(Math.random()-0.5)*8;dy=(Math.random()-0.5)*6;}}
      else if(jkPhase==='out'){const g=tp;if(Math.random()<g*0.7)ch=JK_GLITCH[Math.floor(Math.random()*JK_GLITCH.length)];dx=(Math.random()-0.5)*60*g*g;dy=(Math.random()-0.5)*50*g*g;alpha=1-Math.pow(tp,1.5);}
      jkDrawLetter(ch,bx+i*lw+dx,by+dy,jkPalette[i%jkPalette.length],alpha,1,1,0,fs);
    });
  }
  // 4: Typewriter static
  else if(jkEffectIdx===4) {
    const charDelay=inDur/JUKEBOX_WORD.length;
    JUKEBOX_WORD.split('').forEach((l,i)=>{
      let ch=' ',alpha=0;
      if(jkPhase==='in'){const elapsed=t-i*charDelay;if(elapsed>0){alpha=1;ch=elapsed<0.24?JK_STATIC[Math.floor(Math.random()*JK_STATIC.length)]:l;}}
      else if(jkPhase==='hold'){ch=l;alpha=1;}
      else if(jkPhase==='out'){const delay=i*0.05/outDur;const p=Math.max(0,Math.min(1,(tp-delay)/(1-delay)));ch=p>0.3?JK_STATIC[Math.floor(Math.random()*JK_STATIC.length)]:l;alpha=1-p;}
      if(ch!==' ') jkDrawLetter(ch,bx+i*lw,by,jkPalette[i%jkPalette.length],alpha,1,1,0,fs);
    });
  }
  // 5: Spin in
  else if(jkEffectIdx===5) {
    JUKEBOX_WORD.split('').forEach((l,i)=>{
      const delay=i*0.07/inDur, p=Math.max(0,Math.min(1,(tp-delay)/(1-delay)));
      let rot=0,sc=1,alpha=1;
      const dir=i%2===0?1:-1;
      if(jkPhase==='in'){const ease=1-Math.pow(1-p,3);rot=dir*Math.PI*2*(1-ease);sc=ease;alpha=ease;}
      else if(jkPhase==='hold'){sc=1+0.04*Math.sin(t*3+i*0.5);}
      else if(jkPhase==='out'){const op=Math.max(0,Math.min(1,(tp-i*0.05/outDur)/(1-i*0.05/outDur)));const ease=op*op;rot=-dir*Math.PI*2*ease;sc=1-ease;alpha=1-ease;}
      jkDrawLetter(l,bx+i*lw,by,jkPalette[i%jkPalette.length],alpha,sc,sc,rot,fs);
    });
  }
  // 6: Matrix rain
  else if(jkEffectIdx===6) {
    JUKEBOX_WORD.split('').forEach((l,i)=>{
      const s=jkLetterState[i];
      let ch=l,alpha=1,sc=1;
      if(jkPhase==='in'){
        const elapsed=t-s.startDelay;
        if(elapsed<0) return;
        const lockTime=0.6;
        if(elapsed<lockTime){ch=JK_CHARS_POOL[Math.floor(Math.random()*JK_CHARS_POOL.length)];alpha=Math.min(elapsed/0.2,0.7);}
        else{ch=l;alpha=1;if(!s.locked){s.locked=true;sc=1.2;setTimeout(()=>{if(jkLetterState[i])jkLetterState[i].sc=1;},150);}sc=s.sc||1;}
      } else if(jkPhase==='hold'){ch=l;alpha=1;}
      else if(jkPhase==='out'){const delay=i*0.09/outDur;const p=Math.max(0,Math.min(1,(tp-delay)/(1-delay)));if(p>0){ch=p>0.5?JK_CHARS_POOL[Math.floor(Math.random()*JK_CHARS_POOL.length)]:l;alpha=1-p;}}
      jkDrawLetter(ch,bx+i*lw,by,jkPalette[i%jkPalette.length],alpha,sc||1,1,0,fs);
    });
  }
}

function drawScreenContent(dt=0.016){
  sctx.fillStyle='#020e0a'; sctx.fillRect(0,0,SC_W,SC_H);
  const bg=sctx.createRadialGradient(SC_W/2,SC_H/2,0,SC_W/2,SC_H/2,SC_W*0.7);
  bg.addColorStop(0,'rgba(0,60,50,0.7)'); bg.addColorStop(0.5,'rgba(0,30,25,0.4)'); bg.addColorStop(1,'rgba(0,0,0,0)');
  sctx.fillStyle=bg; sctx.fillRect(0,0,SC_W,SC_H);
  sctx.fillStyle='rgba(0,0,0,0.22)';
  for(let y=0;y<SC_H;y+=4) sctx.fillRect(0,y,SC_W,2);
  if(!fontReady) return;
  drawJukeboxEffect(animTime>0?dt:0);
  if(Math.floor(animTime/0.55)%2===0){
    sctx.font="11px 'Press Start 2P',monospace"; sctx.globalAlpha=1;
    sctx.shadowColor='rgba(255,210,80,0.95)'; sctx.shadowBlur=18;
    sctx.fillStyle='#ffd050'; sctx.fillText('INSERT COIN',SC_W/2,SC_H*0.70); sctx.shadowBlur=0;
  }
}

// ── Intro auto-rotate ──────────────────────────────────────────────────────────
const DEFAULT_CAM_POS    = new THREE.Vector3();
const DEFAULT_CAM_TARGET = new THREE.Vector3();
const SCREEN_CENTER      = new THREE.Vector3();
const CAM_ORTHO          = new THREE.Vector3();
const CAM_TGT            = new THREE.Vector3();
let introPhase=0, introT=0;
let introFromPos=new THREE.Vector3(), introFromTgt=new THREE.Vector3();

function easeInOutCubic(t){return t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;}
function easeOutExpo(t){return t===1?1:1-Math.pow(2,-10*t);}

function startIntro(){
  introPhase=2; introT=0;
  introFromPos.copy(camera.position);
  introFromTgt.copy(controls.target);
  controls.enabled=false;
}

function updateIntro(dt){
  if(introPhase!==2) return;
  introT=Math.min(introT+dt*0.55,1);
  const fromOffset=introFromPos.clone().sub(CAM_TGT);
  const toOffset=CAM_ORTHO.clone().sub(CAM_TGT);
  const fromR=fromOffset.length(), toR=toOffset.length();
  const fromTheta=Math.atan2(fromOffset.x,fromOffset.z), toTheta=Math.atan2(toOffset.x,toOffset.z);
  const fromPhi=Math.asin(Math.max(-1,Math.min(1,fromOffset.y/fromR)));
  const toPhi=Math.asin(Math.max(-1,Math.min(1,toOffset.y/toR)));
  let dTheta=toTheta-fromTheta;
  if(dTheta>Math.PI) dTheta-=Math.PI*2;
  if(dTheta<-Math.PI) dTheta+=Math.PI*2;
  const tRot=easeInOutCubic(introT), tZoom=easeOutExpo(introT);
  const curTheta=fromTheta+dTheta*tRot, curPhi=fromPhi+(toPhi-fromPhi)*tRot, curR=fromR+(toR-fromR)*tZoom;
  camera.position.set(CAM_TGT.x+curR*Math.cos(curPhi)*Math.sin(curTheta),CAM_TGT.y+curR*Math.sin(curPhi),CAM_TGT.z+curR*Math.cos(curPhi)*Math.cos(curTheta));
  controls.target.lerpVectors(introFromTgt,CAM_TGT,tRot);
  camera.lookAt(controls.target);
  if(introT>=1){ introPhase=0; startNFC(); }
}

// ── NFC ────────────────────────────────────────────────────────────────────────
let nfcStarted=false, tokenInserted=false;

async function startNFC(){
  if(!('NDEFReader' in window)){
    console.warn('Web NFC not supported — using keyboard/touch fallback');
    // Desktop: spacebar
    window.addEventListener('keydown',(e)=>{if(e.code==='Space')onTokenInserted('dev');});
    // Mobile (iOS): two-finger hold for 1.5s
    _setupTwoFingerHold();
    return;
  }
  try{
    const reader=new NDEFReader();
    await reader.scan();
    nfcStarted=true;
    console.log('NFC scanning...');
    reader.addEventListener('reading',({message})=>{
      for(const record of message.records){
        if(record.recordType==='text'){
          const text=new TextDecoder().decode(record.data);
          if(text.startsWith('rc:user:')) onTokenInserted(text.slice('rc:user:'.length));
        }
      }
    });
  } catch(e){
    console.warn('NFC failed:',e.message);
    window.addEventListener('keydown',(e)=>{if(e.code==='Space')onTokenInserted('dev');},{once:true});
    _setupTwoFingerHold();
  }
}

function _setupTwoFingerHold(){
  const HOLD_MS = 1500;
  let holdTimer = null;
  let holding   = false;

  // Progress ring drawn on the CRT noise canvas overlay
  const overlay = document.getElementById('crt-noise');
  let progress  = 0;
  let rafId     = null;
  let startTime = 0;

  function drawProgress(p){
    const W = overlay.width  = window.innerWidth;
    const H = overlay.height = window.innerHeight;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0,0,W,H);
    if(p <= 0) return;
    const cx = W/2, cy = H/2, r = 38;
    // Background ring
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.strokeStyle='rgba(200,168,75,0.2)'; ctx.lineWidth=4; ctx.stroke();
    // Progress arc
    const start = -Math.PI/2;
    const end   = start + Math.PI*2*p;
    ctx.beginPath(); ctx.arc(cx,cy,r,start,end);
    ctx.strokeStyle=`rgba(200,168,75,${0.6+p*0.4})`; ctx.lineWidth=4;
    ctx.shadowColor='rgba(200,168,75,0.8)'; ctx.shadowBlur=12;
    ctx.stroke(); ctx.shadowBlur=0;
    // Center dot
    ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2);
    ctx.fillStyle=`rgba(200,168,75,${p})`; ctx.fill();
  }

  function animateProgress(){
    if(!holding) return;
    progress = Math.min(1,(Date.now()-startTime)/HOLD_MS);
    drawProgress(progress);
    if(progress < 1) rafId = requestAnimationFrame(animateProgress);
  }

  function startHold(){
    if(holding || tokenInserted) return;
    holding   = true;
    startTime = Date.now();
    progress  = 0;
    rafId     = requestAnimationFrame(animateProgress);
    holdTimer = setTimeout(()=>{
      if(holding){
        holding = false;
        drawProgress(0);
        onTokenInserted('ios');
      }
    }, HOLD_MS);
  }

  function cancelHold(){
    if(!holding) return;
    holding = false;
    clearTimeout(holdTimer);
    cancelAnimationFrame(rafId);
    // Animate progress back to 0
    const fadeStart = progress;
    const fadeStartTime = Date.now();
    (function fadeOut(){
      const t = Math.min((Date.now()-fadeStartTime)/200, 1);
      drawProgress(fadeStart*(1-t));
      if(t < 1) requestAnimationFrame(fadeOut);
    })();
  }

  canvas.addEventListener('touchstart', e=>{
    if(e.touches.length >= 2) startHold();
  }, {passive:true});
  canvas.addEventListener('touchend',   e=>{
    if(e.touches.length < 2) cancelHold();
  }, {passive:true});
  canvas.addEventListener('touchcancel',()=>cancelHold(), {passive:true});
}

function onTokenInserted(username){
  if(tokenInserted) return;
  tokenInserted=true;
  console.log('Token inserted by:',username);

  charState.forEach(c=>{
    c.poweredOn=true; c.flickering=false; c.fadingIn=false; c.opacity=1;
    c.nextFlicker=0.05+Math.random()*0.15; c.chaosFlicker=true;
  });

  playTokenInsert();
  coinGlow.intensity=4;
  setTimeout(()=>{coinGlow.intensity=1;},300);

  setTimeout(()=>{
    screenState='glitch';
    glitchStartTime=performance.now();
    const stopPulse=playLightPulse();
    const startTime=performance.now();
    const DURATION=1500;
    let glowRAF;
    const BASE_BORDER=LIGHT_TARGETS.borderLightsEmissive;
    const BASE_COIN=LIGHT_TARGETS.coinSlotEmissive;
    const BASE_BORDER_GLOW=LIGHT_TARGETS.borderGlowIntensity;
    const BASE_COIN_GLOW=LIGHT_TARGETS.coinGlowIntensity;
    let isOff=false, offUntil=0;
    let nextFlicker=performance.now()+80+Math.random()*180;
    (function flicker(){
      glowRAF=requestAnimationFrame(flicker);
      const now=performance.now();
      const elapsed=Math.min((now-startTime)/DURATION,1);
      const minInterval=200-elapsed*170, maxInterval=350-elapsed*300;
      if(isOff&&now>=offUntil){ isOff=false; nextFlicker=now+minInterval+Math.random()*(maxInterval-minInterval); }
      if(!isOff&&now>=nextFlicker){
        isOff=true;
        const offDur=Math.max(20,80-elapsed*60)+Math.random()*40;
        offUntil=now+offDur;
        if(Math.random()<0.3){
          setTimeout(()=>{
            if(isOff){
              if(borderLightsMat) borderLightsMat.emissiveIntensity=BASE_BORDER*0.4;
              if(coinSlotMat)     coinSlotMat.emissiveIntensity=BASE_COIN*0.4;
              setTimeout(()=>{
                if(borderLightsMat) borderLightsMat.emissiveIntensity=0;
                if(coinSlotMat)     coinSlotMat.emissiveIntensity=0;
              },15);
            }
          },offDur*0.4);
        }
      }
      const onVal=isOff?0:BASE_BORDER, coinOnVal=isOff?0:BASE_COIN;
      const glowVal=isOff?0:BASE_BORDER_GLOW, coinGlowVal=isOff?0:BASE_COIN_GLOW;
      if(borderLightsMat) borderLightsMat.emissiveIntensity=onVal;
      if(coinSlotMat)     coinSlotMat.emissiveIntensity=coinOnVal;
      borderGlow.intensity=glowVal; coinGlow.intensity=coinGlowVal;
    })();
    setTimeout(()=>{ if(window._skipArcade) return; cancelAnimationFrame(glowRAF); stopPulse(); playCRTShutoff(); startShutoff(); },DURATION);
  },300);
}

// ── CRT shutoff ────────────────────────────────────────────────────────────────
let renderActive=true;

function startShutoff(){
  renderActive=false;
  renderer.setClearColor(0x000000,1); renderer.clear();
  shutoff.style.display='block'; shutoff.style.background='#000';
  shutoff.style.opacity='1'; shutoff.style.transform='scaleY(1)'; shutoff.style.transition='none';
  setTimeout(()=>{
    shutoff.style.background='#fff'; shutoff.style.transition='background 60ms ease-out';
    shutoff.offsetHeight;
    setTimeout(()=>{
      shutoff.style.background='#cff'; shutoff.style.transition='transform 180ms cubic-bezier(0.4,0,1,1)'; shutoff.style.transform='scaleY(0.012)';
      setTimeout(()=>{
        shutoff.style.transition='opacity 220ms ease-in,transform 220ms ease-in'; shutoff.style.opacity='0'; shutoff.style.transform='scaleY(0.004)';
        setTimeout(()=>{
          shutoff.style.display='none';
          playerLayer.style.display='block';
          window._runBootSequence();
        },280);
      },200);
    },80);
  },80);
}

// ── GLB loader ─────────────────────────────────────────────────────────────────
let cabinetScene=null, borderLightsMat=null, coinSlotMat=null, titleMat=null;
// Interactive meshes for touch/click raycasting
const interactiveMeshes = []; // buttons + joystick
const raycaster = new THREE.Raycaster();
const _rayPointer = new THREE.Vector2();

const LIGHTS_OFF=()=>{
  borderGlow.intensity=0; coinGlow.intensity=0;
  screenGlowLight.intensity=0; titleGlow.intensity=0;
  if(borderLightsMat) borderLightsMat.emissiveIntensity=0;
  if(coinSlotMat)     coinSlotMat.emissiveIntensity=0;
};
LIGHTS_OFF();

new GLTFLoader().load(
  '/arcademachine-final.glb',
  (gltf)=>{
    cabinetScene=gltf.scene;
    gltf.scene.traverse(child=>{
      if(!child.isMesh) return;
      child.castShadow=true; child.receiveShadow=true;
      let node=child; while(node&&!node.name) node=node.parent;
      const name=node?.name||'';
      if(name==='Border Lights'){ child.material=child.material.clone(); child.material.emissive.setRGB(0.3488,0.9743,1.0); child.material.emissiveIntensity=0; borderLightsMat=child.material; }
      if(name==='Coin Slot'){ child.material=child.material.clone(); child.material.emissive.setRGB(1.0,0.0004,0.0059); child.material.emissiveIntensity=0; coinSlotMat=child.material; }
      // Collect buttons and joystick for touch interaction
      if(name.startsWith('Button ') || name==='Joystick'){ interactiveMeshes.push(child); }
      if(name==='Screen'){
        const uv=child.geometry.attributes.uv;
        if(uv&&uv.count===4){uv.setXY(0,1,1);uv.setXY(1,1,0);uv.setXY(2,0,1);uv.setXY(3,0,0);uv.needsUpdate=true;}
        child.material=new THREE.MeshBasicMaterial({map:screenTex,side:THREE.DoubleSide});
        child.geometry.computeBoundingBox();
        const sbox=child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld);
        sbox.getCenter(SCREEN_CENTER); CAM_TGT.copy(SCREEN_CENTER);
        const orthoZ=isMobile?6.5:6.0;
        CAM_ORTHO.set(SCREEN_CENTER.x,SCREEN_CENTER.y,SCREEN_CENTER.z+orthoZ);
      }
      if(name==='Title'){
        const uv=child.geometry.attributes.uv;
        if(uv&&uv.count===4){uv.setXY(0,1,0);uv.setXY(1,0,0);uv.setXY(2,1,1);uv.setXY(3,0,1);uv.needsUpdate=true;}
        child.material=new THREE.MeshBasicMaterial({map:titleTex,side:THREE.DoubleSide});
        titleMat=child.material;
      }
    });
    const bbox=new THREE.Box3().setFromObject(gltf.scene);
    const center=bbox.getCenter(new THREE.Vector3());
    const size=bbox.getSize(new THREE.Vector3());
    const maxDim=Math.max(size.x,size.y,size.z);
    const distMult=isMobile?5.5:3.8;
    const dist=(maxDim/2)/Math.tan((camera.fov*Math.PI/180)/2)*distMult;
    DEFAULT_CAM_POS.set(center.x-dist*0.6,center.y+dist*0.7,center.z+dist*0.9);
    DEFAULT_CAM_TARGET.copy(center);
    camera.position.copy(DEFAULT_CAM_POS);
    controls.target.copy(DEFAULT_CAM_TARGET);
    controls.update();
    scene.add(gltf.scene);
    const cabBbox=new THREE.Box3().setFromObject(gltf.scene);
    gltf.scene.position.y-=cabBbox.min.y;
    arcadeLoading.style.opacity='0';
    setTimeout(()=>{arcadeLoading.style.display='none'; waitForHold();},600);
  },
  (p)=>{ if(p.total>0) lbar.style.width=Math.round(p.loaded/p.total*100)+'%'; },
  (e)=>{ document.querySelector('.ltxt').textContent='ERROR: '+e.message; }
);

// ── Hold to power on ───────────────────────────────────────────────────────────
const HOLD_DURATION=3200;
let holdStartTime=null, holdRAF=null, holdActive=false, powerOnComplete=false;

const LIGHT_TARGETS={
  coinSlotEmissive:2.0, coinGlowIntensity:1.0,
  borderLightsEmissive:1.5, borderGlowIntensity:1.5,
  screenGlowIntensity:1.5, titleGlowIntensity:1.5,
};

function updatePowerLights(t){
  const tCoin=Math.min(Math.max((t-0.15)/0.3,0),1);
  if(coinSlotMat) coinSlotMat.emissiveIntensity=tCoin*LIGHT_TARGETS.coinSlotEmissive;
  coinGlow.intensity=tCoin*LIGHT_TARGETS.coinGlowIntensity;
  const tBorder=Math.min(Math.max((t-0.35)/0.35,0),1);
  if(borderLightsMat) borderLightsMat.emissiveIntensity=tBorder*LIGHT_TARGETS.borderLightsEmissive;
  borderGlow.intensity=tBorder*LIGHT_TARGETS.borderGlowIntensity;
  const tTitle=Math.min(Math.max((t-0.65)/0.35,0),1);
  titleGlow.intensity=tTitle*LIGHT_TARGETS.titleGlowIntensity;
  SIGN_CHARS.forEach((_,i)=>{
    const threshold=(i+1)/(SIGN_CHARS.length+1);
    const c=charState[i];
    if(tTitle>=threshold&&!c.poweredOn){ c.poweredOn=true; c.flickering=true; c.flickerTimer=0; c.opacity=0.2; playLetterSpark(); }
  });
  if(cabinetScene&&t>0.2){
    const intensity=(t-0.2)*0.03;
    const rdx=(Math.random()-0.5)*intensity, rdz=(Math.random()-0.5)*intensity*0.6;
    cabinetScene.position.x=rdx; cabinetScene.position.z=rdz; cabinetScene.rotation.z=-rdx*0.5;
  }
}

function powerDownLights(){
  if(cabinetScene){cabinetScene.position.x=0;cabinetScene.rotation.z=0;}
  const startVals={
    coinSlot:coinSlotMat?coinSlotMat.emissiveIntensity:0,
    borderLights:borderLightsMat?borderLightsMat.emissiveIntensity:0,
    coinGlow:coinGlow.intensity, borderGlow:borderGlow.intensity,
    screenGlow:screenGlowLight.intensity, titleGlow:titleGlow.intensity,
  };
  const start=performance.now();
  (function fadeDown(now){
    const t=Math.min((now-start)/400,1), inv=1-t;
    if(coinSlotMat)     coinSlotMat.emissiveIntensity=startVals.coinSlot*inv;
    if(borderLightsMat) borderLightsMat.emissiveIntensity=startVals.borderLights*inv;
    coinGlow.intensity=startVals.coinGlow*inv; borderGlow.intensity=startVals.borderGlow*inv;
    screenGlowLight.intensity=startVals.screenGlow*inv; titleGlow.intensity=startVals.titleGlow*inv;
    charState.forEach(c=>{if(c.poweredOn) c.opacity=startVals.titleBright*inv;});
    if(t<1) requestAnimationFrame(fadeDown);
    else { charState.forEach(c=>{c.poweredOn=false;c.opacity=0;c.flickering=false;c.fadingIn=false;c.flickerTimer=0;c.nextFlicker=2+Math.random()*8;}); }
  })(performance.now());
}

function holdTick(now){
  if(!holdActive) return;
  const elapsed=now-holdStartTime;
  const t=Math.min(elapsed/HOLD_DURATION,1);
  updatePowerLights(t);
  updateHoldAudio(t);
  if(t>=1){
    if(cabinetScene){cabinetScene.position.x=0;cabinetScene.rotation.z=0;}
    powerOnComplete=true; holdActive=false;
    onHoldComplete();
    screenState='poweron'; screenPowerT=0;
    screenGlowLight.intensity=LIGHT_TARGETS.screenGlowIntensity;
    charState.forEach(c=>{if(!c.poweredOn){c.poweredOn=true;c.opacity=1;c.flickering=false;}});
    return;
  }
  holdRAF=requestAnimationFrame(holdTick);
}

function waitForHold(){
  const onDown=(e)=>{
    if(powerOnComplete) return;
    initAudio();
    holdActive=true; holdStartTime=performance.now();
    holdRAF=requestAnimationFrame(holdTick);
  };
  const onUp=(e)=>{
    if(powerOnComplete) return;
    if(holdActive){ holdActive=false; cancelAnimationFrame(holdRAF); powerDownLights(); onHoldRelease(); }
  };
  document.addEventListener('click',()=>{initAudio();},{once:true});
  document.addEventListener('mousedown',onDown);
  document.addEventListener('touchstart',onDown,{passive:false});
  document.addEventListener('mouseup',onUp);
  document.addEventListener('mouseleave',onUp);
  document.addEventListener('touchend',onUp);
  document.addEventListener('touchcancel',onUp);
}

// ── Audio engine ───────────────────────────────────────────────────────────────
let AC=null, humOsc1=null, humOsc2=null, humGain=null, humNoiseSrc=null;

function initAudio(){
  if(AC) return;
  try { AC=new (window.AudioContext||window.webkitAudioContext)(); } catch(e){ return; }
  humGain=AC.createGain(); humGain.gain.setValueAtTime(0.0,AC.currentTime); humGain.connect(AC.destination);
  humOsc1=AC.createOscillator(); humOsc1.type='sine'; humOsc1.frequency.value=120;
  const g1=AC.createGain(); g1.gain.value=0.6; humOsc1.connect(g1); g1.connect(humGain); humOsc1.start();
  humOsc2=AC.createOscillator(); humOsc2.type='sine'; humOsc2.frequency.value=240;
  const g2=AC.createGain(); g2.gain.value=0.2; humOsc2.connect(g2); g2.connect(humGain); humOsc2.start();
  const bufLen=AC.sampleRate*3, buf=AC.createBuffer(1,bufLen,AC.sampleRate), d=buf.getChannelData(0);
  for(let i=0;i<bufLen;i++) d[i]=(Math.random()*2-1);
  humNoiseSrc=AC.createBufferSource(); humNoiseSrc.buffer=buf; humNoiseSrc.loop=true;
  const noiseFilter=AC.createBiquadFilter(); noiseFilter.type='bandpass'; noiseFilter.frequency.value=2000; noiseFilter.Q.value=0.5;
  const noiseGain=AC.createGain(); noiseGain.gain.value=0.015;
  humNoiseSrc.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(humGain); humNoiseSrc.start();
  AC.resume();
}

function setHumLevel(vol,rampTime=0.05){
  if(!humGain||!AC||!isFinite(vol)||!isFinite(rampTime)) return;
  humGain.gain.linearRampToValueAtTime(vol,Math.max(AC.currentTime+rampTime,AC.currentTime+0.001));
}

function updateHoldAudio(t){
  if(!AC) return;
  const vol=t<=0?0:Math.pow(t,2.5)*0.025;
  setHumLevel(vol,0.08);
  if(humOsc1) humOsc1.frequency.setValueAtTime(120+t*8,AC.currentTime);
  if(humOsc2) humOsc2.frequency.setValueAtTime(240+t*12,AC.currentTime);
}

function onHoldRelease(){
  if(!AC) return;
  setHumLevel(0,0.4);
  if(humOsc1) humOsc1.frequency.linearRampToValueAtTime(120,AC.currentTime+0.4);
  if(humOsc2) humOsc2.frequency.linearRampToValueAtTime(240,AC.currentTime+0.4);
}

function onHoldComplete(){
  if(!AC) return;
  setHumLevel(0.055,0.3);
  if(humOsc1) humOsc1.frequency.linearRampToValueAtTime(30,AC.currentTime+0.3);
  if(humOsc2) humOsc2.frequency.linearRampToValueAtTime(60,AC.currentTime+0.3);
}

function playLetterSpark(){
  if(!AC) return;
  const t=AC.currentTime;
  const osc=AC.createOscillator(); osc.type='square'; osc.frequency.value=120;
  const filt=AC.createBiquadFilter(); filt.type='bandpass'; filt.frequency.value=800; filt.Q.value=2;
  const g=AC.createGain(); g.gain.setValueAtTime(0.15,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.12);
  osc.connect(filt); filt.connect(g); g.connect(AC.destination); osc.start(t); osc.stop(t+0.13);
}

function playScreenOn(){
  if(!AC) return;
  const t=AC.currentTime;
  const osc=AC.createOscillator(); osc.type='sawtooth';
  osc.frequency.setValueAtTime(40,t); osc.frequency.exponentialRampToValueAtTime(120,t+0.35);
  const og=AC.createGain(); og.gain.setValueAtTime(0,t); og.gain.linearRampToValueAtTime(0.18,t+0.05); og.gain.exponentialRampToValueAtTime(0.001,t+0.45);
  const filt=AC.createBiquadFilter(); filt.type='bandpass'; filt.frequency.value=400; filt.Q.value=1.2;
  osc.connect(filt); filt.connect(og); og.connect(AC.destination); osc.start(t); osc.stop(t+0.46);
  const bufLen=Math.floor(AC.sampleRate*0.05), buf=AC.createBuffer(1,bufLen,AC.sampleRate), d=buf.getChannelData(0);
  for(let i=0;i<bufLen;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/bufLen,1.5);
  const src=AC.createBufferSource(); src.buffer=buf;
  const sg=AC.createGain(); sg.gain.value=0.3; src.connect(sg); sg.connect(AC.destination); src.start(t);
}

function playLightPulse(){
  if(!AC) return ()=>{};
  const t=AC.currentTime, DUR=1.5;
  const nodes=[];
  const humMaster=AC.createGain(); humMaster.gain.setValueAtTime(0.06,t); humMaster.gain.linearRampToValueAtTime(0.09,t+DUR); humMaster.connect(AC.destination);
  [60,120,180].forEach((freq,i)=>{
    const osc=AC.createOscillator(); osc.type='sine'; osc.frequency.value=freq;
    const g=AC.createGain(); g.gain.value=i===0?0.5:i===1?0.25:0.12;
    osc.connect(g); g.connect(humMaster); osc.start(t); osc.stop(t+DUR+0.1); nodes.push(osc);
  });
  let stopped=false;
  const crackleMaster=AC.createGain(); crackleMaster.gain.value=1; crackleMaster.connect(AC.destination);
  function scheduleFlicker(schedT,elapsed){
    if(stopped||schedT>t+DUR) return;
    const crackDur=0.02+Math.random()*0.04, bufLen=Math.ceil(AC.sampleRate*crackDur);
    const buf=AC.createBuffer(1,bufLen,AC.sampleRate), data=buf.getChannelData(0);
    for(let i=0;i<bufLen;i++) data[i]=(Math.random()*2-1)*Math.pow(1-i/bufLen,0.5);
    const src=AC.createBufferSource(); src.buffer=buf;
    const bp=AC.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=800+Math.random()*800; bp.Q.value=2;
    const g=AC.createGain(); g.gain.value=0.08+elapsed*0.06;
    src.connect(bp); bp.connect(g); g.connect(crackleMaster); src.start(schedT); src.stop(schedT+crackDur+0.01); nodes.push(src);
    const interval=(0.20-elapsed*0.17)+Math.random()*(0.15-elapsed*0.12);
    const nextElapsed=Math.min(elapsed+interval/DUR,1);
    setTimeout(()=>scheduleFlicker(AC.currentTime,nextElapsed),Math.max(10,interval*1000-20));
  }
  scheduleFlicker(t+0.1,0);
  return ()=>{ stopped=true; nodes.forEach(n=>{try{n.stop();}catch(e){};}); };
}

function playTokenInsert(){
  if(!AC) return;
  const t=AC.currentTime;
  const bufLen=Math.floor(AC.sampleRate*0.1), buf=AC.createBuffer(1,bufLen,AC.sampleRate), d=buf.getChannelData(0);
  for(let i=0;i<bufLen;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/bufLen,2);
  const clunk=AC.createBufferSource(); clunk.buffer=buf;
  const cf=AC.createBiquadFilter(); cf.type='lowpass'; cf.frequency.value=500;
  const cg=AC.createGain(); cg.gain.value=0.7; clunk.connect(cf); cf.connect(cg); cg.connect(AC.destination); clunk.start(t);
  [[880,0.04,0.35],[1320,0.10,0.3]].forEach(([freq,delay,dur])=>{
    const osc=AC.createOscillator(); osc.type='triangle'; osc.frequency.value=freq;
    const g=AC.createGain(); g.gain.setValueAtTime(0,t+delay); g.gain.linearRampToValueAtTime(0.2,t+delay+0.01); g.gain.exponentialRampToValueAtTime(0.001,t+delay+dur);
    osc.connect(g); g.connect(AC.destination); osc.start(t+delay); osc.stop(t+delay+dur+0.05);
  });
}

function playCRTShutoff(){
  if(!AC) return;
  setHumLevel(0,0.05);
  const t=AC.currentTime;
  const osc=AC.createOscillator(); osc.type='sawtooth'; osc.frequency.setValueAtTime(4200,t); osc.frequency.exponentialRampToValueAtTime(35,t+0.38);
  const og=AC.createGain(); og.gain.setValueAtTime(0.25,t); og.gain.exponentialRampToValueAtTime(0.001,t+0.38);
  osc.connect(og); og.connect(AC.destination); osc.start(t); osc.stop(t+0.4);
  const sbufLen=Math.floor(AC.sampleRate*0.07), sbuf=AC.createBuffer(1,sbufLen,AC.sampleRate), sd=sbuf.getChannelData(0);
  for(let i=0;i<sbufLen;i++) sd[i]=(Math.random()*2-1);
  const ssrc=AC.createBufferSource(); ssrc.buffer=sbuf;
  const sg=AC.createGain(); sg.gain.value=0.4; ssrc.connect(sg); sg.connect(AC.destination); ssrc.start(t);
  const pop=AC.createOscillator(); pop.type='sine'; pop.frequency.value=55;
  const pg=AC.createGain(); pg.gain.setValueAtTime(0.55,t+0.3); pg.gain.exponentialRampToValueAtTime(0.001,t+0.38);
  pop.connect(pg); pg.connect(AC.destination); pop.start(t+0.3); pop.stop(t+0.4);
}

// ── Render loop ────────────────────────────────────────────────────────────────
let lastTime=0;
(function animate(now){
  if(!renderActive) return;
  requestAnimationFrame(animate);
  const dt=Math.min((now-lastTime)/1000,0.05);
  lastTime=now; animTime+=dt;
  updateIntro(dt);
  if(screenState==='off')         { drawScreenOff();                            drawTitle(dt); }
  else if(screenState==='poweron'){ drawScreenPowerOn(dt);                      drawTitle(dt); }
  else if(screenState==='attract'){ drawScreen(dt);                             drawTitle(dt); }
  else if(screenState==='token')  { drawScreenToken();                          drawTitle(dt); }
  else if(screenState==='glitch') { const gE=glitchStartTime?Math.min((performance.now()-glitchStartTime)/1500,1):0; drawScreenGlitch(gE); drawTitle(dt); }
  noiseFrame++; if(noiseFrame%3===0) updateNoise();
  if(introPhase===0&&!tokenInserted) controls.update();
  composer.render();
})(0);

window.addEventListener('resize',()=>{
  camera.aspect=window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth,window.innerHeight);
  composer.setSize(window.innerWidth,window.innerHeight);
});
