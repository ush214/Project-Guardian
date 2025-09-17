/**
 * auth-role.js
 *
 * Single source of truth for:
 *  - Firebase initialization
 *  - (Optional) App Check
 *  - Auth state
 *  - Role resolution (allowlist + custom claims)
 *  - Simple subscription hooks
 *
 * Roles returned: 'admin' | 'contributor' | 'user' | 'guest'
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

// --------------------------------------------------
// Firebase App + (Optional) App Check
// --------------------------------------------------
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");

// OPTIONAL: enable App Check if Firestore/AppCheck is enforced.
// Uncomment and insert your reCAPTCHA v3 site key (or use debug token).
/*
import {
  initializeAppCheck, ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js";
self.FIREBASE_APPCHECK_DEBUG_TOKEN = 'PG_DEBUG_TOKEN_12345';
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider('RECAPTCHA_V3_SITE_KEY'),
  isTokenAutoRefreshEnabled: true
});
*/

// --------------------------------------------------
// Internal state
// --------------------------------------------------
let currentUser = null;
let currentRole = "guest";
let rolePromise = null;
let roleResolved = false;

const authListeners = [];
const roleListeners = [];
const authorizedListeners = []; // { roles:[], cb }

function emitAuth() {
  authListeners.forEach(cb => {
    try { cb(currentUser); } catch (e) { console.error("[auth-role] auth listener error", e); }
  });
}
function emitRole() {
  roleListeners.forEach(cb => {
    try { cb({ user: currentUser, role: currentRole }); } catch (e) { console.error("[auth-role] role listener error", e); }
  });
  authorizedListeners.forEach(entry => {
    if (entry.roles.includes(currentRole)) {
      try { entry.cb({ user: currentUser, role: currentRole }); } catch (e) { console.error("[auth-role] authorized listener error", e); }
    }
  });
}

// --------------------------------------------------
// Public subscription API
// --------------------------------------------------
export function onAuthChanged(cb) {
  authListeners.push(cb);
  if (currentUser !== null) cb(currentUser);
}

export function onRoleResolved(cb) {
  roleListeners.push(cb);
  if (roleResolved) cb({ user: currentUser, role: currentRole });
}

/**
 * Fire callback once role matches any in roles array.
 * roles: string[] e.g. ['admin'] or ['contributor','admin']
 */
export function onAuthorized(roles, cb) {
  authorizedListeners.push({ roles, cb });
  if (roleResolved && roles.includes(currentRole)) {
    cb({ user: currentUser, role: currentRole });
  }
}

// Convenience getters
export function getCurrentUser() { return currentUser; }
export function getCurrentRole() { return currentRole; }
export function isAdmin() { return currentRole === "admin"; }
export function isContributor() { return ["admin", "contributor"].includes(currentRole); }

// --------------------------------------------------
// Role Resolution
// --------------------------------------------------
async function fetchAllowlistRole(uid) {
  try {
    const ref = doc(db, "system", "allowlist", "users", uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const d = snap.data() || {};

    // Boolean overrides
    if (d.admin === true) return "admin";
    if (d.contributor === true) return "contributor";

    let r = d.role ?? d.Role ?? d.ROLE;
    if (typeof r === "string") {
      r = r.trim().toLowerCase();
      if (r.startsWith("admin")) return "admin";
      if (r.startsWith("contrib")) return "contributor";
      if (["user", "reader", "viewer"].includes(r)) return "user";
    }
    if (d.allowed === true) return "user";
  } catch (e) {
    console.warn("[auth-role] allowlist fetch error", e);
  }
  return null;
}

async function resolveRole(user) {
  if (!user) {
    currentRole = "guest";
    roleResolved = true;
    emitRole();
    return currentRole;
  }
  if (rolePromise) return rolePromise;

  rolePromise = (async () => {
    // 1. Custom claims
    try {
      const tokenResult = await user.getIdTokenResult(true);
      if (tokenResult.claims.admin === true) return "admin";
      if (typeof tokenResult.claims.role === "string") {
        const lc = tokenResult.claims.role.toLowerCase();
        if (lc === "admin") return "admin";
        if (lc === "contributor") return "contributor";
      }
    } catch (e) {
      console.warn("[auth-role] token claim read failed", e);
    }

    // 2. Allowlist
    const allowlistRole = await fetchAllowlistRole(user.uid);
    if (allowlistRole) return allowlistRole;

    // 3. Default
    return "user";
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

// --------------------------------------------------
// Auth State Listener
// --------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  roleResolved = false;
  emitAuth();
  await resolveRole(user);
});

// --------------------------------------------------
// Sign-in / Sign-out Helpers
// --------------------------------------------------
export async function signInWithGooglePopup() {
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}

export async function signInEmailPassword(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export async function createAccountEmailPassword(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export async function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

export async function signOutUser() { return signOut(auth); }

console.info("[auth-role] Initialized project:", firebaseConfig.projectId);