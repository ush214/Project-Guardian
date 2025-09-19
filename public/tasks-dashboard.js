// tasks-dashboard.js
// Self-contained Task Dashboard aligned to the app's dark aesthetic.
// Uses localStorage for data (safe, no Firestore writes). Admin-gated via auth-role.js.

import {
  onAuthChanged, onRoleResolved, isAdmin, db
} from './auth-role.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* --------- Admin Gate --------- */
let currentUser = null;
let currentRole = 'guest';

function setGate(allowed) {
  const denied = $('#gate-denied');
  const body = $('#dashboard-body');
  if (allowed) {
    denied.classList.add('hidden');
    body.classList.remove('hidden');
  } else {
    body.classList.add('hidden');
    denied.classList.remove('hidden');
  }
  $('#header-user').textContent = currentUser?.email || '';
  $('#header-role').textContent = allowed ? 'admin' : (currentRole || 'guest');
}

/* --------- Data Model (Local) --------- */
const STORAGE_KEY = 'pg_tasks_v1';

const DEFAULT_TASKS = [
  { id: 'PG-001', name: 'Fix Vessel Analyse Function', description: 'Diagnose and resolve the error within the in-app "analyse" feature. This will likely involve debugging the trigger mechanism and the backend Python service it calls.', area: 'Backend / Frontend', priority: 'Critical', status: 'Not Started' },
  { id: 'PG-002', name: 'Fix Map Auto-Reload', description: 'Ensure the map component automatically re-fetches the latest data from Firestore when a user navigates back to it, so the status of wrecks is always current without a manual refresh.', area: 'Frontend', priority: 'High', status: 'Not Started' },
  { id: 'PG-003', name: 'Add Nationality to Map Pop-up', description: "Update the map pop-up UI component to display the vessel's nationality and ensure that data field is being pulled correctly from the main `werpassessments` document.", area: 'Frontend / Firestore', priority: 'Medium', status: 'Not Started' },
  { id: 'PG-004', name: 'Overlay Marine Protected Areas', description: 'Source a dataset of Marine Protected Areas (MPAs), likely as a GeoJSON file, and render it as a toggleable layer on the main map interface.', area: 'Frontend / Data', priority: 'Medium', status: 'Not Started' },
  { id: 'PG-005', name: 'Develop Spill Trajectory Simulation', description: 'Use metocean data (currents and wind) to run a basic simulation showing where a potential leak would drift. The output should be a visual path on the map that highlights any intersections with the MPA layer.', area: 'Backend / Data', priority: 'Low', status: 'Not Started' },
  { id: 'PG-006', name: 'Monitor Earthquakes', description: 'A more robust approach uses Peak Ground Acceleration (PGA) at the wreck location derived from USGS events. Threshold: 0.1g.', area: 'Backend / Data', priority: 'Low', status: 'Not Started' },
  { id: 'PG-007', name: 'Monitor Tropical Storms', description: 'Shallow (<50m): sustained winds ≥ 64 kn within 100 km. Deep: significant wave height > 6 m or ≥24h hurricane-force winds within core.', area: 'Backend / Data', priority: 'Low', status: 'Not Started' },
  { id: 'PG-008', name: 'Monitor Ocean Currents', description: 'Flag sustained average current speed > 2 kn for > 48 hours near wreck location. Indicates potential sediment transport and scouring risk.', area: 'Backend / Data', priority: 'Low', status: 'Not Started' },
  { id: 'PG-009', name: 'Monitor Ocean Acidification', description: 'Long-term risk factor. Flag regions with average pH < 7.8 for accelerated corrosion risk prioritization.', area: 'Backend / Data', priority: 'Low', status: 'Not Started' }
];

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_TASKS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_TASKS];
    return parsed;
  } catch {
    return [...DEFAULT_TASKS];
  }
}
function saveTasks(tasks) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch {}
}

let tasks = loadTasks();

/* --------- Filters --------- */
const priorityFilter = $('#priorityFilter');
const areaFilter = $('#areaFilter');

function applyFilters(list) {
  const p = priorityFilter?.value || 'all';
  const a = areaFilter?.value || 'all';
  return list.filter(t => (p === 'all' || t.priority === p) && (a === 'all' || t.area === a));
}

