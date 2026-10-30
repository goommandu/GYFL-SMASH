import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const SCHOOLS = [
  { id: "goyang_foreign", label: "고양외국어고등학교", file: "./data/goyang_foreign.json" },
  // 고양국제고/김포외고는 건물 모델링을 더 다듬을 때까지 임시로 뺐습니다.
];

const GRAVITY = -24;
const DEBRIS_DESPAWN_DIST_MULT = 1.8;
const THROW_MS = 550; // 수류탄이 던져진 지점까지 날아가는 시간
const EARTHQUAKE_DURATION_MS = 3000;
const EARTHQUAKE_TICK_MS = 700;

// per-weapon tuning: radius (m), outward force range, upward bias range, score multiplier,
// VFX colors, max chunk grid per axis when a building breaks apart, camera-shake strength/duration.
// `damage` is hit points off a building's hp (buildings have 2-4 hp — see buildingMaxHp) so most
// weapons need more than one hit to fully bring a building down instead of one-shotting it.
// 수류탄/빠따는 기본 근접 무기라 위력을 낮췄고, 운석/지진/핵폭탄은 그보다 세게 유지했습니다.
const WEAPONS = {
  bomb: { radius: 10, damage: 1, forceMin: 3, forceMax: 6, upMin: 2, upMax: 4, scoreMult: 0.6, flashColor: 0xffb060, ringColor: 0xffcc66, chunkCap: 2, shakeMag: 0.25, shakeDur: 0.16, freeze: 20 },
  meteor: { radius: 30, damage: 2, forceMin: 16, forceMax: 28, upMin: 11, upMax: 18, scoreMult: 1.35, flashColor: 0xff7a33, ringColor: 0xffa550, chunkCap: 4, shakeMag: 0.85, shakeDur: 0.32, freeze: 55 },
  nuke: { radius: 65, damage: 3, forceMin: 24, forceMax: 42, upMin: 15, upMax: 26, scoreMult: 2.2, flashColor: 0xffffff, ringColor: 0xfff2b0, chunkCap: 5, shakeMag: 1.8, shakeDur: 0.65, freeze: 120 },
};
const EARTHQUAKE = { radius: 42, damage: 1, forceMin: 3, forceMax: 7, upMin: 2, upMax: 5, scoreMult: 0.75, chunkCap: 3, shakeMag: 2.2, wobbleRadius: 110 };
// 레이저는 더 이상 한 점에서 회전하는 무기가 아니라, 사용자가 드래그한 경로를 따라 궤도에서
// 빔이 내려와 훑고 지나가는 방식이라 "radius"는 그 빔이 닿는 폭(= 경로 주변 피해 반경)을 뜻한다.
const LASER = { hitRadius: 10, speed: 85, damage: 1, forceMin: 8, forceMax: 14, upMin: 3, upMax: 7, scoreMult: 1.05, chunkCap: 3, shakeMag: 0.22 };

const HINTS = {
  look: "드래그·휠로 자유롭게 둘러보세요 · 무기를 고르면 공격이 시작됩니다",
  bomb: "지도를 클릭하면 수류탄을 던져요",
  laser: "클릭한 채로 드래그하면 그 경로를 따라 궤도 레이저가 내리꽂혀요",
  meteor: "지도를 클릭하면 하늘에서 운석이 떨어져요",
  earthquake: "지도를 클릭하면 그 주변이 한동안 흔들리며 무너져요",
  nuke: "지도를 클릭하면 폭격기가 지나가며 핵폭탄을 투하해요",
};

// ---------- Korean particle helpers ----------
// For a Hangul syllable, (codepoint - 0xAC00) % 28 gives the final-consonant (받침) slot: 0 means
// no batchim (the syllable ends in a bare vowel), anything else means it does. Non-Hangul text
// (building names in English, etc.) has no reliable rule, so it's treated as batchim-ending,
// which reads correctly far more often than not.
function finalConsonantIndex(ch) {
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return -1;
  return (code - 0xac00) % 28;
}
function josaIGa(word) {
  const f = finalConsonantIndex(word[word.length - 1]);
  return f === 0 ? "가" : "이";
}
function josaEulReul(word) {
  const f = finalConsonantIndex(word[word.length - 1]);
  return f === 0 ? "를" : "을";
}
function josaRo(word) {
  const f = finalConsonantIndex(word[word.length - 1]);
  return f === 0 || f === 8 ? "로" : "으로"; // f===8 is final ㄹ, which also just takes 로
}

// ---------- destruction message set ----------
// ~12 dramatic flavor phrases per weapon (72 total) combined at random with a handful of outcome
// sentence shapes, for well over the ~70 distinct messages asked for without the phrasing ever
// feeling mechanically concatenated — every flavor phrase is written to end in the weapon's own
// name so the particle helpers above always attach correctly regardless of which one is picked.
const FLAVORS = {
  bomb: [
    "말도 안되는 폭발력의 폭탄", "상식을 뛰어넘는 폭탄", "건물을 종잇장처럼 구긴 폭탄",
    "무지막지한 폭탄", "정체불명의 초강력 폭탄", "규격 외 화력의 폭탄", "자비 없는 폭탄",
    "눈 깜짝할 새 터진 폭탄", "위력이 미쳐버린 폭탄", "통제 불능의 폭탄",
    "벽돌도 가루로 만든 폭탄", "시험기간 스트레스가 응축된 폭탄",
  ],
  laser: [
    "빛보다 빠른 레이저", "눈부신 초고출력 레이저", "건물을 두부처럼 썬 레이저",
    "과학기술의 정점을 찍은 레이저", "한 치의 오차도 없는 레이저", "외계 기술로 만든 레이저",
    "섬뜩하게 정밀한 레이저", "소리도 없이 가른 레이저", "붉게 빛나는 죽음의 레이저",
    "절단 전문 레이저", "비현실적인 출력의 레이저", "공상과학 영화급 레이저",
  ],
  meteor: [
    "우주에서 날아온 거대 운석", "공룡을 멸종시킬 뻔한 크기의 운석", "대기권을 뚫고 떨어진 운석",
    "상상초월 크기의 운석", "불타오르며 낙하한 운석", "지구 반대편에서 날아온 운석",
    "하늘이 내린 운석", "중력가속도를 풀로 받은 운석", "운석치고는 너무 큰 운석",
    "NASA도 못 막은 운석", "굉음을 내며 떨어진 운석", "밤하늘을 가르고 온 운석",
  ],
  earthquake: [
    "대지를 통째로 뒤흔든 지진", "리히터 규모를 벗어난 지진", "땅이 갈라질 정도의 지진",
    "건물 기초를 뒤흔든 지진", "전교생이 뛰쳐나올 지진", "지각판이 요동친 지진",
    "교문까지 흔들린 지진", "시험기간에 찾아온 지진", "운동장 모래가 다 튄 지진",
    "땅속 깊은 곳에서 올라온 지진", "진도 측정이 불가능한 지진", "걷잡을 수 없이 흔들린 지진",
  ],
  nuke: [
    "상상을 초월하는 핵폭탄", "버섯구름을 피워올린 핵폭탄", "역사에 남을 위력의 핵폭탄",
    "교칙으로도 못 막는 핵폭탄", "지도에서 지워버릴 핵폭탄", "통제 불가능한 핵폭탄",
    "전교생이 대피할 핵폭탄", "종강을 향한 염원이 담긴 핵폭탄", "다시는 못 볼 위력의 핵폭탄",
    "1교시부터 터진 핵폭탄", "교장선생님도 놀랄 핵폭탄", "차원이 다른 핵폭탄",
  ],
};

const GENERIC_BUILDING_NAMES = ["교사동", "부속 건물", "별관", "교내 건물", "이름 모를 건물동"];

const FULL_DESTROY_TEMPLATES = [
  (f, n) => `${f}${josaRo(f)} ${n}${josaIGa(n)} 완전히 파괴되었습니다!`,
  (f, n) => `${f}${josaRo(f)} ${n}${josaIGa(n)} 흔적도 없이 사라졌습니다!`,
  (f, n) => `${f}에 ${n}${josaIGa(n)} 산산조각났습니다!`,
  (f, n) => `${f}${josaIGa(f)} ${n}${josaEulReul(n)} 완전히 무너뜨렸습니다!`,
  (f, n) => `${f}${josaRo(f)} ${n}${josaIGa(n)} 지도에서 지워졌습니다!`,
  (f, n) => `${f}${josaRo(f)} ${n}${josaIGa(n)} 완전히 주저앉았습니다!`,
];

const PARTIAL_DESTROY_TEMPLATES = [
  (f, n, frac) => `${f}${josaRo(f)} ${n}${josaIGa(n)} ${frac} 파괴되었습니다!`,
  (f, n, frac) => `${f}${josaIGa(f)} ${n}${josaEulReul(n)} ${frac}이나 날려버렸습니다!`,
  (f, n, frac) => `${f}에 ${n}${josaIGa(n)} ${frac} 무너졌습니다!`,
  (f, n, frac) => `${f}${josaRo(f)} ${n}${josaIGa(n)} ${frac} 박살났습니다!`,
  (f, n, frac) => `${f}${josaIGa(f)} ${n}에 치명타를 입혔습니다! (${frac} 파괴)`,
];

function buildDestroyMessage(weaponKey, buildingName, fullyDestroyed, hpAfter, maxHp) {
  const flavors = FLAVORS[weaponKey] || FLAVORS.bomb;
  const flavor = flavors[Math.floor(Math.random() * flavors.length)];
  const name = buildingName || GENERIC_BUILDING_NAMES[Math.floor(Math.random() * GENERIC_BUILDING_NAMES.length)];
  if (fullyDestroyed) {
    const t = FULL_DESTROY_TEMPLATES[Math.floor(Math.random() * FULL_DESTROY_TEMPLATES.length)];
    return t(flavor, name);
  }
  const frac = `${maxHp - hpAfter}/${maxHp}`;
  const t = PARTIAL_DESTROY_TEMPLATES[Math.floor(Math.random() * PARTIAL_DESTROY_TEMPLATES.length)];
  return t(flavor, name, frac);
}

// ---------- DOM ----------
const loadingEl = document.getElementById("loading");
const canvasWrap = document.getElementById("canvas-wrap");
const schoolSelect = document.getElementById("school-select");
const scoreValueEl = document.getElementById("score-value");
const buildingStatEl = document.getElementById("building-stat");
const btnUndo = document.getElementById("btn-undo");
const btnRestore = document.getElementById("btn-restore");
const weaponButtons = Array.from(document.querySelectorAll(".weapon-btn"));
const hintEl = document.getElementById("hint");
const destroyBannerEl = document.getElementById("destroy-banner");
const groundZeroBannerEl = document.getElementById("groundzero-banner");
const dangerBannerEl = document.getElementById("danger-banner");
const canvasWrapEl = document.getElementById("canvas-wrap");
const screenFlashEl = document.getElementById("screen-flash");

function screenFlash(color, peakOpacity, fadeMs) {
  screenFlashEl.style.transition = "none";
  screenFlashEl.style.background = color;
  screenFlashEl.style.opacity = String(peakOpacity);
  requestAnimationFrame(() => {
    screenFlashEl.style.transition = `opacity ${fadeMs}ms ease-out`;
    screenFlashEl.style.opacity = "0";
  });
}

// a quick zoom-punch on big impacts: widen the FOV for an instant then ease it back,
// which reads as a camera "kick" without actually moving the camera.
const baseFov = 50;
let fovPunchToken = 0;
function fovPunch(amount, ms) {
  const myToken = ++fovPunchToken;
  const start = performance.now();
  camera.fov = baseFov + amount;
  camera.updateProjectionMatrix();
  function step() {
    if (myToken !== fovPunchToken) return;
    const t = Math.min(1, (performance.now() - start) / ms);
    camera.fov = baseFov + amount * (1 - t) * (1 - t);
    camera.updateProjectionMatrix();
    if (t < 1) requestAnimationFrame(step);
    else {
      camera.fov = baseFov;
      camera.updateProjectionMatrix();
    }
  }
  step();
}

// ---------- destruction message queue ----------
let messageQueue = [];
let messageShowing = false;
function queueDestroyMessage(text) {
  messageQueue.push(text);
  if (!messageShowing) showNextMessage();
}
function showNextMessage() {
  const text = messageQueue.shift();
  if (!text) {
    messageShowing = false;
    return;
  }
  messageShowing = true;
  destroyBannerEl.textContent = text;
  destroyBannerEl.classList.add("show");
  setTimeout(() => {
    destroyBannerEl.classList.remove("show");
    setTimeout(showNextMessage, 220);
  }, 1700);
}

for (const s of SCHOOLS) {
  const opt = document.createElement("option");
  opt.value = s.id;
  opt.textContent = s.label;
  schoolSelect.appendChild(opt);
}

// ---------- three.js basics ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
canvasWrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xaed4f0);
const textureLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 4000);
const baseCameraOffset = new THREE.Vector3();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.screenSpacePanning = false;

