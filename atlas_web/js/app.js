import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* =====================================================================
   ATLAS — Spatial 3D environment
   Everything here is driven by REAL telemetry streamed from the shared
   AtlasService over the WebSocket (see /api/health, /api/bootstrap).
   No fabricated telemetry. 3D serves interaction, not decoration.
   ===================================================================== */

const $ = (id) => document.getElementById(id);

// ---- Deployment plumbing ---------------------------------------------------
// ?engine=<origin> lets a hosted site bind to any reachable ATLAS engine.
// APP_BASE supports hosting under a sub-path (e.g. GitHub Pages /<repo>/).
const ENGINE_ORIGIN = (new URLSearchParams(location.search).get('engine') || '').replace(/\/+$/, '');
const APP_BASE = new URL('..', import.meta.url).pathname; // app.js lives in /js/
const API_BASE = ENGINE_ORIGIN || APP_BASE.replace(/\/$/, '');
const WS_URL = (ENGINE_ORIGIN
  ? ENGINE_ORIGIN.replace(/^http/, 'ws')
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${APP_BASE}`) + 'ws';
const ENGINE_HINT = 'python run_atlas.py';

const WORLD = {
  MARKET:   { id: 'MARKET',        label: 'MARKET',        normal: new THREE.Vector3(0, 0, 1) },
  INTELLIGENCE: { id: 'INTELLIGENCE', label: 'INTELLIGENCE', normal: new THREE.Vector3(1, 0, 0) },
  JOURNAL:  { id: 'JOURNAL',       label: 'JOURNAL / LEARNING', normal: new THREE.Vector3(-1, 0, 0) },
  SYSTEM:   { id: 'SYSTEM',        label: 'SYSTEM',        normal: new THREE.Vector3(0, 1, 0) },
  LAB:      { id: 'LAB',           label: 'ATLAS LAB',     normal: new THREE.Vector3(0, -1, 0) },
  CORE:     { id: 'CORE',          label: 'ATLAS CORE',    normal: new THREE.Vector3(0, 0, -1) },
};
const WORLDS = Object.values(WORLD);

let state = {
  connected: false,
  latest: null,
  activeWorld: 'MARKET',
  lastSignalAt: 0,
};

/* ------------------------------------------------------------------
   Generic helpers
   ------------------------------------------------------------------ */
async function apiJSON(path, opts) {
  try {
    const r = await fetch(API_BASE + path, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    console.error('api', path, e);
    return null;
  }
}
const postJSON = (path, body) => apiJSON(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmtNum(v, d = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}
function nowTs() { return Date.now(); }

/* ------------------------------------------------------------------
   WebSocket telemetry
   ------------------------------------------------------------------ */
function connectWS() {
  let ws;
  const open = () => {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { state.connected = true; console.log('ATLAS WS open'); };
    ws.onmessage = (ev) => {
      try { onTelemetry(JSON.parse(ev.data)); } catch (e) { console.error(e); }
    };
    ws.onclose = () => {
      state.connected = false;
      // Honest offline state — never fake telemetry while retrying.
      const dot = $('sys-provider-dot');
      if (dot) dot.className = 'dot disabled';
      $('sys-line-text').textContent =
        `ENGINE OFFLINE · live telemetry needs the local engine (${ENGINE_HINT}) · retrying…`;
      setTimeout(open, 2000);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  };
  open();
}

/* ------------------------------------------------------------------
   Three.js scene
   ------------------------------------------------------------------ */
let renderer, camera, scene, globe, coreSphere;
let faceSprites = {};
let intelligenceGroup;
const intelligenceDefs = [
  { id: 'news', label: 'NEWS' },
  { id: 'fundamentals', label: 'FUNDAMENTALS' },
  { id: 'macro', label: 'MACRO' },
  { id: 'cot', label: 'COT' },
  { id: 'calendar', label: 'CALENDAR' },
  { id: 'sentiment', label: 'SENTIMENT' },
];

const flowAnchors = {
  data:      new THREE.Vector3(3.1, 0.55, 0),
  orderflow: new THREE.Vector3(3.35, -0.05, 0),
  decision:  new THREE.Vector3(3.1, -0.7, 0),
};
let flowLine, flowPulse;

function makeLabelTexture(text, sub) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 160);
  g.font = '700 44px Consolas, monospace';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(230,240,251,0.95)';
  g.shadowColor = 'rgba(0,229,255,0.8)';
  g.shadowBlur = 24;
  g.fillText(text, 256, sub ? 74 : 92);
  if (sub) {
    g.font = '30px Consolas, monospace';
    g.fillStyle = 'rgba(111,136,168,0.95)';
    g.fillText(sub, 256, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function initScene() {
  const host = $('scene');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  host.appendChild(renderer.domElement);

  camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 9);

  scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0x33445a, 1.1));
  const key = new THREE.DirectionalLight(0x7fd0ff, 1.6);
  key.position.set(4, 5, 6);
  scene.add(key);
  const rim = new THREE.PointLight(0x00e5ff, 2.2, 30);
  rim.position.set(-6, 2, -4);
  scene.add(rim);

  const starGeo = new THREE.BufferGeometry();
  const N = 1200;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) pos[i] = (Math.random() - 0.5) * 90;
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0x88bbff, size: 0.05, transparent: true, opacity: 0.7,
  })));

  // ---- ATLAS core + orbital rings
  globe = new THREE.Group();
  coreSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 64, 64),
    new THREE.MeshStandardMaterial({
      color: 0x0a1a2e, metalness: 0.85, roughness: 0.18,
      emissive: 0x0a3a5c, emissiveIntensity: 0.35,
    })
  );
  globe.add(coreSphere);
  globe.add(new THREE.Mesh(
    new THREE.SphereGeometry(1.52, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff, wireframe: true, transparent: true, opacity: 0.10 })
  ));
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x2f6f9f, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
  });
  const r1 = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.015, 8, 100), ringMat);
  r1.rotation.x = Math.PI / 2.4;
  const r2 = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.012, 8, 100), ringMat);
  r2.rotation.x = Math.PI / 1.8; r2.rotation.y = 0.7;
  globe.add(r1, r2);
  globe.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.9 })
  ));

  // world face labels (rotating with the globe)
  for (const w of WORLDS) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeLabelTexture(w.label, 'ATLAS'), depthWrite: false })
    );
    sprite.scale.set(3.2, 1.0, 1);
    sprite.position.copy(w.normal.clone().multiplyScalar(2.9));
    sprite.userData.world = w.id;
    globe.add(sprite);
    faceSprites[w.id] = sprite;
  }

  scene.add(globe);
  buildIntelligenceGroup();
  buildFlowLine();
  animate();
}

function buildIntelligenceGroup() {
  intelligenceGroup = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0e2a40, metalness: 0.7, roughness: 0.3,
    emissive: 0x10466b, emissiveIntensity: 0.6,
  });
  intelligenceDefs.forEach((def, i) => {
    const y = (-1.2 + (i / (intelligenceDefs.length - 1)) * 2.4);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 24), mat.clone());
    m.position.set(3.6, y, 0);
    m.userData.intel = def.id;
    const lbl = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeLabelTexture(def.label, ''), depthWrite: false })
    );
    lbl.scale.set(2.4, 0.75, 1);
    lbl.position.set(4.25, y, 0);
    lbl.userData.intel = def.id;
    intelligenceGroup.add(m, lbl);
  });
  intelligenceGroup.scale.setScalar(0.001);
  scene.add(intelligenceGroup);
}

function buildFlowLine() {
  const curve = new THREE.CatmullRomCurve3([
    flowAnchors.data, flowAnchors.orderflow, flowAnchors.decision,
  ]);
  flowCurve = curve;
  const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(64));
  flowLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: 0x00e5ff, transparent: true, opacity: 0.32,
  }));
  scene.add(flowLine);
  for (const key of Object.keys(flowAnchors)) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff })
    );
    dot.position.copy(flowAnchors[key]);
    scene.add(dot);
  }
  flowPulse = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff })
  );
  flowPulse.visible = false;
  scene.add(flowPulse);
}

/* ------------------------------------------------------------------
   Interaction: drag to rotate Atlas in 360°
   ------------------------------------------------------------------ */
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const dragState = { dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, t2: 0 };
let snapTarget = null; // quaternion target while easing into a world

function onPointerDown(e) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(coreSphere, false);
  if (!hit.length) return;
  dragState.dragging = true;
  dragState.lastX = e.clientX;
  dragState.lastY = e.clientY;
  dragState.t2 = 0;
  snapTarget = null;
  renderer.domElement.setPointerCapture(e.pointerId);
}
function onPointerMove(e) {
  if (!dragState.dragging) return;
  const dx = e.clientX - dragState.lastX;
  const dy = e.clientY - dragState.lastY;
  dragState.lastX = e.clientX;
  dragState.lastY = e.clientY;
  dragState.vx = dx; dragState.vy = dy;
  dragState.t2 += Math.abs(dx) + Math.abs(dy);
  rotateGlobe(dx, dy);
}
function rotateGlobe(dx, dy) {
  const qy = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), -dx * 0.005
  );
  const qx = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0), -dy * 0.005
  );
  globe.quaternion.premultiply(qy).premultiply(qx);
}
function onPointerUp() {
  if (!dragState.dragging) return;
  dragState.dragging = false;
  if (dragState.t2 < 8) { detectClick(); return; }
  snapToNearestWorld();
}

function detectClick() {
  raycaster.setFromCamera(pointer, camera);
  const ints = [];
  if (intelligenceGroup) intelligenceGroup.traverse(o => { if (o.isMesh) ints.push(o); });
  const hit = raycaster.intersectObjects(ints, false);
  if (hit.length && hit[0].object.userData.intel) {
    const id = hit[0].object.userData.intel;
    const sym = currentSymbol();
    openPanel({ key: 'intel', title: id.toUpperCase(), subtitle: `spatial intelligence · ${sym || '—'}`, body: intelligenceBody(sym) });
    intelOpen(id, sym);
    return;
  }
  onCoreClick();
}
function snapToNearestWorld() {
  const camDir = camera.position.clone().normalize();
  let best = null, bestDot = -2;
  for (const w of WORLDS) {
    const normal = w.normal.clone().applyQuaternion(globe.quaternion).normalize();
    const d = normal.dot(camDir);
    if (d > bestDot) { bestDot = d; best = w; }
  }
  if (!best || bestDot < 0.55) return;
  snapToWorld(best);
}
function snapToWorld(w) {
  // Compute relative rotation that aligns the target normal with the camera.
  const normalW = w.normal.clone().applyQuaternion(globe.quaternion).normalize();
  const camDir = camera.position.clone().normalize();
  const axis = new THREE.Vector3().crossVectors(normalW, camDir);
  const angle = Math.acos(Math.max(-1, Math.min(1, normalW.dot(camDir))));
  const rot = new THREE.Quaternion().setFromAxisAngle(
    axis.length() > 1e-6 ? axis.normalize() : new THREE.Vector3(0, 1, 0), angle
  );
  const target = globe.quaternion.clone().premultiply(rot);
  snapTarget = { target, done: false };
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ------------------------------------------------------------------
   Orientation detection (which world faces the user)
   ------------------------------------------------------------------ */
function detectWorld() {
  const camDir = camera.position.clone().normalize();
  let best = null, bestDot = -2;
  for (const w of WORLDS) {
    const normal = w.normal.clone().applyQuaternion(globe.quaternion).normalize();
    const d = normal.dot(camDir);
    if (d > bestDot) { bestDot = d; best = w; }
  }
  return best ? best.id : 'CORE';
}

/* ------------------------------------------------------------------
   Frame loop + world state + flow pulse
   ------------------------------------------------------------------ */
let flowCurve = null;
let flowPulseT = -1;
let currentWorld = 'MARKET';
let lastCoreIdle = 0;

function triggerFlowPulse() {
  flowPulseT = 0;
  if (flowPulse) flowPulse.visible = true;
}

function onWorldChanged(w) {
  const def = WORLD[w] || WORLD.CORE;
  $('orientation-name').textContent = def.label;
  // intelligence objects emerge only when facing INTELLIGENCE
  const target = w === 'INTELLIGENCE' ? 1 : 0.001;
  intelligenceGroup.scale.lerp(new THREE.Vector3(target, target, target), 0.08);
}

function animate(time) {
  requestAnimationFrame(animate);
  const dt = time ? Math.min(0.05, (time - (lastCoreIdle || time)) / 1000) : 0.016;
  lastCoreIdle = time || performance.now();

  // idle drift of nucleus (subtle)
  const n = globe.children[globe.children.length - 1];
  if (n && n.isMesh && n.geometry.type === 'SphereGeometry' && n.position.lengthSq() === 0) {
    n.position.x = Math.sin(performance.now() / 900) * 0.12;
    n.position.y = Math.cos(performance.now() / 1100) * 0.12;
  }

  // ease into snapped world
  if (snapTarget) {
    globe.quaternion.slerp(snapTarget.target, 1 - Math.pow(0.0008, dt));
    if (globe.quaternion.angleTo(snapTarget.target) < 0.001) snapTarget = null;
  }

  // orientation
  const w = detectWorld();
  if (w !== currentWorld) { currentWorld = w; onWorldChanged(w); }

  // data-flow pulse (driven by REAL surge events from telemetry)
  if (flowPulseT >= 0) {
    flowPulseT += dt * 0.5;
    if (flowPulseT > 1) { flowPulseT = -1; if (flowPulse) flowPulse.visible = false; }
    else if (flowCurve) flowPulse.position.copy(flowCurve.getPoint(flowPulseT));
  }

  renderer.render(scene, camera);
}

/* ------------------------------------------------------------------
   Telemetry -> DOM
   ------------------------------------------------------------------ */
function onTelemetry(snap) {
  state.latest = snap;
  if (snap.engines) renderEngines(snap.engines);
  if (snap.brokers) updateBroker(snap.brokers);
  if (snap.system) updateSystemLine(snap.system);
  if (snap.surge && snap.surge.animated) {
    triggerFlowPulse();
    flashNodes(['data', 'orderflow', 'decision']);
  }
  if (currentWorld === 'MARKET') renderMarketPanel(snap.market);
}

function flashNodes(ids) {
  ids.forEach(id => {
    const el = document.querySelector(`.eng-node[data-id="${id}"]`);
    if (el) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 900);
    }
  });
}

function updateSystemLine(sys) {
  const dot = $('sys-provider-dot');
  dot.className = 'dot ' + (sys.provider_connected ? 'active' : 'disabled');
  $('sys-line-text').textContent =
    `DATA ${sys.provider && sys.provider.toUpperCase()} · ${sys.provider_connected ? 'ONLINE' : 'OFFLINE'} · MACRO ${sys.macro_state}`;
  setIndicator('market', sys.provider_connected ? 'active' : 'disabled');
}

function renderEngines(engines) {
  const rail = $('engine-rail');
  rail.innerHTML = '';
  engines.forEach(eng => {
    const node = document.createElement('div');
    node.className = 'eng-node state-' + eng.state;
    node.dataset.id = eng.id;
    node.innerHTML =
      `<span class="eng-id"></span><span class="eng-label">${esc(eng.label)}</span>`;
    node.addEventListener('click', () => {
      apiJSON('/api/engine/' + encodeURIComponent(eng.id)).then(d => {
        if (d) openPanel({ title: eng.label, subtitle: 'ENGINE INSPECTOR · real telemetry', body: engineBody(eng, d) });
      });
    });
    rail.appendChild(node);
  });
}

function updateBroker(brokers) {
  const on = (brokers.accounts || []).find(a => String(a.status || '').toUpperCase() === 'CONNECTED');
  const nameEl = $('broker-name');
  const statusEl = $('broker-status');
  const subEl = $('broker-sub');
  const balEl = $('broker-balance');
  const btn = $('broker-connect-btn');
  const glow = $('broker-glow');

  if (!brokers.available) {
    nameEl.textContent = '—'; statusEl.textContent = 'NOT CONNECTED';
    subEl.textContent = 'cTrader / MT5'; balEl.textContent = ''; btn.textContent = 'CONNECT';
    glow.style.opacity = '0.3';
    return;
  }
  statusEl.textContent = on ? 'CONNECTED' : 'NOT CONNECTED';
  statusEl.style.color = on ? 'var(--green)' : 'var(--amber)';
  glow.style.opacity = on ? '1' : '0.3';
  nameEl.textContent = on ? esc(on.label || on.broker_type) : (brokers.accounts && brokers.accounts.length ? 'CONFIGURE' : '—');
  subEl.textContent = on ? esc(String(on.broker_type || '').toUpperCase()) : 'cTrader / MT5';
  balEl.textContent = on ? fmtNum(on.balance, 2) : '';
  btn.textContent = on ? 'DISCONNECT' : 'CONNECT';
  btn.dataset.account = on ? on.account_id || '' : '';
  btn.dataset.connected = on ? '1' : '0';
}

/* ------------------------------------------------------------------
   Panels & world bodies (HTML overlays where content > 3D)
   ------------------------------------------------------------------ */
let openPanelKey = null;

function openPanel({ title, subtitle, body, key }) {
  openPanelKey = key || null;
  $('panel-title').textContent = title || '';
  $('panel-subtitle').textContent = subtitle || '';
  $('panel-body').innerHTML = body || '';
  $('panel').classList.remove('hidden');
  bindPanel();
}
function closePanel() {
  $('panel').classList.add('hidden');
  openPanelKey = null;
}

function onCoreClick() {
  const snap = state.latest || { market: {}, engines: [] };
  switch (currentWorld) {
    case 'MARKET':
      return openPanel({ key: 'market', title: 'MARKET', subtitle: `${snap.market.symbol || '—'} · ${snap.market.timeframe || '—'} · live pipeline`, body: marketBody(snap.market, snap) });
    case 'INTELLIGENCE':
      return openPanel({ key: 'intel', title: 'INTELLIGENCE', subtitle: 'contextual data objects', body: intelligenceBody(snap.market && snap.market.symbol) });
    case 'JOURNAL':
      return openPanel({ key: 'learning', title: 'JOURNAL / LEARNING', subtitle: 'learning engine · replay · backtest', body: learningBody(snap) });
    case 'SYSTEM':
      return openPanel({ key: 'system', title: 'SYSTEM', subtitle: 'connection & diagnostics', body: systemBody(snap) });
    case 'LAB': {
      apiJSON('/api/flow').then(f => openPanel({ key: 'lab', title: 'ATLAS LAB', subtitle: 'engine traces · pipeline inspection', body: labBody(f) }));
      return;
    }
    default:
      return openPanel({ key: 'core', title: 'ATLAS CORE', subtitle: 'living intelligence system', body: coreBody() });
  }
}

function sparklineSVG(bars, w = 520, h = 70) {
  if (!bars || bars.length < 2) return '<div class="dim">no candles yet (market offline)</div>';
  const min = Math.min(...bars), max = Math.max(...bars);
  const rng = (max - min) || 1;
  const step = w / (bars.length - 1);
  const pts = bars.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / rng) * (h - 8) - 4).toFixed(1)}`).join(' ');
  const col = bars[bars.length - 1] >= bars[0] ? '#3dffa0' : '#ff3b5c';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"/></svg>`;
}

