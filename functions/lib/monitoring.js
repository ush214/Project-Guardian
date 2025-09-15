"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onMonitoringEventWrite = exports.monitoringMasterHourly = exports.READ_COLLECTIONS = void 0;
const functions = __importStar(require("firebase-functions"));
const firebase_admin_1 = __importDefault(require("firebase-admin"));
const storage_1 = require("@google-cloud/storage");
try {
    // Prevent re-initialization when testing or in hot-reload
    firebase_admin_1.default.apps.length === 0 && firebase_admin_1.default.initializeApp();
}
catch (_) {
    // ignore
}
const db = firebase_admin_1.default.firestore();
const storage = new storage_1.Storage();
const APP_ID = process.env.APP_ID || 'guardian';
const RAW_BUCKET = process.env.RAW_BUCKET || '';
/**
 * Collections to read wreck docs from.
 * These are treated as collection paths (not document paths).
 */
exports.READ_COLLECTIONS = [
    'artifacts/guardian/public/data/werpassessments',
    'artifacts/guardian-agent-default/public/data/werpassessments',
];
/**
 * Build a UTC path like manifests/YYYY/MM/DD/HH.json
 */
function manifestObjectPath(date = new Date()) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    return `manifests/${y}/${m}/${d}/${h}.json`;
}
async function listWreckDocs() {
    const out = [];
    for (const colPath of exports.READ_COLLECTIONS) {
        const colRef = db.collection(colPath);
        const docRefs = await colRef.listDocuments();
        if (!docRefs || docRefs.length === 0)
            continue;
        const snapshots = await db.getAll(...docRefs);
        for (const snap of snapshots) {
            if (!snap.exists)
                continue;
            out.push({ id: snap.id, path: snap.ref.path });
        }
    }
    return out;
}
/**
 * Writes a minimal manifest of wreck doc IDs and paths to GCS hourly.
 * If RAW_BUCKET isn't configured or the bucket doesn't exist, logs and returns.
 */
exports.monitoringMasterHourly = functions.pubsub
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
        await bucket.file(objectPath).save(JSON.stringify({
            appId: APP_ID,
            generatedAtMs: Date.now(),
            count: manifest.length,
            items: manifest,
        }, null, 2), {
            contentType: 'application/json',
            resumable: false,
        });
        console.log(`[monitoringMasterHourly] Wrote manifest to gs://${RAW_BUCKET}/${objectPath}`, {
            count: manifest.length,
            elapsedMs: Date.now() - started,
        });
    }
    catch (err) {
        console.warn(`[monitoringMasterHourly] Could not write to gs://${RAW_BUCKET}/${objectPath}. This can be configured later.`, { error: err?.message });
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
exports.onMonitoringEventWrite = functions.firestore
    .document('{collectionId}/{docId}/monitoring/{type}/events/{eventId}')
    .onWrite(async (change, context) => {
    const after = change.after;
    if (!after.exists)
        return;
    const data = after.data() || {};
    const exceeded = !!data.exceeded;
    if (!exceeded)
        return;
    const { collectionId, docId, type, eventId } = context.params;
    const wreckRef = db.doc(`${collectionId}/${docId}`);
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(wreckRef);
        if (!snap.exists)
            return;
        const wreck = snap.data() || {};
        const alerts = Array.isArray(wreck.alerts) ? [...wreck.alerts] : [];
        const already = alerts.find((a) => a?.sourceType === type && (a?.eventId === eventId || a?.event_id === eventId));
        if (already) {
            // Update timestamp if you want, but avoid duplicates
            tx.update(wreckRef, {
                alertsUpdatedAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
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
            alertsUpdatedAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            needsReassessment: true,
        });
    });
});
