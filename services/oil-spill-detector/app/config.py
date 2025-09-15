import os

S1_LOOKBACK_HOURS = int(os.getenv("S1_LOOKBACK_HOURS", "36"))
AOI_RADIUS_KM = float(os.getenv("AOI_RADIUS_KM", "20"))

# Thresholds
CRITICAL_AREA_KM2 = float(os.getenv("CRITICAL_AREA_KM2", "0.5"))
CRITICAL_DIST_KM = float(os.getenv("CRITICAL_DIST_KM", "5"))
WARN_AREA_KM2 = float(os.getenv("WARN_AREA_KM2", "0.2"))
WARN_DIST_KM = float(os.getenv("WARN_DIST_KM", "10"))

READ_COLLECTIONS = [
    "artifacts/guardian/public/data/werpassessments",
    "artifacts/guardian-agent-default/public/data/werpassessments",
]