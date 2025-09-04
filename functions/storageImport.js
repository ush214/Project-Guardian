// Cloud Storage-driven bulk import processor (ESM).
// Listens for CSV uploads and processes vessel names for bulk import.

import { onObjectFinalized } from "firebase-functions/v2/storage";
import { defineSecret } from "firebase-functions/params";
import { FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { db } from "./admin.js";

const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const QUEUE_PATH = "system/bulkImport/queue";
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

function normalizeId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function getRole(uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return "user";
    return snap.get("Role") || "user";
  } catch (e) {
    console.error("Failed to read Role for uid:", uid, e);
    return "user";
  }
}

function parseCSV(content) {
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
  const vesselNames = [];
  
  for (const line of lines) {
    // Handle both comma-separated and one-per-line formats
    if (line.includes(',')) {
      vesselNames.push(...line.split(',').map(name => name.trim()).filter(Boolean));
    } else {
      vesselNames.push(line);
    }
  }
  
  return vesselNames;
}

// Cloud Storage trigger for CSV uploads
export const processStorageImport = onObjectFinalized(
  {
    region: REGION,
    secrets: [GEMINI_API_KEY],
    bucket: "project-guardian-agent.appspot.com" // Default bucket
  },
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType;
    
    // Only process CSV files in the bulk-import folder
    if (!filePath.startsWith("bulk-import/") || !filePath.endsWith(".csv")) {
      console.log(`Skipping non-CSV file or file outside bulk-import folder: ${filePath}`);
      return;
    }

    // Extract metadata to verify admin permission
    const metadata = event.data.metadata || {};
    const uploaderUid = metadata.uploaderUid;
    
    if (!uploaderUid) {
      console.error(`No uploaderUid metadata found for file: ${filePath}`);
      return;
    }

    // Verify admin permission
    const role = await getRole(uploaderUid);
    if (role !== "admin") {
      console.error(`Non-admin user ${uploaderUid} attempted bulk import via storage`);
      return;
    }

    try {
      // Download and read the CSV file
      const bucket = getStorage().bucket();
      const file = bucket.file(filePath);
      const [content] = await file.download();
      const csvContent = content.toString('utf-8');
      
      // Parse vessel names from CSV
      const vesselNames = parseCSV(csvContent);
      
      if (vesselNames.length === 0) {
        console.log(`No vessel names found in file: ${filePath}`);
        return;
      }

      console.log(`Processing ${vesselNames.length} vessel names from ${filePath}`);
      
      // Process vessels similar to existing bulk import logic
      const seen = new Set();
      let skippedDuplicate = 0;
      let skippedExisting = 0;
      let enqueued = 0;

      for (const name of vesselNames) {
        const docId = normalizeId(name);
        if (!docId) { skippedDuplicate++; continue; }
        if (seen.has(docId)) { skippedDuplicate++; continue; }
        seen.add(docId);

        // Skip if assessment already exists
        const assessRef = db.doc(`artifacts/${APP_ID}/public/data/werpassessments/${docId}`);
        if ((await assessRef.get()).exists) {
          skippedExisting++;
          continue;
        }

        // Idempotent queue doc by docId (one queued item per vessel)
        const qRef = db.doc(`${QUEUE_PATH}/${docId}`);
        await qRef.set({
          vesselName: name,
          docId,
          status: "pending",
          attempts: 0,
          source: "storage-import",
          sourceFile: filePath,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        enqueued++;
      }

      // Log results
      console.log(`Storage import completed for ${filePath}:`, {
        total: vesselNames.length,
        enqueued,
        skippedDuplicate,
        skippedExisting
      });

      // Create a processing log document
      const logRef = db.collection("system/bulkImport/storageLogs").doc();
      await logRef.set({
        filePath,
        uploaderUid,
        processedAt: FieldValue.serverTimestamp(),
        total: vesselNames.length,
        enqueued,
        skippedDuplicate,
        skippedExisting,
        status: "completed"
      });

      // Optionally move the processed file to a processed folder
      const processedPath = filePath.replace("bulk-import/", "bulk-import/processed/");
      await file.copy(processedPath);
      await file.delete();

    } catch (error) {
      console.error(`Error processing storage import for ${filePath}:`, error);
      
      // Log the error
      const logRef = db.collection("system/bulkImport/storageLogs").doc();
      await logRef.set({
        filePath,
        uploaderUid,
        processedAt: FieldValue.serverTimestamp(),
        status: "failed",
        error: String(error?.message || error || "Unknown error")
      });
    }
  }
);