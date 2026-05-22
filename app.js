/**
 * ═══════════════════════════════════════════════════════════
 * KinetiLink · app.js
 * JuneVerse · Accessible Navigation Platform
 *
 * Architecture:
 *   CameraManager     — getUserMedia, rear camera, canvas sizing
 *   DetectionEngine   — TensorFlow COCO-SSD, frame throttling
 *   RiskEngine        — Priority scoring, collision detection
 *   SpatialAudio      — WebAudio API, PannerNode, HRTF
 *   VoiceSystem       — SpeechSynthesis, cooldown logic
 *   NavigationMode    — Audio-first UI for blind users
 *   DemoMode          — Dashboard + logs + ledger simulation
 *   LedgerSim         — localStorage community ledger mock
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────── */

/** Classes we care about — ignore everything else */
const RELEVANT_CLASSES = new Set([
  'person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle',
  'chair', 'couch', 'dining table', 'potted plant',
  'bottle', 'suitcase', 'backpack', 'fire hydrant',
  'stop sign', 'traffic light', 'bench', 'dog', 'cat'
]);

/** Risk score for each class (higher = more urgent) */
const CLASS_RISK = {
  car: 10, truck: 10, bus: 10, motorcycle: 9,
  person: 8, bicycle: 7,
  'fire hydrant': 5, 'stop sign': 4, 'traffic light': 4,
  bench: 3, chair: 3, couch: 3, 'dining table': 3,
  'potted plant': 2, bottle: 1, suitcase: 2,
  backpack: 1, dog: 5, cat: 3
};

/** Navigation system modes */
const NAV_MODES = {
  CRUISE: 'CRUISE',
  ALERT: 'ALERT',
  REDIRECT: 'REDIRECT'
};

/** AI polling interval (ms) — keeps CPU light */
const DETECT_INTERVAL_MS = 180;   // ~5-6 fps for AI
const VOICE_COOLDOWN_MS  = 4500;  // min gap between same voice message
const AUDIO_COOLDOWN_MS  = 1500;  // min gap between spatial audio pulses

/* ─────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────── */
const state = {
  activeMode: null,       // 'nav' | 'demo'
  running: false,
  paused: false,
  audioEnabled: true,
  model: null,
  modelReady: false,

  // Detection state
  lastDetections: [],
  navMode: NAV_MODES.CRUISE,
  lastVoiceMessage: '',
  lastVoiceTime: 0,
  lastAudioTime: 0,
  detectionCount: 0,
  frameCount: 0,
  fpsLastTime: performance.now(),
  displayFps: 0,

  // Camera
  stream: null,
  detectTimer: null,
  fpsTimer: null,
};

/* ─────────────────────────────────────────────────
   UTILITY HELPERS
───────────────────────────────────────────────── */

/** Format timestamp HH:MM:SS */
function ts() {
  return new Date().toTimeString().slice(0, 8);
}

/** Clamp a value between min and max */
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

/** Generate random hex string of n chars */
function randHex(n) {
  return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

/* ─────────────────────────────────────────────────
   SYSTEM LOG
───────────────────────────────────────────────── */
const Log = (() => {
  const body = document.getElementById('log-body');
  let lineCount = 0;
  const MAX_LINES = 200;

  function write(msg, level = '') {
    if (!body) return;
    const p = document.createElement('p');
    p.className = `log-line ${level}`;
    p.textContent = `[${ts()}] ${msg}`;
    body.appendChild(p);
    lineCount++;

    // Prune old lines
    if (lineCount > MAX_LINES) {
      body.removeChild(body.firstChild);
      lineCount--;
    }

    body.scrollTop = body.scrollHeight;
  }

  return {
    info  : (msg) => write(msg, 'info'),
    warn  : (msg) => write(msg, 'warn'),
    danger: (msg) => write(msg, 'danger'),
    ok    : (msg) => write(msg, 'ok'),
    plain : (msg) => write(msg, ''),
    clear : ()    => { body.innerHTML = ''; lineCount = 0; }
  };
})();

/* ─────────────────────────────────────────────────
   STATUS UPDATER — syncs both nav and demo pills
───────────────────────────────────────────────── */
function setStatus(text, level = '') {
  // nav pill
  const navDot  = document.getElementById('nav-status-dot');
  const navText = document.getElementById('nav-status-text');
  if (navDot)  { navDot.className  = `status-dot ${level}`; }
  if (navText) { navText.textContent = text; }

  // demo pill
  const demoDot  = document.getElementById('demo-status-dot');
  const demoText = document.getElementById('demo-status-text');
  if (demoDot)  { demoDot.className  = `status-dot ${level}`; }
  if (demoText) { demoText.textContent = text; }
}

/* ─────────────────────────────────────────────────
   CAMERA MANAGER
───────────────────────────────────────────────── */
const CameraManager = (() => {

  /**
   * Request rear camera. Falls back to any available camera.
   * Returns MediaStream or throws.
   */
  async function start() {
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Fallback: try any camera
      Log.warn(`Rear camera failed (${e.name}). Trying any camera…`);
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }

  /**
   * Attach stream to a <video> element and wait for it to play.
   */
  function attachToVideo(stream, videoEl) {
    videoEl.srcObject = stream;
    return new Promise((resolve) => {
      videoEl.onloadedmetadata = () => {
        videoEl.play().then(resolve).catch(resolve);
      };
    });
  }

  /**
   * Fit the canvas overlay to the video element's actual displayed size.
   */
  function sizeCanvas(videoEl, canvasEl) {
    const { offsetWidth: w, offsetHeight: h } = videoEl.parentElement;
    canvasEl.width  = w;
    canvasEl.height = h;
  }

  /**
   * Stop all tracks in a stream.
   */
  function stop(stream) {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }
  }

  return { start, attachToVideo, sizeCanvas, stop };
})();

