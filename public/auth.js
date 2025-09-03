/**
 * Authentication module for Project Guardian
 * Handles Firebase authentication with multiple providers
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup,
  onAuthStateChanged,
  OAuthProvider
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";

// Firebase configuration (same as index.html)
const firebaseConfig = {
  apiKey: "AIzaSyCiqs5iMg-Nj3r6yRszUxFKOIxmMfs5m6Q",
  authDomain: "project-guardian-agent.firebaseapp.com",
  projectId: "project-guardian-agent",
  storageBucket: "project-guardian-agent.firebasestorage.app",
  messagingSenderId: "84395007243",
  appId: "1:84395007243:web:b07e5f4c4264d27611160e",
  measurementId: "G-NRLH3WSCQ9"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Auth providers
const googleProvider = new GoogleAuthProvider();
const microsoftProvider = new OAuthProvider('microsoft.com');
const githubProvider = new OAuthProvider('github.com');

/**
 * Ensures user is authenticated before proceeding with an action
 * @param {string} actionLabel - Description of the action requiring auth (e.g., "Analyze Wreck")
 * @returns {Promise<User>} - Resolves with user object when authenticated
 */
export function ensureAuth(actionLabel = "perform this action") {
  return new Promise((resolve, reject) => {
    const currentUser = auth.currentUser;
    
    if (currentUser) {
      // User is already signed in
      resolve(currentUser);
      return;
    }
    
    // User is not signed in, redirect to login with next URL
    const currentURL = window.location.href;
    const loginURL = `/login.html?next=${encodeURIComponent(currentURL)}&action=${encodeURIComponent(actionLabel)}`;
    window.location.href = loginURL;
  });
}

/**
 * Sign in with Google
 */
export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error("Google sign-in failed:", error);
    throw error;
  }
}

/**
 * Sign in with Microsoft
 */
export async function signInWithMicrosoft() {
  try {
    const result = await signInWithPopup(auth, microsoftProvider);
    return result.user;
  } catch (error) {
    console.error("Microsoft sign-in failed:", error);
    throw error;
  }
}

/**
 * Sign in with GitHub
 */
export async function signInWithGitHub() {
  try {
    const result = await signInWithPopup(auth, githubProvider);
    return result.user;
  } catch (error) {
    console.error("GitHub sign-in failed:", error);
    throw error;
  }
}

/**
 * Get current user
 */
export function getCurrentUser() {
  return auth.currentUser;
}

/**
 * Listen for auth state changes
 */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * Get Firebase auth instance
 */
export function getAuthInstance() {
  return auth;
}