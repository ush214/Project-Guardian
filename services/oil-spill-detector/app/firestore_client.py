from typing import Any, Dict, List, Optional, Tuple
from google.cloud import firestore

db = firestore.Client()

def pick_latlng(doc: Dict[str, Any]) -> Optional[Tuple[float, float]]:
    candidates = [
        doc.get("phase1", {}).get("screening", {}).get("coordinates"),
        doc.get("coordinates"),
        doc.get("location", {}).get("coordinates"),
        doc.get("historical", {}).get("location", {}).get("coordinates"),
        doc.get("geometry", {}).get("coordinates"),
        doc.get("geo", {}).get("coordinates"),
        doc.get("position", {}).get("coordinates"),
        doc.get("geo"),
        doc.get("position"),
        doc.get("geometry"),
    ]
    for c in candidates:
        if c is None:
            continue
        if isinstance(c, list) and len(c) >= 2:
            lng, lat = float(c[0]), float(c[1])
            return (lat, lng)
        if isinstance(c, dict):
            lat = c.get("lat", c.get("latitude"))
            lng = c.get("lng", c.get("longitude"))
            if lat is not None and lng is not None:
                return (float(lat), float(lng))
    return None

def read_wrecks(collection_paths: List[str]) -> List[Dict[str, Any]]:
    out = []
    for col in collection_paths:
        col_ref = db.collection(col)
        doc_refs = list(col_ref.list_documents())
        if not doc_refs:
            continue
        snapshots = db.get_all(doc_refs)
        for s in snapshots:
            if not s.exists:
                continue
            data = s.to_dict()
            latlng = pick_latlng(data)
            out.append({"id": s.id, "path": s.reference.path, "data": data, "latlng": latlng})
    return out

def write_oil_event(wreck_path: str, event_id: str, event: Dict[str, Any]) -> None:
    ref = db.document(f"{wreck_path}/monitoring/oil/events/{event_id}")
    ref.set(event, merge=True)