/* =========================================================
   Parametric Heart Typesetter — canvas engine
   x(t) = 16 sin³t
   y(t) = 13 cos t − 5 cos 2t − 2 cos 3t − cos 4t
   Phase 1 TRACE : arc-length walk along the curve (and inset rings),
                   laying phrase runs tangent to the path.
   Phase 2 FILL  : seeded rejection sampling inside the innermost ring,
                   AABB collision via spatial hash.
   ========================================================= */
'use strict';

/* ---------------- constants ---------------- */
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const ACCENT = '#e11d48';
const FONT_STACK = '"Inter", "Noto Sans Devanagari", "Noto Sans Bengali", "Noto Sans KR", "Noto Sans JP", "Noto Sans SC", system-ui, sans-serif';
const SAMPLES = 1440;          // curve samples over [0, 2π]
const HEART_AREA = 180 * Math.PI; // ∮ x dy, exact
const PERIM_GAP = 7;           // px between perimeter runs
const MAX_ATTEMPTS = 48;       // placement attempts per interior word
const SAT_LIMIT = 30;          // consecutive failed words ⇒ saturated
const LINE_H = 1.3;            // em box height factor for collision

const $ = (s, r = document) => r.querySelector(s);

/* ---------------- corpus ---------------- */
let uid = 0;
const mk = (code, lang, script, text, custom = false) =>
  ({ id: ++uid, code, lang, script, text, enabled: true, rw: true, rs: true, rt: true, custom });

const DEFAULT_CORPUS = [
  ['en', 'English', 'Latin', 'I love you'],
  ['fr', 'French', 'Latin', 'Je t’aime'],
  ['es', 'Spanish', 'Latin', 'Te quiero'],
  ['pt', 'Portuguese', 'Latin', 'Eu te amo'],
  ['it', 'Italian', 'Latin', 'Ti amo'],
  ['de', 'German', 'Latin', 'Ich liebe dich'],
  ['pl', 'Polish', 'Latin', 'Kocham cię'],
  ['tr', 'Turkish', 'Latin', 'Seni seviyorum'],
  ['vi', 'Vietnamese', 'Latin', 'Anh yêu em'],
  ['sw', 'Swahili', 'Latin', 'Nakupenda'],
  ['ru', 'Russian', 'Cyrillic', 'Я тебя люблю'],
  ['uk', 'Ukrainian', 'Cyrillic', 'Я тебе кохаю'],
  ['bg', 'Bulgarian', 'Cyrillic', 'Обичам те'],
  ['sr', 'Serbian', 'Cyrillic', 'Волим те'],
  ['el', 'Greek', 'Greek', 'Σ’ αγαπώ'],
  ['hi', 'Hindi', 'Devanagari', 'मैं तुमसे प्यार करता हूँ'],
  ['mr', 'Marathi', 'Devanagari', 'मी तुझ्यावर प्रेम करतो'],
  ['ne', 'Nepali', 'Devanagari', 'म तिमीलाई माया गर्छु'],
  ['bn', 'Bengali', 'Bengali', 'আমি তোমাকে ভালোবাসি'],
  ['zh-Hans', 'Mandarin', 'Han', '我爱你'],
  ['zh-Hant', 'Cantonese', 'Han', '我愛你'],
  ['ja', 'Japanese', 'Kana', '愛してる'],
  ['ko', 'Korean', 'Hangul', '사랑해'],
];
const buildDefault = () => DEFAULT_CORPUS.map(r => mk(...r));
let corpus = buildDefault();

const SCRIPT_TESTS = [
  ['Devanagari', /\p{Script=Devanagari}/u], ['Bengali', /\p{Script=Bengali}/u],
  ['Tamil', /\p{Script=Tamil}/u], ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u], ['Hangul', /\p{Script=Hangul}/u],
  ['Kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ['Han', /\p{Script=Han}/u],
  ['Arabic', /\p{Script=Arabic}/u], ['Hebrew', /\p{Script=Hebrew}/u],
  ['Thai', /\p{Script=Thai}/u], ['Latin', /\p{Script=Latin}/u],
];
const detectScript = s => (SCRIPT_TESTS.find(([, re]) => re.test(s)) || ['Other'])[0];

/* crimson monochrome ramp, H≈347° */
const TONES = [
  { id: '900', hex: '#881337', on: false },
  { id: '800', hex: '#9f1239', on: true },
  { id: '700', hex: '#be123c', on: true },
  { id: '600', hex: '#e11d48', on: true },
  { id: '500', hex: '#f43f5e', on: true },
  { id: '400', hex: '#fb7185', on: true },
  { id: '300', hex: '#fda4af', on: true, light: true },
  { id: '200', hex: '#fecdd3', on: false, light: true },
];

/* ---------------- parameters ---------------- */
const params = {
  delay: 16, batch: 4,
  scale: 0.92, rings: 2, ringGap: 16, tangent: true,
  density: 900, jitter: 0, seed: 1402,
  sizeMin: 8, sizeMax: 14,
  showGrid: true, showGuide: true, showBoundary: false, showPen: true,
};

/* ---------------- PRNG ---------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeDeck(pool, rng) { // shuffled draw without repeats per cycle
  let d = [];
  return () => {
    if (!d.length) {
      d = pool.slice();
      for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    }
    return d.pop();
  };
}

/* ---------------- curve ---------------- */
const heartXY = t => {
  const s = Math.sin(t);
  return [16 * s * s * s, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)];
};
const CURVE = (() => {
  const pts = []; let s = 0, px = 0, py = 0, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = (i / SAMPLES) * TAU; const [x, y] = heartXY(t);
    if (i) s += Math.hypot(x - px, y - py);
    pts.push({ t, x, y, s }); px = x; py = y;
    ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  return { pts, L: s, ymin, ymax };
})();
const YC = (CURVE.ymin + CURVE.ymax) / 2;