const hemiLight = new THREE.HemisphereLight(0xcfe8ff, 0x3a2f1f, 0.65);
scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xfff3e0, 1.15);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
scene.add(sunLight);
scene.add(sunLight.target);
const ambient = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambient);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- audio (procedural, no external files) ----------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      audioCtx = null;
    }
  } else if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

let noiseBuffer = null;
function getNoiseBuffer(ctx) {
  if (noiseBuffer) return noiseBuffer;
  const len = ctx.sampleRate * 1.2;
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

function playBoom(intensity) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const dur = 0.25 + intensity * 0.55;

  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(1400 * intensity + 200, now);
  filter.frequency.exponentialRampToValueAtTime(60, now + dur);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.5 * intensity + 0.15, now + 0.02);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  noise.connect(filter).connect(noiseGain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + dur + 0.05);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(90 * intensity + 40, now);
  osc.frequency.exponentialRampToValueAtTime(28, now + dur * 0.9);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.0001, now);
  oscGain.gain.exponentialRampToValueAtTime(0.6 * intensity + 0.1, now + 0.015);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(oscGain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.05);
}

function playLaserZap() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(1800, now);
  osc.frequency.exponentialRampToValueAtTime(400, now + 0.14);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.18);
}

function playRumble(dur) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  noise.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(140, now);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.4, now + 0.1);
  gain.gain.setValueAtTime(0.4, now + dur * 0.6);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + dur + 0.05);
}

// a low, slightly detuned two-oscillator drone that swells in then fades out — read as an
// aircraft engine passing by, without needing a real sample
function playPlaneDrone(dur) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.22, now + dur * 0.3);
  gain.gain.setValueAtTime(0.22, now + dur * 0.6);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  gain.connect(ctx.destination);
  for (const [freq, detune] of [[120, 0], [124, -6]]) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, now);
    osc.detune.setValueAtTime(detune, now);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(380, now);
    osc.connect(filter).connect(gain);
    osc.start(now);
    osc.stop(now + dur + 0.1);
  }
}

// a rising-then-wailing siren tone for the earthquake warning banner
function playSiren() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.linearRampToValueAtTime(520, now + 0.35);
  osc.frequency.linearRampToValueAtTime(220, now + 0.7);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.3, now + 0.05);
  gain.gain.setValueAtTime(0.3, now + 0.65);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.8);
}

// ---------- game state ----------
let buildings = []; // {id, name, mesh, footprint, height, area, centroid, alive, destroyable}
let debris = [];
let projectiles = []; // bombs / nukes (fuse) and meteors (falling)
let undoStack = [];
let score = 0;
let sceneGroup = null;
let groundMesh = null;
let sceneRadius = 300; // backdrop/ground/fog extent (all buildings)
let campusRadius = 150; // real-campus extent (destroyable buildings), used for camera fit
let activeWeapon = "look";
let floatingTexts = [];
let wobbles = []; // {mesh, startTime, duration}
let nameLabels = []; // {el, building}
let shakeState = { time: 0, duration: 0, magnitude: 0 };
let freezeUntil = 0;
let activeNukeCutscene = null; // {phase, plane, bomb, start, dropAt, point, ...}

const raycaster = new THREE.Raycaster();

function ensureCCW(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += (x2 - x1) * (y2 + y1);
  }
  return sum > 0 ? points.slice().reverse() : points;
}

// 고양외고 실제 건물 사진 기준: 붉은 벽돌 + 아이보리색 석재 트림이 섞인 배색.
function buildingColor(id) {
  const palette = [0xc77459, 0xb8674e, 0xd0a988, 0xc06a4f, 0xba6b54, 0xc9816a];
  return palette[id % palette.length];
}
function backdropColor(id) {
  const palette = [0x8b93a0, 0x949aa6, 0x8690a0, 0x9098a3];
  return palette[id % palette.length];
}

// 벽면용 절차적 벽돌+창문 텍스처. 실제 파사드 사진이 없어 완전히 똑같이 만들 수는 없지만,
// 평평한 단색보다 사진 속 건물에 훨씬 가깝게 보이도록 한다.
// A rounded-top ("arched") rectangle, echoing the arched collegiate-style windows in the
// reference photos (e.g. 미래관's entrance windows) better than a plain rectangle would.
function archedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, Math.PI * 1.5, 0);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function createBrickTexture() {
  const size = 320;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#b5674d";
  ctx.fillRect(0, 0, size, size);

  // brick coursing
  ctx.strokeStyle = "rgba(60,25,15,0.16)";
  ctx.lineWidth = 2;
  for (let y = 8; y < size; y += 12) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,220,200,0.07)";
  for (let y = 2; y < size; y += 12) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  const rows = 2;
  const cols = 3;
  const rowH = size / rows;
  const colW = size / cols;

  // ivory stone trim bands between floors, like the horizontal banding on the real dorm/academic
  // buildings in the reference photos
  ctx.fillStyle = "#ded4bf";
  for (let r = 0; r <= rows; r++) {
    const y = r * rowH;
    ctx.fillRect(0, y - 5, size, 10);
  }

  // arched windows (ivory frame, pale blue-green glass)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wWidth = colW * 0.48;
      const wHeight = rowH * 0.58;
      const x = c * colW + (colW - wWidth) / 2;
      const y = r * rowH + rowH * 0.3;
      ctx.fillStyle = "#e9e3d2";
      archedRectPath(ctx, x - 5, y - 5, wWidth + 10, wHeight + 10, wWidth * 0.55);
      ctx.fill();
      ctx.fillStyle = r % 2 === 0 ? "#8fb3c4" : "#9fc1cf";
      archedRectPath(ctx, x, y, wWidth, wHeight, wWidth * 0.5);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1.5;
      archedRectPath(ctx, x, y, wWidth, wHeight, wWidth * 0.5);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const brickTexture = createBrickTexture();

// ExtrudeGeometry/ShapeGeometry extrude along local Z from a shape drawn in the local XY
// plane, then rotateX(-90deg) stands that shape up so local X -> world X and local Z (the
// extrude depth) -> world Y (up). That same rotation sends local Y -> world -Z, so feeding a
// footprint's raw (x, z) straight in as the shape's (X, Y) silently mirrors the building on
// the world Z axis relative to anything built directly from world coordinates (the ground,
// the satellite plane, the boundary line). Negating z here before building the shape cancels
// that mirror, so every building lands at world Z == footprint Z like everything else.
function footprintToShape(points) {
  const flipped = points.map(([x, z]) => [x, -z]);
  const ordered = ensureCCW(flipped);
  return new THREE.Shape(ordered.map(([x, y]) => new THREE.Vector2(x, y)));
}

