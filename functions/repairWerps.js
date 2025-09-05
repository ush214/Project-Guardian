// Updated: repairs PHS (new 4-param weighted), ESI, RPM, upgrades legacy schemas, fills missing rationales.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db } from "./admin.js";
import { FieldPath } from "firebase-admin/firestore";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  normalizeWCS,
  normalizeToPHSV2,
  normalizeESI,
  normalizeRPM,
  PHS_V2_CANONICAL,
  computePHSV2WeightedTotal
} from "./schemaMapping.js";

const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const TARGET_PATH = `artifacts/${APP_ID}/public/data/werpassessments`;
const GEMINI_MODEL = "gemini-2.5-pro";
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch {
    return "user";
  }
}

function clamp(n, min, max) {
  if (typeof n !== "number") {
    n = parseFloat(String(n));
  }
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function extractJsonCandidate(s) {
  s = String(s || "");
  let m = s.match(/```json([\s\S]*?)```/i);
  if (m) return m[1].trim();
  m = s.match(/```([\s\S]*?)```/i);
  if (m) return m[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return s.slice(first, last + 1).trim();
  return s.trim();
}

function createGeminiClient() {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

async function callGemini(prompt) {
  const model = createGeminiClient();
  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json"
    }
  });
  const raw = res?.response?.text() || "";
  const cand = extractJsonCandidate(raw);
  return JSON.parse(cand);
}

function needsPhsRepair(data) {
  const p = data?.phs?.parameters;
  if (!Array.isArray(p) || p.length !== 4) return true;
  const names = p.map(x => x.name);
  const hasAll = PHS_V2_CANONICAL.every(c => names.includes(c.name));
  if (!hasAll) return true;
  // Missing weight or off weight
  const wrongWeight = p.some(x => {
    const target = PHS_V2_CANONICAL.find(c => c.name === x.name);
    return !target || Math.abs((x.weight || 0) - target.weight) > 0.0001;
  });
  const badTotal = typeof data?.phs?.totalWeightedScore !== "number";
  return wrongWeight || badTotal;
}

function needsEsiRepair(data) {
  const p = data?.esi?.parameters;
  if (!Array.isArray(p) || p.length < 3) return true;
  const missingRationale = p.some(x => !x.rationale || !x.rationale.trim());
  const badTotal = typeof data?.esi?.totalScore !== "number";
  return missingRationale || badTotal;
}

function needsRpmRepair(data) {
  const f = data?.rpm?.factors;
  if (!Array.isArray(f) || f.length < 3) return true;
  const badFinal = typeof data?.rpm?.finalMultiplier !== "number" ||
    data.rpm.finalMultiplier < 0.5 || data.rpm.finalMultiplier > 2.5;
  const missingRationale = f.some(x => !x.rationale || !x.rationale.trim());
  return badFinal || missingRationale;
}

function buildAssessmentPrompt(vesselName, background, location) {
  return `You are an expert OSINT analyst and marine environmental risk assessor.
Return ONLY JSON (no markdown) with:

{
  "phs_pollution_hazard": {
    "parameters": [
      {"parameter":"Fuel Volume & Type","weight":0.40,"rationale":"...","score":0},
      {"parameter":"Ordnance","weight":0.25,"rationale":"...","score":0},
      {"parameter":"Vessel Integrity","weight":0.20,"rationale":"...","score":0},
      {"parameter":"Hazardous Materials","weight":0.15,"rationale":"...","score":0}
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
  }
}

Rules:
- High score/value => higher risk/sensitivity/pressure.
- PHS scores 0-10 each; weights exactly 0.40 0.25 0.20 0.15; compute weighted sum 0..10 (do not re-normalize).
- ESI scores each 0-10, sum <= 30.
- RPM values 0.5-2.5 (1 baseline). Provide concrete rationales.
Context background: ${background || "Unknown."}
Location: ${location || "Unknown."}
Vessel: ${vesselName}`;
}

function unifyPhs(resultPhs) {
  const params = (resultPhs?.parameters || []).map(p => ({
    name: p.parameter || p.name,
    rationale: p.rationale || "Not specified.",
    score: clamp(p.score, 0, 10),
    weight: p.weight
  }));
  // Force canonical ordering & weights
  const canonical = PHS_V2_CANONICAL.map(c => {
    const found = params.find(p => p.name === c.name);
    return {
      name: c.name,
      rationale: found?.rationale || "Not specified.",
      score: clamp(found?.score ?? 0, 0, 10),
      weight: c.weight
    };
  });
  return {
    parameters: canonical,
    totalWeightedScore: computePHSV2WeightedTotal(canonical)
  };
}

function unifyEsi(resultEsi) {
  const params = (resultEsi?.parameters || []).map(p => ({
    name: p.parameter || p.name,
    rationale: p.rationale || "Not specified.",
    score: clamp(p.score, 0, 10)
  }));
  const total = params.reduce((s, p) => s + p.score, 0);
  return {
    parameters: params,
    totalScore: clamp(total, 0, 30),
    maxScore: 30
  };
}

function unifyRpm(resultRpm) {
  const factors = (resultRpm?.factors || []).map(f => ({
    name: f.factor || f.name,
    rationale: f.rationale || "Not specified.",
    value: clamp(f.value, 0.5, 2.5)
  }));
  const avg = factors.length ? factors.reduce((s, f) => s + f.value, 0) / factors.length : 1;
  return {
    factors,
    finalMultiplier: parseFloat(avg.toFixed(2))
  };
}