function sampleAt(sU) { // arc length (units) → interpolated sample
  const p = CURVE.pts; sU = Math.max(0, Math.min(CURVE.L, sU));
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].s < sU) lo = m; else hi = m; }
  const a = p[lo], b = p[hi], k = b.s - a.s ? (sU - a.s) / (b.s - a.s) : 0;
  return { t: a.t + (b.t - a.t) * k, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, i: lo };
}

/* ---------------- view ---------------- */
const V = { W: 0, H: 0, dpr: 1, cx: 0, cy: 0, u: 1 };
const toPx = (x, y, f = 1) => [V.cx + x * f * V.u, V.cy - (y - YC) * f * V.u];
const toUnits = (px, py) => [(px - V.cx) / V.u, YC + (V.cy - py) / V.u];
const ringF = k => Math.max(0.12, 1 - (k * params.ringGap) / (V.u * 14));

/* ---------------- canvases ---------------- */
const stage = $('#stage'), sctx = stage.getContext('2d');
const layer = document.createElement('canvas'), lctx = layer.getContext('2d');
const base = document.createElement('canvas'), bctx = base.getContext('2d');
const hit = document.createElement('canvas'), hctx = hit.getContext('2d');
const wrap = $('#stageWrap');

/* ---------------- spatial hash ---------------- */
class SpatialHash {
  constructor(cell) { this.c = cell; this.m = new Map(); }
  _range(b) { const c = this.c; return [Math.floor(b[0] / c), Math.floor(b[1] / c), Math.floor(b[2] / c), Math.floor(b[3] / c)]; }
  insert(it) {
    const [i0, j0, i1, j1] = this._range(it.box);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = i + ',' + j; let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(it);
    }
  }
  overlaps(b) {
    const [i0, j0, i1, j1] = this._range(b);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = this.m.get(i + ',' + j); if (!a) continue;
      for (const it of a) { const o = it.box; if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true; }
    }
    return false;
  }
  at(px, py) {
    const a = this.m.get(Math.floor(px / this.c) + ',' + Math.floor(py / this.c)); if (!a) return null;
    for (let n = a.length - 1; n >= 0; n--) {
      const it = a[n], dx = px - it.x, dy = py - it.y, c = Math.cos(it.ang), s = Math.sin(it.ang);
      if (Math.abs(dx * c + dy * s) <= it.w / 2 && Math.abs(-dx * s + dy * c) <= it.h / 2) return it;
    }
    return null;
  }
}

/* ---------------- typography helpers ---------------- */
const fontStr = (w, s) => `${w} ${s}px ${FONT_STACK}`;
const mCache = new Map();
function measure(text, w, s) {
  const k = w + '|' + s + '|' + text; let v = mCache.get(k);
  if (v === undefined) { hctx.font = fontStr(w, s); v = hctx.measureText(text).width; mCache.set(k, v); }
  return v;
}
const activePool = () => corpus.filter(p => p.enabled);
const activeTones = () => TONES.filter(t => t.on).map(t => t.hex);

function styleFor(ph, rng) {
  // consume a fixed number of draws regardless of toggles → stable sequences
  const r1 = rng(), r2 = rng(), r3 = rng();
  const lo = Math.min(params.sizeMin, params.sizeMax), hi = Math.max(params.sizeMin, params.sizeMax);
  const tones = activeTones();
  return {
    size: ph.rs ? lo + Math.floor(r1 * (hi - lo + 1)) : Math.round((lo + hi) / 2),
    weight: ph.rw ? (r2 < 0.5 ? 400 : 700) : 400,
    color: ph.rt && tones.length ? tones[Math.floor(r3 * tones.length)] : ACCENT,
  };
}
function aabb(x, y, w, h, a) {
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hw = (w * c + h * s) / 2, hh = (w * s + h * c) / 2;
  return [x - hw, y - hh, x + hw, y + hh];
}
function corners(x, y, w, h, a) {
  const c = Math.cos(a), s = Math.sin(a), hw = w / 2, hh = h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
}
function makeItem(ph, st, x, y, ang, w, kind, extra) {
  const h = st.size * LINE_H;
  const it = { ph, text: ph.text, size: st.size, weight: st.weight, color: st.color, font: fontStr(st.weight, st.size), x, y, ang, w, h, kind, ...extra };
  it.box = aabb(x, y, w, h, ang);
  return it;
}
function drawItem(ctx, it) {
  ctx.save();
  ctx.translate(it.x, it.y); if (it.ang) ctx.rotate(it.ang);
  ctx.font = it.font; ctx.fillStyle = it.color;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(it.text, 0, 0);
  ctx.restore();
}
const polyPath = pts => { const p = new Path2D(); pts.forEach(([x, y], i) => i ? p.lineTo(x, y) : p.moveTo(x, y)); p.closePath(); return p; };

/* ---------------- layout (deterministic from params) ---------------- */
const G = { rings: [], inner: null, queue: [] };

