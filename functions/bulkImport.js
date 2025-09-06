/**
 * bulkImport.js
 *
 * Responsibilities:
 *  - Storage finalize trigger: watches bulk-import/*.csv and enqueues vessel names.
 *  - Queue processor: generates unified WERP assessment docs.
 *  - Callable enqueue & immediate queue-run utilities.
 *
 * Schema (PHS v3):
 *  phs.version = 3
 *  PHS parameters (exactly 3):
 *    - Fuel Volume & Type (weight 0.50)
 *    - Ordnance (weight 0.30)
 *    - Hazardous Materials (weight 0.20)
 *
 * Age Scoring:
 *  - If metadata.buildYear present:
 *      If buildYear <= 1950 => set Age score = 5 (WW2 era or earlier).
 *      Else band by (currentYear - buildYear):
 *        >=120: 5
 *        >=90: 4
 *        >=60: 3
 *        >=30: 2
 *        <30: 1
 *  - If buildYear missing, retain model-provided score.
 *
 * RPM factors canonical (3):
 *  - Thermal Stress (Ocean Warming)
 *  - Seismic Activity
 *  - Anthropogenic Disturbance
 */

import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as functions from "firebase-functions";
import { getStorage } from "firebase-admin/storage";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

const logger = functions.logger;

const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const TARGET_COLLECTION = `artifacts/${APP_ID}/public/data/werpassessments`;
const QUEUE_PATH = "system/bulkImport/queue";
const EXPECTED_BUCKET = "project-guardian-agent.firebasestorage.app";

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

const QUEUE_PROCESS_BATCH_LIMIT = 5;
const FIRESTORE_BATCH_LIMIT = 450;

// Role helper
async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch (e) {
    logger.error("Role lookup failed:", e);
    return "user";
  }
}

// ---- Model helpers ----
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

async function callGemini(prompt) {
  const model = createModel();
  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" }
  });
  const raw = res?.response?.text() || "";
  const cand = extractJsonCandidate(raw);
  return JSON.parse(cand);
}

