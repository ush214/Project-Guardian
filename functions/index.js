/**
 * Functions entrypoint (ESM).
 *
 * Exports (callable / triggered):
 *  - callGeminiApi
 *  - guardianSentry
 *  - migrateWerps (legacy)
 *
 * Bulk import pipeline:
 *  - enqueueBulkImport
 *  - processBulkImportFromStorage
 *  - runBulkImportQueue
 *  - runBulkImportQueueNow
 *
 * Schema + data maintenance:
 *  - schemaDiffReport
 *  - normalizeWerps
 *  - migrateToPHSv2
 *  - migrateToPHSv3
 *  - migrateAgeScores
 *  - backfillRationales
 *  - repairWerps
 *  - reassessWerps
 *
 * Phase 2 (In Situ) and Event Impact:
 *  - addInSituUpdate
 *  - flagForReassessment
 *  - clearReassessmentFlag
 *  - recordEnvironmentalEvent
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "./admin.js";

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";
const REGION = "us-central1";

const ALLOWED_ORIGINS = [
  "https://project-guardian-agent.web.app",
  "https://project-guardian-agent.firebaseapp.com",
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://127.0.0.1:5000"
];

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch {
    return "user";
  }
}

function createGeminiClient() {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("GEMINI_API_KEY secret missing at runtime.");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

// Generic ad-hoc model call
export const callGeminiApi = onCall(
  {
    region: REGION,
    invoker: "public",
    secrets: [GEMINI_API_KEY],
    cors: ALLOWED_ORIGINS
  },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (!["contributor", "admin"].includes(role)) {
      throw new HttpsError("permission-denied", "Contributor access required.");
    }

    const prompt = String(req.data?.prompt || "").trim();
    if (!prompt) throw new HttpsError("invalid-argument", "Missing 'prompt' string.");

    try {
      const model = createGeminiClient();
      const res = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      });
      const text = res?.response?.text() || "";
      return text;
    } catch (err) {
      console.error("callGeminiApi failure:", err);
      throw new HttpsError("internal", err?.message || "Model invocation failed.");
    }
  }
);

// Bulk import (queue + triggers)
export {
  enqueueBulkImport,
  processBulkImportFromStorage,
  runBulkImportQueue,
  runBulkImportQueueNow
} from "./bulkImport.js";

// Scheduled / sentinel
export { guardianSentry } from "./guardianSentry.js";

// Legacy collection path migration
export { migrateWerps } from "./migrateAssessments.js";

// Normalization & structural diff
export { normalizeWerps } from "./normalizeWerps.js";
export { schemaDiffReport } from "./schemaDiffReport.js";

// Migrations & scoring updates
export { migrateToPHSv2 } from "./migrateToPHSv2.js";
export { migrateToPHSv3 } from "./migrateToPHSv3.js";
export { migrateAgeScores } from "./migrateAgeScores.js";

// Content enhancement & repair
export { backfillRationales } from "./backfillRationales.js";
export { repairWerps } from "./repairWerps.js";
export { reassessWerps } from "./reassessWerps.js";

// Phase 2 in-situ & event impact management
export {
  addInSituUpdate,
  flagForReassessment,
  clearReassessmentFlag,
  recordEnvironmentalEvent
} from "./inSitu.js";