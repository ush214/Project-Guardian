/**
 * auth-role.js (root-level, separate firebase-config.js variant)
 * Centralizes Firebase initialization, auth state, role resolution, and observer helpers.
 * Assumes firebase-config.js is in the same directory.
 */
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore, getDoc, doc
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import {
  getFunctions
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

// Initialize core services
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");

// Internal state
let currentUser = null;
let currentRole = "guest";
let roleResolved = false;
let rolePromise = null;

// Listener arrays
const authListeners = [];
const roleListeners = [];
const authorizedListeners = [];

// Emit helpers
function emitAuth() {
  for (const cb of authListeners) { try { cb(currentUser); } catch(e){ console.error(e);} }
}
function emitRole() {
  for (const cb of roleListeners) { try { cb({ user: currentUser, role: currentRole }); } catch(e){ console.error(e);} }
  for (const o of authorizedListeners) {
    if (o.roles.includes(currentRole)) {
      try { o.cb({ user: currentUser, role: currentRole }); } catch(e){ console.error(e); }
    }
  }
}

// Public subscription API
export function onAuthChanged(cb){
  authListeners.push(cb);
  // Fire immediately if we already have state (not null).
  if (currentUser !== null) cb(currentUser);
}
export function onRoleResolved(cb){
  roleListeners.push(cb);
  if (roleResolved) cb({ user: currentUser, role: currentRole });
}
export function onAuthorized(roles, cb){
  authorizedListeners.push({ roles, cb });
  if (roleResolved && roles.includes(currentRole)) cb({ user: currentUser, role: currentRole });
}

// Convenience getters
export function getCurrentUser(){ return currentUser; }
export function getCurrentRole(){ return currentRole; }
export function isAdmin(){ return currentRole === 'admin'; }
export function isContributor(){ return currentRole === 'admin' || currentRole === 'contributor'; }
// NEW: allowlisted = admin OR contributor OR user (user is min allowlisted)
export function isAllowlisted(){ return ['admin','contributor','user'].includes(currentRole); }

// Auth helpers
export async function signInWithGooglePopup(){
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}
export async function signInEmailPassword(email, password){
  return signInWithEmailAndPassword(auth, email, password);
}
export async function createAccountEmailPassword(email, password){
  return createUserWithEmailAndPassword(auth, email, password);
}
export async function resetPassword(email){
  return sendPasswordResetEmail(auth, email);
}
export async function signOutUser(){
  return signOut(auth);
}

// Allowlist role resolution
async function fetchAllowlistRole(uid){
  try {
    const snap = await getDoc(doc(db,"system","allowlist","users",uid));
    if (!snap.exists()) return null;
    const d = snap.data() || {};
    if (d.admin === true) return "admin";
    if (d.contributor === true) return "contributor";
    let r = d.role ?? d.Role ?? d.ROLE;
    if (typeof r === 'string' && r.trim()){
      r = r.trim().toLowerCase();
      if (r.startsWith('admin')) return 'admin';
      if (r.startsWith('contrib')) return 'contributor';
      if (['user','reader','viewer'].includes(r)) return 'user';
    }
    if (d.allowed === true) return 'user';
  } catch(e){
    console.warn("[auth-role] allowlist read failed", e);
  }
  return null;
}

async function resolveRole(user){
  if (!user){
    currentRole = 'guest';
    roleResolved = true;
    emitRole();
    return currentRole;
  }
  if (rolePromise) return rolePromise;

  rolePromise = (async () => {
    // Custom claims first
    try {
      const tokenResult = await user.getIdTokenResult(true);
      if (tokenResult.claims.admin === true) return 'admin';
      if (typeof tokenResult.claims.role === 'string') {
        const rr = tokenResult.claims.role.toLowerCase();
        if (rr === 'admin') return 'admin';
        if (rr === 'contributor') return 'contributor';
        if (rr === 'user') return 'user';
      }
    } catch(e){}

    // Allowlist
    const al = await fetchAllowlistRole(user.uid);
    if (al) return al;

    // Default when NOT allowlisted: stay guest
    return 'guest';
  })();

  try {
    currentRole = await rolePromise;
  } finally {
    roleResolved = true;
    emitRole();
    rolePromise = null;
  }
  return currentRole;
}

// Auth state listener
onAuthStateChanged(auth, async (user)=>{
  currentUser = user;
  roleResolved = false;
  emitAuth();
  await resolveRole(user);
});

console.info("[auth-role] Initialized (separate firebase-config.js).");