import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import admin from "firebase-admin";
// Initialize admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
const storage = admin.storage();
/**
 * Cloud Scheduler trigger that runs every 60 minutes
 * Writes a minimal manifest JSON to GCS bucket listing wreck doc paths+ids
 * from collections: artifacts/guardian/public/data/werpassessments and
 * artifacts/guardian-agent-default/public/data/werpassessments
 */
export const monitoringMasterHourly = onSchedule({
    schedule: "0 * * * *", // Every hour at minute 0
    timeZone: "UTC",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 300
}, async (event) => {
    const bucketName = process.env.RAW_BUCKET;
    if (!bucketName) {
        console.log("RAW_BUCKET environment variable not set, skipping monitoring manifest generation");
        return;
    }
    try {
        const bucket = storage.bucket(bucketName);
        // Check if bucket exists
        const [exists] = await bucket.exists();
        if (!exists) {
            console.log(`Bucket ${bucketName} does not exist, skipping monitoring manifest generation`);
            return;
        }
        const collections = [
            "artifacts/guardian/public/data/werpassessments",
            "artifacts/guardian-agent-default/public/data/werpassessments"
        ];
        const manifest = {
            generatedAt: new Date().toISOString(),
            timestamp: Date.now(),
            collections: []
        };
        for (const collectionPath of collections) {
            try {
                const snapshot = await db.collection(collectionPath).get();
                const docs = snapshot.docs.map((doc) => ({
                    id: doc.id,
                    path: `${collectionPath}/${doc.id}`,
                    lastModified: doc.updateTime?.toDate()?.toISOString() || null
                }));
                manifest.collections.push({
                    path: collectionPath,
                    count: docs.length,
                    docs
                });
                console.log(`Found ${docs.length} documents in ${collectionPath}`);
            }
            catch (error) {
                console.error(`Error processing collection ${collectionPath}:`, error);
                manifest.collections.push({
                    path: collectionPath,
                    count: 0,
                    docs: [],
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }
        // Write manifest to GCS
        const fileName = `monitoring/manifests/${new Date().toISOString().split('T')[0]}/manifest-${Date.now()}.json`;
        const file = bucket.file(fileName);
        await file.save(JSON.stringify(manifest, null, 2), {
            contentType: 'application/json',
            resumable: false,
            metadata: {
                metadata: {
                    generatedBy: 'monitoringMasterHourly',
                    version: '1.0'
                }
            }
        });
        console.log(`Monitoring manifest written to gs://${bucketName}/${fileName}`);
        console.log(`Total collections: ${manifest.collections.length}, Total documents: ${manifest.collections.reduce((sum, col) => sum + col.count, 0)}`);
    }
    catch (error) {
        console.error("Error in monitoringMasterHourly:", error);
        throw error;
    }
});
/**
 * Firestore onWrite trigger for monitoring events
 * Triggered on {collectionId}/{docId}/monitoring/{type}/{eventId}
 * If after.exceeded === true, appends alert to wreck root array field alerts
 */
export const onMonitoringEventWrite = onDocumentWritten({
    document: "{collectionId}/{docId}/monitoring/{type}/{eventId}",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60
}, async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    if (!after?.exists) {
        // Document was deleted, nothing to do
        return;
    }
    const afterData = after.data();
    const beforeData = before?.data();
    // Only proceed if exceeded changed to true or if this is a new event with exceeded=true
    const wasExceeded = beforeData?.exceeded === true;
    const isExceeded = afterData?.exceeded === true;
    if (!isExceeded || wasExceeded) {
        // Either not exceeded, or was already exceeded (avoid duplicate alerts)
        return;
    }
    const { collectionId, docId, type, eventId } = event.params;
    try {
        // Get reference to the wreck document
        const wreckRef = db.doc(`${collectionId}/${docId}`);
        const wreckSnap = await wreckRef.get();
        if (!wreckSnap.exists) {
            console.error(`Wreck document ${collectionId}/${docId} not found`);
            return;
        }
        // Create alert object
        const alert = {
            id: `${type}_${eventId}_${Date.now()}`,
            type,
            eventId,
            acknowledged: false,
            createdAt: new Date().toISOString(),
            createdAtMs: Date.now(),
            message: afterData.message || `${type} threshold exceeded`,
            severity: afterData.severity || 'warning',
            source: afterData.source || 'monitoring',
            metadata: {
                threshold: afterData.threshold,
                value: afterData.pgaG || afterData.value,
                eventData: {
                    magnitude: afterData.magnitude,
                    distance: afterData.distanceKm,
                    coordinates: afterData.lat && afterData.lng ? [afterData.lat, afterData.lng] : null
                }
            }
        };
        // Update the wreck document
        await wreckRef.update({
            alerts: FieldValue.arrayUnion(alert),
            needsReassessment: true,
            alertsUpdatedAt: FieldValue.serverTimestamp()
        });
        console.log(`Alert added to ${collectionId}/${docId} for ${type} event ${eventId}`);
    }
    catch (error) {
        console.error(`Error processing monitoring event for ${collectionId}/${docId}/monitoring/${type}/${eventId}:`, error);
        throw error;
    }
});
