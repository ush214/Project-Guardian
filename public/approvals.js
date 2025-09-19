// approvals.js — Admin-only UI for reviewing and approving registration requests.
// Data model:
// - system/approvals/users/{uid}   : created by the user, {email, displayName, createdAt, status: 'pending'|'approved'|'rejected', notes?}
// - system/allowlist/users/{uid}   : written by admins when approving, {admin?, contributor?, allowed? true, role?, approvedAt, approvedBy}
// This UI writes allowlist and updates the approvals doc accordingly.

import {
  onAuthChanged, onRoleResolved, isAdmin, db
} from './auth-role.js';

import {
  collection, doc, onSnapshot, setDoc, updateDoc, serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const $ = (s)=>document.querySelector(s);

let currentUser = null;

// Gate
function setGate() {
  const allowed = isAdmin();
  $('#header-user').textContent = currentUser?.email || '';
  $('#header-role').textContent = allowed ? 'admin' : 'guest';
  $('#gate-denied').classList.toggle('hidden', allowed);
  $('#approvals-body').classList.toggle('hidden', !allowed);
}

onAuthChanged((u)=>{ currentUser = u; $('#header-user').textContent = u?.email || ''; });
onRoleResolved(()=>{ setGate(); if (isAdmin()) init(); });

function init(){
  subscribeApprovals();
  $('#search')?.addEventListener('input', renderAll);
}

let approvals = []; // [{id:uid, ...data}]
function subscribeApprovals(){
  const ref = collection(db, 'system', 'approvals', 'users');
  const q = query(ref, orderBy('createdAt','desc'));
  onSnapshot(q, (snap)=>{
    approvals = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));
    renderAll();
  }, (err)=>console.error('[approvals] subscribe error', err));
}

function renderAll(){
  const term = ($('#search')?.value || '').toLowerCase();
  const matches = (r)=>{
    const hay = [
      r.email || '', r.displayName || '', r.id || '', r.notes || ''
    ].join(' ').toLowerCase();
    return hay.includes(term);
  };

  const pending = approvals.filter(r=>(r.status||'pending')==='pending').filter(matches);
  const decided = approvals.filter(r=>['approved','rejected'].includes(r.status)).filter(matches);

  // Stats
  $('#stat-pending').textContent = approvals.filter(r=>(r.status||'pending')==='pending').length;
  $('#stat-approved').textContent = approvals.filter(r=>r.status==='approved').length;
  $('#stat-rejected').textContent = approvals.filter(r=>r.status==='rejected').length;

  // Pending list
  const pWrap = $('#pending-list');
  pWrap.innerHTML = '';
  if (!pending.length) $('#pending-empty').classList.remove('hidden'); else $('#pending-empty').classList.add('hidden');

  pending.forEach(rec=>{
    const card = document.createElement('div');
    card.className = 'card-inner p-4';
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-slate-100 font-medium">${escapeHtml(rec.displayName || '(no name)')}</div>
          <div class="text-sm text-slate-300">${escapeHtml(rec.email || '')}</div>
          <div class="text-xs text-slate-400 mt-1">${rec.id}</div>
        </div>
        <div class="text-xs text-slate-400">${formatTs(rec.createdAt)}</div>
      </div>

      <div class="mt-3 text-sm text-slate-300 whitespace-pre-wrap">${escapeHtml(rec.notes || '')}</div>

      <div class="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <select class="role-select px-3 py-2 rounded-lg bg-surface-800 border border-white/10 text-slate-100">
          <option value="contributor">Contributor</option>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <button class="btn-approve px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white">Approve</button>
        <button class="btn-reject px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white">Reject</button>
      </div>
    `;
    const roleSel = card.querySelector('.role-select');
    const btnApprove = card.querySelector('.btn-approve');
    const btnReject = card.querySelector('.btn-reject');

    btnApprove.addEventListener('click', async ()=>{
      const role = roleSel.value;
      await approveRecord(rec, role);
    });
    btnReject.addEventListener('click', async ()=>{
      await rejectRecord(rec);
    });

    pWrap.appendChild(card);
  });

  // History
  const hWrap = $('#history-list');
  hWrap.innerHTML = '';
  if (!decided.length) $('#history-empty').classList.remove('hidden'); else $('#history-empty').classList.add('hidden');

  decided.forEach(rec=>{
    const color = rec.status==='approved' ? 'text-emerald-300' : 'text-rose-300';
    const chip  = rec.status==='approved' ? 'bg-emerald-500/10 border-emerald-300/30' : 'bg-rose-500/10 border-rose-300/30';
    const card = document.createElement('div');
    card.className = 'card-inner p-4';
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-slate-100 font-medium">${escapeHtml(rec.displayName || '(no name)')}</div>
          <div class="text-sm text-slate-300">${escapeHtml(rec.email || '')}</div>
          <div class="text-xs text-slate-400 mt-1">${rec.id}</div>
        </div>
        <div class="text-xs text-slate-400">${formatTs(rec.approvedAt || rec.rejectedAt || rec.updatedAt)}</div>
      </div>
      <div class="mt-2">
        <span class="px-2 py-0.5 rounded-md border ${chip} ${color} text-xs">${rec.status?.toUpperCase() || ''}</span>
        ${rec.roleAssigned ? `<span class="ml-2 text-xs text-slate-300">Role: ${escapeHtml(rec.roleAssigned)}</span>` : ''}
      </div>
      ${rec.notes ? `<div class="mt-3 text-sm text-slate-300 whitespace-pre-wrap">${escapeHtml(rec.notes)}</div>` : ''}
    `;
    hWrap.appendChild(card);
  });
}

function escapeHtml(s){ return String(s||'').replace(/[&<>\"']/g, c=>({"&":"&amp;","<":"&lt;","\">":"&gt;","\"":"&quot;","'":"&#39;"}[c]||c)); }
function formatTs(ts){
  try{
    const d = ts?.toDate ? ts.toDate() : (typeof ts === 'number' ? new Date(ts) : null);
    if(!d) return '';
    return d.toLocaleString();
  }catch{return '';}
}

async function approveRecord(rec, role){
  if (!isAdmin()) return;
  const uid = rec.id;
  const allowRef = doc(db, 'system', 'allowlist', 'users', uid);
  await setDoc(allowRef, {
    allowed: true,
    admin: role === 'admin',
    contributor: role === 'contributor',
    role,
    approvedAt: serverTimestamp(),
    approvedBy: currentUser?.uid || null,
    email: rec.email || null,
    displayName: rec.displayName || null
  }, { merge: true });

  const apprRef = doc(db, 'system', 'approvals', 'users', uid);
  await updateDoc(apprRef, {
    status: 'approved',
    roleAssigned: role,
    approvedAt: serverTimestamp(),
    approvedBy: currentUser?.uid || null,
    updatedAt: serverTimestamp()
  });
}

async function rejectRecord(rec){
  if (!isAdmin()) return;
  const uid = rec.id;
  const apprRef = doc(db, 'system', 'approvals', 'users', uid);
  await updateDoc(apprRef, {
    status: 'rejected',
    rejectedAt: serverTimestamp(),
    rejectedBy: currentUser?.uid || null,
    updatedAt: serverTimestamp()
  });
}