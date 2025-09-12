// App — prefers cached Storage assets (phase2.assets), falls back to external URLs when needed.
// Fixes included:
// - Robust PHS weights parsing: accepts weightPercent/percent strings and falls back to equal weights
// - Image uploads wired: Upload button + hidden file input -> Storage -> append to phase2.assets
// - Robust coordinate resolver for map markers: supports lon vs lng and nested paths like historical.location.coordinates
// - RPM breakdown reader supports multiple shapes (parameters, factors, breakdown, factorMap, object maps)
// - Assessment details layout: single tile/container with vertical sections and consistent spacing

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp, collection, onSnapshot, arrayUnion, deleteDoc, getDocs
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL
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

const appId = "guardian";
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);
const functions = getFunctions(app, "us-central1");

let callable = { cacheReferenceMedia: null, cacheCollectionReferenceMedia: null, analyzeWerps: null, reassessWerps: null, repairWerps: null };
try { callable.cacheReferenceMedia = httpsCallable(functions, "cacheReferenceMedia"); } catch {}
try { callable.cacheCollectionReferenceMedia = httpsCallable(functions, "cacheCollectionReferenceMedia"); } catch {}
try { callable.analyzeWerps = httpsCallable(functions, "analyzeWerps"); } catch {}
try { callable.reassessWerps = httpsCallable(functions, "reassessWerps"); } catch {}
try { callable.repairWerps = httpsCallable(functions, "repairWerps"); } catch {}

const READ_COLLECTIONS = [
  "artifacts/guardian/public/data/werpassessments",
  "artifacts/guardian-agent-default/public/data/werpassessments"
];
const DEFAULT_WRITE_COLLECTION = "artifacts/guardian-agent-default/public/data/werpassessments";

// DOM
const signedOutContainer = document.getElementById("signedOutContainer");
const appContainer = document.getElementById("appContainer");
const importDataBtn = document.getElementById("importDataBtn");
const userNameSpan = document.getElementById("userName");
const signOutBtn = document.getElementById("signOutBtn");
const roleBadge = document.getElementById("roleBadge");
const contribHint = document.getElementById("contribHint");

const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const signInEmailBtn = document.getElementById("signInEmailBtn");
const createAccountBtn = document.getElementById("createAccountBtn");
const resetPasswordBtn = document.getElementById("resetPasswordBtn");
const authMessage = document.getElementById("authMessage");

const analyzeBtn = document.getElementById("analyzeBtn");
const analyzeText = document.getElementById("analyzeText");
const vesselNameInput = document.getElementById("vesselName");
const statusMessage = document.getElementById("statusMessage");

const sevHigh = document.getElementById("sevHigh");
const sevMedium = document.getElementById("sevMedium");
const sevLow = document.getElementById("sevLow");
const searchBox = document.getElementById("searchBox");
const clearSearch = document.getElementById("clearSearch");
const visibleCounts = document.getElementById("visibleCounts");

const initialList = document.getElementById("initialWreckList");
const completedList = document.getElementById("completedWreckList");
const reassessList = document.getElementById("reassessList");
const initialCount = document.getElementById("initialCount");
const completedCount = document.getElementById("completedCount");
const reassessCount = document.getElementById("reassessCount");
const noInitial = document.getElementById("noInitialWrecksMessage");
const noCompleted = document.getElementById("noCompletedWrecksMessage");
const noReassess = document.getElementById("noReassessMessage");

const reportContainer = document.getElementById("reportContainer");
const reportTitle = document.getElementById("reportTitle");
const reportContent = document.getElementById("reportContent");
const benchLegend = document.getElementById("benchLegend");

const uploadGalleryGrid = document.getElementById("uploadGalleryGrid");
const uploadGalleryEmpty = document.getElementById("uploadGalleryEmpty");
const referenceMediaGrid = document.getElementById("referenceMediaGrid");
const referenceMediaEmpty = document.getElementById("referenceMediaEmpty");

const phase2Input = document.getElementById("phase2Input");
const phase2Files = document.getElementById("phase2Files");
const savePhase2Btn = document.getElementById("savePhase2Btn");
const reassessBtn = document.getElementById("reassessBtn");
const uploadFilesBtn = document.getElementById("uploadFilesBtn");
const phase2Status = document.getElementById("phase2Status");
const uploadStatus = document.getElementById("uploadStatus");

const feedbackInput = document.getElementById("feedbackInput");
const saveFeedbackBtn = document.getElementById("saveFeedbackBtn");
const feedbackStatus = document.getElementById("feedbackStatus");
const feedbackList = document.getElementById("feedbackList");

const exportPdfBtn = document.getElementById("exportPdfBtn");
const exportHtmlBtn = document.getElementById("exportHtmlBtn");
const exportMdBtn = document.getElementById("exportMdBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");

const monitoringBtn = document.getElementById("monitoringBtn");

// State
let currentRole = "user";
let currentItem = null;
let currentDocId = null;
let currentDocPath = READ_COLLECTIONS[0];
let map;
let markers = new Map();
let radarChart = null;
let dataUnsubs = [];
let allItems = [];
let lastRenderedHtml = "";

// Logos for PDF
const LOGO_LEFT = "https://raw.githubusercontent.com/ush214/Logos/main/Screenshot%202025-09-02%20114624.jpg?raw=true";
const LOGO_RIGHT = "https://raw.githubusercontent.com/ush214/Logos/main/DeepTrek.jpg?raw=true";

// Chart config
let chartConfig = {
  scaleMax: 10,
  benchmarks: { high: 9, medium: 6, low: 3 },
  colors: {
    wreck: "rgba(79,70,229,0.45)",
    wreckBorder: "rgba(79,70,229,1)",
    high: "rgba(239,68,68,0.12)",
    highBorder: "rgba(239,68,68,0.8)",
    medium: "rgba(245,158,11,0.12)",
    mediumBorder: "rgba(245,158,11,0.8)",
    low: "rgba(16,185,129,0.12)",
    lowBorder: "rgba(16,185,129,0.8)"
  }
};

