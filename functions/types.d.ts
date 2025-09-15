declare module './admin.js' {
  import { Firestore } from 'firebase-admin/firestore';
  import { Storage } from 'firebase-admin/storage';
  export const db: Firestore;
  export const storage: Storage;
}