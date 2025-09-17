// Admin-only Task Dashboard (Kanban + Charts) for Project Guardian
// Requires: Tailwind (already in app), Firestore modular v9+ (db from index.html), admin role.
// Firestore path: artifacts/${appId}/private/admin/tasks

// Usage from index.html:
// import { initTasksDashboard } from "./tasks-dashboard.js";
// initTasksDashboard({ db, appId, getRole: () => state.role });

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

let firestore;
let charts = { status: null, priority: null };
let unsubTasks = null;
let tasks = [];
let roleGetter = () => "user";
let appIdGlobal = "guardian-agent-default";
let dbGlobal = null;

function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

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

function tasksCollectionPath() {
  return `artifacts/${appIdGlobal}/private/admin/tasks`;
}

function ensurePanel() {
  let panel = qs("#task-dashboard-panel");
  if (panel) return panel;

  // Create a hidden panel appended under #app; mirrors existing card visuals
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

    <!-- Modals -->
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
  const appRoot = qs("#app") || document.body;
  appRoot.appendChild(panel);

  // Close/open wiring
  qs("#btn-close-dashboard", panel).addEventListener("click", () => togglePanel(false));
  qs("#modal-close", panel).addEventListener("click", closeModal);
  qs("#task-modal", panel).addEventListener("click", (e) => { if (e.target.id === "task-modal") closeModal(); });

  // Add modal
  qs("#btn-new-task", panel).addEventListener("click", openAddModal);
  qs("#task-add-close", panel).addEventListener("click", closeAddModal);
  qs("#task-add-modal", panel).addEventListener("click", (e) => { if (e.target.id === "task-add-modal") closeAddModal(); });
  qs("#task-add-form", panel).addEventListener("submit", onAddTaskSubmit);

  // Filters
  qs("#task-filter-priority", panel).addEventListener("change", renderBoard);
  qs("#task-filter-area", panel).addEventListener("change", renderBoard);

  return panel;
}

function togglePanel(show) {
  const panel = ensurePanel();
  if (show) {
    panel.classList.remove("hidden");
    renderBoard();
    renderCharts();
  } else {
    panel.classList.add("hidden");
  }
}

function showToastSafe(msg, type = "info") {
  if (typeof window.showToast === "function") {
    window.showToast(msg, type);
  } else {
    console.log(`[${type}] ${msg}`);
  }
}

function openModal(task) {
  const panel = ensurePanel();
  qs("#modal-title", panel).textContent = task.name || "(Untitled)";
  qs("#modal-code", panel).textContent = task.code || task.id || "";
  qs("#modal-desc", panel).textContent = task.description || "";
  qs("#modal-priority", panel).innerHTML = `<span class="${priorityText[task.priority] || ""}">${task.priority || "-"}</span>`;
  qs("#modal-area", panel).textContent = task.area || "-";
  qs("#modal-status", panel).textContent = task.status || "-";
  const modal = qs("#task-modal", panel);
  modal.classList.remove("hidden");
}

function closeModal() {
  const panel = ensurePanel();
  qs("#task-modal", panel).classList.add("hidden");
}

function openAddModal() {
  if (roleGetter() !== "admin") {
    showToastSafe("Admin only", "error");
    return;
  }
  const panel = ensurePanel();
  qs("#task-add-modal", panel).classList.remove("hidden");
}

function closeAddModal() {
  const panel = ensurePanel();
  qs("#task-add-modal", panel).classList.add("hidden");
}

function getFilters() {
  const panel = ensurePanel();
  const p = qs("#task-filter-priority", panel)?.value || "all";
  const a = qs("#task-filter-area", panel)?.value || "all";
  return { priority: p, area: a };
}

function filteredTasks() {
  const { priority, area } = getFilters();
  return tasks.filter(t => {
    const pOk = (priority === "all") || (t.priority === priority);
    const aOk = (area === "all") || (t.area === area);
    return pOk && aOk;
  });
}

function statusCounts() {
  const counts = { "Not Started": 0, "In Progress": 0, "Done": 0 };
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return counts;
}

function priorityCounts() {
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const t of tasks) counts[t.priority] = (counts[t.priority] || 0) + 1;
  return counts;
}

function renderCharts() {
  const panel = ensurePanel();
  const sCanvas = qs("#chart-status", panel);
  const pCanvas = qs("#chart-priority", panel);
  if (!sCanvas || !pCanvas || !window.Chart) return;

  const sc = statusCounts();
  const pc = priorityCounts();

  if (charts.status) charts.status.destroy();
  charts.status = new window.Chart(sCanvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: Object.keys(sc),
      datasets: [{
        label: "Tasks by Status",
        data: Object.values(sc),
        backgroundColor: ["#d6d3d1", "#a8a29e", "#78716c"],
        borderColor: "#f5f5f4",
        borderWidth: 3
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "top" }, title: { display: true, text: "Tasks by Status" } }
    }
  });

  if (charts.priority) charts.priority.destroy();
  charts.priority = new window.Chart(pCanvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: Object.keys(pc),
      datasets: [{
        label: "Tasks by Priority",
        data: Object.values(pc),
        backgroundColor: ["#ef4444", "#f97316", "#eab308", "#22c55e"],
        borderColor: "#f5f5f4",
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, title: { display: true, text: "Tasks by Priority" } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
    }
  });
}

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
  card.addEventListener("dragstart", (e) => { card.classList.add("dragging"); e.dataTransfer.setData("text/plain", t._docId); });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  return card;
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

