import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db, storage } from "../admin.js";
const READ_COLLECTIONS = [
    "artifacts/guardian/public/data/werpassessments",
    "artifacts/guardian-agent-default/public/data/werpassessments"
];
/**
 * monitoringMasterHourly - Pub/Sub function triggered every 60 minutes
 * Reads wreck docs from collections, builds manifest and writes to GCS bucket
 */
export const monitoringMasterHourly = onSchedule({
    schedule: "every 60 minutes",
    timeZone: "Etc/UTC",
    memory: "512MiB",
    timeoutSeconds: 300
}, async (event) => {
    try {
        const rawBucket = process.env.RAW_BUCKET;
        if (!rawBucket) {
            logger.warn("RAW_BUCKET environment variable not set. Skipping manifest generation.");
            return;
        }
        // Check if bucket exists
        let bucket;
        try {
            bucket = storage.bucket(rawBucket);
            await bucket.getMetadata();
        }
        catch (error) {
            logger.warn(`Bucket ${rawBucket} not found or inaccessible. Skipping manifest generation.`, error);
            return;
        }
        // Build manifest
        const manifest = [];
        for (const collectionPath of READ_COLLECTIONS) {
            try {
                const snapshot = await db.collection(collectionPath).get();
                snapshot.forEach((doc) => {
                    manifest.push({
                        id: doc.id,
                        path: `${collectionPath}/${doc.id}`
                    });
                });
            }
            catch (error) {
                logger.error(`Error reading collection ${collectionPath}:`, error);
            }
        }
        // Generate timestamp path
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        const hour = String(now.getUTCHours()).padStart(2, '0');
        const manifestPath = `manifests/${year}/${month}/${day}/${hour}.json`;
        // Write to GCS
        const file = bucket.file(manifestPath);
        await file.save(JSON.stringify(manifest, null, 2), {
            contentType: 'application/json',
            resumable: false
        });
        logger.info(`Generated manifest with ${manifest.length} entries at ${manifestPath}`);
    }
    catch (error) {
        logger.error("Error in monitoringMasterHourly:", error);
    }
});
/**
 * onMonitoringEventWrite - Firestore trigger for monitoring events
 * Triggers on any document write under {collectionId}/{docId}/monitoring/{type}/{eventId}
 */
export const onMonitoringEventWrite = onDocumentWritten({
    document: "{collectionId}/{docId}/monitoring/{type}/{eventId}",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120
}, async (event) => {
    try {
        const { collectionId, docId, type, eventId } = event.params;
        const afterData = event.data?.after?.data();
        if (!afterData || afterData.exceeded !== true) {
            // Only process events that have exceeded thresholds
            return;
        }
        // Get the wreck document to update
        const wreckRef = db.collection(collectionId).doc(docId);
        const wreckSnap = await wreckRef.get();
        if (!wreckSnap.exists) {
            logger.warn(`Wreck document not found: ${collectionId}/${docId}`);
            return;
        }
        const wreckData = wreckSnap.data() || {};
        const existingAlerts = Array.isArray(wreckData.alerts) ? wreckData.alerts : [];
        // Check for idempotency - don't duplicate alerts for the same eventId
        const alertExists = existingAlerts.some((alert) => alert.eventId === eventId && alert.type === type);
        if (alertExists) {
            logger.info(`Alert already exists for eventId ${eventId}, skipping duplicate`);
            return;
        }
        // Create new alert object
        const newAlert = {
            eventId,
            type,
            message: afterData.message || `${type} event detected`,
            threshold: afterData.threshold,
            value: afterData.pgaG || afterData.windSpeedKmh || afterData.confidenceScore,
            distanceKm: afterData.distanceKm,
            eventTimeMs: afterData.timeMs || afterData.createdAtMs,
            acknowledged: false,
            createdAt: FieldValue.serverTimestamp()
        };
        // Update wreck document with new alert
        const updatedAlerts = [...existingAlerts, newAlert];
        await wreckRef.update({
            alerts: updatedAlerts,
            needsReassessment: true,
            alertsUpdatedAt: FieldValue.serverTimestamp()
        });
        logger.info(`Added alert for ${type} event ${eventId} to wreck ${docId}`);
    }
    catch (error) {
        logger.error("Error in onMonitoringEventWrite:", error);
    }
});
//# sourceMappingURL=monitoring.js.map