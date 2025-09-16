// Importer with backfill cache button.
// Requires authenticated Contributor/Admin to run destructive actions and to call the backfill function.

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, getDocs, collection, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
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
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const functions = getFunctions(app, "us-central1");

const callCacheCollection = httpsCallable(functions, "cacheCollectionReferenceMedia");

// DOM helpers
const el = (id) => document.getElementById(id);
const authUserEl = el("authUser");
const authRoleEl = el("authRole");

const primaryPathInput = el("primaryPathInput");
const secondaryPathInput = el("secondaryPathInput");
const fileInput = el("fileInput");
const jsonInput = el("jsonInput");
const btnValidate = el("btnValidate");
const btnExportPrimary = el("btnExportPrimary");
const btnAppendPrimary = el("btnAppendPrimary");
const btnReplacePrimary = el("btnReplacePrimary");
const btnDeleteSecondary = el("btnDeleteSecondary");
const btnReplaceAndDelete = el("btnReplaceAndDelete");
const btnCachePrimary = el("btnCachePrimary");
const statusEl = el("status");
const logEl = el("log");

function setStatus(s) { statusEl.textContent = s || ""; }
function log(s) { logEl.textContent += (s + "\n"); }
function clearLog() { logEl.textContent = ""; }

async function readJsonFromInputs() {
  const file = fileInput.files?.[0];
  if (file) {
    try {
      const txt = await file.text();
      return JSON.parse(txt);
    } catch (e) { throw new Error("Invalid JSON file: " + (e?.message || e)); }
  }
  if (jsonInput.value.trim()) {
    try {
      return JSON.parse(jsonInput.value);
    } catch (e) { throw new Error("Invalid pasted JSON: " + (e?.message || e)); }
  }
  throw new Error("Provide JSON via file upload or paste area.");
}

