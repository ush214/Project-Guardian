// Node 20+ required
// Usage: node tools/test-call-cache.js

import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

// 1) Firebase web config (same as your app)
const firebaseConfig = {
  apiKey: "AIzaSyCiqs5iMg-Nj3r6yRszUxFKOIxmMfs5m6Q",
  authDomain: "project-guardian-agent.firebaseapp.com",
  projectId: "project-guardian-agent",
  storageBucket: "project-guardian-agent.firebasestorage.app",
  messagingSenderId: "84395007243",
  appId: "1:84395007243:web:b07e5f4c4264d27611160e",
  measurementId: "G-NRLH3WSCQ9"
};

// 2) Your Firebase account (must be allowed as contributor/admin per allowlist)
const EMAIL = "you@example.com";      // <-- set this
const PASSWORD = "your-password";     // <-- set this

// 3) Test parameters
const REGION = "us-central1";
const APP_ID = "guardian";
const COLLECTION_PATH = "artifacts/guardian/public/data/werpassessments";
// Optional single doc test:
const DOC_ID = ""; // put a specific doc id to test cacheReferenceMedia

async function main() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);

  console.log("Signing in…");
  const cred = await signInWithEmailAndPassword(auth, EMAIL, PASSWORD);
  console.log("Signed in as:", cred.user.email || cred.user.uid);

  const functions = getFunctions(app, REGION);

  // A) DRY-RUN backfill — shows candidates per doc without caching
  const backfill = httpsCallable(functions, "cacheCollectionReferenceMedia");
  console.log("Calling cacheCollectionReferenceMedia (dryRun)…");
  const resDry = await backfill({ appId: APP_ID, collectionPath: COLLECTION_PATH, limit: 1000, dryRun: true });
  console.log("Dry-run result:", JSON.stringify(resDry.data, null, 2));

  // B) Real backfill — do this when dryRun shows candidates > 0
  // const resReal = await backfill({ appId: APP_ID, collectionPath: COLLECTION_PATH, limit: 1000 });
  // console.log("Backfill result:", JSON.stringify(resReal.data, null, 2));

  // C) Single document test (optional)
  if (DOC_ID) {
    const single = httpsCallable(functions, "cacheReferenceMedia");
    console.log(`Caching single doc ${DOC_ID}…`);
    const one = await single({ appId: APP_ID, docPath: COLLECTION_PATH, docId: DOC_ID });
    console.log("Single-doc result:", JSON.stringify(one.data, null, 2));
  }

  console.log("Done.");
}

main().catch(e => {
  console.error("Error:", e?.message || e);
  process.exit(1);
});