// Rewrites a geometry's UV so a flat-shaded top-down texture (like our satellite image) lines
// up with world space: u/v are derived straight from each vertex's final world X/Z against the
// image's world-space rect, matching the mapping used for the ground satellite plane.
function applySatelliteUV(geo, rect) {
  if (!rect) return;
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const spanX = rect.maxX - rect.minX || 1;
  const spanZ = rect.maxZ - rect.minZ || 1;
  for (let i = 0; i < pos.count; i++) {
    const wx = pos.getX(i);
    const wz = pos.getZ(i);
    uv[i * 2] = (wx - rect.minX) / spanX;
    uv[i * 2 + 1] = (rect.maxZ - wz) / spanZ;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

// ExtrudeGeometry's default side-wall UV generator normalizes u/v to [0,1] per individual edge
// segment and per the extrude depth, so a short wall segment and a 30m-long one both get exactly
// one texture repeat — on footprints with very uneven edge lengths that stretches or compresses
// the brick/window pattern into illegible stripes. Overwriting the side faces' UV from each
// vertex's actual world position gives the brick texture a consistent real-world tile size
// instead, regardless of how long or short any one wall segment is.
const WALL_TILE_METERS = 6;
function applyWallUV(geo, height) {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const wx = pos.getX(i);
    const wz = pos.getZ(i);
    const wy = pos.getY(i);
    uv[i * 2] = (wx + wz) / WALL_TILE_METERS;
    uv[i * 2 + 1] = wy / WALL_TILE_METERS;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

// Per-building procedural facade textures, designed FROM the reference photos the user sent
// (colors, materials, window shapes, proportions) rather than stretching those photos directly
// onto the geometry — a flat UV map of an oblique photo reads as smeared/distorted, while a
// drawn material captures the building's real character (brick tone, ivy coverage, glass vs.
// stone banding, tile stripes...) cleanly at any viewing angle and tiles seamlessly up the wall.
// (reuses the archedRectPath() helper defined above for createBrickTexture())
function createBuildingTexture(opts) {
  const size = 320;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = opts.base;
  ctx.fillRect(0, 0, size, size);

  if (opts.stripes) {
    const n = opts.stripes.count;
    const w = size / n;
    ctx.fillStyle = opts.stripes.color;
    for (let i = 0; i < n; i++) {
      if (i % 2 === (opts.stripes.offset || 0)) ctx.fillRect(i * w, 0, w, size);
    }
  }

  if (opts.bands) {
    for (const band of opts.bands) {
      ctx.fillStyle = band.color;
      ctx.fillRect(0, band.y0 * size, size, (band.y1 - band.y0) * size);
    }
  }

  if (opts.coursing) {
    ctx.strokeStyle = opts.coursing.color || "rgba(50,20,10,0.16)";
    ctx.lineWidth = 2;
    for (let y = opts.coursing.y0 * size; y < opts.coursing.y1 * size; y += 12) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
  }

  if (opts.glassGrid) {
    const { rows, cols, color, yRange } = opts.glassGrid;
    ctx.fillStyle = color;
    ctx.fillRect(0, yRange[0] * size, size, (yRange[1] - yRange[0]) * size);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1.5;
    const rowH = ((yRange[1] - yRange[0]) * size) / rows;
    const colW = size / cols;
    for (let r = 0; r <= rows; r++) {
      const y = yRange[0] * size + r * rowH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
    for (let c = 0; c <= cols; c++) {
      const x = c * colW;
      ctx.beginPath();
      ctx.moveTo(x, yRange[0] * size);
      ctx.lineTo(x, yRange[1] * size);
      ctx.stroke();
    }
  }

  if (opts.windows) {
    const { rows, cols, color, frame, shape, yRange } = opts.windows;
    const rowH = ((yRange[1] - yRange[0]) * size) / rows;
    const colW = size / cols;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wWidth = colW * 0.5;
        const wHeight = rowH * 0.6;
        const x = c * colW + (colW - wWidth) / 2;
        const y = yRange[0] * size + r * rowH + rowH * 0.22;
        ctx.fillStyle = frame;
        if (shape === "arch") {
          archedRectPath(ctx, x - 5, y - 5, wWidth + 10, wHeight + 10, wWidth * 0.55);
          ctx.fill();
          ctx.fillStyle = color;
          archedRectPath(ctx, x, y, wWidth, wHeight, wWidth * 0.5);
          ctx.fill();
        } else {
          ctx.fillRect(x - 5, y - 5, wWidth + 10, wHeight + 10);
          ctx.fillStyle = color;
          ctx.fillRect(x, y, wWidth, wHeight);
        }
      }
    }
  }

  if (opts.ivy) {
    const colors = ["#3f6b30", "#4c7a3a", "#355c28", "#5a8a44"];
    for (let i = 0; i < opts.ivy.clusters; i++) {
      const cx = Math.random() * size;
      const cy = size * (0.18 + Math.random() * 0.8);
      ctx.fillStyle = colors[i % colors.length];
      for (let j = 0; j < 6; j++) {
        const r = 12 + Math.random() * 20;
        ctx.beginPath();
        ctx.arc(cx + (Math.random() - 0.5) * 32, cy + (Math.random() - 0.5) * 32, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 창문은 더 이상 평평한 텍스처 그림이 아니라 실제 돌출된 3D 지오메트리(buildWindowInstances)로
// 만들어지므로, 여기서는 벽의 바탕 재질(벽돌 톤 · 석재 밴드 · 줄눈 · 담쟁이)만 담당한다.
const BUILDING_CUSTOM_TEXTURES = {
  IVY관: createBuildingTexture({
    base: "#8b5a42",
    coursing: { y0: 0, y1: 1 },
    ivy: { clusters: 11 },
  }),
  "위즈덤 홀": createBuildingTexture({
    base: "#cdbfae",
    bands: [{ y0: 0, y1: 0.58, color: "#3f8f78" }],
  }),
  글로리아관: createBuildingTexture({
    base: "#e4ddcb",
    stripes: { count: 6, color: "#c66b47", offset: 0 },
  }),
  비전관: createBuildingTexture({
    base: "#c0523a",
    coursing: { y0: 0, y1: 1 },
  }),
  미래관: createBuildingTexture({
    base: "#a5583f",
    bands: [{ y0: 0, y1: 0.18, color: "#eee6d3" }],
    coursing: { y0: 0.18, y1: 1 },
  }),
};

// Per-building facade style for the real 3D architectural detail (cornice, plinth, window bays,
// entrance canopy) added in buildFacadeDetails() — one style per named building the user sent
// reference photos of, matched to that building's actual material/window character; everything
// else (surrounding destroyable buildings without a specific photo) falls back to a small rotating
// set of generic collegiate-brick styles keyed off the building's OSM id so they still look varied.
const BUILDING_STYLES = {
  IVY관: { frameColor: 0xd8cdb8, glassColor: 0x273842, windowShape: "rect", floors: 3, corniceColor: 0xcdbfae, canopy: true },
  "위즈덤 홀": { frameColor: 0xe7ddc9, glassColor: 0x3f8f78, windowShape: "glass", floors: 3, corniceColor: 0x9c8f78, canopy: true },
  글로리아관: { frameColor: 0xffffff, glassColor: 0x7398ab, windowShape: "rect", floors: 3, corniceColor: 0xf2ede0, canopy: true },
  비전관: { frameColor: 0xe9e2d2, glassColor: 0x7fa0b0, windowShape: "arch", floors: 3, corniceColor: 0xeee6d3, canopy: true },
  미래관: { frameColor: 0xeee6d3, glassColor: 0x7fa7bc, windowShape: "arch", floors: 3, corniceColor: 0xeee6d3, canopy: true },
};
const DEFAULT_BUILDING_STYLES = [
  { frameColor: 0xd8cdb8, glassColor: 0x33424a, windowShape: "rect", floors: 3, corniceColor: 0xe6ddc8, canopy: false },
  { frameColor: 0xe9e2d2, glassColor: 0x7fa0b0, windowShape: "arch", floors: 2, corniceColor: 0xeee6d3, canopy: false },
  { frameColor: 0xffffff, glassColor: 0x7398ab, windowShape: "rect", floors: 3, corniceColor: 0xf2ede0, canopy: false },
];
function styleForBuilding(b) {
  return BUILDING_STYLES[b.name] || DEFAULT_BUILDING_STYLES[b.id % DEFAULT_BUILDING_STYLES.length];
}

// The outward-facing unit normal of footprint edge p1->p2: perpendicular to the edge, picking
// whichever of the two perpendicular directions points away from the building's own centroid.
function outwardNormal(p1, p2, centroid) {
  const ex = p2[0] - p1[0];
  const ez = p2[1] - p1[1];
  const len = Math.hypot(ex, ez) || 1;
  let nx = ez / len;
  let nz = -ex / len;
  const midx = (p1[0] + p2[0]) / 2;
  const midz = (p1[1] + p2[1]) / 2;
  if (nx * (midx - centroid.x) + nz * (midz - centroid.z) < 0) {
    nx = -nx;
    nz = -nz;
  }
  return [nx, nz];
}

// A rounded-top arch as a real extrudable 2D Shape (not a canvas path) for arched window glass,
// centered on its own origin so instancing can place/rotate it directly.
function archedShape3D(w, h) {
  const hw = w / 2;
  const r = hw;
  const straightH = Math.max(0.05, h - r);
  const baseY = -h / 2;
  const topY = baseY + straightH;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, baseY);
  shape.lineTo(-hw, topY);
  const segs = 14;
  for (let i = 0; i <= segs; i++) {
    const a = Math.PI - (Math.PI * i) / segs;
    shape.lineTo(Math.cos(a) * r, topY + Math.sin(a) * r);
  }
  shape.lineTo(hw, baseY);
  shape.closePath();
  return shape;
}

// A perimeter trim band (roof cornice / ground plinth) built as one box per footprint edge,
// pushed outward along that edge's own outward normal so it reads as a protruding ledge rather
// than a flat decal.
function buildEdgeBand(footprint, centroid, y, bandH, outset, color, roughness) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.03 });
  const n = footprint.length;
  for (let i = 0; i < n; i++) {
    const p1 = footprint[i];
    const p2 = footprint[(i + 1) % n];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (len < 0.4) continue;
    const [nx, nz] = outwardNormal(p1, p2, centroid);
    const midx = (p1[0] + p2[0]) / 2 + nx * outset * 0.5;
    const midz = (p1[1] + p2[1]) / 2 + nz * outset * 0.5;
    const box = new THREE.Mesh(new THREE.BoxGeometry(len + outset, bandH, outset), mat);
    box.position.set(midx, y, midz);
    box.rotation.y = Math.atan2(nx, nz);
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);
  }
  return group;
}

// Real, protruding window bays (recessed frame + glass pane) walked around every footprint edge
// and stacked per floor, rendered as two InstancedMesh batches (frame, glass) per building so a
// 10+ building campus with hundreds of window units still costs only ~2 draw calls each.
function buildWindowInstances(footprint, centroid, height, style, floors, floorH, extraOutset = 0) {
  const bayTarget = 3.4;
  const isGlass = style.windowShape === "glass";
  const winW = isGlass ? bayTarget * 0.42 : bayTarget * 0.46;
  const winH = isGlass ? floorH * 0.78 : floorH * (style.windowShape === "arch" ? 0.6 : 0.52);
  const depth = isGlass ? 0.08 : 0.12;

  const transforms = [];
  const n = footprint.length;
  for (let e = 0; e < n; e++) {
    const p1 = footprint[e];
    const p2 = footprint[(e + 1) % n];
    const ex = p2[0] - p1[0];
    const ez = p2[1] - p1[1];
    const len = Math.hypot(ex, ez);
    if (len < 3.0) continue;
    const bays = Math.max(1, Math.min(9, Math.round(len / bayTarget)));
    const cols = isGlass ? bays * 2 : bays;
    const [nx, nz] = outwardNormal(p1, p2, centroid);
    const rotY = Math.atan2(nx, nz);
    for (let c = 0; c < cols; c++) {
      const t = (c + 0.5) / cols;
      const px = p1[0] + ex * t + nx * (0.04 + extraOutset);
      const pz = p1[1] + ez * t + nz * (0.04 + extraOutset);
      for (let j = 0; j < floors; j++) {
        if (floors > 1 && j === 0 && height / floors < 3) continue;
        const py = floorH * j + floorH * 0.5;
        transforms.push({ x: px, y: py, z: pz, rotY, nx, nz });
      }
    }
  }
  if (!transforms.length) return null;

  const group = new THREE.Group();
  const frameGeo = new THREE.BoxGeometry(winW, winH, depth);
  const frameMat = new THREE.MeshStandardMaterial({ color: style.frameColor, roughness: 0.75, metalness: 0.03 });
  const frameMesh = new THREE.InstancedMesh(frameGeo, frameMat, transforms.length);
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;

  let glassGeo;
  if (style.windowShape === "arch") {
    glassGeo = new THREE.ExtrudeGeometry(archedShape3D(winW * 0.76, winH * 0.76), { depth: 0.04, bevelEnabled: false });
    glassGeo.translate(0, 0, -0.02);
  } else {
    glassGeo = new THREE.BoxGeometry(winW * 0.8, winH * 0.8, 0.04);
  }
  const glassMat = new THREE.MeshStandardMaterial({
    color: style.glassColor,
    roughness: isGlass ? 0.12 : 0.3,
    metalness: isGlass ? 0.55 : 0.12,
    emissive: new THREE.Color(style.glassColor).multiplyScalar(0.1),
  });
  const glassMesh = new THREE.InstancedMesh(glassGeo, glassMat, transforms.length);
  glassMesh.receiveShadow = true;

  // The frame box's own outer face already sits (frame center offset + depth/2) proud of the
  // wall, so the glass pane has to be pushed out past THAT face — not just past the wall — or it
  // ends up sitting inside the frame's volume and is fully hidden behind its front face.
  const glassExtra = depth / 2 + 0.03;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3(1, 1, 1);
  transforms.forEach((t, i) => {
    euler.set(0, t.rotY, 0);
    q.setFromEuler(euler);
    m.compose(new THREE.Vector3(t.x, t.y, t.z), q, scale);
    frameMesh.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(t.x + t.nx * glassExtra, t.y, t.z + t.nz * glassExtra), q, scale);
    glassMesh.setMatrixAt(i, m);
  });
  frameMesh.instanceMatrix.needsUpdate = true;
  glassMesh.instanceMatrix.needsUpdate = true;
  group.add(frameMesh, glassMesh);
  return group;
}

// A small entrance portico (flat canopy slab on two columns) centered on a building's longest
// wall, echoing the entrance canopies visible in the reference photos without modeling doors.
function buildEntranceCanopy(footprint, centroid, floorH, color) {
  const n = footprint.length;
  let best = null;
  let bestLen = -1;
  for (let i = 0; i < n; i++) {
    const p1 = footprint[i];
    const p2 = footprint[(i + 1) % n];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (len > bestLen) {
      bestLen = len;
      best = [p1, p2];
    }
  }
  if (!best || bestLen < 6) return null;
  const [p1, p2] = best;
  const midx = (p1[0] + p2[0]) / 2;
  const midz = (p1[1] + p2[1]) / 2;
  const [nx, nz] = outwardNormal(p1, p2, centroid);
  const tx = nz;
  const tz = -nx;
  const rotY = Math.atan2(nx, nz);

  const group = new THREE.Group();
  const canopyDepth = 2.6;
  const canopyWidth = Math.min(bestLen * 0.45, 7);
  const canopyY = Math.max(2.6, floorH * 0.92);
  const slabMat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(canopyWidth, 0.28, canopyDepth), slabMat);
  canopy.position.set(midx + nx * canopyDepth * 0.5, canopyY, midz + nz * canopyDepth * 0.5);
  canopy.rotation.y = rotY;
  canopy.castShadow = true;
  canopy.receiveShadow = true;
  group.add(canopy);

  const colMat = new THREE.MeshStandardMaterial({ color: 0xcfc6b2, roughness: 0.7 });
  const colGeo = new THREE.CylinderGeometry(0.15, 0.18, canopyY, 8);
  for (const s of [-1, 1]) {
    const col = new THREE.Mesh(colGeo, colMat);
    const ox = midx + nx * canopyDepth * 0.92 + tx * s * canopyWidth * 0.4;
    const oz = midz + nz * canopyDepth * 0.92 + tz * s * canopyWidth * 0.4;
    col.position.set(ox, canopyY / 2, oz);
    col.castShadow = true;
    group.add(col);
  }
  return group;
}

// Full facade detail pass for a destroyable building: roof cornice, ground plinth, real window
// bays, and (for a few named buildings) an entrance canopy — all built directly in world space
// from the building's own footprint/height, so they line up with the wall mesh with no extra
// transform bookkeeping.
function buildFacadeDetails(group, bd, centroid) {
  const style = styleForBuilding(bd);
  const floors = Math.max(1, Math.min(style.floors || 3, Math.round(bd.height / 3.2)));
  const floorH = bd.height / floors;

  group.add(buildEdgeBand(bd.footprint, centroid, bd.height - 0.21, 0.42, 0.24, style.corniceColor, 0.7));
  group.add(buildEdgeBand(bd.footprint, centroid, 0.52, 1.05, 0.12, 0x6e6555, 0.95));

  const windows = buildWindowInstances(bd.footprint, centroid, bd.height, style, floors, floorH);
  if (windows) group.add(windows);

  if (style.canopy) {
    const canopy = buildEntranceCanopy(bd.footprint, centroid, floorH, style.corniceColor);
    if (canopy) group.add(canopy);
  }
}

// Real modeled buildings (.glb, hand-modeled or AI-generated from the user's reference photos)
// that fully replace the procedural facade for that one building. Keyed by name; a building not
// listed here just keeps its procedural look. `extraRotationDeg` is a manual correction (found by
// eye, in 90° steps) for cases where the model's front and the real building's front still end up
// mirrored after the automatic aspect-ratio match below — see loadGlbIntoGroup.
const BUILDING_GLB_MODELS = {
  미래관: { path: "./data/models/mirae.glb", extraRotationDeg: 180 },
  "위즈덤 홀": { path: "./data/models/wisdom.glb", extraRotationDeg: 0, fitMode: "uniform" },
  비전관: { path: "./data/models/vision.glb", extraRotationDeg: 180, fitMode: "stretch" },
};

// A real building footprint is almost never aligned to world X/Z — ours here is a parallelogram
// sitting at roughly a 30-40° angle. An axis-aligned min/max bounding box around a rotated
// rectangle is always bigger than the rectangle itself, in both directions, so fitting a model to
// that box (as an earlier version of this function did) makes it both the wrong size AND
// impossible to orient correctly (its sides can never line up with the real, angled walls). This
// instead measures the footprint's own true length/width along its longest edge's own direction.
function orientedFootprintDims(footprint) {
  const n = footprint.length;
  let bestLen = -1;
  let dx = 1;
  let dz = 0;
  for (let i = 0; i < n; i++) {
    const p1 = footprint[i];
    const p2 = footprint[(i + 1) % n];
    const ex = p2[0] - p1[0];
    const ez = p2[1] - p1[1];
    const len = Math.hypot(ex, ez);
    if (len > bestLen) {
      bestLen = len;
      dx = ex / len;
      dz = ez / len;
    }
  }
  const px = -dz;
  const pz = dx;
  let minL = Infinity;
  let maxL = -Infinity;
  let minW = Infinity;
  let maxW = -Infinity;
  for (const [x, z] of footprint) {
    const l = x * dx + z * dz;
    const w = x * px + z * pz;
    minL = Math.min(minL, l);
    maxL = Math.max(maxL, l);
    minW = Math.min(minW, w);
    maxW = Math.max(maxW, w);
  }
  return { length: Math.max(1, maxL - minL), width: Math.max(1, maxW - minW), dx, dz };
}

