/**
 * migrateAgeScores.js
 *
 * Recomputes WCS "Age" parameter based on metadata.buildYear (if present).
 * Rule:
 *   If buildYear <= 1950 => score=5
 *   Else band by age (years since build):
 *     >=120:5, >=90:4, >=60:3, >=30:2, <30:1
 *
 * Only updates if the recomputed score differs OR rationale missing age annotation.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";

const logger = functions.logger;
const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const COLLECTION = `artifacts/${APP_ID}/public/data/werpassessments`;

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch {
    return "user";
  }
}

function computeAgeScore(buildYear) {
  const year = new Date().getUTCFullYear();
  if (!Number.isFinite(buildYear) || buildYear <= 0) return null;
  if (buildYear <= 1950) return 5;
  const age = year - buildYear;
  if (age >= 120) return 5;
  if (age >= 90) return 4;
  if (age >= 60) return 3;
  if (age >= 30) return 2;
  return 1;
}

async function migrateBatch(limit, dryRun, startAfterId) {
  let q = db.collection(COLLECTION).orderBy("vesselName");
  if (startAfterId) {
    const anchor = await db.collection(COLLECTION).doc(startAfterId).get();
    if (anchor.exists) {
      const vesselName = anchor.get("vesselName");
      if (vesselName) q = q.startAfter(vesselName);
    }
  }
  q = q.limit(limit);

  const snap = await q.get();
  const out = {
    scanned: 0,
    updated: 0,
    wrote: 0,
    nextPageStartAfterId: ""
  };
  if (snap.empty) return out;

  const batch = db.batch();
  for (const d of snap.docs) {
    out.scanned++;
    const data = d.data();
    const buildYear = data?.metadata?.buildYear;
    if (!buildYear) continue;

    const wcs = data.wcs;
    if (!wcs || !Array.isArray(wcs.parameters)) continue;
    const ageParam = wcs.parameters.find(p => p.name === "Age");
    if (!ageParam) continue;

    const newScore = computeAgeScore(parseInt(buildYear, 10));
    if (newScore == null) continue;

    const currentScore = ageParam.score;
    const hasAnnotation = /build year/i.test(ageParam.rationale || "");
    const changed = currentScore !== newScore || !hasAnnotation;

    if (!changed) continue;

    out.updated++;
    if (!dryRun) {
      ageParam.score = newScore;
      ageParam.rationale = (ageParam.rationale || "").replace(/\s+$/, "") +
        ` (Rescored from build year ${buildYear}.)`;

      batch.set(
        d.ref,
        {
          wcs: {
            ...wcs,
            parameters: wcs.parameters,
            totalScore: wcs.parameters.reduce((s, p) => (p.name === "Age" ? s + newScore : s + (p.score || 0)), 0)
          },
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      out.wrote++;
    }
  }

  if (!dryRun && out.wrote > 0) {
    await batch.commit();
  }
  if (snap.size === limit) {
    out.nextPageStartAfterId = snap.docs[snap.docs.length - 1].id;
  }
  return out;
}

export const migrateAgeScores = onCall(
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
      const res = await migrateBatch(limit, dryRun, startAfterId);
      return { ok: true, dryRun, ...res };
    } catch (e) {
      logger.error("migrateAgeScores error:", e);
      throw new HttpsError("internal", e?.message || "Migration failed.");
    }
  }
);