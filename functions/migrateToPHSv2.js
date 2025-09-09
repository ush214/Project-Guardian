import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin.js";
import { FieldPath } from "firebase-admin/firestore";
import {
  normalizeToPHSV2,
  normalizeESI
} from "./schemaMapping.js";

const REGION = "us-central1";
const TARGET_PATH = "artifacts/guardian-agent-default/public/data/werpassessments";

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch {
    return "user";
  }
}

export const migrateToPHSv2 = onCall(
  {
    region: REGION,
    invoker: "public",
    cors: true,
    timeoutSeconds: 540,
    memory: "512MiB"
  },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin only.");

    const dryRun = req.data?.dryRun === undefined ? true : !!req.data.dryRun;
    const pageSize = 300;

    const col = db.collection(TARGET_PATH);
    let pages = 0, scanned = 0, upgraded = 0, wrote = 0;
    const errors = [];
    let last = null;

    while (true) {
      let q = col.orderBy(FieldPath.documentId()).limit(pageSize);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      pages++;

      for (const d of snap.docs) {
        scanned++;
        try {
          const data = d.data() || {};
          // Upgrade PHS
          const newPhs = normalizeToPHSV2(data.phs || {});
          const phsChanged = JSON.stringify(data.phs) !== JSON.stringify(newPhs);
          // Align ESI maxScore if missing
          const newEsi = normalizeESI(data.esi || {});
          const esiChanged = JSON.stringify(data.esi) !== JSON.stringify(newEsi);

          if (phsChanged || esiChanged) {
            upgraded++;
            if (!dryRun) {
              const update = {};
              if (phsChanged) update.phs = newPhs;
              if (esiChanged) update.esi = newEsi;
              await d.ref.update(update);
              wrote++;
            }
          }
        } catch (e) {
          errors.push({ id: d.id, message: e.message || String(e) });
        }
      }
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }

    return {
      ok: errors.length === 0,
      dryRun,
      pages,
      scanned,
      upgraded,
      wrote,
      errors
    };
  }
);