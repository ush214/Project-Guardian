// Helpers to create/update monitoring flags consistently
const admin = require("firebase-admin");

async function upsertMonitoringFlag({
  wreckId,
  type, // 'earthquake' | 'cyclone' | 'oil_spill'
  eventId,
  eventSource,
  eventAt,
  distanceKm = null,
  details = {},
  requiresReassessment
}) {
  const db = admin.firestore();
  const id = `${type}_${eventSource}_${wreckId}_${eventId}`;
  const ref = db.collection("monitoring_flags").doc(id);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await ref.set(
    {
      wreckId,
      type,
      eventId,
      eventSource,
      eventAt,
      distanceKm,
      details,
      requiresReassessment: !!requiresReassessment,
      updatedAt: now,
      createdAt: now
    },
    { merge: true }
  );

  return id;
}

module.exports = { upsertMonitoringFlag };