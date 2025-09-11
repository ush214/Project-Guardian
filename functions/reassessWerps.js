/**
 * reassessWerps.js
 *
 * Fully re-generates all sections (WCS, PHS v3, ESI, RPM, finalSummary) for a single document,
 * optionally guided by operator-provided context ("analysis guidance").
 *
 * Accepts:
 *  - docId (required)
 *  - context (string, optional guidance)
 *  - dryRun (boolean, default false)
 *
 * Behavior:
 *  - Enforces PHS v3 weights (0.50 / 0.30 / 0.20).
 *  - Clamps scores & totals (WCS 0–20, ESI 0–30, PHS weighted 0–10, RPM 0.5–2.5).
 *  - If metadata.buildYear <= 1950, set WCS Age score to 5; otherwise band by age.
 *  - Preserves phase2, impactEvents, and flags; updates updatedAt.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { defineSecret } from "firebase-functions/params";
import { getFollowupPrompt } from "./prompts/loader.js";

const logger = functions.logger;
const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const COLLECTION = `artifacts/${APP_ID}/public/data/werpassessments`;

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

const PHS_WEIGHTS = {
  "Fuel Volume & Type": 0.50,
  "Ordnance": 0.30,
  "Hazardous Materials": 0.20
};

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch {
    return "user";
  }
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) n = lo;
  return Math.min(hi, Math.max(lo, n));
}

function computeAgeScore(buildYear) {
  const year = new Date().getUTCFullYear();
  if (!Number.isFinite(buildYear) || buildYear <= 0) return null;
  if (buildYear <= 1950) return 5;
  const age = year - buildYear;
  if (age >= 120) return 5;
  if (age >= 90) return 4;
  if (age >= 60) return 3;
  if (age >= 30) return 2;
  return 1;
}

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

function buildPrompt(vesselName, context, buildYear) {
  // Get the base prompt from the loader
  const basePrompt = getFollowupPrompt({ wreckName: vesselName });
  
  // Add context and build year guidance if provided
  const guidance = (context || "").trim();
  const guidanceBlock = guidance
    ? `\n\nOperator guidance (apply to scoring and rationales where relevant):\n${guidance}`
    : "";
  
  const buildYearHint = Number.isFinite(buildYear) && buildYear > 0
    ? `\n\nKnown build year: ${buildYear}. If ≤ 1950, Age score should reflect extreme chronological age.`
    : `\n\nIf vessel is WWII-era or older, Age reflects extreme chronological age.`;

  return `${basePrompt}${guidanceBlock}${buildYearHint}`;
}

export const reassessWerps = onCall({
  region: REGION,
  secrets: [GEMINI_API_KEY],
  invoker: "public",
  cors: {
    origin: [
      "https://project-guardian-agent.web.app",
      "https://project-guardian-agent.firebaseapp.com",
      "http://localhost:3000",
      "http://localhost:5000", 
      "http://localhost:5173",
      "http://127.0.0.1:5000"
    ],
    methods: ["POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  timeoutSeconds: 540,
  memory: "1GiB"
}, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin role required.");

    const docId = typeof req.data?.docId === "string" ? req.data.docId.trim() : "";
    const context = typeof req.data?.context === "string" ? req.data.context.trim() : "";
    const dryRun = !!req.data?.dryRun;

    if (!docId) throw new HttpsError("invalid-argument", "docId is required.");

    const ref = db.doc(`${COLLECTION}/${docId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Assessment not found.");

    const data = snap.data() || {};
    const vesselName = data.vesselName || data.name || docId;
    const buildYear = Number.parseInt(data?.metadata?.buildYear, 10);
    
    // If req.data.docId provided and minimal context needed, fetch doc and include context
    let additionalContext = context;
    if (req.data?.docId && data?.phase2) {
      const existingPhase2 = data.phase2;
      const minimalContext = `Existing phase2 data: ${JSON.stringify(existingPhase2)}`;
      additionalContext = additionalContext ? `${additionalContext}\n\n${minimalContext}` : minimalContext;
    }

    // Run model
    let parsed;
    try {
      const prompt = buildPrompt(vesselName, additionalContext, buildYear);
      const model = createModel();
      const res = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      });
      const raw = res?.response?.text() || "";
      parsed = JSON.parse(extractJsonCandidate(raw));
    } catch (e) {
      logger.error("Model reassess failed:", e);
      throw new HttpsError("internal", e?.message || "Model reassessment failed.");
    }

    // WCS
    const wcsParams = (parsed.wcs_hull_structure?.parameters || []).map(p => ({
      name: p.parameter,
      rationale: p.rationale,
      score: clamp(p.score, 0, 5)
    }));
    // Age rescore if buildYear present
    if (Number.isFinite(buildYear)) {
      const age = wcsParams.find(p => p.name === "Age");
      const newAge = computeAgeScore(buildYear);
      if (age && newAge != null) {
        age.score = newAge;
        age.rationale = (age.rationale || "").trim() + ` (Rescored from build year ${buildYear}.)`;
      }
    }
    const wcsTotal = wcsParams.reduce((s, p) => s + p.score, 0);

    // PHS v3
    const phsIn = parsed.phs_pollution_hazard || {};
    const phsParams = (phsIn.parameters || [])
      .map(p => ({
        name: p.parameter,
        rationale: p.rationale,
        score: clamp(p.score, 0, 10),
        weight: PHS_WEIGHTS[p.parameter] ?? 0
      }))
      .filter(p => Object.prototype.hasOwnProperty.call(PHS_WEIGHTS, p.name));
    phsParams.forEach(p => { p.weight = PHS_WEIGHTS[p.name]; });
    const phsWeighted = phsParams.reduce((s, p) => s + p.score * p.weight, 0);

    // ESI
    const esiParams = (parsed.esi_environmental_sensitivity?.parameters || []).map(p => ({
      name: p.parameter,
      rationale: p.rationale,
      score: clamp(p.score, 0, 10)
    }));
    const esiTotal = esiParams.reduce((s, p) => s + p.score, 0);

    // RPM
    const rpmFactors = (parsed.rpm_risk_pressure_modifiers?.factors || []).map(f => ({
      name: f.factor,
      rationale: f.rationale,
      value: clamp(f.value, 0.5, 2.5)
    }));
    const rpmAvg = rpmFactors.length
      ? rpmFactors.reduce((s, f) => s + f.value, 0) / rpmFactors.length
      : 1.0;

    const finalSummary = {
      summativeAssessment: parsed.final_summary?.summativeAssessment || "",
      remediationSuggestions: parsed.final_summary?.remediationSuggestions || []
    };

    const patch = {
      vesselName,
      wcs: { parameters: wcsParams, totalScore: wcsTotal },
      phs: { version: 3, parameters: phsParams, totalWeightedScore: clamp(phsWeighted, 0, 10) },
      esi: { parameters: esiParams, totalScore: clamp(esiTotal, 0, 30), maxScore: 30 },
      rpm: { factors: rpmFactors, finalMultiplier: Number(rpmAvg.toFixed(2)) },
      finalSummary
    };

    if (dryRun) {
      return { ok: true, dryRun: true, patchPreview: patch };
    }

    // Merge while preserving phase2, impactEvents, flags
    await ref.set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true, dryRun: false, wrote: 1 };
  }
);