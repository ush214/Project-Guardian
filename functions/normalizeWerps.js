// Normalize WERP docs: ensure correct status and clamp numeric metrics.
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
  if (!Array.isArray(arr)) return arr;
  return arr.map(item => {
    const out = { ...item };
    for (const k of numericKeys) {
      const v = toNum(out[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  });
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
    let metricsClamped = 0;
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

        // Determine desired status
        const hasPhase2 = !!(data?.phase2 && (data.phase2.summary || Object.keys(data.phase2).length > 0));
        const desiredStatus = hasPhase2 ? "completed" : "initial";
        const currentStatus = data?.status || "initial";

        // Coerce numeric arrays to numbers
        const wcsParams = coerceParameterArray(data?.wcs?.parameters, ["score"]);
        const phsParams = coerceParameterArray(data?.phs?.parameters, ["score", "weight"]);
        const esiParams = coerceParameterArray(data?.esi?.parameters, ["score"]);
        const rpmFactors = coerceParameterArray(data?.rpm?.factors, ["value"]);

        // Clamp top-level numeric metrics
        const newWcsTotal = clamp(toNum(data?.wcs?.totalScore), 0, 20);
        const newPhsTotal = clamp(toNum(data?.phs?.totalWeightedScore), 0, 10);
        const newEsiTotal = clamp(toNum(data?.esi?.totalScore), 0, 40);
        const newRpmMult = clamp(toNum(data?.rpm?.finalMultiplier), 1.0, 2.5);

        let update = {};

        if (currentStatus !== desiredStatus) {
          update.status = desiredStatus;
          statusFixed += 1;
        }

        if (wcsParams) update["wcs.parameters"] = wcsParams;
        if (phsParams) update["phs.parameters"] = phsParams;
        if (esiParams) update["esi.parameters"] = esiParams;
        if (rpmFactors) update["rpm.factors"] = rpmFactors;

        let clampedAny = false;
        if (newWcsTotal !== undefined && newWcsTotal !== data?.wcs?.totalScore) {
          update["wcs.totalScore"] = newWcsTotal; clampedAny = true;
        }
        if (newPhsTotal !== undefined && newPhsTotal !== data?.phs?.totalWeightedScore) {
          update["phs.totalWeightedScore"] = newPhsTotal; clampedAny = true;
        }
        if (newEsiTotal !== undefined && newEsiTotal !== data?.esi?.totalScore) {
          update["esi.totalScore"] = newEsiTotal; clampedAny = true;
        }
        if (newRpmMult !== undefined && newRpmMult !== data?.rpm?.finalMultiplier) {
          update["rpm.finalMultiplier"] = newRpmMult; clampedAny = true;
        }
        if (clampedAny) metricsClamped += 1;

        if (Object.keys(update).length > 0) {
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
      metricsClamped,
      errors
    };
  }
);