// Utils
const escapeHtml = (s) => String(s || "").replace(/[&<>\"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);
const getText = (v) => { if (v == null) return null; const s = String(v).trim(); return s.length ? s : null; };
const deepGet = (obj, path) => path.split(".").reduce((a,k)=> (a && a[k]!==undefined)?a[k]:undefined, obj);

// Robust placeholder (no backticks)
const PLACEHOLDER_SVG = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="100%" height="100%" fill="#f1f5f9"/><text x="50%" y="50%" text-anchor="middle" fill="#64748b" font-size="14" font-family="Arial">No image</text></svg>');

// External image helpers
const WEB_IMG_EXT_RX = /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)(?:\?|#|$)/i;
function isHttpUrl(u) {
  if (typeof u !== "string") return false;
  const s = u.trim();
  if (!s || s.startsWith("data:") || s.startsWith("blob:")) return false;
  return /^https?:\/\//i.test(s);
}
function looksLikeImageUrl(u) {
  return isHttpUrl(u) && WEB_IMG_EXT_RX.test(u);
}
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const k = String(v || "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}
function getExternalImageUrls(item) {
  const urls = [];

  // Primary expected location
  const arr = Array.isArray(item?.media?.images) ? item.media.images : [];
  for (const it of arr) {
    if (!it) continue;
    if (typeof it === "string" && looksLikeImageUrl(it)) {
      urls.push(it);
    } else if (typeof it === "object") {
      const cands = [it.url, it.href, it.src, it.imageUrl, it.thumbnail, it.thumb, it.picture, it.pic];
      for (const c of cands) if (c && looksLikeImageUrl(String(c))) urls.push(String(c));
      if (it.link && typeof it.link === "object") {
        const c2 = [it.link.url, it.link.href, it.link.src];
        for (const c of c2) if (c && looksLikeImageUrl(String(c))) urls.push(String(c));
      }
    }
  }

  // Alternates sometimes present in imports
  const altArrays = [
    item?.media?.photos, item?.media?.gallery,
    item?.images, item?.photos, item?.gallery,
    item?.referenceMedia
  ].filter(Array.isArray);
  for (const arr2 of altArrays) {
    for (const it of arr2) {
      if (!it) continue;
      if (typeof it === "string" && looksLikeImageUrl(it)) urls.push(it);
      else if (typeof it === "object") {
        const cands = [it.url, it.href, it.src, it.imageUrl, it.thumbnail, it.thumb, it.picture, it.pic];
        for (const c of cands) if (c && looksLikeImageUrl(String(c))) urls.push(String(c));
        if (it.link && typeof it.link === "object") {
          const c2 = [it.link.url, it.link.href, it.link.src];
          for (const c of c2) if (c && looksLikeImageUrl(String(c))) urls.push(String(c));
        }
      }
    }
  }

  return dedupe(urls);
}

// Leaflet map
const MAPBOX_TOKEN = "pk.eyJ1IjoidXNoMjE0IiwiYSI6ImNtZmNnZzV1YjFxMG0ybHM2MnI5aGN6bzIifQ.0FPMf68cgCHTCOsolzB1_w";
function initMap() {
  if (map) return;
  map = L.map("map").setView([10, 150], 3);
  L.tileLayer("https://api.mapbox.com/styles/v1/{id}/tiles/{z}/{x}/{y}?access_token={accessToken}", {
    id: "mapbox/satellite-streets-v12", tileSize: 512, zoomOffset: -1, accessToken: MAPBOX_TOKEN,
    attribution: "&copy; OpenStreetMap &copy; Mapbox"
  }).addTo(map);
}
function markerIconFor(band) {
  const color = band === "high" ? "red" : band === "medium" ? "orange" : band === "low" ? "green" : "blue";
  return L.icon({
    iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
    shadowUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-shadow.png",
    iconSize: [25,41], iconAnchor: [12,41], popupAnchor: [1,-34], shadowSize: [41,41]
  });
}

// Coordinates resolver for varied shapes (supports lon vs lng and nesting)
function resolveCoordinates(item) {
  const toNum = (v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // Extract lat/lng from an object or array
  function extract(obj) {
    if (!obj) return null;

    // GeoJSON [lng, lat]
    if (Array.isArray(obj) && obj.length >= 2) {
      const lngA = toNum(obj[0]);
      const latA = toNum(obj[1]);
      if (latA != null && lngA != null) return { lat: latA, lng: lngA };
      // If looks like [lat, lng]
      const latB = toNum(obj[0]);
      const lngB = toNum(obj[1]);
      if (latB != null && lngB != null) return { lat: latB, lng: lngB };
      return null;
    }

    // If object has a nested coordinates field, prefer that
    if (obj.coordinates) {
      const nested = extract(obj.coordinates);
      if (nested) return nested;
    }

    // Try common keys
    const lat = toNum(obj.latitude ?? obj.lat ?? obj.y);
    const lng = toNum(obj.longitude ?? obj.lng ?? obj.lon ?? obj.x);

    if (lat != null && lng != null) return { lat, lng };

    // Some shapes like { latlng: { lat, lng } }
    if (obj.latlng) {
      const ll = extract(obj.latlng);
      if (ll) return ll;
    }
    return null;
  }

  const cands = [
    item?.phase1?.screening?.coordinates,
    item?.coordinates,
    item?.location?.coordinates,
    item?.historical?.location?.coordinates,
    item?.location,
    item?.geo,
    item?.position,
    item?.geometry?.coordinates, // GeoJSON array
    item?.geometry
  ];

  for (const c of cands) {
    const got = extract(c);
    if (got) return got;
  }

  return null;
}

// Marker: prefer cached; fallback external if none
function getMarkerImageUrl(item) {
  const webExt = /\.(png|jpe?g|webp|gif)$/i;
  const assets = Array.isArray(item?.phase2?.assets) ? item.phase2.assets : [];
  const img = assets.find(a => a?.url && webExt.test(String(a?.name || a?.path || "")));
  if (img?.url) return img.url;

  const extUrls = getExternalImageUrls(item);
  return extUrls[0] || null;
}
function upsertMarker(item) {
  const coord = resolveCoordinates(item);
  const id = item?.id;
  if (!id || !coord) return;

  const sv = getSeverityValue(item);
  const band = item?.severity?.band || bandFromValue(sv);
  const pos = [Number(coord.lat), Number(coord.lng)];
  const title = escapeHtml(getVesselName(item));
  const svTxt = isFiniteNum(sv) ? sv.toFixed(2) : "N/A";

  const imgUrl = getMarkerImageUrl(item) || PLACEHOLDER_SVG;
  const imgHtml = `<div style="margin-top:6px"><img src="${imgUrl}" alt="${title}" referrerpolicy="no-referrer" onerror="this.src='${PLACEHOLDER_SVG}'" style="width:220px;height:auto;max-height:180px;object-fit:cover;border:1px solid #ddd;border-radius:6px"></div>`;

  const popupHtml = `
    <div>
      <div style="font-weight:600">${title}</div>
      <div>Severity: ${(band||"").toUpperCase()} ${svTxt}</div>
      ${imgHtml}
    </div>
  `;

  if (markers.has(id)) {
    const m = markers.get(id);
    m.setLatLng(pos); m.setIcon(markerIconFor(band)); m.setPopupContent(popupHtml);
  } else {
    const m = L.marker(pos, { icon: markerIconFor(band) }).addTo(map).bindPopup(popupHtml);
    markers.set(id, m);
  }
}
function clearMarkers() { for (const m of markers.values()) { try { map.removeLayer(m); } catch {} } markers = new Map(); }

// Scoring/helpers
function readNumberByPaths(obj, paths) {
  for (const p of paths) {
    const v = deepGet(obj, p);
    if (v == null) continue;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const m = v.match(/-?\d+(\.\d+)?/);
      if (m) { const n = Number(m[0]); if (Number.isFinite(n)) return n; }
    }
  }
  return null;
}
function hasUnifiedV2(item) {
  return Array.isArray(item?.wcs?.parameters)
      && Array.isArray(item?.phs?.parameters)
      && Array.isArray(item?.esi?.parameters)
      && (Array.isArray(item?.rpm?.factors) || Array.isArray(item?.rpm?.parameters) || isFiniteNum(item?.rpm?.finalMultiplier));
}
function resolveRPMMultiplier(item) {
  const toNum = (v)=>{ const n=Number(v); return Number.isFinite(n)?n:null; };
  const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
  const explicit = toNum(deepGet(item, "rpm.finalMultiplier")) ?? toNum(deepGet(item, "RPM.finalMultiplier"));
  if (Number.isFinite(explicit)) return clamp(explicit, 0.5, 2.5);
  const factors = deepGet(item, "rpm.factors") || deepGet(item, "RPM.factors") || deepGet(item, "rpm.parameters");
  if (Array.isArray(factors) && factors.length) {
    let base = 1.0;
    for (const f of factors) {
      const name = String(f?.name ?? f?.factor ?? "").toLowerCase();
      let v = toNum(f?.value); if (!Number.isFinite(v)) continue;
      if (name.includes("chemical")) v = Math.min(v, 1.2);
      else if (name.includes("thermal") || name.includes("warming") || name.includes("temperature")) v = Math.min(v, 1.4);
      else if (name.includes("physical") || name.includes("seismic") || name.includes("storm") || name.includes("current")) v = Math.min(v, 1.4);
      else v = Math.min(v, 1.4);
      base += Math.max(v - 1.0, 0);
    }
    return clamp(base, 0.5, 2.5);
  }
  const generic = toNum(deepGet(item, "rpm")) ?? toNum(deepGet(item, "RPM")) ?? toNum(deepGet(item, "scores.RPM"));
  if (Number.isFinite(generic)) return clamp(generic, 0.5, 2.5);
  return 1.0;
}
function normalizeWcsParameters(rawParams = []) {
  const params = (Array.isArray(rawParams) ? rawParams : [])
    .map(p => ({ name: String(p?.name ?? p?.parameter ?? "").trim(), rationale: String(p?.rationale ?? "").trim(), score: Number(p?.score) }))
    .filter(p => (p.name || p.rationale) && Number.isFinite(p.score));
  const rawScores = params.map(p => p.score);
  const maxScore = rawScores.length ? Math.max(...rawScores) : 0;
  const scale = maxScore > 5 && maxScore <= 10 ? 10 : 5;
  const scaleNote = maxScore > 5;
  const rx = {
    age: [/\bage\b/i, /\byear/i, /\bbuilt\b/i, /\blaunched\b/i, /\bcommission/i, /\bdecommission/i, /since\s*sink/i, /\bsubmerged\b/i, /\bdecade/i, /\bcentur/i, /\bmodern\b/i],
    vessel: [/\bvessel\b/i, /\bship\b/i, /\bclass\b/i, /\btype\b/i, /\bsize\b/i, /\btonnage\b/i, /\bgrt\b/i, /\bdisplacement\b/i, /\blength\b/i, /\bbeam\b/i, /\bdraft\b/i, /\bauxiliary\b/i, /\boil\b/i],
    trauma: [/\btorpedo/i, /\btype\s*93\b/i, /\bdepth\s*charge/i, /\bmine\b/i, /\bbomb/i, /\bexplosion/i, /\bdetonat/i, /\bshell(hit|ing)?\b/i, /\bgunfire\b/i, /\bcollision\b/i, /\bgrounding\b/i],
    integrity: [/\bstructur/i, /\bintegrit/i, /\bintact\b/i, /\bcollaps/i, /\bfragment/i, /\bbroken\b/i, /\bruptur/i, /\bbuckl/i, /\bcondition\b/i, /\bhull\b/i, /\bsection\b/i, /\bsevered\b/i]
  };
  function matchScore(p, patterns) {
    const name = p.name || "", rat = p.rationale || ""; let s = 0;
    for (const re of (Array.isArray(patterns) ? patterns : [patterns])) { if (re.test(name)) s += 3; if (re.test(rat)) s += 1; }
    return s;
  }
  function best(patterns) { let best = null; for (const p of params) { const s = matchScore(p, patterns); if (s > 0 && (!best || s > best.s)) best = { p, s }; } return best?.p; }
  const picks = { age: best(rx.age), vessel: best(rx.vessel), trauma: best(rx.trauma), integrity: best(rx.integrity) };
  const norm = (v) => !Number.isFinite(v) ? 0 : scale === 10 ? Math.max(0, Math.min(5, v/2)) : Math.max(0, Math.min(5, v));
  let traumaNormalized, traumaRationale = "Not provided.";
  if (picks.trauma) { traumaNormalized = norm(picks.trauma.score); traumaRationale = picks.trauma.rationale || "Not provided."; }
  else if (picks.integrity) {
    const rat = picks.integrity.rationale || "", name = picks.integrity.name || "";
    const looks = rx.trauma.some(re => re.test(rat) || re.test(name));
    traumaNormalized = looks ? 5 : 0; traumaRationale = looks ? (rat || "Derived from integrity rationale.") : "Not provided.";
  } else traumaNormalized = 0;
  const rows = [
    { title: "Age", rationale: picks.age?.rationale || "Not provided.", normalized: norm(picks.age?.score ?? 0) },
    { title: "Vessel Type/Size", rationale: picks.vessel?.rationale || "Not provided.", normalized: norm(picks.vessel?.score ?? 0) },
    { title: "Sinking Trauma", rationale: traumaRationale, normalized: norm(picks.trauma?.score ?? 0) },
    { title: "Current Structural Integrity", rationale: picks.integrity?.rationale || "Not provided.", normalized: norm(picks.integrity?.score ?? 0) }
  ];
  const total = rows.reduce((s, r) => s + (Number(r.normalized) || 0), 0);
  return { rows, total: Number(total.toFixed(2)), scaleNote };
}

// Robust PHS normalizer
function normalizePhsWeights(params = []) {
  function parseScore(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const m = v.match(/-?\d+(\.\d+)?/);
      if (m) return Number(m[0]);
    }
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return NaN;
  }
  function parseWeightFrom(obj) {
    const candidates = [
      "weight", "Weight", "w", "W",
      "weightPct", "weight_percent", "weightPercent",
      "percentage", "percent", "Percent", "Percentage",
      "Weight (%)", "Weight %", "Weight(%)",
      "weightPercent"
    ];
    for (const key of candidates) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
        const raw = obj[key];
        if (typeof raw === "number" && Number.isFinite(raw)) {
          return { value: raw, hadPercent: raw > 1.5 || raw > 100 };
        }
        if (typeof raw === "string") {
          const trimmed = raw.trim();
          const hadPercent = /%/.test(trimmed);
            const num = parseFloat(trimmed.replace("%", ""));
            if (Number.isFinite(num)) return { value: num, hadPercent };
        }
      }
    }
    return { value: NaN, hadPercent: false };
  }

  const items = (Array.isArray(params) ? params : [])
    .map((p) => {
      const name = String(p?.name ?? p?.parameter ?? p?.title ?? "").trim();
      const rationale = String(p?.rationale ?? p?.notes ?? p?.note ?? "").trim();
      const scoreRaw = parseScore(p?.score ?? p?.value ?? p?.points);
      const { value: weightRaw, hadPercent } = parseWeightFrom(p || {});
      return { name, rationale, scoreRaw, weightRaw, hadPercent };
    })
    .filter((i) => i.name && Number.isFinite(i.scoreRaw));

  if (!items.length) {
    return { rows: [], totalWeighted: 0, asPercent: false, renormalized: false };
  }

  const clampScore = (v) => Math.max(0, Math.min(10, Number(v) || 0));

  let anyWeights = false;
  let anyPercentHint = false;
  const weights = items.map((i) => {
    const w = Number(i.weightRaw);
    if (Number.isFinite(w) && w > 0) {
      anyWeights = true;
      if (i.hadPercent) anyPercentHint = true;
      return w;
    }
    return NaN;
  });

  let weightFracs;
  let asPercent = false;
  let renormalized = false;

  if (!anyWeights) {
    const frac = 1 / items.length;
    weightFracs = items.map(() => frac);
    asPercent = false;
  } else {
    const finiteWeights = weights.map((w) => (Number.isFinite(w) ? w : 0));
    const sumW = finiteWeights.reduce((a, b) => a + b, 0);

    if (anyPercentHint || (sumW > 85 && sumW < 115)) {
      asPercent = true;
      weightFracs = finiteWeights.map((w) => w / 100);
    } else {
      asPercent = false;
      weightFracs = finiteWeights.slice();
    }

    let fracSum = weightFracs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    if (!Number.isFinite(fracSum) || fracSum <= 0) {
      const frac = 1 / items.length;
      weightFracs = items.map(() => frac);
    } else if (Math.abs(fracSum - 1) > 0.01) {
      weightFracs = weightFracs.map((w) => (Number.isFinite(w) ? w / fracSum : 0));
      renormalized = true;
    }
  }

  const rows = items.map((i, idx) => {
    const weightFrac = weightFracs[idx] || 0;
    const weightPct = weightFrac * 100;
    const score = clampScore(i.scoreRaw);
    const weighted = score * weightFrac;
    return { name: i.name, rationale: i.rationale, weightFrac, weightPct, score, weighted };
  });

  const totalWeighted = rows.reduce((s, r) => s + r.weighted, 0);
  return { rows, totalWeighted: Number(totalWeighted.toFixed(2)), asPercent, renormalized };
}