/* ─────────────────────────────────────────────────
   AI DETECTION ENGINE (COCO-SSD)
───────────────────────────────────────────────── */
const DetectionEngine = (() => {

  /** Load the COCO-SSD model once */
  async function loadModel() {
    Log.info('Loading COCO-SSD model…');
    setStatus('Loading AI…', '');

    // cocoSsd is the global from the CDN script
    if (typeof cocoSsd === 'undefined') {
      throw new Error('cocoSsd CDN script not loaded');
    }

    const model = await cocoSsd.load({
      base: 'lite_mobilenet_v2'   // fastest variant
    });

    Log.ok('COCO-SSD model ready.');
    return model;
  }

  /**
   * Run detection on a video frame.
   * Returns array of { class, score, bbox } for relevant classes only.
   */
  async function detect(model, videoEl) {
    if (!model || videoEl.readyState < 2) return [];

    const predictions = await model.detect(videoEl, 10, 0.40);

    // Filter to relevant classes only
    return predictions.filter(p => RELEVANT_CLASSES.has(p.class));
  }

  return { loadModel, detect };
})();

/* ─────────────────────────────────────────────────
   RISK ENGINE
───────────────────────────────────────────────── */
const RiskEngine = (() => {

  /**
   * Calculate risk for a detection given video dimensions.
   *
   * Risk score considers:
   *   1. Class inherent danger (CLASS_RISK)
   *   2. Object size relative to frame (bigger = closer = more risk)
   *   3. Horizontal position (center = higher risk than edges)
   */
  function scoreDetection(detection, videoW, videoH) {
    const [x, y, w, h] = detection.bbox;

    const classRisk = CLASS_RISK[detection.class] ?? 1;

    // Relative area — larger object = closer = higher risk
    const relArea = (w * h) / (videoW * videoH);
    const sizeScore = clamp(relArea * 8, 0, 5);

    // Horizontal proximity to center — center is most dangerous for forward path
    const centerX = x + w / 2;
    const normalizedX = centerX / videoW;          // 0=left, 1=right
    const distFromCenter = Math.abs(normalizedX - 0.5); // 0=center, 0.5=edge
    const centerScore = clamp((0.5 - distFromCenter) * 4, 0, 2);

    const total = classRisk * (1 + sizeScore + centerScore) * detection.score;
    return { detection, total, relArea, normalizedX };
  }

  /**
   * Evaluate all detections and return:
   *   - navMode (CRUISE | ALERT | REDIRECT)
   *   - topThreat (highest risk detection or null)
   *   - guidanceDirection ('left' | 'right' | 'back' | null)
   */
  function evaluate(detections, videoW, videoH) {
    if (!detections.length) {
      return { navMode: NAV_MODES.CRUISE, topThreat: null, guidanceDirection: null };
    }

    // Score each detection
    const scored = detections.map(d => scoreDetection(d, videoW, videoH));

    // Sort by risk descending
    scored.sort((a, b) => b.total - a.total);

    const top = scored[0];
    const riskScore = top.total;

    // Determine navigation mode thresholds
    let navMode;
    if (riskScore > 25) {
      navMode = NAV_MODES.REDIRECT;
    } else if (riskScore > 10) {
      navMode = NAV_MODES.ALERT;
    } else {
      navMode = NAV_MODES.CRUISE;
    }

    // Determine guidance direction based on object position
    let guidanceDirection = null;
    if (navMode !== NAV_MODES.CRUISE) {
      // Object is on the LEFT side of frame → move RIGHT
      // Object is on the RIGHT side → move LEFT
      // Object is center → suggest either direction
      if (top.normalizedX < 0.35) {
        guidanceDirection = 'right';
      } else if (top.normalizedX > 0.65) {
        guidanceDirection = 'left';
      } else {
        // Obstacle dead ahead — pick side with more clear space
        // Count objects on each half
        const leftCount  = scored.filter(s => s.normalizedX < 0.5).length;
        const rightCount = scored.filter(s => s.normalizedX >= 0.5).length;
        guidanceDirection = leftCount <= rightCount ? 'left' : 'right';
      }
    }

    return { navMode, topThreat: top.detection, guidanceDirection, riskScore };
  }

  /**
   * Build a short, calm voice message for the risk level.
   */
  function buildVoiceMessage(result) {
    const { navMode, topThreat, guidanceDirection } = result;

    if (navMode === NAV_MODES.CRUISE) {
      // Cruise: silence most of the time. Speak rarely.
      return null;
    }

    const cls = topThreat?.class ?? 'obstacle';
    const label = cls === 'person' ? 'person' :
                  (cls === 'car' || cls === 'truck' || cls === 'bus') ? 'vehicle' :
                  'obstacle';

    if (navMode === NAV_MODES.REDIRECT) {
      return `Barrier ahead. Move ${guidanceDirection}.`;
    }

    if (navMode === NAV_MODES.ALERT) {
      if (guidanceDirection) {
        return `${label} ahead. Move ${guidanceDirection}.`;
      }
      return `${label} ahead.`;
    }

    return null;
  }

  return { evaluate, buildVoiceMessage, scoreDetection };
})();