export const repairWerps = onCall(
  {
    region: REGION,
    timeoutSeconds: 540,
    memory: "1GiB",
    invoker: "public",
    secrets: [GEMINI_API_KEY],
    cors: true
  },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin access required.");

    const dryRun = req.data?.dryRun === undefined ? true : !!req.data.dryRun;
    const pageSizeRaw = parseInt(String(req.data?.pageSize ?? "150"), 10);
    const pageSize = Math.min(Math.max(Number.isFinite(pageSizeRaw) ? pageSizeRaw : 150, 50), 450);
    const maxDocsRaw = parseInt(String(req.data?.maxDocs ?? pageSize), 10);
    const maxDocs = Math.min(Math.max(Number.isFinite(maxDocsRaw) ? maxDocsRaw : pageSize, 1), pageSize);
    const budgetRaw = parseInt(String(req.data?.timeBudgetSeconds ?? "45"), 10);
    const timeBudgetSeconds = Math.min(Math.max(Number.isFinite(budgetRaw) ? budgetRaw : 45, 10), 480);

    const singleDocId = typeof req.data?.docId === "string" ? req.data.docId.trim() : "";
    const startAfterId = typeof req.data?.startAfterId === "string" ? req.data.startAfterId.trim() : "";

    const began = Date.now();
    const deadlineMs = began + (timeBudgetSeconds * 1000 - 2000);

    let scanned = 0, updated = 0, phsFixed = 0, esiFixed = 0, rpmFixed = 0;
    let pages = 0;
    const errors = [];
    let lastProcessedId = "";
    let nextPageStartAfterId = "";

    const col = db.collection(TARGET_PATH);

    async function processDoc(docSnap) {
      const id = docSnap.id;
      const data = docSnap.data() || {};
      const vessel = data.vesselName || id;
      const background = data?.phase1?.summary?.background || "";
      const location = data?.phase1?.summary?.location || "";
      const update = {};

      const needPhs = needsPhsRepair(data);
      const needEsi = needsEsiRepair(data);
      const needRpm = needsRpmRepair(data);

      if (!(needPhs || needEsi || needRpm)) return { changed: false };

      const prompt = buildAssessmentPrompt(vessel, background, location);
      let result;
      try {
        result = await callGemini(prompt);
      } catch (e) {
        throw new Error("Model call failed: " + (e.message || e));
      }

      if (needPhs) {
        const phs = unifyPhs(result.phs_pollution_hazard);
        update["phs.parameters"] = phs.parameters;
        update["phs.totalWeightedScore"] = phs.totalWeightedScore;
        phsFixed++;
      }
      if (needEsi) {
        const esi = unifyEsi(result.esi_environmental_sensitivity);
        update["esi.parameters"] = esi.parameters;
        update["esi.totalScore"] = esi.totalScore;
        update["esi.maxScore"] = esi.maxScore;
        esiFixed++;
      }
      if (needRpm) {
        const rpm = unifyRpm(result.rpm_risk_pressure_modifiers);
        update["rpm.factors"] = rpm.factors;
        update["rpm.finalMultiplier"] = rpm.finalMultiplier;
        rpmFixed++;
      }

      if (Object.keys(update).length > 0 && !dryRun) {
        await docSnap.ref.update(update);
        updated++;
      }

      return { changed: Object.keys(update).length > 0 };
    }

    // Single document mode
    if (singleDocId) {
      const snap = await col.doc(singleDocId).get();
      if (!snap.exists) throw new HttpsError("not-found", "Document not found");
      scanned = 1;
      try {
        await processDoc(snap);
        lastProcessedId = singleDocId;
      } catch (e) {
        errors.push({ id: singleDocId, message: e.message || String(e) });
      }
      return {
        ok: errors.length === 0,
        dryRun,
        pages: 1,
        scanned,
        updated,
        phsFixed,
        esiFixed,
        rpmFixed,
        lastProcessedId,
        tookMs: Date.now() - began,
        errors
      };
    }

    // Batch mode
    let q = col.orderBy(FieldPath.documentId()).limit(pageSize);
    if (startAfterId) q = q.startAfter(startAfterId);
    const snap = await q.get();
    if (!snap.empty) {
      pages = 1;
      let processed = 0;
      for (const doc of snap.docs) {
        if (Date.now() > deadlineMs) {
          nextPageStartAfterId = lastProcessedId || startAfterId;
          break;
        }
        if (processed >= maxDocs) {
          nextPageStartAfterId = lastProcessedId || startAfterId;
          break;
        }
        scanned++;
        try {
          await processDoc(doc);
          lastProcessedId = doc.id;
        } catch (e) {
          errors.push({ id: doc.id, message: e.message || String(e) });
          lastProcessedId = doc.id;
        }
        processed++;
      }
      if (!nextPageStartAfterId && snap.docs.length === pageSize) {
        nextPageStartAfterId = lastProcessedId || snap.docs[snap.docs.length - 1].id;
      }
    }

    return {
      ok: errors.length === 0,
      dryRun,
      pages,
      scanned,
      updated,
      phsFixed,
      esiFixed,
      rpmFixed,
      lastProcessedId,
      nextPageStartAfterId: nextPageStartAfterId || undefined,
      tookMs: Date.now() - began,
      errors
    };
  }
);