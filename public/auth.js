/**
 * Firebase Authentication Module for Project Guardian
 * Provides invite-only authentication with email/password
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";

// Firebase Configuration
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

// Export Firebase instances for use by other modules
export { app, auth };

/**
 * Signs in a user with email and password
 * @param {string} email - User's email address
 * @param {string} password - User's password
 * @returns {Promise} - Firebase auth result
 */
export async function signInWithEmail(email, password) {
  return await signInWithEmailAndPassword(auth, email, password);
}

/**
 * Signs out the current user
 * @returns {Promise} - Firebase sign out result
 */
export async function signOutUser() {
  return await signOut(auth);
}

/**
 * Gets the current authenticated user
 * @returns {Object|null} - Current user object or null if not authenticated
 */
export function getCurrentUser() {
  return auth.currentUser;
}

/**
 * Ensures user is authenticated for protected actions
 * Redirects to login page if not authenticated
 * @param {string} actionLabel - Description of the action requiring authentication
 * @returns {Promise<Object>} - Current user object if authenticated
 */
export async function ensureAuth(actionLabel) {
  return new Promise((resolve, reject) => {
    const user = getCurrentUser();
    
    if (user) {
      resolve(user);
      return;
    }

    // If not authenticated, redirect to login with return URL
    const currentUrl = window.location.pathname + window.location.search;
    const loginUrl = `/login.html?next=${encodeURIComponent(currentUrl)}`;
    
    // Show a brief message before redirecting
    if (actionLabel) {
      alert(`Please sign in to ${actionLabel}.`);
    }
    
    window.location.href = loginUrl;
    reject(new Error('User not authenticated'));
  });
}

/**
 * Sets up authentication state listener
 * @param {Function} callback - Function to call when auth state changes
 * @returns {Function} - Unsubscribe function
 */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * Initialize sign out button if it exists on the page
 * Call this function after DOM is loaded
 */
export function initializeSignOutButton() {
  const signOutBtn = document.getElementById('signOutBtn');
  
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      try {
        await signOutUser();
        // Redirect to home page after sign out
        window.location.href = '/';
      } catch (error) {
        console.error('Sign out error:', error);
        alert('Failed to sign out. Please try again.');
      }
    });
  }
}

/**
 * Check if user is currently authenticated
 * @returns {boolean} - True if user is authenticated
 */
export function isAuthenticated() {
  return !!getCurrentUser();
}

// Auto-initialize sign out button when module loads or DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initializeSignOutButton();
  });
} else {
  // DOM already loaded
  initializeSignOutButton();
}