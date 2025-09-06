/**
 * backfillRationales.js
 *
 * Adds/improves missing or placeholder rationales across WCS, PHS, ESI, RPM.
 * - Placeholder detection: "", "Not specified.", "Insufficient data.", "Unknown."
 * - Does NOT change scores or weights.
 * - Paginates by ordered vesselName.
 *
 * Approach:
 *  1. Scan a page (limit = pageSize).
 *  2. Collect all items needing improvements (capped to MAX_ITEMS_PER_MODEL to keep prompt size sane).
 *  3. Single model call generates rationales in structured JSON.
 *  4. Merge results back & write batch.
 *
 * Supports:
 *   dryRun (boolean)
 *   pageSize (default 100)
 *   startAfterId (pagination anchor)
 *   timeBudgetSeconds (optional early exit)
 *
 * Return fields:
 *   scanned, updated, wrote, placeholdersFound, nextPageStartAfterId, modelItemsRequested
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

const PLACEHOLDERS = new Set(["", "not specified.", "insufficient data.", "unknown."]);
const MAX_ITEMS_PER_MODEL = 70; // conservative to keep prompt compact
const DEFAULT_PAGE_SIZE = 100;

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
  const t = r.trim().toLowerCase();
  return PLACEHOLDERS.has(t);
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
  if (!key) throw new Error("Missing GEMINI_API_KEY secret.");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

/**
 * Build a minimal instruction to fill only missing/placeholder rationales.
 * Format requests as array to ease mapping back.
 */
function buildPrompt(items) {
  const req = items.map(it => ({
    docId: it.docId,
    section: it.section,
    key: it.key,
    currentScoreOrValue: it.scoreOrValue
  }));
  return `You are improving missing rationales for vessel WERP assessments.
Return JSON ONLY with structure:
{
  "updates":[
    {"docId":"...","section":"wcs|phs|esi|rpm","key":"(parameter-or-factor-name)","rationale":"Improved concise rationale..."}
  ]
}

Guidelines:
- Provide factual, concise rationales (1–3 sentences) using generic OSINT knowledge about shipwreck aging, fuel/ordnance persistence, environmental sensitivity, or pressure factors.
- DO NOT invent precise quantitative data (capacities, tonnages) unless widely typical; prefer qualitative phrasing.
- For RPM factors, explain risk driver succinctly (e.g., 'Regional seismicity elevates structural disturbance probability').
- Avoid placeholders like 'Not specified.' or 'Insufficient data.'

Requests:
${JSON.stringify(req, null, 2)}`;
}

async function runModel(items) {
  if (items.length === 0) return { updates: [] };
  const prompt = buildPrompt(items);
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
    throw new Error("Model JSON parse failed: " + (e.message || e));
  }
  if (!parsed || !Array.isArray(parsed.updates)) {
    throw new Error("Model response missing updates array.");
  }
  return parsed;
}

function collectTargets(docId, data) {
  const out = [];
  // WCS
  if (data?.wcs?.parameters) {
    for (const p of data.wcs.parameters) {
      if (isPlaceholder(p.rationale)) {
        out.push({
          docId,
          section: "wcs",
          key: p.name,
          scoreOrValue: p.score
        });
      }
    }
  }
  // PHS
  if (data?.phs?.parameters) {
    for (const p of data.phs.parameters) {
      if (isPlaceholder(p.rationale)) {
        out.push({
          docId,
          section: "phs",
          key: p.name,
          scoreOrValue: p.score
        });
      }
    }
  }
  // ESI
  if (data?.esi?.parameters) {
    for (const p of data.esi.parameters) {
      if (isPlaceholder(p.rationale)) {
        out.push({
          docId,
          section: "esi",
          key: p.name,
          scoreOrValue: p.score
        });
      }
    }
  }
  // RPM
  if (data?.rpm?.factors) {
    for (const f of data.rpm.factors) {
      if (isPlaceholder(f.rationale)) {
        out.push({
          docId,
          section: "rpm",
          key: f.name,
          scoreOrValue: f.value
        });
      }
    }
  }
  return out;
}

