// Firebase Functions v2 - Cache reference media from external URLs into Firebase Storage
import { onCall } from "firebase-functions/v2/https";
import { HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { v4 as uuidv4 } from "uuid";

// Initialize Admin SDK once
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

// Compose a non-expiring download URL by setting a token in metadata
function buildDownloadUrl(bucketName, filePath, token) {
  const o = encodeURIComponent(filePath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${o}?alt=media&token=${token}`;
}

export const cacheReferenceMedia = onCall(
  { region: "us-central1", cors: true, enforceAppCheck: false, consumeAppCheckToken: false, memory: "512MiB", timeoutSeconds: 120 },
  async (req) => {
    const { appId, docId, docPath } = req.data || {};
    const uid = req.auth?.uid || null;

    if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
    if (!appId || !docId || !docPath) throw new HttpsError("invalid-argument", "Missing appId, docId, or docPath.");

    // Optional: simple role check (admin/contributor) via allowlist (best-effort)
    try {
      const allowRef = db.doc(`system/allowlist/users/${uid}`);
      const allowSnap = await allowRef.get();
      if (allowSnap.exists) {
        const role = String(allowSnap.get("role") || "").toLowerCase();
        const isAdmin = allowSnap.get("admin") === true || role.startsWith("admin");
        const isContrib = allowSnap.get("contributor") === true || role.startsWith("contrib");
        if (!isAdmin && !isContrib) throw new HttpsError("permission-denied", "Contributor or Admin required.");
      }
    } catch (e) {
      // If allowlist missing, still require auth
    }

    const docRef = db.doc(`${docPath}/${docId}`);
    const snap = await docRef.get();
    if (!snap.exists) throw new HttpsError("not-found", "Assessment not found.");

    const data = snap.data() || {};
    const images = Array.isArray(data?.media?.images) ? data.media.images : [];
    if (!images.length) return { created: 0, skipped: 0 };

    const bucket = storage.bucket(); // default bucket
    const bucketName = bucket.name;
    const basePath = `artifacts/${appId}/public/uploads/${docId}/reference`;

    // Prepare list and avoid re-downloading duplicates by originalUrl
    const already = new Set();
    const assets = Array.isArray(data?.phase2?.assets) ? data.phase2.assets : [];
    for (const a of assets) {
      if (a?.source === "reference" && a?.originalUrl) already.add(String(a.originalUrl));
    }

    let created = 0, skipped = 0;
    const maxConcurrency = 4;
    let index = 0;

    async function processOne(img) {
      const originalUrl = String(img?.url || "").trim();
      if (!originalUrl) { skipped++; return; }
      if (already.has(originalUrl)) { skipped++; return; }

      // Fetch file
      let resp;
      try {
        resp = await fetch(originalUrl, {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": "ProjectGuardian/1.0 (+cacheReferenceMedia)" }
        });
      } catch (e) {
        skipped++; return;
      }
      if (!resp.ok) { skipped++; return; }

      // Determine filename/ext
      const ct = resp.headers.get("content-type") || "";
      const clen = Number(resp.headers.get("content-length") || "0");
      const urlExt = guessExtFromUrl(originalUrl);
      const ctExt = extFromContentType(ct);
      const ext = (urlExt || ctExt || ".jpg").toLowerCase();

      // Prefer a compact base name from title or URL
      const baseName =
        sanitizeFileName(img?.title || originalUrl.split("/").pop() || "image")
          .replace(/\.(png|jpe?g|webp|gif|bmp|tif|tiff|svg)$/i, "");

      const filePath = `${basePath}/${Date.now()}_${baseName}${ext}`;
      const file = bucket.file(filePath);

      // Read stream -> upload stream
      const token = uuidv4();
      const [writeStream] = await Promise.resolve([file.createWriteStream({
        metadata: {
          contentType: ct || undefined,
          metadata: { firebaseStorageDownloadTokens: token }
        },
        resumable: false,
        validation: false
      })]);

      await new Promise((resolve, reject) => {
        resp.body.pipe(writeStream)
          .on("error", reject)
          .on("finish", resolve);
      });

      const url = buildDownloadUrl(bucketName, filePath, token);
      const asset = {
        name: `${baseName}${ext}`,
        path: filePath,
        url,
        contentType: ct || "",
        bytes: clen || undefined,
        uploadedAtMs: Date.now(),
        source: "reference",
        originalUrl,
        title: img?.title || "",
        author: img?.author || "",
        license: img?.license || "",
        sourceUrl: img?.sourceUrl || ""
      };

      // Append to doc
      await docRef.update({
        "phase2.assets": FieldValue.arrayUnion(asset),
        "phase2.assetsUpdatedAt": FieldValue.serverTimestamp()
      });

      created++;
    }

    // Concurrency loop
    const queue = [];
    while (index < images.length) {
      while (queue.length < maxConcurrency && index < images.length) {
        queue.push(processOne(images[index++])); // start next
      }
      await Promise.race(queue).catch(()=>{});
      // remove settled
      for (let i = queue.length - 1; i >= 0; i--) {
        if (Promise.resolve(queue[i]).settled) queue.splice(i, 1);
      }
      // Above trick isn't native; simpler: wait for all in batches
      // For simplicity: break here and do batches of size maxConcurrency:
      if (queue.length >= maxConcurrency || index >= images.length) {
        await Promise.allSettled(queue);
        queue.length = 0;
      }
    }

    return { created, skipped };
  }
);