# Monitoring Processor Service

A Cloud Run service for processing monitoring events for the Project Guardian platform.

## Overview

This service monitors wreck sites for environmental threats including earthquakes and storms. It processes data from external APIs and writes monitoring events to Firestore, which trigger alerts when thresholds are exceeded.

## Endpoints

### Health Check
- **GET /** - Returns service health status
- Response: `{ "status": "healthy", "service": "monitoring-processor", "timestamp": "..." }`

### Monitoring Processor
- **POST /run** - Executes monitoring run for all wreck sites
- Response: `{ "success": true, "processed": 123, "timestamp": "..." }`

## Features

### Earthquake Monitoring
- Fetches recent earthquakes from USGS FDSN GeoJSON API (last 6 hours, magnitude ≥ 4.5)
- Calculates distance from each earthquake to each wreck site
- Estimates Peak Ground Acceleration (PGA) from MMI or magnitude/distance
- Creates alerts when PGA exceeds 0.10g threshold
- Writes events to Firestore at `{collection}/{wreckId}/monitoring/earthquakes/events`

### Storm Monitoring
- Framework for storm monitoring (NHC integration placeholder)
- Designed to process hurricane/tropical storm data
- Distance-based threat assessment for wreck sites

### Coordinate Resolution
Resolves wreck coordinates from multiple possible fields:
1. `phase1.screening.coordinates`
2. `coordinates`
3. `location.coordinates`
4. `historical.location.coordinates`
5. `geo.position.geometry.coordinates` (GeoJSON format)

## Environment Variables

- `GOOGLE_CLOUD_PROJECT` - Google Cloud Project ID
- `PORT` - Service port (default: 8080)

## Docker Build

```bash
npm run build
docker build -t monitoring-processor .
```

## Local Development

```bash
npm install
npm run build
npm start
```

## Cloud Run Deployment

```bash
gcloud run deploy monitoring-processor \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 300
```

## Monitoring Event Structure

Events written to Firestore follow this structure:

```json
{
  "source": "usgs",
  "eventId": "earthquake_id",
  "timeMs": 1234567890,
  "magnitude": 5.2,
  "lat": 35.123,
  "lng": -120.456,
  "depthKm": 10.5,
  "distanceKm": 45.2,
  "pgaG": 0.125,
  "threshold": 0.10,
  "exceeded": true,
  "message": "Earthquake M5.2 exceeded PGA threshold",
  "createdAtMs": 1234567890
}
```

When `exceeded: true`, the Firebase Function `onMonitoringEventWrite` will automatically create alerts on the wreck document.