// Firebase Functions v2 — no-hotlinking: cache reference images into Storage.
// Now scans multiple fields for image URLs, including arrays, common key names, and HTML/Markdown content.
// Requires Blaze plan for outbound HTTP.
//
// Deploy:
//   firebase deploy --only functions:autoCacheReferenceMedia,functions:cacheCollectionReferenceMedia,functions:cacheReferenceMedia
//
// Note: For onCall to work from the browser, ensure the Cloud Run service for this function allows roles/run.invoker to allUsers.
// We still enforce Firebase Auth and role checks inside the callable.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { v4 as uuidv4 } from "uuid";
import { db, storage } from "./admin.js";
// ---------- Helpers: URL and image candidate discovery ----------
const IMG_EXT_RX = /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)(?:\?|#|$)/i;
function isHttpUrl(u) {
    if (typeof u !== "string")
        return false;
    const s = u.trim();
    if (!s || s.startsWith("data:") || s.startsWith("blob:"))
        return false;
    return /^https?:\/\//i.test(s);
}
function looksLikeImageUrl(u) {
    return isHttpUrl(u) && IMG_EXT_RX.test(u);
}
function unique(arr) {
    const seen = new Set();
    const out = [];
    for (const v of arr) {
        const k = String(v || "");
        if (!k || seen.has(k))
            continue;
        seen.add(k);
        out.push(v);
    }
    return out;
}
function sanitizeFileName(name = "") {
    return String(name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 140) || `file_${Date.now()}`;
}
function guessExtFromUrl(url = "") {
    const m = String(url).toLowerCase().match(/\.(png|jpe?g|webp|gif|bmp|tif|tiff|svg)(?:\?|#|$)/i);
    return m ? `.${m[1].replace("jpeg", "jpg")}` : "";
}
function extFromContentType(ct = "") {
    const map = {
        "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
        "image/gif": ".gif", "image/bmp": ".bmp", "image/tiff": ".tif", "image/svg+xml": ".svg"
    };
    return map[ct] || "";
}
function buildDownloadUrl(bucketName, filePath, token) {
    const o = encodeURIComponent(filePath);
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${o}?alt=media&token=${token}`;
}
// Extract image URLs from strings (plain URL, HTML img, or Markdown image)
function extractImageUrlsFromText(text) {
    const out = [];
    const s = String(text || "");
    if (!s)
        return out;
    // Markdown ![alt](url)
    const md = [...s.matchAll(/!\[[^\]]*]\((https?:\/\/[^\s)]+)\)/gi)].map(m => m[1]);
    // HTML <img src="url">
    const html = [...s.matchAll(/<img[^>]+src=['"]([^'"]+)['"]/gi)].map(m => m[1]);
    // Plain http(s) URLs
    const plain = [...s.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)].map(m => m[0]);
    for (const u of [...md, ...html, ...plain]) {
        if (looksLikeImageUrl(u))
            out.push(u);
    }
    return unique(out);
}
// Walk common fields to collect image URLs
function collectImageCandidates(data) {
    const urls = [];
    // 1) Direct arrays on common paths
    const arraysToCheck = [
        ["media", "images"], ["media", "photos"], ["media", "gallery"],
        ["images"], ["photos"], ["gallery"],
        ["media", "reference"], ["media", "referenceMedia"], ["referenceMedia"], ["references"]
    ];
    function deepGet(obj, pathArr) {
        return pathArr.reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), obj);
    }
    for (const path of arraysToCheck) {
        const arr = deepGet(data, path);
        if (Array.isArray(arr)) {
            for (const item of arr) {
                if (typeof item === "string" && looksLikeImageUrl(item)) {
                    urls.push(item);
                }
                else if (item && typeof item === "object") {
                    const candidates = [item.url, item.href, item.src, item.imageUrl, item.thumbnail, item.thumb, item.picture, item.pic];
                    for (const c of candidates)
                        if (looksLikeImageUrl(c))
                            urls.push(c);
                    // Sometimes nested object { link: { href } }
                    if (item.link && typeof item.link === "object") {
                        const c2 = [item.link.url, item.link.href, item.link.src];
                        for (const c of c2)
                            if (looksLikeImageUrl(c))
                                urls.push(c);
                    }
                }
            }
        }
    }
    // 2) Text fields that may embed images
    const textFields = [
        "reportHtml", "report", "html", "markdown", "md", "content", "body",
        "summary", "notes", "description",
        "phase1", "phase2", "phase3"
    ];
    for (const tf of textFields) {
        const val = data?.[tf];
        if (!val)
            continue;
        if (typeof val === "string") {
            urls.push(...extractImageUrlsFromText(val));
        }
        else if (typeof val === "object") {
            // dive one level and extract strings
            for (const v of Object.values(val)) {
                if (typeof v === "string")
                    urls.push(...extractImageUrlsFromText(v));
            }
        }
    }
    // 3) Fallback: any top-level string fields with image URLs
    for (const [k, v] of Object.entries(data || {})) {
        if (typeof v === "string" && looksLikeImageUrl(v))
            urls.push(v);
    }
    return unique(urls);
}
// ---------- Storage fetch/save ----------
async function downloadAndSaveImage(bucket, basePath, img) {
    const originalUrl = String(img?.url || "").trim();
    if (!originalUrl)
        return null;
    let resp;
    try {
        // Node.js 20: global fetch available
        resp = await fetch(originalUrl, {
            method: "GET",
            redirect: "follow",
            headers: { "User-Agent": "ProjectGuardian/1.0 (+cacheReferenceMedia)" }
        });
    }
    catch {
        return null;
    }
    if (!resp || !resp.ok)
        return null;
    let buffer;
    try {
        const ab = await resp.arrayBuffer();
        buffer = Buffer.from(ab);
    }
    catch {
        return null;
    }
    const ct = resp.headers?.get ? (resp.headers.get("content-type") || "") : "";
    if (ct && !ct.startsWith("image/"))
        return null;
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
        if (!k || seen.has(k))
            continue;
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push(it);
    }
    return out;
}
// ---------- Core cache logic ----------
async function cacheImagesForDoc({ appId, docPath, docId }) {
    const docRef = db.doc(`${docPath}/${docId}`);
    const snap = await docRef.get();
    if (!snap.exists)
        return { created: 0, skipped: 0, candidates: 0 };
    const data = snap.data() || {};
    // Collect candidates from the document
    const candidateUrls = collectImageCandidates(data);
    const candidates = candidateUrls.map(u => ({ url: u, title: "", sourceUrl: u }));
    if (!candidates.length) {
        // No images found to cache
        return { created: 0, skipped: 0, candidates: 0 };
    }
    const assets = Array.isArray(data?.phase2?.assets) ? data.phase2.assets : [];
    const existingOriginals = new Set(assets.filter(a => a?.source === "reference" && a?.originalUrl)
        .map(a => String(a.originalUrl)));
    const toCache = uniqueBy(candidates.filter(m => m?.url).map(m => ({ ...m, url: String(m.url) })), (m) => m.url).filter(m => !existingOriginals.has(m.url));
    if (!toCache.length) {
        // All candidates already present
        return { created: 0, skipped: candidates.length, candidates: candidates.length };
    }
    const bucket = storage.bucket();
    const basePath = `artifacts/${appId}/public/uploads/${docId}/reference`;
    let created = 0;
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
    const skipped = candidates.length - created;
    return { created, skipped, candidates: candidates.length };
}
// ---------- Callables ----------
// Backfill entire collection after import, with diagnostics
export const cacheCollectionReferenceMedia = onCall({ region: "us-central1", cors: true, memory: "1GiB", timeoutSeconds: 540 }, async (req) => {
    const { appId, collectionPath, limit = 300, dryRun = false } = req.data || {};
    const uid = req.auth?.uid || null;
    if (!uid)
        throw new HttpsError("unauthenticated", "Sign-in required.");
    if (!appId || !collectionPath)
        throw new HttpsError("invalid-argument", "Missing appId or collectionPath.");
    // Role gate: admin or contributor
    try {
        const allowRef = db.doc(`system/allowlist/users/${uid}`);
        const allowSnap = await allowRef.get();
        if (allowSnap.exists) {
            const role = String(allowSnap.get("role") || "").toLowerCase();
            const isAdmin = allowSnap.get("admin") === true || role.startsWith("admin");
            const isContrib = allowSnap.get("contributor") === true || role.startsWith("contrib");
            if (!isAdmin && !isContrib)
                throw new HttpsError("permission-denied", "Contributor or Admin required.");
        }
    }
    catch { }
    const colRef = db.collection(collectionPath);
    const snap = await colRef.limit(Math.max(1, Math.min(2000, Number(limit) || 300))).get();
    let processed = 0, created = 0, skipped = 0, candidateTotal = 0, docsWithCandidates = 0;
    const samplesWith = [];
    const samplesNone = [];
    for (const docSnap of snap.docs) {
        const docId = docSnap.id;
        const data = docSnap.data() || {};
        const candidates = collectImageCandidates(data);
        candidateTotal += candidates.length;
        if (candidates.length) {
            docsWithCandidates++;
            if (samplesWith.length < 10)
                samplesWith.push({ docId, candidates: candidates.slice(0, 5) });
        }
        else {
            if (samplesNone.length < 10)
                samplesNone.push({ docId });
        }
        if (!dryRun && candidates.length) {
            const res = await cacheImagesForDoc({ appId, docPath: collectionPath, docId });
            created += res.created || 0;
            skipped += res.skipped || 0;
        }
        processed++;
    }
    return {
        processed, created, skipped,
        candidateTotal, docsWithCandidates,
        samples: { withCandidates: samplesWith, withNone: samplesNone }
    };
});
// Single-doc cache helper for quick testing
export const cacheReferenceMedia = onCall({ region: "us-central1", cors: true, memory: "512MiB", timeoutSeconds: 180 }, async (req) => {
    const { appId, docPath, docId } = req.data || {};
    const uid = req.auth?.uid || null;
    if (!uid)
        throw new HttpsError("unauthenticated", "Sign-in required.");
    if (!appId || !docPath || !docId)
        throw new HttpsError("invalid-argument", "Missing appId, docPath, or docId.");
    // Role gate
    try {
        const allowRef = db.doc(`system/allowlist/users/${uid}`);
        const allowSnap = await allowRef.get();
        if (allowSnap.exists) {
            const role = String(allowSnap.get("role") || "").toLowerCase();
            const isAdmin = allowSnap.get("admin") === true || role.startsWith("admin");
            const isContrib = allowSnap.get("contributor") === true || role.startsWith("contrib");
            if (!isAdmin && !isContrib)
                throw new HttpsError("permission-denied", "Contributor or Admin required.");
        }
    }
    catch { }
    const res = await cacheImagesForDoc({ appId, docPath, docId });
    return res;
});
// ---------- Firestore trigger (unchanged contract) ----------
export const autoCacheReferenceMedia = onDocumentWritten({
    region: "us-central1",
    document: "artifacts/{appNs}/public/data/werpassessments/{docId}",
    memory: "512MiB",
    timeoutSeconds: 300
}, async (event) => {
    const after = event.data?.after?.data();
    if (!after)
        return;
    const appNs = event.params.appNs;
    const docId = event.params.docId;
    const docPath = `artifacts/${appNs}/public/data/werpassessments`;
    const appId = "guardian";
    // Run only if we can find at least one candidate (fast check)
    const candidates = collectImageCandidates(after);
    if (!candidates.length)
        return;
    try {
        await cacheImagesForDoc({ appId, docPath, docId });
    }
    catch (e) {
        console.error("autoCacheReferenceMedia error", docPath, docId, e?.message || e);
    }
});
// Import and export new functions
export { analyzeWerps } from "./analyzeWerps.js";
export { reassessWerps } from "./reassessWerps.js";
