/**
 * tasks-dashboard.js
 * Admin-only Firestore listener for tasks:
 *   /artifacts/{appId}/private/admin/tasks
 *
 * Relies on shared auth-role.js for role gating.
 */

import { db } from "./auth-role.js";
import { onAuthorized, isAdmin, getCurrentUser } from "./auth-role.js";
import {
  collection, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const statusEl = document.getElementById("tasks-status");
const listEl = document.getElementById("tasks-list");
const appId = window.appId || "guardian";

let unsubscribe = null;

function renderTask(id, data) {
  const li = document.createElement("li");
  li.className = "border rounded px-3 py-2 bg-white flex flex-col gap-1";
  li.innerHTML = `
    <div class="flex items-center justify-between">
      <span class="font-medium">${escapeHtml(data.title || id)}</span>
      <span class="text-xs px-2 py-0.5 rounded bg-slate-100 border">${escapeHtml(data.status || "pending")}</span>
    </div>
    <div class="text-xs text-slate-500">${escapeHtml(data.description || "")}</div>
  `;
  return li;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

function startListener() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  const colRef = collection(db, `artifacts/${appId}/private/admin/tasks`);
  const q = query(colRef, orderBy("createdAt", "desc"));
  unsubscribe = onSnapshot(q, snap => {
    listEl.innerHTML = "";
    if (snap.empty) {
      statusEl.textContent = "No tasks.";
      return;
    }
    statusEl.textContent = "";
    snap.forEach(docSnap => {
      listEl.appendChild(renderTask(docSnap.id, docSnap.data()));
    });
  }, err => {
    console.error("[tasks] listener error", err);
    statusEl.textContent = "Failed to load tasks (permission/network).";
  });
}

onAuthorized(["admin"], ({ user, role }) => {
  if (!isAdmin()) {
    statusEl.textContent = "Admin role required (your role: " + role + ")";
    return;
  }
  statusEl.textContent = "Loading tasks…";
  startListener();
  console.info("[tasks] Listener active for user", getCurrentUser()?.uid);
});

// If you want to allow contributors read-only in future:
// onAuthorized(['admin','contributor'], ... ) and only start listener if role === 'admin'.