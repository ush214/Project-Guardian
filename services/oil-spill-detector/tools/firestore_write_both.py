from google.cloud import firestore
from datetime import datetime, timezone

wreck_id = "rio-de-janeiro-maru"

db = firestore.Client()  # Uses ADC and GOOGLE_CLOUD_PROJECT
print("Using Firestore project:", db.project)

def write_event(assess_collection: str):
    path = (db.collection("artifacts")
              .document("guardian")
              .collection("public")
              .document("data")
              .collection(assess_collection)
              .document(wreck_id)
              .collection("monitoring")
              .document("oil")
              .collection("events"))

    doc_id = f"manual-test-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    ref = path.document(doc_id)
    ref.set({
        "message": f"Manual test event (oil) in {assess_collection}",
        "status": "needs_review",
        "test": True,
        "createdAt": firestore.SERVER_TIMESTAMP,
    })
    print(f"Wrote test event to: {ref.path}")

for col in ("werpassessments", "wreckassessments"):
    try:
        write_event(col)
    except Exception as e:
        print(f"Failed writing to {col}:", e)