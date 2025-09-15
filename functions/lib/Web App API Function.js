/**
 * Defines the `callGeminiApi` onCall function used by the web application
 * for single-wreck analysis. Includes role-based access control.
 */
import { defineSecret } from "firebase-functions/params";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "./admin.js";
import { logger } from "firebase-functions/v2";
const REGION = "us-central1";
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";
async function getRole(uid) {
    try {
        const snap = await db.doc(`system/allowlist/users/${uid}`).get();
        if (!snap.exists)
            return "user";
        return snap.get("Role") || "user";
    }
    catch (e) {
        logger.error("Failed to read Role for uid:", uid, e);
        return "user";
    }
}
function createGeminiClient() {
    const key = GEMINI_API_KEY.value();
    if (!key)
        throw new Error("GEMINI_API_KEY secret is not available at runtime.");
    const genAI = new GoogleGenerativeAI(key);
    return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}
async function generateGeminiJSON(prompt) {
    const model = createGeminiClient();
    const res = await model.generateContent(prompt);
    const text = res.response.text();
    const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
    return JSON.parse(cleaned);
}
//# sourceMappingURL=Web%20App%20API%20Function.js.map