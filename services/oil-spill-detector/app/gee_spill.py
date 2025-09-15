import time
from typing import Any, Dict, List, Tuple
import ee

def init_ee():
    # Use ADC within Cloud Run
    try:
        ee.Initialize()
    except Exception:
        # Some environments require explicit init on first call
        ee.Initialize(opt_url="https://earthengine-highvolume.googleapis.com")

def circle_aoi(lat: float, lng: float, radius_km: float):
    return ee.Geometry.Point([lng, lat]).buffer(radius_km * 1000).bounds()

def detect_dark_spots(lat: float, lng: float, lookback_hours: int, radius_km: float) -> List[Dict[str, Any]]:
    """
    Very simple dark-spot detector on Sentinel-1 VV (fallback VH):
    - Filter last lookback_hours.
    - Convert to dB, clip to AOI.
    - Use percentile-based threshold (e.g., 15th percentile) to pick darker pixels.
    - Morphological open/close and vectorize.
    """
    now = ee.Date(int(time.time() * 1000))
    start = now.advance(-lookback_hours, "hour")
    aoi = circle_aoi(lat, lng, radius_km)

    s1 = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterBounds(aoi)
        .filterDate(start, now)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.eq("resolution_meters", 10))
        .filter(ee.Filter.eq("orbitProperties_pass", "DESCENDING"))
        .filter(ee.Filter.eq("productType", "GRD"))
    )

    def per_image(img):
        bands = img.bandNames()
        use_vv = bands.contains("VV")
        band = ee.Image(ee.Algorithms.If(use_vv, img.select("VV"), img.select("VH")))
        db = band.log10().multiply(10.0)
        db = db.clip(aoi)

        # Adaptive threshold
        pctl = db.reduceRegion(
            reducer=ee.Reducer.percentile([15]), geometry=aoi, scale=30, maxPixels=1e8
        ).getNumber(db.bandNames().get(0))
        # Dark pixels below threshold
        dark = db.lt(pctl)

        # Morphology
        dark = dark.focal_min(1).focal_max(1)

        vectors = dark.selfMask().reduceToVectors(
            geometry=aoi,
            geometryType="polygon",
            scale=10,
            maxPixels=1e8,
            labelProperty="dark",
            bestEffort=True,
        )
        return ee.FeatureCollection(
            vectors.map(lambda f: f.set({
                "imageId": img.get("system:id"),
                "timeMs": img.get("system:time_start")
            }))
        )

    fc = s1.map(per_image).flatten()
    # Limit to reasonable number
    fc = fc.limit(1000)
    return fc.getInfo().get("features", [])