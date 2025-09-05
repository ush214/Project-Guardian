/**
 * Bulk import pipeline (Firebase Functions v2, ESM)
 * - Storage trigger reads CSVs from gs://<bucket>/bulk-import/*.csv, enqueues names to Firestore, and moves CSV to bulk-import/processed/.
 * - Scheduled job processes the Firestore queue and writes analysis artifacts.
 * - Callables for manual enqueue and run-now.
 */

import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as functions from "firebase-functions";
const { logger } = functions;

import { getStorage } from "firebase-admin/storage";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ----- Config -----
const REGION = "us-central1";
const EXPECTED_BUCKET = "project-guardian-agent.firebasestorage.app";
const APP_ID = "guardian-agent-default";
const QUEUE_PATH = "system/bulkImport/queue";
const BATCH_SIZE = 5;
const FIRESTORE_BATCH_LIMIT = 500;
const GEMINI_MODEL = "gemini-2.5-pro";
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// ----- Utilities -----
function normalizeId(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
function clamp(n, min, max) {
  if (typeof n !== "number" || Number.isNaN(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}
function toNum(x) {
  if (typeof x === "number") return x;
  const n = parseFloat(String(x));
  return Number.isFinite(n) ? n : undefined;
}
function coerceParameterArray(arr, numericKeys) {
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    const out = { ...item };
    for (const k of numericKeys) {
      const v = toNum(out[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  });
}
function normalizeAndScore(report) {
  const out = { ...report };

  // WCS
  const wcsParams = coerceParameterArray(out?.wcs?.parameters, ["score"]);
  const wcsTotal = clamp(
    wcsParams.reduce((s, p) => s + clamp(toNum(p?.score) ?? 0, 0, 5), 0),
    0,
    20
  );
  out.wcs = {
    ...(out.wcs || {}),
    parameters: wcsParams,
    totalScore: wcsTotal ?? clamp(toNum(out?.wcs?.totalScore), 0, 20) ?? 0
  };

  // PHS (weighted average 0..10)
  const phsParams = coerceParameterArray(out?.phs?.parameters, ["score", "weight"]);
  const weights = phsParams.map(p => toNum(p?.weight) ?? 1).map(w => (w > 0 ? w : 1));
  const wsum = weights.reduce((s, w) => s + w, 0) || 1;
  const wval = phsParams.reduce((s, p, i) => s + (clamp(toNum(p?.score) ?? 0, 0, 10) * weights[i]), 0);
  const phsTotal = clamp(wval / wsum, 0, 10);
  out.phs = {
    ...(out.phs || {}),
    parameters: phsParams,
    totalWeightedScore: phsTotal ?? clamp(toNum(out?.phs?.totalWeightedScore), 0, 10) ?? 0
  };

  // ESI: 4 required components
  const requiredEsi = [
    "Proximity to Sensitive Ecosystems",
    "Biodiversity Value",
    "Protected Areas",
    "Socioeconomic Sensitivity"
  ];
  const esiRaw = coerceParameterArray(out?.esi?.parameters, ["score"]);
  const byName = {};
  for (const p of esiRaw) if (p?.name) byName[p.name] = p;
  const esiParams = requiredEsi.map(name => {
    const p = byName[name];
    return p
      ? { ...p, score: clamp(toNum(p.score) ?? 0, 0, 10) }
      : { name, rationale: "Insufficient data.", score: 0 };
  });
  const esiTotal = clamp(esiParams.reduce((s, p) => s + (toNum(p.score) ?? 0), 0), 0, 40);
  out.esi = {
    ...(out.esi || {}),
    parameters: esiParams,
    totalScore: esiTotal ?? clamp(toNum(out?.esi?.totalScore), 0, 40) ?? 0
  };

  // RPM: 4 factors, average 1.0..2.5
  const requiredRpm = [
    "Thermal Stress",
    "Storm Exposure",
    "Seismic Activity",
    "Anthropogenic Disturbance"
  ];
  const rpmRaw = coerceParameterArray(out?.rpm?.factors, ["value"]);
  const rpmBy = {};
  for (const f of rpmRaw) if (f?.name) rpmBy[f.name] = f;
  const rpmFactors = requiredRpm.map(name => {
    const f = rpmBy[name];
    const v = clamp(toNum(f?.value) ?? 1.0, 1.0, 2.5);
    return f
      ? { ...f, value: v, rationale: (typeof f?.rationale === "string" && f.rationale.trim()) ? f.rationale : "Not specified." }
      : { name, value: 1.0, rationale: "Insufficient data." };
  });
  const rpmAvg = clamp(rpmFactors.reduce((s, f) => s + (toNum(f.value) ?? 1.0), 0) / rpmFactors.length, 1.0, 2.5);
  out.rpm = {
    ...(out.rpm || {}),
    factors: rpmFactors,
    finalMultiplier: clamp(toNum(out?.rpm?.finalMultiplier), 1.0, 2.5) ?? rpmAvg
  };

  // Status by presence of phase2
  const hasPhase2 = !!(out?.phase2 && (out.phase2.summary || Object.keys(out.phase2).length > 0));
  out.status = hasPhase2 ? "completed" : "initial";

  return out;
}

function extractJsonCandidate(text) {
  const s = String(text || "");
  let m = s.match(/```json([\s\S]*?)```/i);
  if (m?.[1]) return m[1].trim();
  m = s.match(/```([\s\S]*?)```/i);
  if (m?.[1]) return m[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return s.slice(first, last + 1).trim();
  return s.trim();
}
function buildSchemas() {
  return {
    wcs: {
      type: "object",
      properties: {
        parameters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rationale: { type: "string" },
              score: { type: "number", minimum: 0, maximum: 5 }
            },
            required: ["name", "score"]
          },
          minItems: 4,
          maxItems: 8
        },
        totalScore: { type: "number", minimum: 0, maximum: 20 }
      },
      required: ["parameters"]
    },
    phs: {
      type: "object",
      properties: {
        parameters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rationale: { type: "string" },
              weight: { type: "number", minimum: 0, maximum: 5 },
              score: { type: "number", minimum: 0, maximum: 10 }
            },
            required: ["name", "score"]
          },
          minItems: 4,
          maxItems: 10
        },
        totalWeightedScore: { type: "number", minimum: 0, maximum: 10 }
      },
      required: ["parameters"]
    },
    esi: {
      type: "object",
      properties: {
        parameters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rationale: { type: "string" },
              score: { type: "number", minimum: 0, maximum: 10 }
            },
            required: ["name", "score"]
          },
          minItems: 4,
          maxItems: 12
        },
        totalScore: { type: "number", minimum: 0, maximum: 40 }
      },
      required: ["parameters"]
    },
    rpm: {
      type: "object",
      properties: {
        factors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rationale: { type: "string" },
              value: { type: "number", minimum: 1.0, maximum: 2.5 }
            },
            required: ["name", "value"]
          },
          minItems: 4,
          maxItems: 12
        },
        finalMultiplier: { type: "number", minimum: 1.0, maximum: 2.5 }
      },
      required: ["factors"]
    }
  };
}

