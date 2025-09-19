/**
 * Handles user creation -> set custom claims approved:false and write approval doc.
 * Provides a callable to approve/promote a user.
 */
import * as admin from 'firebase-admin';
import { onCall } from 'firebase-functions/v2/https';
import { onUserCreated } from 'firebase-functions/v2/auth';
import { FieldValue } from 'firebase-admin/firestore';

admin.initializeApp();

/**
 * Auth trigger: every new user becomes pending (approved:false).
 */
export const onUserCreateSetPending = onUserCreated(async (event) => {
  const user = event.data;
  if (!user.uid || !user.email) return;

  const uid = user.uid;
  const email = user.email.toLowerCase();

  // Firestore tracking doc
  await admin.firestore().doc(`system/approvals/users/${uid}`).set({
    email,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp()
  }, { merge: true });

  // Set initial claims
  await admin.auth().setCustomUserClaims(uid, {
    approved: false
  });

  // (Optional) log
  console.log('User created -> pending:', uid, email);
});

/**
 * Callable: approve a user and optionally grant admin role.
 * Security: Caller must already have admin custom claim.
 * Data payload: { uid: string, role?: 'admin' | 'user' }
 */
export const approveUser = onCall(async (request) => {
  if (!request.auth?.token?.admin) {
    throw new Error('permission-denied: admin only');
  }
  const { uid, role } = request.data || {};
  if (!uid) throw new Error('invalid-argument: uid required');

  const claims: Record<string, any> = { approved: true };
  if (role === 'admin') claims.admin = true;
  if (role) claims.role = role;

  await admin.auth().setCustomUserClaims(uid, claims);

  await admin.firestore().doc(`system/approvals/users/${uid}`).set({
    status: 'approved',
    role: role || 'user',
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  console.log('Approved user', uid, claims);
  return { ok: true, claims };
});

/**
 * Callable: revoke approval or demote.
 * Data: { uid: string, removeAdmin?: boolean }
 */
export const revokeUser = onCall(async (request) => {
  if (!request.auth?.token?.admin) {
    throw new Error('permission-denied: admin only');
  }
  const { uid, removeAdmin } = request.data || {};
  if (!uid) throw new Error('invalid-argument: uid required');

  // Read existing claims to decide what to keep
  const user = await admin.auth().getUser(uid);
  const existing = user.customClaims || {};
  const newClaims: Record<string, any> = {};

  // Remove approval
  // (If you wanted "suspend" vs revoke you could set approved:false instead of deleting)
  if (existing.approved) {
    // nothing retained
  }
  if (existing.admin && !removeAdmin) {
    // keep admin but force unapproved? Decide your semantics. We'll remove admin if revoked.
  }

  await admin.auth().setCustomUserClaims(uid, newClaims);

  await admin.firestore().doc(`system/approvals/users/${uid}`).set({
    status: 'revoked',
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  console.log('Revoked user', uid);
  return { ok: true };
});