/* ─────────────────────────────────────────────────
   SPATIAL AUDIO SYSTEM
───────────────────────────────────────────────── */
const SpatialAudio = (() => {
  let audioCtx = null;
  let listener = null;

  /** Lazy-init AudioContext (must be after user gesture) */
  function ensureContext() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    listener = audioCtx.listener;

    // Place listener at origin, facing forward
    if (listener.positionX) {
      listener.positionX.value = 0;
      listener.positionY.value = 0;
      listener.positionZ.value = 0;
      listener.forwardX.value  = 0;
      listener.forwardY.value  = 0;
      listener.forwardZ.value  = -1;
      listener.upX.value       = 0;
      listener.upY.value       = 1;
      listener.upZ.value       = 0;
    }
  }

  /**
   * Play a spatial guidance tone.
   *
   * @param {number} normalizedX  - 0 = far left, 0.5 = center, 1 = far right
   * @param {number} intensity    - 0..1 (1 = very close/urgent)
   * @param {string} riskLevel    - 'low' | 'medium' | 'high'
   */
  function playGuidanceTone(normalizedX, intensity, riskLevel = 'medium') {
    try {
      ensureContext();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const now = audioCtx.currentTime;

      // Oscillator
      const osc = audioCtx.createOscillator();

      // Frequency varies by risk: low risk = gentle low freq, high = higher
      const baseFreq = riskLevel === 'high' ? 520 :
                       riskLevel === 'medium' ? 380 : 260;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq, now);

      // Short envelope to avoid harshness
      const gainNode = audioCtx.createGain();
      const vol = clamp(0.08 + intensity * 0.22, 0, 0.3);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(vol, now + 0.04);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

      // 3D panner
      const panner = audioCtx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = 10000;
      panner.rolloffFactor = 1.2;

      // Map normalizedX to 3D position
      // x: -1 (hard left) → +1 (hard right)
      const panX = clamp((normalizedX - 0.5) * 2, -1, 1);
      const distZ = clamp(1.5 - intensity, 0.5, 1.5); // closer = smaller z
      if (panner.positionX) {
        panner.positionX.value = panX;
        panner.positionY.value = 0;
        panner.positionZ.value = -distZ;
      } else {
        panner.setPosition(panX, 0, -distZ);
      }

      // Chain: osc → gain → panner → destination
      osc.connect(gainNode);
      gainNode.connect(panner);
      panner.connect(audioCtx.destination);

      // Play short pulse
      osc.start(now);
      osc.stop(now + 0.30);

      // Cleanup
      osc.onended = () => {
        try { osc.disconnect(); gainNode.disconnect(); panner.disconnect(); } catch {}
      };

    } catch (err) {
      // Silent fail — spatial audio is enhancement, not core
      Log.warn(`SpatialAudio error: ${err.message}`);
    }
  }

  /** Play a "clear path" gentle sonar click */
  function playClearPing() {
    try {
      ensureContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(180, now + 0.15);

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.2);

      osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch {} };
    } catch {}
  }

  function resume() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  return { playGuidanceTone, playClearPing, resume, ensureContext };
})();

/* ─────────────────────────────────────────────────
   VOICE SYSTEM
───────────────────────────────────────────────── */
const VoiceSystem = (() => {
  let enabled = true;
  let synth = window.speechSynthesis;
  let lastMessage = '';
  let lastTime = 0;

  function speak(text, force = false) {
    if (!enabled) return;
    if (!synth) return;

    const now = Date.now();

    // Cooldown: don't repeat same message too fast
    if (!force && text === lastMessage && (now - lastTime) < VOICE_COOLDOWN_MS) {
      return;
    }

    // Don't repeat during CRUISE unless it's been a very long time
    if (!force && text === lastMessage && (now - lastTime) < VOICE_COOLDOWN_MS * 1.5) {
      return;
    }

    // Cancel current utterance if speaking
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate   = 0.92;
    utterance.pitch  = 0.95;
    utterance.volume = 1.0;

    // Prefer a calm English voice
    const voices = synth.getVoices();
    const preferred = voices.find(v =>
      v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Natural'))
    ) || voices.find(v => v.lang.startsWith('en')) || null;

    if (preferred) utterance.voice = preferred;

    synth.speak(utterance);
    lastMessage = text;
    lastTime = now;
  }

  function setEnabled(val) { enabled = val; }
  function isEnabled() { return enabled; }

  return { speak, setEnabled, isEnabled };
})();

