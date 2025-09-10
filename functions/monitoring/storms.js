// Tropical cyclone proximity monitor using GDACS (global).
// Schedules every 3 hours by default. Filters shallow wrecks.

const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { haversineKm } = require("./geo");
const { getMonitoringConfig } = require("./config");
const { upsertMonitoringFlag } = require("./flags");

// Basic GDACS tropical cyclone list
const GDACS_TC_API = "https://www.gdacs.org/gdacsapi/api/events/geteventlist?eventtype=TC";

function wreckIsShallow(wreck, shallowDepthMeters) {
  const d = wreck?.depthMeters;
  if (typeof d !== "number") return true; // unknown => conservative
  return d <= shallowDepthMeters;
}

function extractStormPoints(event) {
  // GDACS list gives centroids; for better accuracy you can fetch detail per-event later.
  // For a first pass, use the reported lat/lon as the reference point.
  const lat = Number(event?.latitude);
  const lon = Number(event?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return [{ lat, lon }];
  }
  return [];
}

exports.monitorTropicalCyclones = onSchedule(
  {
    schedule: "every 180 minutes",
    timeZone: "Etc/UTC",
    memory: "512MiB",
    timeoutSeconds: 120
  },
  async (event) => {
    const cfg = await getMonitoringConfig();
    if (!cfg.enabled) {
      logger.info("Monitoring disabled via config.");
      return;
    }

    // Fetch active storms
    let storms = [];
    try {
      const res = await fetch(GDACS_TC_API, { headers: { "accept": "application/json" } });
      if (!res.ok) throw new Error(`GDACS HTTP ${res.status}`);
      const data = await res.json();
      storms = Array.isArray(data?.features || data) ? (data.features || data) : []; // handle array or GeoJSON-ish
    } catch (err) {
      logger.error("Failed to fetch GDACS storms", err);
      return;
    }

    if (!storms.length) {
      logger.info("No active cyclones from GDACS");
      return;
    }

    const db = admin.firestore();
    const wrecksSnap = await db.collection("wrecks").get();
    if (wrecksSnap.empty) {
      logger.info("No wrecks found; nothing to do.");
      return;
    }

    const shallowDepth = cfg.shallowDepthMeters;
    const maxDistKm = cfg.cycloneDistanceKm;

    let processed = 0;
    for (const doc of wrecksSnap.docs) {
      const w = doc.data();
      const wreckId = doc.id;
      const coords = w?.coordinates;
      const wreckPoint = coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)
        ? { lat: coords.lat, lon: coords.lon }
        : null;

      if (!wreckPoint) continue; // skip wrecks without coords
      if (!wreckIsShallow(w, shallowDepth)) continue; // only shallow wrecks

      // Compute min distance to any storm point
      let nearest = { storm: null, dist: Infinity, point: null };
      for (const s of storms) {
        const ev = s?.properties || s; // attempt to adapt to array or feature
        const eventId = String(ev?.eventid || ev?.eventId || ev?.name || ev?.identifier || "");
        const points = extractStormPoints(s?.properties || s);
        for (const pt of points) {
          const dKm = haversineKm(wreckPoint, pt);
          if (dKm < nearest.dist) nearest = { storm: { ev, eventId }, dist: dKm, point: pt };
        }
      }

      if (nearest.dist <= maxDistKm && nearest.storm?.eventId) {
        const requiresReassessment = !!w?.phase2Completed;
        const payload = {
          wreckId,
          type: "cyclone",
          eventId: nearest.storm.eventId,
          eventSource: "gdacs",
          eventAt: new Date().toISOString(),
          distanceKm: Math.round(nearest.dist * 10) / 10,
          details: {
            thresholdKm: maxDistKm,
            shallowDepthMeters: shallowDepth,
            stormPoint: nearest.point,
            stormProp: { name: nearest.storm.ev?.name || nearest.storm.ev?.eventname || null }
          },
          requiresReassessment
        };
        if (cfg.dryRun) {
          logger.info("DRY RUN: would flag cyclone proximity", payload);
        } else {
          await upsertMonitoringFlag(payload);
          logger.info("Flagged cyclone proximity", { wreckId, eventId: payload.eventId, distanceKm: payload.distanceKm, requiresReassessment });
        }
        processed++;
      }
    }

    logger.info("Cyclone monitor completed", { processed, wreckCount: wrecksSnap.size });
  }
);