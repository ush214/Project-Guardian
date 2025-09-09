import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin.js";
import { FieldPath } from "firebase-admin/firestore";
import {
  normalizeWCS,
  normalizeToPHSV2,
  normalizeESI,
  normalizeRPM
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

function deriveStatus(doc) {
  const hasPhase2 = !!(doc.phase2 && (doc.phase2.summary || Object.keys(doc.phase2).length > 0));
  return hasPhase2 ? "completed" : "initial";
}

export const normalizeWerps = onCall(
  {
    region: REGION,
    invoker: "public",
    cors: true
  },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin access required.");

    const dryRun = req.data?.dryRun === undefined ? true : !!req.data.dryRun;
    const pageSizeRaw = parseInt(String(req.data?.pageSize ?? "300"), 10);
    const pageSize = Math.min(Math.max(Number.isFinite(pageSizeRaw) ? pageSizeRaw : 300, 50), 450);

    const col = db.collection(TARGET_PATH);
    let last = null;
    let pages = 0, scanned = 0, wrote = 0, planWrites = 0;
    const errors = [];

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
          const newWcs = normalizeWCS(data.wcs || {});
          const newPhs = normalizeToPHSV2(data.phs || {});
          const newEsi = normalizeESI(data.esi || {});
          const newRpm = normalizeRPM(data.rpm || {});
          const newStatus = deriveStatus(data);

            // Only update changed sections
          const update = {};
          const changed = (field, newVal) => {
            const oldVal = data[field];
            if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
              update[field] = newVal;
            }
          };
          changed("wcs", newWcs);
          changed("phs", newPhs);
          changed("esi", newEsi);
          changed("rpm", newRpm);
          if (data.status !== newStatus) update.status = newStatus;

          if (Object.keys(update).length > 0) {
            planWrites++;
            if (!dryRun) {
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
      planWrites,
      wrote,
      errors
    };
  }
);