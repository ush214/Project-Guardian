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
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, listAll
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

// Optional callable names (use what's available in your functions/)
const repairWerpsFn = httpsCallable(functions, 'repairWerps');
let reassessWerpsFn = null; try { reassessWerpsFn = httpsCallable(functions, 'reassessWerps'); } catch {}

const assessmentsPath = `artifacts/${appId}/public/data/werpassessments`;
const appConfigPathCandidates = [
  `artifacts/${appId}/public/config/werpChart`,
  `artifacts/${appId}/public/config/werpRadarBenchmarks`,
  `artifacts/${appId}/public/config/werp`
];

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

const galleryGrid = document.getElementById('galleryGrid');
const galleryEmpty = document.getElementById('galleryEmpty');
const phase2Input = document.getElementById('phase2Input');
const phase2Files = document.getElementById('phase2Files');
const savePhase2Btn = document.getElementById('savePhase2Btn');
const reassessBtn = document.getElementById('reassessBtn');
const uploadFilesBtn = document.getElementById('uploadFilesBtn');
const phase2Status = document.getElementById('phase2Status');
const uploadStatus = document.getElementById('uploadStatus');

const feedbackInput = document.getElementById('feedbackInput');
const saveFeedbackBtn = document.getElementById('saveFeedbackBtn');
const feedbackStatus = document.getElementById('feedbackStatus');
const feedbackList = document.getElementById('feedbackList');

const exportPdfBtn = document.getElementById('exportPdfBtn');
const exportHtmlBtn = document.getElementById('exportHtmlBtn');
const exportMdBtn = document.getElementById('exportMdBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');

const assessPathSpan = document.getElementById('assessPathSpan');
const appIdSpan = document.getElementById('appIdSpan');
if (appIdSpan) appIdSpan.textContent = appId;
if (assessPathSpan) assessPathSpan.textContent = assessmentsPath;

let currentRole = 'user';
let currentItem = null;
let currentDocId = null;
let map;
let markers = new Map();
let radarChart = null;
let dataUnsub = null;
let allItems = [];
let lastRenderedHtml = '';

let chartConfig = {
  scaleMax: 10,
  benchmarks: { high: 9, medium: 6, low: 3 },
  colors: {
    wreck: 'rgba(79,70,229,0.45)', wreckBorder: 'rgba(79,70,229,1)',
    high: 'rgba(239,68,68,0.12)', highBorder: 'rgba(239,68,68,0.8)',
    medium: 'rgba(245,158,11,0.12)', mediumBorder: 'rgba(245,158,11,0.8)',
    low: 'rgba(16,185,129,0.12)', lowBorder: 'rgba(16,185,129,0.8)'
  }
};

// Utils
const escapeHtml = s => String(s||"").replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isFiniteNum = n => typeof n === 'number' && Number.isFinite(n);
const toNum = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const getText = v => { if (v == null) return null; const s = String(v).trim(); return s.length ? s : null; };
const deepGet = (obj, path) => path.split('.').reduce((a,k)=> (a && a[k]!==undefined)?a[k]:undefined, obj);
const flattenEntries = (obj, maxDepth = 4) => {
  const out = [];
  (function rec(cur, path, depth){
    if (cur === null || cur === undefined) return;
    if (typeof cur !== 'object' || depth > maxDepth) { out.push([path, cur]); return; }
    const keys = Object.keys(cur); if (!keys.length) out.push([path, cur]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      if (typeof cur[k] === 'object' && cur[k] !== null) rec(cur[k], p, depth + 1);
      else out.push([p, cur[k]]);
    }
  })(obj, '', 0);
  return out;
};

