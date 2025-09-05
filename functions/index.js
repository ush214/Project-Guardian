/**
 * Functions entrypoint (ESM).
 *
 * Exports:
 *  - callGeminiApi               (ad‑hoc model call for contributors/admins)
 *  - guardianSentry              (scheduled heartbeat / future telemetry hook)
 *  - migrateWerps                (legacy path migration if still needed)
 *  - bulk import pipeline:
 *      enqueueBulkImport
 *      processBulkImportFromStorage
 *      runBulkImportQueue
 *      runBulkImportQueueNow
 *  - normalizeWerps              (schema + score normalization, v2 aware)
 *  - repairWerps                 (model re-generation for incomplete/misaligned sections)
 *  - migrateToPHSv2              (batch upgrade legacy PHS/ESI to new schema)
 *  - backfillRationales          (LLM pass to enrich missing "Not specified." rationales)
 *  - schemaDiffReport            (dry-run diff of prospective normalization changes)
 *
 *  Support libraries in separate modules:
 *    schemaMapping.js  (canonical schema constants & mapping helpers)
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "./admin.js";

// ---------------------------------------------------------------------------
// Secrets / Config
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Role utility
// ---------------------------------------------------------------------------
async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch {
    return "user";
  }
}

// ---------------------------------------------------------------------------
// callGeminiApi (general purpose prompt -> JSON passthrough)
// ---------------------------------------------------------------------------
function createGeminiClient() {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("GEMINI_API_KEY secret missing at runtime.");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

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

// ---------------------------------------------------------------------------
// Exported domain-specific functions (imported from their modules)
// ---------------------------------------------------------------------------

// Bulk import (queue + triggers)
export {
  enqueueBulkImport,
  processBulkImportFromStorage,
  runBulkImportQueue,
  runBulkImportQueueNow
} from "./bulkImport.js";

// Guardian sentry (scheduler / placeholder)
export { guardianSentry } from "./guardianSentry.js";

// Legacy migration (if still present for earlier artifact path)
export { migrateWerps } from "./migrateAssessments.js";

// Normalization & repair (v2-aware)
export { normalizeWerps } from "./normalizeWerps.js";
export { repairWerps } from "./repairWerps.js";

// New schema-oriented migrations & utilities
export { migrateToPHSv2 } from "./migrateToPHSv2.js";
export { backfillRationales } from "./backfillRationales.js";
export { schemaDiffReport } from "./schemaDiffReport.js";