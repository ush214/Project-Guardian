#!/bin/bash

# Project Guardian Monitoring System Deployment Script
# This script deploys the complete monitoring system

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"project-guardian-agent"}
REGION=${REGION:-"us-central1"}
APP_ID=${APP_ID:-"guardian"}

echo "🚀 Deploying Project Guardian Monitoring System"
echo "Project ID: $PROJECT_ID"
echo "Region: $REGION"
echo "App ID: $APP_ID"
echo

# Check prerequisites
command -v firebase >/dev/null 2>&1 || { echo "❌ Firebase CLI is required but not installed. Aborting." >&2; exit 1; }
command -v gcloud >/dev/null 2>&1 || { echo "❌ Google Cloud CLI is required but not installed. Aborting." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "❌ Docker is required but not installed. Aborting." >&2; exit 1; }

# Set project
gcloud config set project $PROJECT_ID
firebase use $PROJECT_ID

echo "✅ Prerequisites check complete"
echo

# Step 1: Deploy Firebase Functions
echo "📦 Deploying Firebase Functions..."
cd functions

# Install dependencies
npm install

# Deploy functions
firebase deploy --only functions:monitoringMasterHourly,functions:onMonitoringEventWrite

# Set environment variables
firebase functions:config:set app.id="$APP_ID"
if [[ -n "$RAW_BUCKET" ]]; then
    firebase functions:config:set raw.bucket="$RAW_BUCKET"
fi

cd ..
echo "✅ Firebase Functions deployed"
echo

# Step 2: Deploy Monitoring Processor
echo "🔧 Deploying Monitoring Processor..."
cd services/monitoring-processor

# Install dependencies and build
npm install
npm run build

# Build and deploy Docker image
gcloud builds submit --tag gcr.io/$PROJECT_ID/monitoring-processor .

gcloud run deploy monitoring-processor \
  --image gcr.io/$PROJECT_ID/monitoring-processor \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 15m \
  --concurrency 10 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=$PROJECT_ID

cd ../..
echo "✅ Monitoring Processor deployed"
echo

# Step 3: Deploy Oil Spill Detector
echo "🛢️ Deploying Oil Spill Detector..."
cd services/oil-spill-detector

# Check if Earth Engine service account exists
if ! gcloud iam service-accounts describe earth-engine-service@$PROJECT_ID.iam.gserviceaccount.com >/dev/null 2>&1; then
    echo "Creating Earth Engine service account..."
    gcloud iam service-accounts create earth-engine-service \
      --display-name="Earth Engine Service Account"
    
    # Grant permissions
    gcloud projects add-iam-policy-binding $PROJECT_ID \
      --member="serviceAccount:earth-engine-service@$PROJECT_ID.iam.gserviceaccount.com" \
      --role="roles/earthengine.viewer"
    
    gcloud projects add-iam-policy-binding $PROJECT_ID \
      --member="serviceAccount:earth-engine-service@$PROJECT_ID.iam.gserviceaccount.com" \
      --role="roles/firestore.user"
fi

# Build and deploy
gcloud builds submit --tag gcr.io/$PROJECT_ID/oil-spill-detector .

gcloud run deploy oil-spill-detector \
  --image gcr.io/$PROJECT_ID/oil-spill-detector \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --memory 2Gi \
  --timeout 30m \
  --concurrency 5 \
  --service-account earth-engine-service@$PROJECT_ID.iam.gserviceaccount.com

cd ../..
echo "✅ Oil Spill Detector deployed"
echo

# Step 4: Deploy Web UI
echo "🌐 Deploying Web UI..."
firebase deploy --only hosting
echo "✅ Web UI deployed"
echo

# Step 5: Create Firestore indexes (if needed)
echo "📊 Creating Firestore indexes..."

# Create indexes using Firebase CLI
cat > firestore.indexes.json << EOF
{
  "indexes": [
    {
      "collectionGroup": "events",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        {
          "fieldPath": "createdAtMs",
          "order": "DESCENDING"
        }
      ]
    },
    {
      "collectionGroup": "monitoring_flags",
      "queryScope": "COLLECTION",
      "fields": [
        {
          "fieldPath": "wreckId",
          "order": "ASCENDING"
        },
        {
          "fieldPath": "createdAt",
          "order": "DESCENDING"
        }
      ]
    }
  ]
}
EOF

firebase deploy --only firestore:indexes
rm firestore.indexes.json
echo "✅ Firestore indexes created"
echo

# Step 6: Set up Cloud Scheduler jobs (optional)
if [[ "$SETUP_SCHEDULER" == "true" ]]; then
    echo "⏰ Setting up Cloud Scheduler jobs..."
    
    # Get monitoring processor URL
    PROCESSOR_URL=$(gcloud run services describe monitoring-processor --region=$REGION --format='value(status.url)')
    
    # Create earthquake scan job
    gcloud scheduler jobs create http earthquake-scan \
      --schedule="0 */6 * * *" \
      --uri="$PROCESSOR_URL/process-earthquakes" \
      --http-method=POST \
      --headers="Content-Type=application/json" \
      --message-body='{"hoursBack": 6}' \
      --time-zone="UTC" || echo "Earthquake scan job already exists"
    
    # Create storm scan job
    gcloud scheduler jobs create http storm-scan \
      --schedule="0 */3 * * *" \
      --uri="$PROCESSOR_URL/process-storms" \
      --http-method=POST \
      --headers="Content-Type=application/json" \
      --message-body='{}' \
      --time-zone="UTC" || echo "Storm scan job already exists"
    
    echo "✅ Cloud Scheduler jobs created"
fi

echo
echo "🎉 Project Guardian Monitoring System deployed successfully!"
echo
echo "📝 Deployment Summary:"
echo "   • Firebase Functions: monitoringMasterHourly, onMonitoringEventWrite"
echo "   • Monitoring Processor: https://monitoring-processor-*-uc.a.run.app"
echo "   • Oil Spill Detector: https://oil-spill-detector-*-uc.a.run.app"
echo "   • Monitoring Dashboard: https://$PROJECT_ID.web.app/monitoring.html"
echo
echo "📋 Next Steps:"
echo "   1. Test the monitoring dashboard at https://$PROJECT_ID.web.app/monitoring.html"
echo "   2. Trigger manual scans to verify functionality"
echo "   3. Monitor logs for any errors or issues"
echo "   4. Set up alerts for service health monitoring"
echo
echo "📚 For detailed configuration options, see docs/MONITORING_DEPLOYMENT.md"