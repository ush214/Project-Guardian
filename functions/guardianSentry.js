// Scheduled sentinel to surface actionable alerts on assessments.
// - Adds a "stale assessment" alert to initial (non-completed) reports older than STALE_DAYS.
// - Runs periodically and is idempotent via sentryFlags.
//
// Notes:
// - Alerts are appended to the `alerts` array used by the UI (unacknowledged alerts show up).
// - Adjust STALE_DAYS, BATCH_LIMIT, and schedule to fit your needs.

import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";

const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const COLLECTION_PATH = `artifacts/${APP_ID}/public/data/werpassessments`;

// Tunables
const STALE_DAYS = 30;     // How old an initial assessment must be to trigger alert
const BATCH_LIMIT = 50;    // Max docs to process per run

export const guardianSentry = onSchedule(
  { region: REGION, schedule: "every 6 hours", timeZone: "Etc/UTC" },
  async () => {
    const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

    // Query older docs; we’ll filter by status in code to avoid composite index requirements.
    const col = db.collection(COLLECTION_PATH);
    const snap = await col.where("createdAt", "<", cutoff).orderBy("createdAt", "asc").limit(BATCH_LIMIT).get();

    let processed = 0;
    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      const status = data?.status || "initial";
      const flags = data?.sentryFlags || {};

      // Only alert for non-completed assessments
      if (status === "completed") continue;

      // Skip if already alerted once
      if (flags.staleAlertCreated) continue;

      const alert = {
        type: "stale_assessment",
        details: `Initial assessment is older than ${STALE_DAYS} days. Consider Phase 2 in-situ survey or re-running the analysis.`,
        timestamp: FieldValue.serverTimestamp(),
        acknowledged: false
      };

      try {
        await docSnap.ref.update({
          alerts: FieldValue.arrayUnion(alert),
          "sentryFlags.staleAlertCreated": true,
          "sentryFlags.updatedAt": FieldValue.serverTimestamp()
        });
        processed++;
      } catch (e) {
        console.error(`guardianSentry: failed to update ${docSnap.id}`, e);
      }
    }

    console.log(`guardianSentry: processed ${processed}/${snap.size} old assessments.`);
  }
);