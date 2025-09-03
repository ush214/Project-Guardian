// Admin-only bulk import queue and scheduled processor (ESM).
// Uses Firebase Secret GEMINI_API_KEY and model gemini-2.5-pro.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "./admin.js";

const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const QUEUE_PATH = "system/bulkImport/queue";
const BATCH_SIZE = 5;
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

// Allow your Hosting site and common local dev ports
const ALLOWED_ORIGINS = [
  "https://project-guardian-agent.web.app",
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://127.0.0.1:5000"
];

function normalizeId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function getRole(uid) {
  const snap = await db.doc(`system/allowlist/users/${uid}`).get();
  if (!snap.exists) return "user";
  return snap.get("Role") || "user";
}

function createGeminiClient() {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("GEMINI_API_KEY secret is not available at runtime.");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

async function callGemini(prompt) {
  const model = createGeminiClient();
  const res = await model.generateContent(prompt);
  const text = typeof res.response.text === "function" ? res.response.text() : "";
  const raw = (text || "").trim();
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Gemini JSON parse failed. Raw:", raw);
    throw new Error("Model returned invalid JSON.");
  }
}

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

function getWcsPrompt(v, context) {
  return `You are a naval architecture expert. For "${v}", analyze WCS using context: ${context}.
Return JSON:
{
  "parameters": [
    {"name":"Age","rationale":"...","score":0-5},
    {"name":"Construction","rationale":"...","score":0-5},
    {"name":"Integrity","rationale":"...","score":0-5},
    {"name":"Corrosion","rationale":"...","score":0-5}
  ],
  "totalScore": 0-20
}`;
}

function getPhsPrompt(v, context) {
  return `You are a marine pollution expert. For "${v}", analyze PHS using context: ${context}.
Return JSON:
{
  "parameters": [
    {"name":"Fuel Volume & Type","rationale":"...","weight":1,"score":0-10},
    {"name":"Cargo Risk","rationale":"...","weight":1,"score":0-10},
    {"name":"Residual Oils","rationale":"...","weight":1,"score":0-10},
    {"name":"Leak Likelihood","rationale":"...","weight":1,"score":0-10}
  ],
  "totalWeightedScore": 0-10
}`;
}

function getEsiPrompt(v, loc) {
  return `You are a marine ecologist. For "${v}" near "${loc}", analyze ESI.
Return JSON:
{
  "parameters": [
    {"name":"Proximity to Sensitive Ecosystems","rationale":"...","score":0-10},
    {"name":"Biodiversity Value","rationale":"...","score":0-10},
    {"name":"Protected Areas","rationale":"...","score":0-10},
    {"name":"Socioeconomic Sensitivity","rationale":"...","score":0-10}
  ],
  "totalScore": 0-40
}`;
}

function getRpmPrompt(v, loc) {
  return `You are a climate scientist. For "${v}" near "${loc}", analyze RPM (Risk Pressure Modifiers).
Return JSON:
{
  "factors": [
    {"name":"Thermal Stress","rationale":"...","value":1.0-2.5},
    {"name":"Storm Exposure","rationale":"...","value":1.0-2.5},
    {"name":"Seismic Activity","rationale":"...","value":1.0-2.5},
    {"name":"Anthropogenic Disturbance","rationale":"...","value":1.0-2.5}
  ],
  "finalMultiplier": 1.0-2.5
}`;
}

function getSummaryPrompt(v, d) {
  const c = JSON.stringify(d);
  return `You are a lead strategist. For "${v}", synthesize this data: ${c}.
Return JSON:
{
  "summativeAssessment": "...",
  "remediationSuggestions": [
    {"priority":1,"title":"...","description":"..."},
    {"priority":2,"title":"...","description":"..."},
    {"priority":3,"title":"...","description":"..."}
  ]
}`;
}

async function performNewAnalysis(vesselName) {
  const report = { vesselName };
  report.phase1 = await callGemini(getPhase1Prompt(vesselName));
  report.wcs = await callGemini(getWcsPrompt(vesselName, report.phase1.summary.background));
  report.phs = await callGemini(getPhsPrompt(vesselName, report.phase1.summary.background));
  report.esi = await callGemini(getEsiPrompt(vesselName, report.phase1.summary.location));
  report.rpm = await callGemini(getRpmPrompt(vesselName, report.phase1.summary.location));
  report.finalSummary = await callGemini(getSummaryPrompt(vesselName, report));
  return report;
}

// Admin-only callable: enqueue comma-separated names
export const enqueueBulkImport = onCall(
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
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin only.");

    const raw = String(req.data?.names || "");
    const names = raw.split(",").map(s => s.trim()).filter(Boolean);

    const seen = new Set();
    let skippedDuplicate = 0;
    let skippedExisting = 0;
    let enqueued = 0;

    for (const name of names) {
      const docId = normalizeId(name);
      if (!docId) { skippedDuplicate++; continue; }
      if (seen.has(docId)) { skippedDuplicate++; continue; }
      seen.add(docId);

      // Skip if assessment already exists
      const assessRef = db.doc(`artifacts/${APP_ID}/public/data/werpassessments/${docId}`);
      if ((await assessRef.get()).exists) {
        skippedExisting++;
        continue;
      }

      // Idempotent queue doc by docId (one queued item per vessel)
      const qRef = db.doc(`${QUEUE_PATH}/${docId}`);
      await qRef.set({
        vesselName: name,
        docId,
        status: "pending",
        attempts: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      enqueued++;
    }

    return { total: names.length, enqueued, skippedDuplicate, skippedExisting };
  }
);

// Scheduled processor
export const processBulkImportQueue = onSchedule(
  { region: REGION, schedule: "every 10 minutes", timeZone: "Etc/UTC", secrets: [GEMINI_API_KEY] },
  async () => {
    const qCol = db.collection("system").doc("bulkImport").collection("queue");
    const snap = await qCol.where("status", "==", "pending").orderBy("createdAt", "asc").limit(BATCH_SIZE).get();

    for (const docSnap of snap.docs) {
      const qRef = docSnap.ref;
      const data = docSnap.data();

      // Claim atomically
      const claimed = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(qRef);
        if (!fresh.exists) return false;
        if (fresh.get("status") !== "pending") return false;
        tx.update(qRef, { status: "processing", updatedAt: FieldValue.serverTimestamp() });
        return true;
      }).catch(() => false);
      if (!claimed) continue;

      try {
        const docId = data.docId;
        const name = data.vesselName;

        // Dedup guard at processing time
        const assessRef = db.doc(`artifacts/${APP_ID}/public/data/werpassessments/${docId}`);
        if ((await assessRef.get()).exists) {
          await qRef.update({ status: "skipped_duplicate", updatedAt: FieldValue.serverTimestamp() });
          continue;
        }

        const report = await performNewAnalysis(name);
        await assessRef.set({ ...report, status: "initial", createdAt: FieldValue.serverTimestamp() });
        await qRef.update({ status: "done", updatedAt: FieldValue.serverTimestamp() });
      } catch (err) {
        console.error("Bulk import item failed:", docSnap.id, err);
        const attempts = (docSnap.get("attempts") || 0) + 1;
        await qRef.update({
          status: attempts >= 3 ? "failed" : "pending",
          attempts,
          updatedAt: FieldValue.serverTimestamp()
        });
      }
    }
  }
);