function sanitizeReportHtml(html) {
  let safe = DOMPurify.sanitize(html || '', {
    RETURN_TRUSTED_TYPE: false, WHOLE_DOCUMENT: false, USE_PROFILES: { html: true },
    FORBID_TAGS: ['script','style','link'], FORBID_ATTR: ['style','onerror','onload']
  });
  safe = safe.replace(/<(p|div)>\s*(?:&nbsp;|\u00A0|\s|<br\s*\/?>)*<\/\1>/gi, '')
             .replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>');
  return safe;
}
function renderMarkdown(md) { try { return sanitizeReportHtml(marked.parse(md || '')); } catch { return `<p>${escapeHtml(md||'')}</p>`; } }
function extractHtml(val) {
  if (typeof val === 'string') { const s = val.trim(); if (s) return sanitizeReportHtml(`<p>${escapeHtml(s).replace(/\n/g,'<br>')}</p>`); return null; }
  if (val == null) return null;
  if (typeof val === 'object') {
    const html = getText(val.html); if (html) return sanitizeReportHtml(html);
    const md = getText(val.markdown ?? val.md); if (md) return renderMarkdown(md);
    const text = getText(val.text ?? val.content ?? val.value ?? val.body ?? val.summary);
    if (text) return sanitizeReportHtml(`<p>${escapeHtml(text).replace(/\n/g,'<br>')}</p>`);
    const parts = Array.isArray(val.parts) ? val.parts : Array.isArray(val.content) ? val.content : null;
    if (parts) { const chunk = parts.map(p => typeof p === 'string' ? p : (p?.text ?? p?.content ?? p?.markdown ?? p?.html ?? ''))
                                    .filter(Boolean).join('\n\n').trim();
                 if (chunk) return extractHtml(chunk); }
  }
  if (Array.isArray(val)) { const chunks = val.map(extractHtml).filter(Boolean); if (chunks.length) return chunks.join('\n'); }
  return null;
}
function extractPlain(val) {
  if (typeof val === 'string') return val.trim() || null;
  if (val == null) return null;
  if (typeof val === 'object') {
    const text = getText(val.text ?? val.content ?? val.value ?? val.summary ?? val.body); if (text) return text;
    const md = getText(val.markdown ?? val.md); if (md) return md;
    const html = getText(val.html); if (html) { const tmp = document.createElement('div'); tmp.innerHTML = sanitizeReportHtml(html); return tmp.textContent?.trim() || null; }
  }
  if (Array.isArray(val)) for (const v of val) { const t = extractPlain(v); if (t) return t; }
  return null;
}
function readNumberByPaths(obj, paths) {
  for (const p of paths) {
    const v = deepGet(obj, p);
    if (v == null) continue;
    if (typeof v === 'number') { if (Number.isFinite(v)) return v; }
    if (typeof v === 'string') {
      const m = v.match(/-?\d+(\.\d+)?/); if (m) { const n = Number(m[0]); if (Number.isFinite(n)) return n; }
    }
  }
  return null;
}
function clamp(v, min, max) { const n = Number(v); if (!Number.isFinite(n)) return min; return Math.max(min, Math.min(max, n)); }

// v2 detection and totals
function hasUnifiedV2(item) {
  return Array.isArray(item?.wcs?.parameters)
      && Array.isArray(item?.phs?.parameters)
      && Array.isArray(item?.esi?.parameters)
      && (Array.isArray(item?.rpm?.factors) || Array.isArray(item?.rpm?.parameters) || isFiniteNum(item?.rpm?.finalMultiplier));
}
function v2Totals(item) {
  // WCS total
  const wParams = Array.isArray(item?.wcs?.parameters) ? item.wcs.parameters : [];
  const wcs = isFiniteNum(item?.wcs?.totalScore)
                ? Number(item.wcs.totalScore)
                : wParams.reduce((s, p) => s + clamp(Number(p?.score)||0, 0, 5), 0);

  // PHS weighted sum
  const pParams = Array.isArray(item?.phs?.parameters) ? item.phs.parameters : [];
  const phs = isFiniteNum(item?.phs?.totalWeightedScore)
                ? Number(item.phs.totalWeightedScore)
                : pParams.reduce((s, p) => s + (clamp(Number(p?.score)||0, 0, 10) * (Number(p?.weight)||0)), 0);

  // ESI
  const eParams = Array.isArray(item?.esi?.parameters) ? item.esi.parameters : [];
  const esi = isFiniteNum(item?.esi?.totalScore)
                ? Number(item.esi.totalScore)
                : eParams.reduce((s, p) => s + clamp(Number(p?.score)||0, 0, 10), 0);
  const esiMax = isFiniteNum(item?.esi?.maxScore) ? Number(item.esi.maxScore) : (eParams.length ? eParams.length * 10 : 30);

  // RPM
  const rpm = resolveRPMMultiplier(item);

  return { wcs, phs: clamp(phs,0,10), esi, esiMax, rpm };
}

// RPM strictly as multiplier
function resolveRPMMultiplier(item) {
  const explicit = toNum(deepGet(item, 'rpm.finalMultiplier')) ?? toNum(deepGet(item, 'RPM.finalMultiplier'));
  if (isFiniteNum(explicit)) return clamp(explicit, 0.5, 2.5);

  const factors = deepGet(item, 'rpm.factors') || deepGet(item, 'RPM.factors') || deepGet(item, 'rpm.parameters');
  if (Array.isArray(factors) && factors.length) {
    let base = 1.0;
    for (const f of factors) {
      const name = String(f?.name ?? f?.factor ?? '').toLowerCase();
      let v = toNum(f?.value); if (!isFiniteNum(v)) continue;
      if (name.includes('chemical')) v = Math.min(v, 1.2);
      else if (name.includes('thermal') || name.includes('warming') || name.includes('temperature')) v = Math.min(v, 1.4);
      else if (name.includes('physical') || name.includes('seismic') || name.includes('storm') || name.includes('current')) v = Math.min(v, 1.4);
      else v = Math.min(v, 1.4);
      base += Math.max(v - 1.0, 0);
    }
    return clamp(base, 0.5, 2.5);
  }

  const generic = toNum(deepGet(item, 'rpm')) ?? toNum(deepGet(item, 'RPM')) ?? toNum(deepGet(item, 'scores.RPM'));
  if (isFiniteNum(generic)) return clamp(generic, 0.5, 2.5);

  return 1.0;
}