function computeLayout() {
  V.u = params.scale * Math.min(V.W / 35, V.H / 31.5);
  V.cx = V.W / 2; V.cy = V.H / 2;
  G.rings = [];
  for (let k = 0; k < params.rings; k++) {
    const f = ringF(k);
    const pts = CURVE.pts.map(p => toPx(p.x, p.y, f));
    G.rings.push({ f, pts, path: polyPath(pts), Lpx: CURVE.L * V.u * f });
  }
  const fi = ringF(params.rings - 0.35);
  const ipts = [];
  for (let i = 0; i < CURVE.pts.length; i += 4) { const p = CURVE.pts[i]; ipts.push(toPx(p.x, p.y, fi)); }
  const xs = ipts.map(p => p[0]), ys = ipts.map(p => p[1]);
  G.inner = { f: fi, path: polyPath(ipts), bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  drawBase();
  buildPerimQueue();
}

function buildPerimQueue() {
  const q = []; G.queue = q;
  const pool = activePool(); if (!pool.length) return;
  const rng = mulberry32(params.seed >>> 0), deck = makeDeck(pool, rng);
  G.rings.forEach((ring, k) => {
    const sc = V.u * ring.f; let d = PERIM_GAP / 2;
    for (let guard = 0; guard < 4000; guard++) {
      let ph = null, st, w;
      for (let tries = 0; tries < 6 && !ph; tries++) {
        const c = deck(), cs = styleFor(c, rng), cw = measure(c.text, cs.weight, cs.size);
        if (d + cw <= ring.Lpx - PERIM_GAP / 2) { ph = c; st = cs; w = cw; }
      }
      if (!ph) break;
      const a = sampleAt(d / sc), b = sampleAt((d + w) / sc);
      const [ax, ay] = toPx(a.x, a.y, ring.f), [bx, by] = toPx(b.x, b.y, ring.f);
      let ang = params.tangent ? Math.atan2(by - ay, bx - ax) : 0;
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI; // keep upright
      q.push(makeItem(ph, st, (ax + bx) / 2, (ay + by) / 2, ang, w, 'perimeter',
        { ring: k, iEnd: b.i, tEnd: b.t, ux: b.x * ring.f, uy: YC + (b.y - YC) * ring.f, n: q.length + 1 }));
      d += w + PERIM_GAP;
    }
  });
}

function drawBase() {
  bctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  bctx.fillStyle = '#09090b'; bctx.fillRect(0, 0, V.W, V.H);
  if (!params.showGrid) return;
  const u = V.u, step = u >= 12 ? 1 : 2;
  const kx = Math.ceil(V.W / 2 / u) + 1;
  const [, oy] = toPx(0, 0);
  const ky0 = Math.floor(-oy / u) - 1, ky1 = Math.ceil((V.H - oy) / u) + 1;
  bctx.lineWidth = 1;
  for (let i = -kx; i <= kx; i += step) {
    const x = Math.round(V.cx + i * u) + 0.5;
    bctx.strokeStyle = i === 0 ? '#27272a' : i % 4 === 0 ? '#18181b' : '#111114';
    bctx.beginPath(); bctx.moveTo(x, 0); bctx.lineTo(x, V.H); bctx.stroke();
  }
  for (let j = ky0; j <= ky1; j += step) {
    const y = Math.round(oy + j * u) + 0.5;
    bctx.strokeStyle = j === 0 ? '#27272a' : j % 4 === 0 ? '#18181b' : '#111114';
    bctx.beginPath(); bctx.moveTo(0, y); bctx.lineTo(V.W, y); bctx.stroke();
  }
  bctx.font = '9px "JetBrains Mono", monospace'; bctx.fillStyle = '#52525b';
  bctx.textAlign = 'center'; bctx.textBaseline = 'top';
  for (let i = -kx; i <= kx; i++) if (i && i % 4 === 0) bctx.fillText(String(i), V.cx + i * u, oy + 4);
  bctx.textAlign = 'left'; bctx.textBaseline = 'middle';
  for (let j = ky0; j <= ky1; j++) if (j && j % 4 === 0) bctx.fillText(String(-j), V.cx + 4, oy + j * u);
  // bounding extents ticks
  bctx.fillStyle = '#3f3f46';
  const [, yTop] = toPx(0, CURVE.ymax), [, yBot] = toPx(0, CURVE.ymin);
  bctx.fillText(`y=${CURVE.ymax.toFixed(2)}`, V.cx + 16.6 * u, yTop);
  bctx.fillText(`y=${CURVE.ymin.toFixed(0)}`, V.cx + 16.6 * u, yBot);
}

/* ---------------- animation state ---------------- */
const S = {
  playing: false, phase: 'IDLE',
  ticks: 0, raf: 0, elapsed: 0, lastTs: 0, lastTickAt: 0,
  fps: 0, fpsFrames: 0, fpsT: 0, tickWindow: [],
  perimIndex: 0, interior: 0, processed: 0, attempts: 0, accepted: 0, consecFail: 0,
  items: [], ink: 0, lastItem: null, saturated: false,
  grid: null, frng: null, fdeck: null,
};
let needsRebuild = true;
let hover = null;

function resetPlacement() {
  S.items = []; S.grid = new SpatialHash(28);
  lctx.save(); lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, layer.width, layer.height); lctx.restore();
  Object.assign(S, { perimIndex: 0, interior: 0, processed: 0, attempts: 0, accepted: 0, consecFail: 0, ink: 0, lastItem: null, saturated: false });
  S.frng = mulberry32((params.seed ^ 0x9E3779B9) >>> 0);
  const pool = activePool();
  S.fdeck = pool.length ? makeDeck(pool, S.frng) : null;
  hover = null;
}

function commit(it) {
  S.items.push(it); S.grid.insert(it); drawItem(lctx, it);
  S.ink += it.w * it.h; S.lastItem = it;
}