function v2Totals(item) {
  const wNorm = normalizeWcsParameters(item?.wcs?.parameters || []);
  const wcs = wNorm.total;
  const p = normalizePhsWeights(item?.phs?.parameters || []);
  const phs = Math.max(0, Math.min(10, p.totalWeighted));
  const eParams = Array.isArray(item?.esi?.parameters) ? item.esi.parameters : [];
  const esi = eParams.reduce((s, par) => s + Math.max(0, Math.min(10, Number(par?.score) || 0)), 0);
  const esiMax = Number(item?.esi?.maxScore) || (eParams.length ? eParams.length * 10 : 30);
  const rpm = resolveRPMMultiplier(item);
  return { wcs, phs, esi, esiMax, rpm, wcsRows: wNorm.rows, phsRows: p.rows, phsRenormalized: p.renormalized, wcsScaleNote: wNorm.scaleNote };
}
function computeFormulaSeverity(item) {
  if (hasUnifiedV2(item)) { const v = v2Totals(item); return (v.wcs + v.phs + (v.esi / 3)) * v.rpm; }
  const W = readNumberByPaths(item, ["scores.WCS","wcs","WCS","phase1.screening.WCS","phase2.scores.WCS"]) ?? 0;
  const P = readNumberByPaths(item, ["scores.PHS","phs","PHS","phase1.screening.PHS","phase2.scores.PHS"]) ?? 0;
  const E = readNumberByPaths(item, ["scores.ESI","esi","ESI","phase1.screening.ESI","phase2.scores.ESI"]) ?? 0;
  const R = resolveRPMMultiplier(item);
  return (W + P + (E / 3)) * R;
}
function bandFromValue(val) { const v = Number(val); if (!Number.isFinite(v)) return "unknown"; if (v >= 7.5) return "high"; if (v >= 4) return "medium"; return "low"; }
function getSeverityValue(item) {
  const direct = readNumberByPaths(item, ["severity.value","severityValue","severity_score","severityScore","risk.severity","risk.score"]);
  if (direct !== null) return direct;
  return computeFormulaSeverity(item);
}

