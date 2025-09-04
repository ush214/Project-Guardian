// Functions entry (ESM).
// - callGeminiApi
// - enqueueBulkImport, processBulkImportFromStorage, runBulkImportQueue
// - guardianSentry

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "./admin.js";

export {
  enqueueBulkImport,
  processBulkImportFromStorage,
  runBulkImportQueue
} from "./bulkImport.js";
export { guardianSentry } from "./guardianSentry.js";

const REGION = "us-central1";
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

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
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return cleaned;
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
      const result = await generateGeminiJSON(prompt);
      return result;
    } catch (err) {
      console.error("callGeminiApi failed:", err);
      throw new HttpsError("internal", err?.message || "Model invocation failed.");
    }
  }
);