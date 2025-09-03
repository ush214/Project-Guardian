import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { initializeApp } from "firebase-admin/app";

initializeApp();
const db = getFirestore();

export const callGeminiApi = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");

  const roleSnap = await db.doc(`system/allowlist/users/${uid}`).get();
  const role = roleSnap.exists ? roleSnap.get("Role") : "user";
  if (!["contributor", "admin"].includes(role)) {
    throw new HttpsError("permission-denied", "Contributor access required.");
  }

  // ...existing Gemini logic...
});