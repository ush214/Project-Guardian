/**
 * Earthquake Processor - Fetches USGS earthquake data and processes events for wrecks
 */

import { Firestore } from 'firebase-admin/firestore';
import fetch from 'node-fetch';

interface Wreck {
  id: string;
  collectionPath: string;
  coordinates: { lat: number; lon: number };
  depth?: number;
  data: any;
}

interface USGSEarthquake {
  id: string;
  properties: {
    mag: number;
    place: string;
    time: number;
    url: string;
    detail: string;
    title: string;
  };
  geometry: {
    coordinates: [number, number, number]; // [lng, lat, depth]
  };
}

interface ProcessedEarthquakeEvent {
  source: string;
  eventId: string;
  timeMs: number;
  magnitude: number;
  lat: number;
  lng: number;
  depthKm: number;
  distanceKm: number;
  pgaG: number;
  threshold: number;
  exceeded: boolean;
  message: string;
  createdAtMs: number;
}

export class EarthquakeProcessor {
  private readonly PGA_THRESHOLD = 0.10; // 0.10g threshold
  
  constructor(private db: Firestore) {}

  async processEarthquakes(wrecks: Wreck[], hoursBack: number = 6): Promise<{ processed: number; events: number }> {
    console.log(`Processing earthquakes for ${wrecks.length} wrecks, ${hoursBack} hours back`);
    
    // Fetch USGS earthquake data
    const earthquakes = await this.fetchUSGSEarthquakes(hoursBack);
    console.log(`Found ${earthquakes.length} earthquakes in the last ${hoursBack} hours`);
    
    let processed = 0;
    let events = 0;
    
    for (const wreck of wrecks) {
      for (const earthquake of earthquakes) {
        const distance = this.calculateDistance(
          wreck.coordinates.lat,
          wreck.coordinates.lon,
          earthquake.geometry.coordinates[1], // lat
          earthquake.geometry.coordinates[0]  // lng
        );
        
        // Only process earthquakes within reasonable distance (e.g., 1000km)
        if (distance <= 1000) {
          const pgaG = this.calculatePGA(earthquake.properties.mag, distance, earthquake.geometry.coordinates[2]);
          
          const event: ProcessedEarthquakeEvent = {
            source: "usgs",
            eventId: earthquake.id,
            timeMs: earthquake.properties.time,
            magnitude: earthquake.properties.mag,
            lat: earthquake.geometry.coordinates[1],
            lng: earthquake.geometry.coordinates[0],
            depthKm: earthquake.geometry.coordinates[2],
            distanceKm: Math.round(distance * 100) / 100,
            pgaG: Math.round(pgaG * 1000) / 1000,
            threshold: this.PGA_THRESHOLD,
            exceeded: pgaG > this.PGA_THRESHOLD,
            message: `Magnitude ${earthquake.properties.mag} earthquake ${Math.round(distance)}km away (PGA: ${(pgaG * 100).toFixed(1)}%g)`,
            createdAtMs: Date.now()
          };

          await this.saveEarthquakeEvent(wreck, event);
          events++;
        }
        
        processed++;
      }
    }
    
    console.log(`Processed ${processed} earthquake-wreck combinations, created ${events} events`);
    return { processed, events };
  }

  private async fetchUSGSEarthquakes(hoursBack: number): Promise<USGSEarthquake[]> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hoursBack * 60 * 60 * 1000);
    
    // USGS FDSN Event Web Service
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${startTime.toISOString()}&endtime=${endTime.toISOString()}&minmagnitude=4.0`;
    
    console.log(`Fetching USGS earthquakes: ${url}`);
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`USGS API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json() as any;
    return data.features || [];
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    // Haversine formula
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  private calculatePGA(magnitude: number, distanceKm: number, depthKm: number): number {
    // Simplified PGA calculation based on Boore-Atkinson GMPE
    // This is a rough approximation - in production you'd want a more sophisticated model
    
    // Convert distance to logarithmic scale
    const logR = Math.log10(Math.max(distanceKm, 1));
    
    // Simple magnitude scaling
    const magTerm = 1.5 * magnitude - 6.0;
    
    // Distance attenuation
    const distTerm = -2.0 * logR;
    
    // Depth effect (deeper earthquakes have less surface effect)
    const depthTerm = depthKm > 10 ? -0.1 * Math.log10(depthKm / 10) : 0;
    
    // Calculate log(PGA) and convert to linear scale
    const logPGA = magTerm + distTerm + depthTerm - 2.0; // -2.0 is a calibration factor
    
    return Math.pow(10, logPGA);
  }

  private async saveEarthquakeEvent(wreck: Wreck, event: ProcessedEarthquakeEvent): Promise<void> {
    const eventPath = `${wreck.collectionPath}/${wreck.id}/monitoring/earthquakes/events/${event.eventId}`;
    
    try {
      await this.db.doc(eventPath).set(event, { merge: true });
      
      if (event.exceeded) {
        console.log(`⚠️  Earthquake threshold exceeded for wreck ${wreck.id}: ${event.message}`);
      }
    } catch (error) {
      console.error(`Error saving earthquake event for wreck ${wreck.id}:`, error);
      throw error;
    }
  }
}