function tryInterior() {
  S.processed++;
  const ph = S.fdeck(), st = styleFor(ph, S.frng);
  const w = measure(ph.text, st.weight, st.size), h = st.size * LINE_H;
  const bb = G.inner.bb;
  for (let a = 0; a < MAX_ATTEMPTS; a++) {
    S.attempts++;
    const x = bb[0] + S.frng() * (bb[2] - bb[0]);
    const y = bb[1] + S.frng() * (bb[3] - bb[1]);
    const ang = params.jitter ? (S.frng() * 2 - 1) * params.jitter * DEG : 0;
    const box = aabb(x, y, w + 4, h, ang);
    if (S.grid.overlaps(box)) continue;
    if (!corners(x, y, w, h * 0.8, ang).every(([cx, cy]) => hctx.isPointInPath(G.inner.path, cx, cy))) continue;
    const [ux, uy] = toUnits(x, y);
    const it = makeItem(ph, st, x, y, ang, w, 'interior', { n: S.interior + 1, ux, uy });
    it.box = box;
    commit(it); S.interior++; S.accepted++; S.consecFail = 0;
    return true;
  }
  S.consecFail++;
  return false;
}

function setPhase(p, silent, msg) {
  S.phase = p;
  if (!silent) log(msg || `phase → ${p}`, 'phase');
}

function finish(reason, silent) {
  setPhase('DONE', silent, `DONE · ${reason}`);
  S.playing = false;
}

/** Advances one glyph-run (perimeter run or interior word). */
function advanceOne(silent) {
  if (S.phase === 'IDLE') setPhase('TRACE', silent, `TRACE · ${G.queue.length} runs across ${params.rings} ring(s)`);
  if (S.phase === 'TRACE') {
    if (S.perimIndex < G.queue.length) commit(G.queue[S.perimIndex++]);
    if (S.perimIndex >= G.queue.length) {
      setPhase('FILL', silent, `FILL · target ${params.density} words, frame ${S.ticks}`);
      if (S.interior >= params.density) finish('interior target is 0', silent);
    }
    return true;
  }
  if (S.phase === 'FILL') {
    if (!S.fdeck || S.interior >= params.density) { finish(`target ${params.density} reached`, silent); return false; }
    tryInterior();
    if (S.consecFail >= SAT_LIMIT) { S.saturated = true; finish(`saturated at ${S.interior} words`, silent); return false; }
    if (S.interior >= params.density) { finish(`target ${params.density} reached`, silent); return false; }
    return true;
  }
  return false;
}

function tick() {
  if (S.phase === 'DONE') return;
  if (!activePool().length) { pause(); log('no active phrases — enable at least one', 'warn'); return; }
  for (let i = 0; i < params.batch; i++) if (!advanceOne(false)) break;
  S.ticks++;
  S.tickWindow.push(performance.now());
}

/** Re-layout from params, then deterministically fast-forward to the prior progress. */
function rebuild() {
  needsRebuild = false;
  const prev = { phase: S.phase, perim: S.perimIndex, proc: S.processed, ticks: S.ticks, playing: S.playing };
  computeLayout(); resetPlacement();
  S.phase = 'IDLE';
  if (prev.phase !== 'IDLE' && activePool().length) {
    S.phase = 'TRACE';
    const target = prev.phase === 'TRACE' ? prev.perim : Infinity;
    while (S.phase === 'TRACE' && S.perimIndex < target) advanceOne(true);
    if (prev.phase !== 'TRACE') {
      const t0 = performance.now();
      while (S.phase === 'FILL' && S.processed < prev.proc && performance.now() - t0 < 600) advanceOne(true);
    }
  }
  S.ticks = prev.ticks;
  S.playing = prev.playing && S.phase !== 'DONE';
  syncTransport();
  updateStaticReadouts();
}
const scheduleRebuild = () => { needsRebuild = true; };

/* ---------------- transport ---------------- */
function play() {
  if (!activePool().length) { log('no active phrases — enable at least one', 'warn'); return; }
  if (S.phase === 'DONE') resetRun(true);
  S.playing = true; S.lastTickAt = 0;
  log(`play · delay ${params.delay} ms, ${params.batch} run(s)/frame`);
  syncTransport();
}
function pause() {
  if (!S.playing) return;
  S.playing = false; log(`pause · frame ${S.ticks}`); syncTransport();
}
function step() {
  if (S.phase === 'DONE') return;
  if (S.playing) { S.playing = false; }
  tick();
  log(`step → frame ${S.ticks} · ${S.items.length} plotted`);
  syncTransport();
}
function resetRun(silent) {
  S.playing = false; S.ticks = 0; S.elapsed = 0; S.tickWindow = [];
  computeLayout(); resetPlacement(); S.phase = 'IDLE';
  if (!silent) log('reset · buffers cleared');
  syncTransport();
}