// Loads a GLB model in place of a building's procedural facade, once it's ready. The procedural
// wall/roof/cornice/window meshes are built first and kept (just hidden) as both an immediate
// placeholder while the (often multi-MB) model downloads, and a safe fallback if the load fails.
//
// Orientation always comes from the footprint's own true, oriented length/width (see
// orientedFootprintDims above) rather than a world-axis-aligned box — an inflated, un-rotatable
// box can never actually line up with an angled building. Of the 4 ways to line the model's long
// axis up with the footprint's long axis (2 choices of which model axis is "long", each with a
// front/back flip), the one whose box best matches the footprint's length:width ratio is kept —
// this still can't tell front from back on its own (both read identically in a bounding box), so
// `extraRotationDeg` is there for a manual 180° correction found by eye.
//
// `fitMode` controls how SIZE is matched: "stretch" (default) scales length and width
// independently to exactly fill the footprint — precise, but if the model's own proportions
// differ much from the footprint's, it can look visibly elongated/squashed. "uniform" instead
// scales every axis by the same factor (from height), keeping the model's real proportions intact
// at the cost of not perfectly filling the mapped footprint outline — use it when a building looks
// stretched under "stretch".
//
// `addWindows: true` layers a supplemental band of procedural windows (the same system
// buildFacadeDetails() uses for fully-procedural buildings) around the building's real footprint,
// on top of the loaded model — for a source model that only has real detail on one face (an
// AI-generated "front elevation" model, say) and is otherwise blank on its other walls. Pushed out
// an extra bit from the wall (glbWindowOutset) since the model's own wall plane is only
// approximately where the footprint edge says it is, unlike a procedural wall built exactly there.
function loadGlbIntoGroup(group, path, bd, extraRotationDeg = 0, fitMode = "stretch", addWindows = false) {
  const proceduralChildren = group.children.slice();
  gltfLoader.load(
    path,
    (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);

      const { length, width, dx, dz } = orientedFootprintDims(bd.footprint);
      const targetH = Math.max(1, bd.height);
      const baseRot = Math.atan2(dx, dz); // maps local Z+ to world (dx, dz), the footprint's long-edge direction

      // longAxisIsZ: candidates where the model's own local Z size lines up with the footprint's
      // length (local Z+ along baseRot or baseRot+180); the other two candidates line the model's
      // local X size up with it instead (baseRot+90 / baseRot+270).
      const candidates = [
        { rot: baseRot, longAxisIsZ: true },
        { rot: baseRot + Math.PI, longAxisIsZ: true },
        { rot: baseRot + Math.PI / 2, longAxisIsZ: false },
        { rot: baseRot - Math.PI / 2, longAxisIsZ: false },
      ];
      const targetRatio = length / width;
      let best = candidates[0];
      let bestDiff = Infinity;
      for (const c of candidates) {
        const modelRatio = c.longAxisIsZ ? size.z / size.x : size.x / size.z;
        const diff = Math.abs(Math.log(modelRatio / targetRatio));
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c;
        }
      }

      if (fitMode === "uniform") {
        const s = targetH / Math.max(0.001, size.y);
        model.scale.setScalar(s);
      } else {
        model.scale.set(
          best.longAxisIsZ ? width / Math.max(0.001, size.x) : length / Math.max(0.001, size.x),
          targetH / Math.max(0.001, size.y),
          best.longAxisIsZ ? length / Math.max(0.001, size.z) : width / Math.max(0.001, size.z)
        );
      }
      model.rotation.y = best.rot + (extraRotationDeg * Math.PI) / 180;

      const box2 = new THREE.Box3().setFromObject(model);
      const center = new THREE.Vector3();
      box2.getCenter(center);
      const centroid = polygonCentroid(bd.footprint);
      model.position.x += centroid.x - center.x;
      model.position.z += centroid.z - center.z;
      model.position.y += -box2.min.y;

      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      for (const child of proceduralChildren) child.visible = false;
      group.add(model);
      group.userData.glbModel = model;

      if (addWindows) {
        // Scaling height to match the model's OWN bounding box top (which may include a roof
        // peak/spire well above the flat wall tops, as this one's gabled tower does) scales the
        // plain wall sections shorter than bd.height to compensate — so windows sized for the
        // full bd.height end up floating above the real, shorter wall/roofline. Capping the
        // window band well below the nominal height keeps it inside the wall regardless of how
        // much headroom any one model's roof detail eats into.
        const style = styleForBuilding(bd);
        const windowCeiling = bd.height * 0.62;
        const winFloors = Math.max(1, Math.min(style.floors || 3, Math.round(windowCeiling / 4.5)));
        const winFloorH = windowCeiling / winFloors;
        const windows = buildWindowInstances(bd.footprint, centroid, windowCeiling, style, winFloors, winFloorH, 0.15);
        if (windows) group.add(windows);
      }
    },
    undefined,
    (err) => {
      console.warn(`GLB load failed for ${bd.name} (${path}), keeping procedural building:`, err);
    }
  );
}

function makeFlatShapeMesh(points, color, y, opacity = 1) {
  const shape = footprintToShape(points);
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 1,
    transparent: opacity < 1,
    opacity,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

function buildBuildingMesh(b, destroyable, satRect) {
  const shape = footprintToShape(b.footprint);
  const color = destroyable ? buildingColor(b.id) : backdropColor(b.id);

  const wallGeo = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false, steps: 1 });
  wallGeo.rotateX(-Math.PI / 2);
  if (destroyable) applyWallUV(wallGeo, b.height);
  const customTex = destroyable ? BUILDING_CUSTOM_TEXTURES[b.name] : null;
  // a custom texture already carries its own designed-from-photo color, so it gets no tint;
  // the generic brick texture is tinted lightly per building so buildings still read as distinct.
  const wallTint = customTex ? 0xffffff : destroyable ? new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55) : color;
  const wallMat = new THREE.MeshStandardMaterial({
    color: wallTint,
    map: customTex || (destroyable ? brickTexture : null),
    roughness: destroyable ? 0.85 : 0.95,
    metalness: 0.02,
  });
  const wallMesh = new THREE.Mesh(wallGeo, wallMat);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;

  const group = new THREE.Group();
  group.add(wallMesh);

  if (satRect) {
    const roofGeo = new THREE.ShapeGeometry(shape);
    roofGeo.rotateX(-Math.PI / 2);
    roofGeo.translate(0, b.height + 0.03, 0);
    applySatelliteUV(roofGeo, satRect);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    const roofMesh = new THREE.Mesh(roofGeo, roofMat);
    roofMesh.receiveShadow = true;
    roofMesh.castShadow = true;
    group.add(roofMesh);
    group.userData.roofMat = roofMat;
  }

  if (destroyable) {
    const centroid = polygonCentroid(b.footprint);
    buildFacadeDetails(group, b, centroid);
    const glbCfg = BUILDING_GLB_MODELS[b.name];
    if (glbCfg)
      loadGlbIntoGroup(group, glbCfg.path, b, glbCfg.extraRotationDeg || 0, glbCfg.fitMode || "stretch", !!glbCfg.addWindows);
  }

  group.userData.color = color;
  return group;
}

// Bilinear-samples the baked SRTM elevation grid at a world (x, z) position.
function sampleElevationGrid(elev, wx, wz) {
  const { nx, nz, rect, grid } = elev;
  const u = ((wx - rect.minX) / (rect.maxX - rect.minX)) * (nx - 1);
  const v = ((wz - rect.minZ) / (rect.maxZ - rect.minZ)) * (nz - 1);
  const i0 = Math.min(Math.max(Math.floor(u), 0), Math.max(nx - 2, 0));
  const j0 = Math.min(Math.max(Math.floor(v), 0), Math.max(nz - 2, 0));
  const i1 = Math.min(i0 + 1, nx - 1);
  const j1 = Math.min(j0 + 1, nz - 1);
  const fu = Math.min(Math.max(u - i0, 0), 1);
  const fv = Math.min(Math.max(v - j0, 0), 1);
  const h00 = grid[j0][i0];
  const h10 = grid[j0][i1];
  const h01 = grid[j1][i0];
  const h11 = grid[j1][i1];
  const top = h00 + (h10 - h00) * fu;
  const bot = h01 + (h11 - h01) * fu;
  return top + (bot - top) * fv;
}

// The real SRTM terrain under the schoolyard itself is not perfectly flat (a few meters of
// natural variation), which would make rectangular extruded buildings clip into or float above
// it. Schoolyards are leveled ground in reality, so the campus bounds are held flat at the
// baseline elevation and smoothly blended (smoothstep over BLEND meters) into the real hillside
// elevation outside that footprint.
function terrainHeightAt(elev, bounds, wx, wz) {
  if (!elev) return 0;
  const raw = sampleElevationGrid(elev, wx, wz) - elev.baseline;
  const dx = Math.max(bounds.minX - wx, 0, wx - bounds.maxX);
  const dz = Math.max(bounds.minZ - wz, 0, wz - bounds.maxZ);
  const distOutside = Math.hypot(dx, dz);
  const BLEND = 50;
  const t = Math.min(1, distOutside / BLEND);
  const smooth = t * t * (3 - 2 * t);
  return raw * smooth;
}

function buildTerrainMesh(data) {
  const elev = data.elevation;
  const rect = data.satRect || (elev && elev.rect);
  if (!rect) return null;
  const nx = elev ? Math.max(1, elev.nx - 1) : 1;
  const nz = elev ? Math.max(1, elev.nz - 1) : 1;
  const geo = new THREE.PlaneGeometry(rect.maxX - rect.minX, rect.maxZ - rect.minZ, nx, nz);
  geo.rotateX(-Math.PI / 2);
  geo.translate((rect.minX + rect.maxX) / 2, 0, (rect.minZ + rect.maxZ) / 2);
  if (elev) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i);
      const wz = pos.getZ(i);
      pos.setY(i, terrainHeightAt(elev, data.bounds, wx, wz));
    }
    geo.computeVertexNormals();
  }
  applySatelliteUV(geo, rect);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  return mesh;
}

// ---------- decorative campus props (trees, gate, review stand) ----------
// Realistic low-poly trees: a tapered trunk plus 3 offset, irregularly-sized foliage blobs (not
// one single cone) so the canopy reads as an actual clump of leaves rather than a toy lollipop.
// Built as two InstancedMesh batches (trunks, foliage) shared across every tree on the whole
// campus, so going from a couple dozen trees to ~200 costs only 2 draw calls total instead of
// hundreds of individual meshes.
const TREE_LEAF_COLORS = [0x4c7a3a, 0x3f6b30, 0x5a8a44, 0x6b9850, 0x456b36];
const TREE_CLUSTERS = 3;
function buildTreesInstanced(placements) {
  const group = new THREE.Group();
  const count = placements.length;
  if (!count) return group;

  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.27, 1, 6, 2);
  trunkGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 1 });
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;

  const foliageGeo = new THREE.IcosahedronGeometry(1, 1);
  const foliageMat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
  const foliageMesh = new THREE.InstancedMesh(foliageGeo, foliageMat, count * TREE_CLUSTERS);
  foliageMesh.castShadow = true;
  foliageMesh.receiveShadow = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const col = new THREE.Color();
  let fi = 0;

  placements.forEach(({ x, z, y, seed }, i) => {
    let s = seed >>> 0;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const h = 3.2 + rand() * 3.4;
    const trunkH = h * 0.4;
    const trunkR = 0.75 + rand() * 0.5;
    m.compose(new THREE.Vector3(x, y, z), q.identity(), new THREE.Vector3(trunkR, trunkH, trunkR));
    trunkMesh.setMatrixAt(i, m);

    const canopyR = 1.0 + rand() * 1.0;
    const canopyBaseY = y + trunkH * 0.9;
    for (let c = 0; c < TREE_CLUSTERS; c++) {
      const ang = (c / TREE_CLUSTERS) * Math.PI * 2 + rand() * 2;
      const rOff = c === 0 ? 0 : canopyR * 0.45;
      const cx = x + Math.cos(ang) * rOff;
      const cz = z + Math.sin(ang) * rOff;
      const cy = canopyBaseY + canopyR * (0.35 + c * 0.38);
      const cs = canopyR * (c === 0 ? 1.05 : 0.75) * (0.85 + rand() * 0.3);
      euler.set(rand() * 0.6, rand() * Math.PI * 2, rand() * 0.6);
      q.setFromEuler(euler);
      m.compose(new THREE.Vector3(cx, cy, cz), q, new THREE.Vector3(cs, cs * 0.82, cs));
      foliageMesh.setMatrixAt(fi, m);
      col.setHex(TREE_LEAF_COLORS[Math.floor(rand() * TREE_LEAF_COLORS.length)]);
      col.offsetHSL(0, 0, (rand() - 0.5) * 0.08);
      foliageMesh.setColorAt(fi, col);
      fi++;
    }
  });

  trunkMesh.instanceMatrix.needsUpdate = true;
  foliageMesh.instanceMatrix.needsUpdate = true;
  if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;
  group.add(trunkMesh, foliageMesh);
  return group;
}

