import express from 'express';
import axios from 'axios';
import { Firestore } from '@google-cloud/firestore';

const app = express();
app.use(express.json({ limit: '1mb' }));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// Must match functions' READ_COLLECTIONS
const READ_COLLECTIONS = [
  'artifacts/guardian/public/data/werpassessments',
  'artifacts/guardian-agent-default/public/data/werpassessments',
];

type LatLng = { lat: number; lng: number };

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return R * c;
}

function pickLatLng(doc: any): LatLng | null {
  // Try common shapes
  const candidates: any[] = [
    doc?.phase1?.screening?.coordinates,
    doc?.coordinates,
    doc?.location?.coordinates,
    doc?.historical?.location?.coordinates,
    doc?.geometry?.coordinates,
    doc?.geo?.coordinates,
    doc?.position?.coordinates,
    doc?.geo,
    doc?.position,
    doc?.geometry,
  ];
  for (const c of candidates) {
    if (!c) continue;
    // Array [lng, lat]
    if (Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])) {
      const lng = Number(c[0]);
      const lat = Number(c[1]);
      if (isFinite(lat) && isFinite(lng)) return { lat, lng };
    }
    // Object {lat,lng} or {latitude,longitude}
    if (typeof c === 'object') {
      const lat = Number(c.lat ?? c.latitude);
      const lng = Number(c.lng ?? c.longitude);
      if (isFinite(lat) && isFinite(lng)) return { lat, lng };
    }
  }
  return null;
}

async function loadWrecks(): Promise<
  Array<{ id: string; path: string; data: any; coords: LatLng | null }>
> {
  const out: Array<{ id: string; path: string; data: any; coords: LatLng | null }> = [];
  for (const colPath of READ_COLLECTIONS) {
    const colRef = db.collection(colPath);
    const docRefs = await colRef.listDocuments();
    const snaps = await db.getAll(...docRefs);
    for (const s of snaps) {
      if (!s.exists) continue;
      const data = s.data();
      const coords = pickLatLng(data);
      out.push({ id: s.id, path: s.ref.path, data, coords });
    }
  }
  return out;
}

// Approximate MMI -> PGA (g)
function mmiToPgaG(mmi?: number): number | null {
  if (mmi == null || !isFinite(mmi)) return null;
  // Rough mapping: VI~0.06g, VII~0.12g, VIII~0.22g
  if (mmi < 6) return 0.03;
  if (mmi < 7) return 0.06;
  if (mmi < 8) return 0.12;
  if (mmi < 9) return 0.22;
  return 0.30;
}

