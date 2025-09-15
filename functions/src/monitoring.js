/**
 * monitoring.js - Firebase Functions for Project Guardian monitoring system
 * 
 * Functions:
 * 1. monitoringMasterHourly - Cloud Scheduler trigger (every 60 min) 
 *    Writes manifest JSON to GCS raw bucket listing wreck doc paths + ids
 * 2. onMonitoringEventWrite - Firestore onWrite trigger
 *    Handles {collectionId}/{docId}/monitoring/{type}/{eventId} changes
 *    Creates alerts and sets needsReassessment when thresholds exceeded
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const admin = require("firebase-admin");

// Environment variables
const APP_ID = process.env.APP_ID || "guardian";
const RAW_BUCKET = process.env.RAW_BUCKET || null;

// Hard-coded read collections per requirements
const READ_COLLECTIONS = [
  "artifacts/guardian/public/data/werpassessments",
  "artifacts/guardian-agent-default/public/data/werpassessments"
];

/**
 * Cloud Scheduler function that runs every 60 minutes
 * Creates a manifest JSON listing all wreck document paths and IDs
 * Writes to GCS raw bucket if available
 */
const monitoringMasterHourly = onSchedule(
  {
    schedule: "every 60 minutes", 
    timeZone: "Etc/UTC",
    memory: "512MiB",
    timeoutSeconds: 300
  },
  async (event) => {
    logger.info("Starting monitoring master hourly job");
    
    const db = getFirestore();
    const manifest = {
      timestamp: new Date().toISOString(),
      collections: []
    };

    try {
      // Process each collection
      for (const collectionPath of READ_COLLECTIONS) {
        logger.info(`Processing collection: ${collectionPath}`);
        
        const collection = db.collection(collectionPath);
        const snapshot = await collection.get();
        
        const docs = snapshot.docs.map(doc => ({
          id: doc.id,
          path: `${collectionPath}/${doc.id}`,
          lastModified: doc.updateTime?.toDate()?.toISOString() || null
        }));

        manifest.collections.push({
          path: collectionPath,
          count: docs.length,
          documents: docs
        });
        
        logger.info(`Found ${docs.length} documents in ${collectionPath}`);
      }

      // Write manifest to GCS if bucket is configured
      if (RAW_BUCKET) {
        try {
          const storage = getStorage();
          const bucket = storage.bucket(RAW_BUCKET);
          const fileName = `manifests/monitoring-manifest-${Date.now()}.json`;
          const file = bucket.file(fileName);
          
          await file.save(JSON.stringify(manifest, null, 2), {
            metadata: {
              contentType: "application/json"
            }
          });
          
          logger.info(`Manifest written to gs://${RAW_BUCKET}/${fileName}`);
        } catch (storageError) {
          logger.warn("Failed to write to GCS bucket", { error: storageError, bucket: RAW_BUCKET });
        }
      } else {
        logger.info("No RAW_BUCKET configured, manifest not persisted to storage");
      }

      const totalDocs = manifest.collections.reduce((sum, col) => sum + col.count, 0);
      logger.info(`Monitoring master job completed successfully. Total documents: ${totalDocs}`);
      
    } catch (error) {
      logger.error("Error in monitoring master hourly job", error);
      throw error;
    }
  }
);

/**
 * Firestore trigger for monitoring events
 * Listens to writes on {collectionId}/{docId}/monitoring/{type}/{eventId}
 * When exceeded=true, appends to wreck's alerts array and sets needsReassessment=true
 */
const onMonitoringEventWrite = onDocumentWritten(
  {
    document: "{collectionId}/{docId}/monitoring/{type}/events/{eventId}",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60
  },
  async (event) => {
    const { collectionId, docId, type, eventId } = event.params;
    
    logger.info("Monitoring event write detected", { 
      collectionId, 
      docId, 
      type, 
      eventId 
    });

    // Only process if document was created or updated (not deleted)
    const after = event.data?.after;
    if (!after || !after.exists) {
      logger.info("Document deleted or doesn't exist, skipping");
      return;
    }

    const eventData = after.data();
    
    // Check if this event has exceeded thresholds
    if (!eventData?.exceeded) {
      logger.info("Event has not exceeded thresholds, no action needed");
      return;
    }

    const db = getFirestore();
    
    try {
      // Find the parent wreck document
      const wreckRef = db.doc(`${collectionId}/${docId}`);
      const wreckDoc = await wreckRef.get();
      
      if (!wreckDoc.exists) {
        logger.warn("Parent wreck document not found", { collectionId, docId });
        return;
      }

      const wreckData = wreckDoc.data() || {};
      const currentAlerts = Array.isArray(wreckData.alerts) ? wreckData.alerts : [];
      
      // Create new alert object
      const newAlert = {
        id: `${type}_${eventId}_${Date.now()}`,
        type,
        eventId,
        eventPath: `${collectionId}/${docId}/monitoring/${type}/events/${eventId}`,
        message: eventData.message || `${type} event exceeded threshold`,
        severity: eventData.severity || "medium",
        acknowledged: false,
        createdAt: FieldValue.serverTimestamp(),
        eventData: {
          magnitude: eventData.magnitude,
          distanceKm: eventData.distanceKm,
          pgaG: eventData.pgaG,
          threshold: eventData.threshold,
          source: eventData.source
        }
      };

      // Check if we already have an alert for this exact event
      const existingAlert = currentAlerts.find(alert => 
        alert.eventId === eventId && alert.type === type
      );

      if (existingAlert && !existingAlert.acknowledged) {
        logger.info("Alert already exists for this event and is not acknowledged, skipping", {
          alertId: existingAlert.id
        });
        return;
      }

      // Update wreck document with new alert and reassessment flag
      const updates = {
        alerts: [...currentAlerts, newAlert],
        needsReassessment: true,
        alertsUpdatedAt: FieldValue.serverTimestamp()
      };

      await wreckRef.update(updates);
      
      logger.info("Successfully created alert and set reassessment flag", {
        wreckId: docId,
        alertId: newAlert.id,
        type,
        eventId
      });

    } catch (error) {
      logger.error("Error processing monitoring event", {
        error,
        collectionId,
        docId,
        type,
        eventId
      });
      throw error;
    }
  }
);

module.exports = { monitoringMasterHourly, onMonitoringEventWrite };