const TREE_TARGET_COUNT = 200;
function scatterTrees(data) {
  const bounds = data.bounds;
  const obstacles = [];
  for (const bd of data.buildings) {
    const area = polygonArea(bd.footprint);
    const c = polygonCentroid(bd.footprint);
    obstacles.push({ x: c.x, z: c.z, r: Math.sqrt(area / Math.PI) + 4 });
  }
  for (const poly of data.pitches || []) {
    const area = polygonArea(poly);
    const c = polygonCentroid(poly);
    obstacles.push({ x: c.x, z: c.z, r: Math.sqrt(area / Math.PI) + 2 });
  }
  const margin = 10;
  const spanX = bounds.maxX - bounds.minX + margin * 2;
  const spanZ = bounds.maxZ - bounds.minZ + margin * 2;
  let seed = 7;
  function rand() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }
  const placements = [];
  let tries = 0;
  const maxTries = TREE_TARGET_COUNT * 25;
  while (placements.length < TREE_TARGET_COUNT && tries < maxTries) {
    tries++;
    const x = bounds.minX - margin + rand() * spanX;
    const z = bounds.minZ - margin + rand() * spanZ;
    let blocked = false;
    for (const o of obstacles) {
      if (Math.hypot(x - o.x, z - o.z) < o.r) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const y = data.elevation ? terrainHeightAt(data.elevation, bounds, x, z) : 0;
    placements.push({ x, z, y, seed: Math.floor(rand() * 1e9) });
  }
  return buildTreesInstanced(placements);
}

// Main gate: placed at the campus boundary's westmost point, a reasonable stand-in for "near the
// road" since the exact road geometry isn't in our data. Two stone pillars plus a crossbeam and a
// thin arch cap, echoing the real school gate's silhouette without trying to render its carvings.
function buildGate(data) {
  const boundary = data.boundary;
  if (!boundary || boundary.length < 3) return null;
  let best = boundary[0];
  for (const p of boundary) if (p[0] < best[0]) best = p;

  const group = new THREE.Group();
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0xe9e3d2, roughness: 0.9 });
  const pillarGeo = new THREE.BoxGeometry(1.4, 7, 1.4);
  const left = new THREE.Mesh(pillarGeo, stoneMat);
  left.position.set(0, 3.5, -4.5);
  const right = new THREE.Mesh(pillarGeo, stoneMat);
  right.position.set(0, 3.5, 4.5);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 10.5), stoneMat);
  beam.position.set(0, 7.5, 0);
  const archMat = new THREE.MeshStandardMaterial({ color: 0xd8d0ba, roughness: 0.9 });
  const arch = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.3, 11), archMat);
  arch.position.set(0, 9, 0);
  [left, right, beam, arch].forEach((m) => {
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  });
  group.position.set(best[0] - 3, 0, best[1]);
  return group;
}

// 구령대 (review stand): a small raised platform with a short step, placed just off IVY관 as asked.
function buildReviewStand(ivyBuilding) {
  if (!ivyBuilding) return null;
  const group = new THREE.Group();
  const baseMat = new THREE.MeshStandardMaterial({ color: 0xb9b2a0, roughness: 1 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(5, 1, 3.2), baseMat);
  base.position.y = 0.5;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);
  const stepMat = new THREE.MeshStandardMaterial({ color: 0xa39c8a, roughness: 1 });
  const step = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.3, 1), stepMat);
  step.position.set(0, 0.15, 2.05);
  step.receiveShadow = true;
  group.add(step);
  const railMat = new THREE.MeshStandardMaterial({ color: 0x7a95a8, roughness: 0.6, metalness: 0.3 });
  for (const sx of [-2.3, 2.3]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 0.12), railMat);
    rail.position.set(sx, 1.45, -1.4);
    group.add(rail);
  }
  const xs = ivyBuilding.footprint.map((p) => p[0]);
  const zs = ivyBuilding.footprint.map((p) => p[1]);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const edgeZ = Math.max(...zs);
  group.position.set(midX, 0, edgeZ + 7);
  return group;
}

function makeBoundaryLine(points, y) {
  const pts = points.map(([x, z]) => new THREE.Vector3(x, y, z));
  pts.push(pts[0].clone());
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0xff6a2b, transparent: true, opacity: 0.55 });
  return new THREE.Line(geo, mat);
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function polygonCentroid(points) {
  let x = 0,
    z = 0;
  for (const p of points) {
    x += p[0];
    z += p[1];
  }
  return { x: x / points.length, z: z / points.length };
}

async function loadSchool(id) {
  loadingEl.classList.remove("hidden");
  const info = SCHOOLS.find((s) => s.id === id);
  const res = await fetch(info.file, { cache: "no-store" });
  const data = await res.json();

  if (sceneGroup) {
    scene.remove(sceneGroup);
    sceneGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  for (const d of debris) scene.remove(d.mesh);
  debris = [];
  for (const p of projectiles) scene.remove(p.mesh);
  projectiles = [];
  for (const ft of floatingTexts) ft.el.remove();
  floatingTexts = [];
  wobbles = [];
  for (const nl of nameLabels) nl.el.remove();
  nameLabels = [];
  messageQueue = [];
  messageShowing = false;
  destroyBannerEl.classList.remove("show");
  groundZeroBannerEl.classList.remove("show");
  dangerBannerEl.classList.remove("show");
  activeQuake = null;
  if (activeOrbital) {
    if (sceneGroup) scene.remove(activeOrbital.group);
    if (activeOrbital.light) scene.remove(activeOrbital.light);
    activeOrbital = null;
  }
  activeNukeCutscene = cleanupNukeCutscene(activeNukeCutscene);

  sceneGroup = new THREE.Group();
  buildings = [];
  score = 0;
  undoStack = [];
  updateScoreUI();
  updateUndoBtn();

  const groundRect = data.satRect || data.allBounds || data.bounds;
  const acx = (groundRect.minX + groundRect.maxX) / 2;
  const acz = (groundRect.minZ + groundRect.maxZ) / 2;
  sceneRadius = Math.max(groundRect.maxX - groundRect.minX, groundRect.maxZ - groundRect.minZ) / 2;

  const cb = data.bounds;
  const cx = (cb.minX + cb.maxX) / 2;
  const cz = (cb.minZ + cb.maxZ) / 2;
  campusRadius = Math.max(cb.maxX - cb.minX, cb.maxZ - cb.minZ) / 2 + 30;

  // terrain: a single heightmapped, satellite-textured mesh covering exactly the fetched photo's
  // footprint (no flat green plane beyond it) — flat under the campus itself (schoolyards are
  // leveled ground) and blending into the real hillside elevation outside it.
  const roofMats = [];
  const terrainMesh = buildTerrainMesh(data);
  if (terrainMesh) {
    groundMesh = terrainMesh;
    groundMesh.receiveShadow = true;
    sceneGroup.add(groundMesh);
    roofMats.push(groundMesh.material);
  } else {
    const groundGeo = new THREE.PlaneGeometry(sceneRadius * 2.6 + 200, sceneRadius * 2.6 + 200);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x5c8a4a, roughness: 1 });
    groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.position.set(acx, 0, acz);
    groundMesh.receiveShadow = true;
    sceneGroup.add(groundMesh);
  }
  if (data.satImage) {
    textureLoader.load(data.satImage, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      for (const m of roofMats) {
        m.map = tex;
        m.needsUpdate = true;
      }
    });
  }

  for (const poly of data.water || []) {
    sceneGroup.add(makeFlatShapeMesh(poly, 0x3a8fc0, 0.05));
  }
  if (data.boundary && data.boundary.length >= 3) {
    sceneGroup.add(makeBoundaryLine(data.boundary, 0.08));
  }

  for (const bd of data.buildings) {
    const destroyable = !!bd.destroyable;
    const mesh = buildBuildingMesh(bd, destroyable, data.satRect);
    if (mesh.userData.roofMat) roofMats.push(mesh.userData.roofMat);
    sceneGroup.add(mesh);
    const area = polygonArea(bd.footprint);
    const centroid = polygonCentroid(bd.footprint);
    const maxHp = buildingMaxHp(bd.height);
    buildings.push({
      id: bd.id,
      color: mesh.userData.color,
      name: bd.name,
      mesh,
      footprint: bd.footprint,
      height: bd.height,
      area,
      centroid,
      alive: true,
      destroyable,
      hp: maxHp,
      maxHp,
    });

    if (bd.name) {
      const el = document.createElement("div");
      el.className = "building-label";
      el.textContent = bd.name;
      document.body.appendChild(el);
      nameLabels.push({ el, building: buildings[buildings.length - 1] });
    }
  }

  sceneGroup.add(scatterTrees(data));
  const gate = buildGate(data);
  if (gate) sceneGroup.add(gate);
  const ivy = buildings.find((b) => b.name === "IVY관");
  const reviewStand = buildReviewStand(ivy);
  if (reviewStand) sceneGroup.add(reviewStand);

  scene.add(sceneGroup);

  const dist = campusRadius * 1.35;
  camera.position.set(cx + dist * 0.52, dist * 0.95, cz + dist * 0.52);
  controls.target.set(cx, 0, cz);
  controls.minDistance = campusRadius * 0.1;
  controls.maxDistance = sceneRadius * 1.8;
  controls.update();

  sunLight.position.set(acx + sceneRadius * 1.2, sceneRadius * 2.2, acz + sceneRadius * 0.6);
  sunLight.target.position.set(acx, 0, acz);
  sunLight.target.updateMatrixWorld();
  const scam = sunLight.shadow.camera;
  scam.left = -sceneRadius * 1.6;
  scam.right = sceneRadius * 1.6;
  scam.top = sceneRadius * 1.6;
  scam.bottom = -sceneRadius * 1.6;
  scam.near = 1;
  scam.far = sceneRadius * 6;
  scam.updateProjectionMatrix();

  // fog fades out before the terrain's edge (sceneRadius == half the fetched satellite photo's
  // extent) so the hard boundary of the baked ground never shows
  scene.fog = new THREE.Fog(0xaed4f0, sceneRadius * 1.5, sceneRadius * 2.4);

  updateBuildingStat();
  loadingEl.classList.add("hidden");
}

function updateScoreUI() {
  scoreValueEl.textContent = score.toLocaleString("ko-KR");
}
function updateBuildingStat() {
  const targets = buildings.filter((b) => b.destroyable);
  const alive = targets.filter((b) => b.alive).length;
  buildingStatEl.textContent = `건물 ${alive} / ${targets.length}`;
}
function updateUndoBtn() {
  btnUndo.style.opacity = undoStack.length ? "1" : "0.4";
}

function scoreForBuilding(b, mult = 1) {
  return Math.max(400, Math.round(b.area * b.height * 2.1 * mult));
}

// bigger/taller buildings take more hits to bring down (2-4 hp) so a single weapon use
// doesn't clear a building in one shot.
function buildingMaxHp(height) {
  return Math.max(2, Math.min(4, Math.round(height / 7) + 1));
}

function spawnFloatingScore(worldPos, amount) {
  const el = document.createElement("div");
  el.textContent = "+" + amount.toLocaleString("ko-KR");
  el.style.position = "fixed";
  el.style.zIndex = "20";
  el.style.color = "#ffb347";
  el.style.fontWeight = "900";
  el.style.fontSize = "16px";
  el.style.textShadow = "0 1px 4px rgba(0,0,0,0.6)";
  el.style.pointerEvents = "none";
  document.body.appendChild(el);
  floatingTexts.push({ el, worldPos: worldPos.clone(), start: performance.now() });
}

function updateFloatingTexts() {
  const now = performance.now();
  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const ft = floatingTexts[i];
    const t = (now - ft.start) / 1100;
    if (t >= 1) {
      ft.el.remove();
      floatingTexts.splice(i, 1);
      continue;
    }
    const pos = ft.worldPos.clone();
    pos.y += t * 18;
    const proj = pos.project(camera);
    const sx = (proj.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-proj.y * 0.5 + 0.5) * window.innerHeight;
    ft.el.style.left = sx + "px";
    ft.el.style.top = sy + "px";
    ft.el.style.opacity = String(1 - t);
    ft.el.style.transform = `translate(-50%, -50%) scale(${1 + t * 0.4})`;
  }
}

