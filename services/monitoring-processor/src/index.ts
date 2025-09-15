import express from 'express';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin
const app = initializeApp({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'project-guardian-dev'
});

const db = getFirestore(app);

const server = express();
server.use(express.json());

// Types
interface Coordinates {
  lat: number;
  lng: number;
}

interface WreckDocument {
  id: string;
  coordinates?: Coordinates;
  phase1?: {
    screening?: {
      coordinates?: Coordinates;
    };
  };
  location?: {
    coordinates?: Coordinates;
  };
  historical?: {
    location?: {
      coordinates?: Coordinates;
    };
  };
  geo?: {
    position?: {
      geometry?: {
        coordinates?: [number, number]; // [lng, lat] GeoJSON format
      };
    };
  };
}

interface EarthquakeEvent {
  id: string;
  properties: {
    mag: number;
    time: number;
    place: string;
    mmi?: number;
  };
  geometry: {
    coordinates: [number, number, number]; // [lng, lat, depth]
  };
}

interface StormEvent {
  id: string;
  name: string;
  category?: number;
  coordinates: Coordinates;
  timestamp: number;
}

// Utility functions
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function mmiToPga(mmi: number): number {
  // Simple MMI to PGA mapping as specified
  const mapping: { [key: number]: number } = {
    6: 0.06,   // VI -> 0.06g
    7: 0.12,   // VII -> 0.12g
    8: 0.22    // VIII -> 0.22g+
  };
  
  if (mmi >= 8) return 0.22;
  return mapping[mmi] || 0.0;
}

function resolveCoordinates(wreck: WreckDocument): Coordinates | null {
  // Try various coordinate fields in order of preference
  const sources = [
    wreck.phase1?.screening?.coordinates,
    wreck.coordinates,
    wreck.location?.coordinates,
    wreck.historical?.location?.coordinates,
    wreck.geo?.position?.geometry?.coordinates ? {
      lat: wreck.geo.position.geometry.coordinates[1],
      lng: wreck.geo.position.geometry.coordinates[0]
    } : null
  ];

  for (const coords of sources) {
    if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
      return coords;
    }
  }

  return null;
}

// Health check endpoint
server.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    service: 'monitoring-processor',
    timestamp: new Date().toISOString()
  });
});

// Main monitoring processor endpoint
server.post('/run', async (req, res) => {
  try {
    console.log('Starting monitoring run...');
    
    const collections = [
      'artifacts/guardian/public/data/werpassessments',
      'artifacts/guardian-agent-default/public/data/werpassessments'
    ];

    const wrecks: WreckDocument[] = [];
    
    // Load wreck documents from both collections
    for (const collectionPath of collections) {
      try {
        const snapshot = await db.collection(collectionPath).get();
        for (const doc of snapshot.docs) {
          const data = doc.data() as Partial<WreckDocument>;
          wrecks.push({ ...data, id: doc.id } as WreckDocument);
        }
        console.log(`Loaded ${snapshot.docs.length} wrecks from ${collectionPath}`);
      } catch (error) {
        console.error(`Error loading collection ${collectionPath}:`, error);
      }
    }

    // Resolve coordinates for all wrecks
    const wrecksWithCoords = wrecks
      .map(wreck => ({ ...wreck, resolvedCoords: resolveCoordinates(wreck) }))
      .filter(wreck => wreck.resolvedCoords !== null) as Array<WreckDocument & { resolvedCoords: Coordinates }>;

    console.log(`Processing ${wrecksWithCoords.length} wrecks with valid coordinates`);

    // Process earthquakes
    await processEarthquakes(wrecksWithCoords);
    
    // Process storms
    await processStorms(wrecksWithCoords);

    res.status(200).json({
      success: true,
      processed: wrecksWithCoords.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error in monitoring run:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

async function processEarthquakes(wrecks: Array<WreckDocument & { resolvedCoords: Coordinates }>) {
  try {
    // Fetch USGS FDSN GeoJSON for last 6 hours (minmag 4.5)
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    
    const usgsUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${sixHoursAgo}&endtime=${now}&minmagnitude=4.5`;
    
    console.log(`Fetching earthquakes from USGS: ${usgsUrl}`);
    
    const response = await fetch(usgsUrl);
    if (!response.ok) {
      throw new Error(`USGS API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json() as any;
    const earthquakes: EarthquakeEvent[] = data.features || [];
    
    console.log(`Found ${earthquakes.length} earthquakes in the last 6 hours`);

    // Process each wreck against each earthquake
    for (const wreck of wrecks) {
      const { lat, lng } = wreck.resolvedCoords;
      
      for (const earthquake of earthquakes) {
        const [eqLng, eqLat, eqDepth] = earthquake.geometry.coordinates;
        const distance = calculateDistance(lat, lng, eqLat, eqLng);
        
        // Calculate PGA from MMI if available, otherwise use simplified magnitude-based estimation
        let pgaG = 0;
        if (earthquake.properties.mmi) {
          pgaG = mmiToPga(earthquake.properties.mmi);
        } else {
          // Simplified PGA estimation based on magnitude and distance
          const mag = earthquake.properties.mag;
          const logDistance = Math.log10(Math.max(distance, 1));
          pgaG = Math.max(0, Math.pow(10, mag - 3.5 - 1.5 * logDistance) / 100);
        }
        
        const threshold = 0.10;
        const exceeded = pgaG >= threshold;
        
        const eventData = {
          source: 'usgs',
          eventId: earthquake.id,
          timeMs: earthquake.properties.time,
          magnitude: earthquake.properties.mag,
          lat: eqLat,
          lng: eqLng,
          depthKm: eqDepth,
          distanceKm: Math.round(distance * 100) / 100,
          pgaG: Math.round(pgaG * 1000) / 1000,
          threshold,
          exceeded,
          message: exceeded 
            ? `Earthquake M${earthquake.properties.mag} exceeded PGA threshold (${pgaG.toFixed(3)}g >= ${threshold}g)`
            : `Earthquake M${earthquake.properties.mag} below PGA threshold (${pgaG.toFixed(3)}g < ${threshold}g)`,
          createdAtMs: Date.now()
        };

        // Find the wreck's collection path
        const collectionPath = wrecks.find(w => w.id === wreck.id) ? 
          'artifacts/guardian/public/data/werpassessments' : 
          'artifacts/guardian-agent-default/public/data/werpassessments';
        
        // Write event to Firestore
        const eventPath = `${collectionPath}/${wreck.id}/monitoring/earthquakes/events`;
        await db.collection(eventPath).doc(earthquake.id).set(eventData);
        
        if (exceeded) {
          console.log(`🚨 Earthquake alert for wreck ${wreck.id}: M${earthquake.properties.mag} at ${distance.toFixed(1)}km (PGA: ${pgaG.toFixed(3)}g)`);
        }
      }
    }
  } catch (error) {
    console.error('Error processing earthquakes:', error);
  }
}

async function processStorms(wrecks: Array<WreckDocument & { resolvedCoords: Coordinates }>) {
  try {
    // Fetch NHC JSON index - using a simplified approach for now
    // In production, this would integrate with actual NHC APIs
    console.log('Storm monitoring not fully implemented yet - would fetch from NHC APIs');
    
    // Placeholder for storm processing
    // This would:
    // 1. Fetch active storms from NHC
    // 2. Calculate distance to each wreck
    // 3. Check shallow water thresholds
    // 4. Write storm events to Firestore
    
    return;
  } catch (error) {
    console.error('Error processing storms:', error);
  }
}

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Monitoring processor service listening on port ${PORT}`);
});

export default server;