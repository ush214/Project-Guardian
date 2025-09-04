// One-time migration: copy docs from artifacts/guardian/... to artifacts/guardian-agent-default/...
// Only accessible to signed-in admins. Supports dry-run and pagination.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin.js";
import { FieldPath } from "firebase-admin/firestore";

const REGION = "us-central1";
const SOURCE_PATH = "artifacts/guardian/public/data/werpassessments";
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

export const migrateWerps = onCall(
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

    const srcCol = db.collection(SOURCE_PATH);
    const tgtCol = db.collection(TARGET_PATH);

    let last = null;
    let totalRead = 0;
    let copied = 0;
    let skippedExisting = 0;
    let pages = 0;
    const errors = [];

    while (true) {
      let q = srcCol.orderBy(FieldPath.documentId()).limit(pageSize);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;

      pages += 1;
      totalRead += snap.size;

      // Prepare target refs and fetch existing in bulk
      const tgtRefs = snap.docs.map(d => tgtCol.doc(d.id));
      const existingSnaps = await db.getAll(...tgtRefs);

      // Prepare batch
      let batch = db.batch();
      let writesInBatch = 0;

      for (let i = 0; i < snap.size; i++) {
        const srcDoc = snap.docs[i];
        const tgtDocSnap = existingSnaps[i];
        const tgtRef = tgtRefs[i];

        if (tgtDocSnap.exists) {
          skippedExisting += 1;
          continue;
        }

        const data = srcDoc.data();
        try {
          if (!dryRun) {
            batch.set(tgtRef, data, { merge: false });
            writesInBatch += 1;

            // Commit in chunks to respect the 500 ops limit
            if (writesInBatch >= 450) {
              await batch.commit();
              batch = db.batch();
              writesInBatch = 0;
            }
          }
          copied += 1;
        } catch (e) {
          console.error(`Failed to queue copy for ${srcDoc.id}:`, e);
          errors.push({ id: srcDoc.id, message: e?.message || String(e) });
        }
      }

      if (!dryRun && writesInBatch > 0) {
        await batch.commit();
      }

      last = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }

    return {
      ok: errors.length === 0,
      dryRun,
      pages,
      pageSize,
      totalRead,
      copied,
      skippedExisting,
      errors
    };
  }
);