/* ─────────────────────────────────────────────────
   CANVAS DRAWING
───────────────────────────────────────────────── */
const CanvasDraw = (() => {

  /**
   * Draw bounding boxes and labels for detections.
   * Color by risk level.
   */
  function drawDetections(canvas, detections, videoW, videoH) {
    const ctx = canvas.getContext('2d');
    const scaleX = canvas.width  / videoW;
    const scaleY = canvas.height / videoH;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    detections.forEach(d => {
      const [x, y, w, h] = d.bbox;
      const risk = CLASS_RISK[d.class] ?? 1;

      // Color by risk
      let color;
      if (risk >= 8)      color = '#ff4757';
      else if (risk >= 5) color = '#ffa502';
      else                color = '#00e5cc';

      const rx = x * scaleX;
      const ry = y * scaleY;
      const rw = w * scaleX;
      const rh = h * scaleY;

      // Box
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.strokeRect(rx, ry, rw, rh);

      // Background for label
      ctx.fillStyle = color + '33';
      ctx.fillRect(rx, ry, rw, rh);

      // Label pill
      const label = `${d.class} ${Math.round(d.score * 100)}%`;
      ctx.font = 'bold 11px DM Sans, sans-serif';
      const textW = ctx.measureText(label).width;
      const pillH = 18;
      const pillY = Math.max(ry - pillH - 2, 0);

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(rx, pillY, textW + 10, pillH, 4);
      ctx.fill();

      ctx.fillStyle = '#0a0e1a';
      ctx.fillText(label, rx + 5, pillY + 13);
    });
  }

  /** Draw a simple "clear path" indicator arrow */
  function drawClearPath(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Subtle upward arrow in center bottom
    const cx = canvas.width / 2;
    const by = canvas.height - 60;

    ctx.strokeStyle = 'rgba(0,229,204,0.5)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(cx, by);
    ctx.lineTo(cx, by - 40);
    ctx.moveTo(cx - 12, by - 26);
    ctx.lineTo(cx, by - 42);
    ctx.lineTo(cx + 12, by - 26);
    ctx.stroke();
  }

  return { drawDetections, drawClearPath };
})();

/* ─────────────────────────────────────────────────
   LEDGER SIMULATION
───────────────────────────────────────────────── */
const LedgerSim = (() => {
  const STORE_KEY = 'kinetilink_ledger_v1';

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function save(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch {}
  }

  function init() {
    let data = load();
    if (!data) {
      data = {
        wallet:   `JV·0x${randHex(4)}…${randHex(4)}`,
        block:    Math.floor(Math.random() * 900000) + 100000,
        rep:      (Math.random() * 2 + 3).toFixed(2),
        txHistory: []
      };
      save(data);
    }
    return data;
  }

  function addBlock(data, eventLabel) {
    data.block++;
    data.rep = (parseFloat(data.rep) + 0.01).toFixed(2);

    const tx = {
      id:    `0x${randHex(12)}`,
      block: data.block,
      ts:    ts(),
      label: eventLabel
    };
    data.txHistory.unshift(tx);
    if (data.txHistory.length > 20) data.txHistory.length = 20;

    save(data);
    return tx;
  }

  return { init, addBlock };
})();

/* ─────────────────────────────────────────────────
   LEDGER UI UPDATER
───────────────────────────────────────────────── */
let ledgerData = LedgerSim.init();

function updateLedgerUI() {
  const walletEl = document.getElementById('ledger-wallet');
  const blockEl  = document.getElementById('ledger-block');
  const repEl    = document.getElementById('ledger-rep');
  if (walletEl) walletEl.textContent = ledgerData.wallet;
  if (blockEl)  blockEl.textContent  = `#${ledgerData.block}`;
  if (repEl)    repEl.textContent    = ledgerData.rep;
}

function addLedgerEntry(label, levelClass = 'feed-ok') {
  const tx = LedgerSim.addBlock(ledgerData, label);
  updateLedgerUI();

  const feed = document.getElementById('ledger-feed');
  if (!feed) return;

  const placeholder = feed.querySelector('.feed-placeholder');
  if (placeholder) placeholder.remove();

  const item = document.createElement('div');
  item.className = 'feed-item';
  item.innerHTML = `<span class="${levelClass}">✓</span> Block #${tx.block} · ${tx.ts}<br><span style="color:var(--text3)">${tx.id}</span> — ${tx.label}`;
  feed.insertBefore(item, feed.firstChild);

  // Keep max 8 entries visible
  while (feed.children.length > 8) {
    feed.removeChild(feed.lastChild);
  }
}

/* ─────────────────────────────────────────────────
   MAIN DETECTION LOOP
   Shared between nav and demo modes
───────────────────────────────────────────────── */

/**
 * Run one detection pass.
 * Both modes share this logic; UI updates differ.
 */