// Overview sections / report HTML
const fmt = {
  int: (v) => Number.isFinite(Number(v)) ? String(Number(v)) : "",
  date: (s) => { if (!s && s !== 0) return ""; try { const d = new Date(s); if (!isNaN(d)) return d.toISOString().slice(0,10); } catch {} return String(s); },
  coord: (lat, lng) => { const a = Number(lat), b = Number(lng); if (!Number.isFinite(a) || !Number.isFinite(b)) return ""; return `${a.toFixed(4)}°, ${b.toFixed(4)}°`; }
};
function buildOverviewHtml(item) {
  const h = item?.historical || {};
  const age = h?.ageAndSinking || {};
  const loc = h?.location || {};
  const coordsTop = item?.coordinates;
  const c = coordsTop || loc?.coordinates || {};
  const lat = c?.lat ?? c?.latitude;
  const lng = c?.lng ?? c?.lon ?? c?.longitude;
  const rows = [
    ["Vessel Type", getText(h?.vesselType)],
    ["Tonnage / Size", getText(h?.vesselSizeTonnage)],
    ["Launched", fmt.date(age?.launchedYear)],
    ["Sunk", fmt.date(age?.sunkDate)],
    ["Years Submerged", fmt.int(age?.yearsSubmerged)],
    ["Protected Area", getText(loc?.mpaOrProtectedArea)],
    ["Depth (m)", fmt.int(loc?.depthMeters)],
    ["Coordinates", fmt.coord(lat, lng) || null],
    ["Location", getText(loc?.description)]
  ].filter(([_, v]) => !!v);
  if (!rows.length) return "";
  const trs = rows.map(([k, v]) => `<tr><th style="white-space:nowrap">${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join("");
  return `<section><h3>Vessel Overview</h3><table><tbody>${trs}</tbody></table></section>`;
}
function buildSourcesHtml(item) {
  const src = Array.isArray(item?.sources) ? item.sources : [];
  if (!src.length) return "";
  const links = src.map(u => {
    const t = String(u || "").trim(); const safe = escapeHtml(t);
    return t ? `<li><a href="${safe}" target="_blank" rel="noopener">${safe}</a></li>` : "";
  }).filter(Boolean).join("");
  if (!links) return "";
  return `<section><h3>Sources</h3><ul class="list-disc ml-5">${links}</ul></section>`;
}
function buildAssumptionsHtml(item) {
  const arr = Array.isArray(item?.assumptions) ? item.assumptions : [];
  if (!arr.length) return "";
  const lis = arr.map(s => `<li>${escapeHtml(String(s || ""))}</li>`).join("");
  if (!lis) return "";
  return `<section><h3>Assumptions</h3><ul class="list-disc ml-5">${lis}</ul></section>`;
}
function buildConfidenceHtml(item) {
  const c = item?.confidence || {};
  const parts = [];
  if (isFiniteNum(c?.value)) parts.push(`<div><strong>Value:</strong> ${Number(c.value).toFixed(2)}</div>`);
  if (getText(c?.confidenceLabel)) parts.push(`<div><strong>Label:</strong> ${escapeHtml(c.confidenceLabel)}</div>`);
  if (getText(c?.basis)) parts.push(`<div><strong>Basis:</strong> ${escapeHtml(c.basis)}</div>`);
  if (!parts.length) return "";
  return `<section><h3>Confidence</h3><div class="text-sm space-y-1">${parts.join("")}</div></section>`;
}
function factorSummaryTable(item) {
  const rows = [];
  if (hasUnifiedV2(item)) {
    const v = v2Totals(item);
    rows.push(`<tr><th>WCS</th><td>${v.wcs.toFixed(2)}</td><td>0–20</td></tr>`);
    rows.push(`<tr><th>PHS</th><td>${v.phs.toFixed(2)}</td><td>0–10</td></tr>`);
    rows.push(`<tr><th>ESI</th><td>${v.esi.toFixed(2)}</td><td>0–${v.esiMax}</td></tr>`);
    rows.push(`<tr><th>RPM</th><td>${v.rpm.toFixed(2)}×</td><td>multiplier</td></tr>`);
  } else {
    const W = readNumberByPaths(item, ["wcs","scores.WCS","WCS"]) ?? 0;
    const P = readNumberByPaths(item, ["phs","scores.PHS","PHS"]) ?? 0;
    const E = readNumberByPaths(item, ["esi","scores.ESI","ESI"]) ?? 0;
    const R = resolveRPMMultiplier(item);
    rows.push(`<tr><th>WCS</th><td>${W.toFixed(2)}</td><td>0–20</td></tr>`);
    rows.push(`<tr><th>PHS</th><td>${P.toFixed(2)}</td><td>0–10</td></tr>`);
    rows.push(`<tr><th>ESI</th><td>${E.toFixed(2)}</td><td>0–30/40</td></tr>`);
    rows.push(`<tr><th>RPM</th><td>${R.toFixed(2)}×</td><td>multiplier</td></tr>`);
  }
  return `<h3>Factor Scores Summary</h3><table><thead><tr><th>Factor</th><th>Score</th><th>Scale</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function renderReportV2HTML(item) {
  const v = v2Totals(item);
  const overview = buildOverviewHtml(item);
  const wcsTable = `
    <table>
      <thead><tr><th>Parameter</th><th>Rationale</th><th>Score (0–5)</th></tr></thead>
      <tbody>
        ${v.wcsRows.map(r => `<tr><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.rationale)}</td><td>${(Number(r.normalized) || 0).toFixed(2)}</td></tr>`).join("")}
      </tbody>
    </table>
    <p class="mt-2"><strong>Total:</strong> ${v.wcs} / 20</p>
    ${v.wcsScaleNote ? '<p class="text-xs text-gray-500 mt-1">Note: WCS values appeared on 0–10; normalized to 0–5.</p>' : ''}
  `;
  const phsRowsHtml = (v.phsRows || []).map(r => `
    <tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.rationale)}</td><td>${r.weightPct.toFixed(0)}%</td><td>${r.score.toFixed(2)}</td><td>${r.weighted.toFixed(2)}</td></tr>
  `).join("");
  const esiParams = Array.isArray(item?.esi?.parameters) ? item.esi.parameters : [];
  const esiRowsHtml = esiParams.map(p => `
    <tr><td>${escapeHtml(p?.name ?? p?.parameter ?? "")}</td><td>${escapeHtml(p?.rationale ?? "")}</td><td>${escapeHtml(String(p?.score ?? ""))}</td></tr>
  `).join("");

  // RPM: accept arrays or maps (flattened in readRPMFactors in index.html equivalent here not needed)
  const rpmList = Array.isArray(item?.rpm?.parameters) ? item.rpm.parameters : Array.isArray(item?.rpm?.factors) ? item.rpm.factors : [];
  const rpmRowsHtml = Array.isArray(rpmList)
    ? rpmList.map(f => `<tr><td>${escapeHtml(f?.name ?? f?.factor ?? "")}</td><td>${escapeHtml(f?.rationale ?? "Not specified.")}</td><td>${escapeHtml(String(f?.value ?? ""))}</td></tr>`).join("")
    : "";

  const sources = buildSourcesHtml(item);
  const assumptions = buildAssumptionsHtml(item);
  const confidence = buildConfidenceHtml(item);

  return `
    <div class="rounded-lg border p-4 bg-white shadow-sm space-y-6">
      ${overview || ""}
      ${factorSummaryTable(item)}
      <section class="space-y-2"><h3 class="text-lg font-semibold">Phase 3: WCS (Hull & Structure)</h3>${wcsTable}</section>
      <section class="space-y-2">
        <h3 class="text-lg font-semibold">Phase 3: PHS (Pollution Hazard)</h3>
        <p class="text-xs text-gray-600">Weights normalized to sum to 100%. Weighted = Score × Weight.</p>
        <table>
          <thead><tr><th>Parameter</th><th>Rationale</th><th>Weight (%)</th><th>Score (0–10)</th><th>Weighted</th></tr></thead>
          <tbody>${phsRowsHtml}</tbody>
        </table>
        <p class="mt-1"><strong>Total Weighted Score (PHS):</strong> ${v.phs.toFixed(2)} / 10</p>
        ${v.phsRenormalized ? '<p class="text-xs text-gray-500">Note: input weights normalized.</p>' : ''}
      </section>
      <section class="space-y-2"><h3 class="text-lg font-semibold">Phase 3: ESI (Environmental Sensitivity)</h3>
        <table><thead><tr><th>Parameter</th><th>Rationale</th><th>Score (0–10)</th></tr></thead><tbody>${esiRowsHtml}</tbody></table>
        <p class="mt-1"><strong>Total:</strong> ${v.esi} / ${v.esiMax}</p>
      </section>
      <section class="space-y-2"><h3 class="text-lg font-semibold">Phase 3: RPM (Release Probability Modifier)</h3>
        ${rpmRowsHtml || '<p class="text-gray-600">No factor breakdown provided. Using final multiplier if supplied.</p>'}
        <p class="mt-1"><strong>Final Multiplier:</strong> ${(Number(item?.rpm?.finalMultiplier) || 1).toFixed(2)}× <span class="text-xs text-gray-500">(1.00 baseline)</span></p>
      </section>
      ${sources || ""}${assumptions || ""}${confidence || ""}
    </div>
  `;
}
function buildReportHtml(item) {
  const blocks = [];
  const overview = buildOverviewHtml(item); if (overview) blocks.push(overview);
  blocks.push(factorSummaryTable(item));
  const W = readNumberByPaths(item, ["wcs","scores.WCS","WCS"]) ?? 0;
  const P = readNumberByPaths(item, ["phs","scores.PHS","PHS"]) ?? 0;
  const E = readNumberByPaths(item, ["esi","scores.ESI","ESI"]) ?? 0;
  const R = resolveRPMMultiplier(item);
  blocks.push(`
    <h3>Factor Scores and Rationale</h3>
    <table>
      <thead><tr><th>Factor</th><th>Score</th><th>Notes</th></tr></thead>
      <tbody>
        <tr><th>WCS</th><td>${W.toFixed(2)}</td><td></td></tr>
        <tr><th>PHS</th><td>${P.toFixed(2)}</td><td></td></tr>
        <tr><th>ESI</th><td>${E.toFixed(2)}</td><td></td></tr>
        <tr><th>RPM</th><td>${R.toFixed(2)}×</td><td></td></tr>
      </tbody>
    </table>
  `);
  const sources = buildSourcesHtml(item);
  const assumptions = buildAssumptionsHtml(item);
  const confidence = buildConfidenceHtml(item);
  if (sources) blocks.push(sources);
  if (assumptions) blocks.push(assumptions);
  if (confidence) blocks.push(confidence);
  return `<div class="rounded-lg border p-4 bg-white shadow-sm space-y-6">${blocks.join("\n")}</div>`;
}