function marketBody(market, snap) {
  const emap = {};
  (snap.engines || []).forEach(e => emap[e.id] = e);
  const flow = snap.flow || {};
  const falls = (flow.engines || []).filter(en => en.status === 'FAILED').map(en => en.name);
  return `
    <h4>PRICE</h4>
    <div class="kv"><b>${esc(market.symbol || '—')}</b><span>${fmtNum(market.price, 5)}</span></div>
    <div class="kv"><b>TIMEFRAME</b><span>${esc(market.timeframe || '—')}</span></div>
    <div class="kv"><b>VERDICT</b><span>${esc(market.verdict || '—')}</span></div>
    <div class="kv"><b>CONFIDENCE</b><span>${market.confidence == null ? '—' : fmtNum(market.confidence, 0) + '%'}</span></div>
    <div class="kv"><b>SCORE</b><span>${fmtNum(market.score, 1)}</span></div>
    <div class="kv"><b>OPEN POSITIONS</b><span>${esc(market.open_positions || 0)}</span></div>
    <div class="kv"><b>BASE BARS</b><span>${esc(market.base_bars || 0)}</span></div>
    ${sparklineSVG(market.bars || [])}
    <h4>ATLAS SIGNAL · ORDERFLOW</h4>
    <div class="kv"><b>Orderflow state</b><span>${emap.orderflow ? esc(emap.orderflow.state) : 'waiting'}</span></div>
    <div class="kv"><b>Decision reached</b><span>${(flow.decision && flow.decision.present) ? 'YES' : 'NO'}</span></div>
    ${falls.length ? `<div class="kv"><b>FAILED ENGINES</b><span>${esc(falls.join(', '))}</span></div>` : ''}
    <div class="row-actions"><button class="sys-btn" id="analyze-now">RUN ANALYSIS</button></div>`;
}

