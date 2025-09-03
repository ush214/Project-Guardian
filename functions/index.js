// Functions entry file (ESM). Exports:
// - callGeminiApi: contributor/admin-only callable used by the app for single analyses
// - enqueueBulkImport, processBulkImportQueue: admin-only bulk import (re-exported from bulkImport.js)
//
// Requirements:
// - Node.js 20 runtime
// - "type": "module" in functions/package.json
// - Secret "GEMINI_API_KEY" stored in Firebase Secrets
//
// Firestore role path:
//   system/allowlist/users/{uid} with field "Role" in ["user","contributor","admin"]

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Initialize Admin SDK
initializeApp();
const db = getFirestore();

// Constants and Secrets
const REGION = "us-central1";
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

// Helpers
async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch (e) {
    console.error("Failed to read Role for uid:", uid, e);
    return "user";
  }
}

function createGeminiClient() {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("GEMINI_API_KEY secret is not available at runtime.");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

async function generateGeminiJSON(prompt) {
  const model = createGeminiClient();
  const res = await model.generateContent(prompt);
  const textFn = res?.response && typeof res.response.text === "function" ? res.response.text : null;
  const raw = (textFn ? textFn.call(res.response) : "").trim();

  // Strip code fences (``` or ```json) if present
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  // Return the cleaned string (frontend parses JSON on the client)
  // If you prefer to validate here, you can JSON.parse(cleaned) and return the object instead.
  return cleaned;
}

// Contributor/Admin-only callable to generate analysis fragments via Gemini
export const callGeminiApi = onCall({ region: REGION, secrets: [GEMINI_API_KEY] }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");

  // Allow contributors and admins
  const role = await getRole(uid);
  if (!["contributor", "admin"].includes(role)) {
    throw new HttpsError("permission-denied", "Contributor access required.");
  }

  const prompt = String(req.data?.prompt || "").trim();
  if (!prompt) {
    throw new HttpsError("invalid-argument", "Missing 'prompt' string.");
  }

  try {
    const result = await generateGeminiJSON(prompt);
    // Returning a string is fine; the client handles parsing and code fence stripping.
    return result;
  } catch (err) {
    console.error("callGeminiApi failed:", err);
    throw new HttpsError("internal", err?.message || "Model invocation failed.");
  }
});

// Re-export bulk import functions (admin-only)
export { enqueueBulkImport, processBulkImportQueue } from "./bulkImport.js";