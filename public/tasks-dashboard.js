import {
  db, onAuthorized, isAdmin, getCurrentUser,
  onAuthChanged, onRoleResolved, signOutUser
} from "./auth-role.js";
import {
  collection, onSnapshot, query, orderBy,
  doc, setDoc, updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const appId = window.appId || "guardian";
const collectionPath = `artifacts/${appId}/private/admin/tasks`;

const statusEl = document.getElementById("tasks-status");
const listEl = document.getElementById("tasks-list");
const emptyIndicator = document.getElementById("empty-indicator");
const hdrEmail = document.getElementById("hdr-email");
const hdrRole = document.getElementById("hdr-role");
const signOutBtn = document.getElementById("btn-signout");
const createSection = document.getElementById("create-section");
const taskForm = document.getElementById("task-form");
const titleInput = document.getElementById("task-title");
const descInput = document.getElementById("task-desc");
const statusInput = document.getElementById("task-status");
const tagsInput = document.getElementById("task-tags");
const createMsg = document.getElementById("create-msg");
let unsubscribe = null;

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function statusBadgeClass(st){
  switch(st){
    case "done": return "bg-emerald-100 text-emerald-700 border border-emerald-300";
    case "in_progress": return "bg-amber-100 text-amber-700 border border-amber-300";
    default: return "bg-slate-200 text-slate-700 border border-slate-300";
  }
}
function cycleStatus(st){
  return st==="pending" ? "in_progress" : st==="in_progress" ? "done" : "pending";
}

function renderTask(id,data){
  const li=document.createElement('li');
  li.className="group border rounded-lg p-4 bg-white shadow-sm hover:shadow transition flex flex-col gap-2";
  const title=escapeHtml(data.title||id);
  const desc=escapeHtml(data.description||"");
  const st=data.status||"pending";
  const created=data.createdAt?.toDate?data.createdAt.toDate().toLocaleString():"—";
  const tags=Array.isArray(data.tags)?data.tags:[];
  const tagsHtml=tags.map(t=>`<span class="px-2 py-0.5 text-[10px] rounded bg-slate-100 border border-slate-300 text-slate-600">${escapeHtml(t)}</span>`).join(" ");
  const adminControls=isAdmin()?`
    <div class="flex items-center gap-2">
      <button data-action="cycle" data-id="${id}" class="text-[11px] underline text-indigo-600 hover:text-indigo-500">Cycle</button>
      <button data-action="delete" data-id="${id}" class="text-[11px] underline text-rose-600 hover:text-rose-500">Delete</button>
    </div>`:"";
  li.innerHTML=`
    <div class="flex flex-col md:flex-row md:items-start gap-2 md:gap-4">
      <div class="flex-1 min-w-0">
        <div class="flex items-start gap-2">
          <h3 class="font-semibold text-slate-800 truncate">${title}</h3>
          <span class="status-pill ${statusBadgeClass(st)}"
                data-action="${isAdmin()?'cycle':''}"
                data-id="${id}"
                style="cursor:${isAdmin()?'pointer':'default'}">${st.replace(/_/g,' ')}</span>
        </div>
        ${desc?`<p class="text-sm text-slate-600 mt-1 whitespace-pre-line">${desc}</p>`:""}
        ${tagsHtml?`<div class="mt-2 flex flex-wrap gap-1">${tagsHtml}</div>`:""}
      </div>
      <div class="flex flex-col items-end gap-1 text-xs text-slate-500">
        <div><span class="font-medium">Created:</span> ${escapeHtml(created)}</div>
        ${adminControls}
      </div>
    </div>`;
  return li;
}

function startListener(){
  if(unsubscribe){ unsubscribe(); }
  const colRef=collection(db, collectionPath);
  const q=query(colRef, orderBy("createdAt","desc"));
  unsubscribe=onSnapshot(q,snap=>{
    listEl.innerHTML="";
    if(snap.empty){
      emptyIndicator.classList.remove("hidden");
      statusEl.textContent="No tasks.";
      return;
    }
    emptyIndicator.classList.add("hidden");
    statusEl.textContent="";
    snap.forEach(d=>listEl.appendChild(renderTask(d.id,d.data())));
  },err=>{
    console.error("[tasks] listener error",err);
    statusEl.textContent="Permission denied or network error.";
  });
}

async function createTask(e){
  e.preventDefault();
  if(!isAdmin()){ createMsg.textContent="Not authorized."; return; }
  const title=titleInput.value.trim();
  if(!title){ createMsg.textContent="Title required."; return; }
  const description=descInput.value.trim();
  const status=statusInput.value;
  const tags=tagsInput.value.split(',').map(t=>t.trim()).filter(Boolean);
  createMsg.textContent="Creating…";
  try{
    const id=crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2);
    await setDoc(doc(collection(db, collectionPath), id), {
      title, description, status, tags,
      createdAt: serverTimestamp(),
      createdBy: getCurrentUser()?.uid || null
    });
    titleInput.value="";
    descInput.value="";
    tagsInput.value="";
    statusInput.value="pending";
    createMsg.textContent="Created.";
    setTimeout(()=>createMsg.textContent="",2000);
  }catch(e2){
    console.error(e2);
    createMsg.textContent=e2?.message||"Failed.";
  }
}

async function cycleTaskStatus(id){
  if(!isAdmin()) return;
  const pill=listEl.querySelector(`.status-pill[data-id="${CSS.escape(id)}"]`);
  if(!pill) return;
  const current=pill.textContent.trim().replace(/\s+/g,'_');
  const next=cycleStatus(current);
  pill.textContent=next.replace(/_/g,' ');
  pill.className="status-pill "+statusBadgeClass(next);
  try{
    await updateDoc(doc(db, collectionPath, id), { status: next, updatedAt: serverTimestamp() });
  }catch(e){ console.error(e); statusEl.textContent="Update failed."; }
}

async function deleteTask(id){
  if(!isAdmin()) return;
  if(!confirm("Delete this task?")) return;
  try{
    await deleteDoc(doc(db, collectionPath, id));
  }catch(e){ console.error(e); statusEl.textContent="Delete failed."; }
}

listEl.addEventListener("click", e=>{
  const t=e.target.closest("[data-action]");
  if(!t) return;
  const action=t.getAttribute("data-action");
  const id=t.getAttribute("data-id");
  if(!id) return;
  if(action==="cycle") cycleTaskStatus(id);
  else if(action==="delete") deleteTask(id);
});
taskForm?.addEventListener("submit", createTask);

onAuthChanged(user=>{
  hdrEmail.textContent = user ? (user.email || user.uid) : "Not signed in";
});
onRoleResolved(({ role })=>{
  hdrRole.textContent = role;
  if(isAdmin()){
    createSection.classList.remove("hidden");
    if(!unsubscribe) startListener();
  } else {
    createSection.classList.add("hidden");
  }
});
onAuthorized(['admin'], ()=>{
  statusEl.textContent="Loading tasks...";
  if(!unsubscribe) startListener();
});
signOutBtn?.addEventListener("click", async ()=>{
  await signOutUser();
  location.reload();
});
statusEl.textContent="Initializing…";
console.debug("[tasks-dashboard] collectionPath:", collectionPath);