function renderMarketPanel(market) {
  if (openPanelKey !== 'market') return;
  const snap = state.latest;
  $('panel-body').innerHTML = marketBody(market, snap);
  const btn = $('analyze-now');
  if (btn) btn.addEventListener('click', () => postJSON('/api/analyze', { symbol: market.symbol, timeframe: market.timeframe }).then(() => {
    $('panel-subtitle').textContent = 'analysis re-run · updating…';
  }));
}

function intelligenceBody(symbol) {
  const chips = intelligenceDefs.map(d =>
    `<span class="sphere-chip" data-intel="${d.id}">${esc(d.label)}</span>`).join('');
  return `<p class="dim" style="margin-bottom:10px">Contextual intelligence for <b>${esc(symbol || '—')}</b>. Rotate to INTELLIGENCE to see these as spatial objects; select to expand.</p>
    <div class="sphere-list">${chips}</div><div id="intel-target"></div>`;
}

function intelOpen(id, symbol) {
  const t = $('intel-target') || document.body;
  if (id === 'cot') {
    apiJSON('/api/cot?symbol=' + encodeURIComponent(symbol || '')).then(d => { t.innerHTML = cotBody(d); });
  } else if (id === 'macro' || id === 'sentiment') {
    return apiJSON('/api/macro').then(d => { t.innerHTML = id === 'sentiment' ? sentimentBody(d) : macroBody(d); });
  } else {
    return apiJSON('/api/news').then(d => { t.innerHTML = id === 'fundamentals' ? fundamentalsBody(d) : newsBody(d); });
  }
}