async function runDetectionPass(videoEl, canvasEl) {
  if (!state.model || !state.running || state.paused) return;
  if (videoEl.readyState < 2 || videoEl.paused) return;

  try {
    const detections = await DetectionEngine.detect(state.model, videoEl);
    state.lastDetections = detections;
    state.detectionCount = detections.length;

    const vW = videoEl.videoWidth  || videoEl.offsetWidth;
    const vH = videoEl.videoHeight || videoEl.offsetHeight;

    // Risk evaluation
    const result = RiskEngine.evaluate(detections, vW, vH);
    state.navMode = result.navMode;

    // Canvas drawing
    CameraManager.sizeCanvas(videoEl, canvasEl);
    if (detections.length > 0) {
      CanvasDraw.drawDetections(canvasEl, detections, vW, vH);
    } else {
      CanvasDraw.drawClearPath(canvasEl);
    }

    // Update UI
    updateNavigationUI(result);
    updateDashboardUI(result);

    // Audio + Voice
    if (state.audioEnabled) {
      processAudioOutput(result, vW);
    }

    // Ledger: add entry on mode changes
    if (result.navMode !== NAV_MODES.CRUISE && Math.random() < 0.04) {
      addLedgerEntry(`Nav alert: ${result.topThreat?.class ?? 'obstacle'}`, 'feed-warn');
    }

  } catch (err) {
    Log.warn(`Detection error: ${err.message}`);
  }
}

/* ─────────────────────────────────────────────────
   AUDIO PROCESSOR
───────────────────────────────────────────────── */

let lastCruisePingTime = 0;
const CRUISE_PING_INTERVAL = 8000; // gentle ping every 8s in cruise

function processAudioOutput(result, videoW) {
  const now = Date.now();

  if (result.navMode === NAV_MODES.CRUISE) {
    // Voice: occasional "path clear" at long intervals
    if (now - state.lastVoiceTime > 18000) {
      VoiceSystem.speak('Path clear. Move ahead.');
      state.lastVoiceTime = now;
    }
    // Spatial: gentle periodic ping
    if (now - lastCruisePingTime > CRUISE_PING_INTERVAL) {
      SpatialAudio.playClearPing();
      lastCruisePingTime = now;
    }
    return;
  }

  // ALERT or REDIRECT mode
  const threat = result.topThreat;
  if (!threat) return;

  // Spatial audio for obstacle position
  if (now - state.lastAudioTime > AUDIO_COOLDOWN_MS) {
    const [x, , w] = threat.bbox;
    const threatCenterX = x + w / 2;
    const normalizedX = threatCenterX / (videoW || 1);

    // Calculate intensity by bounding box area relative to screen
    const [, , tw, th] = threat.bbox;
    const relArea = (tw * th) / ((videoW || 1) * (videoW * 0.56 || 1));
    const intensity = clamp(relArea * 4, 0.1, 1.0);
    const riskLevel = result.navMode === NAV_MODES.REDIRECT ? 'high' : 'medium';

    SpatialAudio.playGuidanceTone(normalizedX, intensity, riskLevel);
    state.lastAudioTime = now;
  }

  // Voice guidance
  const voiceMsg = RiskEngine.buildVoiceMessage(result);
  if (voiceMsg && now - state.lastVoiceTime > VOICE_COOLDOWN_MS) {
    VoiceSystem.speak(voiceMsg);
    state.lastVoiceTime = now;
    Log.warn(`Voice: "${voiceMsg}"`);
    addLedgerEntry(`Voice guidance: ${voiceMsg}`, 'feed-warn');
  }
}

/* ─────────────────────────────────────────────────
   NAV MODE UI UPDATES
───────────────────────────────────────────────── */
function updateNavigationUI(result) {
  const badge     = document.getElementById('mode-badge');
  const badgeText = document.getElementById('mode-badge-text');
  const alertDiv  = document.getElementById('alert-overlay');
  const alertText = document.getElementById('alert-text');

  if (!badge) return;

  // Mode badge
  badge.className = 'mode-badge';
  if (result.navMode === NAV_MODES.ALERT) {
    badge.classList.add('warn-mode');
    if (badgeText) badgeText.textContent = 'ALERT';
    setStatus('Alert Mode', 'warn');
  } else if (result.navMode === NAV_MODES.REDIRECT) {
    badge.classList.add('danger-mode');
    if (badgeText) badgeText.textContent = 'REDIRECT';
    setStatus('Redirecting', 'danger');
  } else {
    if (badgeText) badgeText.textContent = 'CRUISE';
    setStatus('Cruise · Active', 'active');
  }

  // Alert overlay
  if (alertDiv) {
    if (result.navMode === NAV_MODES.CRUISE) {
      alertDiv.classList.add('hidden');
    } else {
      alertDiv.classList.remove('hidden');
      const voiceMsg = RiskEngine.buildVoiceMessage(result) || 'Obstacle detected';
      if (alertText) alertText.textContent = voiceMsg;

      if (result.navMode === NAV_MODES.REDIRECT) {
        alertDiv.className = 'alert-overlay level-danger';
      } else {
        alertDiv.className = 'alert-overlay level-warn';
      }
    }
  }

  // Status bar
  const fpsEl    = document.getElementById('nav-fps');
  const countEl  = document.getElementById('nav-detect-count');
  if (fpsEl)   fpsEl.textContent   = `${state.displayFps} fps`;
  if (countEl) countEl.textContent = `${state.detectionCount} objects`;
}

