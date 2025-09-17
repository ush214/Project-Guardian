from google.cloud import firestore

# Rio de Janeiro Maru coordinates (Chuuk Lagoon)
LAT = 7.374383
LNG = 151.928883
WRECK_ID = "rio-de-janeiro-maru"

def main():
    db = firestore.Client()
    print("Using Firestore project:", db.project)
    doc_ref = (db.collection("artifacts")
                 .document("guardian")
                 .collection("public")
                 .document("data")
                 .collection("werpassessments")
                 .document(WRECK_ID))
    updates = {
        # Simple shape most detectors use
        "coordinates": {"lat": LAT, "lng": LNG},
        # Optional GeoJSON-style
        "geometry": {"type": "Point", "coordinates": [LNG, LAT]},
        # Optional duplicate for broader compatibility
        "position": {"lat": LAT, "lng": LNG},
    }
    doc_ref.set(updates, merge=True)
    print("Patched doc:", doc_ref.path)
    print("Set fields:", list(updates.keys()))

if __name__ == "__main__":
    main()