function newsBody(d) {
  if (!d) return '<div class="dim">unavailable</div>';
  const arts = (d.articles || []).slice(0, 12);
  return `<h4>NEWS · ${esc(d.symbol || '')}</h4>
    <div class="kv"><b>Wire sentiment</b><span>${fmtNum(d.sentiment, 3)}</span></div>
    <div class="kv"><b>Source</b><span>${esc(d.source || 'RSS / NewsAPI')}</span></div>
    ${arts.length ? arts.map(a => `<div style="margin:8px 0;border-bottom:1px solid rgba(120,180,255,.08);padding-bottom:6px">
      <b>${esc(a.title || '')}</b><div class="dim">${esc(a.source || '')} · ${esc(a.published_at || a.publishedAt || '')}</div></div>`).join('')
      : '<div class="dim">no contextual headlines fetched</div>'}`;
}
function cotBody(d) {
  if (!d) return '<div class="dim">unavailable</div>';
  const comps = (d.components || []).map(c =>
    `<div class="kv"><b>${esc(c.currency)}</b><span>${c.score == null ? 'UNAVAILABLE' : c.score}</span></div>`).join('');
  return `<h4>COT · ${esc(d.symbol)}</h4>
    <div class="kv"><b>COMBINED POSITIONING</b><span>${d.combined_score == null ? '—' : d.combined_score}</span></div>
    ${comps}
    <div class="dim">CFTC Legacy Futures · combines base &amp; quote positioning for pairs.</div>`;
}
function macroBody(d) {
  if (!d) return '<div class="dim">unavailable</div>';
  const fg = d.fear_greed || {};
  return `<h4>MACRO FEAR &amp; GREED</h4>
    <div class="kv"><b>VALUE</b><span>${fg.value == null ? '—' : fg.value}</span></div>
    <div class="kv"><b>ZONE</b><span>${esc(fg.zone || '—')}</span></div>
    <h4>COMPONENTS</h4>
    ${Object.entries(fg.components || {}).map(([k, v]) => `<div class="kv"><b>${esc(k)}</b><span>${fmtNum(v, 1)}</span></div>`).join('')}`;
}
function sentimentBody(d) {
  if (!d) return '<div class="dim">unavailable</div>';
  const fg = d.fear_greed || {};
  const c = (d.crypto_fear_greed || {});
  return `<h4>SENTIMENT</h4><div class="kv"><b>Fear &amp; Greed</b><span>${esc(fg.zone || '—')} (${fg.value})</span></div>
    <div class="kv"><b>Crypto</b><span>${esc(c.classification || '—')}</span></div>`;
}
function fundamentalsBody(d) {
  return newsBody(d);
}

