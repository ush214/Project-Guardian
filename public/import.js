// Import/Replace tool with dual-path controls and schema normalization for the UI.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore, collection, getDocs, writeBatch, doc, setDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// Firebase config (same as main app)
const firebaseConfig = {
  apiKey: "AIzaSyCiqs5iMg-Nj3r6yRszUxFKOIxmMfs5m6Q",
  authDomain: "project-guardian-agent.firebaseapp.com",
  projectId: "project-guardian-agent",
  storageBucket: "project-guardian-agent.firebasestorage.app",
  messagingSenderId: "84395007243",
  appId: "1:84395007243:web:b07e5f4c4264d27611160e",
  measurementId: "G-NRLH3WSCQ9"
};
if (getApps().length === 0) initializeApp(firebaseConfig);
const auth = getAuth();
const db = getFirestore();

// DOM
const el = (id) => document.getElementById(id);
const signedInAs = el("signedInAs");
const roleBadge = el("roleBadge");
const primaryPathInput = el("primaryPath");
const secondaryPathInput = el("secondaryPath");
const jsonInput = el("jsonInput");
const btnValidate = el("btnValidate");
const btnExportPrimary = el("btnExportPrimary");
const btnReplacePrimary = el("btnReplacePrimary");
const btnDeleteSecondary = el("btnDeleteSecondary");
const btnReplaceAndDelete = el("btnReplaceAndDelete");
const statusEl = el("status");
const logEl = el("log");
const parsedCountEl = el("parsedCount");

