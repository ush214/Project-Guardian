# Bulk Import via Cloud Storage

This document describes the new backend-only bulk import process that replaces the previous frontend UI-based bulk import feature.

## Overview

The bulk import feature has been redesigned to use Cloud Storage as the trigger mechanism instead of a frontend UI. This provides a more secure, scalable, and automated approach to processing large numbers of vessel assessments.

## How It Works

1. **Upload CSV files** to the Cloud Storage bucket in the `bulk-import/` folder
2. **Automatic processing** is triggered when files are uploaded
3. **CSV parsing** extracts vessel names from the uploaded files
4. **Queue processing** uses the existing bulk import queue system
5. **Automatic cleanup** moves processed files to a `processed/` folder

## Prerequisites

- **Admin role** required (only admins can trigger bulk imports)
- **Cloud Storage access** to the Firebase project storage bucket
- **CSV format** files with vessel names

## CSV File Format

The system supports flexible CSV formats:

### Option 1: One vessel per line
```
HMS Victory
USS Constitution
HMS Beagle
```

### Option 2: Comma-separated vessels in a single line
```
HMS Victory, USS Constitution, HMS Beagle
```

### Option 3: Mixed format
```
HMS Victory, USS Constitution
HMS Beagle
RMS Titanic, USS Enterprise
```

## Upload Process

### Step 1: Prepare your CSV file
- Create a CSV file containing vessel names
- Use one of the supported formats above
- Save with a `.csv` extension

### Step 2: Set metadata (required for admin verification)
When uploading to Cloud Storage, you must set custom metadata to verify admin permissions:

```javascript
// Example using Firebase Admin SDK
const metadata = {
  uploaderUid: 'your-admin-uid-here'
};

await bucket.file('bulk-import/my-vessels.csv').save(csvContent, {
  metadata: metadata
});
```

### Step 3: Upload to the correct path
- Upload files to the `bulk-import/` folder in your Cloud Storage bucket
- File path example: `bulk-import/vessel-list-2024.csv`

## Processing Behavior

The system will:

1. **Validate permissions** - Only admin users can trigger bulk imports
2. **Parse CSV content** - Extract vessel names using flexible parsing
3. **Deduplicate entries** - Skip duplicate vessel names within the same file
4. **Check existing assessments** - Skip vessels that already have assessments
5. **Queue for processing** - Add new vessels to the assessment queue
6. **Log results** - Create processing logs with statistics
7. **Clean up** - Move processed files to `bulk-import/processed/` folder

## Processing Results

After processing, you can check the results in:

- **Processing logs**: Stored in Firestore at `system/bulkImport/storageLogs`
- **Queue status**: Check `system/bulkImport/queue` for individual vessel processing status
- **Console logs**: Review Cloud Functions logs for detailed processing information

Each log entry includes:
- Total vessels found in the file
- Number successfully enqueued
- Number skipped (duplicates)
- Number skipped (already exist)
- Processing timestamp and status

## Error Handling

Common error scenarios:

1. **Non-admin upload**: Files uploaded without admin permissions will be ignored
2. **Invalid file format**: Only `.csv` files in the `bulk-import/` folder are processed
3. **Missing metadata**: Files without `uploaderUid` metadata will be rejected
4. **Processing errors**: Individual vessel processing errors are logged and retried

## Queue Processing

The bulk import uses the existing queue system:

- **Scheduled processing**: Runs every 5 minutes
- **Batch processing**: Processes up to 5 vessels per run
- **Retry logic**: Failed assessments are retried up to 3 times
- **Status tracking**: Each vessel has status tracking (pending, processing, succeeded, failed)

## Monitoring

To monitor bulk import progress:

1. **Check queue collection**: `system/bulkImport/queue`
2. **Review processing logs**: `system/bulkImport/storageLogs`
3. **Monitor Cloud Functions logs**: Look for `processStorageImport` function logs
4. **Check assessment results**: New assessments appear in `artifacts/guardian-agent-default/public/data/werpassessments`

## Security Notes

- Only users with admin role can trigger bulk imports
- File uploads require proper metadata with admin UID
- Processed files are automatically moved to prevent reprocessing
- All processing activities are logged for audit purposes

## Troubleshooting

### File not processing
- Verify file is in `bulk-import/` folder
- Ensure file has `.csv` extension
- Check that `uploaderUid` metadata is set correctly
- Verify the uploader has admin role

### Vessels not being queued
- Check if assessments already exist for those vessels
- Verify CSV format is correct
- Look for processing errors in Cloud Functions logs

### Processing stuck
- Check the queue collection for vessel status
- Review Cloud Functions logs for errors
- Verify the scheduled function is running every 5 minutes

## Migration from Frontend UI

The previous frontend bulk import UI has been removed. To migrate:

1. **Export existing workflows** to CSV files
2. **Use Cloud Storage upload** instead of the web UI
3. **Monitor via Firestore** instead of the frontend status display

This new approach provides better security, scalability, and automation capabilities for bulk vessel assessments.