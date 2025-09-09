/**
 * inSitu.js
 *
 * Phase 2 (in situ) management helpers:
 *  - addInSituUpdate: append an update entry, set phase2.latest, preserve history
 *  - flagForReassessment: sets needsReassessment=true ONLY if phase2.latest.status === "completed"
 *  - clearReassessmentFlag: clears needsReassessment and records lastReassessedAt
 *  - recordEnvironmentalEvent: attach event metadata to docs; flags only those eligible (completed Phase 2)
 *
 * Docs are under:
 *   artifacts/{APP_ID}/public/data/werpassessments/{docId}
 *
 * Doc fields used:
 *   phase2: {
 *     latest: { status: "completed"|"in-progress"|..., notes, updatedAt, assessor, ... },
 *     updates: [ { ...same as latest per update... } ]
 *   }
 *   needsReassessment: boolean
 *   impactEvents: [ { eventId, name, type, date|occurredAt, description, recordedAt } ]
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";

const logger = functions.logger;
const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const COLLECTION = `artifacts/${APP_ID}/public/data/werpassessments`;

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch {
    return "user";
  }
}

function sanitizeUpdate(u = {}) {
  const now = FieldValue.serverTimestamp();
  const out = {
    status: String(u.status || "").toLowerCase() || "in-progress",
    notes: String(u.notes || "").slice(0, 4000),
    assessor: u.assessor ? String(u.assessor).slice(0, 256) : undefined,
    attachments: Array.isArray(u.attachments) ? u.attachments.slice(0, 10) : undefined,
    updatedAt: now
  };
  Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
  return out;
}

/**
 * addInSituUpdate
 * data: { docId, update: { status, notes, assessor, attachments? } }
 */
export const addInSituUpdate = onCall(
  { region: REGION, timeoutSeconds: 300, memory: "512MiB" },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (!["contributor", "admin"].includes(role)) {
      throw new HttpsError("permission-denied", "Contributor or admin required.");
    }

    const docId = String(req.data?.docId || "").trim();
    const rawUpdate = req.data?.update || {};
    if (!docId) throw new HttpsError("invalid-argument", "docId is required.");

    const update = sanitizeUpdate(rawUpdate);

    try {
      const ref = db.doc(`${COLLECTION}/${docId}`);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Assessment not found.");
        const data = snap.data() || {};
        const phase2 = data.phase2 || {};
        const updates = Array.isArray(phase2.updates) ? phase2.updates.slice() : [];
        updates.push(update);
        const latest = { ...update };

        tx.set(
          ref,
          {
            phase2: { ...phase2, updates, latest },
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      });

      return { ok: true };
    } catch (e) {
      logger.error("addInSituUpdate error:", e);
      throw new HttpsError("internal", e?.message || "Failed to add update.");
    }
  }
);

/**
 * flagForReassessment
 * data: { docId, reason?:string, event?: { eventId?, name, type?, date?, description? } }
 * Only flags if phase2.latest.status === "completed".
 */
export const flagForReassessment = onCall(
  { region: REGION, timeoutSeconds: 180 },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin required.");

    const docId = String(req.data?.docId || "").trim();
    if (!docId) throw new HttpsError("invalid-argument", "docId is required.");

    const reason = typeof req.data?.reason === "string" ? req.data.reason.trim().slice(0, 1000) : "";
    const event = req.data?.event && typeof req.data.event === "object" ? req.data.event : null;

    try {
      const ref = db.doc(`${COLLECTION}/${docId}`);
      let flagged = false;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Assessment not found.");
        const data = snap.data() || {};
        const p2status = String(data?.phase2?.latest?.status || "").toLowerCase();
        const wasCompleted = p2status === "completed";
        const patch = { updatedAt: FieldValue.serverTimestamp() };

        if (event) {
          const ev = {
            eventId: event.eventId || undefined,
            name: event.name || event.type || "Event",
            type: event.type || undefined,
            description: typeof event.description === "string" ? event.description.slice(0, 2000) : undefined,
            occurredAt: event.date || undefined,
            recordedAt: FieldValue.serverTimestamp(),
            reason
          };
          const current = Array.isArray(data.impactEvents) ? data.impactEvents.slice() : [];
          current.push(ev);
          patch["impactEvents"] = current;
        }

        if (wasCompleted) {
          patch["needsReassessment"] = true;
          if (reason) patch["reassessmentReason"] = reason;
          flagged = true;
        }

        tx.set(ref, patch, { merge: true });
      });

      return { ok: true, flagged };
    } catch (e) {
      logger.error("flagForReassessment error:", e);
      throw new HttpsError("internal", e?.message || "Failed to flag for reassessment.");
    }
  }
);