function normalizeDoc(docObj) {
  const d = { ...docObj };
  // ensure an id
  d.id = d.id || d.ID || d.name || d.uuid || d.slug || d.title || "";
  if (!d.id) throw new Error("Each doc must include an 'id' or a unique key.");
  return d;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function listAllDocIds(colPath) {
  const snap = await getDocs(collection(db, colPath));
  return snap.docs.map(d => d.id);
}

// Very light role resolution for UI (rules still enforce on server)
async function getUiRole(uid) {
  try {
    const snap = await getDoc(doc(db, "system", "allowlist", "users", uid));
    if (!snap.exists()) return "user";
    const d = snap.data() || {};
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
  } catch {}
  return "user";
}

function setControlsEnabled(isContribOrAdmin) {
  // Read-only safe ops: always enabled
  btnValidate.disabled = false;
  btnExportPrimary.disabled = false;

  // Destructive/backfill ops: gated in UI
  for (const b of [btnAppendPrimary, btnReplacePrimary, btnDeleteSecondary, btnReplaceAndDelete, btnCachePrimary]) {
    b.disabled = !isContribOrAdmin;
    b.classList.toggle("opacity-50", !isContribOrAdmin);
    b.classList.toggle("cursor-not-allowed", !isContribOrAdmin);
  }
}

function parseAppIdFromCollectionPath(colPath) {
  // artifacts/{appId}/public/data/werpassessments
  const parts = String(colPath || "").split("/");
  if (parts.length >= 2 && parts[0] === "artifacts") return parts[1];
  return "";
}

async function saveDocs(colPath, arr, merge = true) {
  const docs = arr.map(normalizeDoc);
  const BULK_LIMIT = 450;
  let wrote = 0, batches = 0;

  for (const part of chunk(docs, BULK_LIMIT)) {
    const batch = writeBatch(db);
    for (const d of part) {
      batch.set(doc(db, colPath, d.id), d, { merge });
    }
    await batch.commit();
    batches++;
    wrote += part.length;
    setStatus(`Wrote ${wrote}/${docs.length}…`);
  }
  return { wrote, batches };
}

async function deleteAll(colPath) {
  const ids = await listAllDocIds(colPath);
  if (ids.length === 0) return { deleted: 0, batches: 0 };
  const BULK_LIMIT = 450;
  let deleted = 0, batches = 0;

  for (const part of chunk(ids, BULK_LIMIT)) {
    const batch = writeBatch(db);
    for (const id of part) batch.delete(doc(db, colPath, id));
    await batch.commit();
    batches++;
    deleted += part.length;
    setStatus(`Deleted ${deleted}/${ids.length}…`);
  }
  return { deleted, batches };
}

// Actions
btnValidate.addEventListener("click", async () => {
  clearLog(); setStatus("Validating…");
  try {
    const arr = await readJsonFromInputs();
    if (!Array.isArray(arr)) throw new Error("Top-level JSON must be an array of documents.");
    const sample = arr.slice(0, 3).map(normalizeDoc);
    setStatus(`Valid JSON. ${arr.length} record(s).`);
    log(JSON.stringify(sample, null, 2));
  } catch (e) {
    setStatus(e.message || String(e));
  }
});

btnExportPrimary.addEventListener("click", async () => {
  clearLog(); setStatus("Exporting primary…");
  const col = primaryPathInput.value.trim();
  try {
    const snap = await getDocs(collection(db, col));
    const out = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "primary-export.json";
    a.click();
    setStatus(`Exported ${out.length} record(s).`);
  } catch (e) {
    setStatus("Export failed: " + (e?.message || e));
  }
});

btnAppendPrimary.addEventListener("click", async () => {
  clearLog(); setStatus("Appending to primary…");
  const col = primaryPathInput.value.trim();
  try {
    const arr = await readJsonFromInputs();
    const { wrote, batches } = await saveDocs(col, arr, true);
    setStatus(`Append complete: ${wrote} record(s) in ${batches} batch(es).`);
  } catch (e) {
    setStatus("Append failed: " + (e?.message || e));
  }
});

btnReplacePrimary.addEventListener("click", async () => {
  const col = primaryPathInput.value.trim();
  if (!confirm(`Replace primary?\nThis will DELETE all docs in:\n${col}\nThen import from JSON.`)) return;

  clearLog(); setStatus("Replacing primary (delete + import) …");
  try {
    const del = await deleteAll(col);
    log(`Deleted ${del.deleted} record(s) in ${del.batches} batch(es).`);
    const arr = await readJsonFromInputs();
    const put = await saveDocs(col, arr, false);
    setStatus(`Replace complete. Deleted ${del.deleted}, wrote ${put.wrote}.`);
  } catch (e) {
    setStatus("Replace failed: " + (e?.message || e));
  }
});

btnDeleteSecondary.addEventListener("click", async () => {
  const col = secondaryPathInput.value.trim();
  if (!col) { alert("Secondary collection path is empty."); return; }
  if (!confirm(`Delete ALL docs from secondary?\n${col}`)) return;

  clearLog(); setStatus("Deleting secondary…");
  try {
    const res = await deleteAll(col);
    setStatus(`Secondary deleted: ${res.deleted} record(s) in ${res.batches} batch(es).`);
  } catch (e) {
    setStatus("Delete secondary failed: " + (e?.message || e));
  }
});

btnReplaceAndDelete.addEventListener("click", async () => {
  const primary = primaryPathInput.value.trim();
  const secondary = secondaryPathInput.value.trim();
  if (!confirm(`Replace primary and then delete secondary?\nPrimary: ${primary}\nSecondary: ${secondary}`)) return;

  clearLog(); setStatus("Replace primary → delete secondary…");
  try {
    const del = await deleteAll(primary);
    log(`Deleted from primary: ${del.deleted} record(s).`);
    const arr = await readJsonFromInputs();
    const put = await saveDocs(primary, arr, false);
    log(`Imported into primary: ${put.wrote} record(s).`);

    if (secondary) {
      const del2 = await deleteAll(secondary);
      log(`Deleted secondary: ${del2.deleted} record(s).`);
    }
    setStatus("Replace and delete completed.");
  } catch (e) {
    setStatus("Replace+Delete failed: " + (e?.message || e));
  }
});

btnCachePrimary.addEventListener("click", async () => {
  clearLog();
  const col = primaryPathInput.value.trim();
  const appId = parseAppIdFromCollectionPath(col) || "guardian";
  if (!confirm(`Run cache backfill on:\nappId=${appId}\ncollectionPath=${col}\n\nThis enqueues media caching for reference images.`)) return;
  setStatus("Starting cache backfill…");
  try {
    const res = await callCacheCollection({ appId, collectionPath: col, limit: 300, dryRun: false });
    const data = res?.data || {};
    setStatus(`Backfill started. ${JSON.stringify(data)}`);
    log(JSON.stringify(data, null, 2));
  } catch (e) {
    setStatus("Backfill failed: " + (e?.message || e));
  }
});

// Auth/UI wiring
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    authUserEl.textContent = "Not signed in";
    authRoleEl.textContent = "—";
    setControlsEnabled(false);
    return;
  }
  authUserEl.textContent = user.email || user.uid;
  try {
    const role = await getUiRole(user.uid);
    authRoleEl.textContent = role;
    setControlsEnabled(role === "admin" || role === "contributor");
  } catch {
    authRoleEl.textContent = "user";
    setControlsEnabled(false);
  }
});