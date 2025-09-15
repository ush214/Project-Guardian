# Project Guardian Monitoring Scaffold

This monitoring scaffold provides real-time environmental monitoring capabilities for Project Guardian's wreck assessment platform.

## Components

### 1. Firebase Functions (`functions/src/monitoring.ts`)

#### `monitoringMasterHourly`
- **Trigger**: Cloud Scheduler (every 60 minutes)
- **Purpose**: Creates manifest files of all wreck documents
- **Output**: JSON manifests in GCS bucket under `manifests/YYYY/MM/DD/HH.json`
- **Environment**: Requires `RAW_BUCKET` environment variable

#### `onMonitoringEventWrite`
- **Trigger**: Firestore document writes on `{collectionId}/{docId}/monitoring/{type}/{eventId}`
- **Purpose**: Processes monitoring events and creates alerts when thresholds are exceeded
- **Behavior**: Adds alerts to wreck documents with idempotency protection

### 2. Cloud Run Service (`services/monitoring-processor`)

#### Endpoints
- `GET /` - Health check endpoint
- `POST /run` - Triggers monitoring processing

#### Monitoring Capabilities
- **Earthquakes**: USGS FDSN API integration for magnitude 4.5+ events
- **Storms**: NHC active storms monitoring for shallow wrecks
- **Oil Spills**: Google Earth Engine Sentinel-1 detection (placeholder implementation)

### 3. UI Integration

#### Files
- `public/monitoring-ui.js` - Core monitoring UI module
- `public/monitoring-init.js` - Bootstrap script
- `public/monitoring.css` - Styling

#### Features
- Real-time event display
- Spill detection queuing
- Event filtering and alerts

## Configuration

### Collections
Hard-coded read collections:
- `artifacts/guardian/public/data/werpassessments`
- `artifacts/guardian-agent-default/public/data/werpassessments`

### Coordinate Resolution
Supports multiple coordinate formats:
- `phase1.screening.coordinates`
- `coordinates`
- `location.coordinates`
- `historical.location.coordinates`
- `geometry.coordinates`
- `geo`, `position`

### Thresholds
- **Earthquakes**: PGA ≥ 0.10g
- **Storms**: Distance ≤ 250km for shallow wrecks (< 60m depth)
- **Oil Spills**: Confidence ≥ 75%

## Deployment

### Functions
```bash
cd functions
npm run build
npm run deploy
```

### Cloud Run Service
```bash
cd services/monitoring-processor
npm run build
docker build -t monitoring-processor .
# Deploy to Cloud Run with Application Default Credentials
```

## Authentication

All server components use Application Default Credentials. No secrets are committed to the repository.

## Event Structure

### Earthquake Events
```json
{
  "source": "usgs",
  "eventId": "string",
  "timeMs": "number",
  "magnitude": "number",
  "lat": "number",
  "lng": "number",
  "depthKm": "number",
  "distanceKm": "number",
  "pgaG": "number",
  "threshold": 0.10,
  "exceeded": "boolean",
  "message": "string",
  "createdAtMs": "number"
}
```

### Storm Events
```json
{
  "source": "nhc",
  "eventId": "string",
  "timeMs": "number",
  "stormName": "string",
  "lat": "number",
  "lng": "number",
  "distanceKm": "number",
  "windSpeedMph": "number",
  "category": "number",
  "threshold": 250,
  "exceeded": "boolean",
  "message": "string",
  "createdAtMs": "number"
}
```

### Oil Spill Events
```json
{
  "source": "sentinel1_gee",
  "eventId": "string",
  "timeMs": "number",
  "lat": "number",
  "lng": "number",
  "confidenceScore": "number",
  "threshold": 0.75,
  "exceeded": "boolean",
  "message": "string",
  "createdAtMs": "number"
}
```

## Firestore Structure

Events are written to:
```
{collectionId}/{docId}/monitoring/{type}/{eventId}
```

Where:
- `collectionId` = wreck collection path
- `docId` = wreck document ID
- `type` = "earthquake" | "cyclone" | "oil_spill"
- `eventId` = unique event identifier

## Dependencies

### Functions
- firebase-functions ^5.0.0
- firebase-admin ^12.6.0

### Monitoring Processor
- express ^4.18.0
- firebase-admin ^12.6.0
- @google/earthengine ^0.1.0

## Testing

Run the test script to verify implementation:
```bash
./test-monitoring.sh
```