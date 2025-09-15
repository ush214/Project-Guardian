import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, updateDoc, onSnapshot, collection,
  query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Configure Firebase
// If your project uses Firebase Hosting, you can also include /__/firebase/init.js instead.
// Provide your config here if not already globally available.
const firebaseConfig = window.firebaseConfig || {
  // TODO: Insert your config or rely on /__/firebase/init.js in hosting
};

let app;
try {
  app = initializeApp(firebaseConfig);
} catch (e) {
  // If already initialized by another script
}

const db = getFirestore();

function getParam(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function renderList(el, items, renderItem) {
  if (!items || items.length === 0) {
    el.textContent = "No events.";
    return;
  }
  el.innerHTML = "";
  for (const it of items) {
    const div = document.createElement("div");
    div.className = "event";
    div.appendChild(renderItem(it));
    el.appendChild(div);
  }
}

function badge(text, cls = "badge") {
  const b = document.createElement("span");
  b.className = cls;
  b.textContent = text;
  return b;
}

async function loadWreck(collectionId, docId) {
  const ref = doc(db, collectionId, docId);
  return getDoc(ref);
}

function subscribeEvents(wreckPath, type, elId) {
  const el = document.getElementById(elId);
  const eventsRef = collection(db, `${wreckPath}/monitoring/${type}/events`);
  const q = query(eventsRef, orderBy("timeMs", "desc"), limit(50));
  return onSnapshot(q, (snap) => {
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    renderList(el, items, (ev) => {
      const container = document.createElement("div");
      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.alignItems = "baseline";
      header.style.gap = ".5rem";

      header.appendChild(document.createTextNode(
        `${new Date(ev.timeMs || 0).toLocaleString()} — ${ev.message || ""}`
      ));

      if (ev.exceeded) {
        header.appendChild(badge("EXCEEDED", "badge exceeded"));
      } else {
        header.appendChild(badge("ok"));
      }

      container.appendChild(header);

      if (type === "oil" && ev.thumbUrl) {
        const img = document.createElement("img");
        img.src = ev.thumbUrl;
        img.alt = "oil thumbnail";
        img.className = "thumb";
        container.appendChild(img);
      }

      // Details
      const small = document.createElement("div");
      small.style.fontSize = ".9rem";
      small.style.opacity = ".8";
      small.textContent = JSON.stringify(
        {
          source: ev.source,
          pgaG: ev.pgaG,
          magnitude: ev.magnitude,
          distanceKm: ev.distanceKm || ev.closestDistanceKm,
          sustainedWindKt: ev.sustainedWindKt,
          waveHeightM: ev.waveHeightM,
          area_km2: ev.area_km2,
          severity: ev.severity
        },
        null,
        0
      );
      container.appendChild(small);

      return container;
    });
  });
}

async function acknowledgeAll(wreckPath) {
  const ref = doc(db, wreckPath);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data() || {};
  const alerts = Array.isArray(data.alerts) ? data.alerts : [];
  const updated = alerts.map((a) => ({ ...a, acknowledged: true }));
  await updateDoc(ref, { alerts: updated, alertsUpdatedAt: new Date() });
}

function renderAlerts(wreckPath) {
  const el = document.getElementById("alertsList");
  const ref = doc(db, wreckPath);
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      el.textContent = "No alerts.";
      return;
    }
    const data = snap.data();
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    if (alerts.length === 0) {
      el.textContent = "No alerts.";
      return;
    }
    el.innerHTML = "";
    alerts.forEach((a, idx) => {
      const row = document.createElement("div");
      row.className = "event";
      const left = document.createElement("div");
      left.textContent = `${new Date(a.timeMs || 0).toLocaleString()} — ${a.message || ""}`;
      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = ".5rem";
      right.appendChild(badge(a.sourceType || "event"));
      if (a.exceeded) right.appendChild(badge("EXCEEDED", "badge exceeded"));
      const btn = document.createElement("button");
      btn.textContent = a.acknowledged ? "Acknowledged" : "Acknowledge";
      btn.disabled = !!a.acknowledged;
      btn.addEventListener("click", async () => {
        // Replace array element
        const current = (Array.isArray(snap.data().alerts) ? snap.data().alerts : []).slice();
        current[idx] = { ...current[idx], acknowledged: true };
        await updateDoc(ref, { alerts: current, alertsUpdatedAt: new Date() });
      });
      right.appendChild(btn);

      const bar = document.createElement("div");
      bar.style.display = "flex";
      bar.style.justifyContent = "space-between";
      bar.appendChild(left);
      bar.appendChild(right);

      row.appendChild(bar);
      el.appendChild(row);
    });
  });
}

(async function main() {
  const wreckId = getParam("wreckId");
  if (!wreckId) {
    alert("Missing ?wreckId=DOC_ID");
    return;
  }

  // We need to discover which of the two collections contains this doc.
  const colCandidates = [
    "artifacts/guardian/public/data/werpassessments",
    "artifacts/guardian-agent-default/public/data/werpassessments",
  ];

  let wreckPath = null;
  let role = null;

  for (const col of colCandidates) {
    const s = await loadWreck(col, wreckId);
    if (s.exists()) {
      wreckPath = `${col}/${wreckId}`;
      const data = s.data() || {};
      role = data.role || data.phase || data.status || null;
      break;
    }
  }

  if (!wreckPath) {
    alert("Could not find wreck in known collections.");
    return;
  }

  document.getElementById("wreckPath").textContent = wreckPath;
  if (role) document.getElementById("roleBadge").textContent = `role: ${role}`;

  // Alerts
  const unsubAlerts = renderAlerts(wreckPath);

  // Panels
  const unsubEq = subscribeEvents(wreckPath, "earthquakes", "earthquakes");
  const unsubSt = subscribeEvents(wreckPath, "storms", "storms");
  const unsubOil = subscribeEvents(wreckPath, "oil", "oil");

  document.getElementById("ackAllBtn").addEventListener("click", () => acknowledgeAll(wreckPath));

  // Optional: expose unsub for debugging
  window._monitoringUnsubs = [unsubAlerts, unsubEq, unsubSt, unsubOil];
})();