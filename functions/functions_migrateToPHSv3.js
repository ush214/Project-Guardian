/**
 * migrateToPHSv3.js
 *
 * Converts PHS v2 (4 parameters including "Vessel Integrity") to PHS v3 (3 parameters, weights 0.50/0.30/0.20).
 * Adds phs.version=3 and migration metadata.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";

const logger = functions.logger;
const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const COLLECTION = `artifacts/${APP_ID}/public/data/werpassessments`;

const TARGETS = ["Fuel Volume & Type", "Ordnance", "Hazardous Materials"];
const NEW_WEIGHTS = {
  "Fuel Volume & Type": 0.50,
  "Ordnance": 0.30,
  "Hazardous Materials": 0.20
};

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch {
    return "user";
  }
}

function recalcTotal(params) {
  return params.reduce((s, p) => s + (p.score * p.weight), 0);
}

async function migrateBatch(limit, dryRun, startAfterId) {
  let q = db.collection(COLLECTION).orderBy("vesselName");
  if (startAfterId) {
    // We page by doc id fallback: get snapshot to anchor startAfter
    const ref = db.collection(COLLECTION).doc(startAfterId);
    const snap = await ref.get();
    if (snap.exists) {
      const vesselName = snap.get("vesselName");
      if (vesselName) {
        q = q.startAfter(vesselName);
      }
    }
  }
  q = q.limit(limit);

  const snap = await q.get();
  const res = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    wrote: 0,
    nextPageStartAfterId: ""
  };
  if (snap.empty) return res;

  const batch = db.batch();
  for (const d of snap.docs) {
    res.scanned++;
    const data = d.data();
    const phs = data.phs || data.phs_pollution_hazard;
    if (!phs || !Array.isArray(phs.parameters)) {
      res.skipped++;
      continue;
    }
    const hasVesselIntegrity = phs.parameters.some(p => (p.name || p.parameter) === "Vessel Integrity");
    if (!hasVesselIntegrity) {
      res.skipped++;
      continue;
    }
    // Build new subset
    const newParams = [];
    for (const p of phs.parameters) {
      const n = p.name || p.parameter;
      if (TARGETS.includes(n)) {
        newParams.push({
          name: n,
          rationale: p.rationale,
          score: typeof p.score === "number" ? p.score : 0,
          weight: NEW_WEIGHTS[n]
        });
      }
    }
    if (newParams.length !== 3) {
      res.skipped++;
      continue;
    }
    const totalWeightedScore = recalcTotal(newParams);
    res.migrated++;
    if (!dryRun) {
      batch.set(
        d.ref,
        {
          phs: {
            version: 3,
            parameters: newParams,
            totalWeightedScore: Math.min(10, Math.max(0, totalWeightedScore)),
            migration: {
              fromVersion: phs.version || 2,
              toVersion: 3,
              migratedAt: FieldValue.serverTimestamp()
            }
          },
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      res.wrote++;
    }
  }

  if (!dryRun && res.wrote > 0) {
    await batch.commit();
  }
  if (snap.size === limit) {
    const last = snap.docs[snap.docs.length - 1];
    res.nextPageStartAfterId = last.id;
  }
  return res;
}

export const migrateToPHSv3 = onCall(
  { region: REGION, timeoutSeconds: 540, memory: "1GiB" },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin role required.");

    const dryRun = !!req.data?.dryRun;
    const limit = Math.min(Math.max(parseInt(req.data?.limit ?? "300", 10), 10), 450);
    const startAfterId = typeof req.data?.startAfterId === "string" ? req.data.startAfterId.trim() : "";

    try {
      const out = await migrateBatch(limit, dryRun, startAfterId);
      return { ok: true, dryRun, ...out };
    } catch (e) {
      logger.error("migrateToPHSv3 error:", e);
      throw new HttpsError("internal", e?.message || "Migration failed.");
    }
  }
);