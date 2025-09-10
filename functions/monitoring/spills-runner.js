// Stub endpoint to queue oil spill detection jobs.
// Later, wire this to a Cloud Run service that wraps the model from:
// https://github.com/Otutu11/Oil-Spill-Detection-from-Satellite-Imagery

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { getMonitoringConfig } = require("./config");

exports.queueSpillDetection = onRequest({ cors: true, timeoutSeconds: 120 }, async (req, res) => {
  const cfg = await getMonitoringConfig();
  if (!cfg.enabled) return res.status(403).json({ error: "Monitoring disabled" });

  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { bbox, timeWindow, wreckId } = req.body || {};
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return res.status(400).json({ error: "bbox must be [minLon, minLat, maxLon, maxLat]" });
  }

  const db = admin.firestore();
  const job = {
    bbox,
    timeWindow: timeWindow || null,
    wreckId: wreckId || null,
    status: "queued",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const ref = await db.collection("spill_jobs").add(job);
  logger.info("Queued spill detection job", { id: ref.id, wreckId });

  return res.status(202).json({ id: ref.id, status: "queued" });
});