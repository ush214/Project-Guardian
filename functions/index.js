// Firebase Functions v2 — no-hotlinking: cache reference images into Storage.
// Requires Blaze plan for outbound HTTP. Uses onCall with CORS enabled.
// Deploy: firebase deploy --only functions:autoCacheReferenceMedia,functions:cacheCollectionReferenceMedia

import { onCall } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { v4 as uuidv4 } from "uuid";

initializeApp();
const db = getFirestore();
const storage = getStorage();

function sanitizeFileName(name = "") {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 140) || `file_${Date.now()}`;
}
function guessExtFromUrl(url = "") {
  const m = String(url).toLowerCase().match(/\.(png|jpe?g|webp|gif|bmp|tif|tiff|svg)(?:\?|#|$)/i);
  return m ? `.${m[1].replace("jpeg","jpg")}` : "";
}
function extFromContentType(ct = "") {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tif",
    "image/svg+xml": ".svg"
  };
  return map[ct] || "";
}
function buildDownloadUrl(bucketName, filePath, token) {
  const o = encodeURIComponent(filePath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${o}?alt=media&token=${token}`;
}

async function downloadAndSaveImage(bucket, basePath, img) {
  const originalUrl = String(img?.url || "").trim();
  if (!originalUrl) return null;

  // Node 20 global fetch
  let resp;
  try {
    resp = await fetch(originalUrl, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "ProjectGuardian/1.0 (+cacheReferenceMedia)" }
    });
  } catch {
    return null;
  }
  if (!resp || !resp.ok) return null;

  let buffer;
  try {
    const ab = await resp.arrayBuffer();
    buffer = Buffer.from(ab);
  } catch {
    return null;
  }

  const ct = resp.headers?.get ? (resp.headers.get("content-type") || "") : "";
  if (ct && !ct.startsWith("image/")) return null;

  const urlExt = guessExtFromUrl(originalUrl);
  const ctExt = extFromContentType(ct);
  const ext = (urlExt || ctExt || ".jpg").toLowerCase();

  const baseName = sanitizeFileName(img?.title || originalUrl.split("/").pop() || "image")
    .replace(/\.(png|jpe?g|webp|gif|bmp|tif|tiff|svg)$/i, "");
  const filePath = `${basePath}/${Date.now()}_${baseName}${ext}`;
  const file = bucket.file(filePath);
  const token = uuidv4();

  await file.save(buffer, {
    contentType: ct || undefined,
    resumable: false,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } }
  });

  const url = buildDownloadUrl(bucket.name, filePath, token);
  return {
    name: `${baseName}${ext}`,
    path: filePath,
    url,
    contentType: ct || "",
    bytes: buffer.byteLength || undefined,
    uploadedAtMs: Date.now(),
    source: "reference",
    originalUrl,
    title: img?.title || "",
    author: img?.author || "",
    license: img?.license || "",
    sourceUrl: img?.sourceUrl || ""
  };
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function cacheImagesForDoc({ appId, docPath, docId }) {
  const docRef = db.doc(`${docPath}/${docId}`);
  const snap = await docRef.get();
  if (!snap.exists) return { created: 0, skipped: 0 };

  const data = snap.data() || {};
  const imgs = Array.isArray(data?.media?.images) ? data.media.images : [];
  if (!imgs.length) return { created: 0, skipped: 0 };

  const assets = Array.isArray(data?.phase2?.assets) ? data.phase2.assets : [];
  const existingOriginals = new Set(
    assets.filter(a => a?.source === "reference" && a?.originalUrl)
          .map(a => String(a.originalUrl))
  );

  const toCache = uniqueBy(
    imgs.filter(m => m?.url).map(m => ({ ...m, url: String(m.url) })),
    (m) => m.url
  ).filter(m => !existingOriginals.has(m.url));

  if (!toCache.length) {
    return { created: 0, skipped: imgs.length };
  }

  const bucket = storage.bucket();
  const basePath = `artifacts/${appId}/public/uploads/${docId}/reference`;

  let created = 0;
  let skipped = imgs.length - toCache.length;

  const BATCH = 4;
  for (let i = 0; i < toCache.length; i += BATCH) {
    const slice = toCache.slice(i, i + BATCH);
    const saved = await Promise.all(slice.map(img => downloadAndSaveImage(bucket, basePath, img)));
    const good = saved.filter(Boolean);
    if (good.length) {
      await docRef.update({
        "phase2.assets": FieldValue.arrayUnion(...good),
        "phase2.assetsUpdatedAt": FieldValue.serverTimestamp(),
        "media.cachedAt": FieldValue.serverTimestamp()
      });
      created += good.length;
    }
  }

  return { created, skipped };
}

// Backfill entire collection after import
export const cacheCollectionReferenceMedia = onCall(
  { region: "us-central1", cors: true, memory: "1GiB", timeoutSeconds: 540 },
  async (req) => {
    const { appId, collectionPath, limit = 300 } = req.data || {};
    const uid = req.auth?.uid || null;

    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    if (!appId || !collectionPath) throw new HttpsError("invalid-argument", "Missing appId or collectionPath.");

    // Role gate (best effort)
    try {
      const allowRef = db.doc(`system/allowlist/users/${uid}`);
      const allowSnap = await allowRef.get();
      if (allowSnap.exists) {
        const role = String(allowSnap.get("role") || "").toLowerCase();
        const isAdmin = allowSnap.get("admin") === true || role.startsWith("admin");
        const isContrib = allowSnap.get("contributor") === true || role.startsWith("contrib");
        if (!isAdmin && !isContrib) throw new HttpsError("permission-denied", "Contributor or Admin required.");
      }
    } catch {}

    const colRef = db.collection(collectionPath);
    const snap = await colRef.limit(Math.max(1, Math.min(2000, Number(limit) || 300))).get();

    let processed = 0, created = 0, skipped = 0;
    for (const docSnap of snap.docs) {
      const docId = docSnap.id;
      const res = await cacheImagesForDoc({ appId, docPath: collectionPath, docId });
      processed++;
      created += res.created || 0;
      skipped += res.skipped || 0;
    }
    return { processed, created, skipped };
  }
);

// Auto-cache on create/update
export const autoCacheReferenceMedia = onDocumentWritten(
  {
    region: "us-central1",
    document: "artifacts/{appNs}/public/data/werpassessments/{docId}",
    memory: "512MiB",
    timeoutSeconds: 300
  },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return;

    const appNs = event.params.appNs;
    const docId = event.params.docId;
    const docPath = `artifacts/${appNs}/public/data/werpassessments`;
    const appId = "guardian";

    const hasImages = Array.isArray(after?.media?.images) && after.media.images.length > 0;
    if (!hasImages) return;

    const hasCachedMarker = !!after?.media?.cachedAt;
    const assetRef = Array.isArray(after?.phase2?.assets) ? after.phase2.assets : [];
    const hasReferenceAssets = assetRef.some(a => a?.source === "reference");

    if (hasCachedMarker && hasReferenceAssets) return;

    try {
      await cacheImagesForDoc({ appId, docPath, docId });
    } catch (e) {
      console.error("autoCacheReferenceMedia error", docPath, docId, e?.message || e);
    }
  }
);