// Severity prefers v2 totals when available
function computeFormulaSeverity(item) {
  if (hasUnifiedV2(item)) {
    const v = v2Totals(item);
    return (v.wcs + v.phs + (v.esi / 3)) * v.rpm;
  }
  const W = readNumberByPaths(item, ['scores.WCS','wcs','WCS','phase1.screening.WCS','phase2.scores.WCS']) ?? 0;
  const P = readNumberByPaths(item, ['scores.PHS','phs','PHS','phase1.screening.PHS','phase2.scores.PHS']) ?? 0;
  const E = readNumberByPaths(item, ['scores.ESI','esi','ESI','phase1.screening.ESI','phase2.scores.ESI']) ?? 0;
  const R = resolveRPMMultiplier(item);
  return (W + P + (E / 3)) * R;
}
function bandFromValue(val){ const v = Number(val); if (!Number.isFinite(v)) return 'unknown'; if (v >= 7.5) return 'high'; if (v >= 4) return 'medium'; return 'low'; }
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
    id: 'mapbox/streets-v12', tileSize: 512, zoomOffset: -1, accessToken: MAPBOX_TOKEN,
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
  const id = item?.id; if (!id) return;
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
    m.setLatLng(pos); m.setIcon(markerIconFor(band)); m.setPopupContent(popupHtml);
  } else {
    const m = L.marker(pos, { icon: markerIconFor(band) }).addTo(map).bindPopup(popupHtml);
    markers.set(id, m);
  }
}
function clearMarkers(){ for (const m of markers.values()){ try { map.removeLayer(m); } catch {} } markers = new Map(); }

// Radar (generic; RPM scaled visually)
function getAxisScores(item) {
  let w, p, e;
  if (hasUnifiedV2(item)) {
    const v = v2Totals(item);
    w = v.wcs; p = v.phs; e = v.esi;
  } else {
    w = readNumberByPaths(item, ['wcs','scores.WCS','WCS','phase1.screening.WCS','phase2.scores.WCS']) ?? 0;
    p = readNumberByPaths(item, ['phs','scores.PHS','PHS','phase1.screening.PHS','phase2.scores.PHS']) ?? 0;
    e = readNumberByPaths(item, ['esi','scores.ESI','ESI','phase1.screening.ESI','phase2.scores.ESI']) ?? 0;
  }
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
  const ctx = document.getElementById('werSpiderChart')?.getContext('2d'); if (!ctx) return;
  const labels = ['WCS', 'PHS', 'ESI', 'RPM'];
  const wreck = getAxisScores(item);
  const max = chartConfig.scaleMax || 10;
  const b = chartConfig.benchmarks;

  const ring = (val, label, bg, border) => ({ label, data: [val,val,val,val], fill: true, backgroundColor: bg, borderColor: border, pointRadius: 0, borderWidth: 1 });

  const data = {
    labels,
    datasets: [
      ring(b.high, 'Benchmark High', chartConfig.colors.high, chartConfig.colors.highBorder),
      ring(b.medium, 'Benchmark Medium', chartConfig.colors.medium, chartConfig.colors.mediumBorder),
      ring(b.low, 'Benchmark Low', chartConfig.colors.low, chartConfig.colors.lowBorder),
      { label: 'Wreck Risk', data: wreck, fill: true, backgroundColor: chartConfig.colors.wreck, borderColor: chartConfig.colors.wreckBorder, pointBackgroundColor: chartConfig.colors.wreckBorder, pointBorderColor: '#fff' }
    ]
  };
  const options = { responsive: true, maintainAspectRatio: false, scales: { r: { beginAtZero: true, min: 0, max, ticks: { stepSize: Math.max(1, Math.round(max/5)) } } }, plugins: { legend: { display: true, position: 'bottom' } }, animation: { duration: 250 } };

  if (radarChart) radarChart.destroy();
  radarChart = new Chart(ctx, { type: 'radar', data, options });
  renderBenchLegend();
}