/* ---------------- render ---------------- */
function render() {
  sctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  sctx.drawImage(base, 0, 0, V.W, V.H);

  const lastP = S.perimIndex ? G.queue[S.perimIndex - 1] : null;
  if (params.showGuide) {
    sctx.lineWidth = 1;
    G.rings.forEach((r, k) => {
      sctx.setLineDash([2, 4]); sctx.strokeStyle = '#27272a'; sctx.stroke(r.path); sctx.setLineDash([]);
      let end = -1;
      if (S.phase === 'FILL' || S.phase === 'DONE') end = r.pts.length - 1;
      else if (lastP) end = k < lastP.ring ? r.pts.length - 1 : k === lastP.ring ? lastP.iEnd : -1;
      if (end > 0) {
        sctx.strokeStyle = k === 0 ? 'rgb(225 29 72 / .55)' : 'rgb(225 29 72 / .22)';
        sctx.beginPath(); sctx.moveTo(r.pts[0][0], r.pts[0][1]);
        for (let i = 1; i <= end; i++) sctx.lineTo(r.pts[i][0], r.pts[i][1]);
        sctx.stroke();
      }
    });
  }
  if (params.showBoundary && G.inner) {
    sctx.setLineDash([4, 3]); sctx.strokeStyle = 'rgb(244 63 94 / .45)'; sctx.lineWidth = 1;
    sctx.stroke(G.inner.path); sctx.setLineDash([]);
    const b = G.inner.bb; sctx.strokeStyle = '#27272a';
    sctx.strokeRect(b[0] + .5, b[1] + .5, b[2] - b[0], b[3] - b[1]);
  }

  sctx.drawImage(layer, 0, 0, V.W, V.H);

  if (params.showPen) {
    if (S.phase === 'TRACE' && lastP) {
      const [x, y] = G.rings[lastP.ring].pts[lastP.iEnd];
      sctx.strokeStyle = ACCENT; sctx.lineWidth = 1;
      sctx.beginPath();
      sctx.moveTo(x - 9, y); sctx.lineTo(x - 3, y); sctx.moveTo(x + 3, y); sctx.lineTo(x + 9, y);
      sctx.moveTo(x, y - 9); sctx.lineTo(x, y - 3); sctx.moveTo(x, y + 3); sctx.lineTo(x, y + 9);
      sctx.stroke();
      sctx.strokeRect(Math.round(x) - 2.5, Math.round(y) - 2.5, 5, 5);
      label(`t=${lastP.tEnd.toFixed(4)}  (${lastP.ux.toFixed(2)}, ${lastP.uy.toFixed(2)})`, x + 12, y - 12);
    } else if (S.lastItem && S.lastItem.kind === 'interior' && S.phase !== 'IDLE') {
      outline(S.lastItem, ACCENT);
      label(`#${S.lastItem.n} ${S.lastItem.ph.code}`, S.lastItem.box[2] + 6, S.lastItem.box[1] - 4);
    }
  }
  if (hover) outline(hover, '#fafafa');
}
function outline(it, color) {
  sctx.save(); sctx.translate(it.x, it.y); sctx.rotate(it.ang);
  sctx.strokeStyle = color; sctx.lineWidth = 1;
  sctx.strokeRect(-it.w / 2 - 2, -it.h / 2, it.w + 4, it.h);
  sctx.restore();
}
function label(text, x, y) {
  sctx.font = '500 10px "JetBrains Mono", monospace';
  const w = sctx.measureText(text).width + 10;
  x = Math.min(x, V.W - w - 4); y = Math.max(y, 12);
  sctx.fillStyle = '#18181b'; sctx.fillRect(x, y - 9, w, 17);
  sctx.strokeStyle = '#3f3f46'; sctx.strokeRect(x + .5, y - 8.5, w - 1, 16);
  sctx.fillStyle = '#fafafa'; sctx.textAlign = 'left'; sctx.textBaseline = 'middle';
  sctx.fillText(text, x + 5, y);
}

/* ---------------- main loop ---------------- */
let lastUi = 0;
function frame(ts) {
  if (needsRebuild && V.W) rebuild();
  const dt = S.lastTs ? Math.min(ts - S.lastTs, 250) : 0; S.lastTs = ts; S.raf++;
  S.fpsFrames++;
  if (ts - S.fpsT >= 500) { S.fps = (S.fpsFrames * 1000) / (ts - S.fpsT); S.fpsFrames = 0; S.fpsT = ts; }

  if (S.playing) {
    S.elapsed += dt;
    if (ts - S.lastTickAt >= params.delay) {
      S.lastTickAt = ts;
      tick();
      if (S.phase === 'DONE') syncTransport();
    }
  }
  render();
  if (ts - lastUi > 100) { lastUi = ts; updateMetrics(); }
  requestAnimationFrame(frame);
}

/* ---------------- UI: telemetry ---------------- */
const el = id => document.getElementById(id);
const fmtTime = ms => {
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), x = Math.floor(ms % 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
};
const nf = new Intl.NumberFormat('en-US');
function setText(id, v) { const n = el(id); if (n.textContent !== v) n.textContent = v; }

