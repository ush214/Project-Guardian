import * as functions from 'firebase-functions';
import admin from 'firebase-admin';
import { Storage } from '@google-cloud/storage';

try {
  // Prevent re-initialization when testing or in hot-reload
  admin.apps.length === 0 && admin.initializeApp();
} catch (_) {
  // ignore
}

const db = admin.firestore();
const storage = new Storage();

const APP_ID = process.env.APP_ID || 'guardian';
const RAW_BUCKET = process.env.RAW_BUCKET || '';

/**
 * Collections to read wreck docs from.
 * These are treated as collection paths (not document paths).
 */
export const READ_COLLECTIONS = [
  'artifacts/guardian/public/data/werpassessments',
  'artifacts/guardian-agent-default/public/data/werpassessments',
];

/**
 * Build a UTC path like manifests/YYYY/MM/DD/HH.json
 */
function manifestObjectPath(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  return `manifests/${y}/${m}/${d}/${h}.json`;
}

async function listWreckDocs() {
  const out: Array<{ id: string; path: string }> = [];
  for (const colPath of READ_COLLECTIONS) {
    const colRef = db.collection(colPath);
    const docRefs = await colRef.listDocuments();
    if (!docRefs || docRefs.length === 0) continue;
    const snapshots = await db.getAll(...docRefs);
    for (const snap of snapshots) {
      if (!snap.exists) continue;
      out.push({ id: snap.id, path: snap.ref.path });
    }
  }
  return out;
}

/**
 * Writes a minimal manifest of wreck doc IDs and paths to GCS hourly.
 * If RAW_BUCKET isn't configured or the bucket doesn't exist, logs and returns.
 */
export const monitoringMasterHourly = functions.pubsub
  .schedule('every 60 minutes')
  .timeZone('UTC')
  .onRun(async (_context) => {
    const started = Date.now();
    const manifest = await listWreckDocs();

    if (!RAW_BUCKET) {
      console.log('[monitoringMasterHourly] RAW_BUCKET not set. Skipping write.', {
        count: manifest.length,
      });
      return null;
    }

    const objectPath = manifestObjectPath(new Date());
    try {
      const bucket = storage.bucket(RAW_BUCKET);
      await bucket.file(objectPath).save(
        JSON.stringify(
          {
            appId: APP_ID,
            generatedAtMs: Date.now(),
            count: manifest.length,
            items: manifest,
          },
          null,
          2
        ),
        {
          contentType: 'application/json',
          resumable: false,
        }
      );
      console.log(`[monitoringMasterHourly] Wrote manifest to gs://${RAW_BUCKET}/${objectPath}`, {
        count: manifest.length,
        elapsedMs: Date.now() - started,
      });
    } catch (err: any) {
      console.warn(
        `[monitoringMasterHourly] Could not write to gs://${RAW_BUCKET}/${objectPath}. This can be configured later.`,
        { error: err?.message }
      );
    }

    return null;
  });

/**
 * Firestore trigger:
 * When a monitoring event is created/updated under:
 * {collectionId}/{docId}/monitoring/{type}/events/{eventId}
 * If exceeded === true, append an alert to the wreck doc (root) and set needsReassessment=true.
 * Idempotent: do not duplicate an alert for the same eventId+type.
 */
export const onMonitoringEventWrite = functions.firestore
  .document('{collectionId}/{docId}/monitoring/{type}/events/{eventId}')
  .onWrite(async (change, context) => {
    const after = change.after;
    if (!after.exists) return;

    const data = after.data() || {};
    const exceeded = !!data.exceeded;
    if (!exceeded) return;

    const { collectionId, docId, type, eventId } = context.params as {
      collectionId: string;
      docId: string;
      type: string;
      eventId: string;
    };

    const wreckRef = db.doc(`${collectionId}/${docId}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(wreckRef);
      if (!snap.exists) return;

      const wreck = snap.data() || {};
      const alerts: any[] = Array.isArray(wreck.alerts) ? [...wreck.alerts] : [];

      const already = alerts.find(
        (a) => a?.sourceType === type && (a?.eventId === eventId || a?.event_id === eventId)
      );
      if (already) {
        // Update timestamp if you want, but avoid duplicates
        tx.update(wreckRef, {
          alertsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          needsReassessment: true,
        });
        return;
      }

      const alert = {
        sourceType: type,
        eventId,
        message: data.message || `Monitoring event exceeded for ${type}`,
        exceeded: true,
        acknowledged: false,
        timeMs: typeof data.timeMs === 'number' ? data.timeMs : Date.now(),
        createdAtMs: Date.now(),
        createdBy: 'monitoring-trigger',
      };

      alerts.unshift(alert);

      tx.update(wreckRef, {
        alerts,
        alertsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        needsReassessment: true,
      });
    });
  });