/* ─────────────────────────────────────────────────
   DASHBOARD UI UPDATES
───────────────────────────────────────────────── */
function updateDashboardUI(result) {
  const modeEl    = document.getElementById('dash-mode');
  const fpsEl     = document.getElementById('dash-fps');
  const detectEl  = document.getElementById('dash-detections');
  const riskEl    = document.getElementById('dash-risk');

  if (modeEl) {
    modeEl.textContent = result.navMode;
    modeEl.style.color = result.navMode === NAV_MODES.CRUISE ? 'var(--ok)' :
                         result.navMode === NAV_MODES.ALERT  ? 'var(--warn)' : 'var(--danger)';
  }
  if (fpsEl)    fpsEl.textContent    = state.displayFps;
  if (detectEl) detectEl.textContent = state.detectionCount;
  if (riskEl) {
    const rs = result.riskScore ?? 0;
    riskEl.textContent = rs > 25 ? 'HIGH' : rs > 10 ? 'MEDIUM' : 'LOW';
    riskEl.style.color = rs > 25 ? 'var(--danger)' : rs > 10 ? 'var(--warn)' : 'var(--ok)';
  }
}

/* ─────────────────────────────────────────────────
   FPS TRACKER
───────────────────────────────────────────────── */
function startFpsTracker() {
  state.fpsTimer = setInterval(() => {
    const now = performance.now();
    const elapsed = (now - state.fpsLastTime) / 1000;
    state.displayFps = Math.round(state.frameCount / elapsed);
    state.frameCount = 0;
    state.fpsLastTime = now;
  }, 1000);
}

/* ─────────────────────────────────────────────────
   NAV MODE CONTROLLER
───────────────────────────────────────────────── */
const NavMode = (() => {

  const videoEl  = document.getElementById('video');
  const canvasEl = document.getElementById('overlay');
  const cameraMsg = document.getElementById('camera-msg');

  async function startNavigation() {
    Log.info('Navigation mode starting…');
    setStatus('Starting…', '');
    SpatialAudio.ensureContext();

    try {
      if (!state.stream) {
        state.stream = await CameraManager.start();
      }
      await CameraManager.attachToVideo(state.stream, videoEl);
      if (cameraMsg) cameraMsg.classList.add('hidden');
      Log.ok('Camera active.');
    } catch (e) {
      Log.danger(`Camera error: ${e.message}`);
      if (cameraMsg) cameraMsg.classList.remove('hidden');
      setStatus('Camera error', 'danger');
      VoiceSystem.speak('Camera access denied. Please allow camera and reload.');
      return;
    }

    if (!state.modelReady) {
      setStatus('Loading AI…', '');
      try {
        state.model = await DetectionEngine.loadModel();
        state.modelReady = true;
        const readyEl = document.getElementById('dash-model-ready');
        if (readyEl) readyEl.textContent = 'Yes ✓';
        Log.ok('Model ready.');
      } catch (e) {
        Log.danger(`Model load failed: ${e.message}`);
        setStatus('AI error', 'danger');
        return;
      }
    }

    state.running = true;
    state.paused  = false;
    setStatus('Cruise · Active', 'active');
    VoiceSystem.speak('Navigation started. Path scanning active.');
    addLedgerEntry('Session started', 'feed-ok');

    // Toggle buttons
    document.getElementById('btn-start').classList.add('hidden');
    document.getElementById('btn-pause').classList.remove('hidden');

    // Main detection loop
    state.detectTimer = setInterval(async () => {
      if (!state.running || state.paused) return;
      state.frameCount++;
      await runDetectionPass(videoEl, canvasEl);
    }, DETECT_INTERVAL_MS);

    startFpsTracker();
  }

  function pause() {
    state.paused = !state.paused;
    const btn = document.getElementById('btn-pause');
    if (state.paused) {
      setStatus('Paused', 'warn');
      if (btn) btn.innerHTML = '<i class="fa-solid fa-play" aria-hidden="true"></i><span>Resume</span>';
      VoiceSystem.speak('Navigation paused.');
    } else {
      setStatus('Cruise · Active', 'active');
      if (btn) btn.innerHTML = '<i class="fa-solid fa-pause" aria-hidden="true"></i><span>Pause</span>';
      VoiceSystem.speak('Resuming navigation.');
    }
  }

  function emergencyStop() {
    state.running = false;
    state.paused  = false;
    clearInterval(state.detectTimer);
    clearInterval(state.fpsTimer);
    CameraManager.stop(state.stream);
    state.stream = null;

    // Clear canvas
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    // Reset buttons
    document.getElementById('btn-start').classList.remove('hidden');
    document.getElementById('btn-pause').classList.add('hidden');

    // Reset mode badge
    const badge = document.getElementById('mode-badge');
    const badgeText = document.getElementById('mode-badge-text');
    if (badge) badge.className = 'mode-badge';
    if (badgeText) badgeText.textContent = 'STOPPED';

    const alertDiv = document.getElementById('alert-overlay');
    if (alertDiv) alertDiv.classList.add('hidden');

    setStatus('Stopped', '');
    VoiceSystem.speak('Navigation stopped.');
    addLedgerEntry('Session ended', 'feed-ok');
    Log.warn('Navigation stopped by user.');
  }

  return { startNavigation, pause, emergencyStop };
})();

