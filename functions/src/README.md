# Monitoring Functions

TypeScript Firebase Functions for the Project Guardian monitoring system.

## Functions

### `monitoringMasterHourly`
Cloud Scheduler function that runs every hour to generate monitoring manifests.

**Trigger**: Cloud Scheduler (cron: `0 * * * *`)
**Environment**: `RAW_BUCKET` - GCS bucket name for manifest storage

**Behavior**:
- Scans collections: `artifacts/guardian/public/data/werpassessments` and `artifacts/guardian-agent-default/public/data/werpassessments`
- Generates manifest JSON with document paths and IDs
- Writes to GCS: `gs://{RAW_BUCKET}/monitoring/manifests/{date}/manifest-{timestamp}.json`

### `onMonitoringEventWrite`
Firestore trigger that creates alerts when monitoring thresholds are exceeded.

**Trigger**: Firestore `onWrite` on `{collectionId}/{docId}/monitoring/{type}/{eventId}`

**Behavior**:
- Monitors for events where `exceeded === true`
- Creates alert object with metadata from the monitoring event
- Appends to wreck document's `alerts` array
- Sets `needsReassessment: true` and `alertsUpdatedAt: serverTimestamp()`

## Deployment

Functions are built from TypeScript and deployed alongside existing JavaScript functions:

```bash
cd functions
npm run build
firebase deploy --only functions
```

## Alert Structure

When monitoring events exceed thresholds, alerts are created with this structure:

```json
{
  "id": "earthquakes_event123_1234567890",
  "type": "earthquakes",
  "eventId": "event123",
  "acknowledged": false,
  "createdAt": "2024-01-01T12:00:00.000Z",
  "createdAtMs": 1234567890,
  "message": "Earthquake M5.2 exceeded PGA threshold",
  "severity": "warning",
  "source": "monitoring",
  "metadata": {
    "threshold": 0.10,
    "value": 0.125,
    "eventData": {
      "magnitude": 5.2,
      "distance": 45.2,
      "coordinates": [35.123, -120.456]
    }
  }
}
```