function updateNameLabels() {
  for (const nl of nameLabels) {
    const b = nl.building;
    if (!b.alive) {
      nl.el.style.display = "none";
      continue;
    }
    const pos = new THREE.Vector3(b.centroid.x, b.height + 2.5, b.centroid.z);
    const proj = pos.clone().project(camera);
    if (proj.z > 1) {
      nl.el.style.display = "none";
      continue;
    }
    nl.el.style.display = "block";
    nl.el.style.left = ((proj.x * 0.5 + 0.5) * window.innerWidth).toFixed(1) + "px";
    nl.el.style.top = ((-proj.y * 0.5 + 0.5) * window.innerHeight).toFixed(1) + "px";
  }
}

function triggerShake(magnitude, duration) {
  if (magnitude >= shakeState.magnitude || shakeState.time >= shakeState.duration) {
    shakeState = { time: 0, duration, magnitude };
  }
}

// ---------- destruction ----------
// Walks a coarse chunkCap³ grid over the building like before, but each coarse cell now shatters
// into 2-3 small, irregularly-sized/rotated shards instead of becoming one neat box — a hit reads
// as real rubble bursting apart rather than a handful of clean blocks calving off.
function fragmentBuilding(b, chunkCap) {
  const minX = Math.min(...b.footprint.map((p) => p[0]));
  const maxX = Math.max(...b.footprint.map((p) => p[0]));
  const minZ = Math.min(...b.footprint.map((p) => p[1]));
  const maxZ = Math.max(...b.footprint.map((p) => p[1]));
  const w = Math.max(2, maxX - minX);
  const d = Math.max(2, maxZ - minZ);

  const nx = Math.min(chunkCap, Math.max(1, Math.round(w / 6)));
  const nz = Math.min(chunkCap, Math.max(1, Math.round(d / 6)));
  const ny = Math.min(chunkCap, Math.max(1, Math.round(b.height / 6)));

  const cellW = w / nx;
  const cellD = d / nz;
  const cellH = b.height / ny;
  const color = new THREE.Color(b.color);

  const chunks = [];
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        const cx0 = minX + cellW * ix;
        const cz0 = minZ + cellD * iz;
        const cy0 = cellH * iy;
        const shardCount = 2 + Math.floor(Math.random() * 2);
        for (let s = 0; s < shardCount; s++) {
          const sw = (cellW / 1.6) * (0.5 + Math.random() * 0.7);
          const sh = (cellH / 1.6) * (0.5 + Math.random() * 0.7);
          const sd = (cellD / 1.6) * (0.5 + Math.random() * 0.7);
          const geo = new THREE.BoxGeometry(sw, sh, sd);
          const mat = new THREE.MeshStandardMaterial({
            color: color.clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.1),
            roughness: 0.92,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.rotation.set(Math.random() * 0.7, Math.random() * Math.PI, Math.random() * 0.7);
          mesh.position.set(cx0 + Math.random() * cellW, cy0 + Math.random() * cellH, cz0 + Math.random() * cellD);
          chunks.push({ mesh, half: new THREE.Vector3(sw / 2, sh / 2, sd / 2) });
        }
      }
    }
  }
  return chunks;
}

// Deals `dmg` hit points to a building's hp. Below 0 hp the building is fully gone (every
// remaining chunk breaks free, the solid mesh is hidden); above 0 it only "chips" — a handful of
// chunks proportional to the damage fraction fly off while the solid wall+roof mesh stays put, so
// a single hit doesn't visually clear the whole building either. Returns null if the building was
// already destroyed by an earlier action.
function damageBuilding(b, dmg, origin, cfg) {
  if (!b.alive) return null;
  const hpBefore = b.hp;
  b.hp = Math.max(0, b.hp - dmg);
  const fullyDestroyed = b.hp <= 0;

  const allChunks = fragmentBuilding(b, cfg.chunkCap || 3);
  let chosen;
  if (fullyDestroyed) {
    chosen = allChunks;
    b.alive = false;
    b.mesh.visible = false;
  } else {
    const frac = Math.min(1, (hpBefore - b.hp) / b.maxHp);
    const n = Math.max(1, Math.min(allChunks.length, Math.round(allChunks.length * frac)));
    for (let i = allChunks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allChunks[i], allChunks[j]] = [allChunks[j], allChunks[i]];
    }
    chosen = allChunks.slice(0, n);
    for (const c of allChunks.slice(n)) {
      c.mesh.geometry.dispose();
      c.mesh.material.dispose();
    }
  }

  const spawned = [];
  for (const c of chosen) {
    sceneGroup.add(c.mesh);
    const dir = new THREE.Vector3().subVectors(c.mesh.position, origin);
    dir.y += 6;
    // a bit of random jitter on top of the straight "away from the blast" direction so a burst of
    // same-origin shards doesn't all fly out along identical rays
    dir.x += (Math.random() - 0.5) * 4;
    dir.z += (Math.random() - 0.5) * 4;
    if (dir.lengthSq() < 0.01) dir.set((Math.random() - 0.5) || 1, 1, (Math.random() - 0.5) || 1);
    dir.normalize();
    const force = (cfg.forceMin + Math.random() * (cfg.forceMax - cfg.forceMin)) * (0.85 + Math.random() * 0.45);
    const vel = dir.multiplyScalar(force);
    vel.y += cfg.upMin + Math.random() * (cfg.upMax - cfg.upMin);
    const angVel = new THREE.Vector3(
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 14
    );
    const rec = { mesh: c.mesh, vel, angVel, half: c.half, settled: false, flyOff: false };
    debris.push(rec);
    spawned.push(rec);
  }
  return { spawned, fullyDestroyed, hpBefore, hpAfter: b.hp };
}

function removeDebrisRecords(recs) {
  if (!recs) return;
  for (const r of recs) {
    if (!r.isOriginal) {
      sceneGroup.remove(r.mesh);
      if (r.mesh.geometry) r.mesh.geometry.dispose();
      if (r.mesh.material && r.mesh.material.dispose) r.mesh.material.dispose();
    }
    const idx = debris.indexOf(r);
    if (idx >= 0) debris.splice(idx, 1);
  }
}

// A rough mushroom cloud: a rising stem plus two stacked puffed-out "cap" spheres, climbing and
// expanding together before fading — good enough at this game's camera distance without needing
// a real particle system.
function spawnMushroomCloud(point) {
  const group = new THREE.Group();
  group.position.set(point.x, point.y, point.z);
  sceneGroup.add(group);

  const stemMat = new THREE.MeshStandardMaterial({ color: 0x8a8378, transparent: true, opacity: 0.85, roughness: 1 });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(4, 7, 1, 16), stemMat);
  group.add(stem);

  const capMat = new THREE.MeshStandardMaterial({ color: 0xcfc6b8, transparent: true, opacity: 0.9, roughness: 1 });
  const cap1 = new THREE.Mesh(new THREE.SphereGeometry(10, 16, 12), capMat);
  const cap2 = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 12), capMat.clone());
  group.add(cap1, cap2);

  const start = performance.now();
  const life = 2200;
  function step() {
    const t = (performance.now() - start) / life;
    if (t >= 1) {
      sceneGroup.remove(group);
      [stem, cap1, cap2].forEach((m) => {
        m.geometry.dispose();
        m.material.dispose();
      });
      return;
    }
    const rise = t * 48;
    stem.scale.set(1 + t * 0.4, 1 + rise * 1.1, 1 + t * 0.4);
    stem.position.y = rise * 0.5;
    const capScale = 0.6 + t * 1.6;
    cap1.scale.setScalar(capScale);
    cap1.position.y = rise;
    cap2.scale.setScalar(capScale * 0.85);
    cap2.position.set(Math.sin(t * 6) * 3, rise + 5, Math.cos(t * 6) * 3);
    const fade = Math.max(0, 1 - Math.max(0, t - 0.5) / 0.5);
    stemMat.opacity = 0.8 * fade;
    capMat.opacity = 0.9 * fade;
    cap2.material.opacity = 0.9 * fade;
    requestAnimationFrame(step);
  }
  step();
}

function spawnFlash(point, color, radius, life) {
  const flash = new THREE.PointLight(color, 16, radius * 2.8, 2);
  flash.position.copy(point);
  flash.position.y += 4;
  sceneGroup.add(flash);

  // two rings at different speeds read as a sharper shockwave than one alone
  const ringGeo = new THREE.RingGeometry(0.1, 1, 48);
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(point);
  ring.position.y += 0.3;
  sceneGroup.add(ring);

  const ring2Mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
  const ring2 = new THREE.Mesh(ringGeo.clone(), ring2Mat);
  ring2.rotation.x = -Math.PI / 2;
  ring2.position.copy(point);
  ring2.position.y += 0.35;
  sceneGroup.add(ring2);

  // a bright core flash sphere that pops then collapses, for extra "pop" on impact
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.22, 14, 10), coreMat);
  core.position.copy(point);
  core.position.y += radius * 0.15 + 1;
  sceneGroup.add(core);

  const start = performance.now();
  function step() {
    const t = (performance.now() - start) / life;
    if (t >= 1) {
      sceneGroup.remove(ring);
      sceneGroup.remove(ring2);
      sceneGroup.remove(core);
      sceneGroup.remove(flash);
      ring.geometry.dispose();
      ring.material.dispose();
      ring2.geometry.dispose();
      ring2.material.dispose();
      core.geometry.dispose();
      core.material.dispose();
      return;
    }
    const s = 1 + t * radius * 0.95;
    ring.scale.set(s, s, s);
    ring.material.opacity = 0.95 * (1 - t);
    const s2 = 1 + Math.min(1, t * 1.6) * radius * 1.15;
    ring2.scale.set(s2, s2, s2);
    ring2.material.opacity = 0.8 * Math.max(0, 1 - t * 1.6);
    const coreT = Math.min(1, t * 4);
    core.scale.setScalar(1 + coreT * 1.6);
    core.material.opacity = Math.max(0, 1 - t * 3.2);
    flash.intensity = 16 * (1 - t) * (1 - t);
    requestAnimationFrame(step);
  }
  step();
}

// A generic cube-particle burst: used for explosion sparks (bright, fast) and dust puffs (muted,
// slow, affected more by gravity) alike — the caller's color/speed/life/gravityMult tell them apart.
function spawnParticleBurst(point, opts) {
  const {
    color = 0xffcc66,
    count = 14,
    speed = 18,
    spread = 1,
    size = 0.5,
    life = 700,
    gravityMult = 1,
    upBias = 0.5,
  } = opts || {};
  const recs = [];
  for (let i = 0; i < count; i++) {
    const s = size * (0.6 + Math.random() * 0.8);
    const geo = new THREE.BoxGeometry(s, s, s);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(point);
    sceneGroup.add(mesh);
    const dir = new THREE.Vector3((Math.random() - 0.5) * spread, Math.random() * upBias + 0.15, (Math.random() - 0.5) * spread).normalize();
    const vel = dir.multiplyScalar(speed * (0.5 + Math.random() * 0.7));
    const angVel = new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
    recs.push({ mesh, vel, angVel });
  }
  const start = performance.now();
  let last = start;
  function step() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - start) / life;
    if (t >= 1) {
      for (const r of recs) {
        sceneGroup.remove(r.mesh);
        r.mesh.geometry.dispose();
        r.mesh.material.dispose();
      }
      return;
    }
    for (const r of recs) {
      r.vel.y += GRAVITY * gravityMult * dt;
      r.mesh.position.addScaledVector(r.vel, dt);
      r.mesh.rotation.x += r.angVel.x * dt;
      r.mesh.rotation.y += r.angVel.y * dt;
      r.mesh.material.opacity = Math.max(0, 1 - t);
    }
    requestAnimationFrame(step);
  }
  step();
}

function explodeAt(point, weaponKey) {
  const cfg = WEAPONS[weaponKey];
  spawnFlash(point, cfg.flashColor, cfg.radius, 480 + cfg.radius * 2);
  triggerShake(cfg.shakeMag, cfg.shakeDur);
  freezeUntil = performance.now() + cfg.freeze;
  playBoom(Math.min(1, cfg.radius / 90));
  spawnParticleBurst(point, {
    color: cfg.ringColor,
    count: Math.round(14 + cfg.radius * 0.5),
    speed: 14 + cfg.radius * 0.35,
    spread: 1.3,
    size: 0.5 + cfg.radius * 0.015,
    life: 650 + cfg.radius * 6,
    upBias: 0.9,
  });
  spawnParticleBurst(point, {
    color: 0x9a938a,
    count: 10,
    speed: 4 + cfg.radius * 0.08,
    spread: 1,
    size: 0.9,
    life: 1100,
    gravityMult: 0.3,
    upBias: 1.1,
  });
  // small bright embers that linger and fall slower than the main spark burst, for extra sparkle
  spawnParticleBurst(point, {
    color: 0xffe9a8,
    count: Math.round(8 + cfg.radius * 0.3),
    speed: 6 + cfg.radius * 0.18,
    spread: 1.6,
    size: 0.28,
    life: 900 + cfg.radius * 4,
    gravityMult: 0.5,
    upBias: 1.4,
  });
  fovPunch(cfg.radius * 0.12, 220 + cfg.radius * 2);
  if (weaponKey === "nuke" || weaponKey === "meteor") {
    screenFlash(weaponKey === "nuke" ? "#ffffff" : "#ffb347", weaponKey === "nuke" ? 0.85 : 0.5, weaponKey === "nuke" ? 650 : 400);
  }
  if (weaponKey === "nuke") spawnMushroomCloud(point);

  const hits = [];
  let totalScore = 0;
  const allSpawned = [];
  for (const b of buildings) {
    if (!b.alive || !b.destroyable) continue;
    const dx = b.centroid.x - point.x;
    const dz = b.centroid.z - point.z;
    const dist = Math.hypot(dx, dz);
    const approxR = Math.sqrt(b.area / Math.PI);
    if (dist - approxR < cfg.radius) {
      const res = damageBuilding(b, cfg.damage, point, cfg);
      if (res) {
        hits.push({ id: b.id, hpBefore: res.hpBefore });
        allSpawned.push(...res.spawned);
        totalScore += Math.round(scoreForBuilding(b, cfg.scoreMult) * ((res.hpBefore - res.hpAfter) / b.maxHp));
        queueDestroyMessage(buildDestroyMessage(weaponKey, b.name, res.fullyDestroyed, res.hpAfter, b.maxHp));
      }
    }
  }
  if (hits.length) {
    score += totalScore;
    updateScoreUI();
    updateBuildingStat();
    spawnFloatingScore(new THREE.Vector3(point.x, 14, point.z), totalScore);
    undoStack.push({ hits, scoreDelta: totalScore, debrisRecs: allSpawned });
    updateUndoBtn();
  }
}

