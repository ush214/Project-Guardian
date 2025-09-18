// Import Tool using root-level shared auth-role.js (no /js/ folder)
// If you move auth-role.js back into a subfolder, update the import paths accordingly.

import { app, db, auth, functions } from "./auth-role.js";
import {
  doc, setDoc, getDoc, getDocs, collection, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";
import {
  onRoleResolved, onAuthChanged, isAdmin, isContributor
} from "./auth-role.js";

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
const logEl = el("log");
const statusEl = el("statusLine");

// ============ Utility / Parsing ============
function parseJsonFlexible(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return [parsed];
  throw new Error("JSON must be an object or an array of objects.");
}

async function readJsonFromInputs() {
  const file = fileInput.files?.[0];
  if (file) {
    try {
      const txt = await file.text();
      return parseJsonFlexible(txt);
    } catch (e) { throw new Error("Invalid JSON file: " + (e?.message || e)); }
  }
  if (jsonInput.value.trim()) {
    try {
      return parseJsonFlexible(jsonInput.value);
    } catch (e) { throw new Error("Invalid pasted JSON: " + (e?.message || e)); }
  }
  throw new Error("Provide JSON via file upload or paste area.");
}

function normalizeDoc(docObj) {
  const d = { ...docObj };
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

// UI gating
function setControlsEnabled(isContribOrAdmin) {
  btnValidate.disabled = false;
  btnExportPrimary.disabled = false;

  for (const b of [btnAppendPrimary, btnReplacePrimary, btnDeleteSecondary, btnReplaceAndDelete, btnCachePrimary]) {
    b.disabled = !isContribOrAdmin;
    b.classList.toggle("opacity-50", !isContribOrAdmin);
    b.classList.toggle("cursor-not-allowed", !isContribOrAdmin);
  }
}

function parseAppIdFromCollectionPath(colPath) {
  const parts = String(colPath || "").split("/");
  if (parts.length >= 2 && parts[0] === "artifacts") return parts[1];
  return "";
}

// ============ Logging / Status ============
function log(msg) {
  const line = document.createElement("div");
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
function clearLog() { logEl.innerHTML = ""; }
function setStatus(msg) { statusEl.textContent = msg; }

// ============ Core Firestore Ops ============
async function saveDocs(colPath, arr, merge = true) {
  let wrote = 0;
  const CHUNK = 450;
  for (const group of chunk(arr, CHUNK)) {
    const batch = writeBatch(db);
    for (const d of group) {
      batch.set(doc(db, colPath, d.id), d, { merge });
      wrote++;
    }
    await batch.commit();
  }
  return { wrote };
}

async function deleteAll(colPath) {
  const ids = await listAllDocIds(colPath);
  let deleted = 0;
  for (const group of chunk(ids, 450)) {
    const batch = writeBatch(db);
    group.forEach(id => batch.delete(doc(db, colPath, id)));
    await batch.commit();
    deleted += group.length;
  }
  return { deleted };
}

// ============ Button Handlers ============
btnValidate.addEventListener("click", async () => {
  clearLog();
  try {
    const arr = await readJsonFromInputs();
    const normalized = arr.map(normalizeDoc);
    log(`Validated ${normalized.length} doc(s).`);
    setStatus("Validation passed.");
  } catch (e) {
    setStatus("Validation failed.");
    log("ERROR: " + (e?.message || e));
  }
});

btnExportPrimary.addEventListener("click", async () => {
  clearLog();
  try {
    const col = primaryPathInput.value.trim();
    if (!col) throw new Error("Primary collection path required.");
    const snap = await getDocs(collection(db, col));
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const blob = new Blob([JSON.stringify(docs, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${col.replace(/\//g, "_")}.export.json`;
    a.click();
    setStatus("Export complete.");
    log(`Exported ${docs.length} doc(s).`);
  } catch (e) {
    setStatus("Export failed.");
    log("ERROR: " + (e?.message || e));
  }
});

btnAppendPrimary.addEventListener("click", async () => {
  clearLog(); setStatus("Appending…");
  try {
    const primary = primaryPathInput.value.trim();
    if (!primary) throw new Error("Primary path required.");
    const arr = (await readJsonFromInputs()).map(normalizeDoc);
    const { wrote } = await saveDocs(primary, arr, true);
    setStatus("Append complete.");
    log(`Appended ${wrote} document(s).`);
  } catch (e) {
    setStatus("Append failed.");
    log("ERROR: " + (e?.message || e));
  }
});

btnReplacePrimary.addEventListener("click", async () => {
  clearLog(); setStatus("Replacing primary…");
  try {
    const primary = primaryPathInput.value.trim();
    if (!primary) throw new Error("Primary path required.");
    const del = await deleteAll(primary);
    log(`Deleted from primary: ${del.deleted} doc(s).`);
    const arr = (await readJsonFromInputs()).map(normalizeDoc);
    const { wrote } = await saveDocs(primary, arr, false);
    setStatus("Replace complete.");
    log(`Imported into primary: ${wrote} doc(s).`);
  } catch (e) {
    setStatus("Replace failed.");
    log("ERROR: " + (e?.message || e));
  }
});

btnDeleteSecondary.addEventListener("click", async () => {
  clearLog(); setStatus("Deleting secondary…");
  try {
    const secondary = secondaryPathInput.value.trim();
    if (!secondary) throw new Error("Secondary path required.");
    const del = await deleteAll(secondary);
    log(`Deleted ${del.deleted} doc(s) from secondary.`);
    setStatus("Delete secondary complete.");
  } catch (e) {
    setStatus("Delete secondary failed.");
    log("ERROR: " + (e?.message || e));
  }
});

btnReplaceAndDelete.addEventListener("click", async () => {
  const primary = primaryPathInput.value.trim();
  const secondary = secondaryPathInput.value.trim();
  if (!primary) {
    alert("Primary path required.");
    return;
  }
  if (!confirm(`Replace primary and then delete secondary?\nPrimary: ${primary}\nSecondary: ${secondary || "(none)"}`)) return;

  clearLog(); setStatus("Replace primary → delete secondary…");
  try {
    const del = await deleteAll(primary);
    log(`Deleted from primary: ${del.deleted} record(s).`);
    const arr = (await readJsonFromInputs()).map(normalizeDoc);
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
  if (!col) {
    setStatus("Primary path required for caching.");
    return;
  }
  setStatus("Triggering cache function…");
  try {
    const res = await callCacheCollection({ appId });
    log("Cache function result: " + JSON.stringify(res.data));
    setStatus("Cache trigger completed.");
  } catch (e) {
    log("ERROR: " + (e?.message || e));
    setStatus("Cache trigger failed.");
  }
});

// ============ Auth / Role Wiring ============
onAuthChanged(user => {
  if (!user) {
    authUserEl.textContent = "Not signed in";
    authRoleEl.textContent = "—";
    setControlsEnabled(false);
    return;
  }
  authUserEl.textContent = user.email || user.uid;
});

onRoleResolved(({ role }) => {
  authRoleEl.textContent = role;
  setControlsEnabled(isContributor() || isAdmin());
});

// Initial UI baseline
setControlsEnabled(false);
authUserEl.textContent = "Checking sign-in…";
authRoleEl.textContent = "—";