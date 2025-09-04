/**
 * Initializes the Firebase Admin SDK and exports the Firestore database instance.
 * This modular approach keeps initialization clean and separate.
 */

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp();

export const db = getFirestore();