async function onDropColumn(e) {
  e.preventDefault();
  const col = e.currentTarget;
  col.classList.remove("drag-over");
  const newStatus = col.dataset.status;
  const docId = e.dataTransfer?.getData("text/plain");
  if (!docId || !newStatus) return;

  if (roleGetter() !== "admin") {
    showToastSafe("Admin only", "error");
    return;
  }

  try {
    const { doc, updateDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
    const ref = doc(dbGlobal, tasksCollectionPath(), docId);
    await updateDoc(ref, { status: newStatus, updatedAt: serverTimestamp() });
    showToastSafe(`Task moved to "${newStatus}"`, "success");
  } catch (err) {
    console.error(err);
    showToastSafe("Failed to update task", "error");
  }
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function renderBoard() {
  const panel = ensurePanel();
  const board = qs("#kanban-board", panel);
  if (!board) return;

  board.innerHTML = "";
  const ft = filteredTasks();

  for (const st of STATUS) {
    const col = makeColumn(st);
    const inCol = ft.filter(t => (t.status || "Not Started") === st);
    for (const t of inCol) col.appendChild(makeCard(t));
    board.appendChild(col);
  }

  // Update charts after board render for coherence
  renderCharts();
}

async function onAddTaskSubmit(e) {
  e.preventDefault();
  if (roleGetter() !== "admin") {
    showToastSafe("Admin only", "error");
    return;
  }
  const panel = ensurePanel();
  const name = qs("#new-name", panel).value.trim();
  const description = qs("#new-desc", panel).value.trim();
  const priority = qs("#new-priority", panel).value;
  const area = qs("#new-area", panel).value;
  const status = "Not Started";

  if (!name || !description) {
    showToastSafe("Please fill all fields", "error");
    return;
  }

  try {
    const { collection, addDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");

    // Compute next PG- code
    const maxNum = tasks
      .map(t => Number(String(t.code || "").split("-")[1]))
      .filter(n => Number.isFinite(n))
      .reduce((m, n) => Math.max(m, n), 0);
    const nextCode = `PG-${String(maxNum + 1).padStart(3, "0")}`;

    await addDoc(collection(dbGlobal, tasksCollectionPath()), {
      code: nextCode,
      name, description, area, priority, status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    showToastSafe("Task created", "success");
    closeAddModal();
    qs("#task-add-form", panel).reset();
  } catch (err) {
    console.error(err);
    showToastSafe("Failed to create task", "error");
  }
}

function subscribeTasks() {
  if (unsubTasks) { unsubTasks(); unsubTasks = null; }
  return (async () => {
    const { collection, query, orderBy, onSnapshot } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
    const q = query(collection(dbGlobal, tasksCollectionPath()), orderBy("createdAt", "desc"));
    unsubTasks = onSnapshot(q, snap => {
      tasks = snap.docs.map(d => ({ _docId: d.id, ...(d.data() || {}) }));
      renderBoard();
    }, err => {
      console.error("tasks subscription error", err);
    });
  })();
}

function insertAdminButton() {
  // Try to place inside header; fall back to top-right floating button
  const header = document.querySelector("header") || document.querySelector("header.bg-white") || document.body;

  let btn = document.getElementById("btn-task-dashboard");
  if (btn) return btn;

  btn = document.createElement("button");
  btn.id = "btn-task-dashboard";
  btn.type = "button";
  btn.textContent = "Task Dashboard";
  btn.className = "ml-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm";
  btn.addEventListener("click", async () => {
    if (roleGetter() !== "admin") {
      showToastSafe("Admin only", "error");
      return;
    }
    await ensureChartJs();
    ensurePanel();
    await subscribeTasks();
    togglePanel(true);
  });

  // Try appending inside header actions if exists
  const userInfo = document.getElementById("userInfo") || header;
  userInfo.appendChild(btn);
  return btn;
}

// Public API
export function initTasksDashboard({ db, appId, getRole }) {
  dbGlobal = db;
  appIdGlobal = appId || appIdGlobal;
  roleGetter = typeof getRole === "function" ? getRole : roleGetter;

  // Manage visibility of the admin button based on role
  const btn = insertAdminButton();

  const syncRoleVisibility = () => {
    const isAdmin = roleGetter() === "admin";
    if (btn) btn.style.display = isAdmin ? "inline-flex" : "none";
    if (!isAdmin) togglePanel(false);
  };

  // Poll role state lightly; existing app sets state.role asynchronously
  syncRoleVisibility();
  const interval = setInterval(syncRoleVisibility, 1000);

  // Stop polling when page is hidden to save cycles
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInterval(interval);
  });
}