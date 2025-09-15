# Project Guardian Monitoring System Deployment Guide

This guide covers deploying the complete monitoring system for Project Guardian, including Firebase Functions, Cloud Run services, and UI components.

## Overview

The monitoring system consists of:

1. **Firebase Functions**
   - `monitoringMasterHourly`: Scheduled function for manifest generation
   - `onMonitoringEventWrite`: Firestore trigger for alert management

2. **Cloud Run Services**
   - `monitoring-processor`: Node.js service for earthquake and storm processing
   - `oil-spill-detector`: Python service for satellite-based oil spill detection

3. **Web UI**
   - `monitoring.html`: Dashboard for event visualization and alert management
   - `monitoring.js`: JavaScript for real-time monitoring interface

## Quick Deployment

Use the provided deployment script:

```bash
./scripts/deploy-monitoring.sh
```

## Prerequisites

- Google Cloud Project with billing enabled
- Firebase project configured
- Firebase CLI installed (`npm install -g firebase-tools`)
- Google Cloud CLI installed (`gcloud`)
- Docker installed (for Cloud Run services)

## Manual Deployment Steps

### Step 1: Deploy Firebase Functions

```bash
cd functions
npm install
firebase deploy --only functions:monitoringMasterHourly,functions:onMonitoringEventWrite
```

### Step 2: Deploy Cloud Run Services

```bash
# Monitoring Processor
cd services/monitoring-processor
npm run build
gcloud builds submit --tag gcr.io/PROJECT_ID/monitoring-processor
gcloud run deploy monitoring-processor --image gcr.io/PROJECT_ID/monitoring-processor

# Oil Spill Detector  
cd services/oil-spill-detector
gcloud builds submit --tag gcr.io/PROJECT_ID/oil-spill-detector
gcloud run deploy oil-spill-detector --image gcr.io/PROJECT_ID/oil-spill-detector
```

### Step 3: Deploy Web UI

```bash
firebase deploy --only hosting
```

## Access Points

- **Monitoring Dashboard**: `https://your-project.web.app/monitoring.html`
- **Monitoring Processor API**: `https://monitoring-processor-*-uc.a.run.app`
- **Oil Spill Detector API**: `https://oil-spill-detector-*-uc.a.run.app`

For detailed configuration and troubleshooting, see the full deployment documentation.
