// Runtime config sourced from Firestore to avoid redeploys for toggles
const admin = require("firebase-admin");

const CONFIG_DOC_PATH = "config/runtime/monitoring";

let cache = { value: null, ts: 0 };
const TTL_MS = 60 * 1000;

async function getMonitoringConfig() {
  const now = Date.now();
  if (cache.value && now - cache.ts < TTL_MS) return cache.value;

  const snap = await admin.firestore().doc(CONFIG_DOC_PATH).get();
  const data = snap.exists ? snap.data() : {};
  const cfg = {
    enabled: !!data.enabled,
    dryRun: !!data.dryRun,
    shallowDepthMeters: typeof data.shallowDepthMeters === "number" ? data.shallowDepthMeters : 60,
    cycloneDistanceKm: typeof data.cycloneDistanceKm === "number" ? data.cycloneDistanceKm : 250,
    allowlist: Array.isArray(data.allowlist) ? data.allowlist : []
  };

  cache = { value: cfg, ts: now };
  return cfg;
}

module.exports = { getMonitoringConfig, CONFIG_DOC_PATH };