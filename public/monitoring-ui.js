// Minimal monitoring UI module (ESM). Assumes Firestore v9+ (modular).
// You provide an existing Firestore instance (db) during init to avoid double init.

let dbRef = null;
let functionsBase = null;

function setFunctionsEnv({ projectId, region = "us-central1" }) {
  functionsBase = `https://${region}-${projectId}.cloudfunctions.net`;
}

export function initMonitoring({ db, projectId, region = "us-central1" }) {
  if (!db) throw new Error("initMonitoring requires a Firestore db instance");
  dbRef = db;
  setFunctionsEnv({ projectId, region });
}

function formatDate(ts) {
  try {
    if (!ts) return "-";
    if (typeof ts.toDate === "function") return ts.toDate().toISOString();
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

function iconForType(type) {
  switch (type) {
    case "earthquake": return "🌋";
    case "cyclone": return "🌀";
    case "oil_spill": return "🛢️";
    default: return "⚑";
  }
}

function badge(text, cls = "") {
  return `<span class="mon-badge ${cls}">${text}</span>`;
}

function renderItem(doc) {
  const d = doc.data();
  const icon = iconForType(d.type);
  const date = formatDate(d.eventAt || d.createdAt);
  const dist = (d.distanceKm !== null && d.distanceKm !== undefined) ? `${d.distanceKm} km` : "-";
  const reassess = d.requiresReassessment ? badge("Reassessment", "warn") : "";
  const src = d.eventSource || "-";
  const title = (d.details?.stormProp?.name) || d.type;

  return `
    <li class="mon-item">
      <div class="mon-item-row">
        <div class="mon-left">
          <span class="mon-emoji">${icon}</span>
          <span class="mon-title">${title}</span>
          ${reassess}
          ${badge(src, "muted")}
        </div>
        <div class="mon-right">
          ${badge(date, "date")}
          ${badge(dist, "info")}
        </div>
      </div>
    </li>
  `;
}

export function mountMonitoringPanel({ container, wreckId, limitCount = 10 }) {
  if (!dbRef) throw new Error("Call initMonitoring({ db, projectId, region }) first");
  if (!container) throw new Error("mountMonitoringPanel requires a container element");
  if (!wreckId) throw new Error("mountMonitoringPanel requires wreckId");

  container.innerHTML = `
    <div class="mon-panel">
      <div class="mon-header">
        <h3>Monitoring</h3>
        <div class="mon-actions">
          <button id="mon-refresh" class="mon-btn">Refresh</button>
          <button id="mon-spill" class="mon-btn mon-secondary" title="Queue oil spill detection (admin/test)">
            Run spill detection
          </button>
        </div>
      </div>
      <ul class="mon-list" id="mon-list"></ul>
      <div class="mon-empty" id="mon-empty" style="display:none;">No monitoring events yet.</div>
    </div>
  `;

  const listEl = container.querySelector("#mon-list");
  const emptyEl = container.querySelector("#mon-empty");
  const refreshBtn = container.querySelector("#mon-refresh");
  const spillBtn = container.querySelector("#mon-spill");

  const { getFirestore, collection, query, where, orderBy, limit, onSnapshot } = await import(
    "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js"
  );

  // Build query: monitoring_flags where wreckId == X, newest first.
  const flagsCol = collection(dbRef, "monitoring_flags");
  // eventAt may be a string; createdAt is a Firestore timestamp. We order by createdAt as a stable fallback.
  const q = query(
    flagsCol,
    where("wreckId", "==", wreckId),
    orderBy("createdAt", "desc"),
    limit(limitCount)
  );

  let unsub = null;

  function renderSnapshot(snap) {
    if (snap.empty) {
      listEl.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";
    const html = snap.docs.map(renderItem).join("");
    listEl.innerHTML = html;
  }

  function start() {
    if (unsub) unsub();
    unsub = onSnapshot(q, renderSnapshot, (err) => {
      console.error("monitoring onSnapshot error", err);
    });
  }

  refreshBtn.addEventListener("click", start);

  spillBtn.addEventListener("click", async () => {
    try {
      const bbox = await resolveWreckBbox(dbRef, wreckId);
      const res = await queueSpillDetection({ bbox, wreckId });
      alert(`Spill detection queued: ${res.id}`);
    } catch (e) {
      console.error(e);
      alert(`Failed to queue spill detection: ${e.message || e}`);
    }
  });

  start();

  return () => { if (unsub) unsub(); };
}

async function resolveWreckBbox(db, wreckId, paddingKm = 15) {
  const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  const ref = doc(db, "wrecks", wreckId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Wreck not found");
  const w = snap.data();
  const lat = w?.coordinates?.lat;
  const lon = w?.coordinates?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") {
    throw new Error("Wreck missing coordinates");
  }
  // Convert ~km to degrees (approx; adequate for small bbox)
  const dLat = paddingKm / 111; // ~111 km per degree latitude
  const dLon = paddingKm / (111 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

export async function queueSpillDetection({ bbox, wreckId, timeWindow = null }) {
  if (!functionsBase) throw new Error("Functions environment not set; call initMonitoring first");
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error("bbox must be [minLon, minLat, maxLon, maxLat]");

  const url = `${functionsBase}/queueSpillDetection`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bbox, timeWindow, wreckId })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${txt}`);
  }
  return res.json();
}