async function callGemini(prompt, schema /* optional JSON schema */) {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("GEMINI_API_KEY secret is not available at runtime.");

  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const request = {
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: {
      responseMimeType: "application/json",
      ...(schema ? { responseSchema: schema } : {}),
    },
  };

  const res = await model.generateContent(request);
  const raw = res?.response?.text ? res.response.text() : "";
  const candidate = extractJsonCandidate(raw);

  try {
    return JSON.parse(candidate);
  } catch (e) {
    logger.error("Failed to parse Gemini JSON. Raw output:", raw);
    throw new Error("Gemini did not return valid JSON for the given prompt.");
  }
}

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch (e) {
    logger.error("Failed to read Role for uid:", uid, e);
    return "user";
  }
}

function parseGcsRefFromData(data) {
  if (!data || typeof data !== "object") return null;

  if (typeof data.gsUri === "string" && data.gsUri.startsWith("gs://")) {
    const without = data.gsUri.slice("gs://".length);
    const i = without.indexOf("/");
    if (i === -1) return null;
    return { bucket: without.slice(0, i), name: without.slice(i + 1) };
  }

  if (typeof data.bucket === "string" && typeof data.name === "string") {
    return { bucket: data.bucket, name: data.name };
  }

  if (typeof data.bucket === "string" && typeof data.object === "string") {
    return { bucket: data.bucket, name: data.object };
  }

  if (typeof data.path === "string" && data.path.startsWith("gs://")) {
    const without = data.path.slice("gs://".length);
    const i = without.indexOf("/");
    if (i === -1) return null;
    return { bucket: without.slice(0, i), name: without.slice(i + 1) };
  }

  return null;
}