// Radar for v2 (0–20 scaling like your earlier version)
function renderRadarV2(item) {
  const ctx = document.getElementById('werSpiderChart')?.getContext('2d'); if (!ctx) return;
  const v = v2Totals(item);
  const wcs20 = Math.max(0, Math.min(20, v.wcs));
  const phs20 = Math.max(0, Math.min(20, (v.phs / 10) * 20));
  const esi20 = Math.max(0, Math.min(20, (v.esi / (v.esiMax || 30)) * 20));
  const rpm20 = Math.max(0, Math.min(20, ((Math.min(Math.max(v.rpm, 0.5), 2.5) - 0.5) / 2.0) * 20));

  const profile = [wcs20, phs20, esi20, rpm20];
  const lowCap = [6,6,6,6], medCap = [12,12,12,12], highCap = [20,20,20,20];

  if (radarChart) radarChart.destroy();
  radarChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: ['WCS','PHS','ESI','RPM'],
      datasets: [
        { label: 'Low benchmark', data: lowCap, backgroundColor: 'rgba(16,185,129,0.18)', borderColor: 'rgba(16,185,129,0.45)', pointRadius: 0, order: 1 },
        { label: 'Medium benchmark', data: medCap, backgroundColor: 'rgba(245,158,11,0.14)', borderColor: 'rgba(245,158,11,0.45)', pointRadius: 0, fill: '-1', order: 2 },
        { label: 'High benchmark', data: highCap, backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.45)', pointRadius: 0, fill: '-1', order: 3 },
        { label: 'Risk Profile', data: profile, backgroundColor: 'rgba(30,64,175,0.22)', borderColor: 'rgba(30,64,175,1)', pointBackgroundColor: 'rgba(30,64,175,1)', order: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { r: { suggestedMin: 0, suggestedMax: 20, ticks: { stepSize: 4 } } } }
  });
  if (benchLegend) benchLegend.textContent = 'Low/Medium/High rings shown for orientation (0–20 scale)';
}

// Vessel name
function getVesselName(it) {
  const direct = [it.vesselName, it.name, it.title, it.displayName, it.label, it.vessel?.name, it.ship?.name, it.wreck?.name, it.wreckName, it.shipName, it.meta?.vesselName, it.metadata?.vesselName, it.phase1?.screening?.vesselName];
  for (const c of direct) { const t = getText(c); if (t) return t; }
  const pairs = flattenEntries(it, 2);
  const keyRx = /(vessel|wreck|ship|name|title)/i;
  for (const [k, v] of pairs) { if (!keyRx.test(k)) continue; const t = getText(v); if (t) return t; }
  return getText(it.id) || 'Unknown';
}

// Overview data (table)
function extractAxisDetails(item) {
  const details = { WCS:{score:null,rationale:null}, PHS:{score:null,rationale:null}, ESI:{score:null,rationale:null}, RPM:{score:null,rationale:null} };

  if (hasUnifiedV2(item)) {
    const v = v2Totals(item);
    details.WCS.score = v.wcs;
    details.PHS.score = v.phs;
    details.ESI.score = v.esi;
    details.RPM.score = v.rpm;
  } else {
    details.WCS.score = readNumberByPaths(item, ['scores.WCS','wcs','WCS','phase1.screening.WCS']);
    details.PHS.score = readNumberByPaths(item, ['scores.PHS','phs','PHS','phase1.screening.PHS']);
    details.ESI.score = readNumberByPaths(item, ['scores.ESI','esi','ESI','phase1.screening.ESI']);
    details.RPM.score = resolveRPMMultiplier(item);
  }

  const flat = flattenEntries(item, 4);
  const ratRx = /(rationale|justification|reason|explanation|basis|notes|comment|detail|narrative)/i;
  for (const ax of ['WCS','PHS','ESI','RPM']) {
    for (const [path, value] of flat) {
      if (!path?.toUpperCase().includes(ax)) continue;
      if (!ratRx.test(path)) continue;
      const t = extractPlain(value);
      if (t) { details[ax].rationale = t; break; }
    }
  }
  return details;
}

// Screening narratives
function renderScreeningSections(item) {
  const sections = [];
  const carriers = [ item?.screening, item?.phase1?.screening ];
  const seen = new Set();
  const pushSection = (title, htmlOrText) => { const html = extractHtml(htmlOrText); if (!html) return; const key = `${title}|${html}`; if (seen.has(key)) return; sections.push(`<h3>${escapeHtml(title)}</h3>`); sections.push(html); seen.add(key); };
  for (const sc of carriers) {
    if (!sc || typeof sc !== 'object') continue;
    const candidates = { 'Screening Summary': sc.summary, 'Rationale': sc.rationale, 'Methodology': sc.methodology, 'Assumptions': sc.assumptions, 'Limitations': sc.limitations, 'Data Sources': sc.sources ?? sc.dataSources };
    for (const [title, val] of Object.entries(candidates)) pushSection(title, val);
  }
  return sections.join('\n');
}

// Report builders
function buildReportHtml(item) {
  const blocks = [];
  const summaryHtml = extractHtml(item?.summary) || extractHtml(item?.phase1?.summary);
  if (summaryHtml) { blocks.push('<h3>Summary</h3>', summaryHtml); }

  // Factor summary table
  const d = extractAxisDetails(item);
  const row = (k, o) => `<tr><th style="white-space:nowrap">${k}${k==='RPM'?' (multiplier)':''}</th><td style="width:100px">${isFiniteNum(o.score)?o.score.toFixed(2):'—'}</td><td>${extractHtml(o.rationale) || ''}</td></tr>`;
  blocks.push(`
    <h3>Factor Scores and Rationale</h3>
    <table>
      <thead><tr><th>Factor</th><th>Score</th><th>Rationale</th></tr></thead>
      <tbody>
        ${row('WCS', d.WCS)}
        ${row('PHS', d.PHS)}
        ${row('ESI', d.ESI)}
        ${row('RPM', d.RPM)}
      </tbody>
    </table>
  `);

  const screeningHtml = renderScreeningSections(item);
  if (screeningHtml) blocks.push(screeningHtml);
  return blocks.join('\n');
}

