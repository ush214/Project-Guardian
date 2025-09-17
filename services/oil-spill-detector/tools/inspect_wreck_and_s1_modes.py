import os
from datetime import datetime, timedelta, timezone
import json

from google.cloud import firestore
import ee

WRECK_ID = "rio-de-janeiro-maru"

LOOKBACK_HOURS = int(os.environ.get("S1_LOOKBACK_HOURS", "168"))
AOI_RADIUS_KM = float(os.environ.get("AOI_RADIUS_KM", "50"))

def resolve_coords(data: dict):
    if isinstance(data.get("coordinates"), dict) and "lat" in data["coordinates"] and "lng" in data["coordinates"]:
        return [data["coordinates"]["lng"], data["coordinates"]["lat"]]
    loc = data.get("location")
    if isinstance(loc, dict) and isinstance(loc.get("coordinates"), (list, tuple)) and len(loc["coordinates"]) >= 2:
        return loc["coordinates"][:2]
    hist = data.get("historical")
    if isinstance(hist, dict):
        try:
            coords = hist["location"]["coordinates"]
            if isinstance(coords, (list, tuple)) and len(coords) >= 2:
                return coords[:2]
        except Exception:
            pass
    geom = data.get("geometry")
    if isinstance(geom, dict) and isinstance(geom.get("coordinates"), (list, tuple)) and len(geom["coordinates"]) >= 2:
        return geom["coordinates"][:2]
    geo = data.get("geo")
    if hasattr(geo, "longitude") and hasattr(geo, "latitude"):
        return [geo.longitude, geo.latitude]
    pos = data.get("position")
    if isinstance(pos, dict) and "lng" in pos and "lat" in pos:
        return [pos["lng"], pos["lat"]]
    phase1 = data.get("phase1")
    if isinstance(phase1, dict):
        try:
            coords = phase1["screening"]["coordinates"]
            if isinstance(coords, (list, tuple)) and len(coords) >= 2:
                return coords[:2]
        except Exception:
            pass
    return None

def get_wreck_doc(db):
    base = (db.collection("artifacts")
              .document("guardian")
              .collection("public")
              .document("data"))
    for col in ("werpassessments", "wreckassessments"):
        doc_ref = base.collection(col).document(WRECK_ID)
        doc = doc_ref.get()
        if doc.exists:
            return col, doc
    return None, None

def main():
    db = firestore.Client()
    print("Using Firestore project:", db.project)
    col_name, doc = get_wreck_doc(db)
    if not doc:
        print("Wreck doc not found in werpassessments or wreckassessments:", WRECK_ID)
        return
    data = doc.to_dict()
    print("Found wreck doc in collection:", col_name)
    lnglat = resolve_coords(data)
    print("Resolved lnglat:", lnglat)
    if not lnglat:
        print("ERROR: No usable coordinates; detector would skip this wreck.")
        return

    try:
        ee.Initialize()
    except Exception as e:
        print("EE Initialize failed, trying interactive auth...", e)
        ee.Authenticate()
        ee.Initialize()
    print("EE initialized")

    lng, lat = float(lnglat[0]), float(lnglat[1])
    aoi = ee.Geometry.Point([lng, lat]).buffer(AOI_RADIUS_KM * 1000.0)
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=LOOKBACK_HOURS)
    print(f"Time window UTC: {start.isoformat()} .. {end.isoformat()}   (hours={LOOKBACK_HOURS})")
    print(f"AOI radius km: {AOI_RADIUS_KM}")

    base = (ee.ImageCollection("COPERNICUS/S1_GRD")
              .filterDate(start, end)
              .filterBounds(aoi))

    for mode in ["IW", "EW"]:
        icm = base.filter(ee.Filter.eq("instrumentMode", mode))
        count = icm.size().getInfo()
        print(f"{mode} scene count:", count)
        if count > 0:
            def fmt(img):
                return ee.Feature(None, {
                    "id": img.get("system:index"),
                    "time": ee.Date(img.get("system:time_start")).format().cat(""),
                    "mode": img.get("instrumentMode"),
                    "pol": ee.String(ee.List(img.get("transmitterReceiverPolarisation")).join(",")),
                })
            feats = icm.sort("system:time_start").map(fmt).limit(10).getInfo()["features"]
            for f in feats:
                p = f["properties"]
                print("-", p["time"], p["id"], p["mode"], p["pol"])

if __name__ == "__main__":
    main()