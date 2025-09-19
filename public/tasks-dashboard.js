// Firestore-persisted Task Dashboard (allowlisted users can write; admins can also delete in future).
// Requires: auth-role.js (exports db, isAdmin, isContributor, isAllowlisted, onAuthChanged, onRoleResolved)

import {
  onAuthChanged, onRoleResolved, isAdmin, isAllowlisted, db
} from './auth-role.js';

import {
  collection, doc, setDoc, updateDoc, onSnapshot,
  serverTimestamp, runTransaction
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const $ = (s) => document.querySelector(s);

/* ---------- Access helpers ---------- */
const CAN_READ = () => isAllowlisted();
const CAN_WRITE = () => isAllowlisted(); // approved users can add/move
// const CAN_DELETE = () => isAdmin(); // for future administrative deletes

/* ---------- Gate ---------- */
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
  $('#header-role').textContent = allowed ? (isAdmin() ? 'admin' : 'approved') : (currentRole || 'guest');
}

/* ---------- App constants ---------- */
const appId = window.appId || 'guardian';
const TASKS_PATH = `artifacts/${appId}/private/admin/tasks`;
const SEQ_DOC_PATH = `artifacts/${appId}/private/admin/tasks_meta/sequence`;

const board = $('#kanban-board');
const priorityFilter = $('#priorityFilter');
const areaFilter = $('#areaFilter');

const STATUS_ORDER = ['Not Started', 'In Progress', 'Done'];
const PRIORITY_BADGES = {
  'Critical': 'text-rose-300 border-rose-400/30 bg-rose-500/10',
  'High': 'text-orange-300 border-orange-400/30 bg-orange-500/10',
  'Medium': 'text-amber-200 border-amber-300/30 bg-amber-400/10',
  'Low': 'text-emerald-200 border-emerald-300/30 bg-emerald-400/10'
};

function escapeHtml(s){ return String(s||'').replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;","\">":"&gt;","\"":"&quot;","'":"&#39;"}[c]||c)); }

/* ---------- Charts ---------- */
let statusChart, priorityChart;
function rebuildCharts(tasks) {
  const byStatus = tasks.reduce((acc, t) => { acc[t.status||'Not Started'] = (acc[t.status||'Not Started'] || 0) + 1; return acc; }, {});
  const byPriority = tasks.reduce((acc, t) => { acc[t.priority||'Low'] = (acc[t.priority||'Low'] || 0) + 1; return acc; }, {});

  const ctxStatus = document.getElementById('statusChart')?.getContext('2d');
  const ctxPriority = document.getElementById('priorityChart')?.getContext('2d');
  if(!ctxStatus || !ctxPriority) return;

  const common = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#cbd5e1' } } }
  };

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
      ...common,
      plugins: { ...common.plugins, title: { display: true, text: 'Tasks by Status', color: '#e2e8f0' } }
    }
  });

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
      ...common,
      scales: {
        x: { ticks: { color: '#cbd5e1' }, grid: { color: 'rgba(148,163,184,0.15)' } },
        y: { ticks: { color: '#cbd5e1', stepSize: 1 }, grid: { color: 'rgba(148,163,184,0.15)' }, beginAtZero: true }
      },
      plugins: {
        ...common.plugins,
        title: { display: true, text: 'Tasks by Priority', color: '#e2e8f0' },
        legend: { display: false }
      }
    }
  });
}

