import express from 'express';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
// Initialize Firebase Admin with Application Default Credentials
initializeApp({
    credential: applicationDefault()
});
const db = getFirestore();
const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());
const READ_COLLECTIONS = [
    "artifacts/guardian/public/data/werpassessments",
    "artifacts/guardian-agent-default/public/data/werpassessments"
];
// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Coordinate resolution utility
function resolveCoordinates(wreck) {
    const toNum = (v) => {
        if (v == null)
            return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    function extract(obj) {
        if (!obj)
            return null;
        // GeoJSON [lng, lat]
        if (Array.isArray(obj) && obj.length >= 2) {
            const lng = toNum(obj[0]);
            const lat = toNum(obj[1]);
            if (lat != null && lng != null)
                return { lat, lng };
        }
        // Try common keys
        const lat = toNum(obj.latitude ?? obj.lat ?? obj.y);
        const lng = toNum(obj.longitude ?? obj.lng ?? obj.lon ?? obj.x);
        if (lat != null && lng != null)
            return { lat, lng };
        // If object has a nested coordinates field, prefer that
        if (obj.coordinates) {
            const nested = extract(obj.coordinates);
            if (nested)
                return nested;
        }
        return null;
    }
    const candidates = [
        wreck?.phase1?.screening?.coordinates,
        wreck?.coordinates,
        wreck?.location?.coordinates,
        wreck?.historical?.location?.coordinates,
        wreck?.location,
        wreck?.geo,
        wreck?.position,
        wreck?.geometry?.coordinates,
        wreck?.geometry
    ];
    for (const c of candidates) {
        const coords = extract(c);
        if (coords)
            return coords;
    }
    return null;
}
// Haversine distance calculation
function haversineKm(a, b) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLatSin = Math.sin(dLat / 2);
    const dLngSin = Math.sin(dLng / 2);
    const aa = dLatSin * dLatSin + Math.cos(lat1) * Math.cos(lat2) * dLngSin * dLngSin;
    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
    return R * c;
}
// PGA estimation from MMI
function estimatePGA(mmi) {
    // Simple mapping: MMI VI≈0.06g, VII≈0.12g, VIII≈0.22g
    const mapping = {
        1: 0.002, 2: 0.005, 3: 0.01, 4: 0.02, 5: 0.04,
        6: 0.06, 7: 0.12, 8: 0.22, 9: 0.40, 10: 0.70, 11: 1.0, 12: 1.5
    };
    return mapping[Math.round(mmi)] || 0.05;
}
// Process earthquakes
async function processEarthquakes(wrecks) {
    try {
        // Fetch USGS FDSN data for last 6 hours (minmag 4.5)
        const now = new Date();
        const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        const usgsUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${sixHoursAgo.toISOString()}&endtime=${now.toISOString()}&minmagnitude=4.5`;
        const response = await fetch(usgsUrl);
        if (!response.ok) {
            console.error('Failed to fetch USGS data:', response.status);
            return;
        }
        const data = await response.json();
        const earthquakes = data.features || [];
        console.log(`Processing ${earthquakes.length} earthquakes for ${wrecks.length} wrecks`);
        for (const eq of earthquakes) {
            const eqCoords = eq.geometry?.coordinates;
            if (!eqCoords || eqCoords.length < 3)
                continue;
            const eqLng = eqCoords[0];
            const eqLat = eqCoords[1];
            const eqDepth = eqCoords[2];
            const magnitude = eq.properties?.mag || 0;
            const time = eq.properties?.time || Date.now();
            const eventId = eq.id || `eq_${time}_${magnitude}`;
            const mmi = eq.properties?.mmi;
            for (const wreck of wrecks) {
                const wreckCoords = resolveCoordinates(wreck);
                if (!wreckCoords)
                    continue;
                const distanceKm = haversineKm(wreckCoords, { lat: eqLat, lng: eqLng });
                // Estimate PGA if MMI is available
                let pgaG = 0.05; // Default
                if (mmi && typeof mmi === 'number') {
                    pgaG = estimatePGA(mmi);
                }
                const exceeded = pgaG >= 0.10;
                const message = `Magnitude ${magnitude} earthquake ${distanceKm.toFixed(1)}km away (PGA: ${pgaG.toFixed(3)}g)`;
                const eventDoc = {
                    source: "usgs",
                    eventId,
                    timeMs: time,
                    magnitude,
                    lat: eqLat,
                    lng: eqLng,
                    depthKm: eqDepth,
                    distanceKm,
                    pgaG,
                    threshold: 0.10,
                    exceeded,
                    message,
                    createdAtMs: Date.now()
                };
                // Write to monitoring collection
                const eventPath = `${wreck._path}/monitoring/earthquake/${eventId}`;
                try {
                    await db.doc(eventPath).set(eventDoc);
                    console.log(`Created earthquake event for wreck ${wreck.id}: ${exceeded ? 'EXCEEDED' : 'normal'}`);
                }
                catch (error) {
                    console.error(`Failed to write earthquake event for wreck ${wreck.id}:`, error);
                }
            }
        }
    }
    catch (error) {
        console.error('Error processing earthquakes:', error);
    }
}
// Process storms (using NHC active storms)
async function processStorms(wrecks) {
    try {
        // Fetch NHC active storms
        const nhcUrl = "https://www.nhc.noaa.gov/CurrentStorms.json";
        const response = await fetch(nhcUrl);
        if (!response.ok) {
            console.error('Failed to fetch NHC data:', response.status);
            return;
        }
        const data = await response.json();
        const storms = data.activeStorms || [];
        console.log(`Processing ${storms.length} storms for ${wrecks.length} wrecks`);
        for (const storm of storms) {
            const stormName = storm.name || storm.id || 'Unknown';
            const stormId = storm.id || storm.name || `storm_${Date.now()}`;
            // Get latest position
            const lat = storm.latitude || storm.lat;
            const lng = storm.longitude || storm.lng || storm.lon;
            if (typeof lat !== 'number' || typeof lng !== 'number')
                continue;
            const windSpeed = storm.intensity?.mph || storm.windSpeed || 0;
            const category = storm.category || 0;
            for (const wreck of wrecks) {
                const wreckCoords = resolveCoordinates(wreck);
                if (!wreckCoords)
                    continue;
                // Check if wreck is shallow (< 60 meters typically)
                const depth = wreck?.historical?.location?.depthMeters ||
                    wreck?.location?.depthMeters ||
                    wreck?.depthMeters || 100; // Default deep
                if (depth < 60) { // Shallow wreck filter
                    const distanceKm = haversineKm(wreckCoords, { lat, lng });
                    const threshold = 250; // 250km threshold
                    const exceeded = distanceKm <= threshold;
                    const message = `Storm ${stormName} ${distanceKm.toFixed(1)}km away (winds: ${windSpeed}mph, cat: ${category})`;
                    const eventDoc = {
                        source: "nhc",
                        eventId: `${stormId}_${Date.now()}`,
                        timeMs: Date.now(),
                        stormName,
                        stormId,
                        lat,
                        lng,
                        distanceKm,
                        windSpeedMph: windSpeed,
                        category,
                        threshold,
                        exceeded,
                        message,
                        createdAtMs: Date.now()
                    };
                    // Write to monitoring collection
                    const eventPath = `${wreck._path}/monitoring/cyclone/${eventDoc.eventId}`;
                    try {
                        await db.doc(eventPath).set(eventDoc);
                        console.log(`Created storm event for wreck ${wreck.id}: ${exceeded ? 'EXCEEDED' : 'normal'}`);
                    }
                    catch (error) {
                        console.error(`Failed to write storm event for wreck ${wreck.id}:`, error);
                    }
                }
            }
        }
    }
    catch (error) {
        console.error('Error processing storms:', error);
    }
}
// Mock oil spill detection (placeholder for Google Earth Engine integration)
async function processOilSpillDetection(wrecks) {
    try {
        console.log(`Processing oil spill detection for ${wrecks.length} wrecks`);
        // Placeholder implementation - would integrate with Google Earth Engine
        // For now, create mock events for demonstration
        for (const wreck of wrecks) {
            const wreckCoords = resolveCoordinates(wreck);
            if (!wreckCoords)
                continue;
            // Mock detection with low probability
            if (Math.random() < 0.05) { // 5% chance for demo
                const eventId = `spill_${wreck.id}_${Date.now()}`;
                const confidenceScore = 0.65 + Math.random() * 0.3; // 0.65-0.95
                const exceeded = confidenceScore >= 0.75;
                const message = `Potential oil slick detected near wreck (confidence: ${(confidenceScore * 100).toFixed(1)}%)`;
                const eventDoc = {
                    source: "sentinel1_gee",
                    eventId,
                    timeMs: Date.now(),
                    lat: wreckCoords.lat + (Math.random() - 0.5) * 0.01, // Small offset
                    lng: wreckCoords.lng + (Math.random() - 0.5) * 0.01,
                    confidenceScore,
                    threshold: 0.75,
                    exceeded,
                    message,
                    createdAtMs: Date.now()
                };
                // Write to monitoring collection
                const eventPath = `${wreck._path}/monitoring/oil_spill/${eventId}`;
                try {
                    await db.doc(eventPath).set(eventDoc);
                    console.log(`Created oil spill event for wreck ${wreck.id}: ${exceeded ? 'EXCEEDED' : 'normal'}`);
                }
                catch (error) {
                    console.error(`Failed to write oil spill event for wreck ${wreck.id}:`, error);
                }
            }
        }
    }
    catch (error) {
        console.error('Error processing oil spill detection:', error);
    }
}
// Main processing endpoint
app.post('/run', async (req, res) => {
    try {
        console.log('Starting monitoring processor run...');
        // Load all wreck documents from both collections
        const allWrecks = [];
        for (const collectionPath of READ_COLLECTIONS) {
            try {
                const snapshot = await db.collection(collectionPath).get();
                snapshot.forEach(doc => {
                    const data = doc.data();
                    allWrecks.push({
                        ...data,
                        id: doc.id,
                        _path: `${collectionPath}/${doc.id}`
                    });
                });
                console.log(`Loaded ${snapshot.size} wrecks from ${collectionPath}`);
            }
            catch (error) {
                console.error(`Error loading collection ${collectionPath}:`, error);
            }
        }
        if (allWrecks.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'No wrecks found to process',
                processed: 0
            });
        }
        console.log(`Processing ${allWrecks.length} total wrecks...`);
        // Process each monitoring type
        await Promise.all([
            processEarthquakes(allWrecks),
            processStorms(allWrecks),
            processOilSpillDetection(allWrecks)
        ]);
        console.log('Monitoring processor run completed successfully');
        res.status(200).json({
            success: true,
            message: 'Monitoring processing completed',
            processed: allWrecks.length,
            timestamp: new Date().toISOString()
        });
    }
    catch (error) {
        console.error('Error in monitoring processor:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
app.listen(PORT, () => {
    console.log(`Monitoring processor listening on port ${PORT}`);
});
//# sourceMappingURL=index.js.map