// Radar visuals
function renderBenchLegend() {
  const b = chartConfig.benchmarks;
  const el = benchLegend; if (!el) return;
  el.innerHTML = `<span style="color:${chartConfig.colors.highBorder}">High</span>: ${b.high} &nbsp;|&nbsp;
                  <span style="color:${chartConfig.colors.mediumBorder}">Medium</span>: ${b.medium} &nbsp;|&nbsp;
                  <span style="color:${chartConfig.colors.lowBorder}">Low</span>: ${b.low}`;
}
function getAxisScores(item) {
  let w, p, e;
  if (hasUnifiedV2(item)) { const v = v2Totals(item); w = v.wcs; p = v.phs; e = v.esi; }
  else {
    w = readNumberByPaths(item, ["wcs","scores.WCS","WCS","phase1.screening.WCS","phase2.scores.WCS"]) ?? 0;
    p = readNumberByPaths(item, ["phs","scores.PHS","PHS","phase1.screening.PHS","phase2.scores.PHS"]) ?? 0;
    e = readNumberByPaths(item, ["esi","scores.ESI","ESI","phase1.screening.ESI","phase2.scores.ESI"]) ?? 0;
  }
  const rpm = resolveRPMMultiplier(item);
  const max = chartConfig.scaleMax || 10;
  const rpmScaled = ((rpm - 0.5) / 2.0) * max;
  const clampAxis = (v) => Math.max(0, Math.min(max, Number(v) || 0));
  return [clampAxis(w), clampAxis(p), clampAxis(e), clampAxis(rpmScaled)];
}
function renderRadarGeneric(item) {
  const ctx = document.getElementById("werSpiderChart")?.getContext("2d"); if (!ctx) return;
  const labels = ["WCS","PHS","ESI","RPM"];
  const wreck = getAxisScores(item);
  const max = chartConfig.scaleMax || 10;
  const b = chartConfig.benchmarks;
  const ring = (val, label, bg, border) => ({ label, data:[val,val,val,val], fill:true, backgroundColor:bg, borderColor:border, pointRadius:0, borderWidth:1 });
  const data = {
    labels, datasets: [
      ring(b.high, "Benchmark High", chartConfig.colors.high, chartConfig.colors.highBorder),
      ring(b.medium, "Benchmark Medium", chartConfig.colors.medium, chartConfig.colors.mediumBorder),
      ring(b.low, "Benchmark Low", chartConfig.colors.low, chartConfig.colors.lowBorder),
      { label: "Wreck Risk", data: wreck, fill:true, backgroundColor: chartConfig.colors.wreck, borderColor: chartConfig.colors.wreckBorder, pointBackgroundColor: chartConfig.colors.wreckBorder, pointRadius:4 }
    ]
  };
  const options = { responsive: true, maintainAspectRatio: false,
    scales: { r: { beginAtZero: true, min: 0, max, ticks: { stepSize: Math.max(1, Math.round(max/5)) } } },
    plugins: { legend: { display: true, position: "bottom" } }
  };
  if (radarChart) radarChart.destroy();
  radarChart = new Chart(ctx, { type:"radar", data, options });
  renderBenchLegend();
}
function renderRadarV2(item) {
  const ctx = document.getElementById("werSpiderChart")?.getContext("2d"); if (!ctx) return;
  const v = v2Totals(item);
  const wcs20 = Math.max(0, Math.min(20, v.wcs));
  const phs20 = Math.max(0, Math.min(20, (v.phs / 10) * 20));
  const esi20 = Math.max(0, Math.min(20, (v.esi / (v.esiMax || 30)) * 20));
  const rpm20 = Math.max(0, Math.min(20, ((Math.min(Math.max(v.rpm, 0.5), 2.5) - 0.5) / 2.0) * 20));
  const profile = [wcs20, phs20, esi20, rpm20];
  const caps = { low:[6,6,6,6], med:[12,12,12,12], high:[20,20,20,20] };
  if (radarChart) radarChart.destroy();
  radarChart = new Chart(ctx, {
    type: "radar",
    data: {
      labels: ["WCS","PHS","ESI","RPM"],
      datasets: [
        { label:"Low benchmark", data: caps.low, backgroundColor:"rgba(16,185,129,0.18)", borderColor:"rgba(16,185,129,0.45)", pointRadius:0, order:1 },
        { label:"Medium benchmark", data: caps.med, backgroundColor:"rgba(245,158,11,0.14)", borderColor:"rgba(245,158,11,0.45)", pointRadius:0, fill:"-1", order:2 },
        { label:"High benchmark", data: caps.high, backgroundColor:"rgba(239,68,68,0.12)", borderColor:"rgba(239,68,68,0.45)", pointRadius:0, fill:"-1", order:3 },
        { label:"Risk Profile", data: profile, backgroundColor:"rgba(30,64,175,0.22)", borderColor:"rgba(30,64,175,1)", pointBackgroundColor:"rgba(30,64,175,1)", order:4 }
      ]
    },
    options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:"bottom" } }, scales:{ r:{ suggestedMin:0, suggestedMax:20, ticks:{ stepSize:4 } } } }
  });
  renderBenchLegend();
}

