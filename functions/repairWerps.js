/**
 * repairWerps.js
 *
 * Regenerates incomplete sections (PHS, ESI, RPM) for a page of documents OR a single doc.
 * Enhanced RPM criteria:
 *  - Missing any required factor (Thermal Stress (Ocean Warming), Seismic Activity, Anthropogenic Disturbance)
 *  - OR all values = 1 and ≥2 placeholder rationales
 *  - OR zero factors
 *
 * PHS fix triggers if:
 *  - Not version 3 (after you have migrated)
 *  - Wrong parameter count
 *  - Missing one of required names
 *
 * ESI fix triggers if:
 *  - Missing parameters array
 *  - Any parameter lacks rationale
 *
 * Accepts:
 *  dryRun (boolean)
 *  docId (optional single document)
 *  startAfterId (pagination)
 *  pageSize (scan window)
 *  maxDocs (max docs to actually repair within page)
 *  timeBudgetSeconds (early stop)
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { defineSecret } from "firebase-functions/params";

const logger = functions.logger;
const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const COLLECTION = `artifacts/${APP_ID}/public/data/werpassessments`;
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

const PHS_V3_REQUIRED = ["Fuel Volume & Type", "Ordnance", "Hazardous Materials"];
const RPM_REQUIRED = ["Thermal Stress (Ocean Warming)", "Seismic Activity", "Anthropogenic Disturbance"];

const PLACEHOLDERS = new Set(["", "not specified.", "insufficient data.", "unknown."]);

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch {
    return "user";
  }
}

function isPlaceholder(r) {
  if (!r) return true;
  return PLACEHOLDERS.has(r.trim().toLowerCase());
}

function phsNeedsRepair(phs) {
  if (!phs || !Array.isArray(phs.parameters)) return true;
  if (phs.version !== 3) return true;
  if (phs.parameters.length !== 3) return true;
  const names = phs.parameters.map(p => p.name);
  for (const req of PHS_V3_REQUIRED) {
    if (!names.includes(req)) return true;
  }
  return false;
}

function esiNeedsRepair(esi) {
  if (!esi || !Array.isArray(esi.parameters) || esi.parameters.length !== 3) return true;
  return esi.parameters.some(p => isPlaceholder(p.rationale));
}

function rpmNeedsRepair(rpm) {
  if (!rpm || !Array.isArray(rpm.factors) || rpm.factors.length === 0) return true;
  const names = rpm.factors.map(f => f.name);
  const missing = RPM_REQUIRED.some(r => !names.includes(r));
  if (missing) return true;
  const placeholderCount = rpm.factors.filter(f => isPlaceholder(f.rationale)).length;
  const allValuesBaseline = rpm.factors.every(f => Number(f.value) === 1);
  if (allValuesBaseline && placeholderCount >= Math.min(2, rpm.factors.length)) return true;
  return false;
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

function buildRepairPrompt(vesselName, want) {
  // want = { phs:true/false, esi:true/false, rpm:true/false }
  return `You are updating missing risk assessment sections for a vessel.
Return ONLY JSON (no markdown fences). Provide only requested sections.

Desired JSON keys (include only those requested):
{
  "phs": {
    "version": 3,
    "parameters": [
      {"name":"Fuel Volume & Type","weight":0.50,"rationale":"...","score":0},
      {"name":"Ordnance","weight":0.30,"rationale":"...","score":0},
      {"name":"Hazardous Materials","weight":0.20,"rationale":"...","score":0}
    ],
    "totalWeightedScore": 0
  },
  "esi": {
    "parameters":[
      {"name":"Proximity to Sensitive Ecosystems","rationale":"...","score":0},
      {"name":"Biodiversity Value","rationale":"...","score":0},
      {"name":"Socioeconomic Sensitivity","rationale":"...","score":0}
    ],
    "totalScore":0,
    "maxScore":30
  },
  "rpm": {
    "factors":[
      {"name":"Thermal Stress (Ocean Warming)","rationale":"...","value":1.0},
      {"name":"Seismic Activity","rationale":"...","value":1.0},
      {"name":"Anthropogenic Disturbance","rationale":"...","value":1.0}
    ],
    "finalMultiplier":1.0
  }
}

Scoring constraints:
- PHS scores 0–10 (weight sum=1.0, compute totalWeightedScore).
- ESI scores 0–10 each (sum => totalScore ≤ 30).
- RPM values 0.5–2.5; finalMultiplier is average of values (2 decimals).
Avoid placeholders like "Insufficient data." Provide concise evidence-based rationales.

Only produce sections flagged for repair: ${JSON.stringify(want)}.
Vessel: ${vesselName}`;
}

async function runModel(vesselName, want) {
  const prompt = buildRepairPrompt(vesselName, want);
  const model = createModel();
  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" }
  });
  const raw = res?.response?.text() || "";
  let parsed;
  try {
    parsed = JSON.parse(extractJsonCandidate(raw));
  } catch (e) {
    throw new Error("Model parse error: " + (e.message || e));
  }
  return parsed;
}

async function processPage({ dryRun, docId, startAfterId, pageSize, maxDocs, timeBudgetSeconds }) {
  const startTime = Date.now();
  const deadline = timeBudgetSeconds
    ? startTime + Math.max(5, Math.min(timeBudgetSeconds, 500)) * 1000
    : null;

  let docs = [];
  if (docId) {
    const snap = await db.collection(COLLECTION).doc(docId).get();
    if (snap.exists) docs.push(snap);
  } else {
    let q = db.collection(COLLECTION).orderBy("vesselName").limit(pageSize);
    if (startAfterId) {
      const anchor = await db.collection(COLLECTION).doc(startAfterId).get();
      if (anchor.exists) {
        const vesselName = anchor.get("vesselName");
        if (vesselName) {
          q = db.collection(COLLECTION).orderBy("vesselName").startAfter(vesselName).limit(pageSize);
        }
      }
    }
    const snap = await q.get();
    docs = snap.docs;
  }

  const result = {
    scanned: 0,
    updated: 0,
    phsFixed: 0,
    esiFixed: 0,
    rpmFixed: 0,
    wrote: 0,
    nextPageStartAfterId: ""
  };

  if (docs.length === 0) return result;

  let repairsPerformed = 0;
  for (const d of docs) {
    if (deadline && Date.now() > deadline - 500) {
      break;
    }
    result.scanned++;
    if (repairsPerformed >= maxDocs) continue;

    const data = d.data();
    const want = {
      phs: phsNeedsRepair(data.phs),
      esi: esiNeedsRepair(data.esi),
      rpm: rpmNeedsRepair(data.rpm)
    };
    if (!want.phs && !want.esi && !want.rpm) continue;

    // Run model for this doc
    let modelOut;
    try {
      modelOut = await runModel(data.vesselName || d.id, want);
    } catch (e) {
      // log and skip
      logger.warn(`Model failed for doc ${d.id}:`, e.message);
      continue;
    }

    const patch = {};
    if (want.phs && modelOut.phs?.parameters) {
      // Enforce weights & version
      modelOut.phs.version = 3;
      for (const p of modelOut.phs.parameters) {
        if (p.name === "Fuel Volume & Type") p.weight = 0.50;
        else if (p.name === "Ordnance") p.weight = 0.30;
        else if (p.name === "Hazardous Materials") p.weight = 0.20;
        p.score = Math.min(10, Math.max(0, p.score || 0));
      }
      modelOut.phs.totalWeightedScore = modelOut.phs.parameters.reduce(
        (s, p) => s + p.score * p.weight,
        0
      );
      result.phsFixed++;
      patch.phs = {
        ...data.phs,
        ...modelOut.phs
      };
    }
    if (want.esi && modelOut.esi?.parameters) {
      for (const p of modelOut.esi.parameters) {
        p.score = Math.min(10, Math.max(0, p.score || 0));
      }
      modelOut.esi.maxScore = 30;
      modelOut.esi.totalScore = modelOut.esi.parameters.reduce((s, p) => s + p.score, 0);
      result.esiFixed++;
      patch.esi = {
        ...data.esi,
        ...modelOut.esi
      };
    }
    if (want.rpm && modelOut.rpm?.factors) {
      for (const f of modelOut.rpm.factors) {
        f.value = Math.min(2.5, Math.max(0.5, f.value || 1));
      }
      const avg =
        modelOut.rpm.factors.reduce((s, f) => s + f.value, 0) / modelOut.rpm.factors.length;
      modelOut.rpm.finalMultiplier = parseFloat(avg.toFixed(2));
      result.rpmFixed++;
      patch.rpm = {
        ...data.rpm,
        ...modelOut.rpm
      };
    }

    if (Object.keys(patch).length) {
      result.updated++;
      if (!dryRun) {
        await d.ref.set(
          {
            ...patch,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        result.wrote++;
      }
      repairsPerformed++;
    }
  }

  // Paging token (only if not single doc)
  if (!docId && docs.length === pageSize) {
    result.nextPageStartAfterId = docs[docs.length - 1].id;
  }
  return result;
}

export const repairWerps = onCall(
  { region: REGION, timeoutSeconds: 540, memory: "1GiB", secrets: [GEMINI_API_KEY] },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin role required.");

    const dryRun = !!req.data?.dryRun;
    const docId = typeof req.data?.docId === "string" ? req.data.docId.trim() : "";
    const startAfterId = typeof req.data?.startAfterId === "string" ? req.data.startAfterId.trim() : "";
    const pageSize = Math.min(Math.max(parseInt(req.data?.pageSize ?? "150", 10), 10), 450);
    const maxDocs = Math.min(Math.max(parseInt(req.data?.maxDocs ?? "50", 10), 1), pageSize);
    const timeBudgetSeconds = req.data?.timeBudgetSeconds
      ? parseInt(req.data.timeBudgetSeconds, 10)
      : undefined;

    try {
      const res = await processPage({
        dryRun,
        docId,
        startAfterId,
        pageSize,
        maxDocs,
        timeBudgetSeconds
      });
      return { ok: true, dryRun, ...res };
    } catch (e) {
      logger.error("repairWerps error:", e);
      throw new HttpsError("internal", e?.message || "Repair failed.");
    }
  }
);