function renderReportV2HTML(item) {
  const v = v2Totals(item);
  // Add a compact v2 summary table up front
  const summaryTable = `
    <h3>Factor Scores Summary (v2)</h3>
    <table>
      <thead><tr><th>Factor</th><th>Score</th><th>Scale</th></tr></thead>
      <tbody>
        <tr><th>WCS</th><td>${v.wcs.toFixed(2)}</td><td>0–20</td></tr>
        <tr><th>PHS</th><td>${v.phs.toFixed(2)}</td><td>0–10</td></tr>
        <tr><th>ESI</th><td>${v.esi.toFixed(2)}</td><td>0–${v.esiMax}</td></tr>
        <tr><th>RPM</th><td>${v.rpm.toFixed(2)}×</td><td>multiplier</td></tr>
      </tbody>
    </table>
  `;

  // Then the detailed breakdown sections like before
  const wcsRows = (item?.wcs?.parameters ?? []).map(p => `<tr><td>${escapeHtml(p?.name ?? p?.parameter ?? '')}</td><td>${escapeHtml(p?.rationale ?? '')}</td><td>${escapeHtml(String(p?.score ?? ''))}</td></tr>`).join('');
  const phsRows = (item?.phs?.parameters ?? []).map(p => `<tr><td>${escapeHtml(p?.name ?? p?.parameter ?? '')}</td><td>${escapeHtml(String(p?.weight ?? ''))}</td><td>${escapeHtml(p?.rationale ?? '')}</td><td>${escapeHtml(String(p?.score ?? ''))}</td></tr>`).join('');
  const esiRows = (item?.esi?.parameters ?? []).map(p => `<tr><td>${escapeHtml(p?.name ?? p?.parameter ?? '')}</td><td>${escapeHtml(p?.rationale ?? '')}</td><td>${escapeHtml(String(p?.score ?? ''))}</td></tr>`).join('');
  const rpmRows = (item?.rpm?.factors ?? item?.rpm?.parameters ?? []).map(f => `<tr><td>${escapeHtml(f?.name ?? f?.factor ?? '')}</td><td>${escapeHtml(f?.rationale ?? 'Not specified.')}</td><td>${escapeHtml(String(f?.value ?? ''))}</td></tr>`).join('');

  return `
    ${summaryTable}

    <section>
      <h3>Phase 3: WCS (Hull & Structure)</h3>
      <table><thead><tr><th>Parameter</th><th>Rationale</th><th>Score (0–5)</th></tr></thead><tbody>${wcsRows}</tbody></table>
      <p class="mt-2"><strong>Total:</strong> ${v.wcs} / 20</p>
    </section>

    <section>
      <h3>Phase 3: PHS (Pollution Hazard)</h3>
      <p class="text-xs text-gray-600 mb-2">Weights: Fuel 0.40, Ordnance 0.25, Vessel Integrity 0.20, Hazardous Materials 0.15.</p>
      <table><thead><tr><th>Parameter</th><th>Weight</th><th>Rationale</th><th>Score (0–10)</th></tr></thead><tbody>${phsRows}</tbody></table>
      <p class="mt-2"><strong>Total Weighted Score:</strong> ${v.phs.toFixed(2)} / 10</p>
    </section>

    <section>
      <h3>Phase 3: ESI (Environmental Sensitivity)</h3>
      <table><thead><tr><th>Parameter</th><th>Rationale</th><th>Score (0–10)</th></tr></thead><tbody>${esiRows}</tbody></table>
      <p class="mt-2"><strong>Total:</strong> ${v.esi} / ${v.esiMax}</p>
    </section>

    <section>
      <h3>Phase 3: RPM (Release Probability Modifier)</h3>
      ${rpmRows ? `<table><thead><tr><th>Factor</th><th>Rationale</th><th>Value</th></tr></thead><tbody>${rpmRows}</tbody></table>` : '<p class="text-gray-600">No factor breakdown provided.</p>'}
      <p class="mt-2"><strong>Final Multiplier:</strong> ${v.rpm.toFixed(2)}× <span class="text-xs text-gray-500">(1.00 baseline)</span></p>
    </section>
  `;
}

