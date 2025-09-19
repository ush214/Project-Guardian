/**
 * Deprecated: callGeminiApi was consolidated into "Web App API Function.ts".
 * This file intentionally exports no Cloud Functions now to avoid duplicate names.
 */

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

// No exports on purpose.
// If you prefer, you can delete this file from the repo to keep things tidy.