function splitLinesToVessels(contents) {
  return String(contents || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function enqueueVessels(vesselNames) {
  if (!Array.isArray(vesselNames) || vesselNames.length === 0) return { enqueued: 0 };

  let enqueued = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const vesselName of vesselNames) {
    const docId = normalizeId(vesselName);
    if (!docId) continue;

    const queueRef = db.doc(`${QUEUE_PATH}/${docId}`);
    batch.set(
      queueRef,
      {
        vesselName,
        docId,
        status: "pending",
        attempts: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    enqueued++;
    batchCount++;

    if (batchCount >= FIRESTORE_BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) await batch.commit();
  return { enqueued };
}

async function enqueueFromGcsFile(bucket, name, moveToProcessed = true) {
  if (!bucket || !name) throw new Error("Missing bucket or name for the GCS file.");

  logger.info(`Downloading GCS file: gs://${bucket}/${name}`);
  const file = getStorage().bucket(bucket).file(name);
  const [buf] = await file.download();
  const contents = buf.toString("utf8");

  const vesselNames = splitLinesToVessels(contents);
  if (vesselNames.length === 0) {
    logger.warn(`GCS file 'gs://${bucket}/${name}' is empty.`);
    return { enqueued: 0, processedPath: null };
  }

  logger.info(`Found ${vesselNames.length} names. Enqueuing...`);
  const { enqueued } = await enqueueVessels(vesselNames);

  const isAlreadyProcessed = /^bulk-import\/processed\//.test(name);
  const shouldMove = moveToProcessed && !isAlreadyProcessed && /^bulk-import\//.test(name);

  let processedPath = null;
  if (shouldMove) {
    const destName = name.replace(/^bulk-import\//, "bulk-import/processed/");
    await file.move(destName);
    processedPath = `gs://${bucket}/${destName}`;
    logger.info(`Moved processed file to '${processedPath}'.`);
  } else if (isAlreadyProcessed) {
    logger.info(`Not moving: file already under processed/: 'gs://${bucket}/${name}'`);
  }

  return { enqueued, processedPath };
}

// ----- Prompt Generation -----
function getPhase1Prompt(v) {
  return `You are an expert maritime historian. For "${v}", conduct a Phase 1 WERP assessment.
Return strictly valid JSON with:
{
  "summary": {"background":"...", "location":"...", "discovery":"..."},
  "screening": {
    "vesselType":"...", "tonnage":"...", "yearBuilt":"...", "lastOwner":"...",
    "coordinates": {"latitude": <number>, "longitude": <number>}
  }
}`;
}
function getWcsPrompt(v, c) {
  return `You are a naval architecture expert. For "${v}", analyze WCS based on context: ${c}.
Return strictly valid JSON for the object:
{
  "parameters": [
    {"name":"Age","rationale":"...","score":0-5},
    {"name":"Construction","rationale":"...","score":0-5},
    {"name":"Integrity","rationale":"...","score":0-5},
    {"name":"Corrosion","rationale":"...","score":0-5}
  ],
  "totalScore": 0-20
}
Make sure totalScore equals the sum of the parameter scores and does not exceed 20.`;
}
function getPhsPrompt(v, c) {
  return `You are a marine pollution expert. For "${v}", analyze PHS based on context: ${c}.
Return strictly valid JSON for the object:
{
  "parameters": [
    {"name":"Fuel Volume & Type","rationale":"...","weight":1,"score":0-10},
    {"name":"Cargo Risk","rationale":"...","weight":1,"score":0-10},
    {"name":"Residual Oils","rationale":"...","weight":1,"score":0-10},
    {"name":"Leak Likelihood","rationale":"...","weight":1,"score":0-10}
  ],
  "totalWeightedScore": 0-10
}
totalWeightedScore must be the weighted average of the parameter scores (weights default 1), clamped 0..10.`;
}
function getEsiPrompt(v, l) {
  return `You are a marine ecologist. For "${v}" at "${l}", analyze ESI.
Return strictly valid JSON for the object:
{
  "parameters": [
    {"name":"Proximity to Sensitive Ecosystems","rationale":"...","score":0-10},
    {"name":"Biodiversity Value","rationale":"...","score":0-10},
    {"name":"Protected Areas","rationale":"...","score":0-10},
    {"name":"Socioeconomic Sensitivity","rationale":"...","score":0-10}
  ],
  "totalScore": 0-40
}
Ensure all four parameters are included and totalScore equals the sum of their scores (0..40).`;
}
function getRpmPrompt(v, l) {
  return `You are a climate scientist. For "${v}" near "${l}", compute RPM (Risk Pressure Modifiers).
Return strictly valid JSON for the object:
{
  "factors": [
    {"name":"Thermal Stress","rationale":"...","value":1.0-2.5},
    {"name":"Storm Exposure","rationale":"...","value":1.0-2.5},
    {"name":"Seismic Activity","rationale":"...","value":1.0-2.5},
    {"name":"Anthropogenic Disturbance","rationale":"...","value":1.0-2.5}
  ],
  "finalMultiplier": 1.0-2.5
}
finalMultiplier must be the average of the factor values and include rationales for each factor.`;
}
function getSummaryPrompt(v, d) {
  const c = JSON.stringify(d);
  return `You are a lead strategist. For "${v}", synthesize this data: ${c}.
Return strictly valid JSON:
{
  "summativeAssessment": "...",
  "remediationSuggestions": [
    {"priority":1,"title":"...","description":"..."},
    {"priority":2,"title":"...","description":"..."},
    {"priority":3,"title":"...","description":"..."}
  ]
}`;
}

// ----- Core Analysis -----
async function performNewAnalysis(vesselName) {
  const schema = buildSchemas();
  const report = { vesselName };

  report.phase1 = await callGemini(getPhase1Prompt(vesselName));
  report.wcs = await callGemini(getWcsPrompt(vesselName, report.phase1?.summary?.background || ""), schema.wcs);
  const phs = await callGemini(getPhsPrompt(vesselName, report.phase1?.summary?.background || ""), schema.phs);
  report.phs = normalizeAndScore({ phs }).phs;
  const esi = await callGemini(getEsiPrompt(vesselName, report.phase1?.summary?.location || ""), schema.esi);
  report.esi = normalizeAndScore({ esi }).esi;
  report.rpm = await callGemini(getRpmPrompt(vesselName, report.phase1?.summary?.location || ""), schema.rpm);
  report.finalSummary = await callGemini(getSummaryPrompt(vesselName, report));

  return normalizeAndScore(report);
}

// ----- Queue Processing -----
async function processQueueBatch(limit = BATCH_SIZE) {
  logger.info("Running queue processor batch...");

  const results = [];

  const qPending = await db
    .collection(QUEUE_PATH)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get();

  results.push(...qPending.docs);

  if (results.length < limit) {
    const qRetry = await db
      .collection(QUEUE_PATH)
      .where("status", "==", "retry")
      .orderBy("createdAt", "asc")
      .limit(limit - results.length)
      .get();
    results.push(...qRetry.docs);
  }

  if (results.length === 0) {
    logger.info("Queue is empty.");
    return { processed: 0 };
  }

  let processed = 0;

  for (const doc of results) {
    const qRef = doc.ref;
    const data = doc.data() || {};
    const vesselName = data.vesselName;
    const docId = data.docId;
    const attempts = data.attempts ?? 0;

    if (!vesselName || !docId) {
      logger.warn(`Skipping malformed queue doc ${qRef.path}`);
      await qRef.update({
        status: "failed",
        error: "Missing vesselName or docId",
        updatedAt: FieldValue.serverTimestamp(),
      });
      continue;
    }

    await qRef.update({
      status: "processing",
      updatedAt: FieldValue.serverTimestamp(),
    });

    try {
      const analysis = await performNewAnalysis(vesselName);
      const assessRef = db.doc(`artifacts/${APP_ID}/public/data/werpassessments/${docId}`);
      await assessRef.set(
        {
          vesselName,
          ...analysis,
          status: analysis?.status || "initial",
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      await qRef.update({
        status: "succeeded",
        updatedAt: FieldValue.serverTimestamp(),
      });
      processed++;
      logger.info(`Success for '${vesselName}'.`);
    } catch (err) {
      logger.error(`Bulk import failed for '${vesselName}':`, err);
      const nextAttempts = (attempts ?? 0) + 1;
      const terminal = nextAttempts >= 3;
      await qRef.update({
        status: terminal ? "failed" : "retry",
        error: String(err?.message || "Unknown error"),
        attempts: nextAttempts,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }

  return { processed };
}

// ----- Triggers & Callables -----
export const processBulkImportFromStorage = onObjectFinalized(
  { region: REGION, cpu: 1, memory: "512MiB" },
  async (event) => {
    const bucket = event?.data?.bucket;
    const name = event?.data?.name;

    if (bucket !== EXPECTED_BUCKET) {
      logger.info(`Ignoring event from bucket ${bucket}. Expected ${EXPECTED_BUCKET}.`);
      return;
    }
    if (!name || !name.endsWith(".csv")) {
      logger.info(`Ignoring non-CSV file '${name}'.`);
      return;
    }
    if (/^bulk-import\/processed\//.test(name)) {
      logger.info(`Ignoring already-processed file '${name}'.`);
      return;
    }
    if (/^[^/]+\.csv$/i.test(name)) {
      const destName = `bulk-import/${name}`;
      await getStorage().bucket(bucket).file(name).move(destName);
      logger.info(`Relocated root CSV to '${destName}', awaiting new finalize event.`);
      return;
    }
    if (!/^bulk-import\//.test(name)) {
      logger.info(`Ignoring file outside bulk-import/: '${name}'.`);
      return;
    }

    try {
      await enqueueFromGcsFile(bucket, name, true);
    } catch (err) {
      logger.error(`Error processing uploaded CSV '${name}':`, err);
      throw err;
    }
  }
);

export const runBulkImportQueue = onSchedule(
  {
    region: REGION,
    schedule: "every 5 minutes",
    timeZone: "Etc/UTC",
    secrets: [GEMINI_API_KEY],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    try {
      const { processed } = await processQueueBatch(BATCH_SIZE);
      logger.info(`Queue batch complete. processed=${processed}`);
    } catch (e) {
      logger.error("runBulkImportQueue failed:", e);
      throw e;
    }
  }
);

export const runBulkImportQueueNow = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [GEMINI_API_KEY],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (!["contributor", "admin"].includes(role)) {
      throw new HttpsError("permission-denied", "Contributor access required.");
    }
    try {
      const limit = Number(request.data?.limit ?? BATCH_SIZE);
      const { processed } = await processQueueBatch(limit);
      return { ok: true, processed };
    } catch (e) {
      logger.error("runBulkImportQueueNow failed:", e);
      throw new HttpsError("internal", e?.message || "Queue processing failed.");
    }
  }
);

export const enqueueBulkImport = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign-in required.");
    }
    const role = await getRole(uid);
    if (!["contributor", "admin"].includes(role)) {
      throw new HttpsError("permission-denied", "Contributor access required.");
    }

    try {
      const ref = parseGcsRefFromData(request.data);
      if (!ref) {
        throw new HttpsError("invalid-argument", "Expected data with gsUri or { bucket, name | object }.");
      }
      if (!ref.name.endsWith(".csv")) {
        throw new HttpsError("invalid-argument", "Provided object is not a .csv file.");
      }
      if (ref.bucket !== EXPECTED_BUCKET) {
        throw new HttpsError("invalid-argument", `Bucket must be ${EXPECTED_BUCKET}.`);
      }

      const { enqueued, processedPath } = await enqueueFromGcsFile(ref.bucket, ref.name, true);
      return { ok: true, enqueued, processedPath };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error("enqueueBulkImport failed:", e);
      throw new HttpsError("invalid-argument", e?.message || "Invalid request, unable to process.");
    }
  }
);