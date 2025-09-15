// Centralized Firebase Admin initialization (TypeScript, compiled to CJS)
import admin from 'firebase-admin';

if (admin.apps.length === 0) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const storage = admin.storage();
export { admin };