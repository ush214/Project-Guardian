# Monitoring scaffold (Earthquakes, Storms, Oil Spills)

This adds a minimal, production-leaning monitoring pipeline to Project‑Guardian:

- Firebase Functions
  - `monitoringMasterHourly` (hourly): writes a manifest listing all wreck docs into a GCS bucket (RAW bucket) for downstream triggers.
  - `onMonitoringEventWrite` (Firestore trigger): when a monitoring event with `exceeded=true` is written, appends an alert and sets `needsReassessment=true` on the wreck doc.

- Cloud Run services
  - `monitoring-processor` (Node/TS): Fetches USGS Earthquakes (last 6h) and NHC Storms, computes proximity/impact, and writes events to Firestore.
  - `oil-spill-detector` (Python + Earth Engine): Scans Sentinel‑1 GRD for dark slicks near each wreck and writes events, including a thumbnail URL.

- Web UI
  - `public/monitoring.html` + `public/monitoring.js` subscribes to events and alerts for a given `?wreckId=DOC_ID`.

- Firestore
  - Rules to allow public reads and contributor/admin writes for monitoring events and wreck alerts.
  - Composite index on `collectionGroup: events` by `timeMs DESC, source ASC`.

## Data model

Per-wreck monitoring events are written under:

```
{wreckDoc}/monitoring/{type}/events/{eventId}
```

where `type ∈ {earthquakes, storms, oil}`.

Example (earthquake):
```json
{
  "source": "usgs",
  "eventId": "us7000abcd",
  "timeMs": 1737047700000,
  "magnitude": 5.6,
  "lat": 18.4,
  "lng": -66.2,
  "depthKm": 22.0,
  "distanceKm": 84.5,
  "pgaG": 0.12,
  "threshold": 0.10,
  "exceeded": true,
  "message": "USGS M5.6 @ 85km, PGA≈0.12g",
  "createdAtMs": 1737048000000
}
```

When `exceeded=true`, the trigger appends an alert on the wreck root:
```json
{
  "alerts": [
    {
      "sourceType": "earthquakes",
      "eventId": "us7000abcd",
      "message": "USGS M5.6 @ 85km, PGA≈0.12g",
      "exceeded": true,
      "acknowledged": false,
      "timeMs": 1737047700000,
      "createdAtMs": 1737048000000,
      "createdBy": "monitoring-trigger"
    }
  ],
  "needsReassessment": true,
  "alertsUpdatedAt": "<serverTimestamp>"
}
```

## Sources and thresholds

- Earthquakes (USGS FDSN GeoJSON, last 6h, minmag 4.5)
  - Prefer MMI→PGA approximation. Exceeded if `pgaG ≥ 0.10`.

- Storms (NHC current storms JSON or equivalent)
  - Shallow wrecks (<50m): exceeded if `sustainedWindKt ≥ 64` within `100 km`.
  - Deep wrecks (≥50m or unknown): exceeded if `waveHeightM ≥ 6` OR `sustainedWindKt ≥ 64` (duration placeholder).

- Oil Spills (Sentinel‑1)
  - Dark-spot detection using adaptive percentile on VV/VH and simple morphology.
  - Exceeded if `(area≥0.5 km² within 5 km)` OR `(area≥0.2 km² within 10 km)`.
  - Severity: `critical | warning | info`.

## Deployment

1) Enable required APIs
- Cloud Run, Cloud Build, Eventarc, Firestore (in Native mode), Cloud Scheduler, Cloud Storage.
- Earth Engine: link your GCP project to Earth Engine and grant the Cloud Run service account access.

2) Create RAW bucket for manifests
```
gsutil mb -l us-central1 gs://<your-raw-bucket>
```

3) Deploy Cloud Run services
Use `scripts/deploy-monitoring.sh` as a guided reference (edit PROJECT_ID/REGION/RAW_BUCKET).

4) Deploy Firebase Functions
- Ensure environment variables: `APP_ID=guardian`, `RAW_BUCKET=<your-raw-bucket>`.
- Deploy your functions via Firebase CLI or gcloud (2nd gen). Example:
```
gcloud functions deploy monitoringMasterHourly --gen2 --runtime=nodejs20 --region=us-central1 \
  --entry-point=monitoringMasterHourly --trigger-topic=monitoring-hourly \
  --set-env-vars APP_ID=guardian,RAW_BUCKET=<your-raw-bucket>

gcloud functions deploy onMonitoringEventWrite --gen2 --runtime=nodejs20 --region=us-central1 \
  --entry-point=onMonitoringEventWrite \
  --trigger-event-filters="type=google.cloud.firestore.document.v1.written" \
  --trigger-event-filters="document=**" \
  --set-env-vars APP_ID=guardian,RAW_BUCKET=<your-raw-bucket>
```

5) Create Cloud Scheduler jobs
- Hourly Pub/Sub job to the `monitoring-hourly` topic for `monitoringMasterHourly`.
- Optional: HTTP job every 6h to POST `/run` on the `oil-spill-detector`.

6) Eventarc trigger (optional)
- GCS finalize on `manifests/*` in RAW bucket -> `monitoring-processor` service.

7) Firestore config
- Deploy `firestore.rules` and `firestore.indexes.json`:
```
firebase deploy --only firestore
```

## UI usage

Open:
```
/public/monitoring.html?wreckId=<DOC_ID>
```

The page shows alerts and subscribes to `earthquakes`, `storms`, `oil` subcollections ordered by `timeMs desc limit 50`. Acknowledge alerts via the UI (array replacement strategy).

## Notes

- These services use ADC—no secrets are checked into the repo.
- `monitoring-processor` includes graceful no-ops when upstream feeds are unavailable.
- Earth Engine dark-spot logic is intentionally simple for a scaffold; refine thresholds and morphology as needed.