// Monitoring bootstrap: mounts the Monitoring panel on pages that include a
// <div id="monitoring-panel">. It tries to detect the current wreckId from:
// 1) data-wreck-id attribute on #monitoring-panel
// 2) URL query param ?wreckId=...
// 3) URL hash #wreckId=...
//
// It reuses an existing Firebase app if already initialized, otherwise uses
// window.firebaseConfig to initialize a new app. Then it passes projectId and
// Firestore db to the monitoring-ui module.

function getQueryParam(name) {
  const m = new URLSearchParams(window.location.search).get(name);
  return m || null;
}

function getHashParam(name) {
  const hash = window.location.hash || "";
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!trimmed) return null;
  const kv = new URLSearchParams(trimmed);
  return kv.get(name) || null;
}

function detectWreckId() {
  const panel = document.getElementById("monitoring-panel");
  if (panel && panel.dataset && panel.dataset.wreckId) {
    return panel.dataset.wreckId;
  }
  return getQueryParam("wreckId") || getHashParam("wreckId") || null;
}

async function ensureFirebase() {
  // Prefer existing app if already initialized by your app.
  // Try modular v9+ first; if unavailable, fall back to namespaced v8 if present.
  try {
    const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    if (getApps().length === 0) {
      const cfg = window.firebaseConfig;
      if (!cfg) {
        throw new Error("No existing Firebase app and window.firebaseConfig not found.");
      }
      initializeApp(cfg);
    }
    const { getFirestore } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const { getApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    const app = getApp();
    const db = getFirestore(app);
    const projectId = (app.options && app.options.projectId) || (window.firebaseConfig && window.firebaseConfig.projectId);
    if (!projectId) {
      throw new Error("Could not determine projectId from Firebase app options.");
    }
    return { db, projectId };
  } catch (e) {
    // Fallback to namespaced (v8) if available on window
    if (window.firebase && window.firebase.firestore) {
      const app = window.firebase.app();
      const db = window.firebase.firestore();
      const projectId =
        (app && app.options && app.options.projectId) ||
        (window.firebaseConfig && window.firebaseConfig.projectId);
      if (!projectId) throw e;
      return { db, projectId };
    }
    throw e;
  }
}

(async function bootstrap() {
  const panel = document.getElementById("monitoring-panel");
  if (!panel) {
    // Nothing to do on this page
    return;
  }
  const wreckId = detectWreckId();
  if (!wreckId) {
    // If wreckId is not present, keep the panel hidden to avoid errors.
    panel.style.display = "none";
    console.warn("[Monitoring] No wreckId found. Add data-wreck-id to #monitoring-panel or pass ?wreckId=...");
    return;
  }

  try {
    const { db, projectId } = await ensureFirebase();
    const { initMonitoring, mountMonitoringPanel } = await import("/monitoring-ui.js");
    // If your functions are in a different region, change here (default is us-central1)
    const region = "us-central1";
    initMonitoring({ db, projectId, region });

    // Show the panel and mount
    panel.style.display = "";
    mountMonitoringPanel({ container: panel, wreckId });
  } catch (err) {
    console.error("[Monitoring] Failed to initialize", err);
    if (panel) {
      panel.innerHTML = `
        <div style="padding: 12px; border: 1px solid #eee; border-radius: 6px; background: #fff5f5; color: #b71c1c;">
          Monitoring failed to initialize. See console for details.
        </div>
      `;
    }
  }
})();