function updateMetrics() {
  const now = performance.now();
  S.tickWindow = S.tickWindow.filter(t => now - t < 1000);
  const areaPx = HEART_AREA * V.u * V.u;
  setText('mFrame', nf.format(S.ticks));
  setText('mRaf', nf.format(S.raf));
  setText('mElapsed', fmtTime(S.elapsed));
  setText('mFps', S.fps ? S.fps.toFixed(1) : '—');
  setText('mPerim', `${S.perimIndex}/${G.queue.length}`);
  setText('mInterior', `${nf.format(S.interior)}/${nf.format(params.density)}`);
  setText('mTotal', nf.format(S.items.length));
  setText('mRate', S.playing ? `${S.tickWindow.length} f/s` : '—');
  setText('mDensity', `${((S.items.length / areaPx) * 1e4).toFixed(2)}/10⁴px²`);
  setText('mInk', `${((S.ink / areaPx) * 100).toFixed(1)}%`);
  setText('mAccept', S.attempts ? `${((S.accepted / S.attempts) * 100).toFixed(1)}%` : '—');
  setText('mAttempts', nf.format(S.attempts));

  const tr = G.queue.length ? S.perimIndex / G.queue.length : 0;
  const fl = params.density ? Math.min(1, S.interior / params.density) : (S.phase === 'DONE' ? 1 : 0);
  el('progTrace').style.scale = `${tr} 1`; setText('progTraceV', `${Math.round(tr * 100)}%`);
  el('progFill').style.scale = `${fl} 1`; setText('progFillV', S.saturated ? 'SAT' : `${Math.round(fl * 100)}%`);

  const it = S.lastItem;
  if (it && S.phase !== 'IDLE') {
    setText('penMode', it.kind === 'perimeter' ? `ring ${it.ring} · arc walk` : 'interior · sample');
    setText('penT', it.kind === 'perimeter' ? it.tEnd.toFixed(4) : '—');
    setText('penX', it.ux.toFixed(3));
    setText('penY', it.uy.toFixed(3));
    el('penLast').replaceChildren(`#${it.n} ${it.ph.code} · `, Object.assign(document.createElement('b'), { textContent: it.text, lang: it.ph.code }), ` · ${it.size}px/${it.weight} · ${(it.ang / DEG).toFixed(1)}°`);
  } else {
    ['penT', 'penX', 'penY'].forEach(i => setText(i, '—')); setText('penMode', '—'); setText('penLast', '—');
  }
  const pill = el('phasePill');
  pill.dataset.phase = S.phase; pill.dataset.running = String(S.playing);
  setText('phaseLabel', S.phase + (S.phase !== 'IDLE' && S.phase !== 'DONE' && !S.playing ? ' · PAUSED' : ''));
}

function updateStaticReadouts() {
  setText('vpUnit', `u = ${V.u.toFixed(2)} px · ${params.rings} ring(s)`);
  setText('cornerTL', `VIEWPORT ${V.W}×${V.H} @${V.dpr}x\nORIGIN (${V.cx.toFixed(0)}, ${V.cy.toFixed(0)}) · y₀=${YC.toFixed(2)}`);
  setText('cornerBR', `seed ${params.seed} · ${activePool().length} phrases`);
  setText('sbCanvas', `canvas ${Math.round(V.W * V.dpr)}×${Math.round(V.H * V.dpr)} px`);
  setText('defL', `≈ ${CURVE.L.toFixed(3)} u (${SAMPLES} samples)`);
  setText('defB', `x ±16 · y [${CURVE.ymin.toFixed(1)}, ${CURVE.ymax.toFixed(3)}]`);
  setText('defApx', `${nf.format(Math.round(HEART_AREA * V.u * V.u))} px²`);
}

/* ---------------- UI: log ---------------- */
const logEl = el('log');
function log(msg, kind = '') {
  const li = document.createElement('li'); if (kind) li.dataset.k = kind;
  const t = document.createElement('time'); t.textContent = '+' + fmtTime(S.elapsed);
  const s = document.createElement('span'); s.textContent = msg;
  li.append(t, s); logEl.prepend(li);
  while (logEl.children.length > 120) logEl.lastChild.remove();
}

/* ---------------- UI: transport sync ---------------- */
function syncTransport() {
  const b = el('btnPlay');
  b.setAttribute('aria-pressed', String(S.playing));
  el('btnPlayLabel').textContent = S.playing ? 'Pause' : S.phase === 'DONE' ? 'Replay' : S.phase === 'IDLE' ? 'Play' : 'Resume';
  el('btnStep').disabled = S.phase === 'DONE';
}

/* ---------------- UI: sliders ---------------- */
const SLIDERS = {
  delay: { fmt: v => (v ? `${v} ms` : '0 ms · vsync') },
  batch: { fmt: v => `${v}` },
  scale: { fmt: v => `${v.toFixed(2)}×`, rebuild: true },
  rings: { fmt: v => `${v}`, rebuild: true },
  ringGap: { fmt: v => `${v} px`, rebuild: true },
  density: { fmt: v => nf.format(v), rebuild: true },
  jitter: { fmt: v => `±${v}°`, rebuild: true },
  sizeMin: { fmt: v => `${v} px`, rebuild: true, mcache: true },
  sizeMax: { fmt: v => `${v} px`, rebuild: true, mcache: true },
};
function paintRange(inp) {
  const p = ((inp.value - inp.min) / (inp.max - inp.min)) * 100;
  inp.style.setProperty('--p', `${p}%`);
}
for (const [key, cfg] of Object.entries(SLIDERS)) {
  const inp = el(key), out = el(key + 'Out');
  const sync = () => { params[key] = Number(inp.value); out.textContent = cfg.fmt(params[key]); paintRange(inp); };
  inp.value = params[key]; sync();
  inp.addEventListener('input', () => {
    sync();
    if (key === 'sizeMin' && params.sizeMin > params.sizeMax) { el('sizeMax').value = params.sizeMin; el('sizeMax').dispatchEvent(new Event('input')); }
    if (key === 'sizeMax' && params.sizeMax < params.sizeMin) { el('sizeMin').value = params.sizeMax; el('sizeMin').dispatchEvent(new Event('input')); }
    if (cfg.rebuild) scheduleRebuild();
  });
  inp.addEventListener('change', () => log(`${key} = ${out.textContent}`));
}

/* toggles */
for (const key of ['tangent', 'showGrid', 'showGuide', 'showBoundary', 'showPen']) {
  const inp = el(key); inp.checked = params[key];
  inp.addEventListener('change', () => {
    params[key] = inp.checked;
    if (key === 'tangent') { scheduleRebuild(); log(`tangent alignment ${inp.checked ? 'on' : 'off'}`); }
    if (key === 'showGrid') drawBase();
  });
}

