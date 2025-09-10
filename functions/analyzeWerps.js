/**
 * analyzeWerps.js
 *
 * New callable function for INITIAL WERP assessments using the initial prompt.
 * This function generates initial assessments and writes them to Firestore.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { defineSecret } from "firebase-functions/params";
import { getInitialPrompt } from "./prompts/loader.js";

const logger = functions.logger;
const REGION = "us-central1";
const APP_ID = "guardian";
const COLLECTION = `artifacts/${APP_ID}/public/data/werpassessments`;

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

function extractJsonCandidate(text) {
  let s = String(text || "");
  let m = s.match(/```json([\s\S]*?)```/i);
  if (m) return m[1].trim();
  m = s.match(/```([\s\S]*?)```/i);
  if (m) return m[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return s.slice(first, last + 1).trim();
  return s.trim();
}

function createModel() {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

function createUrlSafeId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "unknown-vessel";
}

export const analyzeWerps = onCall(
  {
    region: REGION,
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [GEMINI_API_KEY],
    invoker: "public",
    cors: [
      "https://project-guardian-agent.web.app",
      "https://project-guardian-agent.firebaseapp.com",
      "http://localhost:3000",
      "http://localhost:5000",
      "http://localhost:5173",
      "http://127.0.0.1:5000"
    ]
  },
  async (req) => {
    const wreckName = typeof req.data?.wreckName === "string" ? req.data.wreckName.trim() : "";
    const dryRun = !!req.data?.dryRun;

    if (!wreckName) {
      throw new HttpsError("invalid-argument", "wreckName is required.");
    }

    try {
      // Get the initial prompt and append wreck name
      const basePrompt = getInitialPrompt();
      const fullPrompt = `${basePrompt}\n\nVessel name to assess: ${wreckName}`;

      // Call Gemini model
      const model = createModel();
      const res = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      });

      const raw = res?.response?.text() || "";
      const parsed = JSON.parse(extractJsonCandidate(raw));

      // Ensure id and name fields
      if (!parsed.id) {
        parsed.id = createUrlSafeId(parsed.name || wreckName);
      }
      if (!parsed.name) {
        parsed.name = wreckName;
      }

      if (dryRun) {
        return { ok: true, dryRun: true, assessment: parsed };
      }

      // Write to Firestore
      const docId = parsed.id;
      const docRef = db.doc(`${COLLECTION}/${docId}`);
      
      const assessmentData = {
        ...parsed,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        source: "initial_assessment",
        version: "1.0"
      };

      await docRef.set(assessmentData, { merge: true });

      return { 
        ok: true, 
        dryRun: false, 
        docId, 
        assessment: parsed,
        message: `Initial assessment created for ${wreckName}`
      };

    } catch (e) {
      logger.error("analyzeWerps failed:", e);
      throw new HttpsError("internal", e?.message || "Initial assessment failed.");
    }
  }
);