/* ─────────────────────────────────────────────────
   DEMO MODE CONTROLLER
───────────────────────────────────────────────── */
const DemoMode = (() => {

  const videoEl  = document.getElementById('demo-video');
  const canvasEl = document.getElementById('demo-overlay');
  const cameraMsg = document.getElementById('demo-camera-msg');

  let demoStream = null;
  let demoTimer  = null;
  let demoRunning = false;
  let demoPaused  = false;

  async function startDemo() {
    Log.info('Demo mode starting…');
    SpatialAudio.ensureContext();

    try {
      demoStream = await CameraManager.start();
      await CameraManager.attachToVideo(demoStream, videoEl);
      if (cameraMsg) cameraMsg.classList.add('hidden');
      Log.ok('Demo camera active.');
    } catch (e) {
      Log.danger(`Demo camera error: ${e.message}`);
      if (cameraMsg) cameraMsg.classList.remove('hidden');
      return;
    }

    if (!state.modelReady) {
      Log.info('Loading AI model…');
      const readyEl = document.getElementById('dash-model-ready');
      if (readyEl) readyEl.textContent = 'Loading…';
      try {
        state.model = await DetectionEngine.loadModel();
        state.modelReady = true;
        if (readyEl) readyEl.textContent = 'Yes ✓';
        Log.ok('COCO-SSD model ready for demo.');
      } catch (e) {
        Log.danger(`Model load failed: ${e.message}`);
        if (readyEl) readyEl.textContent = 'Error ✗';
        return;
      }
    }

    demoRunning = true;
    demoPaused  = false;
    state.running = true;

    // Reuse same stream reference for shared audio processing
    state.stream = demoStream;

    setStatus('Demo · Active', 'active');
    addLedgerEntry('Demo session started', 'feed-ok');
    Log.ok('Demo detection loop active.');

    document.getElementById('demo-btn-start').classList.add('hidden');
    document.getElementById('demo-btn-pause').classList.remove('hidden');

    demoTimer = setInterval(async () => {
      if (!demoRunning || demoPaused) return;
      state.frameCount++;
      await runDetectionPass(videoEl, canvasEl);
    }, DETECT_INTERVAL_MS);

    startFpsTracker();
  }

  function pause() {
    demoPaused = !demoPaused;
    const btn = document.getElementById('demo-btn-pause');
    if (demoPaused) {
      if (btn) btn.innerHTML = '<i class="fa-solid fa-play" aria-hidden="true"></i><span>Resume</span>';
      setStatus('Demo Paused', 'warn');
    } else {
      if (btn) btn.innerHTML = '<i class="fa-solid fa-pause" aria-hidden="true"></i><span>Pause</span>';
      setStatus('Demo · Active', 'active');
    }
  }

  function stop() {
    demoRunning = false;
    state.running = false;
    clearInterval(demoTimer);
    clearInterval(state.fpsTimer);
    CameraManager.stop(demoStream);
    demoStream = null;
    state.stream = null;
    setStatus('Demo Stopped', '');
    document.getElementById('demo-btn-start').classList.remove('hidden');
    document.getElementById('demo-btn-pause').classList.add('hidden');
    Log.warn('Demo stopped.');
  }

  return { startDemo, pause, stop };
})();

/* ─────────────────────────────────────────────────
   PANEL SWITCHER
───────────────────────────────────────────────── */
function showPanel(panelId) {
  document.getElementById('splash').classList.add('hidden');
  document.getElementById('nav-mode').classList.add('hidden');
  document.getElementById('demo-mode').classList.add('hidden');

  document.getElementById(panelId).classList.remove('hidden');
  state.activeMode = panelId === 'nav-mode' ? 'nav' : 'demo';

  Log.plain(`Switched to panel: ${panelId}`);
}

/* ─────────────────────────────────────────────────
   AUDIO TOGGLE HELPER
───────────────────────────────────────────────── */
function toggleAudio(iconEl, btnEl, isDemoMode = false) {
  state.audioEnabled = !state.audioEnabled;
  VoiceSystem.setEnabled(state.audioEnabled);
  SpatialAudio.resume();

  const label = state.audioEnabled ? 'Audio ON' : 'Audio OFF';
  const iconClass = state.audioEnabled ? 'fa-volume-high' : 'fa-volume-xmark';

  if (iconEl) iconEl.className = `fa-solid ${iconClass}`;
  if (btnEl)  btnEl.setAttribute('aria-pressed', state.audioEnabled.toString());

  const navAudioState = document.getElementById('nav-audio-state');
  if (navAudioState) navAudioState.textContent = label;

  Log.plain(`Audio ${label}`);
}