/* --------- Charts --------- */
let statusChart, priorityChart;

function rebuildCharts() {
  const ctxStatus = document.getElementById('statusChart').getContext('2d');
  const ctxPriority = document.getElementById('priorityChart').getContext('2d');

  const byStatus = tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
  const byPriority = tasks.reduce((acc, t) => { acc[t.priority] = (acc[t.priority] || 0) + 1; return acc; }, {});

  const commonOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#cbd5e1' } } }
  };

  // Status (doughnut)
  if (statusChart) statusChart.destroy();
  statusChart = new Chart(ctxStatus, {
    type: 'doughnut',
    data: {
      labels: Object.keys(byStatus),
      datasets: [{
        label: 'Tasks by Status',
        data: Object.values(byStatus),
        backgroundColor: ['#475569', '#06b6d4', '#22c55e'],
        borderColor: '#0f172a',
        borderWidth: 3
      }]
    },
    options: {
      ...commonOpts,
      plugins: { ...commonOpts.plugins, title: { display: true, text: 'Tasks by Status', color: '#e2e8f0' } }
    }
  });

  // Priority (bar)
  if (priorityChart) priorityChart.destroy();
  priorityChart = new Chart(ctxPriority, {
    type: 'bar',
    data: {
      labels: Object.keys(byPriority),
      datasets: [{
        label: 'Tasks by Priority',
        data: Object.values(byPriority),
        backgroundColor: ['#22c55e', '#eab308', '#f97316', '#ef4444'],
        borderColor: '#0f172a',
        borderWidth: 2
      }]
    },
    options: {
      ...commonOpts,
      scales: {
        x: { ticks: { color: '#cbd5e1' }, grid: { color: 'rgba(148,163,184,0.15)' } },
        y: { ticks: { color: '#cbd5e1', stepSize: 1 }, grid: { color: 'rgba(148,163,184,0.15)' }, beginAtZero: true }
      },
      plugins: {
        ...commonOpts.plugins,
        title: { display: true, text: 'Tasks by Priority', color: '#e2e8f0' },
        legend: { display: false }
      }
    }
  });
}

/* --------- Kanban --------- */
const STATUS_ORDER = ['Not Started', 'In Progress', 'Done'];
const PRIORITY_BADGES = {
  'Critical': 'text-rose-300 border-rose-400/30 bg-rose-500/10',
  'High': 'text-orange-300 border-orange-400/30 bg-orange-500/10',
  'Medium': 'text-amber-200 border-amber-300/30 bg-amber-400/10',
  'Low': 'text-emerald-200 border-emerald-300/30 bg-emerald-400/10'
};

const board = $('#kanban-board');

function renderBoard() {
  if (!board) return;
  board.innerHTML = '';
  const filtered = applyFilters(tasks);

  STATUS_ORDER.forEach(status => {
    const col = document.createElement('div');
    col.className = 'kanban-column card-inner p-3 min-h-[320px]';
    col.dataset.status = status;

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between pb-2 border-b border-white/10';
    header.innerHTML = `<h3 class="text-slate-200 font-semibold">${status}</h3>
      <span class="text-xs text-slate-400">${filtered.filter(t=>t.status===status).length}</span>`;
    col.appendChild(header);

    const list = document.createElement('div');
    list.className = 'pt-3 space-y-3';

    filtered
      .filter(t => t.status === status)
      .forEach(task => {
        const card = document.createElement('div');
        card.className = 'task-card bg-surface-800 border border-white/10 rounded-lg p-3 hover:border-white/20 transition cursor-grab';
        card.draggable = true;
        card.dataset.id = task.id;
        card.innerHTML = `
          <div class="flex items-start justify-between gap-3">
            <div class="font-medium text-slate-100">${escapeHtml(task.name)}</div>
            <span class="px-2 py-0.5 rounded-md border text-[11px] ${PRIORITY_BADGES[task.priority]||'text-slate-300 border-white/10 bg-white/5'}">${task.priority}</span>
          </div>
          <div class="mt-2 text-xs text-slate-400">${task.id}</div>
        `;
        // Events
        card.addEventListener('click', () => openViewModal(task.id));
        card.addEventListener('dragstart', handleDragStart);
        card.addEventListener('dragend', handleDragEnd);

        list.appendChild(card);
      });

    // DnD targets
    col.addEventListener('dragover', handleDragOver);
    col.addEventListener('dragleave', handleDragLeave);
    col.addEventListener('drop', handleDrop);

    col.appendChild(list);
    board.appendChild(col);
  });
}

