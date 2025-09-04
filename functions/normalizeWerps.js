// Normalize WERP docs: ensure correct status, ensure required ESI/RPM components,
// recompute totals from parameters, and clamp numeric metrics so charts render correctly.
// Usage: call normalizeWerps({ dryRun: true }) to preview, then dryRun: false to write.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin.js";
import { FieldPath } from "firebase-admin/firestore";

const REGION = "us-central1";
const TARGET_PATH = "artifacts/guardian-agent-default/public/data/werpassessments";

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

function normalizeAndScore(doc) {
  const out = { ...doc };

  // Status by Phase 2 presence
  const hasPhase2 = !!(out?.phase2 && (out.phase2.summary || Object.keys(out.phase2).length > 0));
  const desiredStatus = hasPhase2 ? "completed" : "initial";

  // WCS
  const wcsParams = coerceParameterArray(out?.wcs?.parameters, ["score"]);
  const wcsTotalFromParams = clamp(
    wcsParams.reduce((s, p) => s + clamp(toNum(p?.score) ?? 0, 0, 5), 0),
    0,
    20
  );
  const wcsTotal = clamp(toNum(out?.wcs?.totalScore), 0, 20);
  out.wcs = {
    ...(out.wcs || {}),
    parameters: wcsParams,
    totalScore: wcsTotalFromParams ?? wcsTotal ?? 0
  };

  // PHS
  const phsParams = coerceParameterArray(out?.phs?.parameters, ["score", "weight"]);
  const phsWeights = phsParams.map(p => toNum(p?.weight) ?? 1).map(w => (w > 0 ? w : 1));
  const phsWeighted = phsParams.reduce((s, p, i) => s + (clamp(toNum(p?.score) ?? 0, 0, 10) * phsWeights[i]), 0);
  const phsWeightSum = phsWeights.reduce((s, w) => s + w, 0) || 1;
  const phsAvg = clamp(phsWeighted / phsWeightSum, 0, 10);
  out.phs = {
    ...(out.phs || {}),
    parameters: phsParams,
    totalWeightedScore: phsAvg ?? clamp(toNum(out?.phs?.totalWeightedScore), 0, 10) ?? 0
  };

  // ESI: ensure 4 required components, compute total
  const requiredEsiNames = [
    "Proximity to Sensitive Ecosystems",
    "Biodiversity Value",
    "Protected Areas",
    "Socioeconomic Sensitivity"
  ];
  const esiParamsRaw = coerceParameterArray(out?.esi?.parameters, ["score"]);
  const esiByName = {};
  for (const p of esiParamsRaw) {
    if (p?.name) esiByName[p.name] = p;
  }
  const esiParams = requiredEsiNames.map(name => {
    const p = esiByName[name];
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

  // RPM: ensure factors and compute average; backfill rationales
  const requiredRpmFactors = [
    "Thermal Stress",
    "Storm Exposure",
    "Seismic Activity",
    "Anthropogenic Disturbance"
  ];
  const rpmRaw = coerceParameterArray(out?.rpm?.factors, ["value"]);
  const rpmByName = {};
  for (const f of rpmRaw) {
    if (f?.name) rpmByName[f.name] = f;
  }
  const rpmFactors = requiredRpmFactors.map(name => {
    const f = rpmByName[name];
    const v = clamp(toNum(f?.value) ?? 1.0, 1.0, 2.5);
    return f
      ? { ...f, value: v, rationale: (typeof f?.rationale === "string" && f.rationale.trim()) ? f.rationale : "Not specified." }
      : { name, value: 1.0, rationale: "Insufficient data." };
  });
  const rpmAvg = clamp(rpmFactors.reduce((s, f) => s + (toNum(f.value) ?? 1.0), 0) / rpmFactors.length, 1.0, 2.5);
  const rpmFinal = clamp(toNum(out?.rpm?.finalMultiplier), 1.0, 2.5) ?? rpmAvg;
  out.rpm = {
    ...(out.rpm || {}),
    factors: rpmFactors,
    finalMultiplier: rpmFinal
  };

  return { normalized: out, desiredStatus };
}

export const normalizeWerps = onCall(
  {
    region: REGION,
    invoker: "public",
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
    if (role !== "admin") {
      throw new HttpsError("permission-denied", "Admin access required.");
    }

    const dryRun = req.data?.dryRun === undefined ? true : !!req.data.dryRun;
    const pageSizeRaw = parseInt(String(req.data?.pageSize ?? "300"), 10);
    const pageSize = Math.min(Math.max(Number.isFinite(pageSizeRaw) ? pageSizeRaw : 300, 50), 450);

    const col = db.collection(TARGET_PATH);

    let last = null;
    let pages = 0;
    let scanned = 0;
    let willWrite = 0;
    let wrote = 0;
    let statusFixed = 0;
    let metricsFixed = 0;
    const errors = [];

    while (true) {
      let q = col.orderBy(FieldPath.documentId()).limit(pageSize);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;

      pages += 1;
      scanned += snap.size;

      let batch = db.batch();
      let inBatch = 0;

      for (const d of snap.docs) {
        const id = d.id;
        const data = d.data() || {};

        try {
          const { normalized, desiredStatus } = normalizeAndScore(data);

          const update = {};
          let changed = false;

          if ((data?.status || "initial") !== desiredStatus) {
            update.status = desiredStatus;
            changed = true;
            statusFixed += 1;
          }

          // Deep compare key sections and copy if different
          const keys = [
            "wcs.parameters", "wcs.totalScore",
            "phs.parameters", "phs.totalWeightedScore",
            "esi.parameters", "esi.totalScore",
            "rpm.factors", "rpm.finalMultiplier"
          ];

          // Helper to set nested if different
          function setIfDifferent(path, value) {
            const parts = path.split(".");
            let cur = data;
            for (let i = 0; i < parts.length - 1; i++) cur = (cur || {})[parts[i]];
            const lastKey = parts[parts.length - 1];
            const currentValue = cur ? cur[lastKey] : undefined;
            const asJson = (x) => JSON.stringify(x ?? null);
            if (asJson(currentValue) !== asJson(value)) {
              update[path] = value;
              changed = true;
            }
          }

          setIfDifferent("wcs.parameters", normalized?.wcs?.parameters || []);
          setIfDifferent("wcs.totalScore", normalized?.wcs?.totalScore ?? 0);
          setIfDifferent("phs.parameters", normalized?.phs?.parameters || []);
          setIfDifferent("phs.totalWeightedScore", normalized?.phs?.totalWeightedScore ?? 0);
          setIfDifferent("esi.parameters", normalized?.esi?.parameters || []);
          setIfDifferent("esi.totalScore", normalized?.esi?.totalScore ?? 0);
          setIfDifferent("rpm.factors", normalized?.rpm?.factors || []);
          setIfDifferent("rpm.finalMultiplier", normalized?.rpm?.finalMultiplier ?? 1.0);

          if (changed) {
            metricsFixed += 1;
            willWrite += 1;
            if (!dryRun) {
              batch.update(d.ref, update);
              inBatch += 1;
              if (inBatch >= 450) {
                await batch.commit();
                wrote += inBatch;
                batch = db.batch();
                inBatch = 0;
              }
            }
          }
        } catch (e) {
          console.error(`normalizeWerps: failed for ${id}`, e);
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

    return {
      ok: errors.length === 0,
      dryRun,
      pages,
      scanned,
      willWrite,
      wrote,
      statusFixed,
      metricsFixed,
      errors
    };
  }
);