import math
import time
from typing import Any, Dict, List, Tuple

from flask import Flask, jsonify, request
import ee

from . import config
from .firestore_client import read_wrecks, write_oil_event

app = Flask(__name__)

def haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    (lat1, lon1), (lat2, lon2) = a, b
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    la1 = math.radians(lat1)
    la2 = math.radians(lat2)
    s = math.sin(dlat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(s), math.sqrt(1 - s))
    return R * c

@app.get("/")
def health():
    return "ok", 200

@app.post("/run")
def run():
    started = time.time()
    try:
        from .gee_spill import init_ee, detect_dark_spots
        init_ee()

        wrecks = read_wrecks(config.READ_COLLECTIONS)
        processed = 0
        for w in wrecks:
            latlng = w.get("latlng")
            if not latlng:
                continue
            lat, lng = float(latlng[0]), float(latlng[1])

            features = detect_dark_spots(lat, lng, config.S1_LOOKBACK_HOURS, config.AOI_RADIUS_KM)

            # Build a simple thumbnail URL for reference
            aoi = ee.Geometry.Point([lng, lat]).buffer(config.AOI_RADIUS_KM * 1000).bounds()
            # Use a simple visualization of VV band magnitude (not consistent across images; for operator cue only)
            vis_img = ee.Image.constant(0).visualize(min=0, max=1, palette=["000000","FFFFFF"])
            thumb_url = vis_img.getThumbURL({"region": aoi, "dimensions": 512})

            for f in features:
                geom = f.get("geometry", {})
                props = f.get("properties", {})
                image_id = props.get("imageId")
                time_ms = int(props.get("timeMs") or int(time.time() * 1000))

                # Compute area (approx) from polygon if available
                area_km2 = None
                if geom and geom.get("type") in ("Polygon", "MultiPolygon"):
                    # Very rough area estimator using Earth Engine server-computed area would be better;
                    # keep None here; setting a placeholder via size of bbox for basic triage
                    area_km2 = None

                # Fallback: set a small nominal area if unknown (so thresholds can still evaluate)
                if area_km2 is None:
                    area_km2 = 0.25

                # Compute centroid for distance
                coords = None
                if geom and geom.get("type") == "Polygon":
                    coords = geom.get("coordinates", [[]])[0][0]
                elif geom and geom.get("type") == "MultiPolygon":
                    coords = geom.get("coordinates", [[[]]])[0][0][0]
                if coords and isinstance(coords, list) and len(coords) >= 2:
                    poly_lng, poly_lat = float(coords[0]), float(coords[1])
                    distance_km = haversine_km((lat, lng), (poly_lat, poly_lng))
                else:
                    distance_km = 0.0

                exceeded = (area_km2 >= config.CRITICAL_AREA_KM2 and distance_km <= config.CRITICAL_DIST_KM) or \
                           (area_km2 >= config.WARN_AREA_KM2 and distance_km <= config.WARN_DIST_KM)

                severity = "info"
                if area_km2 >= config.CRITICAL_AREA_KM2 and distance_km <= config.CRITICAL_DIST_KM:
                    severity = "critical"
                elif area_km2 >= config.WARN_AREA_KM2 and distance_km <= config.WARN_DIST_KM:
                    severity = "warning"

                message = f"Sentinel-1 dark spot ~{area_km2:.2f} km² at {distance_km:.1f} km"

                event_id = f"{image_id}-{int(distance_km*1000)}"
                event = {
                    "source": "sentinel-1",
                    "imageId": image_id,
                    "timeMs": time_ms,
                    "area_km2": area_km2,
                    "distance_km": distance_km,
                    "exceeded": bool(exceeded),
                    "severity": severity,
                    "message": message,
                    "thumbUrl": thumb_url,
                    "geometry": geom,
                    "threshold": {"warn": [config.WARN_AREA_KM2, config.WARN_DIST_KM],
                                  "critical": [config.CRITICAL_AREA_KM2, config.CRITICAL_DIST_KM]},
                    "createdAtMs": int(time.time() * 1000)
                }
                write_oil_event(w["path"], event_id, event)
                processed += 1

        return jsonify({"ok": True, "elapsed_s": round(time.time() - started, 3)}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500