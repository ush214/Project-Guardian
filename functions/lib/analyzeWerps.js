/**
 * analyzeWerps.js - Initial WERP assessments
 *
 * Cloud Function v2 for generating initial WERP assessments using Gemini AI
 * Region: us-central1
 * Secrets: GEMINI_API_KEY
 * Invoker: public
 * CORS: Supports hosting domains and localhost
 * Timeout: 540 seconds
 * Memory: 1GiB
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "./admin.js";
import { getInitialPrompt } from "./prompts/loader.js";
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";
const REGION = "us-central1";
const DEFAULT_COLLECTION = "artifacts/guardian-agent-default/public/data/werpassessments";
// CORS allowed origins
const ALLOWED_ORIGINS = [
    "https://project-guardian-agent.web.app",
    "https://project-guardian-agent.firebaseapp.com",
    "http://localhost:3000",
    "http://localhost:5000",
    "http://localhost:5173",
    "http://127.0.0.1:5000"
];
export const analyzeWerps = onCall({
    region: REGION,
    secrets: [GEMINI_API_KEY],
    invoker: "public",
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ["POST"],
        allowedHeaders: ["Content-Type", "Authorization"]
    },
    timeoutSeconds: 540,
    memory: "1GiB"
}, async (request) => {
    try {
        const { vesselName, targetPath } = request.data;
        if (!vesselName || typeof vesselName !== 'string' || vesselName.trim().length === 0) {
            throw new HttpsError('invalid-argument', 'vesselName is required and must be a non-empty string');
        }
        // Determine collection path
        const collectionPath = targetPath || DEFAULT_COLLECTION;
        // Get the initial prompt
        const basePrompt = getInitialPrompt();
        // Incorporate wreck name into the prompt
        const fullPrompt = `${basePrompt}\n\nGenerate an initial WERP assessment for: "${vesselName.trim()}"`;
        // Initialize Gemini
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
        const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            generationConfig: {
                responseMimeType: "application/json"
            }
        });
        // Generate assessment
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        const text = response.text();
        let assessment;
        try {
            assessment = JSON.parse(text);
        }
        catch (parseError) {
            console.error('Failed to parse Gemini response:', text);
            throw new HttpsError('internal', 'Failed to parse AI response as JSON');
        }
        // Validate required fields
        if (!assessment.id || !assessment.name) {
            // Generate ID from name if missing
            if (!assessment.id && assessment.name) {
                assessment.id = assessment.name.toLowerCase()
                    .replace(/[^a-z0-9\s-]/g, '')
                    .replace(/\s+/g, '-')
                    .replace(/-+/g, '-')
                    .trim();
            }
            // Use vessel name if name is missing
            if (!assessment.name) {
                assessment.name = vesselName.trim();
            }
            // Generate fallback ID if still missing
            if (!assessment.id) {
                assessment.id = vesselName.toLowerCase()
                    .replace(/[^a-z0-9\s-]/g, '')
                    .replace(/\s+/g, '-')
                    .replace(/-+/g, '-')
                    .trim();
            }
        }
        // Add metadata
        assessment.createdAt = new Date().toISOString();
        assessment.updatedAt = new Date().toISOString();
        assessment.type = 'initial';
        assessment.version = '1.0';
        // Write to Firestore
        const docId = assessment.id;
        const docRef = db.collection(collectionPath).doc(docId);
        await docRef.set(assessment);
        return {
            ok: true,
            docId: docId,
            path: `${collectionPath}/${docId}`,
            message: `Initial assessment created for ${assessment.name}`
        };
    }
    catch (error) {
        console.error('analyzeWerps error:', error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError('internal', `Assessment failed: ${error.message}`);
    }
});
