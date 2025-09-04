/**
 * Bulk import pipeline (JavaScript, Firebase Functions v2):
 * - processBulkImportFromStorage: GCS onObjectFinalized trigger that reads a CSV (one vessel per line)
 *   from gs://project-guardian-agent.firebasestorage.app/bulk-import/*.csv and enqueues Firestore docs.
 * - enqueueBulkImport: Firebase callable function to enqueue from a provided GCS path (manual/HTTP kick-off).
 * - runBulkImportQueue: Scheduled job that processes queued items and writes analysis artifacts.
 *
 * Requirements:
 * - Admin initializer file that exports `db` (e.g., functions/admin.js).
 * - Secret named GEMINI_API_KEY configured in the Firebase/Google Cloud project.
 * - Dependency @google/generative-ai installed.
 */

import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getStorage } from "firebase-admin/storage";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ----- Config -----
const REGION = "us-central1";
const EXPECTED_BUCKET = "project-guardian-agent.firebasestorage.app"; // confirmed by you
const APP_ID = "guardian"; // adjust if needed
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

function stripCodeFences(text) {
  return String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function callGemini(prompt) {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("GEMINI_API_KEY secret is not available at runtime.");
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const res = await model.generateContent(prompt);
  const raw = res.response.text();
  const cleaned = stripCodeFences(raw);

  try {
    return JSON.parse(cleaned);
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
    const firstSlash = without.indexOf("/");
    if (firstSlash === -1) return null;
    const bucket = without.slice(0, firstSlash);
    const name = without.slice(firstSlash + 1);
    return { bucket, name };
  }

  if (typeof data.bucket === "string" && typeof data.name === "string") {
    return { bucket: data.bucket, name: data.name };
  }

  if (typeof data.bucket === "string" && typeof data.object === "string") {
    return { bucket: data.bucket, name: data.object };
  }

  if (typeof data.path === "string" && data.path.startsWith("gs://")) {
    const without = data.path.slice("gs://".length);
    const firstSlash = without.indexOf("/");
    if (firstSlash === -1) return null;
    const bucket = without.slice(0, firstSlash);
    const name = without.slice(firstSlash + 1);
    return { bucket, name };
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

  if (batchCount > 0) {
    await batch.commit();
  }

  return { enqueued };
}

async function enqueueFromGcsFile(bucket, name, moveToProcessed = true) {
  if (!bucket || !name) {
    throw new Error("Missing bucket or name for the GCS file.");
  }

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

  let processedPath = null;
  if (moveToProcessed && name.startsWith("bulk-import/")) {
    const newName = name.replace("bulk-import/", "bulk-import/processed/");
    await file.move(newName);
    processedPath = `gs://${bucket}/${newName}`;
    logger.info(`Moved processed file to '${processedPath}'.`);
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

// ----- Cloud Functions -----
// 1) STORAGE-TRIGGERED: Enqueue vessel names from CSV upload
// No 'bucket' filter here to avoid Eventarc validation failures.
// We filter by bucket at runtime instead.
export const processBulkImportFromStorage = onObjectFinalized(
  {
    region: REGION,
    cpu: 1,
    memory: "512MiB",
  },
  async (event) => {
    const bucket = event?.data?.bucket;
    const name = event?.data?.name;

    // Filter to only your desired bucket and path
    if (bucket !== EXPECTED_BUCKET) {
      logger.info(`Ignoring event from bucket ${bucket}. Expected ${EXPECTED_BUCKET}.`);
      return;
    }
    if (!name || !name.endsWith(".csv")) {
      logger.info(`Ignoring non-CSV file '${name}'.`);
      return;
    }
    if (!name.startsWith("bulk-import/")) {
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

// 2) CALLABLE: Manual enqueue by specifying a GCS path or bucket/object
// Keep this only if you still want a manual kick-off path. It requires Firebase Auth + role check.
export const enqueueBulkImport = onCall(
  {
    region: REGION,
    cors: true,
  },
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

// 3) SCHEDULED: Process the Firestore queue
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
    logger.info("Running scheduled queue processor...");

    const qSnap = await db
      .collection(QUEUE_PATH)
      .where("status", "in", ["pending", "retry"])
      .orderBy("createdAt", "asc")
      .limit(BATCH_SIZE)
      .get();

    if (qSnap.empty) {
      logger.info("Queue is empty.");
      return;
    }

    for (const doc of qSnap.docs) {
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
        logger.info(`Success for '${vesselName}'.`);
      } catch (err) {
        logger.error(`Bulk import failed for '${vesselName}':`, err);
        const nextAttempts = attempts + 1;
        const terminal = nextAttempts >= 3;
        await qRef.update({
          status: terminal ? "failed" : "retry",
          error: String(err?.message || "Unknown error"),
          attempts: nextAttempts,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
  }
);