async function processEarthquakes(wrecks: Awaited<ReturnType<typeof loadWrecks>>) {
  const end = new Date();
  const start = new Date(end.getTime() - 6 * 3600 * 1000);
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start.toISOString()}&endtime=${end.toISOString()}&minmagnitude=4.5`;
  const res = await axios.get(url, { timeout: 20000 });
  const features = res.data?.features || [];

  for (const w of wrecks) {
    if (!w.coords) continue;

    for (const f of features) {
      const props = f?.properties || {};
      const coords = f?.geometry?.coordinates || []; // [lng,lat,depth]
      const eq = {
        id: String(f?.id ?? props?.code ?? props?.ids ?? `${props?.time}`),
        timeMs: Number(props?.time) || Date.now(),
        magnitude: Number(props?.mag) || null,
        lat: Number(coords?.[1]),
        lng: Number(coords?.[0]),
        depthKm: Number(coords?.[2]) || null,
        mmi: props?.mmi != null ? Number(props?.mmi) : null
      };

      const distanceKm = haversineKm(w.coords, { lat: eq.lat, lng: eq.lng });
      let pgaG = mmiToPgaG(eq.mmi || undefined);

      if (pgaG == null) {
        // Very crude fallback: stronger if closer and larger magnitude
        if (eq.magnitude && distanceKm) {
          const score = eq.magnitude / Math.max(10, distanceKm); // not physical, placeholder
          pgaG = score >= 0.1 ? 0.12 : score >= 0.05 ? 0.08 : 0.04;
        } else {
          pgaG = 0.04;
        }
      }

      const exceeded = pgaG >= 0.10;
      const message = `USGS M${eq.magnitude ?? '?'} @ ${distanceKm.toFixed(
        0
      )}km, PGA≈${pgaG.toFixed(2)}g`;

      const eventDoc = {
        source: 'usgs',
        eventId: eq.id,
        timeMs: eq.timeMs,
        magnitude: eq.magnitude,
        lat: eq.lat,
        lng: eq.lng,
        depthKm: eq.depthKm,
        distanceKm,
        pgaG,
        threshold: 0.10,
        exceeded,
        message,
        createdAtMs: Date.now()
      };

      const docRef = db.doc(`${w.path}/monitoring/earthquakes/events/${eq.id}`);
      await docRef.set(eventDoc, { merge: true });
    }
  }
}

async function processStorms(wrecks: Awaited<ReturnType<typeof loadWrecks>>) {
  // NHC current storms JSON (subject to availability)
  // If unavailable, this will no-op gracefully.
  const url = 'https://www.nhc.noaa.gov/CurrentStorms.json';
  let storms: any[] = [];
  try {
    const res = await axios.get(url, { timeout: 20000 });
    storms = Array.isArray(res.data) ? res.data : res.data?.storms || [];
  } catch (e) {
    console.warn('[storms] Could not fetch NHC feed; skipping storm processing.');
    return;
  }

  for (const w of wrecks) {
    if (!w.coords) continue;

    const depthM =
      Number(w.data?.water_depth_m) ||
      Number(w.data?.depth_m) ||
      Number(w.data?.depth) ||
      null;

    for (const s of storms) {
      // Normalize a center position (lat,lon)
      const lat = Number(s?.lat ?? s?.latitude);
      const lng = Number(s?.lon ?? s?.lng ?? s?.longitude);
      if (!isFinite(lat) || !isFinite(lng)) continue;

      const sustainedWindKt = Number(s?.windspeed ?? s?.sustainedWindKt ?? s?.windKt ?? s?.wind);
      const waveHeightM =
        s?.waveHeightM != null ? Number(s?.waveHeightM) : s?.seasFt ? Number(s?.seasFt) * 0.3048 : null;

      const timeMs = s?.timeMs ? Number(s.timeMs) : Date.now();
      const distanceKm = haversineKm(w.coords, { lat, lng });

      const shallow = depthM != null ? depthM < 50 : false;
      let exceeded = false;
      let threshold = '';

      if (shallow) {
        exceeded = isFinite(sustainedWindKt) && sustainedWindKt >= 64 && distanceKm <= 100;
        threshold = 'shallow: wind >= 64kt within 100km';
      } else {
        const windEx = isFinite(sustainedWindKt) && sustainedWindKt >= 64;
        const waveEx = isFinite(waveHeightM as any) && (waveHeightM as number) >= 6;
        exceeded = !!(windEx || waveEx); // duration placeholder
        threshold = 'deep: wave >= 6m OR wind >= 64kt (duration placeholder)';
      }

      const message = `Storm @ ${distanceKm.toFixed(0)}km, wind ${isFinite(sustainedWindKt) ? sustainedWindKt : '?'} kt${
        waveHeightM != null ? `, waves ${waveHeightM.toFixed(1)} m` : ''
      }`;

      const eventId = String(s?.id ?? `${timeMs}-${Math.round(lat * 100)}_${Math.round(lng * 100)}`);

      const eventDoc = {
        source: 'nhc',
        eventId,
        timeMs,
        lat,
        lng,
        sustainedWindKt: isFinite(sustainedWindKt) ? sustainedWindKt : null,
        waveHeightM: isFinite(waveHeightM as any) ? (waveHeightM as number) : null,
        closestDistanceKm: distanceKm,
        wreckDepthM: depthM,
        threshold,
        exceeded,
        message,
        createdAtMs: Date.now()
      };

      const docRef = db.doc(`${w.path}/monitoring/storms/events/${eventId}`);
      await docRef.set(eventDoc, { merge: true });
    }
  }
}

async function runOnce() {
  const started = Date.now();
  const wrecks = await loadWrecks();
  console.log(`[run] Loaded ${wrecks.length} wrecks`);

  await processEarthquakes(wrecks);
  await processStorms(wrecks);

  return { ok: true, elapsedMs: Date.now() - started };
}

app.get('/', (_req, res) => res.status(200).send('ok'));
app.post('/run', async (_req, res) => {
  try {
    const r = await runOnce();
    res.status(200).json({ ok: true, elapsed_s: r.elapsedMs / 1000 });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`monitoring-processor listening on :${PORT}`));