// Admin-only callable to repair incomplete WERP reports by re-running ONLY the missing sections.
// - Recomputes PHS (ensures weights and totalWeightedScore) when weights are missing or params < 4.
// - Recomputes ESI when fewer than 4 required components or when many are "Insufficient data".
// - Optionally backfills RPM rationales.
// - Dry-run supported.
//
// invoke examples:
//   repairWerps({ dryRun: true })                      // preview across all docs
//   repairWerps({ dryRun: false })                     // apply across all docs (paged)
//   repairWerps({ docId: "ijn-kirishima", dryRun: false }) // repair a single doc
//   repairWerps({ pageSize: 200, dryRun: true })
//
// Notes:
// - Requires admin role (system/allowlist/users/{uid}.Role == 'admin')
// - Uses the same prompts/schemas as bulkImport to ensure consistent shapes & ranges.

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
  } catch (e) {
    console.error("Failed to read Role for uid:", uid, e);
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
  catch (e) { console.error("Gemini JSON parse fail:", raw); throw new Error("Model did not return valid JSON."); }
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
- totalWeightedScore is the weighted average of scores (clamped 0..10).`;
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
- Return all four parameters with specific rationales (do not use 'insufficient data' unless truly unknown).
- totalScore equals the sum of the four scores (0..40).`;
}

function recomputePhsTotal(phs) {
  const params = coerceParameterArray(phs?.parameters, ["score", "weight"]);
  const weights = params.map(p => toNum(p?.weight) ?? 1).map(w => (w > 0 ? w : 1));
  const wsum = weights.reduce((s, w) => s + w, 0) || 1;
  const wval = params.reduce((s, p, i) => s + (clamp(toNum(p?.score) ?? 0, 0, 10) * weights[i]), 0);
  return {
    parameters: params.map((p, i) => ({ ...p, weight: weights[i] })),
    totalWeightedScore: clamp(wval / wsum, 0, 10) ?? 0
  };
}

function ensureEsiFour(esi) {
  const required = [
    "Proximity to Sensitive Ecosystems",
    "Biodiversity Value",
    "Protected Areas",
    "Socioeconomic Sensitivity"
  ];
  const raw = coerceParameterArray(esi?.parameters, ["score"]);
  const byName = {};
  for (const p of raw) if (p?.name) byName[p.name] = p;
  const params = required.map(name => {
    const p = byName[name];
    return p ? {
      ...p,
      name,
      score: clamp(toNum(p.score) ?? 0, 0, 10),
      rationale: (typeof p.rationale === "string" && p.rationale.trim()) ? p.rationale : "Not specified."
    } : { name, score: 0, rationale: "Insufficient data." };
  });
  const total = clamp(params.reduce((s, p) => s + (toNum(p.score) ?? 0), 0), 0, 40) ?? 0;
  return { parameters: params, totalScore: total };
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
  const required = [
    "Proximity to Sensitive Ecosystems",
    "Biodiversity Value",
    "Protected Areas",
    "Socioeconomic Sensitivity"
  ];
  const missingAny = required.some(r => !names.has(r));
  const tooManyInsufficient = p.filter(x => /insufficient data/i.test(String(x?.rationale || ""))).length >= 2;
  const badTotal = !(typeof data?.esi?.totalScore === "number");
  return missingAny || tooManyInsufficient || badTotal;
}

export const repairWerps = onCall(
  {
    region: REGION,
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
    const pageSizeRaw = parseInt(String(req.data?.pageSize ?? "200"), 10);
    const pageSize = Math.min(Math.max(Number.isFinite(pageSizeRaw) ? pageSizeRaw : 200, 50), 450);
    const singleDocId = typeof req.data?.docId === "string" ? req.data.docId.trim() : "";

    const schema = buildSchemas();

    let scanned = 0;
    let willWrite = 0;
    let wrote = 0;
    let phsFixed = 0;
    let esiFixed = 0;
    const errors = [];
    let pages = 0;

    const col = db.collection(TARGET_PATH);

    if (singleDocId) {
      const dref = col.doc(singleDocId);
      const d = await dref.get();
      if (!d.exists) throw new HttpsError("not-found", `Doc ${singleDocId} not found.`);
      const data = d.data() || {};
      const vesselName = data?.vesselName || singleDocId;
      const context = data?.phase1?.summary?.background || "";
      const location = data?.phase1?.summary?.location || "";

      const update = {};

      try {
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
      } catch (e) {
        errors.push({ id: singleDocId, message: e?.message || String(e) });
      }

      if (Object.keys(update).length > 0) {
        willWrite++;
        if (!dryRun) {
          await dref.update(update);
          wrote++;
        }
      }

      return { ok: errors.length === 0, dryRun, pages: 1, scanned: 1, willWrite, wrote, phsFixed, esiFixed, errors };
    }

    let last = null;
    while (true) {
      let q = col.orderBy(FieldPath.documentId()).limit(pageSize);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;

      pages++;
      scanned += snap.size;

      let batch = db.batch();
      let inBatch = 0;

      for (const doc of snap.docs) {
        const id = doc.id;
        const data = doc.data() || {};
        const vesselName = data?.vesselName || id;
        const context = data?.phase1?.summary?.background || "";
        const location = data?.phase1?.summary?.location || "";

        try {
          const needsPhs = needsPhsRepair(data);
          const needsEsi = needsEsiRepair(data);
          if (!needsPhs && !needsEsi) continue;

          const update = {};

          if (needsPhs) {
            const phs = await callGemini(getPhsPrompt(vesselName, context), schema.phs);
            const recomputed = recomputePhsTotal(phs);
            update["phs.parameters"] = recomputed.parameters;
            update["phs.totalWeightedScore"] = recomputed.totalWeightedScore;
            phsFixed++;
          }
          if (needsEsi) {
            const esi = await callGemini(getEsiPrompt(vesselName, location), schema.esi);
            const ensured = ensureEsiFour(esi);
            update["esi.parameters"] = ensured.parameters;
            update["esi.totalScore"] = ensured.totalScore;
            esiFixed++;
          }

          willWrite++;
          if (!dryRun) {
            batch.update(doc.ref, update);
            inBatch++;
            if (inBatch >= 450) {
              await batch.commit();
              wrote += inBatch;
              batch = db.batch();
              inBatch = 0;
            }
          }
        } catch (e) {
          errors.push({ id, message: e?.message || String(e) });
        }
      }

      if (!dryRun && inBatch > 0) {
        await batch.commit();
        wrote += inBatch;
      }

      last = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }

    return { ok: errors.length === 0, dryRun, pages, scanned, willWrite, wrote, phsFixed, esiFixed, errors };
  }
);