// Firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, serverTimestamp,
  collection, onSnapshot, arrayUnion
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, listAll, deleteObject
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyCiqs5iMg-Nj3r6yRszUxFKOIxmMfs5m6Q",
  authDomain: "project-guardian-agent.firebaseapp.com",
  projectId: "project-guardian-agent",
  storageBucket: "project-guardian-agent.firebasestorage.app",
  messagingSenderId: "84395007243",
  appId: "1:84395007243:web:b07e5f4c4264d27611160e",
  measurementId: "G-NRLH3WSCQ9"
};

const appId = 'guardian';
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);
const functions = getFunctions(app, 'us-central1');

// Callables
const callGeminiFunction = httpsCallable(functions, 'callGeminiApi');
const repairWerpsFn = httpsCallable(functions, 'repairWerps');
let reassessWerpsFn = null;
try { reassessWerpsFn = httpsCallable(functions, 'reassessWerps'); } catch { /* optional */ }

const assessmentsPath = `artifacts/${appId}/public/data/werpassessments`;
const appConfigPathCandidates = [
  `artifacts/${appId}/public/config/werpChart`,
  `artifacts/${appId}/public/config/werpRadarBenchmarks`,
  `artifacts/${appId}/public/config/werp`
];

const DEBUG = false;

// DOM refs
const signedOutContainer = document.getElementById('signedOutContainer');
const appContainer = document.getElementById('appContainer');
const adminToolsBtn = document.getElementById('adminToolsBtn');
const userNameSpan = document.getElementById('userName');
const signOutBtn = document.getElementById('signOutBtn');
const roleBadge = document.getElementById('roleBadge');
const contribHint = document.getElementById('contribHint');
const analyzeBtn = document.getElementById('analyzeBtn');
const analyzeText = document.getElementById('analyzeText');
const vesselNameInput = document.getElementById('vesselName');
const statusMessage = document.getElementById('statusMessage');
const authMessage = document.getElementById('authMessage');

const sevHigh = document.getElementById('sevHigh');
const sevMedium = document.getElementById('sevMedium');
const sevLow = document.getElementById('sevLow');
const searchBox = document.getElementById('searchBox');
const clearSearch = document.getElementById('clearSearch');
const visibleCounts = document.getElementById('visibleCounts');

const initialList = document.getElementById('initialWreckList');
const completedList = document.getElementById('completedWreckList');
const reassessList = document.getElementById('reassessList');
const initialCount = document.getElementById('initialCount');
const completedCount = document.getElementById('completedCount');
const reassessCount = document.getElementById('reassessCount');
const noInitial = document.getElementById('noInitialWrecksMessage');
const noCompleted = document.getElementById('noCompletedWrecksMessage');
const noReassess = document.getElementById('noReassessMessage');

const reportContainer = document.getElementById('reportContainer');
const reportTitle = document.getElementById('reportTitle');
const reportContent = document.getElementById('reportContent');
const benchLegend = document.getElementById('benchLegend');

// Gallery + Phase2
const galleryGrid = document.getElementById('galleryGrid');
const galleryEmpty = document.getElementById('galleryEmpty');
const phase2Input = document.getElementById('phase2Input');
const phase2Files = document.getElementById('phase2Files');
const savePhase2Btn = document.getElementById('savePhase2Btn');
const reassessBtn = document.getElementById('reassessBtn');
const uploadFilesBtn = document.getElementById('uploadFilesBtn');
const phase2Status = document.getElementById('phase2Status');
const uploadStatus = document.getElementById('uploadStatus');

// Feedback
const feedbackSection = document.getElementById('feedbackSection');
const feedbackInput = document.getElementById('feedbackInput');
const saveFeedbackBtn = document.getElementById('saveFeedbackBtn');
const feedbackStatus = document.getElementById('feedbackStatus');
const feedbackList = document.getElementById('feedbackList');

// Path hints
const assessPathSpan = document.getElementById('assessPathSpan');
const appIdSpan = document.getElementById('appIdSpan');
if (appIdSpan) appIdSpan.textContent = appId;
if (assessPathSpan) assessPathSpan.textContent = assessmentsPath;

// Export buttons
const exportPdfBtn = document.getElementById('exportPdfBtn');
const exportHtmlBtn = document.getElementById('exportHtmlBtn');
const exportMdBtn = document.getElementById('exportMdBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');

// State
let currentRole = 'user';
let currentItem = null;
let currentDocId = null;
let map;
let markers = new Map();
let radarChart = null;
let dataUnsub = null;
let allItems = [];
let lastRenderedHtml = '';

// Chart config
let chartConfig = {
  scaleMax: 10,
  benchmarks: { high: 9, medium: 6, low: 3 },
  colors: {
    wreck: 'rgba(79,70,229,0.45)',
    wreckBorder: 'rgba(79,70,229,1)',
    high: 'rgba(239,68,68,0.12)',
    highBorder: 'rgba(239,68,68,0.8)',
    medium: 'rgba(245,158,11,0.12)',
    mediumBorder: 'rgba(245,158,11,0.8)',
    low: 'rgba(16,185,129,0.12)',
    lowBorder: 'rgba(16,185,129,0.8)'
  }
};