// Markdown (used for export)
function buildReportMarkdown(item) {
  const lines = [];
  const vessel = getVesselName(item);
  lines.push(`# ${vessel}`);
  const d = extractAxisDetails(item);
  lines.push('\n## Factor Scores and Rationale');
  lines.push('| Factor | Score | Rationale |');
  lines.push('|---|---:|---|');
  const row = (k, o) => `| ${k}${k==='RPM'?' (multiplier)':''} | ${isFiniteNum(o.score)?o.score.toFixed(2):'—'} | ${(extractPlain(o.rationale) || '').replace(/\n/g,'<br>')} |`;
  lines.push(row('WCS', d.WCS));
  lines.push(row('PHS', d.PHS));
  lines.push(row('ESI', d.ESI));
  lines.push(row('RPM', d.RPM));
  return lines.join('\n');
}

// Data
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
      d.severity = { ...(d.severity || {}), value: sv, band: d.severity?.band || bandFromValue(sv) };
      allItems.push(d);
    });
    render();
  }, (err) => console.error('Snapshot error', err));
}

[sevHigh, sevMedium, sevLow].forEach(cb => cb && cb.addEventListener('change', render));
searchBox?.addEventListener('input', render);
clearSearch?.addEventListener('click', () => { searchBox.value = ''; render(); });

function getVisibleItems() {
  const activeBands = new Set();
  if (sevHigh?.checked) activeBands.add('high');
  if (sevMedium?.checked) activeBands.add('medium');
  if (sevLow?.checked) activeBands.add('low');
  const term = searchBox?.value?.trim().toLowerCase() || '';
  return allItems.filter(it => {
    const band = it?.severity?.band || 'unknown';
    if (!activeBands.has(band) && band !== 'unknown') return false;
    if (term && !getVesselName(it).toLowerCase().includes(term)) return false;
    return true;
  });
}

