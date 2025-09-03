/**
 * Firebase Cloud Functions for Project Guardian
 * This is the final, production-ready version using the latest Firebase v2 SDK syntax
 * and securely accessing the Gemini API key from Google Secret Manager.
 *
 * Includes:
 * 1. callGeminiApi: A secure, callable (onCall) function to perform AI analysis.
 * 2. guardianSentry: A scheduled (onSchedule) function to monitor real-time environmental events.
 * *** SIMULATION UPDATE: This version is configured to scan the last 6 MONTHS of seismic data. ***
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const fetch = require("node-fetch");
const admin = require("firebase-admin");
const { defineSecret } = require("firebase-functions/params");

admin.initializeApp();
const db = admin.firestore();

// Define the secret parameter. This tells the function which secret to access from Secret Manager.
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// --- Callable Function for AI Analysis ---
exports.callGeminiApi = onCall(
  {
    timeoutSeconds: 300,
    secrets: [geminiApiKey],
    cors: true, 
  },
  async (request) => {
    logger.info("onCall function invoked.");
    
    // Check authentication
    if (!request.auth) {
      logger.warn("Unauthenticated request to callGeminiApi");
      throw new HttpsError("unauthenticated", "You must be signed in to use this function.");
    }
    
    // Check allowlist
    try {
      const allowlistDoc = await db.doc(`system/allowlist/users/${request.auth.uid}`).get();
      if (!allowlistDoc.exists) {
        logger.warn(`User ${request.auth.uid} not in allowlist`);
        throw new HttpsError("permission-denied", "You do not have permission to use this function.");
      }
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      logger.error("Error checking allowlist:", error);
      throw new HttpsError("internal", "Failed to verify permissions.");
    }
    
    logger.info(`Authorized request from user ${request.auth.uid}`);
    
    const apiKey = geminiApiKey.value();
    if (!apiKey) {
      logger.error("CRITICAL: Gemini API Key could not be accessed from Secret Manager.");
      throw new HttpsError("internal", "The server is missing its API key configuration.");
    }
    const prompt = request.data.prompt;
    if (!prompt) {
      throw new HttpsError("invalid-argument", "The function must be called with a 'prompt' argument.");
    }
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;
    const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } };
    try {
      const apiResponse = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!apiResponse.ok) { throw new HttpsError("internal", `API call failed with status: ${apiResponse.status}`); }
      const result = await apiResponse.json();
      if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
          return { success: true, data: result.candidates[0].content.parts[0].text };
      } else { throw new HttpsError("internal", "Unexpected API response from Gemini."); }
    } catch (error) {
      logger.error("Full function execution error:", error);
      if (error instanceof HttpsError) { throw error; }
      throw new HttpsError("unknown", "An unknown server error occurred.", error.message);
    }
  }
);

// --- Scheduled Function for Real-Time Monitoring ---
const APP_ID = 'guardian-agent-default';
const SEISMIC_ALERT_THRESHOLD_MAG = 4.5;
const SEISMIC_ALERT_RADIUS_KM = 200;

exports.guardianSentry = onSchedule(
    {
        schedule: "every 24 hours",
        timeoutSeconds: 540,
        secrets: [],
    },
    async (event) => {
        logger.info("Guardian Sentry (SIMULATION MODE) running: Checking for events in the last 6 months.");

        const wrecksRef = db.collection(`artifacts/${APP_ID}/public/data/werpassessments`);
        const wrecksSnapshot = await wrecksRef.get();

        if (wrecksSnapshot.empty) {
            logger.info("No wrecks in database to monitor.");
            return null;
        }

        // --- SIMULATION CHANGE ---
        // Calculate the start time as 6 months ago instead of 24 hours.
        const now = new Date();
        const sixMonthsAgo = new Date(now.setMonth(now.getMonth() - 6));
        const startTime = sixMonthsAgo.toISOString();
        // --- END SIMULATION CHANGE ---
        
        const usgsUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${startTime}&minmagnitude=${SEISMIC_ALERT_THRESHOLD_MAG}`;
        
        let events;
        try {
            const response = await fetch(usgsUrl);
            const geojson = await response.json();
            events = geojson.features || [];
            logger.info(`Found ${events.length} significant seismic events in the last 6 months.`);
        } catch (error) {
            logger.error("Failed to fetch seismic data from USGS.", error);
            return null;
        }

        if (events.length === 0) {
            logger.info("No significant events to process in the time window.");
            return null;
        }

        const batch = db.batch();
        let alertCount = 0;

        wrecksSnapshot.forEach(doc => {
            const wreck = doc.data();
            const coords = wreck.phase1?.screening?.coordinates;

            if (coords?.latitude && coords?.longitude) {
                events.forEach(event => {
                    const eventCoords = event.geometry.coordinates;
                    const distance = haversineDistance(
                        { lat: coords.latitude, lon: coords.longitude },
                        { lat: eventCoords[1], lon: eventCoords[0] }
                    );

                    if (distance <= SEISMIC_ALERT_RADIUS_KM) {
                        logger.warn(`ALERT: Wreck ${wreck.vesselName} is ${distance.toFixed(0)}km from a M${event.properties.mag} earthquake.`);
                        alertCount++;
                        
                        const newAlert = {
                            type: 'SEISMIC_EVENT',
                            timestamp: new Date(event.properties.time).toISOString(),
                            details: `Magnitude ${event.properties.mag.toFixed(1)} earthquake detected ${distance.toFixed(0)} km from wreck site.`,
                            source: 'USGS',
                            acknowledged: false
                        };
                        
                        const wreckRef = doc.ref;
                        batch.update(wreckRef, {
                            alerts: admin.firestore.FieldValue.arrayUnion(newAlert)
                        });
                    }
                });
            }
        });

        if (alertCount > 0) {
            logger.info(`Committing ${alertCount} new alerts to the database.`);
            await batch.commit();
        } else {
            logger.info("No wrecks were within the alert radius of any significant events.");
        }
        
        return null;
    }
);

function haversineDistance(coords1, coords2) {
    const R = 6371; // Earth's radius in km
    const dLat = (coords2.lat - coords1.lat) * Math.PI / 180;
    const dLon = (coords2.lon - coords1.lon) * Math.PI / 180;
    const a = 0.5 - Math.cos(dLat)/2 + Math.cos(coords1.lat * Math.PI / 180) * Math.cos(coords2.lat * Math.PI / 180) * (1 - Math.cos(dLon)) / 2;
    return R * 2 * Math.asin(Math.sqrt(a));
}