// Galleries — uploads (Storage only)
function renderUploadsFromDoc() {
  if (!uploadGalleryGrid) return;
  uploadGalleryGrid.innerHTML = "";
  uploadGalleryEmpty?.classList.add("hidden");
  const assets = Array.isArray(currentItem?.phase2?.assets) ? currentItem.phase2.assets : [];
  const imgs = assets.filter(a => a?.url && /\.(png|jpe?g|gif|webp|bmp|svg|tif|tiff)$/i.test(String(a?.name || a?.path || "")));
  if (!imgs.length) { uploadGalleryEmpty?.classList.remove("hidden"); return; }
  for (const a of imgs) {
    const tile = document.createElement("div");
    tile.className = "gallery-tile";
    const link = document.createElement("a");
    link.href = a.url; link.target = "_blank"; link.rel = "noopener";
    const img = document.createElement("img");
    img.src = a.url; img.alt = escapeHtml(a?.name || "image");
    img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.onerror = () => { img.src = PLACEHOLDER_SVG; };
    link.appendChild(img);
    tile.appendChild(link);
    uploadGalleryGrid.appendChild(tile);
  }
}

// Reference media — prefer cached; fallback external
function renderReferenceMedia() {
  if (!referenceMediaGrid) return;
  referenceMediaGrid.innerHTML = "";
  referenceMediaEmpty?.classList.add("hidden");

  const assets = Array.isArray(currentItem?.phase2?.assets) ? currentItem.phase2.assets : [];
  const refImgs = assets.filter(a =>
    a?.source === "reference" && a?.url && /\.(png|jpe?g|gif|webp)$/i.test(String(a?.name || a?.path || ""))
  );

  if (refImgs.length) {
    for (const a of refImgs) {
      const tile = document.createElement("div");
      tile.className = "gallery-tile";
      const link = document.createElement("a");
      link.href = a.url; link.target = "_blank"; link.rel = "noopener";
      const img = document.createElement("img");
      img.src = a.url; img.alt = "Cached media";
      img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.onerror = () => { img.src = PLACEHOLDER_SVG; };
      link.appendChild(img);
      tile.appendChild(link);
      referenceMediaGrid.appendChild(tile);
    }
    return;
  }

  // Fallback: external URLs
  const extUrls = getExternalImageUrls(currentItem);
  if (!extUrls.length) {
    referenceMediaEmpty?.classList.remove("hidden");
    return;
  }

  for (const u of extUrls) {
    const tile = document.createElement("div");
    tile.className = "gallery-tile relative";
    const link = document.createElement("a");
    link.href = u; link.target = "_blank"; link.rel = "noopener";
    const img = document.createElement("img");
    img.src = u; img.alt = "External (hotlink)";
    img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.onerror = () => { img.src = PLACEHOLDER_SVG; };

    // External badge
    const badge = document.createElement("div");
    badge.textContent = "External";
    badge.style.position = "absolute";
    badge.style.top = "4px";
    badge.style.left = "4px";
    badge.style.fontSize = "10px";
    badge.style.padding = "2px 6px";
    badge.style.borderRadius = "4px";
    badge.style.background = "rgba(251, 191, 36, 0.15)";
    badge.style.color = "#92400e";
    badge.style.border = "1px solid rgba(251, 191, 36, 0.6)";

    link.appendChild(img);
    tile.appendChild(link);
    tile.appendChild(badge);
    referenceMediaGrid.appendChild(tile);
  }
}

// Feedback
function renderFeedbackList(item) {
  if (!feedbackList) return;
  feedbackList.innerHTML = "";
  const entries = Array.isArray(item?.feedback) ? [...item.feedback] : [];
  entries.sort((a,b) => {
    const aMs = a?.createdAtMs ?? (a?.createdAt?.seconds ? a.createdAt.seconds * 1000 : 0);
    const bMs = b?.createdAtMs ?? (b?.createdAt?.seconds ? b.createdAt.seconds * 1000 : 0);
    return bMs - aMs;
  });
  const fmtTs = (e) => {
    if (typeof e?.createdAtMs === "number") return new Date(e.createdAtMs).toLocaleString();
    if (e?.createdAt?.seconds) return new Date(e.createdAt.seconds * 1000).toLocaleString();
    return "";
  };
  for (const e of entries.slice(0, 12)) {
    const who = escapeHtml(e?.user || "Unknown");
    const when = fmtTs(e) || "";
    const msg = escapeHtml(e?.message || "");
    const li = document.createElement("li");
    li.className = "p-2 bg-gray-50 border border-gray-200 rounded";
    li.innerHTML = `<div class="text-xs text-gray-600 mb-1">${who}${when ? " • " + when : ""}</div><div class="text-sm">${msg}</div>`;
    feedbackList.appendChild(li);
  }
}
saveFeedbackBtn?.addEventListener("click", async () => {
  if (!currentDocId) { feedbackStatus.textContent = "Open a report first."; return; }
  const msg = feedbackInput.value.trim();
  if (!msg) { feedbackStatus.textContent = "Enter feedback text."; return; }
  const who = auth.currentUser?.email || auth.currentUser?.uid || "anonymous";
  feedbackStatus.textContent = "Saving...";
  try {
    await updateDoc(doc(db, currentDocPath, currentDocId), {
      feedback: arrayUnion({ message: msg, user: who, createdAtMs: Date.now() }),
      feedbackUpdatedAt: serverTimestamp()
    });
    if (!Array.isArray(currentItem.feedback)) currentItem.feedback = [];
    currentItem.feedback.unshift({ message: msg, user: who, createdAtMs: Date.now() });
    renderFeedbackList(currentItem);
    feedbackInput.value = "";
    feedbackStatus.textContent = "Saved.";
    setTimeout(() => feedbackStatus.textContent = "", 1500);
  } catch (e) {
    feedbackStatus.textContent = `Save failed: ${e?.message || "error"}`;
  }
});

