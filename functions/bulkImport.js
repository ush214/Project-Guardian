/**
 * Bulk import pipeline (Firebase Functions v2, ESM)
 * - Storage trigger reads CSVs from gs://<bucket>/bulk-import/*.csv, enqueues names to Firestore, and moves CSV to bulk-import/processed/.
 * - Scheduled job processes the Firestore queue and writes analysis artifacts.
 * - Callable helpers for manual enqueue and run-now.
 *
 * Prereqs:
 * - Secret GEMINI_API_KEY in Secret Manager, access granted to default runtime SA.
 * - Firestore composite index (if you use an "IN" query). This version avoids "IN" to not require the index.
 * - db exported from ./admin.js (firebase-admin initialized).
 */

import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
// Older firebase-functions versions may not support `import { logger } from "firebase-functions/logger"`.
// Use v1 logger via the main package for compatibility.
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

function extractJsonCandidate(text) {
  const s = String(text || "");
  // Prefer fenced ```json blocks
  let m = s.match(/```json([\s\S]*?)```/i);
  if (m?.[1]) return m[1].trim();
  // Any fenced block
  m = s.match(/```([\s\S]*?)```/i);
  if (m?.[1]) return m[1].trim();
  // Fall back to first {...} block
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return s.slice(first, last + 1).trim();
  return s.trim();
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

  // Only move if the source is not already under processed/
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
  return `You are an expert maritime historian. For "${v}", conduct a Phase 1 WERP assessment. Return strictly valid JSON with coordinates: {"summary":{"background":"...","location":"...","discovery":"..."},"screening":{"vesselType":"...","tonnage":0,"sunkDate":"YYYY-MM-DD","sinkingCause":"...","coordinates":{"latitude":0.0,"longitude":0.0}},"conclusion":"..."}`;
}
function getWcsPrompt(v, c) {
  return `You are a naval architecture expert. For "${v}", analyze WCS based on context: ${c}. Return JSON: { "parameters": [{"name": "Age", "rationale": "...", "score": 0}, ...], "totalScore": 0 }`;
}
function getPhsPrompt(v, c) {
  return `You are a marine pollution expert. For "${v}", analyze PHS based on context: ${c}. Return JSON: { "parameters": [{"name": "Fuel Volume & Type", "rationale": "...", "score": 0, "weight": 40, "weightedScore": 0.0}, ...], "totalWeightedScore": 0.0 }`;
}
function getEsiPrompt(v, l) {
  return `You are a marine ecologist. For "${v}" at "${l}", analyze ESI. Return JSON: { "parameters": [{"name": "Proximity to Sensitive Ecosystems", "rationale": "...", "score": 0}, ...], "totalScore": 0 }`;
}
function getRpmPrompt(v, l) {
  return `You are a climate scientist. For "${v}" near "${l}", compute RPM. Return JSON: { "parameters": [{"name": "Thermal Stress", "rationale": "...", "value": 1.0}, ...], "finalMultiplier": 1.0 }`;
}
function getSummaryPrompt(v, d) {
  const c = JSON.stringify(d);
  return `You are a lead strategist. For "${v}", synthesize this data: ${c}. Return JSON: { "summativeAssessment": "...", "remediationSuggestions": [{"priority": 1, "title": "...", "description": "..."}, ...] }`;
}

// ----- Core Analysis -----
async function performNewAnalysis(vesselName) {
  const report = { vesselName };
  report.phase1 = await callGemini(getPhase1Prompt(vesselName));
  report.wcs = await callGemini(getWcsPrompt(vesselName, report.phase1?.summary?.background || ""));
  report.phs = await callGemini(getPhsPrompt(vesselName, report.phase1?.summary?.background || ""));
  report.esi = await callGemini(getEsiPrompt(vesselName, report.phase1?.summary?.location || ""));
  report.rpm = await callGemini(getRpmPrompt(vesselName, report.phase1?.summary?.location || ""));
  report.finalSummary = await callGemini(getSummaryPrompt(vesselName, report));
  return report;
}

// ----- Queue Processing (no composite index needed) -----
async function processQueueBatch(limit = BATCH_SIZE) {
  logger.info("Running queue processor batch...");

  const results = [];

  // Prefer pending first
  const qPending = await db
    .collection(QUEUE_PATH)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get();

  results.push(...qPending.docs);

  // Then retry if we still have capacity
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
          status: "initial",
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
// Storage-triggered: enqueue vessel names from CSV upload
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
    // Skip files already in processed/ to prevent re-trigger loops
    if (/^bulk-import\/processed\//.test(name)) {
      logger.info(`Ignoring already-processed file '${name}'.`);
      return;
    }
    // Accept root-level CSVs by relocating them into bulk-import/
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

// Scheduled: process the queue
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

// Callable: manual run-now for admins/contributors
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

// Callable: manual enqueue by specifying a GCS path or bucket/object
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