/* seed */
const seedInp = el('seed');
function setSeed(v) {
  v = Math.max(0, Math.min(4294967295, Math.floor(Number(v) || 0)));
  params.seed = v; seedInp.value = v; scheduleRebuild(); log(`seed = ${v}`);
}
seedInp.addEventListener('change', () => setSeed(seedInp.value));
el('btnReseed').addEventListener('click', () => setSeed(Math.floor(Math.random() * 1e6)));

/* tones */
const toneGrid = el('toneGrid');
TONES.forEach(t => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'tone'; b.style.background = t.hex;
  b.dataset.light = String(!!t.light); b.textContent = t.id;
  b.title = `${t.hex} — click to toggle`;
  b.setAttribute('aria-pressed', String(t.on));
  b.addEventListener('click', () => {
    if (t.on && activeTones().length === 1) { log('tone ramp needs at least one swatch', 'warn'); return; }
    t.on = !t.on; b.setAttribute('aria-pressed', String(t.on));
    scheduleRebuild(); log(`tone ${t.hex} ${t.on ? 'added' : 'removed'} (${activeTones().length} active)`);
  });
  toneGrid.append(b);
});

/* ---------------- UI: corpus ---------------- */
const tbody = el('corpusBody');
function renderCorpus() {
  const frag = document.createDocumentFragment();
  for (const p of corpus) {
    const tr = document.createElement('tr'); tr.dataset.id = p.id; tr.dataset.on = String(p.enabled);
    const td = (cls, ...kids) => { const c = document.createElement('td'); c.className = cls; c.append(...kids); return c; };
    const chk = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'chk', checked: p.enabled });
    chk.dataset.act = 'enabled'; chk.setAttribute('aria-label', `Enable ${p.lang}`);
    const txt = document.createElement('span'); txt.textContent = p.text; txt.lang = p.code;
    const sub = document.createElement('small'); sub.textContent = `${p.lang} · ${p.script}`;
    if (p.custom) sub.append(Object.assign(document.createElement('span'), { className: 'custom-tag', textContent: ' · custom' }));
    const tg = (k, title) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tg';
      b.dataset.act = k; b.textContent = k[1].toUpperCase() === 'W' ? 'W' : k === 'rs' ? 'S' : 'T';
      b.title = `${title} randomization — ${p.lang}`; b.setAttribute('aria-pressed', String(p[k]));
      return b;
    };
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'rm'; rm.dataset.act = 'remove';
    rm.textContent = '×'; rm.title = `Remove ${p.lang}`; rm.setAttribute('aria-label', `Remove ${p.lang}`);
    const codeTd = td('c-code'); codeTd.textContent = p.code; codeTd.title = p.code;
    const textTd = td('c-text', txt, sub); textTd.title = `${p.lang} (${p.script}): ${p.text}`;
    tr.append(td('c-on', chk), codeTd, textTd, td('c-tg', tg('rw', 'Weight')), td('c-tg', tg('rs', 'Scale')), td('c-tg', tg('rt', 'Tone')), td('c-x', rm));
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
  renderChips();
  const scripts = new Set(corpus.map(p => p.script));
  el('corpusMeta').textContent = `${activePool().length}/${corpus.length} active · ${scripts.size} scripts`;
}
function renderChips() {
  const by = new Map();
  corpus.forEach(p => { const a = by.get(p.script) || []; a.push(p); by.set(p.script, a); });
  const box = el('scriptChips'); box.replaceChildren();
  for (const [script, list] of by) {
    const on = list.filter(p => p.enabled).length;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    b.setAttribute('aria-pressed', on === list.length ? 'true' : on ? 'mixed' : 'false');
    b.append(script, Object.assign(document.createElement('span'), { className: 'n', textContent: String(list.length) }));
    b.addEventListener('click', () => {
      const target = on !== list.length;
      list.forEach(p => { p.enabled = target; });
      corpusChanged(`${script} ${target ? 'enabled' : 'disabled'} (${list.length})`);
    });
    box.append(b);
  }
}
function corpusChanged(msg) {
  renderCorpus(); scheduleRebuild();
  if (msg) log(msg);
}
tbody.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const id = Number(t.closest('tr').dataset.id), p = corpus.find(x => x.id === id); if (!p) return;
  const act = t.dataset.act;
  if (act === 'enabled') { p.enabled = t.checked; corpusChanged(`${p.code} ${p.enabled ? 'enabled' : 'disabled'}`); }
  else if (act === 'remove') { corpus = corpus.filter(x => x !== p); corpusChanged(`removed ${p.code} “${p.text}”`); }
  else { p[act] = !p[act]; corpusChanged(`${p.code} ${{ rw: 'weight', rs: 'scale', rt: 'tone' }[act]} random ${p[act] ? 'on' : 'off'}`); }
});
document.querySelectorAll('.tg-all').forEach(b => b.addEventListener('click', () => {
  const k = b.dataset.all, target = !corpus.every(p => p[k]);
  corpus.forEach(p => { p[k] = target; });
  corpusChanged(`all ${{ rw: 'weight', rs: 'scale', rt: 'tone' }[k]} random ${target ? 'on' : 'off'}`);
}));