// nearest destroyable building to a point, named or not — used for the nuke's ground-zero label
function nearestBuildingName(point) {
  let best = null;
  let bestDist = Infinity;
  for (const b of buildings) {
    if (!b.destroyable) continue;
    const d = Math.hypot(b.centroid.x - point.x, b.centroid.z - point.z);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best ? best.name || null : null;
}

// 수류탄: 카메라 앞에서 포물선을 그리며 날아가 착지하면 바로 터진다 (투척형 무기)
function throwGrenade(point) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2c2c2c, roughness: 0.45 });
  const geo = new THREE.SphereGeometry(0.9, 12, 12);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const start = camera.position.clone().addScaledVector(dir, 3.5);
  start.y = Math.max(point.y + 1.5, camera.position.y - 4);
  mesh.position.copy(start);
  sceneGroup.add(mesh);
  projectiles.push({ kind: "throw", mesh, start: start.clone(), end: point.clone(), t0: performance.now(), duration: THROW_MS });
}

// 핵폭탄: 폭격기가 화면을 가로질러 날아오다 목표 상공에서 폭탄을 투하하는 컷신.
// 그라운드 제로 경고/위험 반경은 비행기가 접근하는 동안부터 미리 떠 있는다.
function buildPlaneMesh() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.55, metalness: 0.35 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.5, 8.5, 4, 8), bodyMat);
  body.rotation.z = Math.PI / 2;
  group.add(body);
  const wingMat = new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.65 });
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.3, 15), wingMat);
  wing.position.y = -0.1;
  group.add(wing);
  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.2, 5), wingMat);
  tailWing.position.set(-4, 0.5, 0);
  group.add(tailWing);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 0.3), wingMat);
  fin.position.set(-4, 1.5, 0);
  group.add(fin);
  group.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return group;
}

// 재로딩/전부복구 중간에 컷신이 끊길 때를 위한 공통 정리 함수 — 어느 단계에서 호출되어도 안전하게
// 비행기/폭탄/위험 반경/경고문을 전부 치운다.
function cleanupNukeCutscene(cs) {
  if (!cs) return null;
  if (cs.plane) {
    sceneGroup.remove(cs.plane);
    cs.plane.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
  }
  if (cs.bomb) {
    sceneGroup.remove(cs.bomb);
    cs.bomb.geometry.dispose();
    cs.bomb.material.dispose();
  }
  if (cs.ring) {
    sceneGroup.remove(cs.ring);
    cs.ring.geometry.dispose();
    cs.ring.material.dispose();
  }
  if (cs.fill) {
    sceneGroup.remove(cs.fill);
    cs.fill.geometry.dispose();
    cs.fill.material.dispose();
  }
  groundZeroBannerEl.classList.remove("show");
  return null;
}

function placeNukeFuse(point) {
  if (activeNukeCutscene) return;

  const radius = WEAPONS.nuke.radius;
  const ringGeo = new THREE.RingGeometry(radius * 0.97, radius, 64);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff2d2d, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(point.x, point.y + 0.12, point.z);
  sceneGroup.add(ring);

  const fillGeo = new THREE.CircleGeometry(radius, 64);
  const fillMat = new THREE.MeshBasicMaterial({ color: 0xff2d2d, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
  const fill = new THREE.Mesh(fillGeo, fillMat);
  fill.rotation.x = -Math.PI / 2;
  fill.position.set(point.x, point.y + 0.1, point.z);
  sceneGroup.add(fill);

  const name = nearestBuildingName(point);
  groundZeroBannerEl.textContent = `⚠ 그라운드 제로 : ${name || "미상 구역"} ⚠`;
  groundZeroBannerEl.classList.add("show");

  const planeAltitude = sceneRadius * 0.55 + 70;
  const span = sceneRadius * 2.4;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const startX = point.x - (dir * span) / 2;
  const endX = point.x + (dir * span) / 2;
  const flightDur = (span / 140) * 1000; // 대략 140 m/s로 화면을 가로지르는 시간

  const plane = buildPlaneMesh();
  plane.position.set(startX, planeAltitude, point.z);
  plane.rotation.y = dir > 0 ? 0 : Math.PI;
  sceneGroup.add(plane);
  playPlaneDrone(flightDur / 1000 + 0.3);

  activeNukeCutscene = {
    plane,
    bomb: null,
    ring,
    fill,
    point: point.clone(),
    startX,
    endX,
    planeAltitude,
    start: performance.now(),
    flightDur,
    dropFrac: 0.5, // 비행기가 목표 상공(point.x)을 지나는 순간 투하
    bombStart: 0,
    bombFromY: 0,
    bombDur: 850,
  };
}

// 매 프레임 비행→투하→낙하 단계를 진행시키고, 폭탄이 땅에 닿는 순간 기존 핵폭발 연출(explodeAt)로
// 넘긴다.
function updateNukeCutscene() {
  const cs = activeNukeCutscene;
  if (!cs) return;
  const now = performance.now();

  if (cs.plane) {
    const t = Math.min(1, (now - cs.start) / cs.flightDur);
    cs.plane.position.x = cs.startX + (cs.endX - cs.startX) * t;
    cs.plane.position.y = cs.planeAltitude + Math.sin(t * Math.PI) * 4;

    if (t >= cs.dropFrac && !cs.bomb) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x2c2c2c, roughness: 0.4, metalness: 0.2 });
      const geo = new THREE.CylinderGeometry(0.6, 0.85, 3.4, 10);
      const bomb = new THREE.Mesh(geo, mat);
      bomb.position.set(cs.point.x, cs.planeAltitude, cs.point.z);
      bomb.rotation.x = Math.PI / 2;
      bomb.castShadow = true;
      sceneGroup.add(bomb);
      cs.bomb = bomb;
      cs.bombStart = now;
      cs.bombFromY = cs.planeAltitude;
    }

    if (t >= 1) {
      sceneGroup.remove(cs.plane);
      cs.plane.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
      cs.plane = null;
    }
  }

  if (cs.bomb) {
    const bt = Math.min(1, (now - cs.bombStart) / cs.bombDur);
    const ease = bt * bt;
    cs.bomb.position.y = cs.bombFromY + (cs.point.y - cs.bombFromY) * ease;
    cs.bomb.rotation.z += 0.2;
    if (bt >= 1) {
      const point = cs.point;
      activeNukeCutscene = cleanupNukeCutscene(cs);
      explodeAt(point, "nuke");
    }
  }
}

function placeMeteor(point) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xff5522, emissive: 0xff3300, emissiveIntensity: 1.4, roughness: 0.5 });
  const geo = new THREE.SphereGeometry(4.2, 14, 14);
  const mesh = new THREE.Mesh(geo, mat);
  const startY = sceneRadius * 1.6 + 140;
  mesh.position.set(point.x, startY, point.z);
  mesh.castShadow = true;
  sceneGroup.add(mesh);
  const light = new THREE.PointLight(0xff5522, 4, 60, 2);
  mesh.add(light);
  // flame trail: a cone trailing opposite the fall direction (straight up, since the meteor
  // falls on -Y), kept non-rotating so it always reads as "behind" the meteor
  const trailMat = new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
  const trail = new THREE.Mesh(new THREE.ConeGeometry(2.6, 16, 10, 1, true), trailMat);
  trail.position.y = 9;
  mesh.add(trail);
  projectiles.push({ kind: "meteor", mesh, point: point.clone(), startY, start: performance.now(), duration: 700 });
}

function updateProjectiles() {
  const now = performance.now();
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    if (p.kind === "throw") {
      const t = Math.min(1, (now - p.t0) / p.duration);
      const pos = p.start.clone().lerp(p.end, t);
      pos.y += Math.sin(t * Math.PI) * 9;
      p.mesh.position.copy(pos);
      p.mesh.rotation.x += 0.4;
      p.mesh.rotation.z += 0.25;
      if (t >= 1) {
        sceneGroup.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        projectiles.splice(i, 1);
        explodeAt(p.end, "bomb");
      }
    } else if (p.kind === "meteor") {
      const t = Math.min(1, (now - p.start) / p.duration);
      const ease = t * t;
      p.mesh.position.y = p.startY * (1 - ease);
      if (t >= 1) {
        sceneGroup.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        projectiles.splice(i, 1);
        explodeAt(p.point, "meteor");
      }
    }
  }
}

// The quake plays out over EARTHQUAKE_DURATION_MS instead of landing all its damage in one
// instant: updateQuake() below delivers one damage pulse per EARTHQUAKE_TICK_MS, so buildings
// crumble gradually while the ground keeps shaking, rather than vanishing the moment it's clicked.
let activeQuake = null; // {point, start, nextTick}

function triggerEarthquake(point) {
  if (activeQuake) return;
  activeQuake = { point: point.clone(), start: performance.now(), nextTick: performance.now() };
  triggerShake(EARTHQUAKE.shakeMag, EARTHQUAKE_DURATION_MS / 1000);
  playRumble(EARTHQUAKE_DURATION_MS / 1000 + 0.3);
  playSiren();
  dangerBannerEl.textContent = "⚠ 지진 발생 ⚠";
  dangerBannerEl.classList.add("show");
  wobbleNearbyBackdrop(point);
}

function wobbleNearbyBackdrop(point) {
  for (const b of buildings) {
    if (b.destroyable || !b.mesh.visible) continue;
    const dist = Math.hypot(b.centroid.x - point.x, b.centroid.z - point.z);
    if (dist < EARTHQUAKE.wobbleRadius) {
      wobbles.push({ mesh: b.mesh, start: performance.now(), duration: EARTHQUAKE_TICK_MS + 250 });
    }
  }
}

function quakePulse(point) {
  for (let i = 0; i < 3; i++) {
    const dx = (Math.random() - 0.5) * EARTHQUAKE.radius * 1.4;
    const dz = (Math.random() - 0.5) * EARTHQUAKE.radius * 1.4;
    spawnParticleBurst(new THREE.Vector3(point.x + dx, 0.3, point.z + dz), {
      color: 0x8a7d66,
      count: 5,
      speed: 3,
      spread: 1,
      size: 0.5,
      life: 650,
      gravityMult: 0.25,
      upBias: 1.4,
    });
  }
  const hits = [];
  let totalScore = 0;
  const allSpawned = [];
  for (const b of buildings) {
    if (!b.alive || !b.destroyable) continue;
    const dist = Math.hypot(b.centroid.x - point.x, b.centroid.z - point.z);
    if (dist < EARTHQUAKE.radius) {
      const res = damageBuilding(b, EARTHQUAKE.damage, point, EARTHQUAKE);
      if (res) {
        hits.push({ id: b.id, hpBefore: res.hpBefore });
        allSpawned.push(...res.spawned);
        totalScore += Math.round(scoreForBuilding(b, EARTHQUAKE.scoreMult) * ((res.hpBefore - res.hpAfter) / b.maxHp));
        queueDestroyMessage(buildDestroyMessage("earthquake", b.name, res.fullyDestroyed, res.hpAfter, b.maxHp));
      }
    } else if (dist < EARTHQUAKE.wobbleRadius) {
      wobbles.push({ mesh: b.mesh, start: performance.now(), duration: EARTHQUAKE_TICK_MS + 250, baseRot: b.mesh.rotation.z });
    }
  }
  if (hits.length) {
    score += totalScore;
    updateScoreUI();
    updateBuildingStat();
    spawnFloatingScore(new THREE.Vector3(point.x, 14, point.z), totalScore);
    undoStack.push({ hits, scoreDelta: totalScore, debrisRecs: allSpawned });
    updateUndoBtn();
  }
}