function engineBody(eng, detail) {
  const rows = (detail.engines || []).map(e =>
    `<div class="kv"><b>${esc(e.name)}</b><span>${esc(e.status)} · ${fmtNum(e.ms != null ? e.ms : e.elapsed_ms, 1)}ms</span></div>`).join('');
  const out = detail.output || {};
  const input = detail.input || {};
  const errs = (detail.errors || []).map(e => `<div class="kv"><b>ERROR</b><span>${esc(String(e).slice(0, 80))}</span></div>`).join('');
  return `<h4>STATUS · ${esc(String(eng.label).toUpperCase())}</h4>
    <div class="kv"><b>STATE</b><span>${esc(eng.state)}</span></div>
    ${rows}
    <div class="kv"><b>LAST UPDATE</b><span>${esc(detail.last_update || '—')}</span></div>
    <div class="kv"><b>CONFIDENCE</b><span>${detail.confidence == null ? '—' : fmtNum(detail.confidence, 1)}</span></div>
    <div class="kv"><b>DOWNSTREAM</b><span>${esc(detail.downstream || '—')}</span></div>
    <div class="kv"><b>REACHED DECISION</b><span>${detail.reached_decision ? 'YES' : 'NO'}</span></div>
    <h4>INPUT RECEIVED</h4>
    <pre class="dim" style="white-space:pre-wrap;font-size:10px">${esc(JSON.stringify(input, null, 1))}</pre>
    <h4>OUTPUT</h4>
    <pre class="dim" style="white-space:pre-wrap;font-size:10px">${esc(JSON.stringify(out).slice(0, 700))}</pre>
    ${errs}`;
}

