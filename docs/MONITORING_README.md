# Project Guardian Monitoring System

🛡️ **A production-ready monitoring scaffold for detecting environmental threats to shipwrecks**

This monitoring system provides real-time detection and alerting for earthquakes, storms, and oil spills that could impact underwater cultural heritage sites.

## 🏗️ System Architecture

![Monitoring Dashboard](https://github.com/user-attachments/assets/d5bd873f-6643-4ad5-b844-66168bfe6ed8)

### Components

1. **Firebase Functions** (`functions/src/monitoring.js`)
   - `monitoringMasterHourly`: Scheduled manifest generation (every 60 minutes)
   - `onMonitoringEventWrite`: Firestore trigger for automatic alert creation

2. **Cloud Run Services**
   - **Monitoring Processor** (`services/monitoring-processor/`): Node.js/TypeScript service for:
     - USGS earthquake monitoring with PGA calculations
     - NHC/GDACS storm tracking with distance analysis
   - **Oil Spill Detector** (`services/oil-spill-detector/`): Python + Google Earth Engine service for:
     - Sentinel-1 SAR analysis for oil spill detection
     - Automated satellite imagery processing

3. **Web Dashboard** (`public/monitoring.html`)
   - Real-time event visualization
   - Alert acknowledgment interface
   - Manual scan triggers
   - System status monitoring

## 🚀 Quick Start

### Prerequisites
- Google Cloud Project with billing enabled
- Firebase CLI: `npm install -g firebase-tools`
- Google Cloud CLI: Install from [cloud.google.com](https://cloud.google.com/sdk)
- Docker for Cloud Run deployments

### One-Command Deployment
```bash
# Clone and deploy everything
git clone https://github.com/ush214/Project-Guardian.git
cd Project-Guardian
./scripts/deploy-monitoring.sh
```

### Manual Deployment
See detailed instructions in [`docs/MONITORING_DEPLOYMENT.md`](docs/MONITORING_DEPLOYMENT.md)

## 📊 Features

### Real-Time Monitoring
- **Earthquakes**: USGS FDSN integration with PGA threshold analysis (0.10g)
- **Storms**: NHC/GDACS tropical cyclone tracking for shallow wrecks (<60m depth)
- **Oil Spills**: Sentinel-1 SAR satellite analysis using Google Earth Engine

### Alert Management
- Automatic alert generation when thresholds are exceeded
- Firestore triggers set `needsReassessment=true` for flagged wrecks
- Dashboard interface for acknowledging alerts
- Integration with existing assessment workflow

### Data Structure
Events are stored at: `{wreckDoc}/monitoring/{type}/events/{eventId}`

Where `type` ∈ `{earthquakes, storms, oil}`

Example event structure:
```json
{
  "source": "usgs",
  "eventId": "us70008jr5",
  "timeMs": 1701234567890,
  "magnitude": 6.2,
  "lat": 35.123,
  "lng": -118.456,
  "distanceKm": 45.7,
  "pgaG": 0.12,
  "threshold": 0.10,
  "exceeded": true,
  "message": "Magnitude 6.2 earthquake 46km away (PGA: 12.0%g)",
  "createdAtMs": 1701234567890
}
```

## 🔧 Configuration

### Environment Variables

**Firebase Functions:**
```bash
firebase functions:config:set app.id="guardian"
firebase functions:config:set raw.bucket="your-raw-data-bucket"  # optional
```

**Cloud Run Services:**
- `GOOGLE_CLOUD_PROJECT`: Your GCP project ID
- `GOOGLE_APPLICATION_CREDENTIALS`: Earth Engine service account (oil spill detector)

### Firestore Rules
```javascript
// Allow read access to monitoring events
match /artifacts/{appId}/public/data/werpassessments/{docId}/monitoring/{type}/events/{eventId} {
  allow read: if true;
  allow write: if false; // Only Cloud Functions can write
}

// Allow authenticated users to update alerts
match /artifacts/{appId}/public/data/werpassessments/{docId} {
  allow read: if true;
  allow update: if request.auth != null 
    && request.writeFields.hasOnly(['alerts', 'needsReassessment', 'alertsUpdatedAt']);
}
```

## 🌐 API Endpoints

### Monitoring Processor
- `POST /process-earthquakes`: Manual earthquake scan
- `POST /process-storms`: Manual storm scan  
- `POST /process-all`: Combined scan
- `GET /health`: Health check

### Oil Spill Detector
- `POST /detect-spills`: Detect spills for specific area
- `POST /process-wreck`: Process single wreck
- `GET /health`: Health check

## 📈 Monitoring Thresholds

| Event Type | Threshold | Criteria |
|------------|-----------|----------|
| Earthquakes | 0.10g PGA | Peak Ground Acceleration |
| Storms | 500km distance | For shallow wrecks (<60m depth) |
| Oil Spills | 10km proximity | Satellite-detected slicks |

## 🔗 Integration

### Existing Workflow
- Compatible with current assessment collections:
  - `artifacts/guardian/public/data/werpassessments`
  - `artifacts/guardian-agent-default/public/data/werpassessments`
- Preserves existing `public/index.html` and `public/app.js`
- Uses established coordinate resolution patterns

### Alert Integration
- Sets `needsReassessment: true` on parent wreck documents
- Appends to `alerts` array with acknowledgment tracking
- Updates `alertsUpdatedAt` timestamp
- Integrates with existing reassessment workflow

## 🛠️ Development

### Local Development
```bash
# Functions
cd functions && npm install && npm run serve

# Monitoring Processor
cd services/monitoring-processor && npm install && npm run dev

# Oil Spill Detector
cd services/oil-spill-detector && python -m venv venv && source venv/bin/activate && pip install -r requirements.txt && python main.py
```

### Testing
```bash
# Test earthquake processing
curl -X POST http://localhost:8080/process-earthquakes -H "Content-Type: application/json" -d '{"hoursBack": 6}'

# Test storm processing  
curl -X POST http://localhost:8080/process-storms -H "Content-Type: application/json" -d '{}'

# Test oil spill detection
curl -X POST http://localhost:8080/detect-spills -H "Content-Type: application/json" -d '{
  "bbox": [-118.5, 33.5, -118.0, 34.0],
  "wreckId": "example-wreck", 
  "wreckCoords": [33.75, -118.25]
}'
```

## 📚 Documentation

- [Deployment Guide](docs/MONITORING_DEPLOYMENT.md) - Complete deployment instructions
- [API Documentation](docs/API.md) - Detailed API reference
- [Architecture Overview](docs/ARCHITECTURE.md) - System design and data flow

## 🔒 Security

- Firebase Authentication for administrative functions
- IAM roles for service-to-service communication
- Firestore security rules for data access control
- Service account keys for Earth Engine access
- CORS configuration for browser access

## 📊 Monitoring & Observability

### Health Checks
All services provide `/health` endpoints for monitoring

### Logging
- Firebase Functions: Firebase Console
- Cloud Run: Cloud Console Logging
- Client errors: Browser developer console

### Metrics
- Function execution metrics in Firebase Console
- Cloud Run metrics in Cloud Console
- Custom metrics via Cloud Monitoring

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with appropriate tests
4. Update documentation
5. Submit a pull request

## 📄 License

This project is part of Project Guardian and follows the same licensing terms.

## 🆘 Support

For issues and questions:
1. Check the [deployment guide](docs/MONITORING_DEPLOYMENT.md)
2. Review logs in Firebase/Cloud Console
3. Open an issue with reproduction steps
4. Contact the Project Guardian team

---

**Project Guardian Monitoring System** - Protecting underwater cultural heritage through intelligent environmental monitoring.