function updateQuake() {
  if (!activeQuake) return;
  const now = performance.now();
  if (now - activeQuake.start >= EARTHQUAKE_DURATION_MS) {
    activeQuake = null;
    dangerBannerEl.classList.remove("show");
    return;
  }
  if (now >= activeQuake.nextTick) {
    activeQuake.nextTick = now + EARTHQUAKE_TICK_MS;
    quakePulse(activeQuake.point);
    wobbleNearbyBackdrop(activeQuake.point);
  }
}

function updateWobbles() {
  const now = performance.now();
  for (let i = wobbles.length - 1; i >= 0; i--) {
    const w = wobbles[i];
    const t = (now - w.start) / w.duration;
    if (t >= 1) {
      w.mesh.rotation.z = 0;
      wobbles.splice(i, 1);
      continue;
    }
    const decay = 1 - t;
    w.mesh.rotation.z = Math.sin(t * 40) * 0.035 * decay;
  }
}

// ---------- laser: orbital strike along a dragged path ----------
// 더 이상 한 점에서 회전하는 무기가 아니라, 사용자가 지도 위에 드래그한 경로를 따라 궤도에서
// 빔이 내리꽂히며 훑고 지나가는 방식. 시작점에서 끝점까지 LASER.speed(m/s)로 이동하며, 지나가는
// 길목에 있는 건물에 데미지를 준다.
let activeOrbital = null; // {start, end, skyY, dur, startTime, group, beam, halo, groundGlow, light, hitIds, lastSpark}

function startOrbitalLaser(startPoint, endPoint) {
  if (activeOrbital) return;
  const pathLen = Math.max(4, startPoint.distanceTo(endPoint));
  const dur = Math.max(450, (pathLen / LASER.speed) * 1000);
  const skyY = sceneRadius * 1.2 + 140;

  const group = new THREE.Group();
  const haloMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.22, side: THREE.DoubleSide });
  const halo = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 1, 14, 1, true), haloMat);
  group.add(halo);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0x9df3ff, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1, 12, 1, true), beamMat);
  group.add(beam);
  const groundGlowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
  const groundGlow = new THREE.Mesh(new THREE.SphereGeometry(2, 12, 12), groundGlowMat);
  group.add(groundGlow);
  sceneGroup.add(group);

  const light = new THREE.PointLight(0x22d3ee, 5, 60, 2);
  sceneGroup.add(light);

  activeOrbital = {
    start: startPoint.clone(),
    end: endPoint.clone(),
    skyY,
    dur,
    startTime: performance.now(),
    group,
    halo,
    beam,
    groundGlow,
    light,
    hitIds: new Set(),
    lastSpark: 0,
  };
  triggerShake(LASER.shakeMag, dur / 1000);
  playLaserZap();
}

function updateOrbitalLaser() {
  if (!activeOrbital) return;
  const now = performance.now();
  const t = Math.min(1, (now - activeOrbital.startTime) / activeOrbital.dur);
  const cur = activeOrbital.start.clone().lerp(activeOrbital.end, t);
  const h = Math.max(1, activeOrbital.skyY - cur.y);

  activeOrbital.beam.scale.y = h;
  activeOrbital.beam.position.set(cur.x, cur.y + h / 2, cur.z);
  activeOrbital.halo.scale.y = h;
  activeOrbital.halo.position.set(cur.x, cur.y + h / 2, cur.z);
  activeOrbital.groundGlow.position.set(cur.x, cur.y + 1, cur.z);
  activeOrbital.light.position.set(cur.x, cur.y + 3, cur.z);

  if (now - activeOrbital.lastSpark > 45) {
    activeOrbital.lastSpark = now;
    spawnParticleBurst(new THREE.Vector3(cur.x, cur.y + 0.5, cur.z), {
      color: 0xbdf4ff,
      count: 3,
      speed: 4,
      spread: 0.9,
      size: 0.3,
      life: 300,
      gravityMult: 0.12,
      upBias: 0.7,
    });
  }

  const hits = [];
  let totalScore = 0;
  const allSpawned = [];
  for (const b of buildings) {
    if (!b.alive || !b.destroyable || activeOrbital.hitIds.has(b.id)) continue;
    const dist = Math.hypot(b.centroid.x - cur.x, b.centroid.z - cur.z);
    if (dist > LASER.hitRadius) continue;
    activeOrbital.hitIds.add(b.id);
    const res = damageBuilding(b, LASER.damage, cur, LASER);
    if (res) {
      hits.push({ id: b.id, hpBefore: res.hpBefore });
      allSpawned.push(...res.spawned);
      totalScore += Math.round(scoreForBuilding(b, LASER.scoreMult) * ((res.hpBefore - res.hpAfter) / b.maxHp));
      queueDestroyMessage(buildDestroyMessage("laser", b.name, res.fullyDestroyed, res.hpAfter, b.maxHp));
    }
  }
  if (hits.length) {
    score += totalScore;
    updateScoreUI();
    updateBuildingStat();
    spawnFloatingScore(new THREE.Vector3(cur.x, 14, cur.z), totalScore);
    undoStack.push({ hits, scoreDelta: totalScore, debrisRecs: allSpawned });
    updateUndoBtn();
  }

  if (t >= 1) {
    sceneGroup.remove(activeOrbital.group);
    sceneGroup.remove(activeOrbital.light);
    activeOrbital.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
    activeOrbital = null;
  }
}

function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    if (d.settled) continue;
    d.vel.y += GRAVITY * dt;
    d.mesh.position.addScaledVector(d.vel, dt);
    d.mesh.rotation.x += d.angVel.x * dt;
    d.mesh.rotation.y += d.angVel.y * dt;
    d.mesh.rotation.z += d.angVel.z * dt;

    const groundY = d.half.y;
    if (d.mesh.position.y <= groundY) {
      d.mesh.position.y = groundY;
      d.vel.y *= -0.28;
      d.vel.x *= 0.65;
      d.vel.z *= 0.65;
      d.angVel.multiplyScalar(0.6);
      if (Math.abs(d.vel.y) < 1.2 && d.vel.length() < 2.5) {
        d.vel.set(0, 0, 0);
        d.angVel.set(0, 0, 0);
        d.settled = true;
      }
    }

    if (d.flyOff) {
      const distFromCenter = Math.hypot(d.mesh.position.x - controls.target.x, d.mesh.position.z - controls.target.z);
      if (distFromCenter > sceneRadius * DEBRIS_DESPAWN_DIST_MULT) {
        if (d.isOriginal) {
          d.mesh.visible = false;
        } else {
          sceneGroup.remove(d.mesh);
          d.mesh.geometry.dispose();
          d.mesh.material.dispose();
        }
        debris.splice(i, 1);
      }
    }
  }
}

// ---------- undo / restore ----------
function undo() {
  const action = undoStack.pop();
  if (!action) return;
  for (const hit of action.hits) {
    const b = buildings.find((x) => x.id === hit.id);
    if (b) {
      b.hp = hit.hpBefore;
      b.alive = true;
      b.mesh.visible = true;
      b.mesh.position.set(0, 0, 0);
      b.mesh.rotation.set(0, 0, 0);
    }
  }
  removeDebrisRecords(action.debrisRecs);
  score = Math.max(0, score - action.scoreDelta);
  updateScoreUI();
  updateBuildingStat();
  updateUndoBtn();
}

function restoreAll() {
  for (const b of buildings) {
    b.hp = b.maxHp;
    b.alive = true;
    b.mesh.visible = true;
    b.mesh.position.set(0, 0, 0);
    b.mesh.rotation.set(0, 0, 0);
  }
  for (const d of debris) {
    if (d.isOriginal) continue;
    sceneGroup.remove(d.mesh);
    d.mesh.geometry.dispose();
    d.mesh.material.dispose();
  }
  debris = [];
  for (const p of projectiles) {
    sceneGroup.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
  }
  projectiles = [];
  groundZeroBannerEl.classList.remove("show");
  dangerBannerEl.classList.remove("show");
  activeQuake = null;
  if (activeOrbital) {
    scene.remove(activeOrbital.group);
    if (activeOrbital.light) scene.remove(activeOrbital.light);
    activeOrbital = null;
  }
  activeNukeCutscene = cleanupNukeCutscene(activeNukeCutscene);
  undoStack = [];
  score = 0;
  updateScoreUI();
  updateBuildingStat();
  updateUndoBtn();
}

// ---------- input ----------
function setWeapon(w) {
  activeWeapon = w;
  for (const btn of weaponButtons) {
    btn.classList.toggle("active", btn.dataset.weapon === w);
  }
  if (HINTS[w]) hintEl.textContent = HINTS[w];
}
for (const btn of weaponButtons) {
  btn.addEventListener("click", () => setWeapon(btn.dataset.weapon));
}

function ndcFromEvent(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
}

function raycastGroundPoint(ev) {
  raycaster.setFromCamera(ndcFromEvent(ev), camera);
  const targets = [groundMesh, ...buildings.map((b) => b.mesh)];
  const hits = raycaster.intersectObjects(targets, true);
  return hits.length ? hits[0].point : null;
}

renderer.domElement.addEventListener("click", (ev) => {
  if (activeWeapon === "look" || activeWeapon === "laser") return;
  const point = raycastGroundPoint(ev);
  if (!point) return;

  if (activeWeapon === "bomb") {
    ensureAudio();
    throwGrenade(point);
  } else if (activeWeapon === "nuke") {
    ensureAudio();
    placeNukeFuse(point);
  } else if (activeWeapon === "meteor") {
    ensureAudio();
    placeMeteor(point);
  } else if (activeWeapon === "earthquake") {
    ensureAudio();
    triggerEarthquake(point);
  }
});

// ---------- laser: click-and-drag to draw the orbital strike's path ----------
let laserDrag = null; // {startPoint, line}

function clearLaserDragLine() {
  if (!laserDrag) return;
  sceneGroup.remove(laserDrag.line);
  laserDrag.line.geometry.dispose();
  laserDrag.line.material.dispose();
  laserDrag = null;
}

renderer.domElement.addEventListener("pointerdown", (ev) => {
  if (activeWeapon !== "laser") return;
  const point = raycastGroundPoint(ev);
  if (!point) return;
  ensureAudio();
  controls.enabled = false;
  const p0 = point.clone();
  p0.y += 0.6;
  const lineGeo = new THREE.BufferGeometry().setFromPoints([p0, p0.clone()]);
  const lineMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(lineGeo, lineMat);
  sceneGroup.add(line);
  laserDrag = { startPoint: point.clone(), line };
});

renderer.domElement.addEventListener("pointermove", (ev) => {
  if (!laserDrag) return;
  const point = raycastGroundPoint(ev);
  if (!point) return;
  const pos = laserDrag.line.geometry.attributes.position;
  pos.setXYZ(1, point.x, point.y + 0.6, point.z);
  pos.needsUpdate = true;
});

window.addEventListener("pointerup", (ev) => {
  if (!laserDrag) return;
  const point = raycastGroundPoint(ev) || laserDrag.startPoint;
  const start = laserDrag.startPoint;
  clearLaserDragLine();
  controls.enabled = true;
  startOrbitalLaser(start, point);
});

window.addEventListener("keydown", (ev) => {
  const map = { 0: "look", 1: "bomb", 2: "laser", 3: "meteor", 4: "earthquake", 5: "nuke" };
  if (map[ev.key]) setWeapon(map[ev.key]);
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    undo();
  }
});

btnUndo.addEventListener("click", undo);
btnRestore.addEventListener("click", restoreAll);
schoolSelect.addEventListener("change", () => loadSchool(schoolSelect.value));

// ---------- main loop ----------
let lastTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  let dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  if (now < freezeUntil) dt *= 0.08;

  controls.update();

  if (shakeState.time < shakeState.duration) {
    shakeState.time += dt;
    const remain = 1 - shakeState.time / shakeState.duration;
    const m = shakeState.magnitude * remain * remain;
    camera.position.x += (Math.random() - 0.5) * m;
    camera.position.y += (Math.random() - 0.5) * m * 0.6;
    camera.position.z += (Math.random() - 0.5) * m;
    // the camera jitter above moves the 3D view; this additionally shoves the whole rendered
    // canvas around in 2D screen space on top of it, which reads as a much more unmistakable
    // "the screen itself is shaking" effect than camera jitter alone (most noticeable during
    // 지진, whose shakeMag is by far the largest).
    canvasWrapEl.style.transform = `translate(${(Math.random() - 0.5) * m * 2.2}px, ${(Math.random() - 0.5) * m * 2.2}px)`;
  } else if (canvasWrapEl.style.transform) {
    canvasWrapEl.style.transform = "";
  }

  updateProjectiles();
  updateDebris(dt);
  updateFloatingTexts();
  updateWobbles();
  updateNameLabels();
  updateQuake();
  updateOrbitalLaser();
  updateNukeCutscene();

  renderer.render(scene, camera);
}

schoolSelect.value = SCHOOLS[0].id;
loadSchool(SCHOOLS[0].id).then(() => {
  animate();
});