/* ingest */
async function ingest(replace) {
  const ta = el('ingestText');
  const added = [];
  for (const line of ta.value.split(/\r?\n/)) {
    const parts = line.split('|').map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    let code = 'xx', lang = 'Custom', text;
    if (parts.length >= 3) [code, lang, text] = parts;
    else if (parts.length === 2) { [lang, text] = parts; code = lang.slice(0, 2).toLowerCase(); }
    else text = parts[0];
    text = [...text].slice(0, 48).join('');
    if (!replace && corpus.some(p => p.text === text)) continue;
    if (added.some(p => p.text === text)) continue;
    added.push(mk(code.slice(0, 8), lang.slice(0, 24), detectScript(text), text, true));
  }
  if (!added.length) { log('ingest: no new phrases parsed', 'warn'); return; }
  await loadFonts(added);
  corpus = replace ? added : corpus.concat(added);
  ta.value = '';
  corpusChanged(`ingested ${added.length} phrase(s) [${[...new Set(added.map(p => p.script))].join(', ')}]${replace ? ' · corpus replaced' : ''}`);
}
el('btnAppend').addEventListener('click', () => ingest(false));
el('btnReplace').addEventListener('click', () => ingest(true));
el('btnRestore').addEventListener('click', () => { corpus = buildDefault(); corpusChanged('corpus restored · 23 phrases'); });

/* ---------------- UI: transport & keys ---------------- */
el('btnPlay').addEventListener('click', () => (S.playing ? pause() : play()));
el('btnStep').addEventListener('click', step);
el('btnReset').addEventListener('click', () => resetRun(false));
el('btnClearLog').addEventListener('click', () => logEl.replaceChildren());
el('btnExport').addEventListener('click', () => {
  const c = document.createElement('canvas'); c.width = layer.width; c.height = layer.height;
  const x = c.getContext('2d'); x.fillStyle = '#09090b'; x.fillRect(0, 0, c.width, c.height); x.drawImage(layer, 0, 0);
  c.toBlob(b => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(b);
    a.download = `heart-typeset_seed${params.seed}_${S.items.length}w.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    log(`exported PNG ${c.width}×${c.height}`);
  });
});
document.addEventListener('keydown', e => {
  if (e.target.closest('input[type="number"], textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
  else if (e.key === 'ArrowRight' && !e.target.matches('input[type="range"]')) { e.preventDefault(); step(); }
  else if (e.key === 'r' || e.key === 'R') resetRun(false);
});

/* ---------------- pointer: coords + tooltip ---------------- */
const tip = el('tip');
stage.addEventListener('pointermove', e => {
  const r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  const [ux, uy] = toUnits(px, py);
  const inside = G.rings[0] && hctx.isPointInPath(G.rings[0].path, px, py);
  setText('cornerBL', `x ${ux >= 0 ? ' ' : ''}${ux.toFixed(3)}   y ${uy >= 0 ? ' ' : ''}${uy.toFixed(3)}   ${inside ? 'INSIDE' : 'outside'}`);
  hover = S.grid ? S.grid.at(px, py) : null;
  if (hover) {
    const h = hover;
    const sw = Object.assign(document.createElement('span'), { className: 't-sw' }); sw.style.background = h.color;
    const t1 = Object.assign(document.createElement('div'), { className: 't-text', textContent: h.text, lang: h.ph.code });
    const t2 = Object.assign(document.createElement('div'), { className: 't-meta', textContent: `${h.ph.lang} · ${h.ph.script} · ${h.ph.code}` });
    const t3 = document.createElement('div'); t3.className = 't-meta';
    t3.append(sw, `${h.size}px / ${h.weight} / ${h.color} · ${h.kind}${h.kind === 'perimeter' ? ' r' + h.ring : ''} #${h.n}`);
    tip.replaceChildren(t1, t2, t3); tip.hidden = false;
    const tx = Math.min(px + 14, r.width - tip.offsetWidth - 8), ty = Math.min(py + 14, r.height - tip.offsetHeight - 8);
    tip.style.translate = `${tx}px ${ty}px`;
  } else tip.hidden = true;
});
stage.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; setText('cornerBL', 'x —  y —'); });

/* ---------------- resize ---------------- */
function resize() {
  const r = wrap.getBoundingClientRect();
  V.W = Math.max(200, Math.floor(r.width)); V.H = Math.max(200, Math.floor(r.height));
  V.dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of [stage, layer, base]) { c.width = Math.round(V.W * V.dpr); c.height = Math.round(V.H * V.dpr); }
  hit.width = V.W; hit.height = V.H;
  stage.style.width = V.W + 'px'; stage.style.height = V.H + 'px';
  lctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  needsRebuild = true;
}
new ResizeObserver(resize).observe(wrap);

/* ---------------- fonts & boot ---------------- */
async function loadFonts(list) {
  const jobs = [];
  for (const w of [400, 700]) for (const p of list) jobs.push(document.fonts.load(fontStr(w, 12), p.text));
  await Promise.allSettled(jobs);
  mCache.clear();
  const loaded = [...document.fonts].filter(f => f.status === 'loaded').length;
  setText('sbFonts', `fonts: ${loaded} faces loaded`);
}

(async function boot() {
  renderCorpus();
  syncTransport();
  log(`curve sampled · L ≈ ${CURVE.L.toFixed(3)} u · A = 180π`);
  try { await Promise.race([loadFonts(corpus), new Promise(r => setTimeout(r, 4000))]); }
  catch { /* fall back to system fonts */ }
  log(`fonts ready · ${new Set(corpus.map(p => p.script)).size} scripts`);
  resize(); rebuild();
  requestAnimationFrame(frame);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) log('reduced motion · autoplay disabled — press Play', 'warn');
  else play();
})();