// Export helpers and bindings
function downloadFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function buildReportMarkdown(item) {
  const lines = [];
  const vessel = getVesselName(item);
  lines.push(`# ${vessel}`);
  lines.push("\n## Factor Scores Summary");
  if (hasUnifiedV2(item)) {
    const v = v2Totals(item);
    lines.push(`- WCS: ${v.wcs.toFixed(2)} / 20`);
    lines.push(`- PHS: ${v.phs.toFixed(2)} / 10 (weighted)`);
    lines.push(`- ESI: ${v.esi.toFixed(2)} / ${v.esiMax}`);
    lines.push(`- RPM: ${v.rpm.toFixed(2)}×`);
  } else {
    const W = readNumberByPaths(item, ["wcs","scores.WCS","WCS"]) ?? 0;
    const P = readNumberByPaths(item, ["phs","scores.PHS","PHS"]) ?? 0;
    const E = readNumberByPaths(item, ["esi","scores.ESI","ESI"]) ?? 0;
    const R = resolveRPMMultiplier(item);
    lines.push(`- WCS: ${W.toFixed(2)} / 20`);
    lines.push(`- PHS: ${P.toFixed(2)} / 10`);
    lines.push(`- ESI: ${E.toFixed(2)} / 30–40`);
    lines.push(`- RPM: ${R.toFixed(2)}×`);
  }
  const src = Array.isArray(item?.sources) ? item.sources : [];
  if (src.length) {
    lines.push("\n## Sources");
    for (const s of src) lines.push(`- ${s}`);
  }
  return lines.join("\n");
}
function getCurrentHtml() {
  if (!currentItem) return "";
  if (hasUnifiedV2(currentItem)) return lastRenderedHtml || renderReportV2HTML(currentItem);
  return lastRenderedHtml || buildReportHtml(currentItem);
}
function onExportHtml() {
  if (!currentItem) return;
  const vessel = getVesselName(currentItem) || "assessment";
  const html = getCurrentHtml();
  const docHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(vessel)}</title></head><body>${html}</body></html>`;
  downloadFile(`${vessel.replace(/\s+/g,"_")}.html`, new Blob([docHtml], { type: "text/html;charset=utf-8" }));
}
function onExportMarkdown() {
  if (!currentItem) return;
  const vessel = getVesselName(currentItem) || "assessment";
  const md = buildReportMarkdown(currentItem);
  downloadFile(`${vessel.replace(/\s+/g,"_")}.md`, new Blob([md], { type: "text/markdown;charset=utf-8" }));
}
function onExportJson() {
  if (!currentItem) return;
  const vessel = getVesselName(currentItem) || "assessment";
  const json = JSON.stringify(currentItem, null, 2);
  downloadFile(`${vessel.replace(/\s+/g,"_")}.json`, new Blob([json], { type: "application/json;charset=utf-8" }));
}
function onExportPdf() {
  if (!currentItem) return;
  const vessel = getVesselName(currentItem) || "assessment";

  let chartImg = "";
  try {
    const cnv = document.getElementById("werSpiderChart");
    chartImg = cnv?.toDataURL("image/png") || "";
  } catch {}

  const webExt = /\.(png|jpe?g|webp|gif)$/i;
  const assets = Array.isArray(currentItem?.phase2?.assets) ? currentItem.phase2.assets : [];
  let urls = assets.filter(a => a?.url && webExt.test(String(a?.name || a?.path || ""))).map(a => a.url).slice(0, 9);
  if (!urls.length) {
    const ext = getExternalImageUrls(currentItem);
    urls = ext.slice(0, 9);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(vessel)}</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; color:#111; line-height:1.5; padding:24px; }
      .pdf-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
      .pdf-header img { height: 72px; width: auto; }
      h1 { font-size: 20px; margin: 8px 0 14px; text-align:center; }
      h2,h3,h4 { margin: 10px 0 6px; }
      table { width:100%; border-collapse: collapse; margin: 8px 0; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; }
      th { background:#f5f5f5; }
      .gallery { display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; margin: 10px 0; }
      .gallery img { width:100%; height:120px; object-fit:cover; border:1px solid #e5e7eb; border-radius:6px; }
      @media print { body { -webkit-print-color-adjust: exact; } }
    </style></head><body>
      <div class="pdf-header">
        <img src="${LOGO_LEFT}" alt="Logo left">
        <div style="font-weight:600; font-size:14px;">Project Guardian – WERP Reports</div>
        <img src="${LOGO_RIGHT}" alt="Logo right">
      </div>
      <h1>${escapeHtml(vessel)}</h1>

      ${getCurrentHtml()}
      ${chartImg ? `<h3>WERP Risk Profile</h3><img src="${chartImg}" alt="Radar chart" style="max-width:100%;border:1px solid #e5e7eb;border-radius:6px">` : ""}

      ${urls.length ? `<h3>Gallery</h3><div class="gallery">${urls.map(u => `<img src="${u}" alt="Gallery image">`).join("")}</div>` : ""}
    </body></html>`;

  const w = window.open("", "_blank");
  if (w) {
    w.document.open(); w.document.write(html); w.document.close();
    w.addEventListener("load", () => { try { w.focus(); w.print(); } catch {} });
    setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 500);
  }
}
exportPdfBtn?.addEventListener("click", onExportPdf);
exportHtmlBtn?.addEventListener("click", onExportHtml);
exportMdBtn?.addEventListener("click", onExportMarkdown);
exportJsonBtn?.addEventListener("click", onExportJson);

