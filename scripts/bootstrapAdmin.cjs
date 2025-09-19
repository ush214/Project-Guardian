const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// Replace with YOUR uid (already created by signing up once).
const BOOTSTRAP_UID = 'djBC4boCbiWh9npNFYeVzdXUkok1';

(async () => {
  try {
    const user = await admin.auth().getUser(BOOTSTRAP_UID);
    const existing = user.customClaims || {};
    const newClaims = { ...existing, approved: true, admin: true, role: 'admin' };
    await admin.auth().setCustomUserClaims(BOOTSTRAP_UID, newClaims);
    await admin.firestore().doc(`system/approvals/users/${BOOTSTRAP_UID}`).set({
      email: user.email?.toLowerCase(),
      status: 'approved',
      role: 'admin',
      bootstrapped: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.log('Bootstrap admin set:', BOOTSTRAP_UID, newClaims);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
  process.exit(0);
})();