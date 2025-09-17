from google.cloud import firestore
from datetime import datetime, timezone
import os

WRECK_ID = os.environ.get("WRECK_ID", "rio-de-janeiro-maru")
LOOKBACK_HOURS = int(os.environ.get("S1_LOOKBACK_HOURS", "168"))
AOI_RADIUS_KM = float(os.environ.get("AOI_RADIUS_KM", "50"))
ASSESS_COLLECTION = os.environ.get("ASSESS_COLLECTION", "werpassessments")

def main():
    db = firestore.Client()
    print("Using Firestore project:", db.project)
    events = (db.collection("artifacts")
                .document("guardian")
                .collection("public")
                .document("data")
                .collection(ASSESS_COLLECTION)
                .document(WRECK_ID)
                .collection("monitoring")
                .document("oil")
                .collection("events"))
    doc_id = f"no-data-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    ref = events.document(doc_id)
    msg = f"No Sentinel-1 GRD scenes found in the last {LOOKBACK_HOURS} hours within {AOI_RADIUS_KM} km. No analysis performed."
    ref.set({
        "message": msg,
        "status": "no_data",
        "createdAt": firestore.SERVER_TIMESTAMP,
        "params": {
            "lookbackHours": LOOKBACK_HOURS,
            "aoiRadiusKm": AOI_RADIUS_KM,
            "instrumentModes": ["IW","EW"],
        }
    })
    print("Wrote:", ref.path, "->", msg)

if __name__ == "__main__":
    main()