// Monitoring button: if a report is open, scroll in-page; also update href to include wreckId
monitoringBtn?.addEventListener("click", (e) => {
  if (currentDocId) {
    e.preventDefault();
    const panel = document.getElementById("monitoring-panel");
    if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

// Open report — set monitoring wreckId, trigger caching if needed
async function maybeRequestCaching(item) {
  if (!callable.cacheReferenceMedia) return;
  const hasImages = Array.isArray(item?.media?.images) && item.media.images.length > 0;
  const hasRefAssets = Array.isArray(item?.phase2?.assets) && item.phase2.assets.some(a => a?.source === "reference");
  const canCache = currentRole === "admin" || currentRole === "contributor";
  if (hasImages && !hasRefAssets && canCache) {
    try {
      await callable.cacheReferenceMedia({ appId, docId: item.id, docPath: item._path || currentDocPath });
      setTimeout(async () => {
        const snap = await getDoc(doc(db, item._path || currentDocPath, item.id));
        if (snap.exists()) {
          currentItem = { ...currentItem, ...snap.data(), id: item.id, _path: item._path || currentDocPath };
          renderUploadsFromDoc();
          renderReferenceMedia();
          upsertMarker(currentItem);
        }
      }, 1000);
    } catch {}
  }
}
function openReport(item) {
  currentItem = item;
  currentDocId = item?.id || null;
  currentDocPath = item?._path || READ_COLLECTIONS[0];
  const vessel = getVesselName(item);
  if (reportTitle) reportTitle.textContent = vessel || "Assessment";

  // Set monitoring wreckId and tweak header link
  const mon = document.getElementById("monitoring-panel");
  if (mon) {
    mon.setAttribute("data-wreck-id", currentDocId || "");
    document.dispatchEvent(new CustomEvent("wreck-change", { detail: { wreckId: currentDocId } }));
  }
  if (monitoringBtn && currentDocId) {
    monitoringBtn.href = `/monitoring.html?wreckId=${encodeURIComponent(currentDocId)}`;
  }

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

  if (phase2Input) phase2Input.value = getText(deepGet(item, "phase2.summary")) || "";

  renderUploadsFromDoc();
  renderReferenceMedia();
  renderFeedbackList(item);
  maybeRequestCaching(item);

  reportContainer.classList.remove("hidden");
  reportContainer.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Lists / render pipeline
[sevHigh, sevMedium, sevLow].forEach(cb => cb && cb.addEventListener("change", render));
searchBox?.addEventListener("input", render);
clearSearch?.addEventListener("click", () => { searchBox.value = ""; render(); });

function getVisibleItems() {
  const activeBands = new Set();
  if (sevHigh?.checked) activeBands.add("high");
  if (sevMedium?.checked) activeBands.add("medium");
  if (sevLow?.checked) activeBands.add("low");
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

  const initial = [], completed = [], reassessArr = [];
  for (const it of filtered) {
    const phase2HasNotes = !!getText(it?.phase2?.summary);
    const phase2CompletedFlag = (it?.phase2?.status === 'completed') || (it?.phase2?.completed === true);
    const completedExplicit = (it?.completed === true) || (it?.status === "completed") || !!it?.phase3 || !!it?.finalizedAt;
    const isCompleted = completedExplicit || phase2CompletedFlag || phase2HasNotes;

    const alerts = Array.isArray(it?.alerts) ? it.alerts : [];
    const hasUnackedAlert = alerts.some(a => a && a.acknowledged === false);
    const seismicFlag = it?.seismicEvent === true;
    const events = it?.events;
    const hasSeismicEvent =
      (events?.seismic != null) ||
      (Array.isArray(events) && events.some(e => /seismic/i.test(e?.type || "")));
    const reqReassess = Boolean(it?.needsReassessment || hasUnackedAlert || seismicFlag || hasSeismicEvent);

    if (reqReassess) reassessArr.push(it);
    else if (isCompleted) completed.push(it);
    else initial.push(it);
  }

  const valOf = (o) => isFiniteNum(o?.severity?.value) ? o.severity.value : -Infinity;
  const bySeverityDesc = (a, b) => valOf(b) - valOf(a);

  initial.sort(bySeverityDesc);
  completed.sort(bySeverityDesc);
  reassessArr.sort(bySeverityDesc);

  drawList(initialList, initial);
  drawList(completedList, completed);
  drawList(reassessList, reassessArr);

  if (initialCount) initialCount.textContent = String(initial.length);
  if (completedCount) completedCount.textContent = String(completed.length);
  if (reassessCount) reassessCount.textContent = String(reassessArr.length);

  document.getElementById("noDataBanner")?.classList.toggle("hidden", allItems.length !== 0);
  noInitial?.classList.toggle("hidden", initial.length !== 0);
  noCompleted?.classList.toggle("hidden", completed.length !== 0);
  noReassess?.classList.toggle("hidden", reassessArr.length !== 0);

  clearMarkers();
  for (const it of filtered) upsertMarker(it);

  if (visibleCounts) visibleCounts.textContent = `${filtered.length} of ${allItems.length}`;
}

function drawList(container, items) {
  if (!container) return;
  container.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("div");
    li.className = "list-item flex items-center justify-between gap-3";
    const band = it?.severity?.band || "unknown";
    const vessel = escapeHtml(getVesselName(it));
    const sv = it?.severity?.value;
    const svTxt = isFiniteNum(sv) ? sv.toFixed(2) : "N/A";
    li.innerHTML = `
      <div class="min-w-0">
        <div class="text-sm font-semibold text-gray-900 truncate">${vessel || "Unknown"}</div>
        <div class="text-xs text-gray-500">Severity: ${band.toUpperCase()} ${svTxt}</div>
      </div>
      <span class="pill ${band}">${band.toUpperCase()}</span>
    `;
    li.addEventListener("click", () => openReport(it));
    container.appendChild(li);
  }
}

// Analyze (unchanged behavior)
const analyzeFunctionNames = ["analyzeWerps", "reassessWerps"];
function getCallableByName(name) { try { return httpsCallable(functions, name); } catch { return null; } }
analyzeBtn?.addEventListener("click", async () => {
  const name = vesselNameInput?.value?.trim();
  if (!name) { statusMessage.textContent = "Enter a vessel name to analyze."; return; }
  analyzeBtn.disabled = true;
  analyzeText.textContent = "Analyzing...";
  statusMessage.textContent = "Submitting analysis request...";
  let fn = null, fnName = "";
  for (const n of analyzeFunctionNames) { const c = getCallableByName(n); if (c) { fn = c; fnName = n; break; } }
  if (!fn) {
    statusMessage.textContent = "No analysis function deployed.";
    analyzeBtn.disabled = false; analyzeText.textContent = "Analyze Wreck"; return;
  }
  try {
    const payload = { vesselName: name, appId, targetPath: DEFAULT_WRITE_COLLECTION, source: "web-app" };
    await fn(payload);
    statusMessage.textContent = `Analysis requested via ${fnName}. It will appear shortly.`;
    vesselNameInput.value = "";
  } catch (e) {
    statusMessage.textContent = `Analysis failed: ${e?.message || String(e)}`;
  } finally {
    analyzeBtn.disabled = false; analyzeText.textContent = "Analyze Wreck";
  }
});

// Auth UI handlers
signInEmailBtn?.addEventListener("click", async () => {
  authMessage.textContent = "Signing in…";
  try {
    await signInWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
  } catch (e) {
    authMessage.textContent = e?.message || "Sign-in failed.";
  }
});
createAccountBtn?.addEventListener("click", async () => {
  authMessage.textContent = "Creating account…";
  try {
    await createUserWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
  } catch (e) {
    authMessage.textContent = e?.message || "Create account failed.";
  }
});
resetPasswordBtn?.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  if (!email) { authMessage.textContent = "Enter your email first."; return; }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (e) {
    authMessage.textContent = e?.message || "Reset failed.";
  }
});
signOutBtn?.addEventListener("click", async () => {
  try { await signOut(auth); } catch {}
});

// Roles, listeners
async function fetchRoleFor(uid) {
  try {
    const allow = await getDoc(doc(db, "system", "allowlist", "users", uid));
    if (allow.exists()) {
      const d = allow.data() || {};
      let r = d.role ?? d.Role ?? d.ROLE;
      if (typeof r === "string" && r.trim()) {
        r = r.trim().toLowerCase();
        if (r.startsWith("admin")) return "admin";
        if (r.startsWith("contrib")) return "contributor";
        if (["user","reader","viewer"].includes(r)) return "user";
      }
      if (d.admin === true) return "admin";
      if (d.contributor === true) return "contributor";
      if (d.allowed === true) return "user";
    }
  } catch {}
  try {
    const legacy = await getDoc(doc(db, `artifacts/${appId}/private/users/${uid}`));
    if (legacy.exists()) {
      const d = legacy.data() || {};
      let r = d.role ?? d.Role ?? d.ROLE;
      if (typeof r === "string" && r.trim()) {
        r = r.trim().toLowerCase();
        if (r.startsWith("admin")) return "admin";
        if (r.startsWith("contrib")) return "contributor";
        if (["user","reader","viewer"].includes(r)) return "user";
      }
      if (d.admin === true) return "admin";
      if (d.contributor === true) return "contributor";
    }
  } catch {}
  return "user";
}
async function loadChartConfig() {
  const paths = [
    `artifacts/${appId}/public/config/werpChart`,
    `artifacts/${appId}/public/config/werpRadarBenchmarks`,
    `artifacts/${appId}/public/config/werp`
  ];
  for (const p of paths) {
    try {
      const snap = await getDoc(doc(db, p));
      if (snap.exists()) {
        const cfg = snap.data() || {};
        if (typeof cfg.scaleMax === "number") chartConfig.scaleMax = cfg.scaleMax;
        if (cfg.benchmarks && typeof cfg.benchmarks === "object") {
          chartConfig.benchmarks = {
            high: Number(cfg.benchmarks.high ?? chartConfig.benchmarks.high),
            medium: Number(cfg.benchmarks.medium ?? chartConfig.benchmarks.medium),
            low: Number(cfg.benchmarks.low ?? chartConfig.benchmarks.low)
          };
        }
        if (cfg.colors && typeof cfg.colors === "object") chartConfig.colors = { ...chartConfig.colors, ...cfg.colors };
        break;
      }
    } catch {}
  }
}
async function startData() {
  for (const u of dataUnsubs) { try { u(); } catch {} }
  dataUnsubs = [];
  await loadChartConfig();
  const byKey = new Map();
  const applySnap = (snap, basePath) => {
    snap.forEach(docSnap => {
      const raw = docSnap.data() || {};
      const d = { ...normalizeDoc(raw), id: raw?.id || docSnap.id, _path: basePath };
      if (!isWerpAssessment(d)) return;
      const sv = getSeverityValue(d);
      d.severity = { ...(d.severity || {}), value: sv, band: d.severity?.band || bandFromValue(sv) };
      byKey.set(`${basePath}::${d.id}`, d);
    });
    allItems = Array.from(byKey.values());
    render();
  };
  for (const p of READ_COLLECTIONS) {
    try {
      const un = onSnapshot(collection(db, p),
        (snap) => applySnap(snap, p),
        (err) => console.error(`Snapshot error (${p})`, err)
      );
      dataUnsubs.push(un);
    } catch (e) { console.error("Listener error", p, e); }
  }
}
function normalizeDoc(d) {
  const out = { ...d };
  if (d && typeof d.data === "object" && d.data) Object.assign(out, d.data);
  if (d && typeof d.payload === "object" && d.payload) Object.assign(out, d.payload);
  if (d && typeof d.attributes === "object" && d.attributes) Object.assign(out, d.attributes);
  if (d && typeof d.details === "object" && d.details) Object.assign(out, d.details);
  if (d && typeof d.meta === "object" && d.meta) out.meta = { ...d.meta };
  if (d && typeof d.metadata === "object" && d.metadata) out.metadata = { ...d.metadata };
  return out;
}
function isWerpAssessment(d) {
  const t = String(d?.type ?? d?.recordType ?? d?.category ?? d?.kind ?? d?.meta?.type ?? "").toUpperCase();
  const et = String(d?.eventType ?? d?.events?.type ?? "").toUpperCase();
  const name = String(d?.name ?? d?.title ?? d?.id ?? "").toUpperCase();
  const looksSeismic =
    t === "SEISMIC_EVENT" || et === "SEISMIC_EVENT" ||
    (t.includes("SEISMIC") && t.includes("EVENT")) || (et.includes("SEISMIC") && et.includes("EVENT")) ||
    name.includes("SEISMIC_EVENT");
  if (looksSeismic) return false;
  return true;
}
function getVesselName(it) {
  const direct = [
    it.vesselName, it.name, it.title, it.displayName, it.label,
    it.vessel?.name, it.ship?.name, it.wreck?.name, it.wreckName, it.shipName,
    it.meta?.vesselName, it.metadata?.vesselName, it.phase1?.screening?.vesselName
  ];
  for (const c of direct) { const t = getText(c); if (t) return t; }
  return getText(it.id) || "Unknown";
}

// ----- Upload handlers -----
function sanitizeFileName(name = "") {
  return String(name)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 140) || `file_${Date.now()}`;
}