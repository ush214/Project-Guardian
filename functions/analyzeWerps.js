/**
 * analyzeWerps.js
 *
 * Initial WERP (Wreck Environmental Risk Prioritisation) assessment function.
 * Creates new assessments for wrecks using Gemini AI with the initial assessment prompt.
 *
 * Accepts:
 *  - wreckName (required string) - The name of the wreck to assess
 *  - metadata (optional object) - Additional metadata like buildYear
 *
 * Behavior:
 *  - Uses the initial assessment prompt from prompts/loader.js
 *  - Calls Gemini API with JSON response format
 *  - Parses and validates the response
 *  - Ensures id and name fields exist
 *  - Writes to Firestore artifacts collection
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { defineSecret } from "firebase-functions/params";
import { getInitialPrompt } from "./prompts/loader.js";

const logger = functions.logger;
const REGION = "us-central1";
const APP_ID = "guardian-agent-default";
const COLLECTION = `artifacts/${APP_ID}/public/data/werpassessments`;

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

/**
 * Creates a Gemini AI model instance
 */
function createModel() {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

/**
 * Extracts JSON from model response, handling various formats
 */
function extractJsonCandidate(text) {
  let s = String(text || "");
  let m = s.match(/```json([\s\S]*?)```/i);
  if (m) return m[1].trim();
  m = s.match(/```([\s\S]*?)```/i);
  if (m) return m[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return s.slice(first, last + 1).trim();
  return s.trim();
}

/**
 * Clamps a number to be within specified bounds
 */
function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) n = lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Normalizes a name to create a URL-safe document ID
 */
function normalizeId(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Builds the prompt for initial assessment by combining the template with wreck name
 */
function buildAssessmentPrompt(wreckName) {
  const promptTemplate = getInitialPrompt();
  
  // Add the wreck name to the prompt
  return `${promptTemplate}

WRECK TO ASSESS: ${wreckName}

Please provide a complete initial WERP assessment for this wreck following the JSON schema specified above.`;
}

/**
 * Processes the Gemini response and normalizes it for Firestore storage
 */
function processAssessmentResponse(response, wreckName, metadata = {}) {
  // Ensure required fields exist
  if (!response.id) {
    response.id = normalizeId(wreckName);
  }
  if (!response.name) {
    response.name = wreckName;
  }

  // Add vessel name for compatibility
  response.vesselName = wreckName;

  // Add metadata
  response.metadata = {
    ...metadata,
    assessmentType: "initial",
    createdAt: new Date().toISOString(),
    source: "gemini-ai",
    version: "v1"
  };

  // Add status
  response.status = "initial";
  
  // Add timestamps
  response.createdAt = FieldValue.serverTimestamp();
  response.updatedAt = FieldValue.serverTimestamp();

  return response;
}

/**
 * Main callable function for analyzing wrecks
 */
export const analyzeWerps = onCall(
  {
    region: REGION,
    timeoutSeconds: 540,
    memory: "1GiB", 
    secrets: [GEMINI_API_KEY],
    invoker: "public",
    cors: true
  },
  async (req) => {
    try {
      // Extract and validate parameters
      const wreckName = typeof req.data?.wreckName === "string" ? req.data.wreckName.trim() : "";
      const metadata = req.data?.metadata || {};
      const dryRun = !!req.data?.dryRun;

      if (!wreckName) {
        throw new HttpsError("invalid-argument", "wreckName is required.");
      }

      logger.info(`Analyzing wreck: ${wreckName}`, { dryRun, metadata });

      // Generate document ID
      const docId = normalizeId(wreckName);
      
      // Check if assessment already exists
      const ref = db.doc(`${COLLECTION}/${docId}`);
      const existingSnap = await ref.get();
      if (existingSnap.exists && !dryRun) {
        throw new HttpsError("already-exists", `Assessment for ${wreckName} already exists with ID: ${docId}`);
      }

      // Build prompt and call Gemini
      let response;
      try {
        const prompt = buildAssessmentPrompt(wreckName);
        const model = createModel();
        
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { 
            responseMimeType: "application/json",
            temperature: 0.1
          }
        });

        const rawText = result?.response?.text() || "";
        const jsonCandidate = extractJsonCandidate(rawText);
        response = JSON.parse(jsonCandidate);

      } catch (error) {
        logger.error("Gemini API call failed:", error);
        throw new HttpsError("internal", `AI analysis failed: ${error.message}`);
      }

      // Process and validate response
      const processedResponse = processAssessmentResponse(response, wreckName, metadata);

      // Validate required fields
      if (!processedResponse.id || !processedResponse.name) {
        throw new HttpsError("internal", "AI response missing required id or name fields");
      }

      // Write to Firestore (unless dry run)
      if (!dryRun) {
        await ref.set(processedResponse);
        logger.info(`Successfully created assessment for ${wreckName} with ID: ${docId}`);
      } else {
        logger.info(`Dry run completed for ${wreckName}`, { docId });
      }

      return {
        success: true,
        docId,
        wreckName,
        dryRun,
        ...(dryRun ? { preview: processedResponse } : {}),
        message: dryRun 
          ? `Dry run completed for ${wreckName}` 
          : `Assessment created successfully for ${wreckName}`
      };

    } catch (error) {
      logger.error("analyzeWerps error:", error);
      
      // Re-throw HttpsError instances
      if (error instanceof HttpsError) {
        throw error;
      }
      
      // Wrap other errors
      throw new HttpsError("internal", `Analysis failed: ${error.message}`);
    }
  }
);