function systemBody(snap) {
  const sys = snap.system || {};
  const brokers = snap.brokers || {};
  const accts = (brokers.accounts || []).map(a =>
    `<div class="kv"><b>${esc(a.label || a.broker_type)}</b><span>${esc(a.status || 'not configured')}</span></div>`).join('');
  return `<h4>DATA &amp; PROVIDER</h4>
    <div class="kv"><b>Provider</b><span>${esc(sys.provider || '—')}</span></div>
    <div class="kv"><b>Connected</b><span>${sys.provider_connected ? 'ONLINE' : 'OFFLINE'}</span></div>
    <div class="kv"><b>Macro state</b><span>${esc(sys.macro_state || '—')}</span></div>
    <h4>BROKER ACCOUNTS</h4>${accts || '<div class="dim">none attached — open Broker object</div>'}
    <h4>ENGINE PRESENCE</h4>
    ${(snap.engines || []).map(e => `<div class="kv"><b>${esc(e.label)}</b><span>${esc(e.state)}</span></div>`).join('')}`;
}
function labBody(flow) {
  flow = flow || {};
  const eng = (flow.engines || []).map(e =>
    `<div class="kv"><b>${esc(e.name)}</b><span>${esc(e.status)} · ${fmtNum(e.ms != null ? e.ms : e.elapsed_ms, 1)}ms ${e.error ? '· ⚠' : ''}</span></div>`).join('');
  const drops = (flow.drops || []).map(d =>
    `<div class="kv"><b>${esc(d.where)}</b><span>${esc(d.what)}</span></div>`).join('');
  const slots = Object.entries(flow.slots || {}).map(([k, v]) =>
    `<div class="kv"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');
  return `<h4>PIPELINE TRACE · ${esc(flow.symbol || '—')} ${esc(flow.timeframe || '')}</h4>
    <div class="kv"><b>Base bars</b><span>${esc(flow.base_bars || 0)}</span></div>
    <div class="kv"><b>Drops</b><span>${esc(flow.drop_count || 0)}</span></div>
    <h4>ENGINES (real)</h4>${eng || '<div class="dim">no completed run yet (market offline)</div>'}
    <h4>CONTEXT SLOTS</h4>${slots || '<div class="dim">—</div>'}
    ${drops ? `<h4>DROPS</h4>${drops}` : ''}`;
}
function learningBody(snap) {
  const l = (snap.engines || []).find(e => e.id === 'learning');
  const o = (snap.engines || []).find(e => e.id === 'orderflow');
  return `<h4>LEARNING ENGINE</h4>
    <div class="kv"><b>State</b><span>${esc((l && l.state) || 'disabled')}</span></div>
    <div class="kv"><b>Orderflow history</b><span>${esc((o && o.state) || '—')}</span></div>
    <div class="dim" style="margin-top:8px">Trade journal, replay, backtests and prediction accuracy live behind this world. Outcomes are produced by the real replay/backtest subsystem on the backend.</div>`;
}
function coreBody() {
  return `<p>You are rotating around the ATLAS intelligence core. Rotate to any face to enter its world.</p>
    <div class="sphere-list">${WORLDS.map(w => `<span class="sphere-chip">${esc(w.label)}</span>`).join('')}</div>`;
}

function bindPanel() {
  document.querySelectorAll('#panel-body .sphere-chip').forEach(el => {
    if (el.dataset.intel) {
      el.addEventListener('click', () => intelOpen(el.dataset.intel, currentSymbol()));
    }
  });
}
function currentSymbol() {
  return state.latest && state.latest.market ? state.latest.market.symbol : '';
}

/* ------------------------------------------------------------------
   Broker object + floating config modal
   ------------------------------------------------------------------ */
function openBrokerModal() {
  $('broker-modal').classList.remove('hidden');
  $('bf-result').textContent = '';
  renderAccountList();
}
function closeBrokerModal() {
  $('broker-modal').classList.add('hidden');
}
function renderAccountList() {
  apiJSON('/api/brokers').then(b => {
    const wrap = $('broker-account-list');
    if (!b || !b.available) { wrap.innerHTML = '<div class="dim">broker system unavailable</div>'; return; }
    wrap.innerHTML = (b.accounts || []).length
      ? (b.accounts || []).map(a => `<div class="acct-row">
          <span>${esc(a.label || a.broker_type)} · ${esc(a.broker_type)}</span>
          <span>${esc(a.status || 'not configured')}</span>
          <span class="a-actions">
            <button data-act="connect" data-id="${esc(a.account_id || '')}">connect</button>
            <button data-act="disconnect" data-id="${esc(a.account_id || '')}">disconnect</button>
            <button data-act="setdefault" data-id="${esc(a.account_id || '')}">default</button>
            <button data-act="remove" data-id="${esc(a.account_id || '')}" class="acct-remove">✕</button>
          </span>
        </div>`).join('')
      : '<div class="dim">no accounts yet — add one above.</div>';
    wrap.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        const body = { account_id: id };
        if (act === 'remove') {
          if (!window.confirm('Remove this broker account? This frees a slot; it cannot be undone.')) return;
          postJSON('/api/broker/remove', body).then(() => renderAccountList());
          return;
        }
        const path = act === 'setdefault' ? '/api/broker/set-default' : act === 'connect' ? '/api/broker/connect' : '/api/broker/disconnect';
        postJSON(path, body).then(() => renderAccountList());
      });
    });
  });
}

/* ------------------------------------------------------------------
   Broker form, data-source indicators, boot & wiring
   ------------------------------------------------------------------ */
function setIndicator(src, kind) {
  const el = document.querySelector(`.api-ind .dot[data-src="${src}"]`);
  if (el) el.className = 'dot ' + kind;
}
function refreshDataIndicators() {
  apiJSON('/api/news').then(d => {
    setIndicator('news', (d && !d.error && d.articles && d.articles.length) ? 'active' : 'waiting');
    setIndicator('calendar', (d && d.calendar && d.calendar.length) ? 'active' : 'waiting');
  });
  apiJSON('/api/cot?symbol=' + encodeURIComponent(currentSymbol() || 'EURUSD')).then(d => {
    setIndicator('cot', (d && d.combined_score != null) ? 'active' : 'waiting');
  });
}

function brokerSubmit(e) {
  e.preventDefault();
  const provider = $('bf-provider').value;
  const payload = {
    broker_type: provider,
    label: ($('bf-account-id').value ? 'ACCT ' + $('bf-account-id').value : '').trim(),
    client_id: $('bf-client-id').value,
    client_secret: $('bf-client-secret').value,
    account_id: $('bf-account-id').value,
    password: $('bf-token').value,
    server: $('bf-host').value,
    environment: $('bf-env').value,
    make_default: $('bf-default').checked,
  };
  $('bf-result').textContent = 'connecting…';
  postJSON('/api/broker/add', payload).then(r => {
    $('bf-result').textContent = (r && (r.message || (r.ok ? 'OK' : 'FAILED'))) || 'no response';
    renderAccountList();
  });
}
function brokerTest() {
  const payload = {
    broker_type: $('bf-provider').value,
    client_id: $('bf-client-id').value,
    client_secret: $('bf-client-secret').value,
    account_id: $('bf-account-id').value,
    password: $('bf-token').value,
    environment: $('bf-env').value,
  };
  $('bf-result').textContent = 'probing gateway…';
  postJSON('/api/broker/test', payload).then(r => {
    if (!r) { $('bf-result').textContent = 'no response'; return; }
    $('bf-result').textContent = r.ok
      ? `OK · ${r.status || ''}`
      : `NOT REACHED · ${r.reason || ''}`;
  });
}

async function boot() {
  const b = await apiJSON('/api/bootstrap');
  if (b) {
    state.latest = { system: b.system, market: b.market, brokers: b.brokers, engines: b.engines, flow: {}, surge: b.surge };
    renderEngines(b.engines || []);
    updateBroker(b.brokers || {});
    updateSystemLine(b.system || {});
  }
}

function wireEvents() {
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  $('panel-close').addEventListener('click', closePanel);
  $('broker-modal-close').addEventListener('click', closeBrokerModal);

  // broker object (compact left) opens the floating config
  $('broker-object').addEventListener('click', (e) => {
    if (e.target.id === 'broker-connect-btn') return;
    openBrokerModal();
  });
  $('broker-connect-btn').addEventListener('click', () => {
    const connected = $('broker-connect-btn').dataset.connected === '1';
    const id = $('broker-connect-btn').dataset.account;
    if (!id) { openBrokerModal(); return; }
    postJSON(connected ? '/api/broker/disconnect' : '/api/broker/connect', { account_id: id });
  });

  $('broker-form').addEventListener('submit', brokerSubmit);
  $('bf-test').addEventListener('click', brokerTest);

  // nudge hint: never a sidebar — rotate the sphere
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePanel(); closeBrokerModal(); }
  });
}

initScene();
wireEvents();
connectWS();
boot();
refreshDataIndicators();