function render() {
  const filtered = getVisibleItems();

  const initial = [], completed = [], reassess = [];
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
  initial.sort(bySeverity); completed.sort(bySeverity); reassess.sort(bySeverity);

  drawList(initialList, initial);
  drawList(completedList, completed);
  drawList(reassessList, reassess);

  if (initialCount) initialCount.textContent = String(initial.length);
  if (completedCount) completedCount.textContent = String(completed.length);
  if (reassessCount) reassessCount.textContent = String(reassess.length);

  document.getElementById('noDataBanner')?.classList.toggle('hidden', allItems.length !== 0);
  noInitial?.classList.toggle('hidden', initial.length !== 0);
  noCompleted?.classList.toggle('hidden', completed.length !== 0);
  noReassess?.classList.toggle('hidden', reassess.length !== 0);

  clearMarkers(); for (const it of filtered) upsertMarker(it);
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
    const sv = it?.severity?.value; const svTxt = isFiniteNum(sv) ? sv.toFixed(2) : 'N/A';
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

// Report open
function openReport(item) {
  currentItem = item;
  currentDocId = item?.id || null;
  const vessel = getVesselName(item);
  if (reportTitle) reportTitle.textContent = vessel || 'Assessment';

  if (hasUnifiedV2(item)) {
    const html = renderReportV2HTML(item);
    lastRenderedHtml = html; reportContent.innerHTML = html;
    renderRadarV2(item);
  } else {
    const html = buildReportHtml(item);
    lastRenderedHtml = html; reportContent.innerHTML = html;
    renderRadarGeneric(item);
  }

  if (phase2Input) phase2Input.value = getText(deepGet(item, 'phase2.summary')) || '';
  refreshGallery();
  renderFeedbackList(item);

  reportContainer.classList.remove('hidden');
  reportContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Gallery
function galleryPathFor(docId) { return `artifacts/${appId}/public/uploads/${docId}/phase2`; }
async function refreshGallery() {
  if (!galleryGrid || !currentDocId) return;
  galleryGrid.innerHTML = ''; galleryEmpty?.classList.add('hidden');
  try {
    const res = await listAll(storageRef(storage, galleryPathFor(currentDocId)));
    if (!res.items.length) { galleryEmpty?.classList.remove('hidden'); return; }
    for (const itemRef of res.items) {
      const url = await getDownloadURL(itemRef);
      const name = itemRef.name || 'file';
      const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
      const tile = document.createElement('div'); tile.className = 'gallery-tile';
      tile.innerHTML = isImg
        ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escapeHtml(name)}" loading="lazy"></a>`
        : `<a class="file-tile" href="${url}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
      galleryGrid.appendChild(tile);
    }
  } catch {
    galleryEmpty && (galleryEmpty.textContent = 'No images uploaded or unable to load gallery.', galleryEmpty.classList.remove('hidden'));
  }
}

// Phase 2 actions
savePhase2Btn?.addEventListener('click', async () => {
  if (!currentDocId) { phase2Status.textContent = 'Open a report first.'; return; }
  const txt = phase2Input.value.trim();
  phase2Status.textContent = 'Saving...';
  try {
    await updateDoc(doc(db, assessmentsPath, currentDocId), { 'phase2.summary': txt, 'phase2.updatedAt': serverTimestamp() });
    phase2Status.textContent = 'Saved.'; setTimeout(() => phase2Status.textContent = '', 1500);
  } catch { phase2Status.textContent = 'Save failed.'; }
});
uploadFilesBtn?.addEventListener('click', async () => {
  if (!currentDocId) { uploadStatus.textContent = 'Open a report first.'; return; }
  const files = Array.from(phase2Files?.files || []); if (!files.length) { uploadStatus.textContent = 'Choose files first.'; return; }
  uploadStatus.textContent = `Uploading ${files.length} file(s)...`;
  try {
    const base = galleryPathFor(currentDocId);
    const refDoc = doc(db, assessmentsPath, currentDocId);
    let done = 0;
    for (const f of files) {
      const safe = `${Date.now()}_${f.name.replace(/[^\w.\-]+/g,'_')}`;
      const ref = storageRef(storage, `${base}/${safe}`);
      await uploadBytes(ref, f, { contentType: f.type || undefined });
      const url = await getDownloadURL(ref);
      await updateDoc(refDoc, { 'phase2.assets': arrayUnion({ name: f.name, path: `${base}/${safe}`, url, contentType: f.type || '', bytes: f.size || 0, uploadedAt: serverTimestamp() }) });
      done++; uploadStatus.textContent = `Uploaded ${done}/${files.length}`;
    }
    phase2Files.value = ''; await refreshGallery();
    setTimeout(() => uploadStatus.textContent = 'Upload complete.', 500);
    setTimeout(() => uploadStatus.textContent = '', 1500);
  } catch { uploadStatus.textContent = 'Upload failed.'; }
});
reassessBtn?.addEventListener('click', async () => {
  if (!currentDocId) { phase2Status.textContent = 'Open a report first.'; return; }
  phase2Status.textContent = 'Submitting reassessment...';
  try {
    const payload = { docId: currentDocId, usePhase2: true, normalize: true };
    if (reassessWerpsFn) await reassessWerpsFn(payload); else await repairWerpsFn(payload);
    setTimeout(async () => {
      const snap = await getDoc(doc(db, assessmentsPath, currentDocId));
      if (snap.exists()) { currentItem = { ...snap.data(), id: currentDocId }; openReport(currentItem); }
      phase2Status.textContent = 'Reassessment complete.'; setTimeout(() => phase2Status.textContent = '', 2000);
    }, 1500);
  } catch { phase2Status.textContent = 'Reassessment failed.'; }
});

// Feedback
function renderFeedbackList(item) {
  if (!feedbackList) return;
  feedbackList.innerHTML = '';
  const entries = Array.isArray(item?.feedback) ? [...item.feedback] : [];
  entries.sort((a,b) => (b?.createdAt?.seconds || 0) - (a?.createdAt?.seconds || 0));
  const fmt = ts => ts?.seconds ? new Date(ts.seconds*1000).toLocaleString() : '';
  for (const e of entries.slice(0, 12)) {
    const who = escapeHtml(e?.user || 'Unknown'), when = fmt(e?.createdAt) || '', msg = escapeHtml(e?.message || '');
    const li = document.createElement('li'); li.className = 'p-2 bg-gray-50 border border-gray-200 rounded';
    li.innerHTML = `<div class="text-xs text-gray-600 mb-1">${who}${when ? ' • '+when : ''}</div><div class="text-sm">${msg}</div>`;
    feedbackList.appendChild(li);
  }
}
saveFeedbackBtn?.addEventListener('click', async () => {
  if (!currentDocId) { feedbackStatus.textContent = 'Open a report first.'; return; }
  const msg = feedbackInput.value.trim(); if (!msg) { feedbackStatus.textContent = 'Enter feedback text.'; return; }
  const who = auth.currentUser?.email || auth.currentUser?.uid || 'anonymous';
  feedbackStatus.textContent = 'Saving...';
  try {
    await updateDoc(doc(db, assessmentsPath, currentDocId), { feedback: arrayUnion({ message: msg, user: who, createdAt: serverTimestamp() }) });
    if (!Array.isArray(currentItem.feedback)) currentItem.feedback = [];
    currentItem.feedback.unshift({ message: msg, user: who, createdAt: { seconds: Math.floor(Date.now()/1000) } });
    renderFeedbackList(currentItem); feedbackInput.value = ''; feedbackStatus.textContent = 'Saved.'; setTimeout(()=>feedbackStatus.textContent='',1500);
  } catch { feedbackStatus.textContent = 'Save failed.'; }
});

// Auth
document.getElementById('signInEmailBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  authMessage.textContent = '';
  try { await signInWithEmailAndPassword(auth, email, password); } catch (e) { authMessage.textContent = e.message || 'Sign-in failed.'; }
});
document.getElementById('createAccountBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  authMessage.textContent = '';
  try { const cred = await createUserWithEmailAndPassword(auth, email, password);
    try { await setDoc(doc(db, `artifacts/${appId}/private/users/${cred.user.uid}`), { email, role: 'user', createdAt: serverTimestamp() }, { merge: true }); } catch {}
    authMessage.textContent = 'Account created. You are signed in as User.';
  } catch (e) { authMessage.textContent = e.message || 'Account creation failed.'; }
});
document.getElementById('resetPasswordBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('emailInput').value.trim();
  if (!email) { authMessage.textContent = 'Enter your email first.'; return; }
  try { await sendPasswordResetEmail(auth, email); authMessage.textContent = 'Password reset email sent.'; } catch (e) { authMessage.textContent = e.message || 'Password reset failed.'; }
});
signOutBtn?.addEventListener('click', async () => { try { await signOut(auth); } catch {} });

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
        if (['user','reader','viewer'].includes(r)) return 'user';
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
        if (['user','reader','viewer'].includes(r)) return 'user';
      }
      if (d.admin === true) return 'admin';
      if (d.contributor === true) return 'contributor';
    }
  } catch {}
  return 'user';
}

onAuthStateChanged(auth, async (user) => {
  if (dataUnsub) { try { dataUnsub(); } catch {} dataUnsub = null; }
  if (!user) {
    signedOutContainer.classList.remove('hidden'); appContainer.classList.add('hidden');
    adminToolsBtn.classList.add('hidden'); userNameSpan.classList.add('hidden'); signOutBtn.classList.add('hidden');
    roleBadge.textContent = 'Role: —'; analyzeBtn.disabled = true; contribHint.classList.remove('hidden'); return;
  }
  signedOutContainer.classList.add('hidden'); appContainer.classList.remove('hidden');
  userNameSpan.textContent = user.email || user.uid; userNameSpan.classList.remove('hidden'); signOutBtn.classList.remove('hidden');

  currentRole = await fetchRoleFor(user.uid);
  roleBadge.textContent = `Role: ${currentRole}`;
  const isAdmin = currentRole === 'admin'; const isContributor = isAdmin || currentRole === 'contributor';
  if (isAdmin) adminToolsBtn.classList.remove('hidden'); else adminToolsBtn.classList.add('hidden');
  analyzeBtn.disabled = !isContributor; if (!isContributor) contribHint.classList.remove('hidden'); else contribHint.classList.add('hidden');

  initMap();
  await startData();
});

// Export helpers
function downloadFile(filename, blob) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function getCurrentHtml() { if (!currentItem) return ''; if (hasUnifiedV2(currentItem)) return lastRenderedHtml || renderReportV2HTML(currentItem); return lastRenderedHtml || buildReportHtml(currentItem); }
function exportHtml() { if (!currentItem) return; const vessel = getVesselName(currentItem) || 'assessment'; const html = getCurrentHtml(); const docHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(vessel)}</title></head><body>${html}</body></html>`; downloadFile(`${vessel.replace(/\s+/g,'_')}.html`, new Blob([docHtml], { type: 'text/html;charset=utf-8' })); }
function exportMarkdown() { if (!currentItem) return; const vessel = getVesselName(currentItem) || 'assessment'; const md = buildReportMarkdown(currentItem); downloadFile(`${vessel.replace(/\s+/g,'_')}.md`, new Blob([md], { type: 'text/markdown;charset=utf-8' })); }
function exportJson() { if (!currentItem) return; const vessel = getVesselName(currentItem) || 'assessment'; const json = JSON.stringify(currentItem, null, 2); downloadFile(`${vessel.replace(/\s+/g,'_')}.json`, new Blob([json], { type: 'application/json;charset=utf-8' })); }
function exportPdf() {
  if (!currentItem) return;
  const vessel = getVesselName(currentItem) || 'assessment';
  let chartImg = ''; try { const cnv = document.getElementById('werSpiderChart'); chartImg = cnv?.toDataURL('image/png') || ''; } catch {}
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(vessel)}</title><style>body{font-family:Inter,Arial,sans-serif;color:#111;line-height:1.5;padding:24px;}h1,h2,h3,h4{margin:0 0 8px;}table{width:100%;border-collapse:collapse;margin:8px 0;}th,td{border:1px solid #ddd;padding:6px 8px;vertical-align:top;}th{background:#f5f5f5;}</style></head><body><h1>${escapeHtml(vessel)}</h1>${getCurrentHtml()}${chartImg?`<h3>WERP Risk Profile</h3><img src="${chartImg}" alt="Radar chart">`:''}</body></html>`;
  const w = window.open('', '_blank'); if (w) { w.document.open(); w.document.write(html); w.document.close(); w.addEventListener('load', () => { try { w.focus(); w.print(); } catch {} }); setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 500); }
}
exportPdfBtn?.addEventListener('click', exportPdf);
exportHtmlBtn?.addEventListener('click', exportHtml);
exportMdBtn?.addEventListener('click', exportMarkdown);
exportJsonBtn?.addEventListener('click', exportJson);

// Normalize doc helper
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