// Task Dashboard (admin-only) for Project Guardian
// - Works with your existing Firebase app (uses getApp())
// - Always wires the "Task Dashboard" button (#btn-task-dashboard)
// - Shows clear feedback if not signed in or not admin
// - Persists tasks at artifacts/${appId}/private/admin/tasks
// - Lazy-loads Chart.js if needed

import { getApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, collection, addDoc, updateDoc,
  serverTimestamp, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

/* ====== Small, self-contained toast so user always sees feedback ====== */
function ensureToastStack() {
  let stack = document.getElementById("td-toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "td-toast-stack";
    stack.style.position = "fixed";
    stack.style.top = "12px";
    stack.style.right = "12px";
    stack.style.zIndex = "99999";
    stack.style.display = "grid";
    stack.style.gap = "8px";
    document.body.appendChild(stack);
  }
  return stack;
}
function notify(msg, type = "info") {
  // Prefer app toast if exported
  if (typeof window !== "undefined" && typeof window.showToast === "function") {
    window.showToast(msg, type);
    return;
  }
  const stack = ensureToastStack();
  const div = document.createElement("div");
  const bg = type === "success" ? "#059669" : type === "error" ? "#DC2626" : "#334155";
  div.textContent = msg;
  div.style.cssText = `
    color: #fff; background:${bg}; border-radius:10px;
    padding:10px 12px; min-width: 220px; font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.10);
  `;
  stack.appendChild(div);
  setTimeout(() => {
    div.style.transition = "opacity .25s, transform .25s";
    div.style.opacity = "0";
    div.style.transform = "translateY(-4px)";
    setTimeout(() => div.remove(), 250);
  }, 2500);
}

/* ====== Minor utilities ====== */
const STATUS = ["Not Started", "In Progress", "Done"];
const PRIORITIES = ["Critical", "High", "Medium", "Low"];
const AREAS = [
  "Backend / Frontend",
  "Frontend",
  "Frontend / Firestore",
  "Frontend / Data",
  "Backend / Data",
];
const priorityRing = {
  Critical: "border-red-500",
  High: "border-orange-500",
  Medium: "border-yellow-500",
  Low: "border-green-500",
};
const priorityText = {
  Critical: "text-red-600",
  High: "text-orange-600",
  Medium: "text-yellow-600",
  Low: "text-green-600",
};
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
async function ensureChartJs() {
  if (window.Chart) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load Chart.js"));
    document.head.appendChild(s);
  });
}

/* ====== Firebase wiring ====== */
let appId = (typeof window !== "undefined" && window.appId) || "guardian-agent-default";
let db = null;
let auth = null;
let role = "user";
let tasks = [];
let unsubTasks = null;
let charts = { status: null, priority: null };

/* ====== DOM builders ====== */
function injectLocalStyles() {
  if (document.getElementById("td-local-css")) return;
  const style = document.createElement("style");
  style.id = "td-local-css";
  style.textContent = `
    .kanban-column.drag-over { outline: 2px dashed rgba(255,255,255,0.25); background-color: rgba(30,41,59,0.35); }
    .task-card.dragging { opacity: 0.6; filter: drop-shadow(0 8px 16px rgba(0,0,0,0.25)); }
  `;
  document.head.appendChild(style);
}

function getButton() {
  let btn = document.getElementById("btn-task-dashboard");
  if (!btn) {
    // Create one if missing, add to header nav
    const header = document.querySelector("header") || document.body;
    const nav = header.querySelector("nav") || header;
    btn = document.createElement("button");
    btn.id = "btn-task-dashboard";
    btn.type = "button";
    btn.textContent = "Task Dashboard";
    btn.className =
      "ml-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm";
    nav.appendChild(btn);
  }
  return btn;
}

