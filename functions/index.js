/**
 * Project Guardian backend (Firebase Functions v2)
 * - callGeminiApi: HTTPS endpoint (public), CORS enabled. Uses secret GEMINI_API_KEY.
 * - guardianSentry: Scheduled function (daily) that ingests USGS quakes and writes alerts to Firestore.
 *
 * Requirements:
 * - Node 20 runtime (set in functions/package.json)
 * - Secrets: firebase functions:secrets:set GEMINI_API_KEY --project <PROJECT_ID>
 * - No .env entry for GEMINI_API_KEY (avoid secret/env collision)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

// Initialize Admin SDK once
try {
  admin.app();
} catch {
  admin.initializeApp();
}
const db = admin.firestore();

// Constants
const APP_ID = "guardian-agent-default"; // Must match the frontend appId
const WER_COLLECTION = `artifacts/${APP_ID}/public/data/werpassessments`;
const ALERT_RADIUS_KM = 200; // Proximity threshold
const MIN_MAGNITUDE = 4.5;

// Secrets
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

/**
 * HTTPS function: Public endpoint for Gemini calls
 * - CORS enabled
 * - 5-minute timeout
 * - Public invoker (no IAM step needed)
 */
exports.callGeminiApi = onRequest(
  {
    timeoutSeconds: 300,
    secrets: [GEMINI_API_KEY],
    cors: true,
    region: "us-central1",
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const apiKey = GEMINI_API_KEY.value();
    if (!apiKey) {
      logger.error("GEMINI_API_KEY secret is missing.");
      return res.status(500).send({ error: "Server is missing API key configuration." });
    }

    const prompt = req.body?.data?.prompt;
    if (!prompt) {
      return res.status(400).send({ error: "The request must include a 'prompt' in the data payload." });
    }

    const apiUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=" +
      encodeURIComponent(apiKey);
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    };

    try {
      const apiResponse = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        logger.error(`Gemini API Error: ${apiResponse.status}`, { errorBody });
        return res.status(500).send({ error: `API call failed with status: ${apiResponse.status}` });
      }

      const result = await apiResponse.json();
      const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        logger.error("Unexpected API response structure from Gemini", { result });
        return res.status(500).send({ error: "Unexpected API response from Gemini." });
      }

      return res.status(200).send({ data: { success: true, data: text } });
    } catch (err) {
      logger.error("callGeminiApi execution error:", err);
      return res.status(500).send({ error: "An unknown server error occurred." });
    }
  }
);

/**
 * Scheduled function: Guardian Sentry
 * - Runs every 24 hours (UTC)
 * - Fetches USGS M >= 4.5 earthquakes from last 24 hours
 * - For each wreck, computes distance; if within ALERT_RADIUS_KM, writes/updates an alert doc
 * - Deduplicated by using USGS event id as alert doc id (idempotent)
 */
exports.guardianSentry = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "UTC",
    region: "us-central1",
  },
  async (event) => {
    logger.info("Guardian Sentry started");

    try {
      // 1) Fetch quakes from last 24 hours
      const now = new Date();
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const usgsUrl =
        "https://earthquake.usgs.gov/fdsnws/event/1/query" +
        `?format=geojson&starttime=${encodeURIComponent(start.toISOString())}` +
        `&minmagnitude=${encodeURIComponent(MIN_MAGNITUDE)}`;

      const usgsResp = await fetch(usgsUrl);
      if (!usgsResp.ok) {
        const body = await usgsResp.text();
        throw new Error(`USGS fetch failed ${usgsResp.status}: ${body}`);
      }
      const usgs = await usgsResp.json();
      const features = Array.isArray(usgs?.features) ? usgs.features : [];
      logger.info(`USGS returned ${features.length} events since ${start.toISOString()}`);

      if (features.length === 0) {
        logger.info("No events to process. Exiting.");
        return;
      }

      // 2) Load wrecks
      const wrecksSnap = await db.collection(WER_COLLECTION).get();
      if (wrecksSnap.empty) {
        logger.info("No wrecks found in Firestore. Exiting.");
        return;
      }

      // 3) Process alerts
      let createdOrUpdated = 0;

      // For each wreck doc
      for (const doc of wrecksSnap.docs) {
        const data = doc.data() || {};
        const coords =
          data?.phase1?.screening?.coordinates ||
          data?.phase1?.summary?.coordinates ||
          data?.coordinates ||
          null;

        const lat = Number(coords?.latitude);
        const lon = Number(coords?.longitude);
        if (!isFinite(lat) || !isFinite(lon)) continue;

        const wreckRef = doc.ref;

        // Check each quake against this wreck
        for (const feat of features) {
          const qid = String(feat?.id || "");
          const qmag = Number(feat?.properties?.mag);
          const qtimeMs = Number(feat?.properties?.time);
          const qplace = String(feat?.properties?.place || "Unknown location");
          const qcoords = feat?.geometry?.coordinates; // [lon, lat, depth]
          const qLon = Number(Array.isArray(qcoords) ? qcoords[0] : NaN);
          const qLat = Number(Array.isArray(qcoords) ? qcoords[1] : NaN);

          if (!qid || !isFinite(qmag) || !isFinite(qLat) || !isFinite(qLon)) continue;

          const distanceKm = haversineKm(lat, lon, qLat, qLon);
          if (distanceKm > ALERT_RADIUS_KM) continue;

          // Upsert alert doc (idempotent): one doc per USGS event
          const alertId = `usgs-${qid}`;
          const alertRef = wreckRef.collection("alerts").doc(alertId);
          await alertRef.set(
            {
              type: "earthquake",
              source: "USGS",
              sourceEventId: qid,
              magnitude: qmag,
              distanceKm: Math.round(distanceKm * 10) / 10,
              place: qplace,
              eventTime: new Date(qtimeMs || Date.now()),
              computedAt: admin.firestore.FieldValue.serverTimestamp(),
              acknowledged: false,
              radiusKm: ALERT_RADIUS_KM,
              thresholdMinMagnitude: MIN_MAGNITUDE,
            },
            { merge: true }
          );

          // Flag top-level doc
          await wreckRef.set(
            {
              hasActiveAlerts: true,
              lastAlertAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          createdOrUpdated++;
        }
      }

      logger.info(`Guardian Sentry finished. Alerts upserted: ${createdOrUpdated}`);
    } catch (err) {
      logger.error("guardianSentry error:", err);
      // Do not throw to avoid retry storm unless you need retries
    }
  }
);

// --- Helpers ---
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(a));
  return R * c;
}
function toRad(v) {
  return (v * Math.PI) / 180;
}