async function processPage({ pageSize, startAfterId, dryRun, timeBudgetSeconds }) {
  const startTime = Date.now();
  const deadline = timeBudgetSeconds
    ? startTime + Math.max(5, Math.min(timeBudgetSeconds, 500)) * 1000
    : null;

  let q = db.collection(COLLECTION).orderBy("vesselName");
  if (startAfterId) {
    const anchor = await db.collection(COLLECTION).doc(startAfterId).get();
    if (anchor.exists) {
      const vesselName = anchor.get("vesselName");
      if (vesselName) {
        q = q.startAfter(vesselName);
      }
    }
  }
  q = q.limit(pageSize);

  const snap = await q.get();
  const result = {
    scanned: 0,
    updated: 0,
    wrote: 0,
    placeholdersFound: 0,
    modelItemsRequested: 0,
    nextPageStartAfterId: ""
  };
  if (snap.empty) return result;

  const allTargets = [];
  for (const docSnap of snap.docs) {
    if (deadline && Date.now() > deadline - 500) {
      // time nearly exhausted; break early
      break;
    }
    result.scanned++;
    const data = docSnap.data();
    const docTargets = collectTargets(docSnap.id, data);
    if (docTargets.length) {
      result.placeholdersFound += docTargets.length;
      allTargets.push(...docTargets);
    }
  }

  // Slice to max model capacity
  const modelTargets = allTargets.slice(0, MAX_ITEMS_PER_MODEL);
  result.modelItemsRequested = modelTargets.length;

  let updates = [];
  if (modelTargets.length > 0) {
    try {
      const modelRes = await runModel(modelTargets);
      updates = modelRes.updates || [];
    } catch (e) {
      logger.error("Model call failed:", e);
      // fail gracefully: no updates this page
    }
  }

  if (updates.length && !dryRun) {
    // Group updates by docId
    const map = new Map();
    for (const u of updates) {
      if (!u.docId || !u.section || !u.key || !u.rationale) continue;
      if (!map.has(u.docId)) map.set(u.docId, []);
      map.get(u.docId).push(u);
    }

    const batch = db.batch();
    for (const [docId, list] of map.entries()) {
      const ref = db.collection(COLLECTION).doc(docId);
      const snapDoc = await ref.get();
      if (!snapDoc.exists) continue;
      const data = snapDoc.data();

      let mutated = false;

      function apply(section, key, rationale) {
        if (section === "wcs" && data?.wcs?.parameters) {
          const item = data.wcs.parameters.find(p => p.name === key);
          if (item && isPlaceholder(item.rationale)) {
            item.rationale = rationale;
            mutated = true;
          }
        } else if (section === "phs" && data?.phs?.parameters) {
          const item = data.phs.parameters.find(p => p.name === key);
            if (item && isPlaceholder(item.rationale)) {
            item.rationale = rationale;
            mutated = true;
          }
        } else if (section === "esi" && data?.esi?.parameters) {
          const item = data.esi.parameters.find(p => p.name === key);
          if (item && isPlaceholder(item.rationale)) {
            item.rationale = rationale;
            mutated = true;
          }
        } else if (section === "rpm" && data?.rpm?.factors) {
          const item = data.rpm.factors.find(f => f.name === key);
          if (item && isPlaceholder(item.rationale)) {
            item.rationale = rationale;
            mutated = true;
          }
        }
      }

      for (const u of list) {
        apply(u.section, u.key, u.rationale);
      }

      if (mutated) {
        result.updated++;
        batch.set(
          ref,
          {
            wcs: data.wcs,
            phs: data.phs,
            esi: data.esi,
            rpm: data.rpm,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      }
    }

    if (result.updated > 0) {
      await batch.commit();
      result.wrote = result.updated;
    }
  }

  // Paging token if room/time left and we processed full page size
  if (snap.size === pageSize) {
    const last = snap.docs[snap.docs.length - 1];
    result.nextPageStartAfterId = last.id;
  }
  return result;
}

export const backfillRationales = onCall(
  { region: REGION, timeoutSeconds: 540, memory: "1GiB", secrets: [GEMINI_API_KEY] },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin role required.");

    const dryRun = !!req.data?.dryRun;
    const pageSize = Math.min(Math.max(parseInt(req.data?.pageSize ?? DEFAULT_PAGE_SIZE, 10), 10), 400);
    const startAfterId = typeof req.data?.startAfterId === "string" ? req.data.startAfterId.trim() : "";
    const timeBudgetSeconds = req.data?.timeBudgetSeconds ? parseInt(req.data.timeBudgetSeconds, 10) : undefined;

    try {
      const res = await processPage({ pageSize, startAfterId, dryRun, timeBudgetSeconds });
      return { ok: true, dryRun, ...res };
    } catch (e) {
      logger.error("backfillRationales error:", e);
      throw new HttpsError("internal", e?.message || "Backfill failed.");
    }
  }
);