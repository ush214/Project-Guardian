#!/usr/bin/env bash
set -euo pipefail

# Fill these before running:
PROJECT_ID="YOUR_GCP_PROJECT_ID"
REGION="us-central1"
RAW_BUCKET="guardian-raw-manifests" # create a GCS bucket first: gsutil mb -l ${REGION} gs://${RAW_BUCKET}

# Build & deploy monitoring-processor (Node)
pushd services/monitoring-processor
gcloud builds submit --tag gcr.io/${PROJECT_ID}/monitoring-processor
gcloud run deploy monitoring-processor \
  --project ${PROJECT_ID} \
  --region ${REGION} \
  --image gcr.io/${PROJECT_ID}/monitoring-processor \
  --platform managed \
  --allow-unauthenticated
popd

# Build & deploy oil-spill-detector (Python)
pushd services/oil-spill-detector
gcloud builds submit --tag gcr.io/${PROJECT_ID}/oil-spill-detector
gcloud run deploy oil-spill-detector \
  --project ${PROJECT_ID} \
  --region ${REGION} \
  --image gcr.io/${PROJECT_ID}/oil-spill-detector \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars S1_LOOKBACK_HOURS=36,AOI_RADIUS_KM=20
popd

# Deploy Firebase Functions (ensure you are logged in and project is set)
# In your functions environment, set:
#   APP_ID=guardian
#   RAW_BUCKET=${RAW_BUCKET}
# You can set these via runtime config or environment variables for 2nd-gen functions.
# Example (2nd gen with env vars):
# gcloud functions deploy monitoringMasterHourly --gen2 --runtime=nodejs20 --region=${REGION} --entry-point=monitoringMasterHourly --trigger-topic=monitoring-hourly --set-env-vars APP_ID=guardian,RAW_BUCKET=${RAW_BUCKET}
# gcloud functions deploy onMonitoringEventWrite --gen2 --runtime=nodejs20 --region=${REGION} --entry-point=onMonitoringEventWrite --trigger-event-filters="type=google.cloud.firestore.document.v1.written" --trigger-event-filters="document=**" --set-env-vars APP_ID=guardian,RAW_BUCKET=${RAW_BUCKET}

# Cloud Scheduler (hourly) to publish to topic that triggers monitoringMasterHourly (if using Pub/Sub trigger)
# gcloud scheduler jobs create pubsub monitoring-hourly --project=${PROJECT_ID} --location=${REGION} --schedule="0 * * * *" --topic=monitoring-hourly --message-body="{}"

# Eventarc trigger (optional) from GCS RAW manifests -> monitoring-processor
# gcloud eventarc triggers create monitoring-manifest-trigger \
#   --project=${PROJECT_ID} --location=${REGION} \
#   --destination-run-service=monitoring-processor \
#   --event-filters="type=google.cloud.storage.object.v1.finalized" \
#   --event-filters="bucket=${RAW_BUCKET}" \
#   --service-account="${PROJECT_ID}@appspot.gserviceaccount.com"

# Scheduler for oil-spill-detector (every 6 hours)
# gcloud scheduler jobs create http oil-spill-scan \
#   --project=${PROJECT_ID} --location=${REGION} \
#   --schedule="0 */6 * * *" \
#   --http-method=POST \
#   --uri="$(gcloud run services describe oil-spill-detector --project=${PROJECT_ID} --region=${REGION} --format='value(status.url)')/run"
echo "Done. Review README_MONITORING.md for full steps."