/* ---------- Board render ---------- */
function applyFilters(list) {
  const p = priorityFilter?.value || 'all';
  const a = areaFilter?.value || 'all';
  return list.filter(t => (p === 'all' || t.priority === p) && (a === 'all' || t.area === a));
}
function renderBoard(tasks) {
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

    filtered.filter(t => t.status === status).forEach(task => {
      const card = document.createElement('div');
      card.className = 'task-card bg-surface-800 border border-white/10 rounded-lg p-3 hover:border-white/20 transition cursor-grab';
      card.draggable = CAN_WRITE();
      card.dataset.id = task.id; // document ID
      card.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="font-medium text-slate-100">${escapeHtml(task.name || '')}</div>
          <span class="px-2 py-0.5 rounded-md border text-[11px] ${PRIORITY_BADGES[task.priority]||'text-slate-300 border-white/10 bg-white/5'}">${task.priority||'Low'}</span>
        </div>
        <div class="mt-2 text-xs text-slate-400">${task.id}</div>
      `;
      card.addEventListener('click', () => openViewModal(task));
      if (CAN_WRITE()) {
        card.addEventListener('dragstart', handleDragStart);
        card.addEventListener('dragend', handleDragEnd);
      }
      list.appendChild(card);
    });

    if (CAN_WRITE()) {
      col.addEventListener('dragover', handleDragOver);
      col.addEventListener('dragleave', handleDragLeave);
      col.addEventListener('drop', (e)=>handleDrop(e));
    }

    col.appendChild(list);
    board.appendChild(col);
  });
}

/* ---------- Modal logic ---------- */
const taskModal = $('#taskModal');
const addTaskModal = $('#addTaskModal');

function openViewModal(task) {
  $('#modal-title').textContent = task.name || '';
  $('#modal-id').textContent = task.id || '';
  $('#modal-description').innerHTML = String(task.description||'').replace(/\n/g,'<br/>');
  $('#modal-priority').innerHTML = `<span class="px-2 py-0.5 rounded-md border text-[12px] ${PRIORITY_BADGES[task.priority]||'text-slate-300 border-white/10 bg-white/5'}">${task.priority||''}</span>`;
  $('#modal-area').textContent = task.area || '';
  $('#modal-status').textContent = task.status || '';
  taskModal.classList.remove('hidden'); taskModal.classList.add('flex');
}
function closeViewModal() { taskModal.classList.add('hidden'); taskModal.classList.remove('flex'); }
$('#closeModal')?.addEventListener('click', closeViewModal);
taskModal?.addEventListener('click', (e)=>{ if (e.target === taskModal) closeViewModal(); });

function openAddModal() {
  if (!CAN_WRITE()) { alert('You need an approved account to add tasks.'); return; }
  addTaskModal.classList.remove('hidden'); addTaskModal.classList.add('flex');
}
function closeAddModal() { addTaskModal.classList.add('hidden'); addTaskModal.classList.remove('flex'); }
$('#cancelAddTaskBtn')?.addEventListener('click', closeAddModal);
addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ closeViewModal(); closeAddModal(); }});

/* ---------- Add Task (allowlisted) ---------- */
$('#addTaskBtn')?.addEventListener('click', openAddModal);

$('#addTaskForm')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(!CAN_WRITE()){ alert('You need an approved account to add tasks.'); return; }

  const name = $('#newTaskName').value.trim();
  const description = $('#newTaskDescription').value.trim();
  const priority = $('#newTaskPriority').value;
  const area = $('#newTaskArea').value;

  try {
    const newId = await allocateNextId(); // PG-XXX
    const ref = doc(collection(db, TASKS_PATH), newId);
    await setDoc(ref, {
      id: newId,
      name, description, priority, area,
      status: 'Not Started',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: currentUser?.uid || null
    }, { merge: true });

    e.target.reset();
    closeAddModal();
  } catch (err) {
    console.error('[tasks] add failed', err);
    alert('Failed to add task. Check console for details.');
  }
});

/* ---------- Drag & Drop status update (allowlisted) ---------- */
let draggingId = null;
function handleDragStart(e) {
  draggingId = e.currentTarget?.dataset?.id || null;
  e.currentTarget?.classList.add('dragging');
}
function handleDragEnd(e) {
  e.currentTarget?.classList.remove('dragging');
  draggingId = null;
}
function handleDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drop-target'); }
function handleDragLeave(e) { e.currentTarget.classList.remove('drop-target'); }
async function handleDrop(e) {
  e.preventDefault();
  const col = e.currentTarget;
  col.classList.remove('drop-target');
  const toStatus = col.dataset.status;
  if (!CAN_WRITE()) return;
  if (!draggingId || !toStatus) return;
  try {
    const ref = doc(collection(db, TASKS_PATH), draggingId);
    await updateDoc(ref, { status: toStatus, updatedAt: serverTimestamp() });
  } catch (err) {
    console.error('[tasks] status update failed', err);
    alert('Failed to update task status.');
  } finally {
    draggingId = null;
  }
}

/* ---------- Firestore subscription ---------- */
let unsubTasks = null;
function subscribeTasks() {
  if (unsubTasks) { try{unsubTasks();}catch{} unsubTasks=null; }
  unsubTasks = onSnapshot(collection(db, TASKS_PATH), (snap)=>{
    const list = snap.docs.map(d=>{
      const data = d.data() || {};
      return { id: d.id, ...data };
    });
    renderBoard(list);
    rebuildCharts(list);
  }, (err)=>{
    console.error('[tasks] subscribe error', err);
  });
}

/* ---------- Sequence allocator (PG-XXX) ---------- */
async function allocateNextId() {
  const seqRef = doc(db, SEQ_DOC_PATH);
  const nextVal = await runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef);
    let value = 0;
    if (snap.exists()) {
      const current = Number(snap.data().value) || 0;
      value = current + 1;
    } else {
      value = 1;
    }
    tx.set(seqRef, { value }, { merge: true });
    return value;
  });
  return `PG-${String(nextVal).padStart(3,'0')}`;
}

/* ---------- Auth & init ---------- */
onAuthChanged((user)=>{
  currentUser = user;
  $('#header-user').textContent = user?.email || '';
});

onRoleResolved(({ role })=>{
  currentRole = role || 'guest';
  const allowed = CAN_READ();
  setGate(allowed);
  if (allowed) {
    subscribeTasks();
  } else {
    if (unsubTasks) { try{unsubTasks();}catch{} unsubTasks=null; }
  }
});