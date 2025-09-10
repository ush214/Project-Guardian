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
    const docs = arr.map(normalizeDoc);
    let done = 0;
    for (const d of docs) {
      await setDoc(doc(db, col, d.id), d, { merge: true });
      done++;
      if (done % 25 === 0) setStatus(`Appended ${done}/${docs.length}…`);
    }
    setStatus(`Append complete: ${done} record(s).`);
  } catch (e) {
    setStatus("Append failed: " + (e?.message || e));
  }
});

btnReplacePrimary.addEventListener("click", async () => {
  clearLog(); setStatus("Replacing primary (delete + import)…");
  const col = primaryPathInput.value.trim();
  try {
    const arr = await readJsonFromInputs();
    const docs = arr.map(normalizeDoc);

    // Delete all current docs in batches
    const ids = await listAllDocIds(col);
    for (const group of chunk(ids, 400)) {
      const batch = writeBatch(db);
      for (const id of group) batch.delete(doc(db, col, id));
      await batch.commit();
    }
    log(`Deleted ${ids.length} existing doc(s).`);

    // Import new docs in batches
    for (const group of chunk(docs, 400)) {
      const batch = writeBatch(db);
      for (const d of group) batch.set(doc(db, col, d.id), d, { merge: false });
      await batch.commit();
    }
    setStatus(`Replace complete: imported ${docs.length} doc(s).`);

  } catch (e) {
    setStatus("Replace failed: " + (e?.message || e));
  }
});

btnDeleteSecondary.addEventListener("click", async () => {
  clearLog(); setStatus("Deleting secondary…");
  const col = secondaryPathInput.value.trim();
  try {
    const ids = await listAllDocIds(col);
    for (const group of chunk(ids, 400)) {
      const batch = writeBatch(db);
      for (const id of group) batch.delete(doc(db, col, id));
      await batch.commit();
    }
    setStatus(`Deleted ${ids.length} from secondary.`);
  } catch (e) {
    setStatus("Delete failed: " + (e?.message || e));
  }
});

btnReplaceAndDelete.addEventListener("click", async () => {
  clearLog(); setStatus("Replacing primary AND deleting secondary…");
  const primary = primaryPathInput.value.trim();
  const secondary = secondaryPathInput.value.trim();
  try {
    // Replace primary
    const arr = await readJsonFromInputs();
    const docs = arr.map(normalizeDoc);

    const ids = await listAllDocIds(primary);
    for (const group of chunk(ids, 400)) {
      const batch = writeBatch(db);
      for (const id of group) batch.delete(doc(db, primary, id));
      await batch.commit();
    }
    log(`Deleted ${ids.length} existing doc(s) in primary.`);

    for (const group of chunk(docs, 400)) {
      const batch = writeBatch(db);
      for (const d of group) batch.set(doc(db, primary, d.id), d, { merge: false });
      await batch.commit();
    }
    log(`Imported ${docs.length} into primary.`);

    // Delete secondary
    const sids = await listAllDocIds(secondary);
    for (const group of chunk(sids, 400)) {
      const batch = writeBatch(db);
      for (const id of group) batch.delete(doc(db, secondary, id));
      await batch.commit();
    }
    setStatus(`Done. Primary replaced with ${docs.length}, secondary deleted ${sids.length}.`);
  } catch (e) {
    setStatus("Replace and delete failed: " + (e?.message || e));
  }
});

// NEW: Backfill cache for primary
btnCachePrimary.addEventListener("click", async () => {
  clearLog();
  const path = primaryPathInput.value.trim();
  if (!path) { setStatus("Enter the primary collection path."); return; }
  setStatus("Caching media for primary collection… requires billing to fetch external images.");
  try {
    const res = await callCacheCollection({ appId: "guardian", collectionPath: path, limit: 1000 });
    const out = res?.data || {};
    setStatus(`Cache finished. Processed ${out.processed || 0} doc(s); cached ${out.created || 0} image(s), skipped ${out.skipped || 0}.`);
    log(JSON.stringify(out, null, 2));
  } catch (e) {
    setStatus("Cache failed: " + (e?.message || e));
  }
});

// Auth gate: show a note if user isn't logged in
onAuthStateChanged(auth, (user) => {
  if (!user) {
    setStatus("Note: You are not signed in. Importing/backfill will fail unless authenticated.");
  } else {
    setStatus(`Signed in as ${user.email || user.uid}`);
  }
});