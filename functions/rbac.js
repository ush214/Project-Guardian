// rbac.js — Shared role resolution for Cloud Functions (Admin SDK side)

/**
 * Map allowlist document data to a canonical role string.
 * Recognizes boolean flags (admin/contributor/allowed) and a string Role/role/ROLE.
 */
export function roleFromAllowlistData(d = {}) {
  if (!d || typeof d !== 'object') return 'user';
  if (d.admin === true) return 'admin';
  if (d.contributor === true) return 'contributor';

  // Role string fallback
  let r = d.role ?? d.Role ?? d.ROLE;
  if (typeof r === 'string' && r.trim()) {
    r = r.trim().toLowerCase();
    if (r.startsWith('admin')) return 'admin';
    if (r.startsWith('contrib')) return 'contributor';
    if (['user', 'reader', 'viewer', 'allowed'].includes(r)) return 'user';
  }

  if (d.allowed === true) return 'user';
  return 'user';
}

/**
 * Read allowlist and return role ('admin' | 'contributor' | 'user')
 * db: Firestore Admin instance
 * uid: string
 */
export async function getRoleByUid(db, uid) {
  try {
    const snap = await db.doc(`system/allowlist/users/${uid}`).get();
    if (!snap.exists) return 'user';
    return roleFromAllowlistData(snap.data() || {});
  } catch (e) {
    console.error('[rbac] getRoleByUid failed', e);
    return 'user';
  }
}

export function isAdminRole(role) {
  return role === 'admin';
}
export function isContributorRole(role) {
  return role === 'admin' || role === 'contributor';
}