function clamp(v, lo, hi) {
  if (typeof v !== "number") v = parseFloat(String(v));
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

// ---- Prompt ----
function buildUnifiedAssessmentPrompt(vesselName) {
  return `You are an expert OSINT marine environmental risk assessor.
Return ONLY JSON (no markdown fences):

{
  "wcs_hull_structure": {
    "parameters": [
      {"parameter":"Age","rationale":"...","score":0},
      {"parameter":"Construction Quality","rationale":"...","score":0},
      {"parameter":"Wreck Integrity","rationale":"...","score":0},
      {"parameter":"Corrosion Environment","rationale":"...","score":0}
    ],
    "maxScore": 20
  },
  "phs_pollution_hazard": {
    "version": 3,
    "parameters": [
      {"parameter":"Fuel Volume & Type","weight":0.50,"rationale":"...","score":0},
      {"parameter":"Ordnance","weight":0.30,"rationale":"...","score":0},
      {"parameter":"Hazardous Materials","weight":0.20,"rationale":"...","score":0}
    ]
  },
  "esi_environmental_sensitivity": {
    "parameters": [
      {"parameter":"Proximity to Sensitive Ecosystems","rationale":"...","score":0},
      {"parameter":"Biodiversity Value","rationale":"...","score":0},
      {"parameter":"Socioeconomic Sensitivity","rationale":"...","score":0}
    ],
    "maxScore": 30
  },
  "rpm_risk_pressure_modifiers": {
    "factors": [
      {"factor":"Thermal Stress (Ocean Warming)","rationale":"...","value":1.0},
      {"factor":"Seismic Activity","rationale":"...","value":1.0},
      {"factor":"Anthropogenic Disturbance","rationale":"...","value":1.0}
    ]
  },
  "final_summary": {
    "summativeAssessment":"...",
    "remediationSuggestions":[
      {"priority":1,"title":"...","description":"..."},
      {"priority":2,"title":"...","description":"..."},
      {"priority":3,"title":"...","description":"..."}
    ]
  }
}

Rules:
- DO NOT include structural integrity inside pollution hazard (that's WCS).
- Age = years since original build/launch date (not years in service). If era clearly pre-1950, acknowledge advanced age degradation risk.
- WCS scores 0–5 each (sum 0–20).
- PHS scores 0–10 each with weights given (sum weighted 0–10).
- ESI scores 0–10 each (sum 0–30).
- RPM values 0.5–2.5 (1 baseline). Avoid placeholders like "Insufficient data" unless justified; then explain why data is sparse.
- Rationales must be specific and evidence based (e.g., known fuel capacities, documented munitions, environmental context).
Vessel: ${vesselName}`;
}

// ---- Age Scoring Helper ----
function rescoreAgeParam(ageParam, buildYear) {
  if (!buildYear || !ageParam) return;
  const year = new Date().getUTCFullYear();
  // Force WWII or earlier ≤1950 => 5
  if (buildYear <= 1950) {
    ageParam.score = 5;
    ageParam.rationale += " (WWII-era or earlier hull; extreme chronological age => elevated structural degradation risk.)";
    return;
  }
  const age = year - buildYear;
  let score;
  if (age >= 120) score = 5;
  else if (age >= 90) score = 4;
  else if (age >= 60) score = 3;
  else if (age >= 30) score = 2;
  else score = 1;
  ageParam.score = clamp(score, 0, 5);
  ageParam.rationale += ` (Adjusted for build year ${buildYear}, age ≈ ${age} years.)`;
}

// ---- Main Analysis ----
export async function performNewAnalysis(vesselName, metadata = {}) {
  const obj = await callGemini(buildUnifiedAssessmentPrompt(vesselName));

  // WCS
  const wcsParams = (obj.wcs_hull_structure?.parameters || []).map(p => ({
    name: p.parameter,
    rationale: p.rationale,
    score: clamp(p.score, 0, 5)
  }));

  // Age rescore if buildYear provided
  if (metadata.buildYear) {
    const ageParam = wcsParams.find(p => p.name === "Age");
    rescoreAgeParam(ageParam, parseInt(metadata.buildYear, 10));
  }
  const wcsTotal = wcsParams.reduce((s, p) => s + p.score, 0);

  // PHS v3
  const phsRaw = obj.phs_pollution_hazard || {};
  const phsVersion = phsRaw.version || 3;
  const phsParams = (phsRaw.parameters || [])
    .map(p => ({
      name: p.parameter,
      rationale: p.rationale,
      weight: p.weight,
      score: clamp(p.score, 0, 10)
    }))
    .filter(p => ["Fuel Volume & Type", "Ordnance", "Hazardous Materials"].includes(p.name));
  // Ensure weights (in case model drift)
  const enforcedWeights = {
    "Fuel Volume & Type": 0.50,
    "Ordnance": 0.30,
    "Hazardous Materials": 0.20
  };
  phsParams.forEach(p => { p.weight = enforcedWeights[p.name]; });
  const phsWeighted = phsParams.reduce((s, p) => s + p.score * p.weight, 0);

  // ESI
  const esiParams = (obj.esi_environmental_sensitivity?.parameters || []).map(p => ({
    name: p.parameter,
    rationale: p.rationale,
    score: clamp(p.score, 0, 10)
  }));
  const esiTotal = esiParams.reduce((s, p) => s + p.score, 0);

  // RPM
  const rpmFactors = (obj.rpm_risk_pressure_modifiers?.factors || []).map(f => ({
    name: f.factor,
    rationale: f.rationale,
    value: clamp(f.value, 0.5, 2.5)
  }));
  const rpmAvg = rpmFactors.length
    ? rpmFactors.reduce((s, f) => s + f.value, 0) / rpmFactors.length
    : 1.0;

  return {
    vesselName,
    wcs: { parameters: wcsParams, totalScore: wcsTotal },
    phs: { version: phsVersion, parameters: phsParams, totalWeightedScore: clamp(phsWeighted, 0, 10) },
    esi: { parameters: esiParams, totalScore: clamp(esiTotal, 0, 30), maxScore: 30 },
    rpm: { factors: rpmFactors, finalMultiplier: parseFloat(rpmAvg.toFixed(2)) },
    finalSummary: {
      summativeAssessment: obj.final_summary?.summativeAssessment || "",
      remediationSuggestions: obj.final_summary?.remediationSuggestions || []
    },
    metadata: { ...metadata },
    status: "initial"
  };
}

// ---- CSV / Queue helpers ----
function normalizeId(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function splitLinesToVessels(contents) {
  return String(contents || "")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

async function enqueueVessels(vesselNames) {
  if (!Array.isArray(vesselNames) || vesselNames.length === 0) return { enqueued: 0 };
  let batch = db.batch();
  let count = 0;
  let enqueued = 0;
  for (const name of vesselNames) {
    const id = normalizeId(name);
    if (!id) continue;
    const ref = db.doc(`${QUEUE_PATH}/${id}`);
    batch.set(
      ref,
      {
        docId: id,
        vesselName: name,
        status: "pending",
        attempts: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    count++;
    enqueued++;
    if (count >= FIRESTORE_BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
  return { enqueued };
}

async function enqueueFromGcsFile(bucket, objectName, moveToProcessed = true) {
  const file = getStorage().bucket(bucket).file(objectName);
  const [buf] = await file.download();
  const vessels = splitLinesToVessels(buf.toString("utf8"));
  const { enqueued } = await enqueueVessels(vessels);

  let processedPath = null;
  if (
    moveToProcessed &&
    !/^bulk-import\/processed\//.test(objectName) &&
    /^bulk-import\//.test(objectName)
  ) {
    const dest = objectName.replace(/^bulk-import\//, "bulk-import/processed/");
    await file.move(dest);
    processedPath = `gs://${bucket}/${dest}`;
  }
  return { enqueued, processedPath };
}

// ---- Queue processor ----
async function processQueueBatch(limit = QUEUE_PROCESS_BATCH_LIMIT) {
  logger.info("Starting queue batch...");
  const out = [];

  const pendingSnap = await db
    .collection(QUEUE_PATH)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get();
  out.push(...pendingSnap.docs);

  if (out.length < limit) {
    const retrySnap = await db
      .collection(QUEUE_PATH)
      .where("status", "==", "retry")
      .orderBy("createdAt", "asc")
      .limit(limit - out.length)
      .get();
    out.push(...retrySnap.docs);
  }

  if (out.length === 0) {
    logger.info("Queue empty.");
    return { processed: 0 };
  }

  let processed = 0;
  for (const docSnap of out) {
    const qRef = docSnap.ref;
    const data = docSnap.data() || {};
    const vesselName = data.vesselName;
    const docId = data.docId;
    const attempts = data.attempts || 0;

    if (!vesselName || !docId) {
      logger.warn(`Skipping invalid queue doc ${qRef.path}`);
      await qRef.update({
        status: "failed",
        error: "Missing vesselName/docId",
        updatedAt: FieldValue.serverTimestamp()
      });
      continue;
    }

    await qRef.update({
      status: "processing",
      updatedAt: FieldValue.serverTimestamp()
    });

    try {
      // (Optional future: pass buildYear if collected externally)
      const analysis = await performNewAnalysis(vesselName);
      const assessRef = db.doc(`${TARGET_COLLECTION}/${docId}`);
      await assessRef.set(
        {
          vesselName,
            ...analysis,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      await qRef.update({
        status: "succeeded",
        updatedAt: FieldValue.serverTimestamp()
      });
      processed++;
    } catch (err) {
      logger.error(`Processing failed for ${vesselName}:`, err);
      const nextAttempts = attempts + 1;
      await qRef.update({
        status: nextAttempts >= 3 ? "failed" : "retry",
        attempts: nextAttempts,
        error: String(err?.message || err),
        updatedAt: FieldValue.serverTimestamp()
      });
    }
  }
  return { processed };
}

// ---- Triggers & Callables ----

// Storage finalize trigger
export const processBulkImportFromStorage = onObjectFinalized(
  { region: REGION, memory: "256MiB" },
  async (event) => {
    const bucket = event?.data?.bucket;
    const name = event?.data?.name;
    if (!bucket || !name) return;

    if (bucket !== EXPECTED_BUCKET) {
      logger.info(`Ignoring file from unexpected bucket ${bucket}`);
      return;
    }
    if (!name.endsWith(".csv")) {
      logger.info(`Ignoring non-CSV '${name}'`);
      return;
    }

    if (/^[^/]+\.csv$/i.test(name)) {
      const dest = `bulk-import/${name}`;
      await getStorage().bucket(bucket).file(name).move(dest);
      logger.info(`Moved root CSV to ${dest}, awaiting new finalize.`);
      return;
    }

    if (!/^bulk-import\//.test(name)) {
      logger.info(`Ignoring CSV outside bulk-import/: '${name}'`);
      return;
    }

    if (/^bulk-import\/processed\//.test(name)) {
      logger.info(`Already processed: '${name}'`);
      return;
    }

    try {
      const { enqueued } = await enqueueFromGcsFile(bucket, name, true);
      logger.info(`Enqueued ${enqueued} vessels from ${name}`);
    } catch (e) {
      logger.error("Failed to enqueue from CSV:", e);
      throw e;
    }
  }
);

// Scheduled queue runner
export const runBulkImportQueue = onSchedule(
  {
    region: REGION,
    schedule: "every 5 minutes",
    timeZone: "Etc/UTC",
    secrets: [GEMINI_API_KEY],
    timeoutSeconds: 540,
    memory: "1GiB"
  },
  async () => {
    try {
      const { processed } = await processQueueBatch(QUEUE_PROCESS_BATCH_LIMIT);
      logger.info(`Queue batch done. processed=${processed}`);
    } catch (e) {
      logger.error("Scheduled queue run failed:", e);
      throw e;
    }
  }
);

// Callable: Immediate queue processing
export const runBulkImportQueueNow = onCall(
  {
    region: REGION,
    secrets: [GEMINI_API_KEY],
    cors: true,
    timeoutSeconds: 540,
    memory: "1GiB"
  },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (!["contributor", "admin"].includes(role)) {
      throw new HttpsError("permission-denied", "Contributor access required.");
    }
    const limitRaw = parseInt(String(req.data?.limit ?? QUEUE_PROCESS_BATCH_LIMIT), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 15) : QUEUE_PROCESS_BATCH_LIMIT;
    try {
      const { processed } = await processQueueBatch(limit);
      return { ok: true, processed };
    } catch (e) {
      logger.error("runBulkImportQueueNow failed:", e);
      throw new HttpsError("internal", e?.message || "Processing failed.");
    }
  }
);

// Callable: enqueue a CSV by reference
export const enqueueBulkImport = onCall(
  {
    region: REGION,
    cors: true
  },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (!["contributor", "admin"].includes(role)) {
      throw new HttpsError("permission-denied", "Contributor access required.");
    }

    let bucket, name;
    if (typeof req.data?.gsUri === "string" && req.data.gsUri.startsWith("gs://")) {
      const without = req.data.gsUri.slice("gs://".length);
      const idx = without.indexOf("/");
      if (idx === -1) throw new HttpsError("invalid-argument", "Invalid gsUri format.");
      bucket = without.slice(0, idx);
      name = without.slice(idx + 1);
    } else if (req.data?.bucket && req.data?.name) {
      bucket = String(req.data.bucket);
      name = String(req.data.name);
    }

    if (!bucket || !name) {
      throw new HttpsError("invalid-argument", "Provide gsUri or { bucket, name }.");
    }
    if (!name.endsWith(".csv")) {
      throw new HttpsError("invalid-argument", "Object is not a .csv file.");
    }
    if (bucket !== EXPECTED_BUCKET) {
      throw new HttpsError("invalid-argument", `Bucket must be ${EXPECTED_BUCKET}.`);
    }

    try {
      const { enqueued, processedPath } = await enqueueFromGcsFile(bucket, name, true);
      return { ok: true, enqueued, processedPath };
    } catch (e) {
      logger.error("enqueueBulkImport failed:", e);
      throw new HttpsError("internal", e?.message || "Failed to enqueue.");
    }
  }
);