// Role detection (mirrors app.js)
async function fetchRoleFor(uid) {
  const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
  const appId = "guardian";
  try {
    const allowDocRef = doc(db, "system", "allowlist", "users", uid);
    const allowDoc = await getDoc(allowDocRef);
    if (allowDoc.exists()) {
      const d = allowDoc.data() || {};
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
    const legacyRef = doc(db, `artifacts/${appId}/private/users/${uid}`);
    const legacyDoc = await getDoc(legacyRef);
    if (legacyDoc.exists()) {
      const d = legacyDoc.data() || {};
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

function setStatus(msg) { statusEl.textContent = msg || ""; }
function log(msg) { logEl.textContent += (msg ? msg + "\n" : ""); }
function clearLog() { logEl.textContent = ""; }

function parseInputJson(raw) {
  const t = (raw || "").trim();
  if (!t) return [];
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object") return [parsed];
  } catch {
    const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const arr = [];
    for (const line of lines) {
      try { arr.push(JSON.parse(line)); }
      catch (e) { throw new Error("Invalid JSON line: " + line.slice(0, 120)); }
    }
    return arr;
  }
  return [];
}

// Map weights, coordinates, rpm factors for UI compatibility
function transformItem(raw) {
  const item = { ...raw };

  // Ensure id
  item.id = item.id || item.docId || item.slug || "";

  // Coordinates to top-level {lat, lng}
  const coord = raw?.historical?.location?.coordinates;
  if (coord && typeof coord.lat === "number" && (typeof coord.lon === "number" || typeof coord.lng === "number")) {
    const lon = typeof coord.lng === "number" ? coord.lng : coord.lon;
    item.coordinates = { lat: coord.lat, lng: lon };
  }

  // PHS weights: weightPercent -> weight
  if (Array.isArray(item?.phs?.parameters)) {
    item.phs.parameters = item.phs.parameters.map(p => {
      const q = { ...p };
      if (q.weight == null && typeof q.weightPercent === "number") {
        q.weight = q.weightPercent;
      }
      return q;
    });
  }

  // RPM factors: object -> array of parameters (for display table)
  if (item?.rpm && !Array.isArray(item.rpm.factors) && !Array.isArray(item.rpm.parameters) && item.rpm.factors && typeof item.rpm.factors === "object") {
    try {
      const arr = Object.entries(item.rpm.factors).map(([k, v]) => ({
        name: k,
        factor: k,
        value: typeof v?.value === "number" ? v.value : undefined,
        rationale: v?.rationale || ""
      }));
      item.rpm.parameters = arr;
    } catch {}
  }

  return item;
}

btnValidate.addEventListener("click", () => {
  clearLog();
  try {
    const items = parseInputJson(jsonInput.value).map(transformItem);
    parsedCountEl.textContent = `${items.length} item(s) parsed`;
    if (!items.length) { setStatus("No items parsed."); return; }
    const sample = JSON.stringify(items[0], null, 2);
    setStatus("JSON looks valid and normalized for UI.");
    log(`Parsed ${items.length} item(s). First item (normalized):\n${sample}`);
  } catch (e) {
    setStatus("Validation failed.");
    log(String(e?.message || e));
  }
});

btnExportPrimary.addEventListener("click", async () => {
  clearLog();
  const path = primaryPathInput.value.trim();
  if (!path) { setStatus("Enter the primary collection path."); return; }
  setStatus("Exporting primary collection...");
  try {
    const colRef = collection(db, path);
    const snap = await getDocs(colRef);
    const arr = [];
    snap.forEach(d => { arr.push({ id: d.id, ...d.data() }); });
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = (path.replace(/[^\w.-]+/g, "_") || "export") + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Exported ${arr.length} document(s).`);
  } catch (e) {
    setStatus("Export failed.");
    log(String(e?.message || e));
  }
});

btnReplacePrimary.addEventListener("click", async () => {
  await doReplacePrimary(false);
});

btnDeleteSecondary.addEventListener("click", async () => {
  clearLog();
  const path = secondaryPathInput.value.trim();
  if (!path) { setStatus("Enter the secondary collection path."); return; }
  if (!confirm(`Delete ALL documents in "${path}"? This cannot be undone.`)) { setStatus("Canceled."); return; }
  setStatus("Deleting secondary collection...");
  try {
    await deleteAllInCollection(path);
    setStatus("Secondary collection deleted.");
  } catch (e) {
    setStatus("Delete failed.");
    log(String(e?.message || e));
  }
});

btnReplaceAndDelete.addEventListener("click", async () => {
  // Delete secondary then replace primary
  clearLog();
  const sec = secondaryPathInput.value.trim();
  const pri = primaryPathInput.value.trim();
  if (!pri || !sec) { setStatus("Enter both primary and secondary paths."); return; }
  if (!confirm(`This will DELETE ALL documents in "${sec}" and REPLACE "${pri}" with your JSON. Continue?`)) { setStatus("Canceled."); return; }

  try {
    setStatus("Deleting secondary collection...");
    await deleteAllInCollection(sec);
    log("Secondary collection deleted.");
  } catch (e) {
    setStatus("Delete of secondary failed.");
    log(String(e?.message || e));
    return;
  }
  await doReplacePrimary(true);
});

async function doReplacePrimary(skipConfirm) {
  clearLog();
  const path = primaryPathInput.value.trim();
  if (!path) { setStatus("Enter the primary collection path."); return; }
  let items;
  try {
    items = parseInputJson(jsonInput.value).map(transformItem);
  } catch (e) {
    setStatus("Invalid JSON.");
    log(String(e?.message || e));
    return;
  }
  if (!items.length) { setStatus("No items to import."); return; }

  if (!skipConfirm && !confirm(`This will DELETE ALL documents in "${path}" and import ${items.length} item(s). Continue?`)) {
    setStatus("Canceled.");
    return;
  }

  setStatus("Deleting existing documents in primary...");
  try {
    await deleteAllInCollection(path);
    setStatus("Importing new documents into primary...");
    await importItems(path, items);
    setStatus("Replace complete.");
    log(`Imported ${items.length} item(s) into ${path}.`);
  } catch (e) {
    setStatus("Replace failed.");
    log(String(e?.message || e));
  }
}

// Helpers
async function deleteAllInCollection(path) {
  const colRef = collection(db, path);
  const snap = await getDocs(colRef);
  const docs = [];
  snap.forEach(d => docs.push(d));
  if (!docs.length) return;

  let processed = 0;
  while (processed < docs.length) {
    const batch = writeBatch(db);
    const chunk = docs.slice(processed, processed + 400); // keep under 500 ops
    for (const d of chunk) batch.delete(doc(db, path, d.id));
    await batch.commit();
    processed += chunk.length;
    log(`Deleted ${processed}/${docs.length}`);
  }
}

function pickDocId(obj) {
  const s = (v) => (typeof v === "string" && v.trim()) ? v.trim() : null;
  return s(obj?.id) || s(obj?.docId) || s(obj?.slug) || null;
}

async function importItems(path, items) {
  const colRef = collection(db, path);
  let processed = 0;
  let idx = 0;
  while (idx < items.length) {
    const batch = writeBatch(db);
    const chunk = items.slice(idx, idx + 400);
    for (const raw of chunk) {
      const payload = transformItem(raw);
      const id = pickDocId(payload) || undefined;
      const ref = id ? doc(db, path, id) : doc(colRef);

      if (!payload.id) payload.id = ref.id;         // Keep id field in doc for UI
      if (!payload.createdAt) payload.createdAt = serverTimestamp();

      batch.set(ref, payload, { merge: false });
    }
    await batch.commit();
    idx += chunk.length;
    processed += chunk.length;
    log(`Imported ${processed}/${items.length}`);
  }
}

// Auth state
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    signedInAs.textContent = "Not signed in – open the main app and sign in first, then reload this page.";
    roleBadge.textContent = "—";
    btnReplacePrimary.disabled = true;
    btnExportPrimary.disabled = true;
    btnDeleteSecondary.disabled = true;
    btnReplaceAndDelete.disabled = true;
    return;
  }
  signedInAs.textContent = user.email || user.uid;
  const role = await fetchRoleFor(user.uid);
  roleBadge.textContent = role;
  const isContributor = role === "admin" || role === "contributor";
  btnReplacePrimary.disabled = !isContributor;
  btnExportPrimary.disabled = !isContributor;
  btnDeleteSecondary.disabled = !isContributor;
  btnReplaceAndDelete.disabled = !isContributor;
  if (!isContributor) {
    setStatus("You need contributor or admin role to modify collections.");
  }
});