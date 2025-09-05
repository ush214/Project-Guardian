// Repair incomplete WERP reports by re-running ONLY missing sections (PHS/ESI/RPM).
// Supports time-budgeted paging and continuation tokens to avoid deadline-exceeded.
//
// Params:
//   - dryRun?: boolean (default true)
//   - pageSize?: number (50..450, default 150)
//   - maxDocs?: number (1..pageSize, default pageSize)
//   - startAfterId?: string (continue from this docId; used for paging)
//   - docId?: string (if provided, repairs a single document)
//   - timeBudgetSeconds?: number (10..480, default 45)
//
// Return example:
// {
//   ok: true,
//   dryRun: false,
//   scanned: 42,
//   updated: 17,
//   phsFixed: 9,
//   esiFixed: 12,
//   rpmFixed: 11,
//   lastProcessedId: "some-doc-id",
//   nextPageStartAfterId: "some-doc-id", // include to continue; absent when done
//   tookMs: 31875,
//   errors: []
// }

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db } from "./admin.js";
import { FieldPath } from "firebase-admin/firestore";
import { GoogleGenerativeAI } from "@google/generative-ai";

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

function buildSchemas() {
  return {
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

function createGeminiClient() {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("GEMINI_API_KEY secret is not available at runtime.");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}
async function callGemini(prompt, schema /* optional */) {
  const model = createGeminiClient();
  const req = {
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: {
      responseMimeType: "application/json",
      ...(schema ? { responseSchema: schema } : {}),
    }
  };
  const res = await model.generateContent(req);
  const raw = res?.response?.text ? res.response.text() : "";
  const cand = extractJsonCandidate(raw);
  try { return JSON.parse(cand); }
  catch (e) { throw new Error("Model did not return valid JSON."); }
}

function getPhsPrompt(v, context) {
  return `You are a marine pollution expert. For "${v}", analyze PHS using context: ${context}.
Return strictly valid JSON:
{
  "parameters": [
    {"name":"Fuel Volume & Type","rationale":"...","weight":1,"score":0-10},
    {"name":"Cargo Risk","rationale":"...","weight":1,"score":0-10},
    {"name":"Residual Oils","rationale":"...","weight":1,"score":0-10},
    {"name":"Leak Likelihood","rationale":"...","weight":1,"score":0-10}
  ],
  "totalWeightedScore": 0-10
}
Rules:
- Include weights for every parameter (default to 1 when uncertain).
- totalWeightedScore is the weighted average of the scores (clamped 0..10).`;
}

function getEsiPrompt(v, loc) {
  return `You are a marine ecologist. For "${v}" near "${loc}", produce ESI.
Return strictly valid JSON:
{
  "parameters": [
    {"name":"Proximity to Sensitive Ecosystems","rationale":"...","score":0-10},
    {"name":"Biodiversity Value","rationale":"...","score":0-10},
    {"name":"Protected Areas","rationale":"...","score":0-10},
    {"name":"Socioeconomic Sensitivity","rationale":"...","score":0-10}
  ],
  "totalScore": 0-40
}
Rules:
- Return all four parameters with specific rationales (avoid 'insufficient data' unless truly unknown).
- totalScore equals the sum (0..40).`;
}

function getRpmPrompt(v, loc) {
  return `You are a climate risk scientist. For the wreck "${v}" near "${loc}", evaluate RPM (Risk Pressure Modifiers).
Return strictly valid JSON:
{
  "factors": [
    {"name":"Thermal Stress","rationale":"... (use SST anomalies, marine heatwave frequency, depth)","value":1.0-2.5},
    {"name":"Storm Exposure","rationale":"... (cyclone track density, fetch, wave climate)","value":1.0-2.5},
    {"name":"Seismic Activity","rationale":"... (USGS/GCMT seismicity, subduction proximity)","value":1.0-2.5},
    {"name":"Anthropogenic Disturbance","rationale":"... (shipping lanes, fishing pressure, coastal development)","value":1.0-2.5}
  ],
  "finalMultiplier": 1.0-2.5
}
Rules:
- Provide a concrete rationale for each factor (no 'insufficient data').
- finalMultiplier must equal the average of factor values (rounded to two decimals if necessary).`;
}

function recomputePhsTotal(phs) {
  const params = coerceParameterArray(phs?.parameters, ["score", "weight"]).map(p => ({
    ...p,
    weight: (p?.weight === undefined || p?.weight === null) ? 1 : p.weight
  }));
  const weights = params.map(p => (typeof p.weight === 'number' ? p.weight : 1)).map(w => (w > 0 ? w : 1));
  const wsum = weights.reduce((s, w) => s + w, 0) || 1;
  const wval = params.reduce((s, p, i) => s + ((clamp(toNum(p.score) ?? 0, 0, 10)) * weights[i]), 0);
  return { parameters: params, totalWeightedScore: clamp(wval / wsum, 0, 10) ?? 0 };
}

function ensureEsiFour(esi) {
  const required = ["Proximity to Sensitive Ecosystems","Biodiversity Value","Protected Areas","Socioeconomic Sensitivity"];
  const raw = coerceParameterArray(esi?.parameters, ["score"]);
  const by = {}; for (const p of raw) if (p?.name) by[p.name] = p;
  const params = required.map(name => {
    const p = by[name];
    return p ? {
      ...p,
      name,
      score: clamp(toNum(p.score) ?? 0, 0, 10),
      rationale: (typeof p?.rationale === "string" && p.rationale.trim()) ? p.rationale : "Not specified."
    } : { name, score: 0, rationale: "Insufficient data." };
  });
  const total = clamp(params.reduce((s, p) => s + (toNum(p.score) ?? 0), 0), 0, 40) ?? 0;
  return { parameters: params, totalScore: total };
}

function ensureRpm(rpm) {
  const required = ["Thermal Stress","Storm Exposure","Seismic Activity","Anthropogenic Disturbance"];
  const raw = coerceParameterArray(rpm?.factors, ["value"]);
  const by = {}; for (const f of raw) if (f?.name) by[f.name] = f;
  const factors = required.map(name => {
    const f = by[name];
    const v = clamp(toNum(f?.value) ?? 1.0, 1.0, 2.5);
    return f ? {
      ...f,
      name,
      value: v,
      rationale: (typeof f?.rationale === "string" && f.rationale.trim()) ? f.rationale : "Not specified."
    } : { name, value: 1.0, rationale: "Insufficient data." };
  });
  const avg = clamp(factors.reduce((s, f) => s + (toNum(f.value) ?? 1.0), 0) / factors.length, 1.0, 2.5) ?? 1.0;
  return { factors, finalMultiplier: avg };
}

function needsPhsRepair(data) {
  const p = data?.phs?.parameters;
  if (!Array.isArray(p) || p.length < 4) return true;
  const missingWeight = p.some(x => x?.weight === undefined || x?.weight === null);
  const badTotal = !(typeof data?.phs?.totalWeightedScore === "number");
  return missingWeight || badTotal;
}

function needsEsiRepair(data) {
  const p = data?.esi?.parameters;
  if (!Array.isArray(p) || p.length < 4) return true;
  const names = new Set(p.map(x => x?.name).filter(Boolean));
  const required = ["Proximity to Sensitive Ecosystems","Biodiversity Value","Protected Areas","Socioeconomic Sensitivity"];
  const missingAny = required.some(r => !names.has(r));
  const tooManyInsufficient = p.filter(x => /insufficient data/i.test(String(x?.rationale || ""))).length >= 2;
  const badTotal = !(typeof data?.esi?.totalScore === "number");
  return missingAny || tooManyInsufficient || badTotal;
}

function needsRpmRepair(data) {
  const f = data?.rpm?.factors;
  if (!Array.isArray(f) || f.length < 4) return true;
  const names = new Set(f.map(x => x?.name).filter(Boolean));
  const required = ["Thermal Stress","Storm Exposure","Seismic Activity","Anthropogenic Disturbance"];
  const missingAny = required.some(r => !names.has(r));
  const tooManyInsufficient = f.filter(x => /insufficient data/i.test(String(x?.rationale || ""))).length >= 2;
  const allDefaultOnes = f.every(x => (toNum(x?.value) ?? 1.0) <= 1.05);
  const badFinal = !(typeof data?.rpm?.finalMultiplier === "number") || (data?.rpm?.finalMultiplier < 1.0 || data?.rpm?.finalMultiplier > 2.5);
  return missingAny || tooManyInsufficient || allDefaultOnes || badFinal;
}

export const repairWerps = onCall(
  {
    region: REGION,
    timeoutSeconds: 540,
    memory: "1GiB",
    invoker: "public",
    secrets: [GEMINI_API_KEY],
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
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin access required.");

    const dryRun = req.data?.dryRun === undefined ? true : !!req.data.dryRun;
    const pageSizeRaw = parseInt(String(req.data?.pageSize ?? "150"), 10);
    const pageSize = Math.min(Math.max(Number.isFinite(pageSizeRaw) ? pageSizeRaw : 150, 50), 450);

    const maxDocsRaw = parseInt(String(req.data?.maxDocs ?? String(pageSize)), 10);
    const maxDocs = Math.min(Math.max(Number.isFinite(maxDocsRaw) ? maxDocsRaw : pageSize, 1), pageSize);

    const budgetRaw = parseInt(String(req.data?.timeBudgetSeconds ?? "45"), 10);
    const timeBudgetSeconds = Math.min(Math.max(Number.isFinite(budgetRaw) ? budgetRaw : 45, 10), 480);

    const singleDocId = typeof req.data?.docId === "string" ? req.data.docId.trim() : "";
    const startAfterId = typeof req.data?.startAfterId === "string" ? req.data.startAfterId.trim() : "";

    const schema = buildSchemas();

    const began = Date.now();
    const deadlineMs = began + (timeBudgetSeconds * 1000 - 2000);

    let scanned = 0, updated = 0, phsFixed = 0, esiFixed = 0, rpmFixed = 0, pages = 0;
    const errors = [];
    let lastProcessedId = "";
    let nextPageStartAfterId = "";

    const col = db.collection(TARGET_PATH);

    // Single document path
    if (singleDocId) {
      const dref = col.doc(singleDocId);
      const d = await dref.get();
      if (!d.exists) throw new HttpsError("not-found", `Doc '${singleDocId}' not found.`);
      const data = d.data() || {};
      const vesselName = data?.vesselName || singleDocId;
      const context = data?.phase1?.summary?.background || "";
      const location = data?.phase1?.summary?.location || "";

      const update = {};
      try {
        scanned += 1;

        if (needsPhsRepair(data)) {
          const phs = await callGemini(getPhsPrompt(vesselName, context), schema.phs);
          const recomputed = recomputePhsTotal(phs);
          update["phs.parameters"] = recomputed.parameters;
          update["phs.totalWeightedScore"] = recomputed.totalWeightedScore;
          phsFixed++;
        }
        if (needsEsiRepair(data)) {
          const esi = await callGemini(getEsiPrompt(vesselName, location), schema.esi);
          const ensured = ensureEsiFour(esi);
          update["esi.parameters"] = ensured.parameters;
          update["esi.totalScore"] = ensured.totalScore;
          esiFixed++;
        }
        if (needsRpmRepair(data)) {
          const rpm = await callGemini(getRpmPrompt(vesselName, location), schema.rpm);
          const ensured = ensureRpm(rpm);
          update["rpm.factors"] = ensured.factors;
          update["rpm.finalMultiplier"] = ensured.finalMultiplier;
          rpmFixed++;
        }

        if (Object.keys(update).length > 0 && !dryRun) {
          await dref.update(update);
          updated += 1;
        }
        lastProcessedId = singleDocId;
      } catch (e) {
        errors.push({ id: singleDocId, message: e?.message || String(e) });
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

    // Batch with budgeted paging and immediate commits
    let q = col.orderBy(FieldPath.documentId()).limit(pageSize);
    if (startAfterId) q = q.startAfter(startAfterId);
    const snap = await q.get();

    if (!snap.empty) {
      pages += 1;
      let processedInThisCall = 0;
      const docs = snap.docs;

      for (const doc of docs) {
        if (Date.now() > deadlineMs) { nextPageStartAfterId = lastProcessedId || startAfterId; break; }
        if (processedInThisCall >= maxDocs) { nextPageStartAfterId = lastProcessedId || startAfterId; break; }

        const id = doc.id;
        const data = doc.data() || {};
        const vesselName = data?.vesselName || id;
        const context = data?.phase1?.summary?.background || "";
        const location = data?.phase1?.summary?.location || "";

        scanned += 1;

        try {
          const doPhs = needsPhsRepair(data);
          const doEsi = needsEsiRepair(data);
          const doRpm = needsRpmRepair(data);
          if (!doPhs && !doEsi && !doRpm) {
            lastProcessedId = id;
            processedInThisCall += 1;
            continue;
          }

          const update = {};

          if (doPhs) {
            const phs = await callGemini(getPhsPrompt(vesselName, context), schema.phs);
            const recomputed = recomputePhsTotal(phs);
            update["phs.parameters"] = recomputed.parameters;
            update["phs.totalWeightedScore"] = recomputed.totalWeightedScore;
            phsFixed++;
          }
          if (doEsi) {
            const esi = await callGemini(getEsiPrompt(vesselName, location), schema.esi);
            const ensured = ensureEsiFour(esi);
            update["esi.parameters"] = ensured.parameters;
            update["esi.totalScore"] = ensured.totalScore;
            esiFixed++;
          }
          if (doRpm) {
            const rpm = await callGemini(getRpmPrompt(vesselName, location), schema.rpm);
            const ensured = ensureRpm(rpm);
            update["rpm.factors"] = ensured.factors;
            update["rpm.finalMultiplier"] = ensured.finalMultiplier;
            rpmFixed++;
          }

          if (Object.keys(update).length > 0 && !dryRun) {
            await doc.ref.update(update);
            updated += 1;
          }

          lastProcessedId = id;
          processedInThisCall += 1;
        } catch (e) {
          errors.push({ id, message: e?.message || String(e) });
          lastProcessedId = id;
          processedInThisCall += 1;
        }
      }

      if (!nextPageStartAfterId && docs.length === pageSize) {
        nextPageStartAfterId = lastProcessedId || docs[docs.length - 1]?.id || startAfterId;
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