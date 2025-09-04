// Modular CDN version (ESM). Works when your app already initializes Firebase.
// Requires your page to initialize Firebase App before this script runs.
// Example init (elsewhere):
// import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
// initializeApp({ /* your config */ });

import { getApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getFunctions,
  httpsCallable,
  httpsCallableFromURL
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

// Use your deployed region
const REGION = "us-central1";
const PROJECT_ID = "project-guardian-agent";

// Grab existing app (must be initialized already)
const app = getApp();
const functions = getFunctions(app, REGION);

// Preferred: call onCall functions by name (no hardcoded URL)
const enqueueBulkImportByName = httpsCallable(functions, "enqueueBulkImport");
const callGeminiApiByName = httpsCallable(functions, "callGeminiApi");

// Alternative: URL-based callable (must include /callable/ in the path)
const ORIGIN = `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;
const enqueueBulkImportByUrl = httpsCallableFromURL(functions, `${ORIGIN}/callable/enqueueBulkImport`);
const callGeminiApiByUrl = httpsCallableFromURL(functions, `${ORIGIN}/callable/callGeminiApi`);

// Convenience wrappers that you can call from your UI code.
// They return only the .data payload from the callable.
export async function runEnqueueBulkImport(namesCsv) {
  // Use URL-based callable to guarantee /callable path is used
  console.log('Using URL-based callable for enqueueBulkImport:', `${ORIGIN}/callable/enqueueBulkImport`);
  const res = await enqueueBulkImportByUrl({ names: String(namesCsv || "") });
  return res.data;
}

export async function runGemini(prompt) {
  // Use URL-based callable to guarantee /callable path is used
  console.log('Using URL-based callable for callGeminiApi:', `${ORIGIN}/callable/callGeminiApi`);
  const res = await callGeminiApiByUrl({ prompt: String(prompt || "") });
  return res.data;
}

// Optional: expose helpers on window for quick testing from DevTools
// window.runEnqueueBulkImport = runEnqueueBulkImport;
// window.runGemini = runGemini;