/**
 * clearReassessmentFlag
 * data: { docId }
 * Clears needsReassessment and sets lastReassessedAt.
 */
export const clearReassessmentFlag = onCall(
  { region: REGION, timeoutSeconds: 120 },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin required.");

    const docId = String(req.data?.docId || "").trim();
    if (!docId) throw new HttpsError("invalid-argument", "docId is required.");

    try {
      const ref = db.doc(`${COLLECTION}/${docId}`);
      await ref.set(
        {
          needsReassessment: false,
          lastReassessedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return { ok: true };
    } catch (e) {
      logger.error("clearReassessmentFlag error:", e);
      throw new HttpsError("internal", e?.message || "Failed to clear flag.");
    }
  }
);

/**
 * recordEnvironmentalEvent
 * data: {
 *   event: { eventId?, name, type?, date?, description? },
 *   docIds: string[]
 *   autoFlag?: boolean (default true)  // flag only those with completed Phase 2
 * }
 */
export const recordEnvironmentalEvent = onCall(
  { region: REGION, timeoutSeconds: 540, memory: "1GiB" },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    const role = await getRole(uid);
    if (role !== "admin") throw new HttpsError("permission-denied", "Admin required.");

    const event = req.data?.event;
    const docIds = Array.isArray(req.data?.docIds) ? req.data.docIds : [];
    const autoFlag = req.data?.autoFlag !== false;

    if (!event || typeof event !== "object") {
      throw new HttpsError("invalid-argument", "event is required.");
    }
    if (!docIds.length) {
      throw new HttpsError("invalid-argument", "docIds must be a non-empty array.");
    }

    const ev = {
      eventId: event.eventId || undefined,
      name: event.name || event.type || "Event",
      type: event.type || undefined,
      description: typeof event.description === "string" ? event.description.slice(0, 2000) : undefined,
      occurredAt: event.date || undefined,
      recordedAt: FieldValue.serverTimestamp()
    };

    let scanned = 0, impacted = 0, flagged = 0;
    const batchSize = 400;
    for (let i=0; i<docIds.length; i+=batchSize) {
      const slice = docIds.slice(i, i+batchSize);
      const writes = [];
      for (const id of slice) {
        scanned++;
        const ref = db.doc(`${COLLECTION}/${id}`);
        const snap = await ref.get();
        if (!snap.exists) continue;
        const data = snap.data() || {};
        const current = Array.isArray(data.impactEvents) ? data.impactEvents.slice() : [];
        current.push(ev);
        const patch = {
          impactEvents: current,
          updatedAt: FieldValue.serverTimestamp()
        };
        let doFlag = false;
        if (autoFlag) {
          const st = String(data?.phase2?.latest?.status || "").toLowerCase();
          if (st === "completed") {
            patch["needsReassessment"] = true;
            doFlag = true;
          }
        }
        writes.push({ ref, patch, doFlag });
      }
      // Commit sequentially to preserve memory
      for (const w of writes) {
        await w.ref.set(w.patch, { merge: true });
        impacted++;
        if (w.doFlag) flagged++;
      }
    }

    return { ok: true, scanned, impacted, flagged };
  }
);