/* --------- Modals --------- */
const taskModal = $('#taskModal');
const addTaskModal = $('#addTaskModal');

function openViewModal(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  $('#modal-title').textContent = task.name;
  $('#modal-id').textContent = task.id;
  $('#modal-description').innerHTML = (task.description||'').replace(/\n/g,'<br/>');
  $('#modal-priority').innerHTML = `<span class="px-2 py-0.5 rounded-md border text-[12px] ${PRIORITY_BADGES[task.priority]||'text-slate-300 border-white/10 bg-white/5'}">${task.priority}</span>`;
  $('#modal-area').textContent = task.area;
  $('#modal-status').textContent = task.status;

  taskModal.classList.remove('hidden');
  taskModal.classList.add('flex');
}
function closeViewModal() {
  taskModal.classList.add('hidden');
  taskModal.classList.remove('flex');
}

function openAddModal() {
  addTaskModal.classList.remove('hidden');
  addTaskModal.classList.add('flex');
}
function closeAddModal() {
  addTaskModal.classList.add('hidden');
  addTaskModal.classList.remove('flex');
}

$('#closeModal')?.addEventListener('click', closeViewModal);
taskModal?.addEventListener('click', (e)=>{
  if (e.target === taskModal) closeViewModal();
});
$('#cancelAddTaskBtn')?.addEventListener('click', closeAddModal);
addTaskModal?.addEventListener('click', (e)=>{
  if (e.target === addTaskModal) closeAddModal();
});

/* --------- Add Task --------- */
$('#addTaskBtn')?.addEventListener('click', openAddModal);

$('#addTaskForm')?.addEventListener('submit', (e)=>{
  e.preventDefault();
  const name = $('#newTaskName').value.trim();
  const description = $('#newTaskDescription').value.trim();
  const priority = $('#newTaskPriority').value;
  const area = $('#newTaskArea').value;

  // Generate next ID
  const maxNum = tasks
    .map(t => Number(String(t.id).split('-')[1]||0))
    .reduce((m,v)=>Number.isFinite(v)&&v>m?v:m, 0);
  const nextId = `PG-${String(maxNum+1).padStart(3,'0')}`;

  tasks.push({
    id: nextId, name, description, priority, area, status: 'Not Started'
  });
  saveTasks(tasks);
  renderBoard();
  rebuildCharts();
  e.target.reset();
  closeAddModal();
});

/* --------- DnD --------- */
let draggingId = null;

function handleDragStart(e) {
  draggingId = e.currentTarget?.dataset?.id || null;
  e.currentTarget?.classList.add('dragging');
}
function handleDragEnd(e) {
  e.currentTarget?.classList.remove('dragging');
  draggingId = null;
}
function handleDragOver(e) {
  e.preventDefault();
  const col = e.currentTarget;
  col.classList.add('drop-target');
}
function handleDragLeave(e) {
  e.currentTarget.classList.remove('drop-target');
}
function handleDrop(e) {
  e.preventDefault();
  const col = e.currentTarget;
  col.classList.remove('drop-target');
  const toStatus = col.dataset.status;
  if (!draggingId || !toStatus) return;
  const t = tasks.find(x => x.id === draggingId);
  if (!t) return;
  t.status = toStatus;
  saveTasks(tasks);
  renderBoard();
  rebuildCharts();
}

/* --------- Filters --------- */
priorityFilter?.addEventListener('change', renderBoard);
areaFilter?.addEventListener('change', renderBoard);

/* --------- Helpers --------- */
function escapeHtml(s){ return String(s||'').replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;","\">":"&gt;","\"":"&quot;","'":"&#39;"}[c]||c)); }

/* --------- Auth & Init --------- */
onAuthChanged((user)=>{
  currentUser = user;
  $('#header-user').textContent = user?.email || '';
});

onRoleResolved(({ role })=>{
  currentRole = role || 'guest';
  const allowed = isAdmin();
  setGate(allowed);
  if (allowed) {
    // Initialize UI
    renderBoard();
    rebuildCharts();
  }
});