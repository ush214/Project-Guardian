#!/usr/bin/env python3
"""
Oil Spill Detection Service

Uses Google Earth Engine and Sentinel-1 SAR data to detect potential oil spills
near shipwreck locations. Writes detection events to Firestore.
"""

import os
import logging
import json
from datetime import datetime, timedelta
from typing import Dict, List, Tuple, Optional

from flask import Flask, request, jsonify
import ee
from google.cloud import firestore
import numpy as np

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Initialize Earth Engine
try:
    # Try to initialize with service account credentials
    if os.getenv('GOOGLE_APPLICATION_CREDENTIALS'):
        ee.Initialize()
    else:
        # Fallback for local development
        ee.Authenticate()
        ee.Initialize()
    logger.info("Google Earth Engine initialized successfully")
except Exception as e:
    logger.error(f"Failed to initialize Google Earth Engine: {e}")
    ee = None

# Initialize Firestore
db = firestore.Client()

class OilSpillDetector:
    """Detects potential oil spills using Sentinel-1 SAR data"""
    
    def __init__(self):
        self.spill_threshold = -20  # dB threshold for oil spill detection
        self.min_spill_area = 1000  # minimum area in square meters
        
    def detect_spills_near_wreck(self, wreck_coords: Tuple[float, float], 
                                bbox: List[float], 
                                days_back: int = 7) -> List[Dict]:
        """
        Detect oil spills near a wreck location using Sentinel-1 data
        
        Args:
            wreck_coords: (lat, lon) of wreck
            bbox: [min_lon, min_lat, max_lon, max_lat] bounding box
            days_back: Number of days to look back for imagery
            
        Returns:
            List of spill detection events
        """
        if not ee:
            logger.warning("Earth Engine not available, returning empty results")
            return []
            
        try:
            # Define area of interest
            aoi = ee.Geometry.Rectangle(bbox)
            
            # Date range
            end_date = datetime.now()
            start_date = end_date - timedelta(days=days_back)
            
            # Get Sentinel-1 data
            s1_collection = (ee.ImageCollection('COPERNICUS/S1_GRD')
                           .filterDate(start_date.strftime('%Y-%m-%d'), 
                                     end_date.strftime('%Y-%m-%d'))
                           .filterBounds(aoi)
                           .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
                           .filter(ee.Filter.eq('instrumentMode', 'IW')))
            
            # Process each image in the collection
            spill_events = []
            image_count = s1_collection.size().getInfo()
            
            if image_count == 0:
                logger.info(f"No Sentinel-1 images found for bbox {bbox} in last {days_back} days")
                return []
                
            logger.info(f"Processing {image_count} Sentinel-1 images")
            
            # Get image list
            image_list = s1_collection.toList(image_count)
            
            for i in range(min(image_count, 5)):  # Limit to 5 most recent images
                image = ee.Image(image_list.get(i))
                spills = self._detect_spills_in_image(image, aoi, wreck_coords)
                spill_events.extend(spills)
                
            return spill_events
            
        except Exception as e:
            logger.error(f"Error in oil spill detection: {e}")
            return []
    
    def _detect_spills_in_image(self, image: ee.Image, aoi: ee.Geometry, 
                               wreck_coords: Tuple[float, float]) -> List[Dict]:
        """Detect oil spills in a single Sentinel-1 image"""
        try:
            # Get image metadata
            image_info = image.getInfo()
            image_date = datetime.fromtimestamp(
                image_info['properties']['system:time_start'] / 1000
            )
            
            # Get VV polarization band
            vv_band = image.select('VV')
            
            # Apply spill detection threshold
            spill_mask = vv_band.lt(self.spill_threshold)
            
            # Remove small areas (noise reduction)
            spill_mask = spill_mask.connectedPixelCount(100).gte(10)
            
            # Convert to vectors and get area statistics
            spill_vectors = spill_mask.reduceToVectors(
                geometry=aoi,
                scale=10,  # 10m resolution
                maxPixels=1e8
            )
            
            # Calculate areas and filter
            def add_area(feature):
                return feature.set('area', feature.geometry().area())
            
            spill_vectors = spill_vectors.map(add_area)
            large_spills = spill_vectors.filter(ee.Filter.gte('area', self.min_spill_area))
            
            # Get spill information
            spill_info = large_spills.getInfo()
            
            spill_events = []
            if spill_info and spill_info.get('features'):
                for feature in spill_info['features']:
                    properties = feature.get('properties', {})
                    geometry = feature.get('geometry', {})
                    
                    if geometry.get('coordinates'):
                        # Calculate centroid
                        coords = geometry['coordinates'][0]  # Assuming polygon
                        centroid_lon = sum(c[0] for c in coords) / len(coords)
                        centroid_lat = sum(c[1] for c in coords) / len(coords)
                        
                        # Calculate distance from wreck
                        distance_km = self._calculate_distance(
                            wreck_coords[0], wreck_coords[1],
                            centroid_lat, centroid_lon
                        )
                        
                        spill_event = {
                            'source': 'sentinel1',
                            'eventId': f"spill_{image_date.strftime('%Y%m%d')}_{int(centroid_lat*1000)}_{int(centroid_lon*1000)}",
                            'timeMs': int(image_date.timestamp() * 1000),
                            'lat': centroid_lat,
                            'lng': centroid_lon,
                            'area_sqm': properties.get('area', 0),
                            'distanceKm': round(distance_km, 2),
                            'threshold': 10,  # 10km threshold for proximity
                            'exceeded': distance_km <= 10,
                            'confidence': 'medium',  # Simplified confidence
                            'message': f"Potential oil spill detected {round(distance_km, 1)}km from wreck (area: {int(properties.get('area', 0))}m²)",
                            'createdAtMs': int(datetime.now().timestamp() * 1000),
                            'satellite_data': {
                                'platform': 'Sentinel-1',
                                'acquisition_date': image_date.isoformat(),
                                'polarization': 'VV',
                                'threshold_db': self.spill_threshold
                            }
                        }
                        
                        spill_events.append(spill_event)
            
            return spill_events
            
        except Exception as e:
            logger.error(f"Error processing Sentinel-1 image: {e}")
            return []
    
    def _calculate_distance(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Calculate distance between two points using Haversine formula"""
        from math import radians, sin, cos, sqrt, atan2
        
        R = 6371  # Earth's radius in kilometers
        
        lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        
        a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
        c = 2 * atan2(sqrt(a), sqrt(1-a))
        
        return R * c

# Initialize detector
detector = OilSpillDetector()

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'earth_engine_available': ee is not None
    })

@app.route('/detect-spills', methods=['POST'])
def detect_spills():
    """Detect oil spills for specified area and wreck"""
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({'error': 'No JSON data provided'}), 400
        
        # Extract parameters
        bbox = data.get('bbox')
        wreck_id = data.get('wreckId')
        wreck_coords = data.get('wreckCoords')  # [lat, lon]
        days_back = data.get('daysBack', 7)
        
        if not all([bbox, wreck_id, wreck_coords]):
            return jsonify({
                'error': 'Missing required parameters: bbox, wreckId, wreckCoords'
            }), 400
        
        if not isinstance(bbox, list) or len(bbox) != 4:
            return jsonify({'error': 'bbox must be [minLon, minLat, maxLon, maxLat]'}), 400
        
        if not isinstance(wreck_coords, list) or len(wreck_coords) != 2:
            return jsonify({'error': 'wreckCoords must be [lat, lon]'}), 400
        
        logger.info(f"Detecting spills for wreck {wreck_id} at {wreck_coords}")
        
        # Detect spills
        spill_events = detector.detect_spills_near_wreck(
            tuple(wreck_coords), bbox, days_back
        )
        
        # Save events to Firestore
        events_saved = 0
        for event in spill_events:
            try:
                # Save to both collection paths as per requirements  
                collections = [
                    "artifacts/guardian/public/data/werpassessments",
                    "artifacts/guardian-agent-default/public/data/werpassessments"
                ]
                
                for collection_path in collections:
                    event_path = f"{collection_path}/{wreck_id}/monitoring/oil/events/{event['eventId']}"
                    db.document(event_path).set(event, merge=True)
                    events_saved += 1
                    
                    if event['exceeded']:
                        logger.warning(f"🛢️  Oil spill threshold exceeded for wreck {wreck_id}: {event['message']}")
                        
            except Exception as e:
                logger.error(f"Error saving spill event: {e}")
        
        return jsonify({
            'success': True,
            'wreckId': wreck_id,
            'spills_detected': len(spill_events),
            'events_saved': events_saved,
            'spill_events': spill_events
        })
        
    except Exception as e:
        logger.error(f"Error in detect_spills endpoint: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False)