// Utilities
function escapeHtml(s){ return String(s||"").replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function isFiniteNum(n){ return typeof n === 'number' && Number.isFinite(n); }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function getText(v) { if (v == null) return null; const s = String(v).trim(); return s.length ? s : null; }
function deepGet(obj, path) { return path.split('.').reduce((a,k)=> (a && a[k]!==undefined)?a[k]:undefined, obj); }
function toTitleCase(s) {
  return String(s || '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}
function flattenEntries(obj, maxDepth = 4) {
  const out = [];
  (function rec(cur, path, depth){
    if (cur === null || cur === undefined) return;
    if (typeof cur !== 'object' || depth > maxDepth) { out.push([path, cur]); return; }
    const keys = Object.keys(cur);
    if (!keys.length) out.push([path, cur]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      if (typeof cur[k] === 'object' && cur[k] !== null) rec(cur[k], p, depth + 1);
      else out.push([p, cur[k]]);
    }
  })(obj, '', 0);
  return out;
}

// Sanitize/markdown
function sanitizeReportHtml(html) {
  let safe = DOMPurify.sanitize(html || '', {
    RETURN_TRUSTED_TYPE: false,
    WHOLE_DOCUMENT: false,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'link'],
    FORBID_ATTR: ['style', 'onerror', 'onload']
  });
  safe = safe
    .replace(/<(p|div)>\s*(?:&nbsp;|\u00A0|\s|<br\s*\/?>)*<\/\1>/gi, '')
    .replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>');
  return safe;
}
function renderMarkdown(md) {
  try { return sanitizeReportHtml(marked.parse(md || '')); }
  catch { return `<p>${escapeHtml(md || '').replace(/\n{2,}/g, '\n\n').replace(/\n/g, '<br>')}</p>`; }
}

// Robust text extraction
function extractHtml(val) {
  if (typeof val === 'string') {
    const s = val.trim();
    if (s) return sanitizeReportHtml(`<p>${escapeHtml(s).replace(/\n{2,}/g,'\n\n').replace(/\n/g,'<br>')}</p>`);
    return null;
  }
  if (val == null) return null;
  if (typeof val === 'object') {
    const html = getText(val.html);
    if (html) return sanitizeReportHtml(html);
    const md = getText(val.markdown ?? val.md);
    if (md) return renderMarkdown(md);
    const text = getText(val.text ?? val.content ?? val.value ?? val.body ?? val.summary);
    if (text) return sanitizeReportHtml(`<p>${escapeHtml(text).replace(/\n{2,}/g,'\n\n').replace(/\n/g,'<br>')}</p>`);
    const parts = Array.isArray(val.parts) ? val.parts : Array.isArray(val.content) ? val.content : null;
    if (parts) {
      const chunk = parts
        .map(p => typeof p === 'string' ? p : (p?.text ?? p?.content ?? p?.markdown ?? p?.html ?? ''))
        .filter(Boolean)
        .join('\n\n')
        .trim();
      if (chunk) return extractHtml(chunk);
    }
    const acc = [];
    (function dfs(o, depth = 0) {
      if (o == null || acc.length >= 2 || depth > 3) return;
      if (typeof o === 'string') { const t = o.trim(); if (t) acc.push(t); return; }
      if (Array.isArray(o)) { for (const v of o) { dfs(v, depth + 1); if (acc.length >= 2) break; } return; }
      if (typeof o === 'object') { for (const v of Object.values(o)) { dfs(v, depth + 1); if (acc.length >= 2) break; } }
    })(val);
    if (acc.length) {
      const s = acc.join('\n\n');
      return sanitizeReportHtml(`<p>${escapeHtml(s).replace(/\n{2,}/g,'\n\n').replace(/\n/g,'<br>')}</p>`);
    }
  }
  if (Array.isArray(val)) {
    const chunks = val.map(extractHtml).filter(Boolean);
    if (chunks.length) return chunks.join('\n');
  }
  return null;
}
function extractPlain(val) {
  if (typeof val === 'string') return val.trim() || null;
  if (val == null) return null;
  if (typeof val === 'object') {
    const text = getText(val.text ?? val.content ?? val.value ?? val.summary ?? val.body);
    if (text) return text;
    const md = getText(val.markdown ?? val.md);
    if (md) return md;
    const html = getText(val.html);
    if (html) {
      const tmp = document.createElement('div');
      tmp.innerHTML = sanitizeReportHtml(html);
      return tmp.textContent?.trim() || null;
    }
    const parts = Array.isArray(val.parts) ? val.parts : Array.isArray(val.content) ? val.content : null;
    if (parts) {
      const chunk = parts
        .map(p => typeof p === 'string' ? p : (p?.text ?? p?.content ?? p?.markdown ?? p?.html ?? ''))
        .filter(Boolean).join('\n\n').trim();
      if (chunk) return chunk;
    }
    let out = null;
    (function dfs(o, depth = 0) {
      if (o == null || out || depth > 3) return;
      if (typeof o === 'string') { const t = o.trim(); if (t) { out = t; } return; }
      if (Array.isArray(o)) { for (const v of o) { dfs(v, depth + 1); if (out) break; } return; }
      if (typeof o === 'object') { for (const v of Object.values(o)) { dfs(v, depth + 1); if (out) break; } }
    })(val);
    return out;
  }
  if (Array.isArray(val)) {
    for (const v of val) { const t = extractPlain(v); if (t) return t; }
  }
  return null;
}
function readTextByPaths(obj, paths) {
  for (const p of paths) {
    const v = deepGet(obj, p);
    const t = extractPlain(v);
    if (t) return t;
  }
  return null;
}

// RPM multiplier resolution (STRICT 0.5..2.5)
function clamp(v, min, max) { const n = Number(v); if (!Number.isFinite(n)) return min; return Math.max(min, Math.min(max, n)); }
function resolveRPMMultiplier(item) {
  const explicit = toNum(deepGet(item, 'rpm.finalMultiplier')) ?? toNum(deepGet(item, 'RPM.finalMultiplier'));
  if (isFiniteNum(explicit)) return clamp(explicit, 0.5, 2.5);
  const factors = deepGet(item, 'rpm.factors') || deepGet(item, 'RPM.factors') || deepGet(item, 'rpm.parameters');
  if (Array.isArray(factors) && factors.length) {
    let base = 1.0;
    for (const f of factors) {
      const name = String(f?.name ?? f?.factor ?? '').toLowerCase();
      let v = toNum(f?.value);
      if (!isFiniteNum(v)) continue;
      if (name.includes('chemical')) v = Math.min(v, 1.2);
      else if (name.includes('thermal') || name.includes('temperature') || name.includes('warming')) v = Math.min(v, 1.4);
      else if (name.includes('physical') || name.includes('seismic') || name.includes('storm') || name.includes('current')) v = Math.min(v, 1.4);
      else v = Math.min(v, 1.4);
      base += Math.max(v - 1.0, 0);
    }
    return clamp(base, 0.5, 2.5);
  }
  const generic = toNum(deepGet(item, 'rpm')) ?? toNum(deepGet(item, 'RPM')) ?? toNum(deepGet(item, 'scores.RPM'));
  if (isFiniteNum(generic)) {
    const clamped = clamp(generic, 0.5, 2.5);
    return isFiniteNum(clamped) ? clamped : 1.0;
  }
  return 1.0;
}

// Severity
function readNumberByPaths(obj, paths) {
  for (const p of paths) {
    const v = deepGet(obj, p);
    if (v == null) continue;
    const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v.replace(/[^\d.-]/g,'')) : null);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function computeFormulaSeverity(item) {
  const W = readNumberByPaths(item, ['scores.WCS','wcs','WCS','risk.WCS','phase1.screening.WCS','phase2.scores.WCS']) ?? 0;
  const P = readNumberByPaths(item, ['scores.PHS','phs','PHS','risk.PHS','phase1.screening.PHS','phase2.scores.PHS']) ?? 0;
  const E = readNumberByPaths(item, ['scores.ESI','esi','ESI','risk.ESI','phase1.screening.ESI','phase2.scores.ESI']) ?? 0;
  const R = resolveRPMMultiplier(item);
  return (W + P + (E / 3)) * R;
}
function bandFromValue(val){
  const v = Number(val);
  if (!Number.isFinite(v)) return 'unknown';
  if (v >= 7.5) return 'high';
  if (v >= 4) return 'medium';
  return 'low';
}
function getSeverityValue(item) {
  const direct = readNumberByPaths(item, ['severity.value','severityValue','severity_score','severityScore','risk.severity','risk.score']);
  if (direct !== null) return direct;
  return computeFormulaSeverity(item);
}

// Config
async function loadChartConfig() {
  for (const p of appConfigPathCandidates) {
    try {
      const ref = doc(db, p);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const cfg = snap.data() || {};
        if (typeof cfg.scaleMax === 'number') chartConfig.scaleMax = cfg.scaleMax;
        if (cfg.benchmarks && typeof cfg.benchmarks === 'object') {
          chartConfig.benchmarks = {
            high: Number(cfg.benchmarks.high ?? chartConfig.benchmarks.high),
            medium: Number(cfg.benchmarks.medium ?? chartConfig.benchmarks.medium),
            low: Number(cfg.benchmarks.low ?? chartConfig.benchmarks.low)
          };
        }
        if (cfg.colors && typeof cfg.colors === 'object') chartConfig.colors = { ...chartConfig.colors, ...cfg.colors };
        return;
      }
    } catch {}
  }
}

// Map
const MAPBOX_TOKEN = "pk.eyJ1IjoidXNoMjE0IiwiYSI6ImNtZmNnZzV1YjFxMG0ybHM2MnI5aGN6bzIifQ.0FPMf68cgCHTCOsolzB1_w";
function initMap(){
  if (map) return;
  map = L.map('map').setView([10, 150], 3);
  L.tileLayer('https://api.mapbox.com/styles/v1/{id}/tiles/{z}/{x}/{y}?access_token={accessToken}', {
    id: 'mapbox/streets-v12',
    tileSize: 512, zoomOffset: -1, accessToken: MAPBOX_TOKEN,
    attribution: '&copy; OpenStreetMap &copy; Mapbox'
  }).addTo(map);
}
function markerIconFor(band){
  const color = band === "high" ? "red" : band === "medium" ? "orange" : band === "low" ? "green" : "blue";
  return L.icon({
    iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
    shadowUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-shadow.png',
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
  });
}
function upsertMarker(item){
  const coords = item?.phase1?.screening?.coordinates || item?.coordinates || item?.location || item?.geo || item?.position;
  const id = item?.id;
  if (!id) return;
  const lat = coords?.latitude ?? coords?.lat ?? coords?.y;
  const lng = coords?.longitude ?? coords?.lng ?? coords?.x;
  if (lat == null || lng == null) return;

  const sv = getSeverityValue(item);
  const band = item?.severity?.band || bandFromValue(sv);
  const pos = [Number(lat), Number(lng)];
  const title = escapeHtml(getVesselName(item));
  const svTxt = isFiniteNum(sv) ? sv.toFixed(2) : 'N/A';
  const popupHtml = `<div><strong>${title}</strong><br/>Severity: ${(band||"").toUpperCase()} ${svTxt}</div>`;

  if (markers.has(id)) {
    const m = markers.get(id);
    m.setLatLng(pos);
    m.setIcon(markerIconFor(band));
    m.setPopupContent(popupHtml);
  } else {
    const m = L.marker(pos, { icon: markerIconFor(band) }).addTo(map).bindPopup(popupHtml);
    markers.set(id, m);
  }
}
function clearMarkers(){ for (const m of markers.values()){ try { map.removeLayer(m); } catch {} } markers = new Map(); }

// Radar (generic)
function getAxisScores(item) {
  const w = readNumberByPaths(item, ['wcs','scores.WCS','WCS','phase1.screening.WCS','phase2.scores.WCS']) ?? 0;
  const p = readNumberByPaths(item, ['phs','scores.PHS','PHS','phase1.screening.PHS','phase2.scores.PHS']) ?? 0;
  const e = readNumberByPaths(item, ['esi','scores.ESI','ESI','phase1.screening.ESI','phase2.scores.ESI']) ?? 0;
  const rpm = resolveRPMMultiplier(item);
  const max = chartConfig.scaleMax || 10;
  const rpmScaled = ((rpm - 0.5) / 2.0) * max;
  const clampAxis = v => Math.max(0, Math.min(max, Number(v) || 0));
  return [clampAxis(w), clampAxis(p), clampAxis(e), clampAxis(rpmScaled)];
}
function renderBenchLegend() {
  const b = chartConfig.benchmarks;
  benchLegend.innerHTML = `
    <span style="color:${chartConfig.colors.highBorder}">High</span>: ${b.high} &nbsp;|&nbsp;
    <span style="color:${chartConfig.colors.mediumBorder}">Medium</span>: ${b.medium} &nbsp;|&nbsp;
    <span style="color:${chartConfig.colors.lowBorder}">Low</span>: ${b.low}
  `;
}
function renderRadarGeneric(item) {
  const ctx = document.getElementById('werSpiderChart').getContext('2d');
  const labels = ['WCS', 'PHS', 'ESI', 'RPM'];
  const wreck = getAxisScores(item);
  const max = chartConfig.scaleMax || 10;
  const b = chartConfig.benchmarks;

  const ring = (val, label, bg, border) => ({
    label, data: [val,val,val,val],
    fill: true,
    backgroundColor: bg,
    borderColor: border,
    pointRadius: 0,
    borderWidth: 1
  });

  const data = {
    labels,
    datasets: [
      ring(b.high, 'Benchmark High', chartConfig.colors.high, chartConfig.colors.highBorder),
      ring(b.medium, 'Benchmark Medium', chartConfig.colors.medium, chartConfig.colors.mediumBorder),
      ring(b.low, 'Benchmark Low', chartConfig.colors.low, chartConfig.colors.lowBorder),
      {
        label: 'Wreck Risk',
        data: wreck,
        fill: true,
        backgroundColor: chartConfig.colors.wreck,
        borderColor: chartConfig.colors.wreckBorder,
        pointBackgroundColor: chartConfig.colors.wreckBorder,
        pointBorderColor: '#fff'
      }
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    scales: { r: { beginAtZero: true, min: 0, max, ticks: { stepSize: Math.max(1, Math.round(max/5)) } } },
    plugins: { legend: { display: true, position: 'bottom' } },
    animation: { duration: 250 }
  };

  if (radarChart) radarChart.destroy();
  radarChart = new Chart(ctx, { type: 'radar', data, options });
  renderBenchLegend();
}

// Vessel name
function getVesselName(it) {
  const direct = [
    it.vesselName, it.name, it.title, it.displayName, it.label,
    it.vessel?.name, it.ship?.name, it.wreck?.name, it.wreckName, it.shipName,
    it.meta?.vesselName, it.meta?.name, it.meta?.title,
    it.metadata?.vesselName, it.metadata?.name, it.metadata?.title,
    it.phase1?.screening?.vesselName,
    it['vessel_name'], it['Vessel Name'], it['VESSEL_NAME'],
    it['wreck_title'], it['ship_name'], it['Ship Name'], it['Name']
  ];
  for (const c of direct) { const t = getText(c); if (t) return t; }
  const pairs = flattenEntries(it, 2);
  const keyRx = /(vessel|wreck|ship|name|title)/i;
  for (const [k, v] of pairs) { if (!keyRx.test(k)) continue; const t = getText(v); if (t) return t; }
  return getText(it.id) || 'Unknown';
}

// Overview table data
function extractAxisDetails(item) {
  const details = {
    WCS: { score: readNumberByPaths(item, ['scores.WCS','wcs','WCS','phase1.screening.WCS']), rationale: null },
    PHS: { score: readNumberByPaths(item, ['scores.PHS','phs','PHS','phase1.screening.PHS']), rationale: null },
    ESI: { score: readNumberByPaths(item, ['scores.ESI','esi','ESI','phase1.screening.ESI']), rationale: null },
    RPM: { score: resolveRPMMultiplier(item), rationale: null }
  };
  const flat = flattenEntries(item, 4);
  const ratRx = /(rationale|justification|reason|explanation|basis|notes|comment|detail|narrative)/i;

  for (const ax of ['WCS','PHS','ESI','RPM']) {
    for (const [path, value] of flat) {
      if (!path) continue;
      if (!path.toUpperCase().includes(ax)) continue;
      if (!ratRx.test(path)) continue;
      const t = extractPlain(value);
      if (t) { details[ax].rationale = t; break; }
    }
    if (!details[ax].rationale) {
      const obj = deepGet(item, ax.toLowerCase()) || deepGet(item, `scores.${ax}`) || deepGet(item, `phase1.screening.${ax}`) || deepGet(item, `screening.${ax}`);
      if (obj && typeof obj === 'object') {
        const t = extractPlain(obj.rationale || obj.justification || obj.reason || obj.explanation || obj.notes || obj.detail || obj.comment);
        if (t) details[ax].rationale = t;
      }
    }
  }
  return details;
}

// Screening narratives (de-duplicated)
function renderScreeningSections(item) {
  const sections = [];
  const carriers = [ item?.screening, item?.phase1?.screening ];
  const seen = new Set();

  const pushSection = (title, htmlOrText) => {
    const html = extractHtml(htmlOrText);
    if (!html) return;
    const key = `${title}|${html}`;
    if (seen.has(key)) return;
    sections.push(`<h3>${escapeHtml(title)}</h3>`);
    sections.push(html);
    seen.add(key);
  };

  for (const sc of carriers) {
    if (!sc || typeof sc !== 'object') continue;

    const candidates = {
      'Screening Summary': sc.summary,
      'Rationale': sc.rationale,
      'Methodology': sc.methodology,
      'Assumptions': sc.assumptions,
      'Limitations': sc.limitations,
      'Data Sources': sc.sources ?? sc.dataSources
    };
    for (const [title, val] of Object.entries(candidates)) pushSection(title, val);

    for (const [k, v] of Object.entries(sc)) {
      const keyLower = String(k).toLowerCase();
      const isNarrativeKey = /^(summary|rationale|methodology|assumptions|limitations|sources|datasources)$/.test(keyLower);
      const isScoreKey = /^(wcs|phs|esi|rpm|score|value|lat|lng|latitude|longitude|coordinates?)$/.test(keyLower);
      const isMetaKey = /^(vessel(type)?|shiptype|class|sunk(date)?|sinking(cause)?|datesunk|nation|flag|country|displacement|tonnage)$/.test(keyLower);
      if (isNarrativeKey || isScoreKey || isMetaKey) continue;

      const html = extractHtml(v);
      if (html) {
        const title = toTitleCase(k);
        const dedupeKey = `sc:${title}|${html}`;
        if (!seen.has(dedupeKey)) {
          sections.push(`<h4>${escapeHtml(title)}</h4>`);
          sections.push(html);
          seen.add(dedupeKey);
        }
      }
    }
  }
  return sections.join('\n');
}

// Report builders (generic + v2 detailed)
function buildReportHtml(item) {
  const blocks = [];

  const summaryHtml = extractHtml(item?.summary) || extractHtml(item?.phase1?.summary);
  if (summaryHtml) { blocks.push('<h3>Summary</h3>', summaryHtml); }

  const finalSummaryHtml = extractHtml(item?.finalSummary);
  if (finalSummaryHtml) { blocks.push('<h3>Final Summary</h3>', finalSummaryHtml); }

  const conclusionHtml = extractHtml(item?.conclusion);
  if (conclusionHtml) { blocks.push('<h3>Conclusion</h3>', conclusionHtml); }

  const vesselType = readTextByPaths(item, ['vesselType','vessel_type','type','shipType','class','metadata.vesselType','meta.vesselType']);
  const sunkDate = readTextByPaths(item, ['sunkDate','sunk_date','dateSunk','sunkdate','phase1.screening.sunkDate']);
  const sinkingCause = readTextByPaths(item, ['sinkingCause','causeOfSinking','sinking_cause','cause','phase1.screening.sinkingCause']);
  const coords = (() => {
    const c = item?.phase1?.screening?.coordinates || item?.coordinates || item?.location || item?.geo || item?.position;
    const lat = c?.latitude ?? c?.lat ?? c?.y;
    const lng = c?.longitude ?? c?.lng ?? c?.x;
    if (lat == null || lng == null) return null;
    return `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
  })();

  const details = [];
  const addDetail = (k, v) => {
    const t = extractPlain(v);
    if (!t) return;
    const key = `${k}:${t}`.toLowerCase();
    if (details.some(d => d.key === key)) return;
    details.push({ key, label: k, value: t });
  };

  if (vesselType) addDetail('Vessel Type', vesselType);
  if (sunkDate) addDetail('Sunk Date', sunkDate);
  if (sinkingCause) addDetail('Sinking Cause', sinkingCause);
  if (coords) addDetail('Coordinates', coords);

  const extraPairs = [
    ['Nation', readTextByPaths(item, ['nation','flag','country','metadata.nation'])],
    ['Class', readTextByPaths(item, ['class','shipClass'])],
    ['Displacement', readTextByPaths(item, ['displacement','tonnage'])]
  ];
  for (const [label, val] of extraPairs) if (val) addDetail(label, val);

  if (details.length) {
    blocks.push('<h3>Key Facts</h3>');
    blocks.push('<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>');
    for (const d of details) blocks.push(`<tr><th style="white-space:nowrap">${escapeHtml(d.label)}</th><td>${escapeHtml(d.value)}</td></tr>`);
    blocks.push('</tbody></table>');
  }

  const detailsAxes = extractAxisDetails(item);
  const row = (label, d) => {
    const isRPM = label === 'RPM';
    const scoreTxt = isFiniteNum(d.score) ? d.score.toFixed(2) : '—';
    const ratHtml = extractHtml(d.rationale) || (d.rationale ? sanitizeReportHtml(`<p>${escapeHtml(String(d.rationale))}</p>`) : '');
    return `<tr><th style="white-space:nowrap">${label}${isRPM ? ' (multiplier)' : ''}</th><td style="width:100px">${scoreTxt}</td><td>${ratHtml || ''}</td></tr>`;
  };
  blocks.push(`
    <h3>Factor Scores and Rationale</h3>
    <table>
      <thead><tr><th>Factor</th><th>Score</th><th>Rationale</th></tr></thead>
      <tbody>
        ${row('WCS', detailsAxes.WCS)}
        ${row('PHS', detailsAxes.PHS)}
        ${row('ESI', detailsAxes.ESI)}
        ${row('RPM', detailsAxes.RPM)}
      </tbody>
    </table>
  `);

  const screeningHtml = renderScreeningSections(item);
  if (screeningHtml) blocks.push(screeningHtml);

  if (!blocks.length) blocks.push('<p>No formatted report available.</p>');
  return blocks.join('\n');
}

function hasUnifiedV2(item) {
  return Array.isArray(item?.wcs?.parameters)
    && Array.isArray(item?.phs?.parameters)
    && Array.isArray(item?.esi?.parameters)
    && (Array.isArray(item?.rpm?.factors) || Array.isArray(item?.rpm?.parameters) || isFiniteNum(item?.rpm?.finalMultiplier));
}
function renderReportV2HTML(item) {
  const name = getVesselName(item);
  const bg = item?.phase1?.summary?.background ?? '—';
  const loc = item?.phase1?.summary?.location ?? '—';
  const disc = item?.phase1?.summary?.discovery ?? '—';
  const vtype = item?.phase1?.screening?.vesselType ?? '—';
  const tonnage = item?.phase1?.screening?.tonnage ?? '—';
  const yearBuilt = item?.phase1?.screening?.yearBuilt ?? '—';
  const owner = item?.phase1?.screening?.lastOwner ?? '—';
  const lat = item?.phase1?.screening?.coordinates?.latitude ?? '—';
  const lng = item?.phase1?.screening?.coordinates?.longitude ?? '—';

  const wcsTotal = Number(item?.wcs?.totalScore ?? 0);
  const phsTotal = Number(item?.phs?.totalWeightedScore ?? 0);
  const esiTotal = Number(item?.esi?.totalScore ?? 0);
  const esiMax = Number(item?.esi?.maxScore ?? (Array.isArray(item?.esi?.parameters) ? item.esi.parameters.length * 10 : 30));
  const rpmMult = resolveRPMMultiplier(item);

  const rows = {
    wcs: (item?.wcs?.parameters ?? []).map(p => ({
      name: p?.name ?? p?.parameter ?? '',
      rationale: p?.rationale ?? '',
      score: p?.score ?? ''
    })),
    phs: (item?.phs?.parameters ?? []).map(p => ({
      name: p?.name ?? p?.parameter ?? '',
      weight: p?.weight ?? '',
      rationale: p?.rationale ?? '',
      score: p?.score ?? ''
    })),
    esi: (item?.esi?.parameters ?? []).map(p => ({
      name: p?.name ?? p?.parameter ?? '',
      rationale: p?.rationale ?? '',
      score: p?.score ?? ''
    })),
    rpm: (item?.rpm?.factors ?? item?.rpm?.parameters ?? []).map(f => ({
      name: f?.name ?? f?.factor ?? '',
      rationale: (typeof f?.rationale === 'string' && f.rationale.trim()) ? f.rationale : 'Not specified.',
      value: f?.value ?? ''
    }))
  };

  const table = (headers, keys, data) => {
    let h = '<table><thead><tr>';
    headers.forEach(x => h += `<th>${escapeHtml(x)}</th>`);
    h += '</tr></thead><tbody>';
    data.forEach(row => {
      h += '<tr>';
      keys.forEach(k => {
        const v = row?.[k] ?? '';
        h += `<td>${escapeHtml(String(v))}</td>`;
      });
      h += '</tr>';
    });
    h += '</tbody></table>';
    return h;
  };

  return `
    <section>
      <h3>Case Study Background</h3>
      <p>${escapeHtml(bg)}</p>
      <p><strong>Location:</strong> ${escapeHtml(loc)}</p>
      <p><strong>Discovery:</strong> ${escapeHtml(disc)}</p>
    </section>

    <section>
      <h3>Phase 1: Scoping & Screening</h3>
      <ul class="list-disc ml-5 space-y-1">
        <li><strong>Vessel Type:</strong> ${escapeHtml(vtype)}</li>
        <li><strong>Tonnage:</strong> ${escapeHtml(String(tonnage))}</li>
        <li><strong>Year Built:</strong> ${escapeHtml(String(yearBuilt))}</li>
        <li><strong>Last Owner:</strong> ${escapeHtml(owner)}</li>
        <li><strong>Coordinates:</strong> ${escapeHtml(String(lat))}, ${escapeHtml(String(lng))}</li>
      </ul>
    </section>

    <section>
      <h3>Phase 3: WCS (Hull & Structure)</h3>
      ${table(['Parameter','Rationale','Score (0–5)'], ['name','rationale','score'], rows.wcs)}
      <p class="mt-2"><strong>Total:</strong> ${isFiniteNum(wcsTotal) ? wcsTotal : '—'} / 20</p>
    </section>

    <section>
      <h3>Phase 3: PHS (Pollution Hazard)</h3>
      <p class="text-xs text-gray-600 mb-2">Weights: Fuel 0.40, Ordnance 0.25, Vessel Integrity 0.20, Hazardous Materials 0.15.</p>
      ${table(['Parameter','Weight','Rationale','Score (0–10)'], ['name','weight','rationale','score'], rows.phs)}
      <p class="mt-2"><strong>Total Weighted Score:</strong> ${isFiniteNum(phsTotal) ? phsTotal.toFixed(2) : '—'} / 10</p>
    </section>

    <section>
      <h3>Phase 3: ESI (Environmental Sensitivity)</h3>
      ${table(['Parameter','Rationale','Score (0–10)'], ['name','rationale','score'], rows.esi)}
      <p class="mt-2"><strong>Total:</strong> ${isFiniteNum(esiTotal) ? esiTotal : '—'} / ${esiMax}</p>
    </section>

    <section>
      <h3>Phase 3: RPM (Release Probability Modifier)</h3>
      ${rows.rpm.length ? table(['Factor','Rationale','Value'], ['name','rationale','value'], rows.rpm) : '<p class="text-gray-600">No factor breakdown provided.</p>'}
      <p class="mt-2"><strong>Final Multiplier:</strong> ${isFiniteNum(rpmMult) ? rpmMult.toFixed(2) : '—'}× <span class="text-xs text-gray-500">(1.00 baseline)</span></p>
    </section>

    <section>
      <h3>${item?.status === 'completed' ? 'Final' : 'Preliminary'} Risk Synthesis & Classification</h3>
      ${item?.status === 'completed' ? '' : '<p class="italic text-gray-600">Preliminary scores; Phase 2 verification may adjust risk classification.</p>'}
    </section>

    <section>
      <h3>Summative Assessment</h3>
      <p>${escapeHtml(item?.finalSummary?.summativeAssessment ?? '—')}</p>
    </section>

    <section>
      <h3>Remediation Suggestions</h3>
      ${(item?.finalSummary?.remediationSuggestions ?? []).map(s => `
        <div class="mt-3">
          <h4>Priority ${escapeHtml(String(s?.priority ?? ''))}: ${escapeHtml(s?.title ?? '')}</h4>
          <p>${escapeHtml(s?.description ?? '')}</p>
        </div>
      `).join('') || '<p>—</p>'}
    </section>
  `;
}

// Build generic report markdown (used in export)
function buildReportMarkdown(item) {
  const lines = [];
  const vessel = getVesselName(item);
  lines.push(`# ${vessel}`);

  const s = extractPlain(item?.summary) || extractPlain(item?.phase1?.summary);
  if (s) { lines.push('\n## Summary'); lines.push(s); }

  const fs = extractPlain(item?.finalSummary);
  if (fs) { lines.push('\n## Final Summary'); lines.push(fs); }

  const c = extractPlain(item?.conclusion);
  if (c) { lines.push('\n## Conclusion'); lines.push(c); }

  const vesselType = readTextByPaths(item, ['vesselType','vessel_type','type','shipType','class','metadata.vesselType','meta.vesselType']);
  const sunkDate = readTextByPaths(item, ['sunkDate','sunk_date','dateSunk','sunkdate','phase1.screening.sunkDate']);
  const sinkingCause = readTextByPaths(item, ['sinkingCause','causeOfSinking','sinking_cause','cause','phase1.screening.sinkingCause']);
  const coords = (() => {
    const c0 = item?.phase1?.screening?.coordinates || item?.coordinates || item?.location || item?.geo || item?.position;
    const lat = c0?.latitude ?? c0?.lat ?? c0?.y;
    const lng = c0?.longitude ?? c0?.lng ?? c0?.x;
    if (lat == null || lng == null) return null;
    return `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
  })();
  const facts = [];
  const pushFact = (k, v) => { const t = extractPlain(v); if (t && !facts.some(f => f.k === k && f.v === t)) facts.push({k, v: t}); };
  if (vesselType) pushFact('Vessel Type', vesselType);
  if (sunkDate) pushFact('Sunk Date', sunkDate);
  if (sinkingCause) pushFact('Sinking Cause', sinkingCause);
  if (coords) pushFact('Coordinates', coords);
  if (facts.length) {
    lines.push('\n## Key Facts');
    for (const f of facts) lines.push(`- ${f.k}: ${f.v}`);
  }

  const d = extractAxisDetails(item);
  lines.push('\n## Factor Scores and Rationale');
  lines.push('| Factor | Score | Rationale |');
  lines.push('|---|---:|---|');
  const row = (k, o) => `| ${k}${k==='RPM'?' (multiplier)':''} | ${isFiniteNum(o.score)?o.score.toFixed(2):'—'} | ${(extractPlain(o.rationale) || '').replace(/\n/g,'<br>')} |`;
  lines.push(row('WCS', d.WCS));
  lines.push(row('PHS', d.PHS));
  lines.push(row('ESI', d.ESI));
  lines.push(row('RPM', d.RPM));

  const carriers = [ item?.screening, item?.phase1?.screening ];
  const addIf = (title, v) => { const t = extractPlain(v); if (t) { lines.push(`\n## ${title}`); lines.push(t); } };
  for (const sc of carriers) {
    if (!sc) continue;
    addIf('Screening Summary', sc.summary);
    addIf('Rationale', sc.rationale);
    addIf('Methodology', sc.methodology);
    addIf('Assumptions', sc.assumptions);
    addIf('Limitations', sc.limitations);
    addIf('Data Sources', sc.sources || sc.dataSources);
  }

  return lines.join('\n');
}

// Data load
async function startData() {
  if (dataUnsub) return;
  await loadChartConfig();

  const colRef = collection(db, assessmentsPath);
  dataUnsub = onSnapshot(colRef, (snap) => {
    allItems = [];
    snap.forEach(docSnap => {
      const raw = docSnap.data() || {};
      const d = { ...normalizeDoc(raw), id: raw?.id || docSnap.id };
      const sv = getSeverityValue(d);
      if (!d.severity || typeof d.severity !== 'object') d.severity = {};
      d.severity.value = sv;
      d.severity.band = d.severity.band || bandFromValue(sv);
      allItems.push(d);
    });
    if (DEBUG) console.log('[WERP] Loaded docs:', allItems.length, 'from', assessmentsPath);
    render();
  }, (err) => {
    console.error('Snapshot error', err);
  });
}

// Filters and list rendering
[sevHigh, sevMedium, sevLow].forEach(cb => cb && cb.addEventListener('change', render));
if (searchBox) searchBox.addEventListener('input', render);
if (clearSearch) clearSearch.addEventListener('click', () => { searchBox.value = ''; render(); });

function getVisibleItems() {
  const activeBands = new Set();
  if (sevHigh?.checked) activeBands.add('high');
  if (sevMedium?.checked) activeBands.add('medium');
  if (sevLow?.checked) activeBands.add('low');
  const term = searchBox?.value?.trim().toLowerCase() || '';
  return allItems.filter(it => {
    const band = it?.severity?.band || 'unknown';
    if (!activeBands.has(band) && band !== 'unknown') return false;
    if (term) {
      const name = getVesselName(it).toLowerCase();
      if (!name.includes(term)) return false;
    }
    return true;
  });
}

function render() {
  const noDataBanner = document.getElementById('noDataBanner');
  const filtered = getVisibleItems();

  const initial = [];
  const completed = [];
  const reassess = [];
  for (const it of filtered) {
    const needsRe = Boolean(it?.needsReassessment);
    const hasAlerts = Array.isArray(it?.alerts) && it.alerts.some(a => a && a.acknowledged === false);
    const reqReassess = needsRe || hasAlerts;
    const isCompleted = Boolean(it?.completed || it?.status === 'completed' || it?.phase3 || it?.finalizedAt);
    if (reqReassess) reassess.push(it);
    else if (isCompleted) completed.push(it);
    else initial.push(it);
  }

  const valOf = o => isFiniteNum(o?.severity?.value) ? o.severity.value : -Infinity;
  const bySeverity = (a, b) => valOf(b) - valOf(a);
  initial.sort(bySeverity);
  completed.sort(bySeverity);
  reassess.sort(bySeverity);

  drawList(initialList, initial);
  drawList(completedList, completed);
  drawList(reassessList, reassess);

  if (initialCount) initialCount.textContent = String(initial.length);
  if (completedCount) completedCount.textContent = String(completed.length);
  if (reassessCount) reassessCount.textContent = String(reassess.length);

  if (noDataBanner) noDataBanner.classList.toggle('hidden', allItems.length !== 0);
  if (noInitial) noInitial.classList.toggle('hidden', initial.length !== 0);
  if (noCompleted) noCompleted.classList.toggle('hidden', completed.length !== 0);
  if (noReassess) noReassess.classList.toggle('hidden', reassess.length !== 0);

  clearMarkers();
  for (const it of filtered) upsertMarker(it);

  if (visibleCounts) visibleCounts.textContent = `${filtered.length} of ${allItems.length}`;
}

function drawList(container, items) {
  if (!container) return;
  container.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('div');
    li.className = 'list-item flex items-center justify-between gap-3';
    const band = it?.severity?.band || 'unknown';
    const vessel = escapeHtml(getVesselName(it));
    const sv = it?.severity?.value;
    const svTxt = isFiniteNum(sv) ? sv.toFixed(2) : 'N/A';
    li.innerHTML = `
      <div class="min-w-0">
        <div class="text-sm font-semibold text-gray-900 truncate">${vessel || 'Unknown'}</div>
        <div class="text-xs text-gray-500">Severity: ${band.toUpperCase()} ${svTxt}</div>
      </div>
      <span class="pill ${band}">${band.toUpperCase()}</span>
    `;
    li.addEventListener('click', () => openReport(it));
    container.appendChild(li);
  }
}

// Open report
function openReport(item) {
  currentItem = item;
  currentDocId = item?.id || null;
  const vessel = getVesselName(item);
  if (reportTitle) reportTitle.textContent = vessel || 'Assessment';

  // Render body
  if (hasUnifiedV2(item)) {
    const html = renderReportV2HTML(item);
    lastRenderedHtml = html;
    reportContent.innerHTML = html;
    renderRadarV2(item);
  } else {
    const html = buildReportHtml(item);
    lastRenderedHtml = html;
    reportContent.innerHTML = html;
    renderRadarGeneric(item);
  }

  // Populate phase 2 input
  if (phase2Input) {
    const p2 = deepGet(item, 'phase2.summary') || '';
    phase2Input.value = getText(p2) || '';
  }
  // Load gallery
  refreshGallery();

  // Load feedback list
  renderFeedbackList(item);

  reportContainer.classList.remove('hidden');
  reportContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Gallery
function galleryPathFor(docId) {
  return `artifacts/${appId}/public/uploads/${docId}/phase2`;
}
async function refreshGallery() {
  if (!galleryGrid || !currentDocId) return;
  galleryGrid.innerHTML = '';
  galleryEmpty?.classList.add('hidden');

  try {
    const basePath = galleryPathFor(currentDocId);
    const listRef = storageRef(storage, basePath);
    const res = await listAll(listRef);
    if (!res.items.length) {
      galleryEmpty?.classList.remove('hidden');
      return;
    }
    for (const itemRef of res.items) {
      const url = await getDownloadURL(itemRef);
      const name = itemRef.name || 'file';
      const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
      const tile = document.createElement('div');
      tile.className = 'gallery-tile';
      if (isImg) {
        tile.innerHTML = `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escapeHtml(name)}" loading="lazy"></a>`;
      } else {
        tile.innerHTML = `<a class="file-tile" href="${url}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
      }
      galleryGrid.appendChild(tile);
    }
  } catch (e) {
    if (galleryEmpty) {
      galleryEmpty.textContent = 'No images uploaded or unable to load gallery.';
      galleryEmpty.classList.remove('hidden');
    }
  }
}

// Phase 2 actions
async function savePhase2() {
  if (!currentDocId) { phase2Status.textContent = 'Open a report first.'; return; }
  const txt = phase2Input.value.trim();
  phase2Status.textContent = 'Saving...';
  try {
    const ref = doc(db, assessmentsPath, currentDocId);
    await updateDoc(ref, { 'phase2.summary': txt, 'phase2.updatedAt': serverTimestamp() });
    phase2Status.textContent = 'Saved.';
    setTimeout(() => phase2Status.textContent = '', 1500);
  } catch (e) {
    phase2Status.textContent = 'Save failed.';
  }
}

async function uploadFiles() {
  if (!currentDocId) { uploadStatus.textContent = 'Open a report first.'; return; }
  const files = Array.from(phase2Files?.files || []);
  if (!files.length) { uploadStatus.textContent = 'Choose files first.'; return; }
  uploadStatus.textContent = `Uploading ${files.length} file(s)...`;
  try {
    const base = galleryPathFor(currentDocId);
    const refDoc = doc(db, assessmentsPath, currentDocId);
    let done = 0;
    for (const f of files) {
      const path = `${base}/${Date.now()}_${f.name.replace(/[^\w.\-]+/g,'_')}`;
      const ref = storageRef(storage, path);
      await uploadBytes(ref, f, { contentType: f.type || undefined });
      const url = await getDownloadURL(ref);
      // Store attachment metadata on doc
      await updateDoc(refDoc, {
        'phase2.assets': arrayUnion({
          name: f.name,
          path, url,
          contentType: f.type || '',
          bytes: f.size || 0,
          uploadedAt: serverTimestamp()
        })
      });
      done++;
      uploadStatus.textContent = `Uploaded ${done}/${files.length}`;
    }
    phase2Files.value = '';
    await refreshGallery();
    setTimeout(() => uploadStatus.textContent = 'Upload complete.', 500);
    setTimeout(() => uploadStatus.textContent = '', 1500);
  } catch (e) {
    uploadStatus.textContent = 'Upload failed.';
  }
}

async function reassessWithPhase2() {
  if (!currentDocId) { phase2Status.textContent = 'Open a report first.'; return; }
  phase2Status.textContent = 'Submitting reassessment...';
  const payload = { docId: currentDocId, usePhase2: true, normalize: true };
  try {
    if (reassessWerpsFn) {
      await reassessWerpsFn(payload);
    } else {
      await repairWerpsFn(payload);
    }
    phase2Status.textContent = 'Reassessment started. Refreshing...';
    // Allow backend to update, then reload this one doc
    setTimeout(async () => {
      const ref = doc(db, assessmentsPath, currentDocId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        currentItem = { ...snap.data(), id: currentDocId };
        openReport(currentItem);
      }
      phase2Status.textContent = 'Reassessment complete.';
      setTimeout(() => phase2Status.textContent = '', 2000);
    }, 1500);
  } catch (e) {
    phase2Status.textContent = 'Reassessment failed.';
  }
}
savePhase2Btn?.addEventListener('click', savePhase2);
uploadFilesBtn?.addEventListener('click', uploadFiles);
reassessBtn?.addEventListener('click', reassessWithPhase2);

// Feedback (per-report)
function renderFeedbackList(item) {
  if (!feedbackList) return;
  feedbackList.innerHTML = '';
  const entries = Array.isArray(item?.feedback) ? [...item.feedback] : [];
  entries.sort((a,b) => (b?.createdAt?.seconds || 0) - (a?.createdAt?.seconds || 0));
  const fmt = (ts) => {
    try { if (ts?.seconds) return new Date(ts.seconds * 1000).toLocaleString(); if (typeof ts === 'number') return new Date(ts).toLocaleString(); } catch {}
    return '';
  };
  for (const e of entries.slice(0, 12)) {
    const who = escapeHtml(e?.user || 'Unknown');
    const when = fmt(e?.createdAt) || '';
    const msg = escapeHtml(e?.message || '');
    const li = document.createElement('li');
    li.className = 'p-2 bg-gray-50 border border-gray-200 rounded';
    li.innerHTML = `<div class="text-xs text-gray-600 mb-1">${who}${when ? ' • '+when : ''}</div><div class="text-sm">${msg}</div>`;
    feedbackList.appendChild(li);
  }
}
async function saveFeedback() {
  if (!currentDocId) { feedbackStatus.textContent = 'Open a report first.'; return; }
  const msg = feedbackInput.value.trim();
  if (!msg) { feedbackStatus.textContent = 'Enter feedback text.'; return; }
  const user = auth.currentUser;
  const who = user?.email || user?.uid || 'anonymous';
  feedbackStatus.textContent = 'Saving...';
  try {
    const ref = doc(db, assessmentsPath, currentDocId);
    await updateDoc(ref, {
      feedback: arrayUnion({
        message: msg,
        user: who,
        createdAt: serverTimestamp()
      })
    });
    if (!Array.isArray(currentItem.feedback)) currentItem.feedback = [];
    currentItem.feedback.unshift({ message: msg, user: who, createdAt: { seconds: Math.floor(Date.now()/1000) } });
    renderFeedbackList(currentItem);
    feedbackInput.value = '';
    feedbackStatus.textContent = 'Saved.';
    setTimeout(() => feedbackStatus.textContent = '', 1500);
  } catch (e) {
    feedbackStatus.textContent = 'Save failed.';
  }
}
saveFeedbackBtn?.addEventListener('click', saveFeedback);

// Auth UI
document.getElementById('signInEmailBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  authMessage.textContent = '';
  try { await signInWithEmailAndPassword(auth, email, password); }
  catch (e) { authMessage.textContent = e.message || 'Sign-in failed.'; }
});
document.getElementById('createAccountBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  authMessage.textContent = '';
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    try {
      await setDoc(doc(db, `artifacts/${appId}/private/users/${cred.user.uid}`), {
        email, role: 'user', createdAt: serverTimestamp()
      }, { merge: true });
    } catch {}
    authMessage.textContent = 'Account created. You are signed in as User.';
  } catch (e) {
    authMessage.textContent = e.message || 'Account creation failed.';
  }
});
document.getElementById('resetPasswordBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('emailInput').value.trim();
  if (!email) { authMessage.textContent = 'Enter your email first.'; return; }
  try { await sendPasswordResetEmail(auth, email); authMessage.textContent = 'Password reset email sent.'; }
  catch (e) { authMessage.textContent = e.message || 'Password reset failed.'; }
});
signOutBtn?.addEventListener('click', async () => { try { await signOut(auth); } catch {} });

// Role helper
async function fetchRoleFor(uid) {
  try {
    const allowDocRef = doc(db, 'system', 'allowlist', 'users', uid);
    const allowDoc = await getDoc(allowDocRef);
    if (allowDoc.exists()) {
      const d = allowDoc.data() || {};
      let r = d.role ?? d.Role ?? d.ROLE;
      if (typeof r === 'string' && r.trim()) {
        r = r.trim().toLowerCase();
        if (r.startsWith('admin')) return 'admin';
        if (r.startsWith('contrib')) return 'contributor';
        if (r === 'user' || r === 'reader' || r === 'viewer') return 'user';
      }
      if (d.admin === true) return 'admin';
      if (d.contributor === true) return 'contributor';
      if (d.allowed === true) return 'user';
    }
  } catch {}

  try {
    const legacyRef = doc(db, `artifacts/${appId}/private/users/${uid}`);
    const legacyDoc = await getDoc(legacyRef);
    if (legacyDoc.exists()) {
      const d = legacyDoc.data() || {};
      let r = d.role ?? d.Role ?? d.ROLE;
      if (typeof r === 'string' && r.trim()) {
        r = r.trim().toLowerCase();
        if (r.startsWith('admin')) return 'admin';
        if (r.startsWith('contrib')) return 'contributor';
        if (r === 'user' || r === 'reader' || r === 'viewer') return 'user';
      }
      if (d.admin === true) return 'admin';
      if (d.contributor === true) return 'contributor';
    }
  } catch {}

  return 'user';
}

// Auth state
onAuthStateChanged(auth, async (user) => {
  if (dataUnsub) { try { dataUnsub(); } catch {} dataUnsub = null; }

  if (!user) {
    signedOutContainer.classList.remove('hidden');
    appContainer.classList.add('hidden');
    adminToolsBtn.classList.add('hidden');
    userNameSpan.classList.add('hidden');
    signOutBtn.classList.add('hidden');
    roleBadge.textContent = 'Role: —';
    analyzeBtn.disabled = true;
    contribHint.classList.remove('hidden');
    return;
  }

  signedOutContainer.classList.add('hidden');
  appContainer.classList.remove('hidden');
  userNameSpan.textContent = user.email || user.uid;
  userNameSpan.classList.remove('hidden');
  signOutBtn.classList.remove('hidden');

  currentRole = await fetchRoleFor(user.uid);
  roleBadge.textContent = `Role: ${currentRole}`;
  const isAdmin = currentRole === 'admin';
  const isContributor = isAdmin || currentRole === 'contributor';
  if (isAdmin) adminToolsBtn.classList.remove('hidden'); else adminToolsBtn.classList.add('hidden');
  analyzeBtn.disabled = !isContributor;
  if (!isContributor) contribHint.classList.remove('hidden'); else contribHint.classList.add('hidden');

  initMap();
  await startData();
});

// Export
function downloadFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function getCurrentHtml() {
  if (!currentItem) return '';
  if (hasUnifiedV2(currentItem)) return lastRenderedHtml || renderReportV2HTML(currentItem);
  return lastRenderedHtml || buildReportHtml(currentItem);
}
function exportHtml() {
  if (!currentItem) return;
  const vessel = getVesselName(currentItem) || 'assessment';
  const html = getCurrentHtml();
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(vessel)}</title></head><body>${html}</body></html>`;
  downloadFile(`${vessel.replace(/\s+/g,'_')}.html`, new Blob([doc], { type: 'text/html;charset=utf-8' }));
}
function exportMarkdown() {
  if (!currentItem) return;
  const vessel = getVesselName(currentItem) || 'assessment';
  const md = buildReportMarkdown(currentItem);
  downloadFile(`${vessel.replace(/\s+/g,'_')}.md`, new Blob([md], { type: 'text/markdown;charset=utf-8' }));
}
function exportJson() {
  if (!currentItem) return;
  const vessel = getVesselName(currentItem) || 'assessment';
  const json = JSON.stringify(currentItem, null, 2);
  downloadFile(`${vessel.replace(/\s+/g,'_')}.json`, new Blob([json], { type: 'application/json;charset=utf-8' }));
}
function exportPdf() {
  if (!currentItem) return;
  const vessel = getVesselName(currentItem) || 'assessment';
  let chartImg = '';
  try {
    const cnv = document.getElementById('werSpiderChart');
    chartImg = cnv?.toDataURL('image/png') || '';
  } catch {}
  const html = `
    <!doctype html><html><head>
      <meta charset="utf-8">
      <title>${escapeHtml(vessel)}</title>
      <style>
        body { font-family: Inter, Arial, sans-serif; color:#111; line-height:1.5; padding:24px; }
        h1,h2,h3,h4 { margin: 0 0 8px; }
        h1 { font-size: 22px; text-align:center; }
        h2 { font-size: 18px; }
        h3 { font-size: 16px; }
        h4 { font-size: 14px; }
        table { width:100%; border-collapse: collapse; margin: 8px 0; }
        th, td { border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; }
        th { background:#f5f5f5; }
        img { max-width: 100%; }
        @media print { @page { size: A4; margin: 12mm; } }
      </style>
    </head><body>
      <h1>${escapeHtml(vessel)}</h1>
      ${getCurrentHtml()}
      ${chartImg ? `<h3>WERP Risk Profile</h3><img src="${chartImg}" alt="Radar chart">` : ''}
    </body></html>
  `;
  const w = window.open('', '_blank');
  if (w) {
    w.document.open(); w.document.write(html); w.document.close();
    w.addEventListener('load', () => { try { w.focus(); w.print(); } catch {} });
    setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 500);
  }
}
exportPdfBtn?.addEventListener('click', exportPdf);
exportHtmlBtn?.addEventListener('click', exportHtml);
exportMdBtn?.addEventListener('click', exportMarkdown);
exportJsonBtn?.addEventListener('click', exportJson);

// Normalize
function normalizeDoc(d) {
  const out = { ...d };
  if (d && typeof d.data === 'object' && d.data) Object.assign(out, d.data);
  if (d && typeof d.payload === 'object' && d.payload) Object.assign(out, d.payload);
  if (d && typeof d.attributes === 'object' && d.attributes) Object.assign(out, d.attributes);
  if (d && typeof d.details === 'object' && d.details) Object.assign(out, d.details);
  if (d && typeof d.meta === 'object' && d.meta) out.meta = { ...d.meta };
  if (d && typeof d.metadata === 'object' && d.metadata) out.metadata = { ...d.metadata };
  return out;
}