function ensurePanel() {
  let panel = document.getElementById("task-dashboard-panel");
  if (panel) return panel;

  panel = document.createElement("section");
  panel.id = "task-dashboard-panel";
  panel.className = "hidden p-6 bg-white rounded-lg shadow-md mt-6";
  panel.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-2xl font-semibold">Task Dashboard</h2>
        <p class="text-sm text-gray-500">Admin-only interactive board to manage development tasks</p>
      </div>
      <div class="flex gap-2">
        <button id="btn-close-dashboard" class="px-3 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm">Close</button>
        <button id="btn-new-task" class="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm">＋ New Task</button>
      </div>
    </div>

    <div id="task-summary" class="mb-8 p-4 bg-slate-800/50 rounded-lg">
      <h3 class="text-lg font-semibold text-white mb-3">Project Overview</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-slate-900/40 rounded-lg p-4">
          <canvas id="chart-status" height="220"></canvas>
        </div>
        <div class="bg-slate-900/40 rounded-lg p-4">
          <canvas id="chart-priority" height="220"></canvas>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap gap-4 items-end mb-6">
      <div>
        <label class="block text-sm font-medium text-gray-700">Filter by Priority</label>
        <select id="task-filter-priority" class="mt-1 block w-48 px-3 py-2 rounded-md border border-white/10 bg-slate-800 text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-600">
          <option value="all">All Priorities</option>
          ${PRIORITIES.map(p => `<option value="${p}">${p}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700">Filter by Area</label>
        <select id="task-filter-area" class="mt-1 block w-60 px-3 py-2 rounded-md border border-white/10 bg-slate-800 text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-600">
          <option value="all">All Areas</option>
          ${AREAS.map(a => `<option value="${a}">${a}</option>`).join("")}
        </select>
      </div>
    </div>

    <div id="kanban-board" class="grid grid-cols-1 md:grid-cols-3 gap-6"></div>

    <!-- View Modal -->
    <div id="task-modal" class="fixed inset-0 z-50 hidden">
      <div class="absolute inset-0 bg-black/50"></div>
      <div class="relative z-10 mx-auto mt-16 w-full max-w-2xl bg-white rounded-lg shadow-xl">
        <div class="p-6">
          <div class="flex justify-between items-start">
            <div>
              <h3 class="text-xl font-bold" id="modal-title"></h3>
              <p class="text-xs text-gray-500" id="modal-code"></p>
            </div>
            <button id="modal-close" class="text-gray-500 hover:text-gray-800 text-2xl font-bold">&times;</button>
          </div>
          <div class="mt-3 border-t pt-4">
            <p class="font-semibold">Description</p>
            <p id="modal-desc" class="text-gray-700 mt-1 whitespace-pre-wrap"></p>
            <div class="grid grid-cols-3 gap-4 mt-4 text-sm">
              <div><p class="font-semibold">Priority</p><p id="modal-priority"></p></div>
              <div><p class="font-semibold">Area</p><p id="modal-area"></p></div>
              <div><p class="font-semibold">Status</p><p id="modal-status"></p></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Modal -->
    <div id="task-add-modal" class="fixed inset-0 z-50 hidden">
      <div class="absolute inset-0 bg-black/50"></div>
      <div class="relative z-10 mx-auto mt-16 w-full max-w-2xl bg-white rounded-lg shadow-xl">
        <form id="task-add-form" class="p-6">
          <div class="flex justify-between items-start">
            <h3 class="text-xl font-bold">Add New Task</h3>
            <button type="button" id="task-add-close" class="text-gray-500 hover:text-gray-800 text-2xl font-bold">&times;</button>
          </div>
          <div class="mt-3 border-t pt-4 grid gap-4">
            <div>
              <label class="block text-sm font-medium">Task Name</label>
              <input id="new-name" required class="mt-1 w-full px-3 py-2 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-cyan-600" />
            </div>
            <div>
              <label class="block text-sm font-medium">Description</label>
              <textarea id="new-desc" rows="4" required class="mt-1 w-full px-3 py-2 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-cyan-600"></textarea>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium">Priority</label>
                <select id="new-priority" required class="mt-1 w-full px-3 py-2 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-cyan-600">
                  ${PRIORITIES.map(p => `<option>${p}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium">Area</label>
                <select id="new-area" required class="mt-1 w-full px-3 py-2 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-cyan-600">
                  ${AREAS.map(a => `<option>${a}</option>`).join("")}
                </select>
              </div>
            </div>
          </div>
          <div class="mt-5 flex justify-end">
            <button type="submit" class="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm">Save Task</button>
          </div>
        </form>
      </div>
    </div>
  `;

  (document.getElementById("app") || document.body).appendChild(panel);

  // Wire controls
  panel.querySelector("#btn-close-dashboard").addEventListener("click", () => togglePanel(false));
  panel.querySelector("#modal-close").addEventListener("click", closeModal);
  panel.querySelector("#task-modal").addEventListener("click", (e) => {
    if (e.target.id === "task-modal") closeModal();
  });

  panel.querySelector("#btn-new-task").addEventListener("click", openAddModal);
  panel.querySelector("#task-add-close").addEventListener("click", closeAddModal);
  panel.querySelector("#task-add-modal").addEventListener("click", (e) => {
    if (e.target.id === "task-add-modal") closeAddModal();
  });
  panel.querySelector("#task-add-form").addEventListener("submit", onAddTaskSubmit);

  panel.querySelector("#task-filter-priority").addEventListener("change", renderBoard);
  panel.querySelector("#task-filter-area").addEventListener("change", renderBoard);

  return panel;
}

function togglePanel(show) {
  const panel = ensurePanel();
  panel.classList.toggle("hidden", !show);
  if (show) {
    renderBoard();
    renderCharts();
  }
}

function openAddModal() {
  if (role !== "admin") {
    notify("Admin only", "error");
    return;
  }
  ensurePanel().querySelector("#task-add-modal").classList.remove("hidden");
}
function closeAddModal() {
  ensurePanel().querySelector("#task-add-modal").classList.add("hidden");
}

function openModal(task) {
  const panel = ensurePanel();
  panel.querySelector("#modal-title").textContent = task.name || "(Untitled)";
  panel.querySelector("#modal-code").textContent = task.code || task._docId || "";
  panel.querySelector("#modal-desc").textContent = task.description || "";
  panel.querySelector("#modal-priority").innerHTML = `<span class="${priorityText[task.priority] || ""}">${task.priority || "-"}</span>`;
  panel.querySelector("#modal-area").textContent = task.area || "-";
  panel.querySelector("#modal-status").textContent = task.status || "-";
  panel.querySelector("#task-modal").classList.remove("hidden");
}
function closeModal() {
  ensurePanel().querySelector("#task-modal").classList.add("hidden");
}

/* ====== Rendering ====== */
function makeCard(t) {
  const card = document.createElement("div");
  card.className = `task-card bg-white p-4 mb-3 rounded-lg shadow-sm border-l-4 ${priorityRing[t.priority] || "border-gray-300"}`;
  card.draggable = true;
  card.dataset.docId = t._docId;
  card.dataset.status = t.status || STATUS[0];
  card.innerHTML = `
    <p class="font-semibold text-gray-900">${escapeHtml(t.name || "(Untitled)")}</p>
    <div class="flex justify-between items-center mt-3 text-sm">
      <span class="text-gray-500">${escapeHtml(t.code || t._docId)}</span>
      <span class="px-2 py-1 rounded-full ${priorityText[t.priority] || ""} bg-stone-100">${t.priority || "-"}</span>
    </div>
  `;
  card.addEventListener("click", (e) => { e.stopPropagation(); openModal(t); });
  card.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    e.dataTransfer.setData("text/plain", t._docId);
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  return card;
}

async function onDropColumn(e) {
  e.preventDefault();
  const col = e.currentTarget;
  col.classList.remove("drag-over");
  const newStatus = col.dataset.status;
  const docId = e.dataTransfer?.getData("text/plain");
  if (!docId || !newStatus) return;

  if (role !== "admin") {
    notify("Admin only", "error");
    return;
  }
  try {
    await updateDoc(doc(db, tasksCollectionPath(), docId), { status: newStatus, updatedAt: serverTimestamp() });
    notify(`Task moved to "${newStatus}"`, "success");
  } catch (err) {
    console.error(err);
    notify("Failed to update task", "error");
  }
}

function makeColumn(title) {
  const col = document.createElement("div");
  col.className = "kanban-column p-4 rounded-lg min-h-[260px] transition-colors bg-slate-800/30 border border-white/10";
  col.dataset.status = title;
  col.innerHTML = `<h4 class="font-semibold text-slate-100 mb-3 text-center">${title}</h4>`;
  col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
  col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
  col.addEventListener("drop", onDropColumn);
  return col;
}

function getFilters() {
  const panel = ensurePanel();
  const p = panel.querySelector("#task-filter-priority")?.value || "all";
  const a = panel.querySelector("#task-filter-area")?.value || "all";
  return { p, a };
}
function filteredTasks() {
  const { p, a } = getFilters();
  return tasks.filter(t => {
    const pOk = (p === "all") || (t.priority === p);
    const aOk = (a === "all") || (t.area === a);
    return pOk && aOk;
  });
}

function renderBoard() {
  const board = ensurePanel().querySelector("#kanban-board");
  if (!board) return;
  board.innerHTML = "";
  const ft = filteredTasks();
  for (const st of STATUS) {
    const col = makeColumn(st);
    const inCol = ft.filter(t => (t.status || "Not Started") === st);
    for (const t of inCol) col.appendChild(makeCard(t));
    board.appendChild(col);
  }
  renderCharts();
}

function statusCounts() {
  const counts = { "Not Started": 0, "In Progress": 0, "Done": 0 };
  for (const t of tasks) counts[t.status || "Not Started"] = (counts[t.status || "Not Started"] || 0) + 1;
  return counts;
}
function priorityCounts() {
  const counts = { "Critical": 0, "High": 0, "Medium": 0, "Low": 0 };
  for (const t of tasks) counts[t.priority || "Low"] = (counts[t.priority || "Low"] || 0) + 1;
  return counts;
}
function renderCharts() {
  const panel = ensurePanel();
  const sCanvas = panel.querySelector("#chart-status");
  const pCanvas = panel.querySelector("#chart-priority");
  if (!sCanvas || !pCanvas || !window.Chart) return;

  const sc = statusCounts();
  const pc = priorityCounts();

  if (charts.status) charts.status.destroy();
  charts.status = new window.Chart(sCanvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: Object.keys(sc),
      datasets: [{ label: "Tasks by Status", data: Object.values(sc),
        backgroundColor: ["#d6d3d1", "#a8a29e", "#78716c"], borderColor: "#f5f5f4", borderWidth: 3 }]
    },
    options: { responsive: true, plugins: { legend: { position: "top" }, title: { display: true, text: "Tasks by Status" } } }
  });

  if (charts.priority) charts.priority.destroy();
  charts.priority = new window.Chart(pCanvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: Object.keys(pc),
      datasets: [{ label: "Tasks by Priority", data: Object.values(pc),
        backgroundColor: ["#ef4444", "#f97316", "#eab308", "#22c55e"], borderColor: "#f5f5f4", borderWidth: 2 }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, title: { display: true, text: "Tasks by Priority" } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
    }
  });
}

/* ====== Data wiring ====== */
function tasksCollectionPath() {
  return `artifacts/${appId}/private/admin/tasks`;
}
async function subscribeTasks() {
  if (unsubTasks) { unsubTasks(); unsubTasks = null; }
  const q = query(collection(db, tasksCollectionPath()), orderBy("createdAt", "desc"));
  unsubTasks = onSnapshot(q, (snap) => {
    tasks = snap.docs.map(d => ({ _docId: d.id, ...(d.data() || {}) }));
    renderBoard();
  }, (err) => {
    console.error("tasks subscription error", err);
    notify("Failed to load tasks", "error");
  });
}

/* ====== Role resolution (mirrors app) ====== */
async function resolveRole(uid) {
  try {
    const snap = await getDoc(doc(db, "system", "allowlist", "users", uid));
    if (snap.exists()) {
      const d = snap.data() || {};
      let r = d.role ?? d.Role ?? d.ROLE;
      if (typeof r === "string" && r.trim()) {
        r = r.trim().toLowerCase();
        if (r.startsWith("admin")) return "admin";
        if (r.startsWith("contrib")) return "contributor";
        if (["user","reader","viewer"].includes(r)) return "user";
      }
      if (d.admin) return "admin";
      if (d.contributor) return "contributor";
      if (d.allowed) return "user";
    }
  } catch {}
  // Legacy location
  try {
    const snap = await getDoc(doc(db, `artifacts/${appId}/private/users/${uid}`));
    if (snap.exists()) {
      const d = snap.data() || {};
      let r = d.role ?? d.Role ?? d.ROLE;
      if (typeof r === "string" && r.trim()) {
        r = r.trim().toLowerCase();
        if (r.startsWith("admin")) return "admin";
        if (r.startsWith("contrib")) return "contributor";
        if (["user","reader","viewer"].includes(r)) return "user";
      }
      if (d.admin) return "admin";
      if (d.contributor) return "contributor";
    }
  } catch {}
  return "user";
}

/* ====== Main control ====== */
async function handleOpenClick() {
  if (!auth?.currentUser) {
    notify("Please sign in to access the Task Dashboard", "error");
    return;
  }
  // Prefer role from main app state for immediate feedback
  role = (window.pgState?.role) || (await resolveRole(auth.currentUser.uid));
  if (role !== "admin") {
    notify(`Admin only (your role: ${role})`, "error");
    return;
  }

  injectLocalStyles();
  try {
    await ensureChartJs();
  } catch {
    // let dashboard open anyway without charts
  }
  ensurePanel();
  await subscribeTasks();
  togglePanel(true);
}

function init() {
  try {
    const app = getApp();
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (e) {
    console.error("Task Dashboard: Firebase not initialized. Ensure index.html initializes Firebase first.", e);
    notify("Task Dashboard failed to load (Firebase not initialized).", "error");
    return;
  }
  if (typeof window !== "undefined" && window.appId) appId = window.appId;

  const btn = getButton();
  btn.addEventListener("click", handleOpenClick);

  // Prepare hidden panel so it's ready instantly
  ensurePanel();

  // Keep a live role snapshot for better UX
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      role = "user";
      togglePanel(false);
      return;
    }
    role = (window.pgState?.role) || (await resolveRole(user.uid));
  });

  console.info("[TaskDashboard] module loaded; button wired; appId =", appId);
}

init();