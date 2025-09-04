/**
 * Bulk import pipeline (JavaScript, Firebase Functions v2):
 * - processBulkImportFromStorage: GCS onObjectFinalized trigger that reads a CSV (one vessel per line)
 *   from gs://project-guardian-agent.firebasestorage.app/bulk-import/*.csv and enqueues Firestore docs.
 * - runBulkImportQueue: Scheduled job that processes queued items and writes analysis artifacts.
 *
 * Requirements:
 * - Admin initializer file that exports `db` (e.g., functions/src/admin.js).
 * - Secret named GEMINI_API_KEY configured in the Firebase/Google Cloud project.
 * - Dependency @google/generative-ai installed.
 *
 * Notes:
 * - Adjust APP_ID and collection paths to match your app’s structure.
 * - This file intentionally avoids naming conflicts with any existing HTTP function named
 *   `processBulkImportQueue` by naming the scheduler `runBulkImportQueue`.
 */

import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getStorage } from "firebase-admin/storage";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ----- Config -----
const REGION = "us-central1";
const BUCKET = "project-guardian-agent.firebasestorage.app";
const APP_ID = "guardian"; // TODO: set this to your actual app id if different
const QUEUE_PATH = "system/bulkImport/queue";
const BATCH_SIZE = 5;
const GEMINI_MODEL = "gemini-2.5-pro";
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// ----- Utilities -----
function normalizeId(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function stripCodeFences(text) {
  // Remove ```json ... ``` or ``` ... ``` fences if present
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function callGemini(prompt) {
  const key = GEMINI_API_KEY.value();
  if (!key) {
    throw new Error("GEMINI_API_KEY secret is not available at runtime.");
  }
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
  report.wcs = await callGemini(
    getWcsPrompt(vesselName, report.phase1?.summary?.background || "")
  );
  report.phs = await callGemini(
    getPhsPrompt(vesselName, report.phase1?.summary?.background || "")
  );
  report.esi = await callGemini(
    getEsiPrompt(vesselName, report.phase1?.summary?.location || "")
  );
  report.rpm = await callGemini(
    getRpmPrompt(vesselName, report.phase1?.summary?.location || "")
  );
  report.finalSummary = await callGemini(getSummaryPrompt(vesselName, report));
  return report;
}

// ----- Cloud Functions -----
// 1) STORAGE-TRIGGERED: Enqueue vessel names from CSV upload
export const processBulkImportFromStorage = onObjectFinalized(
  {
    region: REGION,
    bucket: BUCKET,
    cpu: 1,
    memory: "512MiB",
  },
  async (event) => {
    const { bucket, name } = event.data;

    if (!name || !name.startsWith("bulk-import/") || !name.endsWith(".csv")) {
      logger.info(`Ignoring file '${name}'.`);
      return;
    }

    logger.info(`Processing uploaded file: ${name}`);
    const file = getStorage().bucket(bucket).file(name);
    const [buf] = await file.download();
    const contents = buf.toString("utf8");

    const vesselNames = contents
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (vesselNames.length === 0) {
      logger.warn(`File '${name}' is empty.`);
      return;
    }

    logger.info(`Found ${vesselNames.length} names. Enqueuing...`);

    const batch = db.batch();
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
    }
    await batch.commit();

    const newName = name.replace("bulk-import/", "bulk-import/processed/");
    await file.move(newName);
    logger.info(`Moved processed file to '${newName}'.`);
  }
);

// 2) SCHEDULED: Process the Firestore queue (renamed to avoid clashing with your existing HTTP function)
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

      await qRef.update({
        status: "processing",
        updatedAt: FieldValue.serverTimestamp(),
      });

      try {
        const analysis = await performNewAnalysis(vesselName);
        const assessRef = db.doc(
          `artifacts/${APP_ID}/public/data/werpassessments/${docId}`
        );
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