/* ─────────────────────────────────────────────────
   EVENT LISTENERS — SPLASH
───────────────────────────────────────────────── */
document.getElementById('btn-nav-mode').addEventListener('click', () => {
  showPanel('nav-mode');
  VoiceSystem.speak('Navigation mode. Press Start to begin.');
});

document.getElementById('btn-demo-mode').addEventListener('click', () => {
  showPanel('demo-mode');
  Log.info('Demo dashboard loaded.');
  updateLedgerUI();
});

/* ─────────────────────────────────────────────────
   EVENT LISTENERS — NAV MODE
───────────────────────────────────────────────── */
document.getElementById('btn-start').addEventListener('click', () => {
  NavMode.startNavigation();
});

document.getElementById('btn-pause').addEventListener('click', () => {
  NavMode.pause();
});

document.getElementById('btn-stop').addEventListener('click', () => {
  NavMode.emergencyStop();
});

document.getElementById('btn-audio').addEventListener('click', function () {
  toggleAudio(
    document.getElementById('audio-icon'),
    this
  );
});

document.getElementById('btn-switch-demo').addEventListener('click', () => {
  showPanel('demo-mode');
  updateLedgerUI();
  Log.info('Switched to demo dashboard.');
});

/* ─────────────────────────────────────────────────
   EVENT LISTENERS — DEMO MODE
───────────────────────────────────────────────── */
document.getElementById('demo-btn-start').addEventListener('click', () => {
  DemoMode.startDemo();
});

document.getElementById('demo-btn-pause').addEventListener('click', () => {
  DemoMode.pause();
});

document.getElementById('demo-btn-audio').addEventListener('click', function () {
  toggleAudio(
    document.getElementById('demo-audio-icon'),
    this,
    true
  );
});

document.getElementById('btn-switch-nav').addEventListener('click', () => {
  DemoMode.stop();
  showPanel('nav-mode');
  VoiceSystem.speak('Navigation mode. Press Start to begin.');
});

document.getElementById('btn-clear-log').addEventListener('click', () => {
  Log.clear();
  Log.plain('Log cleared.');
});

/* ─────────────────────────────────────────────────
   RESIZE HANDLER — Re-size canvas on window resize
───────────────────────────────────────────────── */
window.addEventListener('resize', () => {
  const navVideo  = document.getElementById('video');
  const navCanvas = document.getElementById('overlay');
  const demoVideo = document.getElementById('demo-video');
  const demoCanvas = document.getElementById('demo-overlay');

  if (!navVideo.paused)  CameraManager.sizeCanvas(navVideo, navCanvas);
  if (!demoVideo.paused) CameraManager.sizeCanvas(demoVideo, demoCanvas);
});

/* ─────────────────────────────────────────────────
   KEYBOARD SHORTCUTS (for testing/desktop)
───────────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key.toLowerCase()) {
    case 's':
      // Start whichever mode is active
      if (state.activeMode === 'nav' && !state.running) NavMode.startNavigation();
      if (state.activeMode === 'demo' && !state.running) DemoMode.startDemo();
      break;
    case 'p':
      if (state.activeMode === 'nav' && state.running) NavMode.pause();
      if (state.activeMode === 'demo' && state.running) DemoMode.pause();
      break;
    case 'x':
      if (state.activeMode === 'nav') NavMode.emergencyStop();
      if (state.activeMode === 'demo') DemoMode.stop();
      break;
    case 'm':
      toggleAudio(
        state.activeMode === 'demo'
          ? document.getElementById('demo-audio-icon')
          : document.getElementById('audio-icon'),
        null
      );
      break;
  }
});

/* ─────────────────────────────────────────────────
   BOOT SEQUENCE
───────────────────────────────────────────────── */
(function boot() {
  Log.info('KinetiLink v1.0 by JuneVerse');
  Log.info('Audio: Web Audio API + SpeechSynthesis');
  Log.info('AI: COCO-SSD Lite (TensorFlow.js)');
  Log.info('Platform: vanilla HTML/CSS/JS — no server required');
  Log.plain('─────────────────────────────────────');
  Log.plain('Keyboard shortcuts:');
  Log.plain('  S = Start  |  P = Pause  |  X = Stop  |  M = Mute');
  Log.plain('─────────────────────────────────────');

  updateLedgerUI();

  // Preload voices (Chrome requires this to populate the list)
  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      window.speechSynthesis.getVoices();
    });
  }

  // Check TF.js availability
  if (typeof tf !== 'undefined') {
    Log.ok(`TensorFlow.js loaded (v${tf.version?.tfjs ?? 'unknown'})`);
  } else {
    Log.warn('TensorFlow.js not detected. Check CDN connectivity.');
  }

  Log.plain('Select a mode to begin.');
})();
